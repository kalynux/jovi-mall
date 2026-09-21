import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { OptionalPhoneNumberSchema } from '../../../../core/validation/phone';
import { ICustomer } from '../../../customers/customer.model';
import { PaymentGatewayType } from '../../../payments/models/payment-transaction.model';
import { notchPayEnabled, myCoolPayEnabled } from '../../../payments/config/payments.config';
import { resolveCameroonOperator } from '../../../payments/domain/cm-operator';
import { UserPaymentMethodRepository } from '../../../payment-methods/repositories/user-payment-method.repository';
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
 * The fifth member of the set beside `mobileMoneyGateway`, `storedPayerNumber`,
 * `maskedPayerNumber` and `assertNetworkChargeable`, and exported for the same reason: it
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
 * Refuse a number the chosen gateway cannot route to a mobile network — before it costs anything.
 *
 * ── WHY THIS IS CHECKED HERE WHEN THE GATEWAY CHECKS IT ANYWAY ──────────────
 * NotchPay needs the network (MTN or Orange) to open a charge, and works it out inside
 * `NotchPayGateway.initiatePayment` from the number's prefix. That is **after** the handle is spent
 * and **after** `createOrdersFromCart` — so a number in a prefix range `cm-operator.ts` does not
 * list cost the customer their checkout screen AND left an unpaid order with a stock hold behind
 * it. `resolveCameroonOperator` is pure, so the same verdict can be reached before either.
 * (Found by backend-4d.)
 *
 * ⚠ **Only for NotchPay.** My-CoolPay derives the network server-side and needs nothing from us, so
 * refusing a number it would have accepted would be a regression dressed as a check.
 *
 * ⚠ **The SAME resolver and the SAME code the gateway uses** — `PAYMENT_OPERATOR_UNDETERMINED`,
 * 422 — so a customer meets one refusal whichever side of the spend it lands on, and nobody later
 * "unifies" two vocabularies for one condition.
 *
 * ⚠ **EXPORTED for the booking pay screen (`bp`)**, which opens a NotchPay charge with exactly the
 * same gap. `spent` is the caller's to state: pass `false` for a check made before anything
 * irreversible happened, `true` otherwise — the flag is what a screen reads to decide whether a
 * retry is honest.
 */
export function assertNetworkChargeable(gateway: PaymentGatewayType, payerNumber: string, spent: boolean): void {
    if (gateway !== 'NOTCHPAY') return;
    if (resolveCameroonOperator(payerNumber)) return;
    throw createAppError(
        ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
        422,
        'Could not determine the mobile network for this number.',
        { spent, field: 'phone' },
    );
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
 * ⚠ **`gateway_customer_id` IS the phone number for a mobile-money method** — the customer API
 * stores the E.164 value as both gateway ids and returns neither on any endpoint. That rule is
 * inherited whole: it is read here to charge, and it leaves this process only masked.
 *
 * ⚠ **The REPOSITORY, not `paymentMethodService`, and the difference is the point.** That
 * service projects to `PaymentMethodDto`, which deliberately omits both gateway ids — the rule
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
    /** Already sorted default-first, then newest, by the repository itself. */
    const methods = await paymentMethods.list('customer', String(customer._id));
    const wallet = methods.find((method) => method.method_type === 'mobile_money') ?? null;

    const number = wallet?.gateway_customer_id?.trim();
    if (number) return number;

    return customer.phone?.trim() || null;
}

/**
 * Which mobile-money gateway this deployment charges through.
 *
 * ⚠ **Chosen here rather than by the page, and that is not a detail.** Every other entry point
 * takes the gateway from its caller — the storefront names one, the billing module names one —
 * because those callers are the platform's own code. This one's caller is a browser, and a
 * gateway name arriving from a browser is a caller choosing where a stranger's money goes.
 *
 * ⚠ **NotchPay first, deliberately and not alphabetically.** It is the gateway with a working
 * refund integration and a real webhook secret, so a payment taken through it can be reversed
 * by an administrator; My-CoolPay has no refund API at all. When both are configured, the one
 * that can be undone is the one to use.
 *
 * Neither configured is a **configuration** state rather than a fault, and it is refused as
 * such: the deployment cannot take mobile money, and no amount of retrying by the customer
 * changes that.
 *
 * ⚠ **`PAYMENT_GATEWAY_NOT_CONFIGURED` at 500, NOT `PAYMENT_GATEWAY_NOT_SUPPORTED` at 503**, and
 * the pair of changes is one decision. `..._NOT_SUPPORTED` means *"that gateway is not on
 * offer"* — a rule, about a gateway the caller named. This is the opposite situation: nobody
 * named a gateway, and the deployment has none. Borrowing the other code made an operator read a
 * missing secret as a customer asking for something unavailable.
 *
 * The **500 is load-bearing too**: at 503 the category rule yields `external_service`
 * (`error-category.ts`), which sends whoever is on call to look at NotchPay — a third party that
 * is perfectly healthy and simply absent from our `.env`. At 500 it derives to `internal`, our
 * own fault, which is what it is. No override row is needed: `PAYMENT_` is not an integration
 * prefix, so the status rule alone gets this right.
 *
 * ⚠ **EXPORTED, and it must stay THE answer to "which gateway takes a mobile-money charge".** The
 * chat's retry (`bot-checkout.controller.ts`) and the booking pay screen (`bp`) both import it.
 * Three copies of one preference is how a customer ends up with two charges for one basket — or
 * one basket and one appointment — under different refund rules, decided by which door they used.
 */
export function mobileMoneyGateway(): PaymentGatewayType {
    if (notchPayEnabled()) return 'NOTCHPAY';
    if (myCoolPayEnabled()) return 'MYCOOLPAY';
    throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_CONFIGURED,
        500,
        'No mobile money gateway is configured on this deployment',
    );
}
