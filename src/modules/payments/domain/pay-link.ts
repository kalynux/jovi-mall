import crypto from 'crypto';
import { PaymentGatewayType, PaymentStatus } from '../models/payment-transaction.model';

/**
 * The hosted payment page's handle, and the rules that decide what it may hand out.
 *
 * ── WHAT GAP-008 ACTUALLY NEEDED FROM THE BACKEND ────────────────────────────
 * `POST /api/payments/initiate` with `gateway: 'STRIPE'` answers an
 * `instructions.clientSecret`, and a client secret is only useful to Stripe.js running in
 * a browser. The bot cannot confirm a card; there is no page reachable from a chat link
 * that can; and `GET /api/payments/:transactionId` — the one read that would feed such a
 * page — is authenticated and scoped to the payer, which a chat link's recipient often is
 * not (see `payment.routes.ts`, and `api-doc/payments/README.md` on why payment links are
 * deliberately shareable).
 *
 * The PAGE is frontend work and is not in this repository. What is here is the door it
 * reads through.
 *
 * ── WHY A TOKEN RATHER THAN THE TRANSACTION ID ───────────────────────────────
 * The obvious move — opening `GET /api/payments/:transactionId` up — was declined, and the
 * argument is already written on that route: transaction ids are the only thing standing
 * between one customer and another's payment record (amount, gateway reference, the orders
 * it settled), so an unauthenticated read on them is a record any caller can walk. A
 * separate 256-bit handle keeps that read shut and bounds the new one by TTL.
 *
 * ── WHY IT LIVES ON THE TRANSACTION AND NOT IN REDIS ─────────────────────────
 * Every other opaque handle in this service is a Redis key (download tokens, geo
 * candidates, login sessions). This one is a field on `payment_transactions`, for three
 * reasons, and the first is the deciding one:
 *
 *   1. **A payment link sits in a chat window.** It has to still work after a deploy, a
 *      Redis restart, and — the one that actually decides it — a CACHE FLUSH. That flush
 *      is an operator button, and `BOT_SURFACE_DB` is already `wholeDbAllowed: false`
 *      precisely because one of its halves must not be flushed. Adding a third thing whose
 *      flush costs a customer their payment is the wrong direction.
 *   2. **The Redis index budget is full.** 5–15 is eleven slots and thirteen things
 *      already; `redis.factory.ts` states in as many words that a third paired database is
 *      not available. A document field costs no index number.
 *   3. **`merchantRef` is the same shape of thing on the same model** — a random opaque
 *      reference, sparse-unique, minted per attempt — so this follows an established
 *      precedent rather than inventing one.
 *
 * Nothing is lost by not being in Redis: expiry is an instant compared at read, and
 * REVOCATION is not needed, because the read re-derives its verdict from the transaction's
 * live status every time. A paid, failed or cancelled transaction stops handing out a
 * client secret whether or not its link has expired.
 */

/** Token prefix, so a value found in a log is identifiable at a glance. */
const PAY_LINK_PREFIX = 'pl_';

/** 32 bytes — the entropy `DownloadTokenHelper` and `PasswordResetService` both use. */
const PAY_LINK_BYTES = 32;

/**
 * How long a link lives, in minutes.
 *
 * Default 30, matched to the checkout stock hold: a reservation lapses at thirty minutes,
 * so a link outliving it would open a payment page for goods no longer held. The remedy
 * for an expired link is a new one, which costs one call.
 */
export function payLinkTtlMinutes(): number {
    const raw = Number(process.env.PAYMENT_LINK_TTL_MINUTES || '30');
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
}

/** A fresh, unguessable handle. */
export function mintPayLinkToken(): string {
    return `${PAY_LINK_PREFIX}${crypto.randomBytes(PAY_LINK_BYTES).toString('hex')}`;
}

/**
 * Shape-check a token before it reaches a query.
 *
 * Not the security control — the unguessability of the stored value is that — but it keeps
 * an obviously wrong path parameter out of the database. Both outcomes answer the SAME 404:
 * a malformed token and an unknown one must be indistinguishable, because a difference is
 * an oracle telling a caller their guess had the right shape.
 */
export function isPayLinkToken(value: string): boolean {
    // A fixed pattern over module constants; no user input reaches the constructor.
    // eslint-disable-next-line no-restricted-syntax -- static pattern, no user input
    return new RegExp(`^${PAY_LINK_PREFIX}[0-9a-f]{${PAY_LINK_BYTES * 2}}$`).test(value);
}

/**
 * Does confirming a payment on this gateway require a browser?
 *
 * Named for the question rather than for the gateway, because the answer is a property of
 * how the gateway completes rather than of its name: Stripe hands back a client secret that
 * only Stripe.js can confirm, while both mobile-money gateways complete on the customer's
 * handset — a USSD prompt, or an OTP typed back into the chat. Minting a hosted link for
 * those would put a web page in front of a flow that already finishes where the customer
 * is, which is the whole reason mobile money is the dominant local method.
 */
export function gatewayRequiresHostedPage(gateway: PaymentGatewayType): boolean {
    return gateway === 'STRIPE';
}

/**
 * What a hosted page may do with this transaction right now.
 *
 *   `payable` — mount the Payment Element and confirm.
 *   `settled` — already paid. Show the receipt; never a client secret.
 *   `closed`  — failed, cancelled or refunded. Nothing to confirm.
 *   `expired` — the link outlived its window. Ask for a new one.
 *
 * ⚠ **Status is checked BEFORE expiry, and the order is the decision.** A customer who paid
 * and comes back an hour later must be told they PAID, not that their link expired — the
 * second reading invites them to pay a second time, which is the one outcome a payment page
 * must never invite.
 */
export type PayLinkState = 'payable' | 'settled' | 'closed' | 'expired';

const SETTLED_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>(['SUCCEEDED']);
const CLOSED_STATUSES: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
    'FAILED',
    'CANCELLED',
    'REFUNDED',
]);

export function payLinkState(input: {
    status: PaymentStatus;
    expiresAt: Date;
    now: Date;
}): PayLinkState {
    if (SETTLED_STATUSES.has(input.status)) return 'settled';
    if (CLOSED_STATUSES.has(input.status)) return 'closed';
    if (input.expiresAt.getTime() <= input.now.getTime()) return 'expired';
    return 'payable';
}

/** Only a payable session ever carries the credential that can move money. */
export function payLinkDisclosesSecret(state: PayLinkState): boolean {
    return state === 'payable';
}

/**
 * The page the customer is sent to.
 *
 * `{STOREFRONT_URL}/pay/{token}` — the storefront rather than this API, for the reason
 * `PasswordResetService.buildResetLink` and the magic-login link both give at length: a URL
 * pasted into WhatsApp or Telegram is FETCHED by the transport to build a preview card, so
 * one that answers with anything other than a page is a dead link every time. It is also
 * the only origin that can mount Stripe.js.
 *
 * Returns null when `STOREFRONT_URL` is unset, which is a real deployment state rather than
 * an error: the mobile-money gateways need no page at all, so a deployment taking only
 * mobile money is complete without one. Callers surface the null rather than fabricating a
 * URL that 404s.
 */
export function buildPayLinkUrl(token: string): string | null {
    const base = process.env.STOREFRONT_URL;
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}/pay/${token}`;
}

/**
 * The Stripe publishable key the hosted page mounts the Payment Element with.
 *
 * ⚠ **It is publishable, and that is a claim worth stating rather than assuming.** Stripe
 * puts it in its own client-side snippets; it identifies the account and can create payment
 * methods, and on its own it can do nothing without a client secret. The secret key is
 * `STRIPE_SECRET_KEY`, read only by `getStripeClient()`, which is server-side.
 *
 * ⚠ **`assertExposedConfigSafe()` guards `/system/config`, not this route.** That whitelist
 * governs what an OPERATOR may read; this value is deliberately sent to an anonymous
 * browser, because a page that cannot mount Stripe.js cannot take a card.
 */
export function stripePublishableKey(): string | null {
    const key = (process.env.STRIPE_PUBLISHABLE_KEY || '').trim();
    if (!key) return null;
    /**
     * Refuse a SECRET key in the publishable slot.
     *
     * This is the one configuration mistake here whose consequence is unbounded — an
     * `sk_live_…` sent to every visitor of a payment page is the whole merchant account —
     * and it is easy to make, the two values differing by a few characters in a `.env`
     * file. Returning null degrades the page to "cards are not configured"; publishing it
     * would not degrade anything at all until it was far too late. Same shape of refusal as
     * `assertUploadScannerSafe()`, one severity down: a warning and a closed door rather
     * than a refused boot, because a misconfigured card key must not stop a
     * mobile-money-only deployment from serving.
     */
    if (/^sk_|^rk_/.test(key)) {
        console.error(
            '[PayLink] STRIPE_PUBLISHABLE_KEY holds a SECRET key (sk_/rk_ prefix). Refusing '
            + 'to publish it — card payment pages will report cards as unconfigured until '
            + 'this is corrected.'
        );
        return null;
    }
    return key;
}
