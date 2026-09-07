import { Types } from 'mongoose';
import {
    PaymentTransactionModel,
    IPaymentTransaction,
} from '../models/payment-transaction.model';
import {
    buildPayLinkUrl,
    gatewayRequiresHostedPage,
    isPayLinkToken,
    mintPayLinkToken,
    payLinkDisclosesSecret,
    payLinkState,
    PayLinkState,
    payLinkTtlMinutes,
    stripePublishableKey,
} from '../domain/pay-link';
import { OrderModel } from '../../orders/order.model';
import { Booking as BookingModel } from '../../booking/models/booking.model';
import { StoreModel } from '../../store/models/store.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * GAP-008's backend half: mint a hosted-card-page link, and resolve one.
 *
 * The page itself is frontend work and is not in this repository — see
 * `domain/pay-link.ts` for what GAP-008 asked for and which of its two options this takes.
 * This service owns the two operations that page needs and nothing else.
 */

/** What a mint hands back. `url` is null when `STOREFRONT_URL` is unset — see buildPayLinkUrl. */
export interface MintedPayLink {
    token: string;
    url: string | null;
    expiresAt: Date;
}

/**
 * What the hosted page reads.
 *
 * ⚠ **This is an explicit projection and must stay one.** The transaction document carries
 * `userId`, `idempotencyKey`, `merchantRef`, `rawGatewayPayloads` and the whole order list —
 * and this object is served to an ANONYMOUS caller holding only a link. A spread would
 * publish whatever the model gains next, silently, which is the argument the public-catalog
 * DTOs make one module over. `test:payments` asserts the absence of each by serialising this
 * shape from a document carrying all of them.
 */
export interface PayLinkSession {
    /** The transaction id. The page needs it to poll `POST /payments/verify`. */
    transactionId: string;
    state: PayLinkState;
    gateway: string;
    /** What the customer agreed to pay, in the catalogue's currency. */
    amount: number;
    currency: string;
    /**
     * What Stripe will actually charge, in the account's presentment currency.
     *
     * The Stripe account settles in USD while the catalogue is priced in XAF, so the number
     * the Payment Element renders is NOT `amount`. Both are sent, because a page showing only
     * one of them is lying to somebody: showing XAF alone contradicts the card statement, and
     * showing USD alone contradicts the order.
     */
    chargedAmount: number | null;
    chargedCurrency: string | null;
    /** ⚠ Present only while `state === 'payable'`. See payLinkDisclosesSecret. */
    clientSecret: string | null;
    /** Null when unconfigured, or when the variable holds a secret key. See stripePublishableKey. */
    publishableKey: string | null;
    expiresAt: string;
    /** What the money is for. Never null — see `PayLinkPaidFor`. */
    paidFor: PayLinkPaidFor;
}

/**
 * What this payment is FOR, in the only terms a stranger may be told.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * The page read, in full, *"Amount due — 24 000 FCFA."* The payer is **by design**
 * often not the person who ordered — that is the whole feature — which makes this the
 * one payment screen on the platform where they have no other way to find out what they
 * are paying for. It is also the screen where they are about to type card details, and a
 * payment page naming no merchant is indistinguishable from a phishing page.
 *
 * ── WHY STRUCTURED FIELDS AND NOT A SENTENCE ─────────────────────────────────
 * The obvious shape, and the one the storefront asked for, is a rendered
 * `description: "3 items from Boutique Ndogbong"`. It was declined, and the reason is
 * the mirror image of the one that put `error.customerMessage` on the bot surface:
 *
 * **This is the one reader this service cannot localise for.** Every other page is
 * served to somebody with an account and a `preferred_language`; the holder of a pay
 * link has neither, and may not exist in this database at all. A sentence composed here
 * would be English on a page that is otherwise fully translated into five languages —
 * and it would be English *in the sentence that says what the money is for*. The
 * storefront knows the reader's locale (it is in the URL it was opened with) and can
 * compose. So: this side sends facts, that side writes the sentence.
 *
 * ── ⚠ WHAT MAY NEVER JOIN THIS OBJECT ────────────────────────────────────────
 * Everything here is read by **an anonymous caller holding a forwarded link**, so the
 * test is not "is it useful" but "does it survive a stranger". Deliberately absent, and
 * none of it is an oversight:
 *
 *   - **the buyer** — no name, no email, no phone, no delivery address;
 *   - **the line items** — no product titles, no SKUs, no per-item prices. A count is a
 *     fact about the basket; a title is a fact about the person who filled it;
 *   - **the service on a booking** — see `sellers` below, which is where the same
 *     reasoning bites hardest.
 */
export interface PayLinkPaidFor {
    /** Which of the two payable things this is. */
    kind: 'order' | 'booking';
    /**
     * The handle the payer can match against the message they were sent —
     * `ORD-2026-000046` or `BKG-2026-000123`. **The first**, when one payment settles a
     * multi-vendor checkout group; `orderCount` says how many there are.
     *
     * Null only for a legacy row carrying no number (both generators post-date some
     * data, and `bookingNumber` is nullable by design — see the booking model).
     */
    reference: string | null;
    /** How many orders this one payment settles. Always 1 for a booking. */
    orderCount: number;
    /** Total line items across those orders. Null for a booking, which has no lines. */
    itemCount: number | null;
    /**
     * The shop(s) being paid, by display name.
     *
     * ⚠ **Always EMPTY for a booking, and that asymmetry is deliberate.** A retail
     * seller's name is already a public storefront page, and naming it tells a stranger
     * only that somebody bought something from a shop. A *service provider's* name is
     * frequently the sensitive fact itself — a clinic, a lawyer, a repair somebody would
     * rather not discuss — and this service cannot tell which vendors are which. A
     * booking therefore travels as its reference and its amount, and the payer confirms
     * with whoever sent them the link.
     *
     * Empty is also the honest answer for an order whose store rows are missing; the
     * page must render without it rather than treating it as a loading state.
     */
    sellers: string[];
}

export class PayLinkService {
    /**
     * Mint (or re-mint) the link for a transaction.
     *
     * ── IT OVERWRITES, AND THE OVERWRITE IS THE REVOCATION ───────────────────
     * A second mint replaces the first, so at most one link per transaction is ever live and
     * an old one stops resolving immediately. That is what makes "the customer lost the
     * message, send it again" safe: the link that went to the wrong chat, or that somebody
     * forwarded, dies the moment a replacement is issued.
     *
     * ── IT REFUSES A TRANSACTION THAT NEEDS NO PAGE ──────────────────────────
     * Mobile money completes on the handset. A link for one would open a page with nothing
     * to confirm, and the customer would sit on it waiting — the exact failure GAP-012 warns
     * about in the other direction. `422 PAYMENT_LINK_NOT_APPLICABLE` names the reason.
     *
     * ── AND ONE THAT IS ALREADY DONE ─────────────────────────────────────────
     * A settled or closed transaction gets `422 PAYMENT_LINK_NOT_PAYABLE`. Minting one would
     * produce a link whose only possible answer is "you already paid" — which the resolve
     * does say, for a link minted while it was still payable, because that is a customer who
     * is legitimately coming back. Issuing a fresh one for a finished payment is different:
     * it is the platform inviting a second attempt.
     */
    async mint(transactionId: string): Promise<MintedPayLink> {
        const transaction = await this.loadById(transactionId);

        if (!gatewayRequiresHostedPage(transaction.gateway)) {
            throw createAppError(
                ERROR_CODES.PAYMENT_LINK_NOT_APPLICABLE,
                422,
                `${transaction.gateway} payments complete on the customer's handset and need no payment page`,
            );
        }

        const state = payLinkState({
            status: transaction.status,
            // No link exists yet, so expiry cannot be the reason this is refused. A far-future
            // instant lets the pure rule answer purely on STATUS, which is the only question
            // being asked here — rather than being given `now` and answering `expired` for a
            // transaction that is merely finished.
            expiresAt: new Date(8640000000000000),
            now: new Date(),
        });
        if (state !== 'payable') {
            throw createAppError(
                ERROR_CODES.PAYMENT_LINK_NOT_PAYABLE,
                422,
                `This payment is ${transaction.status.toLowerCase()} and cannot be paid again`,
            );
        }

        const token = mintPayLinkToken();
        const issuedAt = new Date();
        const expiresAt = new Date(issuedAt.getTime() + payLinkTtlMinutes() * 60_000);

        await PaymentTransactionModel.updateOne(
            { _id: transaction._id },
            { $set: { payLink: { token, issuedAt, expiresAt } } },
        );

        return { token, url: buildPayLinkUrl(token), expiresAt };
    }

    /**
     * Resolve a link into the session a payment page can mount.
     *
     * ── UNAUTHENTICATED, AND EVERY REFUSAL IS THE SAME 404 ───────────────────
     * A malformed token, an unknown one and a superseded one are indistinguishable, on
     * purpose: any difference between them is an oracle telling a caller whether their guess
     * had the right shape or hit a real row. The same reasoning `MAGIC_CODE_INVALID` gives
     * for collapsing four situations into one code.
     *
     * ⚠ **An EXPIRED link is the one exception and resolves normally**, answering
     * `state: 'expired'`. It has to: the page's whole job at that point is to tell the
     * customer their link lapsed and offer a fresh one, and a 404 would render "this payment
     * does not exist" to somebody looking at their own order. The token was already valid
     * once, so there is no oracle — the caller learns nothing they did not already hold.
     */
    async resolve(token: string): Promise<PayLinkSession> {
        if (!isPayLinkToken(token)) throw this.notFound();

        /**
         * ⚠ The source linkage (`orderId`/`bookingId`/`cartId`/`orderIds`) is selected so
         * `describePaidFor` can resolve what this is for — and **none of those ids is ever
         * returned**. They are the input to a lookup, not output: an id in the response is
         * an id a stranger holding a forwarded link can take somewhere else.
         * `test:payments` asserts both halves separately for that reason.
         */
        // ⚠ ONE string literal, deliberately — `test:payments` reads this select with a regex
        // to prove the payer and our gateway references are not in it, and a concatenation
        // would make that guard match nothing and pass on an empty field list.
        const transaction = await PaymentTransactionModel.findOne({ 'payLink.token': token })
            .select('gateway status amountSnapshot currencySnapshot rawGatewayPayloads payLink orderId bookingId cartId orderIds')
            .lean();

        if (!transaction?.payLink) throw this.notFound();

        const state = payLinkState({
            status: transaction.status,
            expiresAt: new Date(transaction.payLink.expiresAt),
            now: new Date(),
        });

        const instructions = this.latestInstructions(transaction as unknown as IPaymentTransaction);
        const paidFor = await this.describePaidFor(transaction as unknown as IPaymentTransaction);

        return {
            transactionId: String(transaction._id),
            state,
            gateway: transaction.gateway,
            amount: transaction.amountSnapshot,
            currency: transaction.currencySnapshot,
            chargedAmount: typeof instructions.chargedAmount === 'number' ? instructions.chargedAmount : null,
            chargedCurrency: typeof instructions.chargedCurrency === 'string' ? instructions.chargedCurrency : null,
            /**
             * ⚠ The gate is `payLinkDisclosesSecret`, not `state === 'payable'` written out
             * again. One predicate, one place — a second copy is how the resolve and the page
             * come to disagree about when a credential travels.
             */
            clientSecret: payLinkDisclosesSecret(state)
                ? (typeof instructions.clientSecret === 'string' ? instructions.clientSecret : null)
                : null,
            publishableKey: payLinkDisclosesSecret(state) ? stripePublishableKey() : null,
            expiresAt: new Date(transaction.payLink.expiresAt).toISOString(),
            paidFor,
        };
    }

    /**
     * Resolve what a transaction is for, in terms safe to hand a stranger.
     *
     * The privacy rules and the reason each field is (or is not) here are on
     * `PayLinkPaidFor`. This method's own three properties:
     *
     *  - **It never throws.** A missing order, a deleted store, a legacy row with no
     *    number — every one of them degrades to a thinner answer, because failing here
     *    would take down a payment page over a caption. The amount and the card form are
     *    the page's job; this is the sentence above them.
     *  - **Two indexed reads at most**, both by `_id`. The route is unauthenticated, so
     *    cost matters — but a 256-bit token cannot be walked, and a caller can only ever
     *    hammer a link they already hold.
     *  - **It reads MODELS, never services.** `payments` already imports these three
     *    models directly (see `dispute.service.ts`); reaching for `OrderService` here
     *    would close an import cycle, since orders imports payments back.
     */
    private async describePaidFor(transaction: IPaymentTransaction): Promise<PayLinkPaidFor> {
        if (transaction.bookingId) {
            const booking = await BookingModel.findById(transaction.bookingId)
                .select('bookingNumber')
                .lean();

            return {
                kind: 'booking',
                reference: booking?.bookingNumber ?? null,
                orderCount: 1,
                itemCount: null,
                // Never populated for a booking. See PayLinkPaidFor.sellers.
                sellers: [],
            };
        }

        /**
         * `orderIds` is the checkout group; `orderId` the single-order case. Exactly one
         * of the three source fields is set — the model enforces it with a pre-save hook —
         * so this covers everything that is not a booking.
         */
        const orderIds = transaction.orderIds?.length
            ? transaction.orderIds
            : transaction.orderId
                ? [transaction.orderId]
                : [];

        if (orderIds.length === 0) {
            return { kind: 'order', reference: null, orderCount: 0, itemCount: null, sellers: [] };
        }

        const orders = await OrderModel.find({ _id: { $in: orderIds } })
            .select('order_number vendor_id items')
            .lean();

        /**
         * ⚠ Sorted by order number, so a multi-vendor group reports the SAME first
         * reference on every read. `$in` does not promise document order, and a caption
         * that names a different order each time a page is refreshed reads as a fault.
         */
        const numbers = orders
            .map((order) => order.order_number)
            .filter((n): n is string => typeof n === 'string' && n.length > 0)
            .sort();

        const vendorIds = [...new Set(orders.map((order) => String(order.vendor_id)))];
        const stores = await StoreModel.find({ vendor_id: { $in: vendorIds } })
            .select('name')
            .lean();

        return {
            kind: 'order',
            reference: numbers[0] ?? null,
            orderCount: orders.length,
            itemCount: orders.reduce((sum, order) => sum + (order.items?.length ?? 0), 0),
            sellers: stores
                .map((store) => store.name)
                .filter((name): name is string => typeof name === 'string' && name.length > 0)
                .sort(),
        };
    }

    /**
     * The gateway instructions from the most recent attempt.
     *
     * `rawGatewayPayloads` is append-only across a multi-step flow, so the LAST entry is the
     * live one — the same read `PaymentOrchestratorService` does when it returns an existing
     * transaction from a repeated `initiate`. Reading the first would hand back a client
     * secret for a PaymentIntent that has since been superseded.
     */
    private latestInstructions(transaction: IPaymentTransaction): Record<string, unknown> {
        const payloads = transaction.rawGatewayPayloads ?? [];
        const last = payloads[payloads.length - 1] as { instructions?: Record<string, unknown> } | undefined;
        return last?.instructions ?? {};
    }

    private async loadById(transactionId: string): Promise<IPaymentTransaction> {
        if (!Types.ObjectId.isValid(transactionId)) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }
        const transaction = await PaymentTransactionModel.findById(transactionId);
        if (!transaction) {
            throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
        }
        return transaction;
    }

    private notFound(): Error {
        return createAppError(
            ERROR_CODES.PAYMENT_LINK_NOT_FOUND,
            404,
            'This payment link is not valid. Ask for a new one.',
        );
    }
}

export const payLinkService = new PayLinkService();
