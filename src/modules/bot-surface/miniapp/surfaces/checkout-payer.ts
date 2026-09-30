import { AppError, createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { OptionalPhoneNumberSchema } from '../../../../core/validation/phone';
import { ICustomer } from '../../../customers/customer.model';
import { resolveCameroonOperator } from '../../../payments/domain/cm-operator';
import {
    isMobileMoneyProvider,
    MobileMoneyProvider,
    providerForSavedWallet,
} from '../../../payments/domain/payment-provider';
import { offeredProviders, resolveCollectionRoute } from '../../../payments/services/payment-routing.service';
import { UserPaymentMethodRepository } from '../../../payment-methods/repositories/user-payment-method.repository';
import { walletNumberOf } from '../../../payment-methods/dto/payment-method.dto';
import { maskPhone } from '../../dto/bot-projections';

/** Default-first, then newest — the ordering `storedPayerNumber` relies on is the repository's own. */
const paymentMethods = new UserPaymentMethodRepository();

/**
 * Checkout — the payment helpers, WITH NO TRANSPORT.
 *
 * ⛔ **THIS FILE MUST NEVER IMPORT EXPRESS, A CONTROLLER OR A ROUTE FILE, and that is the
 * entire reason it exists.** These five used to live in `checkout.controller.ts`. The booking
 * pay screen's core needs them, and that core is imported directly by the WhatsApp form
 * handler — so pulling a controller into its import graph makes a bare `ts-node` suite do
 * real work at module scope and hang with **no output**, which reads as a broken test rather
 * than a broken import. `test-inapp-bookings` § 2 asserts exactly that, and it went red on
 * the import rather than letting it through.
 *
 * ⚠ **The lazy `await import()` dodge was considered and REJECTED** (by the bookings stream,
 * and they were right): it would pass that guard while still reaching a controller, so the
 * guard would go green on the thing its own sentence forbids.
 *
 * ── Why these five are ONE module and not five ──────────────────────────────
 *
 * Together they answer "whose money, from which wallet, through which gateway, and may we
 * charge it" — and every one of them is a rule that must have exactly one answer platform-wide.
 * Two copies of any of them is two opinions about where a stranger's money goes: which handset
 * gets the prompt, whether a blank field means "my account's number", whether a customer may
 * retry after a refusal. The chat retry, the checkout screen and the booking pay screen all
 * import from here for that reason.
 *
 * ⚠ **Callers of `checkout.controller.ts` still work**: it re-exports all five, so nothing
 * that imported them from there had to change.
 */

/**
 * The typed payer number, `null` for "use my account's", or a refusal the customer can fix.
 *
 * ⚠ **Empty and whitespace-only strings fold to `null` FIRST — measured, not assumed.** The
 * platform phone schema refuses `''`, and a WhatsApp text input left empty submits exactly that.
 * Without the fold, "use the number on my account" — the common case, and the one that discloses
 * nothing — would be refused as an invalid number on the form while working on the page, which
 * sends `null`.
 *
 * ⚠ **Raised as an `AppError` with `spent: false`, never as a raw `ZodError`.** A `ZodError` has
 * no `details` a caller could read, and this is the one refusal after which a retry is both
 * honest and useful.
 *
 * ⚠ **EXPORTED, and it must stay THE answer to "what number does this customer want charged".**
 * One of the set beside `mobileMoneyRoute`, `storedPayerNumber` and `maskedPayerNumber`,
 * and exported for the same reason: it
 * carries payment SEMANTICS, not just parsing. The empty-string fold decides whether a blank
 * field means "my account's number" or an error, and the `spent: false` on its refusal is the
 * flag a page reads to decide whether its Pay button may unlatch. A second copy would be a
 * second opinion about when a customer may retry a payment, and the two would drift the first
 * time either changed. The booking pay screen (`bp`) imports it.
 */
export function validatedPayerNumber(phone: unknown): string | null {
    if (phone === null || phone === undefined) return null;
    if (typeof phone === 'string' && phone.trim().length === 0) return null;

    const parsed = OptionalPhoneNumberSchema.safeParse(phone);
    if (!parsed.success) {
        throw createAppError(
            ERROR_CODES.VALIDATION_ERROR,
            400,
            'That is not a valid mobile money number — include the country code',
            { spent: false, field: 'phone' },
        );
    }
    return parsed.data ?? null;
}

/**
 * The number the charge will go to, **masked**, or null when the customer has none on file.
 *
 * ⚠ **This is a PLACEHOLDER on the page, never a value**, which is what makes the common case
 * one tap and no disclosure: the customer sees enough to confirm it is the right wallet, the
 * page never holds the number, and submitting the field empty means "use that one". A forwarded
 * URL therefore discloses a masked tail and cannot be used to learn a payable number.
 *
 * ⚠ **EXPORTED for the booking pay screen (`bp`), which must show the SAME masked number** for the
 * same customer. A second masking of the payer number would let one customer see two different
 * placeholders for one wallet depending on whether they are buying a product or paying for an
 * appointment — and would be the first step to the two charging different handsets.
 */
export async function maskedPayerNumber(customer: ICustomer): Promise<string | null> {
    const stored = await storedPayerNumber(customer);
    return stored ? maskPhone(stored) : null;
}

/**
 * The number on the account, in full — **server-side only.**
 *
 * ⚠ **A saved wallet first, the profile phone second.** The wallet is the number the customer
 * deliberately nominated for paying; the profile phone is the number they sign in with, and the
 * two are frequently different handsets. Charging the login number when a wallet exists would
 * push the prompt to the wrong device.
 *
 * ⚠ **The wallet number is `phone_number`, or `gateway_customer_id` on a legacy row** — rows
 * saved before 2026-09-30 kept it there. `walletNumberOf` reads both, and only a value that is
 * actually E.164 (some legacy rows hold an aggregator's customer id). No endpoint returns it
 * unmasked: it is read here to charge, and it leaves this process only masked.
 *
 * ⚠ **The REPOSITORY, not `paymentMethodService`, and the difference is the point.** That
 * service projects to `PaymentMethodDto`, which carries the number only masked — the rule
 * that keeps a saved wallet's number unreadable through every API. Nothing here breaks that:
 * the number is read to open a charge and is published only through `maskedPayerNumber`.
 *
 * ⚠ **EXPORTED, and it must stay the only answer to "which wallet gets charged".**
 * `bot-checkout.controller.ts` re-opens a charge from the chat when a customer asks to try
 * again, and a second implementation of this fallback there would mean the screen and the chat
 * pushing the prompt to two different handsets for one customer — discovered by them, at the
 * moment they are trying to pay. Both are Stream D's files precisely so this stays one rule.
 */
export async function storedPayerNumber(customer: ICustomer): Promise<string | null> {
    /** Already sorted default-first, then newest, by the repository itself — see `storedPayer`. */
    return (await storedPayer(customer))?.number ?? null;
}

/** The wallet a server-picked charge goes to, with the network its saved method names (if any). */
export interface StoredPayer {
    number: string;
    /** The saved method's own `provider` (`MTN`, or legacy `mtn_momo`, …) — null for the profile phone. */
    savedProvider: string | null;
}

/**
 * `storedPayerNumber`, plus what the saved wallet says its network is.
 *
 * Same rule, same order — a saved wallet first, the profile phone second — and it IS the rule:
 * `storedPayerNumber` now reads through this, so the two cannot pick different handsets.
 * `savedProvider` feeds `mobileMoneyRoute` when a number's prefix is not one the table knows.
 */
export async function storedPayer(customer: ICustomer): Promise<StoredPayer | null> {
    const methods = await paymentMethods.list('customer', String(customer._id));
    const wallet = methods.find((method) => method.method_type === 'mobile_money') ?? null;

    const number = wallet ? walletNumberOf(wallet) : null;
    if (number) return { number, savedProvider: wallet?.provider ?? null };

    const phone = customer.phone?.trim();
    return phone ? { number: phone, savedProvider: null } : null;
}

/**
 * Refuse, before anything is spent, when no mobile-money provider can be charged at all.
 *
 * The screens and the chat learn the payer's number — and so its provider — only after the handle
 * is spent when the customer relies on the number on their account. This is the question that CAN
 * be answered up front: is any mobile provider offered? If none is (every one disabled by an
 * administrator, or no aggregator configured), the customer is told now, with the handle alive.
 *
 * `PAYMENT_PROVIDER_UNAVAILABLE` 422, the code the router raises for one provider, so a client
 * handles one refusal whichever side of the spend it lands on.
 */
export function assertMobileMoneyOffered(): void {
    const offered = offeredProviders();
    if (offered.some(isMobileMoneyProvider)) return;
    throw createAppError(
        ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        422,
        'Mobile money payments are not available right now.',
        { offered, spent: false },
    );
}

/**
 * ⭐ THE answer, on the server-picked doors, to "which provider does this charge go through"
 * (ADR-A08). Replaced the old env-picked `mobileMoneyGateway` (deleted in C1).
 *
 * Nobody on these doors DECLARED a provider — the customer confirmed a number — so the number
 * decides, by its prefix. Only when the prefix is not one the table knows does the saved wallet's
 * own network count (owner decision 7: an unknown prefix defers to what was stated). A saved
 * label that contradicts a known prefix is NOT refused: the number is what gets charged, and the
 * customer said nothing in this turn that the number could contradict.
 *
 * Then the provider is routed now, so a disabled provider or an unroutable one is refused on
 * THIS side of the spend when it can be. The orchestrator routes again when it opens the charge;
 * that second answer is the one that counts.
 *
 * Refusals, both 422 and both carrying `spent` as the caller states it:
 *   - `PAYMENT_OPERATOR_UNDETERMINED` `{ spent, field: 'phone' }` — no provider can be worked out;
 *   - `PAYMENT_PROVIDER_UNAVAILABLE` `{ provider, offered, spent }`.
 */
export function mobileMoneyRoute(
    payerNumber: string,
    spent: boolean,
    savedProvider: string | null = null,
): { provider: MobileMoneyProvider } {
    const provider: MobileMoneyProvider | null =
        resolveCameroonOperator(payerNumber) ?? providerForSavedWallet(savedProvider);
    if (!provider) {
        throw createAppError(
            ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
            422,
            'Could not determine the mobile network for this number.',
            { spent, field: 'phone' },
        );
    }

    try {
        resolveCollectionRoute(provider);
    } catch (error) {
        if (error instanceof AppError && error.code === ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE) {
            throw createAppError(error.code, 422, error.message, { ...(error.details ?? {}), spent });
        }
        throw error;
    }
    return { provider };
}
