/**
 * Central Error Code Registry
 *
 * Rules:
 * - All codes must follow `DOMAIN_SCREAMING_SNAKE_CASE` naming.
 * - Generic codes (NOT_FOUND, FORBIDDEN, etc.) are FORBIDDEN in service layer.
 *   They may only be used inside middleware as router-level / catch-all fallbacks.
 * - INTERNAL_SERVER_ERROR is assigned automatically by the global error handler
 *   for unknown/non-operational errors.
 * - Object.freeze prevents mutation at runtime.
 */

type DomainPrefix =
    | 'AUTH'
    | 'PAYMENT'
    | 'BOOKING'
    | 'TICKET'
    | 'DIGITAL'
    | 'WHATSAPP'
    | 'TELEGRAM'
    | 'GOOGLE'
    | 'INTEGRATION'
    | 'DATABASE'
    | 'ORDER'
    | 'REFUND'
    | 'CONFIG'
    | 'MAIL'
    | 'VENDOR'
    | 'CATALOG'
    | 'ANALYTICS'
    | 'DELIVERY'
    | 'GEO'
    | 'CONNECTION'
    | 'BILLING'
    | 'EARNINGS'
    | 'COD'
    | 'INVENTORY'     // what an agency warehouses, per depot
    | 'STOCK'         // the two-sided stock-adjustment request flow
    | 'REVIEW'        // reviews & ratings — products AND deliveries
    | 'SYSTEM'        // operations surface: maintenance mode, cache controls
    | 'INTERNAL'      // INTERNAL_SERVER_ERROR
    | 'NOT'           // NOT_FOUND — router-level only
    | 'REQUEST'       // body-parser rejections — global handler only (Phase 16)
    | 'RATE'          // RATE_LIMIT_EXCEEDED — rate-limit middleware only (Phase 16)
    // Per-gateway prefixes. These are also the `INTEGRATION_PREFIXES` in
    // `error-category.ts`, so any of them raised at 5xx is `external_service` and has its
    // message and details replaced at the boundary — which is what a third party's
    // diagnostics should get. `STRIPE` was in use before it was ever listed here.
    | 'STRIPE'
    | 'NOTCHPAY'
    | 'MYCOOLPAY'
    | 'VALIDATION';   // VALIDATION_ERROR — ZodError catch in global handler only

// Compile-time check: every key must start with a known domain prefix.
// Usage: type Check = ValidCode<'AUTH_INVALID_CREDENTIALS'> // 'AUTH_INVALID_CREDENTIALS'
export type ValidCode<T extends string> = T extends `${DomainPrefix}_${string}` ? T : never;

export const ERROR_CODES = Object.freeze({
    // ── AUTH ──────────────────────────────────────────────────────────────────
    AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
    AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
    AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
    AUTH_MISSING_TOKEN: 'AUTH_MISSING_TOKEN',
    AUTH_ROLE_NOT_FOUND: 'AUTH_ROLE_NOT_FOUND',
    AUTH_ROLE_ALREADY_EXISTS: 'AUTH_ROLE_ALREADY_EXISTS',
    AUTH_ROLE_REQUIRED: 'AUTH_ROLE_REQUIRED',
    AUTH_ACCOUNT_NOT_FOUND: 'AUTH_ACCOUNT_NOT_FOUND',
    AUTH_PHONE_TAKEN: 'AUTH_PHONE_TAKEN',
    AUTH_EMAIL_TAKEN: 'AUTH_EMAIL_TAKEN',
    AUTH_EMAIL_ALREADY_VERIFIED: 'AUTH_EMAIL_ALREADY_VERIFIED',
    AUTH_EMAIL_MISSING: 'AUTH_EMAIL_MISSING',
    AUTH_VERIFY_TOKEN_INVALID: 'AUTH_VERIFY_TOKEN_INVALID',
    /**
     * A password-reset token was absent, expired, malformed or already spent.
     *
     * Deliberately **one code for all four**. Telling a caller which of them applies tells
     * an attacker whether a token they hold was ever real, and the remedy is identical in
     * every case: ask for a new link. Distinct from `AUTH_VERIFY_TOKEN_INVALID` only so the
     * client can put the right copy and the right "resend" button on the screen — the two
     * flows land on different pages.
     */
    AUTH_RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
    AUTH_PROFILE_NOT_FOUND: 'AUTH_PROFILE_NOT_FOUND',
    AUTH_UNSUPPORTED_ROLE: 'AUTH_UNSUPPORTED_ROLE',
    AUTH_REFRESH_TOKEN_INVALID: 'AUTH_REFRESH_TOKEN_INVALID',
    AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',

    /**
     * The credential was minted before the account's password was changed.
     *
     * Its own code rather than `AUTH_SESSION_EXPIRED`, because the two ask the client for
     * different things and one of them is a security message: "your session timed out" is a
     * shrug, while "your password was changed" is what tells the person whose account was
     * taken over that the eviction they asked for actually happened — or warns the one who
     * did not ask for it. Raised at 401 on both credential paths, `requireAuth` (access) and
     * `rotateRefreshToken` (refresh), which together are what makes a password change a
     * revocation. See `core/auth/password-epoch.ts`.
     *
     * 401, not 403: unlike a suspension, re-authenticating is exactly the remedy.
     */
    AUTH_PASSWORD_CHANGED: 'AUTH_PASSWORD_CHANGED',

    /**
     * The sign-in itself has outlived the 90-day absolute cap — ADR-A03 D-1.
     *
     * Its own code rather than `AUTH_SESSION_EXPIRED`, and the distinction is the whole
     * point of raising it (D-10). `AUTH_SESSION_EXPIRED` is routine and REFRESHABLE — the
     * client renews and carries on. This one is not: no credential the client holds can
     * renew it, because the claim it failed on is copied unchanged through every rotation.
     * A client that reads them as the same thing loops forever against a session that is
     * never coming back. And unlike `AUTH_PASSWORD_CHANGED` it carries no alarm: nothing is
     * wrong, the quarter simply ended.
     *
     * The remedy is exactly one thing, and the api-doc says it in those words: **route to
     * login, never retry.**
     *
     * Raised at 401 on both credential paths — `requireAuth` (access, and therefore the two
     * re-issue routes behind it) and `rotateRefreshToken` (refresh). See
     * `core/auth/session-cap.ts`. 401, not 403: re-authenticating IS the remedy.
     */
    AUTH_SESSION_CAP_REACHED: 'AUTH_SESSION_CAP_REACHED',
    AUTH_USER_NOT_FOUND: 'AUTH_USER_NOT_FOUND',
    AUTH_ROLE_PROFILE_NOT_FOUND: 'AUTH_ROLE_PROFILE_NOT_FOUND',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',

    /**
     * The credentials were fine; the account is suspended.
     *
     * Deliberately distinct from AUTH_INVALID_CREDENTIALS. A suspended person who is
     * told "wrong password" retries, resets, and eventually opens a ticket nobody can
     * resolve — the platform knows exactly why they are locked out and saying so costs
     * nothing, because the check runs only AFTER the password comparison, so it is not
     * an oracle over accounts a caller cannot already authenticate to.
     *
     * Raised on three paths, which together are what makes a suspension take effect:
     * login, refresh-token rotation, and every authenticated request (`requireAuth`).
     */
    AUTH_ACCOUNT_SUSPENDED: 'AUTH_ACCOUNT_SUSPENDED',

    /**
     * The vendor role entity is suspended, though the account itself is fine.
     *
     * Its own code rather than `AUTH_ACCOUNT_SUSPENDED`, because the two have different
     * remedies and a client has to be able to say which happened: "your login is
     * suspended" ends every session on every role, while "your shop is suspended" leaves
     * the same person's customer account working. Raised by `requireAuth` and `login`.
     */
    AUTH_VENDOR_SUSPENDED: 'AUTH_VENDOR_SUSPENDED',

    /**
     * The account was CLOSED by the person who owned it (ADR-A02 D-1).
     *
     * Its own code rather than `AUTH_ACCOUNT_SUSPENDED`, for the reason that code's own
     * neighbour gives: the two have different remedies and a client has to be able to say
     * which happened. A suspension has an appeal and a `restore`; a closure has neither, and
     * telling somebody who anonymised their own account that it is "suspended" invites a
     * support ticket asking to have it lifted.
     *
     * Raised on the same three paths a suspension is — login, refresh rotation, `requireAuth`
     * — plus the password-reset redemption, and always BEFORE the suspension check, because a
     * closed account is not an active one and both guards would otherwise match.
     *
     * In practice a client rarely sees it: closure removes both login identifiers, so `login`
     * cannot resolve the account at all. It is what the live access token minted seconds
     * earlier meets.
     */
    AUTH_ACCOUNT_CLOSED: 'AUTH_ACCOUNT_CLOSED',

    // ── PAYMENT ───────────────────────────────────────────────────────────────
    PAYMENT_ORDER_NOT_FOUND: 'PAYMENT_ORDER_NOT_FOUND',
    PAYMENT_ORDER_ALREADY_PAID: 'PAYMENT_ORDER_ALREADY_PAID',
    PAYMENT_INVALID_ORDER_STATUS: 'PAYMENT_INVALID_ORDER_STATUS',
    PAYMENT_GATEWAY_NOT_SUPPORTED: 'PAYMENT_GATEWAY_NOT_SUPPORTED',
    PAYMENT_INITIATION_FAILED: 'PAYMENT_INITIATION_FAILED',
    PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',
    PAYMENT_BOOKING_NOT_FOUND: 'PAYMENT_BOOKING_NOT_FOUND',
    PAYMENT_BOOKING_CANCELLED: 'PAYMENT_BOOKING_CANCELLED',
    PAYMENT_BOOKING_NO_PAYMENT_REQUIRED: 'PAYMENT_BOOKING_NO_PAYMENT_REQUIRED',
    PAYMENT_BOOKING_ALREADY_PAID: 'PAYMENT_BOOKING_ALREADY_PAID',
    PAYMENT_BOOKING_IN_PROGRESS: 'PAYMENT_BOOKING_IN_PROGRESS',
    PAYMENT_TRANSACTION_NOT_FOUND: 'PAYMENT_TRANSACTION_NOT_FOUND',
    PAYMENT_WEBHOOK_INVALID_PAYLOAD: 'PAYMENT_WEBHOOK_INVALID_PAYLOAD',
    PAYMENT_MISSING_BOOKING_ID: 'PAYMENT_MISSING_BOOKING_ID',
    PAYMENT_GATEWAY_NOT_IMPLEMENTED: 'PAYMENT_GATEWAY_NOT_IMPLEMENTED',
    PAYMENT_CARD_DECLINED: 'PAYMENT_CARD_DECLINED',
    PAYMENT_CART_NOT_FOUND: 'PAYMENT_CART_NOT_FOUND',
    PAYMENT_CART_NO_PAYABLE_ORDERS: 'PAYMENT_CART_NO_PAYABLE_ORDERS',
    PAYMENT_CART_MIXED_CURRENCY: 'PAYMENT_CART_MIXED_CURRENCY',
    PAYMENT_REFERENCE_REQUIRED: 'PAYMENT_REFERENCE_REQUIRED',
    PAYMENT_ORDER_IS_COD: 'PAYMENT_ORDER_IS_COD',
    STRIPE_WEBHOOK_SIGNATURE_INVALID: 'STRIPE_WEBHOOK_SIGNATURE_INVALID',
    /**
     * A mobile-money charge could not be routed to MTN or Orange.
     *
     * NotchPay's direct charge takes an explicit `channel`, so the operator has to be
     * known before the call. The client did not declare one and the number's prefix is
     * outside the published Cameroon ranges (Nexttel, Camtel, a ported number, a typo).
     * Raised rather than guessed: charging `cm.mtn` for an Orange number fails at the
     * provider and reaches the customer as "payment declined", which is a worse
     * conversation than "which network is this number on?".
     */
    PAYMENT_OPERATOR_UNDETERMINED: 'PAYMENT_OPERATOR_UNDETERMINED',
    /**
     * A currency with a minor unit was sent to a mobile-money gateway.
     *
     * Both mobile rails settle in XAF and take a plain whole number. Passing a
     * two-decimal currency through unconverted charges 1/100th of the price, and
     * converting it invents an exchange rate nobody configured.
     */
    PAYMENT_CURRENCY_NOT_SUPPORTED: 'PAYMENT_CURRENCY_NOT_SUPPORTED',
    /**
     * A verified callback reported an amount or currency that is not what we recorded.
     *
     * The signature passed, so this is not a forgery in the ordinary sense — it is a
     * mismatch between what the provider says was paid and what the order costs, and
     * settling on the provider's figure is how a one-franc payment buys a phone. It is
     * ALSO the compensating control for My-CoolPay's MD5 signature: an attacker who
     * defeated that construction still cannot choose the amount.
     */
    PAYMENT_WEBHOOK_AMOUNT_MISMATCH: 'PAYMENT_WEBHOOK_AMOUNT_MISMATCH',
    /** The submitted mobile-money OTP was wrong. */
    PAYMENT_OTP_INVALID: 'PAYMENT_OTP_INVALID',
    /** `POST /payments/:id/authorize` on a transaction that is not awaiting an OTP. */
    PAYMENT_OTP_NOT_REQUIRED: 'PAYMENT_OTP_NOT_REQUIRED',
    /**
     * Too many wrong OTP submissions; the transaction is failed.
     *
     * 422 rather than 429: nothing is throttled and waiting changes nothing. The payment
     * is over and the customer must start a new one.
     */
    PAYMENT_OTP_ATTEMPTS_EXCEEDED: 'PAYMENT_OTP_ATTEMPTS_EXCEEDED',

    // ── The hosted card page (GAP-008) ────────────────────────────────────────
    /**
     * The link is malformed, unknown, or superseded by a newer one.
     *
     * ⚠ **One code for all three, deliberately.** Any difference between them is an oracle
     * telling an anonymous caller whether their guess had the right shape or hit a real
     * row — the same reasoning `MAGIC_CODE_INVALID` gives for collapsing four situations.
     * An EXPIRED link is NOT this code: it resolves normally with `state: 'expired'`, so
     * the page can offer a fresh one rather than claim the payment does not exist.
     */
    PAYMENT_LINK_NOT_FOUND: 'PAYMENT_LINK_NOT_FOUND',
    /**
     * A hosted page was asked for on a gateway that completes on the handset.
     *
     * 422 rather than 400: the request is well-formed and the refusal is a rule about
     * mobile money, which needs no browser at all.
     */
    PAYMENT_LINK_NOT_APPLICABLE: 'PAYMENT_LINK_NOT_APPLICABLE',
    /** A link was asked for on a transaction that is already settled, failed or cancelled. */
    PAYMENT_LINK_NOT_PAYABLE: 'PAYMENT_LINK_NOT_PAYABLE',

    // ── NOTCHPAY / MYCOOLPAY ──────────────────────────────────────────────────
    // Raised at 5xx only, so `INTEGRATION_PREFIXES` files them as `external_service`
    // and the boundary replaces the message and drops `details`. That is deliberate:
    // the diagnostics are for our logs, and a provider's own error text is not
    // something to relay to a shopper.
    /** The provider answered, and answered non-2xx. */
    NOTCHPAY_REQUEST_FAILED: 'NOTCHPAY_REQUEST_FAILED',
    /** The provider did not answer at all — timeout, DNS, connection refused. */
    NOTCHPAY_UNREACHABLE: 'NOTCHPAY_UNREACHABLE',
    MYCOOLPAY_REQUEST_FAILED: 'MYCOOLPAY_REQUEST_FAILED',
    MYCOOLPAY_UNREACHABLE: 'MYCOOLPAY_UNREACHABLE',

    // ── REFUND ────────────────────────────────────────────────────────────────
    REFUND_NOT_ELIGIBLE: 'REFUND_NOT_ELIGIBLE',
    REFUND_WINDOW_EXPIRED: 'REFUND_WINDOW_EXPIRED',
    REFUND_POLICY_DISABLED: 'REFUND_POLICY_DISABLED',
    REFUND_AMOUNT_EXCEEDS_MAX: 'REFUND_AMOUNT_EXCEEDS_MAX',
    REFUND_ALREADY_FULLY_REFUNDED: 'REFUND_ALREADY_FULLY_REFUNDED',
    REFUND_PAYMENT_NOT_FOUND: 'REFUND_PAYMENT_NOT_FOUND',
    REFUND_ORDER_NOT_PAID: 'REFUND_ORDER_NOT_PAID',
    REFUND_GATEWAY_FAILED: 'REFUND_GATEWAY_FAILED',
    REFUND_GATEWAY_NOT_SUPPORTED: 'REFUND_GATEWAY_NOT_SUPPORTED',
    /** The order a group payment names could not be loaded — its per-order ceiling is unknowable. */
    REFUND_ORDER_NOT_FOUND: 'REFUND_ORDER_NOT_FOUND',
    /**
     * A COD order was never charged through a gateway, so there is nothing to refund.
     * Its own code rather than falling through to `REFUND_PAYMENT_NOT_FOUND`, which reads
     * as "the record is missing" when the truth is "this money never went through a
     * gateway" — a different conversation with the customer.
     */
    REFUND_ORDER_IS_COD: 'REFUND_ORDER_IS_COD',
    /**
     * An administrator asked to refund outside the vendor's commercial policy without
     * saying so. The override is available; it has to be deliberate and reasoned.
     */
    REFUND_POLICY_OVERRIDE_REQUIRED: 'REFUND_POLICY_OVERRIDE_REQUIRED',

    // ── TICKET ────────────────────────────────────────────────────────────────
    TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
    TICKET_UPDATE_FAILED: 'TICKET_UPDATE_FAILED',
    TICKET_ASSIGN_FAILED: 'TICKET_ASSIGN_FAILED',
    TICKET_PRIORITY_UPDATE_FAILED: 'TICKET_PRIORITY_UPDATE_FAILED',
    TICKET_CLOSE_FAILED: 'TICKET_CLOSE_FAILED',
    TICKET_REOPEN_FAILED: 'TICKET_REOPEN_FAILED',
    TICKET_GENERAL_UPDATE_FAILED: 'TICKET_GENERAL_UPDATE_FAILED',
    TICKET_ACCESS_DENIED: 'TICKET_ACCESS_DENIED',
    TICKET_FOLLOWER_LIMIT_EXCEEDED: 'TICKET_FOLLOWER_LIMIT_EXCEEDED',
    TICKET_ATTACHMENT_LIMIT_EXCEEDED: 'TICKET_ATTACHMENT_LIMIT_EXCEEDED',
    TICKET_ATTACHMENT_MISSING: 'TICKET_ATTACHMENT_MISSING',
    TICKET_PRIORITY_LOCKED: 'TICKET_PRIORITY_LOCKED',
    TICKET_INVALID_STATUS_TRANSITION: 'TICKET_INVALID_STATUS_TRANSITION',
    TICKET_CLOSED: 'TICKET_CLOSED',
    TICKET_WAITING_TARGET_NOT_PARTICIPANT: 'TICKET_WAITING_TARGET_NOT_PARTICIPANT',
    TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN: 'TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN',
    TICKET_REQUIRED_INFO_MISSING: 'TICKET_REQUIRED_INFO_MISSING',
    TICKET_ENTITY_NOT_FOUND: 'TICKET_ENTITY_NOT_FOUND',

    // ── DIGITAL DELIVERY ──────────────────────────────────────────────────────
    DIGITAL_INVALID_ENTITLEMENT_ID: 'DIGITAL_INVALID_ENTITLEMENT_ID',
    DIGITAL_ENTITLEMENT_NOT_FOUND: 'DIGITAL_ENTITLEMENT_NOT_FOUND',
    DIGITAL_ENTITLEMENT_UNAUTHORIZED: 'DIGITAL_ENTITLEMENT_UNAUTHORIZED',
    DIGITAL_ENTITLEMENT_REVOKED: 'DIGITAL_ENTITLEMENT_REVOKED',
    DIGITAL_ENTITLEMENT_EXPIRED: 'DIGITAL_ENTITLEMENT_EXPIRED',
    DIGITAL_ENTITLEMENT_ALREADY_REVOKED: 'DIGITAL_ENTITLEMENT_ALREADY_REVOKED',
    DIGITAL_ENTITLEMENT_NOT_REVOKED: 'DIGITAL_ENTITLEMENT_NOT_REVOKED',
    DIGITAL_DOWNLOAD_LIMIT_EXCEEDED: 'DIGITAL_DOWNLOAD_LIMIT_EXCEEDED',
    DIGITAL_TOKEN_INVALID: 'DIGITAL_TOKEN_INVALID',

    // ── MESSAGING CHANNEL CONNECTIONS ─────────────────────────────────────────
    // Replaces the WHATSAPP_*_LINKED / TELEGRAM_LINK_* pairs the two predecessor
    // mechanisms raised. Each is raised at exactly ONE status — `test:errors`
    // censuses every createAppError site and fails if a code appears at two
    // statuses that disagree on category.
    //
    // ⚠ `CONNECTION_CODE_*` here is about a messaging CODE. The bare
    // `CONNECTION_*` family further down (`CONNECTION_NOT_FOUND`,
    // `CONNECTION_ALREADY_EXISTS`, …) belongs to the vendor↔agency consensual
    // linking domain in `modules/agency-connections` — an entirely different
    // thing that happens to share the English word. The two do not overlap, and
    // this module's non-code errors are `MESSAGING_*`-prefixed to keep it that
    // way.
    CONNECTION_CODE_INVALID: 'CONNECTION_CODE_INVALID',
    CONNECTION_CODE_EXPIRED: 'CONNECTION_CODE_EXPIRED',
    CONNECTION_CODE_ATTEMPTS_EXCEEDED: 'CONNECTION_CODE_ATTEMPTS_EXCEEDED',
    CONNECTION_CODE_GENERATION_FAILED: 'CONNECTION_CODE_GENERATION_FAILED',
    MESSAGING_IDENTITY_ALREADY_LINKED: 'MESSAGING_IDENTITY_ALREADY_LINKED',
    MESSAGING_CONNECTION_NOT_FOUND: 'MESSAGING_CONNECTION_NOT_FOUND',
    MESSAGING_IDENTITY_UNRESOLVED: 'MESSAGING_IDENTITY_UNRESOLVED',
    WEBHOOK_SECRET_INVALID: 'WEBHOOK_SECRET_INVALID',

    // ── PASSWORDLESS SIGN-IN (`/login` from a bot) ────────────────────────────
    // The credentials a `/login` bot command hands out: a magic LINK (an opaque
    // token) and an 8-character CODE, both for one session, both single-use.
    //
    // ⚠ These are 401s, not 400s, and the difference is deliberate: they are
    // CREDENTIALS, and the remedy is to obtain another one rather than to fix a
    // field. A client that files them as validation errors will highlight an
    // input box when what the user needs is to send /login again.
    //
    // ⚠ `MAGIC_CODE_INVALID` is ONE code for four distinct situations — wrong
    // code, unknown identifier, expired-and-swept, and a code/identifier
    // mismatch. Splitting it would turn the redeem endpoint into a registration
    // oracle answering "is this phone a customer here?" for any number anybody
    // cares to type. See `messaging-login.service.ts`.
    MAGIC_LINK_INVALID: 'MAGIC_LINK_INVALID',
    MAGIC_LINK_EXPIRED: 'MAGIC_LINK_EXPIRED',
    MAGIC_CODE_INVALID: 'MAGIC_CODE_INVALID',
    MAGIC_CODE_EXPIRED: 'MAGIC_CODE_EXPIRED',
    MAGIC_ATTEMPTS_EXCEEDED: 'MAGIC_ATTEMPTS_EXCEEDED',
    MAGIC_CONTACT_UNVERIFIED: 'MAGIC_CONTACT_UNVERIFIED',
    MAGIC_SESSION_GENERATION_FAILED: 'MAGIC_SESSION_GENERATION_FAILED',

    // ── ADMINISTRATOR-INITIATED ACCOUNT RECOVERY ──────────────────────────────
    // An operator asking the platform to send a party a way back into their own
    // account. See `messaging-login/services/admin-credential-delivery.service.ts`.
    //
    // ⚠ There is no `USER_CHANNEL_UNVERIFIED` and that is a decision, not a gap:
    // `IUser` carries no `email_verified`. Verification flags live on the ROLE
    // entities, a user may hold several roles, and `login_email` is already the
    // address `POST /auth/forgot-password` mails a live reset token to with no
    // check at all.
    /** The party has no address on the requested channel. */
    USER_CHANNEL_UNAVAILABLE: 'USER_CHANNEL_UNAVAILABLE',
    /** Rate limit — per party OR per administrator; `details.scope` says which. */
    USER_CREDENTIAL_LINK_THROTTLED: 'USER_CREDENTIAL_LINK_THROTTLED',
    /** A sign-in link was asked for on an account that is not a customer. */
    USER_LOGIN_LINK_ROLE_UNSUPPORTED: 'USER_LOGIN_LINK_ROLE_UNSUPPORTED',
    /** The channel accepted the request and did not deliver. A 502, not a 400. */
    MESSAGING_DELIVERY_FAILED: 'MESSAGING_DELIVERY_FAILED',


    // ── THE BOT SURFACE (`/api/internal/bot/*`, GAP-001) ──────────────────────
    // The curated door the automation layer acts through. Nothing here is raised
    // anywhere else, and nothing else is raised BY the identity guard — a caller
    // reading `BOT_*` knows the refusal came from that surface's own door rather
    // than from the delegate underneath it, which matters because everything
    // underneath is an ordinary customer-API error the bot relays unchanged.
    //
    // ⚠ The identity refusals are deliberately SEPARATE from the `MAGIC_*` family
    // even though both are produced by the same resolver. `MAGIC_*` describes a
    // human redeeming a credential; these describe a machine that could not be
    // told which human it is acting for. A client branches on them differently:
    // one asks the person to try again, the other stops the flow.
    //
    // The resolver's `account_inactive` maps to the platform-wide
    // `AUTH_ACCOUNT_SUSPENDED` rather than to a `BOT_*` code of its own — a
    // suspended account is a fact about the account, not about this door.

    /** No platform account for this messaging identity. `details.state` says which. */
    BOT_IDENTITY_UNRESOLVED: 'BOT_IDENTITY_UNRESOLVED',
    /** Telegram, first contact: the chat is anonymous until a contact is shared. */
    BOT_IDENTITY_NEEDS_CONTACT: 'BOT_IDENTITY_NEEDS_CONTACT',
    /**
     * The account exists and holds no customer role — or this messaging identity
     * belongs to a different account. Both are 403 and both are ONE code, because
     * distinguishing them would tell a caller that some *other* account owns the
     * number they are writing from.
     */
    BOT_IDENTITY_NOT_CUSTOMER: 'BOT_IDENTITY_NOT_CUSTOMER',

    // ── The sealed identity token (the MCP transport) ─────────────────────────
    // Both 401, so both derive `authentication` from the status rule and neither
    // needs an entry in `error-category.ts`. They are TWO codes rather than one
    // because the correct client response differs: an expired token means "re-read
    // the one you were given this turn", an invalid one means the caller authored
    // something it had no business authoring. Neither carries details — see
    // `bot-identity-token.ts` on why a refusal here says nothing probeable.
    /** The token's signature did not verify, or its shape is not one we mint. */
    BOT_IDENTITY_TOKEN_INVALID: 'BOT_IDENTITY_TOKEN_INVALID',
    /** The signature verified and the token is past its `exp`. */
    BOT_IDENTITY_TOKEN_EXPIRED: 'BOT_IDENTITY_TOKEN_EXPIRED',

    // ── Idempotency (GAP-001's "required, not optional") ──────────────────────
    // `POST /checkout` is not idempotent underneath — a retry creates a second set
    // of orders and a second stock hold — and chat transports retry. These three
    // are what make a retry safe rather than expensive.
    /** A mutating bot route was called with no `Idempotency-Key`. */
    BOT_IDEMPOTENCY_KEY_REQUIRED: 'BOT_IDEMPOTENCY_KEY_REQUIRED',
    /** The first call carrying this key has not answered yet. Retry shortly. */
    BOT_IDEMPOTENCY_IN_PROGRESS: 'BOT_IDEMPOTENCY_IN_PROGRESS',
    /**
     * The record store could not be consulted, so the mutation was NOT attempted.
     *
     * ⚠ A separate code from the one above, and `test:errors`' census is what insisted on
     * it: the two are raised at different statuses (503 vs 409) and therefore derive
     * different categories (`external_service` vs `conflict`), which that scan refuses.
     * It is the better shape anyway — "another call is in flight" is simply untrue when
     * Redis is down, and a caller that reads it as a race would retry on the wrong cadence.
     *
     * The mutating bot routes fail CLOSED here rather than open. See
     * `bot-idempotency.middleware.ts` for why this one guard's arithmetic runs opposite to
     * the rate limiter's and the worker lock's.
     */
    BOT_IDEMPOTENCY_STORE_UNAVAILABLE: 'BOT_IDEMPOTENCY_STORE_UNAVAILABLE',
    /**
     * This key was already spent by a DIFFERENT request. Never a retry — a caller
     * bug, and answering the stored response would be worse than refusing.
     */
    BOT_IDEMPOTENCY_KEY_REUSED: 'BOT_IDEMPOTENCY_KEY_REUSED',

    /**
     * A geo candidate handle is unknown, spent or stale (GAP-005).
     *
     * The remedy is always to re-run the search — NEVER to re-send held
     * coordinates, which is the whole reason the handle exists.
     */
    BOT_GEO_CANDIDATE_EXPIRED: 'BOT_GEO_CANDIDATE_EXPIRED',
    /**
     * An inbound-file handle is unknown, spent or stale (Step 7b).
     *
     * Same shape and same reasoning as `BOT_GEO_CANDIDATE_EXPIRED` above: the bytes of a
     * photo a customer sent in chat never travel as a tool argument, so what a caller holds
     * is a handle the backend minted when the automation layer delivered the file. The
     * remedy is always for the customer to send the file again — NEVER for a caller to
     * supply a file id, which it has no honest way to obtain.
     */
    BOT_INBOUND_FILE_EXPIRED: 'BOT_INBOUND_FILE_EXPIRED',

    /**
     * A product-list handle is unknown, stale or belongs to another conversation.
     *
     * Raised by `catalog_display_action` on a `more:` token whose set has gone. The
     * third handle on this surface with the same shape and the same one-bucket
     * refusal as `BOT_GEO_CANDIDATE_EXPIRED` — unknown, lapsed and wrong-owner are
     * one answer, because all three have the same remedy and distinguishing them
     * would confirm that a handle the caller does not own is real.
     *
     * ⚠ The remedy is a NEW SEARCH, not a re-send. A list half an hour old quotes
     * prices and stock that have since moved, which is exactly why it expires.
     */
    BOT_PRODUCT_LIST_EXPIRED: 'BOT_PRODUCT_LIST_EXPIRED',
    /**
     * A callback token this service did not mint, or minted under a vocabulary it
     * no longer has.
     *
     * ⚠ **An ordinary event, not a fault.** A button sits in a chat history forever
     * and a deploy can retire the verb it carries, so an unrecognised token is a
     * customer tapping something old — answered with a sentence rather than a 500.
     * Telegram reports nothing at all for an unhandled callback, so without this the
     * tap is simply silent.
     */
    BOT_ACTION_TOKEN_UNKNOWN: 'BOT_ACTION_TOKEN_UNKNOWN',
    /**
     * The Mini App asked to add something the list it was opened for never
     * offered.
     *
     * ⚠ **A DIFFERENT fault from `BOT_PRODUCT_LIST_EXPIRED`, and it needs its own
     * code rather than borrowing that one.** There the list is gone; here it is
     * present and the request names products outside it — which is what a caller
     * that is not the page looks like. Reusing the expiry code would also raise
     * one code at two statuses whose categories disagree (404 `not_found` and
     * 422 `business_rule`), which `test:errors`' census refuses on the stated
     * ground that the category is DERIVED and cannot be right at both.
     *
     * The check behind it is what stops a handle naming one list from becoming a
     * bearer credential for the whole basket.
     */
    BOT_PRODUCT_NOT_IN_LIST: 'BOT_PRODUCT_NOT_IN_LIST',

    // ── Registration and onboarding (GAP-002) ─────────────────────────────────
    // The account is created on the sender's FIRST message, with nobody asked
    // first, so these four describe the only ways that can go wrong. None of them
    // is reachable from an ordinary tool call — the two routes that raise them are
    // the only rows in the table flagged `anonymous`.

    /**
     * The messaging identity is bound to one account and the phone number just
     * proved belongs to a DIFFERENT one.
     *
     * Refused, never transferred, and it names neither account — the caller
     * already knows the identity they are writing from and must not learn who
     * else holds it. Same position `ConnectionService.redeemCode` takes on
     * `MESSAGING_IDENTITY_ALREADY_LINKED`, and the same reason
     * `BOT_IDENTITY_NOT_CUSTOMER` swallows `identity_taken`.
     */
    BOT_REGISTRATION_IDENTITY_TAKEN: 'BOT_REGISTRATION_IDENTITY_TAKEN',
    /**
     * An onboarding step other than `phone` was submitted for a sender who has no
     * account yet.
     *
     * Only reachable on Telegram, where a `chat_id` maps to no phone number and
     * therefore to no account: there is nowhere to record a name or an email until
     * the contact share creates one. `phone` is first in the checklist precisely
     * so a flow following `next` in order can never hit this.
     */
    BOT_ONBOARDING_NOT_REGISTERED: 'BOT_ONBOARDING_NOT_REGISTERED',
    /**
     * A REQUIRED onboarding step was skipped.
     *
     * Raised rather than ignored, because a flow that believes it skipped the
     * phone number will never ask for it again — a silent no-op here is an account
     * permanently stuck one step from complete, with nothing anywhere saying why.
     * `next.skippable` on every response is what a correct caller reads instead.
     */
    BOT_ONBOARDING_STEP_NOT_SKIPPABLE: 'BOT_ONBOARDING_STEP_NOT_SKIPPABLE',
    /**
     * `action: 'provide'` with the step's own field absent.
     *
     * A shape rule that Zod cannot state, because which field is required depends
     * on which step is named — the same reason the bargain-price min/max ordering
     * check is not in Zod either. 400 rather than 422: it is the request that is
     * malformed, not a business rule that refused it.
     */
    BOT_ONBOARDING_VALUE_REQUIRED: 'BOT_ONBOARDING_VALUE_REQUIRED',

    // ── Support routing (GAP-004) ─────────────────────────────────────────────
    // Two refusals, two different questions, and only a NAMED party scope can
    // reach either — `scope: 'auto'` ends at the platform rung and answers 200.

    /**
     * There is nothing to route from at all: no hint was given, and this customer
     * has never ordered, viewed a product, or had one recorded against them.
     *
     * 404 rather than 200-with-nulls because the caller asked for a specific
     * party. `scope: 'auto'` never raises it — GAP-004's ladder ends "nothing →
     * platform only", which is also the better answer to give somebody who said
     * "I need help".
     */
    BOT_SUPPORT_NO_CONTEXT: 'BOT_SUPPORT_NO_CONTEXT',
    /**
     * There IS a subject, and the party asked for does not exist for it.
     *
     * Overwhelmingly `agency` against a product, or against an order whose
     * parcels have not been created yet — an agency attaches to a shipment, not
     * to a product, so this is a legitimate empty answer rather than a fault.
     * Deliberately distinct from the 404 above: the remedy differs, since here
     * the flow can offer the OTHER party it was told about.
     */
    BOT_SUPPORT_SCOPE_UNAVAILABLE: 'BOT_SUPPORT_SCOPE_UNAVAILABLE',

    // ── Messaging connections, from a chat (MCP parity step 7) ────────────────

    /**
     * The caller asked to disconnect the CHANNEL THIS REQUEST ARRIVED ON.
     *
     * Refused, and it is the one rule `connections_disconnect` adds over the customer
     * API's own verb. A `channel_connections` row is step 1 of the identity ladder and it
     * wins outright, so cutting it mid-conversation leaves this surface unable to resolve
     * the very sender it is talking to — and the remedy (send `/connect` to the bot, then
     * redeem the code while signed in) is not reachable from the chat that has just lost
     * its binding. The customer can still do it from the storefront, where the session
     * does not depend on the connection being removed.
     *
     * ⚠ **Not a blanket refusal of the verb.** Disconnecting TELEGRAM from a WhatsApp
     * conversation is permitted and stays permitted: the binding the request arrived on
     * survives, so nothing the customer is currently using breaks.
     */
    BOT_CONNECTION_ACTIVE_CHANNEL: 'BOT_CONNECTION_ACTIVE_CHANNEL',

    // ── GOOGLE / INTEGRATIONS ─────────────────────────────────────────────────
    GOOGLE_MISSING_CLIENT_ID: 'GOOGLE_MISSING_CLIENT_ID',
    GOOGLE_MISSING_CLIENT_SECRET: 'GOOGLE_MISSING_CLIENT_SECRET',
    GOOGLE_MISSING_REDIRECT_URI: 'GOOGLE_MISSING_REDIRECT_URI',
    GOOGLE_PROFILE_FETCH_FAILED: 'GOOGLE_PROFILE_FETCH_FAILED',
    GOOGLE_NO_ACCESS_TOKEN: 'GOOGLE_NO_ACCESS_TOKEN',
    GOOGLE_NO_REFRESH_TOKEN: 'GOOGLE_NO_REFRESH_TOKEN',
    GOOGLE_CALENDAR_NOT_CONNECTED: 'GOOGLE_CALENDAR_NOT_CONNECTED',
    GOOGLE_EVENT_MISSING_ID: 'GOOGLE_EVENT_MISSING_ID',
    GOOGLE_EVENT_MISSING_DATETIME: 'GOOGLE_EVENT_MISSING_DATETIME',
    GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING: 'GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING',
    GOOGLE_TOKEN_INVALID_FORMAT: 'GOOGLE_TOKEN_INVALID_FORMAT',
    INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER: 'INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER',
    // Raised inside a diagnostics probe and always caught by it — "this integration is
    // unreachable" is an ANSWER from /system/integrations, never a failure of it.
    INTEGRATION_PROBE_FAILED: 'INTEGRATION_PROBE_FAILED',

    // ── DATABASE ──────────────────────────────────────────────────────────────
    DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
    DATABASE_CONNECTION_ERROR: 'DATABASE_CONNECTION_ERROR',
    DATABASE_UNIQUE_CONSTRAINT_VIOLATION: 'DATABASE_UNIQUE_CONSTRAINT_VIOLATION',

    // ── ORDER ─────────────────────────────────────────────────────────────────
    ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
    ORDER_PAYMENT_FAILED: 'ORDER_PAYMENT_FAILED',
    ORDER_TERMINAL_STATE: 'ORDER_TERMINAL_STATE',
    ORDER_INVALID_TRANSITION: 'ORDER_INVALID_TRANSITION',
    ORDER_PAYMENT_REQUIRED: 'ORDER_PAYMENT_REQUIRED',
    ORDER_PAYMENT_FAILED_STATE: 'ORDER_PAYMENT_FAILED_STATE',
    ORDER_DISPUTE_HOLD: 'ORDER_DISPUTE_HOLD',
    /**
     * A manual dispute resolution had nothing to resolve. The webhook paths treat this as
     * a harmless replay; an operator is told, because "resolved as won" for an order that
     * was never disputed is a lie a support ticket gets closed on.
     */
    ORDER_DISPUTE_NOT_ACTIVE: 'ORDER_DISPUTE_NOT_ACTIVE',
    ORDER_WRONG_TYPE: 'ORDER_WRONG_TYPE',
    ORDER_DELIVERY_AGENCY_NOT_FOUND: 'ORDER_DELIVERY_AGENCY_NOT_FOUND',
    ORDER_ITEM_NOT_FOUND: 'ORDER_ITEM_NOT_FOUND',
    ORDER_ITEM_NOT_REASSIGNABLE: 'ORDER_ITEM_NOT_REASSIGNABLE',
    SHIPMENT_NOT_FOUND: 'SHIPMENT_NOT_FOUND',
    SHIPMENT_INVALID_STATUS_TRANSITION: 'SHIPMENT_INVALID_STATUS_TRANSITION',
    SHIPMENT_REJECTION_NOT_ALLOWED: 'SHIPMENT_REJECTION_NOT_ALLOWED',
    SHIPMENT_AGENT_NOT_IN_AGENCY: 'SHIPMENT_AGENT_NOT_IN_AGENCY',
    SHIPMENT_ACCESS_DENIED: 'SHIPMENT_ACCESS_DENIED',
    SHIPMENT_ALREADY_CONFIRMED: 'SHIPMENT_ALREADY_CONFIRMED',
    SHIPMENT_CONFIRMATION_NOT_ALLOWED: 'SHIPMENT_CONFIRMATION_NOT_ALLOWED',
    // The auto-generated tracking number collided on every attempt — see
    // TrackingNumberGenerator. Effectively unreachable; it means a broken clock
    // or RNG rather than bad luck.
    SHIPMENT_TRACKING_NUMBER_GENERATION_FAILED: 'SHIPMENT_TRACKING_NUMBER_GENERATION_FAILED',
    // Agent-acceptance workflow (shipment assignment offers)
    SHIPMENT_OFFER_NOT_FOUND: 'SHIPMENT_OFFER_NOT_FOUND',
    SHIPMENT_OFFER_NOT_PENDING: 'SHIPMENT_OFFER_NOT_PENDING',
    SHIPMENT_OFFER_EXPIRED: 'SHIPMENT_OFFER_EXPIRED',
    SHIPMENT_NOT_OFFERABLE: 'SHIPMENT_NOT_OFFERABLE',
    SHIPMENT_ALREADY_HAS_AGENT: 'SHIPMENT_ALREADY_HAS_AGENT',
    SHIPMENT_ALREADY_HAS_PENDING_OFFER: 'SHIPMENT_ALREADY_HAS_PENDING_OFFER',
    SHIPMENT_NO_ELIGIBLE_AGENTS: 'SHIPMENT_NO_ELIGIBLE_AGENTS',
    // No agent has accepted the shipment yet — it cannot be picked up.
    SHIPMENT_AGENT_NOT_ASSIGNED: 'SHIPMENT_AGENT_NOT_ASSIGNED',
    // Agent → agent reassignment (moving a shipment off its current agent).
    SHIPMENT_NOT_REASSIGNABLE: 'SHIPMENT_NOT_REASSIGNABLE',
    SHIPMENT_REASSIGNMENT_NOT_ALLOWED: 'SHIPMENT_REASSIGNMENT_NOT_ALLOWED',
    SHIPMENT_REASSIGN_SAME_AGENT: 'SHIPMENT_REASSIGN_SAME_AGENT',
    SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT: 'SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT',
    SHIPMENT_REASSIGNMENT_CONFLICT: 'SHIPMENT_REASSIGNMENT_CONFLICT',
    // Agent-initiated mid-delivery cancellation (releases the agent, resumes auto-assignment).
    SHIPMENT_CANCEL_NOT_ALLOWED: 'SHIPMENT_CANCEL_NOT_ALLOWED',
    SHIPMENT_CANCEL_CONFLICT: 'SHIPMENT_CANCEL_CONFLICT',
    // The shipment moved between the read that validated the transition and the
    // write — the other actor (agency vs agent, who now drive the same state
    // machine) got there first. Retry from a fresh read.
    SHIPMENT_STATUS_CONFLICT: 'SHIPMENT_STATUS_CONFLICT',
    // Agent delivery-proof upload allowed only at/after the delivery outcome.
    SHIPMENT_PROOF_NOT_ALLOWED: 'SHIPMENT_PROOF_NOT_ALLOWED',
    SHIPMENT_PROOF_NOT_FOUND: 'SHIPMENT_PROOF_NOT_FOUND',
    SHIPMENT_PROOF_FILE_REQUIRED: 'SHIPMENT_PROOF_FILE_REQUIRED',
    ORDER_ALREADY_CANCELLED: 'ORDER_ALREADY_CANCELLED',
    ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
    ORDER_CANCEL_REQUIRES_REFUND: 'ORDER_CANCEL_REQUIRES_REFUND',
    // Shared by order + booking customer cancellation (vendor cancellation_policy gate).
    CANCELLATION_NOT_ALLOWED: 'CANCELLATION_NOT_ALLOWED',

    // ── CONFIG / INFRA ────────────────────────────────────────────────────────
    CONFIG_MISSING_WA_ACCESS_TOKEN: 'CONFIG_MISSING_WA_ACCESS_TOKEN',
    CONFIG_MISSING_WA_PHONE_ID: 'CONFIG_MISSING_WA_PHONE_ID',
    CONFIG_MISSING_STORAGE_PROVIDER: 'CONFIG_MISSING_STORAGE_PROVIDER',
    CONFIG_MISSING_JWT_SECRET: 'CONFIG_MISSING_JWT_SECRET',
    CONFIG_NOTIFICATION_CATALOG_INCOMPLETE: 'CONFIG_NOTIFICATION_CATALOG_INCOMPLETE',
    CONFIG_INVALID_STORAGE_PROVIDER: 'CONFIG_INVALID_STORAGE_PROVIDER',
    CONFIG_INVALID_GEO_PROVIDER: 'CONFIG_INVALID_GEO_PROVIDER',
    /**
     * `MAIL_PROVIDER` or a name inside `MAIL_PROVIDER_CHAIN` is not a provider.
     *
     * Fatal even inside the chain, and for the reason `buildChain` gives in the geocoding
     * factory: silently skipping a misspelt name is how a deployment runs on its fallback
     * believing it runs on its primary. For mail that reading is worse than for geocoding,
     * because the fallback is frequently `console` — which delivers nothing and says so only
     * to stdout.
     */
    CONFIG_INVALID_MAIL_PROVIDER: 'CONFIG_INVALID_MAIL_PROVIDER',
    /**
     * `UPLOAD_VIRUS_SCAN_PROVIDER` names something that cannot scan — `cloud` (declared,
     * never implemented), `mock` in production (a test double), or a typo.
     *
     * Raised by `core/uploads/scanners/index.ts`, and asserted at BOOT rather than left to a
     * request: every injection site builds its scanner per upload, so a per-request throw
     * means the misconfiguration is discovered by a vendor. The failure direction that must
     * never exist is the one this closes — falling back to something harmless-looking, which
     * is a platform that believes it is protected. Same posture as
     * `CONFIG_INVALID_STORAGE_PROVIDER`.
     */
    CONFIG_INVALID_UPLOAD_SCANNER: 'CONFIG_INVALID_UPLOAD_SCANNER',
    /**
     * The virus scanner could not be asked — unreachable, timed out, or answered something
     * this client does not understand. **Not** a detection; a detection is a
     * `VIRUS_DETECTED` violation inside `UPLOAD_POLICY_VIOLATION`.
     *
     * 502 rather than 500: the failure is a dependency's, and the category derives to
     * `external_service`, which is what makes the boundary substitute the registry message and
     * drop `details`. That matters here specifically — `VirusScanValidator` copies the thrown
     * `message` into a violation a vendor sees, so the message must carry no host, port or
     * connection detail. The diagnostics go in `details`, which is journaled and not sent.
     *
     * With `blockOnFailure` true (the shipped setting) this refuses the upload. That is the
     * whole point: "could not scan" must never be spelled "clean".
     */
    UPLOAD_VIRUS_SCAN_UNAVAILABLE: 'UPLOAD_VIRUS_SCAN_UNAVAILABLE',
    // Boot assertions for the operations surface (Phase 14). Both are startup-only: a metric
    // label space that outgrew its cap, and a Redis database with no cache-flush policy row.
    CONFIG_METRICS_CARDINALITY_UNBOUNDED: 'CONFIG_METRICS_CARDINALITY_UNBOUNDED',
    CONFIG_CACHE_POLICY_MISSING: 'CONFIG_CACHE_POLICY_MISSING',
    // The environment validator (`config/env.ts`). Startup-only, and it carries EVERY problem
    // at once rather than the first — an operator fixes one list instead of restarting five
    // times to discover five missing variables.
    CONFIG_INVALID_ENV: 'CONFIG_INVALID_ENV',
    STORAGE_UPLOAD_FAILED: 'STORAGE_UPLOAD_FAILED',
    UPLOAD_POLICY_VIOLATION: 'UPLOAD_POLICY_VIOLATION',

    // ── GEO / GEOCODING (address search & reverse geocoding) ──────────────────
    // Provider selected but its adapter/credentials are missing in this build.
    GEO_PROVIDER_NOT_CONFIGURED: 'GEO_PROVIDER_NOT_CONFIGURED',
    // Provider unreachable — network failure or timeout (fail soft; geo is off
    // the critical path, so deliveries/checkout keep working).
    GEO_PROVIDER_UNAVAILABLE: 'GEO_PROVIDER_UNAVAILABLE',
    // Provider returned a non-2xx or unparseable response.
    GEO_SEARCH_FAILED: 'GEO_SEARCH_FAILED',
    // Provider answered 429 — over its per-second cap or out of daily quota.
    // Distinct from GEO_PROVIDER_UNAVAILABLE because the remedy differs (wait or
    // upgrade, rather than investigate an outage), and because it is one of the
    // two codes ChainedGeocodingProvider treats as "ask the next provider". Both
    // paid free tiers here are small enough that this is an ordinary event, not
    // an incident: Geoapify 3 000/day at 5 rps, LocationIQ 5 000/day at 2 rps.
    GEO_PROVIDER_RATE_LIMITED: 'GEO_PROVIDER_RATE_LIMITED',
    // A new/edited business or headquarters address was submitted without a
    // geocoded `geo` (a selected /api/geo/search result). Required so every
    // physical location is mappable and its country verifiable.
    ADDRESS_GEO_REQUIRED: 'ADDRESS_GEO_REQUIRED',
    // A geocoded address resolves outside the profile's registered country
    // (or its provider returned no country code, so it cannot be verified).
    ADDRESS_COUNTRY_MISMATCH: 'ADDRESS_COUNTRY_MISMATCH',
    // Attempt to change a profile country that is already set. Country is
    // chosen during onboarding and immutable afterwards (tax/shipping policy).
    PROFILE_COUNTRY_IMMUTABLE: 'PROFILE_COUNTRY_IMMUTABLE',

    // ── PHONE VERIFICATION (WhatsApp OTP) ─────────────────────────────────────
    // The dashboard roles — vendor, agency, agent — and administrators never
    // register through the bot, so they hold no WhatsApp CONNECTION and the
    // stronger connection-proof in ContactChangeService cannot reach them. These
    // are the OTP path's refusals. Each is raised at exactly ONE status, so the
    // test:errors census cannot see two categories for one code.
    //
    // No usable number on the account to send a code to.
    PHONE_VERIFICATION_NO_TARGET: 'PHONE_VERIFICATION_NO_TARGET',
    // Wrong code. Carries `attemptsLeft` — deliberately: it tells the holder of
    // the real code they mistyped, and tells an attacker only what they could
    // already count themselves.
    PHONE_VERIFICATION_CODE_INVALID: 'PHONE_VERIFICATION_CODE_INVALID',
    // Past its TTL, or no verification in progress at all. Distinct from INVALID
    // because the remedy differs — request a new code rather than retype this one
    // — which is the same argument CONNECTION_CODE_EXPIRED makes.
    PHONE_VERIFICATION_CODE_EXPIRED: 'PHONE_VERIFICATION_CODE_EXPIRED',
    // The attempt limit is spent. THIS is the security of a six-digit code, not
    // its length, so the refusal is explicit rather than folded into INVALID.
    PHONE_VERIFICATION_TOO_MANY_ATTEMPTS: 'PHONE_VERIFICATION_TOO_MANY_ATTEMPTS',
    // Resend cooldown. Account-scoped, because a number-scoped one bounds nothing
    // when the attacker chooses the number.
    PHONE_VERIFICATION_RESEND_TOO_SOON: 'PHONE_VERIFICATION_RESEND_TOO_SOON',
    // WhatsApp refused the send. Outside the 24-hour window that usually means the
    // AUTHENTICATION template is not approved on the WABA — which is the current
    // state of this deployment, measured 2026-09-14.
    PHONE_VERIFICATION_DELIVERY_FAILED: 'PHONE_VERIFICATION_DELIVERY_FAILED',

    // ── MAIL ──────────────────────────────────────────────────────────────────
    MAIL_TEMPLATE_NOT_FOUND: 'MAIL_TEMPLATE_NOT_FOUND',
    // The five below are the CLASSIFICATION `ChainedMailProvider` fails over on,
    // and the whole point of them is that the chain reads `error.code` rather
    // than re-parsing a provider's body — the mechanism ChainedGeocodingProvider
    // already uses. Every adapter maps its own vendor vocabulary onto exactly
    // these, so the chain contains no provider names.
    //
    // Selected provider has no adapter or no credentials in this build.
    MAIL_PROVIDER_NOT_CONFIGURED: 'MAIL_PROVIDER_NOT_CONFIGURED',
    // The provider's sending ALLOWANCE is spent — Brevo `402/not_enough_credits`,
    // Resend `429/{daily,monthly}_quota_exceeded`, `403/email_above_quota`. This
    // is the one that LATCHES to the provider's own reset boundary: nothing
    // changes until the window rolls over, so re-asking only spends round trips.
    MAIL_PROVIDER_QUOTA_EXCEEDED: 'MAIL_PROVIDER_QUOTA_EXCEEDED',
    // Too fast right now — Brevo `429`, Resend `429/rate_limit_exceeded`.
    // Deliberately NOT the same code as the one above even though both arrive as
    // 429 at Resend: the remedy is seconds, not a day, and latching a per-second
    // limit until midnight throws away the primary's whole remaining allowance.
    MAIL_PROVIDER_RATE_LIMITED: 'MAIL_PROVIDER_RATE_LIMITED',
    // 5xx, DNS, timeout, connection refused.
    MAIL_PROVIDER_UNAVAILABLE: 'MAIL_PROVIDER_UNAVAILABLE',
    // The credential was refused (401, and Resend's suspended/restricted keys).
    // NEVER latched — see `mail.chain.ts`: a latch here would make a wrong key
    // quiet, and quiet is exactly what this failure must not be.
    MAIL_PROVIDER_AUTH_FAILED: 'MAIL_PROVIDER_AUTH_FAILED',
    // The provider read the request and refused IT — an unverified sender domain,
    // a malformed address, a body over the size cap.
    MAIL_SEND_REJECTED: 'MAIL_SEND_REJECTED',
    // Every provider in the chain failed. Carries the last provider's verdict.
    MAIL_ALL_PROVIDERS_FAILED: 'MAIL_ALL_PROVIDERS_FAILED',

    // ── VENDORS ─────────────────────────────────────────────────────────────
    VENDOR_UNSUPPORTED_FISCAL_CALENDAR: 'VENDOR_UNSUPPORTED_FISCAL_CALENDAR',

    // ── CATALOG / INVENTORY (EXPANDED) ────────────────────────────────────────
    CATALOG_INSUFFICIENT_STOCK: 'CATALOG_INSUFFICIENT_STOCK',
    CATALOG_OVERSALE_NOT_ALLOWED: 'CATALOG_OVERSALE_NOT_ALLOWED',
    CATALOG_INVALID_CSV_FORMAT: 'CATALOG_INVALID_CSV_FORMAT',
    CATALOG_BULK_VALIDATION_FAILED: 'CATALOG_BULK_VALIDATION_FAILED',
    CATALOG_RESERVATION_EXPIRED: 'CATALOG_RESERVATION_EXPIRED',
    CATALOG_TRANSACTION_LIMIT_EXCEEDED: 'CATALOG_TRANSACTION_LIMIT_EXCEEDED',
    // Products
    CATALOG_PRODUCT_NOT_FOUND: 'CATALOG_PRODUCT_NOT_FOUND',
    CATALOG_PRODUCT_ACCESS_DENIED: 'CATALOG_PRODUCT_ACCESS_DENIED',
    CATALOG_PRODUCT_INVALID_STATE: 'CATALOG_PRODUCT_INVALID_STATE',
    CATALOG_PRODUCT_INVALID_TITLE: 'CATALOG_PRODUCT_INVALID_TITLE',
    CATALOG_PRODUCT_NO_DESCRIPTION: 'CATALOG_PRODUCT_NO_DESCRIPTION',
    CATALOG_PRODUCT_ALREADY_PUBLISHED: 'CATALOG_PRODUCT_ALREADY_PUBLISHED',
    CATALOG_PRODUCT_NO_VARIANTS: 'CATALOG_PRODUCT_NO_VARIANTS',
    CATALOG_PRODUCT_NO_DEFAULT_VARIANT: 'CATALOG_PRODUCT_NO_DEFAULT_VARIANT',
    CATALOG_PRODUCT_DIGITAL_NO_ASSET: 'CATALOG_PRODUCT_DIGITAL_NO_ASSET',
    CATALOG_PRODUCT_SERVICE_NO_DURATION: 'CATALOG_PRODUCT_SERVICE_NO_DURATION',
    CATALOG_PRODUCT_SERVICE_NO_CAPACITY: 'CATALOG_PRODUCT_SERVICE_NO_CAPACITY',
    CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY: 'CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY',
    CATALOG_PRODUCT_VARIANT_ZERO_PRICE: 'CATALOG_PRODUCT_VARIANT_ZERO_PRICE',
    CATALOG_PRODUCT_NOT_DIGITAL: 'CATALOG_PRODUCT_NOT_DIGITAL',
    CATALOG_PRODUCT_NO_DIGITAL_CONFIG: 'CATALOG_PRODUCT_NO_DIGITAL_CONFIG',
    CATALOG_PRODUCT_NO_DELIVERY_AGENCY: 'CATALOG_PRODUCT_NO_DELIVERY_AGENCY',
    /**
     * The vendor is suspended, so none of their products may be on sale — a
     * product-level activation blocker, so it applies to digital and service listings
     * too. It is what stops an unrelated cascade (an agency problem resolved while the
     * vendor is suspended) walking their listings back onto the storefront.
     */
    CATALOG_PRODUCT_VENDOR_SUSPENDED: 'CATALOG_PRODUCT_VENDOR_SUSPENDED',
    CATALOG_PRODUCT_NO_PICKUP_LOCATION: 'CATALOG_PRODUCT_NO_PICKUP_LOCATION',
    CATALOG_PRODUCT_INVALID_PICKUP_LOCATION: 'CATALOG_PRODUCT_INVALID_PICKUP_LOCATION',
    // A warehouse cannot hold an unbounded quantity: `isInfiniteStock` and
    // `pickup_location.source === 'agency_storage'` are mutually exclusive.
    // Both an activation blocker and a hard refusal on the two write paths that
    // could otherwise reach that combination on an already-active product.
    CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK: 'CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK',
    CATALOG_PRODUCT_VECTORISATION_PENDING: 'CATALOG_PRODUCT_VECTORISATION_PENDING',
    CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE: 'CATALOG_PRODUCT_VECTORISATION_NOT_ELIGIBLE',
    // Authoring mode (see product.model.ts ProductMode). A `simple` product is
    // locked to exactly one variant and zero options; the advanced endpoints
    // refuse it, and the simple endpoints refuse an advanced product.
    CATALOG_PRODUCT_SIMPLE_MODE_LOCKED: 'CATALOG_PRODUCT_SIMPLE_MODE_LOCKED',
    CATALOG_PRODUCT_NOT_SIMPLE_MODE: 'CATALOG_PRODUCT_NOT_SIMPLE_MODE',
    // Variants
    CATALOG_VARIANT_NOT_FOUND: 'CATALOG_VARIANT_NOT_FOUND',
    CATALOG_VARIANT_ACCESS_DENIED: 'CATALOG_VARIANT_ACCESS_DENIED',
    CATALOG_VARIANT_ARCHIVED: 'CATALOG_VARIANT_ARCHIVED',
    CATALOG_VARIANT_INVALID_STOCK: 'CATALOG_VARIANT_INVALID_STOCK',
    CATALOG_VARIANT_INVALID_PRICE: 'CATALOG_VARIANT_INVALID_PRICE',
    CATALOG_VARIANT_COMPARE_PRICE_INVALID: 'CATALOG_VARIANT_COMPARE_PRICE_INVALID',

    // ── Bargainable pricing ──────────────────────────────────────────────────
    // A haggling window stored on the variant (`bargain: { minPrice, maxPrice }`),
    // effective only while the parent product has `vectorisationEnabled === true`.
    // Every rule lives in `catalog/domain/services/bargain-price.rule.ts`.
    //
    // Each code is raised at EXACTLY ONE status: `test:errors` censuses every
    // createAppError site and fails when one code yields two categories. That is
    // why the min/max ordering check exists only in the rule (422) and never in
    // Zod (400) — the same violation arrives three ways, only one of which a
    // schema can see.
    CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED: 'CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED',
    CATALOG_VARIANT_BARGAIN_RANGE_INVALID: 'CATALOG_VARIANT_BARGAIN_RANGE_INVALID',
    CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH: 'CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH',

    // ── The bargaining agent ─────────────────────────────────────────────────
    /**
     * No playbook is published, so the negotiation sub-agent has no instructions.
     *
     * 503 and a REFUSAL rather than a fallback. The sub-agent is given the vendor's
     * real floor in its context, and the playbook is the whole set of rules about
     * what it may do with that number — a model holding a floor and no instructions
     * is an unbounded bargainer, not a degraded one. `no instructions` must mean
     * `do not negotiate`. See negotiation/services/negotiation-playbook.service.ts.
     */
    NEGOTIATION_PLAYBOOK_NOT_PUBLISHED: 'NEGOTIATION_PLAYBOOK_NOT_PUBLISHED',

    /**
     * The five ways a presented price lock is refused (Stream C).
     *
     * The VERDICT is the negotiation module's — it owns the lock and does the
     * checking, behind `catalog/domain/ports/negotiated-price.port.ts`. These
     * codes are the catalog side's rendering of that verdict, one per `reason`,
     * and the mapping is the whole of what `catalog` decides. Never re-derive a
     * lock's validity here to raise one: two modules interpreting one lock is
     * the drift the port exists to prevent.
     *
     * Every one of them is a CLIENT-SAFE category (404 not_found, 422
     * business_rule, 409 conflict), which is deliberate rather than incidental —
     * the bargaining agent has to be able to say what happened and reopen the
     * negotiation. A refusal filtered down to "An unexpected error occurred"
     * dead-ends a customer mid-haggle.
     */
    /** The reference names no lock at all. Re-negotiate; nothing is recoverable. */
    NEGOTIATION_LOCK_INVALID: 'NEGOTIATION_LOCK_INVALID',
    /** The agreed price aged out (`NEGOTIATION_LOCK_TTL_MINUTES`). Re-negotiate. */
    NEGOTIATION_LOCK_EXPIRED: 'NEGOTIATION_LOCK_EXPIRED',
    /** Single-use, and already spent on an order. 409: the state moved. */
    NEGOTIATION_LOCK_CONSUMED: 'NEGOTIATION_LOCK_CONSUMED',
    /** Real, but bound to a different customer, variant or quantity. */
    NEGOTIATION_LOCK_VARIANT_MISMATCH: 'NEGOTIATION_LOCK_VARIANT_MISMATCH',
    /**
     * The vendor moved their window since the price was agreed, and the agreed
     * price now falls outside it (D-10). The customer did nothing wrong and
     * neither did the vendor — which is exactly why this is its own code rather
     * than a bare 422: the chat says "the seller just changed this price, let me
     * re-check" and reopens the negotiation.
     */
    NEGOTIATION_LOCK_WINDOW_MOVED: 'NEGOTIATION_LOCK_WINDOW_MOVED',

    /**
     * The gate's refusals (BARGAINING-AGENT-PLAN D-3). All 422: each is a business
     * rule about a price, never a malformed request — the shape is Zod's job.
     *
     * ⚠ These are answered to the bargaining SUB-AGENT, which re-drafts and tries
     * again. They are not customer copy and must never reach a chat window; the
     * service returns a `revise` instruction alongside, in English, for the model.
     */
    NEGOTIATION_SESSION_NOT_FOUND: 'NEGOTIATION_SESSION_NOT_FOUND',
    NEGOTIATION_SESSION_EXPIRED: 'NEGOTIATION_SESSION_EXPIRED',
    NEGOTIATION_SESSION_CLOSED: 'NEGOTIATION_SESSION_CLOSED',
    NEGOTIATION_PRICE_BELOW_FLOOR: 'NEGOTIATION_PRICE_BELOW_FLOOR',
    NEGOTIATION_PRICE_ABOVE_ASK: 'NEGOTIATION_PRICE_ABOVE_ASK',
    NEGOTIATION_PRICE_INCREASED: 'NEGOTIATION_PRICE_INCREASED',
    /** The variant carries no bargain window, or its product is not vectorised. */
    NEGOTIATION_NOT_BARGAINABLE: 'NEGOTIATION_NOT_BARGAINABLE',
    /**
     * A tool on `/internal/negotiation/tools` was called without naming a product.
     *
     * **400 at every site**, and a code of its own rather than a Zod refinement, because
     * the caller is a language model: `VALIDATION_ERROR` describes a field shape, which a
     * model retries verbatim, where this describes the actionable thing — *you did not say
     * which product*. `details.accepts` lists the identifiers the tool would have taken.
     * See negotiation/domain/negotiation-tool-subject.ts.
     */
    NEGOTIATION_TOOL_SUBJECT_REQUIRED: 'NEGOTIATION_TOOL_SUBJECT_REQUIRED',
    /**
     * `check_promotion` was handed a discount code to validate. **422.**
     *
     * There is no coupon model on this platform — `CartQuoteService` pins `discount` to a
     * literal `0` — so no code can be checked and none can be valid. This is raised
     * instead of answering `{ available: false }` because that answer, to a *named* code,
     * reads as "that code is not valid": a verdict on a specific code nobody checked, and
     * exactly the invented fact the tool exists to prevent. The message below is worded so
     * it cannot be rendered as "your code expired".
     */
    NEGOTIATION_PROMOTIONS_UNAVAILABLE: 'NEGOTIATION_PROMOTIONS_UNAVAILABLE',
    CATALOG_VARIANT_LIMIT_EXCEEDED: 'CATALOG_VARIANT_LIMIT_EXCEEDED',
    CATALOG_VARIANT_NO_OPTIONS: 'CATALOG_VARIANT_NO_OPTIONS',
    CATALOG_VARIANT_OPTION_EMPTY: 'CATALOG_VARIANT_OPTION_EMPTY',
    CATALOG_VARIANT_INSUFFICIENT_STOCK: 'CATALOG_VARIANT_INSUFFICIENT_STOCK',
    CATALOG_VARIANT_UNSUPPORTED_TYPE: 'CATALOG_VARIANT_UNSUPPORTED_TYPE',
    CATALOG_VARIANT_NO_DIGITAL_ASSET: 'CATALOG_VARIANT_NO_DIGITAL_ASSET',
    CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED: 'CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED',
    // Service products carry config + price on a single variant — at most one allowed.
    CATALOG_SERVICE_VARIANT_EXISTS: 'CATALOG_SERVICE_VARIANT_EXISTS',
    CATALOG_VARIANT_INVALID_QUANTITY: 'CATALOG_VARIANT_INVALID_QUANTITY',
    CATALOG_VARIANT_STOCK_ONLY_PHYSICAL: 'CATALOG_VARIANT_STOCK_ONLY_PHYSICAL',
    CATALOG_VARIANT_RESERVATION_CONFLICT: 'CATALOG_VARIANT_RESERVATION_CONFLICT',
    // Options
    CATALOG_OPTION_NOT_FOUND: 'CATALOG_OPTION_NOT_FOUND',
    CATALOG_OPTION_ACCESS_DENIED: 'CATALOG_OPTION_ACCESS_DENIED',
    CATALOG_OPTION_LIMIT_EXCEEDED: 'CATALOG_OPTION_LIMIT_EXCEEDED',
    CATALOG_OPTION_DUPLICATE_NAME: 'CATALOG_OPTION_DUPLICATE_NAME',
    CATALOG_OPTION_REQUIRES_VALUES: 'CATALOG_OPTION_REQUIRES_VALUES',
    CATALOG_OPTION_DUPLICATE_VALUE: 'CATALOG_OPTION_DUPLICATE_VALUE',
    CATALOG_OPTION_VALUES_EXIST: 'CATALOG_OPTION_VALUES_EXIST',
    CATALOG_OPTION_REQUIRES_NO_OPTIONS: 'CATALOG_OPTION_REQUIRES_NO_OPTIONS',
    CATALOG_PRODUCT_INVALID_TYPE: 'CATALOG_PRODUCT_INVALID_TYPE',
    CATALOG_VARIANT_SKU_EXISTS: 'CATALOG_VARIANT_SKU_EXISTS',
    CATALOG_INVALID_OPTION_ID: 'CATALOG_INVALID_OPTION_ID',
    CATALOG_INVALID_CSV: 'CATALOG_INVALID_CSV',
    CATALOG_DIGITAL_ASSET_ALREADY_EXISTS: 'CATALOG_DIGITAL_ASSET_ALREADY_EXISTS',
    CATALOG_DIGITAL_ASSET_MISSING: 'CATALOG_DIGITAL_ASSET_MISSING',
    CATALOG_DIGITAL_CONFIG_MISSING: 'CATALOG_DIGITAL_CONFIG_MISSING',
    CATALOG_FILE_TOO_LARGE: 'CATALOG_FILE_TOO_LARGE',
    CATALOG_FILE_TYPE_INVALID: 'CATALOG_FILE_TYPE_INVALID',
    CATALOG_DIGITAL_ASSET_MISSING_FILE: 'CATALOG_DIGITAL_ASSET_MISSING_FILE',
    // Digital assets
    CATALOG_DIGITAL_ASSET_NOT_FOUND: 'CATALOG_DIGITAL_ASSET_NOT_FOUND',
    CATALOG_VARIANT_RESERVATION_NOT_FOUND: 'CATALOG_VARIANT_RESERVATION_NOT_FOUND',
    // File / media
    CATALOG_FILE_NOT_FOUND: 'CATALOG_FILE_NOT_FOUND',
    CATALOG_FILE_ALREADY_ATTACHED: 'CATALOG_FILE_ALREADY_ATTACHED',
    CATALOG_FILE_STILL_REFERENCED: 'CATALOG_FILE_STILL_REFERENCED',
    CATALOG_IMAGE_LIMIT_EXCEEDED: 'CATALOG_IMAGE_LIMIT_EXCEEDED',
    // Booking / service
    CATALOG_BOOKING_PRODUCT_NOT_FOUND: 'CATALOG_BOOKING_PRODUCT_NOT_FOUND',
    CATALOG_BOOKING_INVALID_PRODUCT_TYPE: 'CATALOG_BOOKING_INVALID_PRODUCT_TYPE',
    CATALOG_BOOKING_MISSING_SERVICE_CONFIG: 'CATALOG_BOOKING_MISSING_SERVICE_CONFIG',
    CATALOG_BOOKING_PRODUCT_NOT_ACTIVE: 'CATALOG_BOOKING_PRODUCT_NOT_ACTIVE',
    CATALOG_BOOKING_INVALID_PRICE: 'CATALOG_BOOKING_INVALID_PRICE',
    CATALOG_BOOKING_NOT_IMPLEMENTED: 'CATALOG_BOOKING_NOT_IMPLEMENTED',
    // Bulk stock
    CATALOG_BULK_LIMIT_EXCEEDED: 'CATALOG_BULK_LIMIT_EXCEEDED',
    CATALOG_BULK_EMPTY: 'CATALOG_BULK_EMPTY',
    CATALOG_BULK_TRANSACTION_LIMIT: 'CATALOG_BULK_TRANSACTION_LIMIT',
    CATALOG_BULK_UPDATE_FAILED: 'CATALOG_BULK_UPDATE_FAILED',

    // ── ANALYTICS ────────────────────────────────────────────────────────────
    ANALYTICS_INVALID_DATE_RANGE: 'ANALYTICS_INVALID_DATE_RANGE',
    ANALYTICS_UNSUPPORTED_TIMEZONE: 'ANALYTICS_UNSUPPORTED_TIMEZONE',
    ANALYTICS_AGGREGATION_NOT_READY: 'ANALYTICS_AGGREGATION_NOT_READY',
    ANALYTICS_DATE_RANGE_EXCEEDED: 'ANALYTICS_DATE_RANGE_EXCEEDED',

    // ── DELIVERY ──────────────────────────────────────────────────────────────
    DELIVERY_AGENCY_NOT_FOUND: 'DELIVERY_AGENCY_NOT_FOUND',
    AGENCY_COVERAGE_AREA_INVALID: 'AGENCY_COVERAGE_AREA_INVALID',
    DELIVERY_AGENT_NOT_FOUND: 'DELIVERY_AGENT_NOT_FOUND',
    DELIVERY_AGENCY_ALREADY_EXISTS: 'DELIVERY_AGENCY_ALREADY_EXISTS',
    /**
     * A compare-and-set on `delivery_agencies.status` missed — the agency was not in the
     * status the operation required. Two administrators holding one agency's screen open
     * is the case: the loser is told the state moved rather than overwriting the winner.
     */
    DELIVERY_AGENCY_STATUS_CONFLICT: 'DELIVERY_AGENCY_STATUS_CONFLICT',
    DELIVERY_ONBOARDING_STEP_INVALID: 'DELIVERY_ONBOARDING_STEP_INVALID',
    DELIVERY_ONBOARDING_STEP_INCOMPLETE: 'DELIVERY_ONBOARDING_STEP_INCOMPLETE',
    DELIVERY_ONBOARDING_ALREADY_COMPLETED: 'DELIVERY_ONBOARDING_ALREADY_COMPLETED',
    DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION: 'DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION',
    DELIVERY_POLICY_DOCUMENT_MISSING: 'DELIVERY_POLICY_DOCUMENT_MISSING',
    DELIVERY_POLICY_DOCUMENT_TYPE_INVALID: 'DELIVERY_POLICY_DOCUMENT_TYPE_INVALID',
    DELIVERY_AGENT_ALREADY_IN_AGENCY: 'DELIVERY_AGENT_ALREADY_IN_AGENCY',
    DELIVERY_AGENT_NOT_IN_AGENCY: 'DELIVERY_AGENT_NOT_IN_AGENCY',
    DELIVERY_AGENT_HAS_ACTIVE_SHIPMENTS: 'DELIVERY_AGENT_HAS_ACTIVE_SHIPMENTS',
    DELIVERY_AGENCY_NOTIFICATION_NOT_FOUND: 'DELIVERY_AGENCY_NOTIFICATION_NOT_FOUND',
    DELIVERY_AGENCY_NOTIFICATION_CHANNEL_NOT_VERIFIED: 'DELIVERY_AGENCY_NOTIFICATION_CHANNEL_NOT_VERIFIED',
    DELIVERY_AGENCY_NOTIFICATION_DELIVERY_FAILED: 'DELIVERY_AGENCY_NOTIFICATION_DELIVERY_FAILED',
    DELIVERY_AGENT_NOTIFICATION_NOT_FOUND: 'DELIVERY_AGENT_NOTIFICATION_NOT_FOUND',
    DELIVERY_AGENT_NOTIFICATION_CHANNEL_NOT_VERIFIED: 'DELIVERY_AGENT_NOTIFICATION_CHANNEL_NOT_VERIFIED',
    DELIVERY_AGENT_NOTIFICATION_DELIVERY_FAILED: 'DELIVERY_AGENT_NOTIFICATION_DELIVERY_FAILED',

    // ── CUSTOMER NOTIFICATIONS (the fourth multi-channel stack) ───────────────
    CUSTOMER_NOTIFICATION_NOT_FOUND: 'CUSTOMER_NOTIFICATION_NOT_FOUND',
    CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED: 'CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED',
    CUSTOMER_NOTIFICATION_DELIVERY_FAILED: 'CUSTOMER_NOTIFICATION_DELIVERY_FAILED',

    // ── AGENT (the agent domain: profile, membership, availability, tracking) ──
    AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
    AGENT_NOT_ACTIVE: 'AGENT_NOT_ACTIVE',
    AGENT_SUSPENDED: 'AGENT_SUSPENDED',
    // Onboarding (locks once completed — edits then go through profile/settings)
    AGENT_ONBOARDING_ALREADY_COMPLETED: 'AGENT_ONBOARDING_ALREADY_COMPLETED',
    // Membership lifecycle
    AGENT_MEMBERSHIP_NOT_FOUND: 'AGENT_MEMBERSHIP_NOT_FOUND',
    AGENT_MEMBERSHIP_ALREADY_EXISTS: 'AGENT_MEMBERSHIP_ALREADY_EXISTS',
    AGENT_MEMBERSHIP_NOT_PENDING: 'AGENT_MEMBERSHIP_NOT_PENDING',
    AGENT_MEMBERSHIP_NOT_APPROVED: 'AGENT_MEMBERSHIP_NOT_APPROVED',
    AGENT_MEMBERSHIP_ALREADY_APPROVED: 'AGENT_MEMBERSHIP_ALREADY_APPROVED',
    AGENT_MEMBERSHIP_SUSPENDED: 'AGENT_MEMBERSHIP_SUSPENDED',
    AGENT_MEMBERSHIP_NOT_SUSPENDED: 'AGENT_MEMBERSHIP_NOT_SUSPENDED',
    AGENT_MEMBERSHIP_INVALID_TRANSITION: 'AGENT_MEMBERSHIP_INVALID_TRANSITION',
    AGENT_MEMBERSHIP_LIMIT_REACHED: 'AGENT_MEMBERSHIP_LIMIT_REACHED',
    AGENT_MEMBERSHIP_HAS_ACTIVE_SHIPMENTS: 'AGENT_MEMBERSHIP_HAS_ACTIVE_SHIPMENTS',
    AGENT_TRANSFER_SAME_AGENCY: 'AGENT_TRANSFER_SAME_AGENCY',
    // Availability / working state
    AGENT_AVAILABILITY_INVALID_TRANSITION: 'AGENT_AVAILABILITY_INVALID_TRANSITION',
    AGENT_AT_CAPACITY: 'AGENT_AT_CAPACITY',
    // Tracking (business flag — geo-tracker enforces, jovi-mall owns)
    AGENT_TRACKING_NOT_ALLOWED: 'AGENT_TRACKING_NOT_ALLOWED',
    AGENT_DEVICE_LOCATION_DISABLED: 'AGENT_DEVICE_LOCATION_DISABLED',
    AGENT_DEVICE_STATE_UNKNOWN: 'AGENT_DEVICE_STATE_UNKNOWN',
    // Assignment eligibility (aggregate — details carry the failed rules)
    AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT: 'AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT',
    // COD threshold allocation (agent global pool ← contract sub-allocations)
    AGENT_COD_THRESHOLD_OUT_OF_BOUNDS: 'AGENT_COD_THRESHOLD_OUT_OF_BOUNDS',
    AGENT_COD_THRESHOLD_BELOW_ALLOCATED: 'AGENT_COD_THRESHOLD_BELOW_ALLOCATED',
    // An administrator's pinned trust score (O-7) outside 0–100. Same scale as
    // the computed score, because the whole point is that it substitutes for it.
    AGENT_TRUST_OVERRIDE_OUT_OF_BOUNDS: 'AGENT_TRUST_OVERRIDE_OUT_OF_BOUNDS',
    CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS: 'CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS',
    CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM: 'CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM',
    CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING: 'CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING',
    // Capacity
    AGENT_CAPACITY_OUT_OF_BOUNDS: 'AGENT_CAPACITY_OUT_OF_BOUNDS',
    AGENT_CAPACITY_BELOW_IN_USE: 'AGENT_CAPACITY_BELOW_IN_USE',
    // Contract lifecycle
    CONTRACT_NOT_FOUND: 'CONTRACT_NOT_FOUND',
    CONTRACT_INVALID_TRANSITION: 'CONTRACT_INVALID_TRANSITION',
    CONTRACT_HAS_OUTSTANDING_COD: 'CONTRACT_HAS_OUTSTANDING_COD',
    CONTRACT_HAS_UNPAID_EARNINGS: 'CONTRACT_HAS_UNPAID_EARNINGS',
    CONTRACT_TRANSITION_NOT_PERMITTED: 'CONTRACT_TRANSITION_NOT_PERMITTED',
    // Status-change request workflow
    CONTRACT_STATUS_REQUEST_NOT_FOUND: 'CONTRACT_STATUS_REQUEST_NOT_FOUND',
    CONTRACT_STATUS_REQUEST_NOT_PENDING: 'CONTRACT_STATUS_REQUEST_NOT_PENDING',
    CONTRACT_STATUS_REQUEST_ALREADY_PENDING: 'CONTRACT_STATUS_REQUEST_ALREADY_PENDING',
    CONTRACT_STATUS_REQUEST_NOT_YOURS: 'CONTRACT_STATUS_REQUEST_NOT_YOURS',
    // Coverage / contract terms
    CONTRACT_COVERAGE_OUTSIDE_AGENT_RADIUS: 'CONTRACT_COVERAGE_OUTSIDE_AGENT_RADIUS',
    CONTRACT_COVERAGE_REGION_NOT_COVERED: 'CONTRACT_COVERAGE_REGION_NOT_COVERED',
    CONTRACT_COVERAGE_REGION_INVALID: 'CONTRACT_COVERAGE_REGION_INVALID',
    CONTRACT_SHIPMENT_VALUE_EXCEEDED: 'CONTRACT_SHIPMENT_VALUE_EXCEEDED',
    CONTRACT_FEE_SPLIT_INVALID: 'CONTRACT_FEE_SPLIT_INVALID',
    // Terms negotiation. CONTRACT_TERMS_NOT_PROPOSED is the guard that makes a
    // bare join-request work: terms nobody stated cannot be approved.
    CONTRACT_TERMS_REQUIRED: 'CONTRACT_TERMS_REQUIRED',
    CONTRACT_TERMS_NOT_PROPOSED: 'CONTRACT_TERMS_NOT_PROPOSED',
    CONTRACT_TERMS_NOT_NEGOTIABLE: 'CONTRACT_TERMS_NOT_NEGOTIABLE',
    CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED: 'CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED',
    CONTRACT_TERMS_PROPOSAL_NOT_FOUND: 'CONTRACT_TERMS_PROPOSAL_NOT_FOUND',
    CONTRACT_TERMS_PROPOSAL_NOT_PENDING: 'CONTRACT_TERMS_PROPOSAL_NOT_PENDING',
    CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING: 'CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING',
    CONTRACT_TERMS_PROPOSAL_NOT_YOURS: 'CONTRACT_TERMS_PROPOSAL_NOT_YOURS',
    // Settlement (COD remittance under a contract). Thrown by AgentDepositService,
    // which owns the settlement path; there is no separate settlement collection.
    CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING: 'CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING',
    // Platform gates (run BEFORE COD/capacity)
    AGENT_KYC_NOT_VERIFIED: 'AGENT_KYC_NOT_VERIFIED',
    AGENT_PLATFORM_BANNED: 'AGENT_PLATFORM_BANNED',
    AGENT_PAYOUT_DETAILS_MISSING: 'AGENT_PAYOUT_DETAILS_MISSING',
    // Service-to-service auth (geo-tracker → jovi-mall)
    AGENT_SERVICE_TOKEN_INVALID: 'AGENT_SERVICE_TOKEN_INVALID',
    AGENT_SERVICE_TOKEN_NOT_CONFIGURED: 'AGENT_SERVICE_TOKEN_NOT_CONFIGURED',

    // ── AUTH — service-to-service (wi-admin → jovi-mall) ──────────────────────
    // The internal admin API. A SEPARATE credential from the agent one above:
    // geo-tracker and the admin service have different blast radii, so sharing one
    // secret would make either compromise the other's.
    AUTH_ADMIN_CALLER_TOKEN_INVALID: 'AUTH_ADMIN_CALLER_TOKEN_INVALID',
    AUTH_ADMIN_CALLER_NOT_CONFIGURED: 'AUTH_ADMIN_CALLER_NOT_CONFIGURED',
    /** The token verified but the caller named no administrator, or named one badly. */
    AUTH_ADMIN_CALLER_ACTOR_MISSING: 'AUTH_ADMIN_CALLER_ACTOR_MISSING',

    // ── CONNECTION (vendor <-> agency consensual linking) ─────────────────────
    CONNECTION_NOT_FOUND: 'CONNECTION_NOT_FOUND',
    CONNECTION_VENDOR_NOT_FOUND: 'CONNECTION_VENDOR_NOT_FOUND',
    CONNECTION_ALREADY_EXISTS: 'CONNECTION_ALREADY_EXISTS',
    CONNECTION_INVALID_STATUS_TRANSITION: 'CONNECTION_INVALID_STATUS_TRANSITION',
    CONNECTION_NOT_PENDING: 'CONNECTION_NOT_PENDING',
    CONNECTION_NOT_PAUSED: 'CONNECTION_NOT_PAUSED',
    CONNECTION_NOT_REQUESTER: 'CONNECTION_NOT_REQUESTER',
    CONNECTION_NOT_APPROVER: 'CONNECTION_NOT_APPROVER',
    CONNECTION_WRONG_REAPPROVAL_PARTY: 'CONNECTION_WRONG_REAPPROVAL_PARTY',
    CONNECTION_NOT_ACTIVE: 'CONNECTION_NOT_ACTIVE',

    // ── CUSTOMER ──────────────────────────────────────────────────────────────
    /**
     * That product is not on this customer's wishlist.
     *
     * A 404 and never a 403, even when the row exists on somebody else's list. Every query
     * behind it is scoped by `customer_id`, so a foreign row matches nothing and there is
     * no place for an ownership check to be forgotten — the same reasoning the public
     * catalogue uses when it answers 404 rather than confirming a draft product exists.
     */
    WISHLIST_ITEM_NOT_FOUND: 'WISHLIST_ITEM_NOT_FOUND',

    CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
    CUSTOMER_ADDRESS_NOT_FOUND: 'CUSTOMER_ADDRESS_NOT_FOUND',
    CUSTOMER_PAYMENT_METHOD_NOT_FOUND: 'CUSTOMER_PAYMENT_METHOD_NOT_FOUND',

    // ── PAYMENT METHODS (per-user saved instruments) ──────────────────────────
    PAYMENT_METHOD_NOT_FOUND: 'PAYMENT_METHOD_NOT_FOUND',
    PAYMENT_METHOD_LIMIT_REACHED: 'PAYMENT_METHOD_LIMIT_REACHED',

    // ── USER ──────────────────────────────────────────────────────────────────
    USER_NOT_FOUND: 'USER_NOT_FOUND',
    USER_INVALID_PASSWORD: 'USER_INVALID_PASSWORD',

    /**
     * A status write lost its compare-and-set: the account was not in the status the
     * caller believed it was in.
     *
     * Same discipline as SHIPMENT_STATUS_CONFLICT, and for the same reason — two
     * administrators can hold one user's screen open, and an unguarded write lets the
     * loser's audit row claim a transition that never happened.
     */
    USER_STATUS_CONFLICT: 'USER_STATUS_CONFLICT',

    /**
     * The edit would leave the account with neither an email nor a phone.
     *
     * Both login identifiers are individually optional, but `login` resolves an account
     * by one of them — clearing both makes the account permanently unreachable, with no
     * self-service path back.
     */
    USER_CONTACT_REQUIRED: 'USER_CONTACT_REQUIRED',

    // ── PRODUCT SHARE (6.J · vendor shares a product over a connected channel) ─

    /**
     * The vendor asked to share over a channel their account is not connected to.
     *
     * 422 rather than 404: the channel exists and the product exists — what is missing is a
     * connection, and the message carries the `/connect` instruction that fixes it.
     *
     * ⚠ Restored 2026-08-21 after being lost to a concurrent edit of this file; the throw
     * site (`ProductShareService.resolveTarget`) is the definition of what it means.
     */
    PRODUCT_SHARE_CHANNEL_NOT_CONNECTED: 'PRODUCT_SHARE_CHANNEL_NOT_CONNECTED',

    /**
     * WhatsApp's 24-hour service window is closed, so no free-form message may be sent.
     *
     * 422 and not 502: nothing failed. Meta's policy permits only an approved `template`
     * outside the window, and there is deliberately no product-share template — a share is
     * a vendor pressing a button, not a delivery notification that must arrive. The remedy
     * is in the message and the vendor can perform it: send the bot any message, which
     * reopens the window.
     *
     * Telegram has no equivalent and never raises this.
     */
    PRODUCT_SHARE_WINDOW_CLOSED: 'PRODUCT_SHARE_WINDOW_CLOSED',

    /**
     * The channel accepted the request and did not deliver.
     *
     * 502 — `external_service`, so the boundary replaces this message with the registry
     * default and drops `details`. The `cause` put in `details` at the throw site is for
     * the journal, which is exactly what that category's exposure rule is for.
     */
    PRODUCT_SHARE_SEND_FAILED: 'PRODUCT_SHARE_SEND_FAILED',

    // ── ACCOUNT CLOSURE (ADR-A02 · self-service, `POST /api/me/close`) ────────

    /**
     * The caller holds a role beyond `customer`, so closure is refused OUTRIGHT.
     *
     * ADR-A02 D-1: "a dual-role account is refused, not partially closed". Anonymising the
     * person behind a live storefront leaves a shop trading under a name nobody can resolve,
     * with products, payouts and a KYC record attached to an identity that no longer exists.
     * The remedy is a real one and is stated in the message: close the other role first.
     *
     * 422 rather than 403 — the caller is entitled to this endpoint, and a rule refused the
     * request. See `error-category.ts`'s 400-vs-422 note.
     */
    ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE: 'ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE',

    /**
     * The customer has orders still moving, so closure is refused until they settle.
     *
     * Not in ADR-A02, and added because the anonymisation makes an in-flight delivery
     * undeliverable rather than merely untidy: `CashCollectionService.notifyCodeIssued`
     * sends the COD delivery code to `Customer.phone`, which closure clears, and the
     * messaging connections that carry every other delivery notification are deleted. The
     * agent arrives at an address holding a parcel the recipient can no longer be given a
     * code for.
     *
     * `details.activeOrderCount` says how many, so a client can render "you have 2 orders in
     * progress" without a second call.
     */
    ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT: 'ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT',

    // ── CONTACT CHANGE (self-service, `/api/me/{email,phone}`) ────────────────
    /**
     * The identifier the caller asked to move to is the one already on the account.
     *
     * Refused rather than treated as a no-op: a silent success would send a verification
     * mail to an address that is already verified, and would teach a client that
     * "pending" and "done" are the same state.
     */
    CONTACT_CHANGE_SAME_IDENTIFIER: 'CONTACT_CHANGE_SAME_IDENTIFIER',

    /**
     * Another account already holds this email or phone.
     *
     * Raised at BOTH ends of the flow — on request and again on confirm — because the
     * identifier can be claimed in the window between them, and `login_email` /
     * `login_phone` carry sparse UNIQUE indexes: swapping into a taken value is a
     * driver-level duplicate-key error, i.e. a 500, unless it is caught here first.
     */
    CONTACT_CHANGE_IDENTIFIER_TAKEN: 'CONTACT_CHANGE_IDENTIFIER_TAKEN',

    /** Confirm or cancel with no change in flight. */
    CONTACT_CHANGE_NOT_PENDING: 'CONTACT_CHANGE_NOT_PENDING',

    /**
     * The pending change aged out.
     *
     * A separate code from `CONTACT_CHANGE_TOKEN_INVALID` on purpose: "start again" and
     * "that link is not ours" are different things to say to a person, and only the first
     * describes the platform behaving normally.
     */
    CONTACT_CHANGE_EXPIRED: 'CONTACT_CHANGE_EXPIRED',

    /** No pending change matches this token — wrong, already spent, or forged. */
    CONTACT_CHANGE_TOKEN_INVALID: 'CONTACT_CHANGE_TOKEN_INVALID',

    /**
     * A phone change was confirmed without proof that the account controls the number.
     *
     * The proof is a `channel_connections` row binding this account to that number on
     * WhatsApp — see `services/contact-change.service.ts`. Without it the confirm would
     * move a login identifier onto a number nobody has ever shown they can receive on,
     * which is an account-recovery hole rather than a contact edit.
     */
    CONTACT_CHANGE_PHONE_UNPROVEN: 'CONTACT_CHANGE_PHONE_UNPROVEN',

    // ── IDENTITY VERIFICATION (`/api/{vendor,agency,agent}/kyc`) ─────────────
    //
    // ⚠ Five codes, and NONE of them is "your submission is incomplete". That is not an
    // omission: the backend grades nothing here, by decision — the required/optional split
    // lives in the administration dashboard, which computes the estimated verdict and
    // pre-populates a rejection reason from it. See `core/types/kyc-documents.types.ts`.

    /** The role has no verification record. An account in a state that cannot submit one. */
    KYC_SUBJECT_NOT_FOUND: 'KYC_SUBJECT_NOT_FOUND',

    /**
     * The named slot does not exist for this role.
     *
     * `details.allowed` carries the role's own slot list. Deliberately a refusal rather than
     * a silent no-op: a write that reports success having stored nothing is the hardest
     * failure there is to diagnose from a client, because every observable signal agrees it
     * worked.
     */
    KYC_SLOT_UNKNOWN: 'KYC_SLOT_UNKNOWN',

    /**
     * The record is under review, or already verified, and is therefore frozen.
     *
     * Two situations with one code, because the remedy is the same — wait for, or ask about,
     * a decision — and `details.status` / `details.submittedAt` distinguish them. Freezing a
     * VERIFIED record is the load-bearing half: without it an approved applicant could swap
     * the identity card an administrator approved for somebody else's, keeping the verdict.
     */
    KYC_LOCKED: 'KYC_LOCKED',

    /** A multi-value slot is full. `details.max` and `details.current` carry the numbers. */
    KYC_SLOT_FULL: 'KYC_SLOT_FULL',

    /** The file named for removal is not in that slot. */
    KYC_DOCUMENT_NOT_FOUND: 'KYC_DOCUMENT_NOT_FOUND',

    /**
     * The upload request carried no file.
     *
     * A dedicated code rather than an `UPLOAD_POLICY_VIOLATION`, matching
     * `SHIPMENT_PROOF_FILE_REQUIRED`: the overwhelmingly likely cause is the wrong multipart
     * field name, and a violation envelope buries that behind a generic policy failure.
     */
    KYC_FILE_REQUIRED: 'KYC_FILE_REQUIRED',

    // ── VENDOR ADMINISTRATION (wi-admin's `/api/internal/admin/vendors`) ──────
    VENDOR_NOT_FOUND: 'VENDOR_NOT_FOUND',

    /**
     * The vendor was not in the status the caller believed it was in.
     *
     * The compare-and-set miss, and the exact counterpart of `USER_STATUS_CONFLICT`:
     * two administrators can hold one vendor's screen open, and an unguarded write lets
     * the loser's reason overwrite the winner's while their audit row claims a
     * transition that never happened.
     */
    VENDOR_STATUS_CONFLICT: 'VENDOR_STATUS_CONFLICT',

    /** Approving an already-approved vendor, or rejecting an already-rejected one. */
    VENDOR_KYC_STATUS_CONFLICT: 'VENDOR_KYC_STATUS_CONFLICT',

    /** Only a product currently on sale can be taken off it. */
    VENDOR_PRODUCT_NOT_SUSPENDABLE: 'VENDOR_PRODUCT_NOT_SUSPENDABLE',

    /**
     * The product is suspended, but not by platform oversight — so this is not the
     * endpoint that lifts it. A product an agency suspended over unpaid storage is
     * that agency's to release.
     */
    VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED: 'VENDOR_PRODUCT_NOT_OVERSIGHT_SUSPENDED',

    /** Unsuspend re-runs the activation gate; `details.blockers` carries the checklist. */
    VENDOR_PRODUCT_UNSUSPEND_BLOCKED: 'VENDOR_PRODUCT_UNSUSPEND_BLOCKED',

    // ── STORE ─────────────────────────────────────────────────────────────────
    STORE_NOT_FOUND: 'STORE_NOT_FOUND',
    STORE_SLUG_TAKEN: 'STORE_SLUG_TAKEN',

    // ── MAGAZIN (agency business surface) ───────────────────────────────────────
    MAGAZIN_NOT_FOUND: 'MAGAZIN_NOT_FOUND',
    MAGAZIN_CONFLICT: 'MAGAZIN_CONFLICT',
    // A headquarters entry was removed while products are still stored there.
    // Deliberately NOT MAGAZIN_CONFLICT: that one means "your view is stale,
    // refresh and retry", which would be a lie here — retrying changes nothing.
    // Mirrors VENDOR_BUSINESS_ADDRESS_IN_USE on the vendor side.
    MAGAZIN_LOCATION_IN_USE: 'MAGAZIN_LOCATION_IN_USE',

    // ── AGENCY INVENTORY (what an agency stores, per depot) ─────────────────────
    INVENTORY_STOCK_LEVEL_NOT_FOUND: 'INVENTORY_STOCK_LEVEL_NOT_FOUND',
    // The depot named on an agency write is not one of the caller's own.
    INVENTORY_LOCATION_UNKNOWN: 'INVENTORY_LOCATION_UNKNOWN',
    // No stock row for (agency, product). Deliberately a 404, never a 403 —
    // whether a given product id exists is not information this caller is owed.
    INVENTORY_PRODUCT_NOT_STORED_HERE: 'INVENTORY_PRODUCT_NOT_STORED_HERE',
    // Only an ACTIVE product can be storage-suspended, mirroring the
    // delivery-agency cascade's rule that non-active products are left alone.
    INVENTORY_PRODUCT_NOT_SUSPENDABLE: 'INVENTORY_PRODUCT_NOT_SUSPENDABLE',
    INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED: 'INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED',
    // Unsuspend re-runs the activation gate; `details.blockers` carries the checklist.
    INVENTORY_PRODUCT_UNSUSPEND_BLOCKED: 'INVENTORY_PRODUCT_UNSUSPEND_BLOCKED',

    // ── COUNTED STOCK (Phase 6 · Step 14, D-6) ────────────────────────────────
    // An AGENCY movement that would drive a counter below zero. Never raised for a
    // system movement: an order selling stock the shelf record does not have is a
    // variance to surface, not a checkout to fail — see
    // AgencyStockMovementRepository.
    INVENTORY_INSUFFICIENT_STOCK: 'INVENTORY_INSUFFICIENT_STOCK',
    // A transfer whose source and destination depot are the same row.
    INVENTORY_TRANSFER_SAME_LOCATION: 'INVENTORY_TRANSFER_SAME_LOCATION',
    // Repointing a product to another depot while its shelves still hold units. A CONFLICT:
    // the remedy is to transfer the stock first, not to retry.
    INVENTORY_DEPOT_CHANGE_HOLDS_STOCK: 'INVENTORY_DEPOT_CHANGE_HOLDS_STOCK',

    // ── STORAGE INVOICES (Phase 6 · Step 14, D-7) ─────────────────────────────
    // A RECORD of rent owed, not a charge: nothing here moves money.
    STORAGE_INVOICE_NOT_FOUND: 'STORAGE_INVOICE_NOT_FOUND',
    // Settle and void both compare-and-set from `open`; a miss is a conflict, never
    // a not-found — the invoice is right there, it is just not in that state.
    STORAGE_INVOICE_NOT_OPEN: 'STORAGE_INVOICE_NOT_OPEN',

    // ── STOCK ADJUSTMENT REQUESTS (vendor ↔ agency, two-sided) ─────────────────
    STOCK_REQUEST_NOT_FOUND: 'STOCK_REQUEST_NOT_FOUND',
    STOCK_REQUEST_ALREADY_PENDING: 'STOCK_REQUEST_ALREADY_PENDING',
    // A compare-and-set miss on resolve. A CONFLICT, never a not-found — the row
    // exists, somebody else just resolved it. Callers must not re-read and retry.
    STOCK_REQUEST_NOT_PENDING: 'STOCK_REQUEST_NOT_PENDING',
    STOCK_REQUEST_NOT_YOURS: 'STOCK_REQUEST_NOT_YOURS',
    // The product stopped being stored with this agency while the request stood.
    STOCK_REQUEST_STALE: 'STOCK_REQUEST_STALE',
    STOCK_REQUEST_NO_CHANGE: 'STOCK_REQUEST_NO_CHANGE',

    // ── REVIEWS & RATINGS (products AND deliveries) ───────────────────────────
    // Each is raised at EXACTLY ONE status — `test:errors` censuses every
    // createAppError site and fails if a code appears at two statuses that
    // disagree on category.
    REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
    /**
     * 409. One review per author per subject, enforced by a unique index AND by a
     * pre-check. A CONFLICT rather than a validation error: the body was fine, the
     * author has simply already had their say. There is deliberately no edit verb,
     * so this is terminal for that (author, subject) pair.
     */
    REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
    /**
     * 422. The verified-purchase / verified-delivery gate. The author has no
     * completed order containing this product, or is not a party to this delivered
     * shipment. Deliberately NOT a 403: whether *somebody else* may review it is
     * not what was asked, and this is a rule of the domain, not an ownership check.
     */
    REVIEW_NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
    /**
     * 404. The product or shipment being reviewed does not exist — or does not
     * exist *for this caller*, which is the same answer on purpose. A 403 here
     * would confirm that an id somebody guessed is real.
     */
    REVIEW_SUBJECT_NOT_FOUND: 'REVIEW_SUBJECT_NOT_FOUND',
    /**
     * 422. The subject exists and is not in a state that can be reviewed — a
     * delivered shipment with no agent bound to it, the case every target
     * derivation needs and no real delivery produces.
     */
    REVIEW_SUBJECT_NOT_REVIEWABLE: 'REVIEW_SUBJECT_NOT_REVIEWABLE',
    /**
     * 409. A moderation compare-and-set miss — the review left `pending` while the
     * administrator was looking at it. Same shape and same reasoning as
     * `STOCK_REQUEST_NOT_PENDING`: the row exists, somebody else decided first.
     */
    REVIEW_NOT_PENDING: 'REVIEW_NOT_PENDING',
    /** 400. This author role may not review this subject type at all. */
    REVIEW_ROLE_NOT_ALLOWED: 'REVIEW_ROLE_NOT_ALLOWED',

    // ── BLOG / EDITORIAL ──────────────────────────────────────────────────────
    // Public reads produce only the first three; the rest are the editor's.
    BLOG_ARTICLE_NOT_FOUND: 'BLOG_ARTICLE_NOT_FOUND',
    /** 404 + `details.slug`: this URL's article moved. The FRONTEND owes the 301. */
    BLOG_ARTICLE_MOVED: 'BLOG_ARTICLE_MOVED',
    /** 410 + `details.categoryKey`: unpublished for good. Send the reader to the hub. */
    BLOG_ARTICLE_GONE: 'BLOG_ARTICLE_GONE',
    BLOG_ARTICLE_KEY_TAKEN: 'BLOG_ARTICLE_KEY_TAKEN',
    BLOG_ARTICLE_NOT_PUBLISHABLE: 'BLOG_ARTICLE_NOT_PUBLISHABLE',
    BLOG_ARTICLE_ALREADY_PUBLISHED: 'BLOG_ARTICLE_ALREADY_PUBLISHED',
    /** A published article is archived, never deleted — its URL has inbound links. */
    BLOG_ARTICLE_DELETE_NOT_ALLOWED: 'BLOG_ARTICLE_DELETE_NOT_ALLOWED',
    BLOG_SLUG_TAKEN: 'BLOG_SLUG_TAKEN',
    BLOG_SLUG_RESERVED: 'BLOG_SLUG_RESERVED',
    BLOG_AUTHOR_NOT_FOUND: 'BLOG_AUTHOR_NOT_FOUND',
    BLOG_AUTHOR_KEY_TAKEN: 'BLOG_AUTHOR_KEY_TAKEN',
    BLOG_AUTHOR_IN_USE: 'BLOG_AUTHOR_IN_USE',

    // ── VENDOR ────────────────────────────────────────────────────────────────
    VENDOR_FISCAL_CALENDAR_INVALID: 'VENDOR_FISCAL_CALENDAR_INVALID',
    VENDOR_BUSINESS_ADDRESS_IN_USE: 'VENDOR_BUSINESS_ADDRESS_IN_USE',
    VENDOR_NOTIFICATION_NOT_FOUND: 'VENDOR_NOTIFICATION_NOT_FOUND',
    VENDOR_NOTIFICATION_CHANNEL_NOT_VERIFIED: 'VENDOR_NOTIFICATION_CHANNEL_NOT_VERIFIED',
    VENDOR_NOTIFICATION_DELIVERY_FAILED: 'VENDOR_NOTIFICATION_DELIVERY_FAILED',
    VENDOR_ONBOARDING_CONCURRENT_MODIFICATION: 'VENDOR_ONBOARDING_CONCURRENT_MODIFICATION',
    VENDOR_ONBOARDING_STEP_INCOMPLETE: 'VENDOR_ONBOARDING_STEP_INCOMPLETE',
    VENDOR_ONBOARDING_STEP_INVALID: 'VENDOR_ONBOARDING_STEP_INVALID',
    VENDOR_ONBOARDING_ALREADY_COMPLETED: 'VENDOR_ONBOARDING_ALREADY_COMPLETED',
    VENDOR_CUSTOMER_NOT_FOUND: 'VENDOR_CUSTOMER_NOT_FOUND',
    VENDOR_CUSTOMER_FLAG_NOT_FOUND: 'VENDOR_CUSTOMER_FLAG_NOT_FOUND',
    VENDOR_CUSTOMER_FLAG_DUPLICATE: 'VENDOR_CUSTOMER_FLAG_DUPLICATE',
    VENDOR_POLICY_DOCUMENT_MISSING: 'VENDOR_POLICY_DOCUMENT_MISSING',
    VENDOR_POLICY_DOCUMENT_TYPE_INVALID: 'VENDOR_POLICY_DOCUMENT_TYPE_INVALID',

    // ── ORDER ─────────────────────────────────────────────────────────────────
    ORDER_CART_EMPTY: 'ORDER_CART_EMPTY',
    ORDER_CART_INVALID: 'ORDER_CART_INVALID',
    ORDER_PRODUCT_NOT_FOUND: 'ORDER_PRODUCT_NOT_FOUND',
    ORDER_VENDOR_NOT_FOUND: 'ORDER_VENDOR_NOT_FOUND',
    ORDER_NO_DELIVERY_AGENCY: 'ORDER_NO_DELIVERY_AGENCY',
    /**
     * A physical checkout resolved no geocoded drop-off.
     *
     * Deliberately NOT `ADDRESS_GEO_REQUIRED`, which is a **400** raised by
     * `address-country.helper.ts` when a supplied address object carries no `geo` — a
     * schema failure on a payload the caller sent. This one is a **422 business rule**: the
     * request is well-formed (both address fields are optional), and the rule is that a
     * physical order must have somewhere to go. Sharing one code would make its category
     * depend on which site raised it, which is what `test:errors`' census refuses.
     *
     * `details.reason` separates the two causes: `no_delivery_address` (nothing selected
     * and no default) versus `selected_address_not_geocoded` (an address the customer DID
     * choose, typed by hand rather than picked from `GET /api/geo/search`).
     */
    ORDER_DELIVERY_ADDRESS_REQUIRED: 'ORDER_DELIVERY_ADDRESS_REQUIRED',

    // ── CART ──────────────────────────────────────────────────────────────────
    CART_VARIANT_REQUIRED: 'CART_VARIANT_REQUIRED',
    CART_PRODUCT_NOT_FOUND: 'CART_PRODUCT_NOT_FOUND',
    CART_SERVICE_PRODUCT_NOT_ALLOWED: 'CART_SERVICE_PRODUCT_NOT_ALLOWED',
    CART_VARIANT_NOT_FOUND: 'CART_VARIANT_NOT_FOUND',
    CART_VARIANT_PRODUCT_MISMATCH: 'CART_VARIANT_PRODUCT_MISMATCH',
    CART_DIGITAL_QUANTITY_MUST_BE_ONE: 'CART_DIGITAL_QUANTITY_MUST_BE_ONE',
    CART_MIXED_PRODUCT_TYPES: 'CART_MIXED_PRODUCT_TYPES',
    CART_DIGITAL_LIMIT_REACHED: 'CART_DIGITAL_LIMIT_REACHED',
    CART_NOT_FOUND: 'CART_NOT_FOUND',
    CART_EMPTY_CHECKOUT: 'CART_EMPTY_CHECKOUT',
    /**
     * A variant-keyed cart operation named a line that is not in the cart.
     *
     * Distinct from `CART_VARIANT_NOT_FOUND`, which means the *variant* does not exist in
     * the catalogue at all. Here the variant is real and simply is not in this cart — a
     * stale tab, or a second device that already removed the line — and the client's remedy
     * is to re-read the cart rather than to re-check the product.
     */
    CART_ITEM_NOT_FOUND: 'CART_ITEM_NOT_FOUND',

    // ── BOOKING ───────────────────────────────────────────────────────────────
    BOOKING_PRODUCT_NOT_FOUND: 'BOOKING_PRODUCT_NOT_FOUND',
    BOOKING_USER_NOT_FOUND: 'BOOKING_USER_NOT_FOUND',
    BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
    BOOKING_UNAUTHORIZED: 'BOOKING_UNAUTHORIZED',
    BOOKING_ALREADY_CANCELLED: 'BOOKING_ALREADY_CANCELLED',
    BOOKING_CALENDAR_SYNC_FAILED: 'BOOKING_CALENDAR_SYNC_FAILED',
    BOOKING_INVALID_STATUS_TRANSITION: 'BOOKING_INVALID_STATUS_TRANSITION',
    BOOKING_PAYMENT_NOT_REQUIRED: 'BOOKING_PAYMENT_NOT_REQUIRED',
    BOOKING_ALREADY_PAID: 'BOOKING_ALREADY_PAID',
    BOOKING_INVALID_PAYMENT_METHOD: 'BOOKING_INVALID_PAYMENT_METHOD',
    BOOKING_TERMINAL_STATE: 'BOOKING_TERMINAL_STATE',
    BOOKING_SLOT_NOT_LOCKED: 'BOOKING_SLOT_NOT_LOCKED',
    BOOKING_SLOT_LOCKED: 'BOOKING_SLOT_LOCKED',
    BOOKING_FORBIDDEN: 'BOOKING_FORBIDDEN',
    BOOKING_INVALID_SLOT_ID: 'BOOKING_INVALID_SLOT_ID',
    BOOKING_NOT_RESCHEDULABLE: 'BOOKING_NOT_RESCHEDULABLE',
    BOOKING_SLOT_FULL: 'BOOKING_SLOT_FULL',
    /** No balance is outstanding on this booking. */
    BOOKING_NO_BALANCE_DUE: 'BOOKING_NO_BALANCE_DUE',
    /** The outstanding balance has already been settled. */
    BOOKING_BALANCE_ALREADY_SETTLED: 'BOOKING_BALANCE_ALREADY_SETTLED',
    /** A balance payment is already in flight with the gateway. */
    BOOKING_BALANCE_PAYMENT_IN_PROGRESS: 'BOOKING_BALANCE_PAYMENT_IN_PROGRESS',
    /** The booking must be completed before its balance can be settled. */
    BOOKING_NOT_COMPLETED: 'BOOKING_NOT_COMPLETED',
    /** An active booking already overlaps the requested interval (commit-time race). */
    BOOKING_SLOT_UNAVAILABLE: 'BOOKING_SLOT_UNAVAILABLE',
    /** The booking is past the point where it can be cancelled by its owner. */
    BOOKING_NOT_CANCELLABLE: 'BOOKING_NOT_CANCELLABLE',

    // ── AVAILABILITY RULES (service products) ─────────────────────────────────
    AVAILABILITY_PRODUCT_NOT_FOUND: 'AVAILABILITY_PRODUCT_NOT_FOUND',
    AVAILABILITY_RULE_NOT_FOUND: 'AVAILABILITY_RULE_NOT_FOUND',
    AVAILABILITY_INVALID_PRODUCT_TYPE: 'AVAILABILITY_INVALID_PRODUCT_TYPE',
    AVAILABILITY_INVALID_TIME_RANGE: 'AVAILABILITY_INVALID_TIME_RANGE',
    AVAILABILITY_TIME_OVERLAP: 'AVAILABILITY_TIME_OVERLAP',
    AVAILABILITY_FORBIDDEN: 'AVAILABILITY_FORBIDDEN',
    /** `timezone` is not a resolvable IANA zone name. */
    AVAILABILITY_INVALID_TIMEZONE: 'AVAILABILITY_INVALID_TIMEZONE',

    // ── ADMIN ─────────────────────────────────────────────────────────────────
    ADMIN_NOT_FOUND: 'ADMIN_NOT_FOUND',
    ADMIN_FORBIDDEN: 'ADMIN_FORBIDDEN',

    // ── BILLING (pricing plans & credit wallet) ───────────────────────────────
    BILLING_PLAN_NOT_FOUND: 'BILLING_PLAN_NOT_FOUND',
    BILLING_PLAN_INACTIVE: 'BILLING_PLAN_INACTIVE',
    BILLING_PLAN_ROLE_MISMATCH: 'BILLING_PLAN_ROLE_MISMATCH',
    BILLING_PLAN_CODE_EXISTS: 'BILLING_PLAN_CODE_EXISTS',
    BILLING_PENDING_PLAN_EXISTS: 'BILLING_PENDING_PLAN_EXISTS',
    BILLING_INSUFFICIENT_CREDITS: 'BILLING_INSUFFICIENT_CREDITS',
    BILLING_LIMIT_EXCEEDED: 'BILLING_LIMIT_EXCEEDED',
    BILLING_WALLET_CONFLICT: 'BILLING_WALLET_CONFLICT',
    BILLING_TOPUP_NOT_FOUND: 'BILLING_TOPUP_NOT_FOUND',
    BILLING_TOPUP_PACK_NOT_FOUND: 'BILLING_TOPUP_PACK_NOT_FOUND',
    BILLING_TOPUP_INVALID_STATE: 'BILLING_TOPUP_INVALID_STATE',
    BILLING_PLAN_PURCHASE_NOT_FOUND: 'BILLING_PLAN_PURCHASE_NOT_FOUND',
    BILLING_PLAN_NOT_PURCHASABLE: 'BILLING_PLAN_NOT_PURCHASABLE',
    BILLING_PURCHASE_INVALID_STATE: 'BILLING_PURCHASE_INVALID_STATE',

    // ── EARNINGS (commission, escrow & payout ledger) ─────────────────────────
    EARNINGS_INVALID_SPLIT: 'EARNINGS_INVALID_SPLIT',
    EARNINGS_ALLOCATION_NOT_FOUND: 'EARNINGS_ALLOCATION_NOT_FOUND',
    EARNINGS_ALREADY_COMPLETED: 'EARNINGS_ALREADY_COMPLETED',
    EARNINGS_ORDER_NOT_CONFIRMABLE: 'EARNINGS_ORDER_NOT_CONFIRMABLE',
    EARNINGS_FORBIDDEN: 'EARNINGS_FORBIDDEN',
    EARNINGS_PAYOUT_ALREADY_PENDING: 'EARNINGS_PAYOUT_ALREADY_PENDING',
    EARNINGS_PAYOUT_METHOD_MISSING: 'EARNINGS_PAYOUT_METHOD_MISSING',
    EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE: 'EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE',
    EARNINGS_PAYOUT_BELOW_MINIMUM: 'EARNINGS_PAYOUT_BELOW_MINIMUM',
    EARNINGS_PAYOUT_REQUEST_NOT_FOUND: 'EARNINGS_PAYOUT_REQUEST_NOT_FOUND',
    EARNINGS_PAYOUT_REQUEST_NOT_PENDING: 'EARNINGS_PAYOUT_REQUEST_NOT_PENDING',

    // ── COD (cash on delivery: collection, cash liabilities, reconciliation) ──
    COD_NOT_AVAILABLE_FOR_DIGITAL: 'COD_NOT_AVAILABLE_FOR_DIGITAL',
    COD_AGENCY_NOT_SUPPORTED: 'COD_AGENCY_NOT_SUPPORTED',
    COD_ORDER_AMOUNT_EXCEEDS_LIMIT: 'COD_ORDER_AMOUNT_EXCEEDS_LIMIT',
    COD_COLLECTION_NOT_FOUND: 'COD_COLLECTION_NOT_FOUND',
    COD_COLLECTION_ALREADY_COLLECTED: 'COD_COLLECTION_ALREADY_COLLECTED',
    COD_COLLECTION_NOT_COLLECTIBLE: 'COD_COLLECTION_NOT_COLLECTIBLE',
    COD_INVALID_CODE: 'COD_INVALID_CODE',
    COD_CODE_ATTEMPTS_EXCEEDED: 'COD_CODE_ATTEMPTS_EXCEEDED',
    COD_CODE_RESEND_TOO_SOON: 'COD_CODE_RESEND_TOO_SOON',
    COD_AGENT_NOT_ASSIGNED: 'COD_AGENT_NOT_ASSIGNED',
    COD_AGENT_EXPOSURE_EXCEEDED: 'COD_AGENT_EXPOSURE_EXCEEDED',
    COD_AGENT_TRUST_TOO_LOW: 'COD_AGENT_TRUST_TOO_LOW',
    COD_AGENT_HAS_OUTSTANDING_CASH: 'COD_AGENT_HAS_OUTSTANDING_CASH',
    COD_DEPOSIT_INVALID_AMOUNT: 'COD_DEPOSIT_INVALID_AMOUNT',
    COD_DEPOSIT_EXCEEDS_BALANCE: 'COD_DEPOSIT_EXCEEDS_BALANCE',
    COD_DEPOSIT_NOT_FOUND: 'COD_DEPOSIT_NOT_FOUND',
    COD_DEPOSIT_ALREADY_RESOLVED: 'COD_DEPOSIT_ALREADY_RESOLVED',
    COD_DEPOSIT_REFERENCE_REQUIRED: 'COD_DEPOSIT_REFERENCE_REQUIRED',
    /** Direct-to-platform deposit for cash the agency has already remitted. */
    COD_DEPOSIT_AGENCY_ALREADY_SETTLED: 'COD_DEPOSIT_AGENCY_ALREADY_SETTLED',
    COD_DEPOSIT_WRONG_RECIPIENT: 'COD_DEPOSIT_WRONG_RECIPIENT',
    COD_REMITTANCE_INVALID_AMOUNT: 'COD_REMITTANCE_INVALID_AMOUNT',
    COD_REMITTANCE_EXCEEDS_LIABILITY: 'COD_REMITTANCE_EXCEEDS_LIABILITY',
    COD_REMITTANCE_NOT_FOUND: 'COD_REMITTANCE_NOT_FOUND',
    COD_REMITTANCE_ALREADY_RESOLVED: 'COD_REMITTANCE_ALREADY_RESOLVED',
    COD_DISCREPANCY_NOT_FOUND: 'COD_DISCREPANCY_NOT_FOUND',
    COD_DISCREPANCY_ALREADY_RESOLVED: 'COD_DISCREPANCY_ALREADY_RESOLVED',

    // ── AUTH EXTENDED ─────────────────────────────────────────────────────────
    AUTH_OAUTH_STATE_INVALID: 'AUTH_OAUTH_STATE_INVALID',
    AUTH_OAUTH_STATE_EXPIRED: 'AUTH_OAUTH_STATE_EXPIRED',

    // ── STORAGE ───────────────────────────────────────────────────────────────
    STORAGE_FILE_NOT_FOUND: 'STORAGE_FILE_NOT_FOUND',
    STORAGE_DELETE_FAILED: 'STORAGE_DELETE_FAILED',
    STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
    STORAGE_CLEANUP_FAILED: 'STORAGE_CLEANUP_FAILED',
    /**
     * The configured `STORAGE_PROVIDER` cannot serve bytes at all — `firebase` and
     * `cloudinary` both throw 501 from `getDownloadStream` (see
     * `supportsDownloadStream()` on `IStorageProvider`).
     *
     * ⚠ **A CONFIGURATION state, not an incident**, which is the entire reason it is not
     * `INTERNAL_SERVER_ERROR`. A caller must be able to say "this deployment cannot show
     * private files" rather than "something went wrong" — the second sends an operator
     * hunting an outage that does not exist. Raised at **409**, never 5xx, so the
     * `business_rule` category carries that meaning through the envelope.
     */
    STORAGE_DOWNLOAD_NOT_SUPPORTED: 'STORAGE_DOWNLOAD_NOT_SUPPORTED',

    // ── CATALOG EXTENDED ──────────────────────────────────────────────────────
    CATALOG_DIGITAL_ASSET_ACCESS_DENIED: 'CATALOG_DIGITAL_ASSET_ACCESS_DENIED',
    CATALOG_SHIPPING_NOT_FOUND: 'CATALOG_SHIPPING_NOT_FOUND',
    CATALOG_SHIPPING_ACCESS_DENIED: 'CATALOG_SHIPPING_ACCESS_DENIED',

    // ── COMMAND BUS ───────────────────────────────────────────────────────────
    COMMAND_ALREADY_REGISTERED: 'COMMAND_ALREADY_REGISTERED',
    COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',

    // ── WHATSAPP EXTENDED ─────────────────────────────────────────────────────
    WHATSAPP_INVALID_PAYLOAD: 'WHATSAPP_INVALID_PAYLOAD',
    WHATSAPP_POLICY_VIOLATION: 'WHATSAPP_POLICY_VIOLATION',
    WHATSAPP_PROVIDER_REJECTED: 'WHATSAPP_PROVIDER_REJECTED',
    WHATSAPP_VALIDATION_ERROR: 'WHATSAPP_VALIDATION_ERROR',
    WHATSAPP_IDEMPOTENCY_REQUIRED: 'WHATSAPP_IDEMPOTENCY_REQUIRED',
    WHATSAPP_DUPLICATE_MESSAGE: 'WHATSAPP_DUPLICATE_MESSAGE',
    WHATSAPP_UNSUPPORTED_MESSAGE_TYPE: 'WHATSAPP_UNSUPPORTED_MESSAGE_TYPE',

    // ── DIGITAL ASSET ─────────────────────────────────────────────────────────
    DIGITAL_ASSET_NOT_FOUND: 'DIGITAL_ASSET_NOT_FOUND',
    DIGITAL_ASSET_ACCESS_DENIED: 'DIGITAL_ASSET_ACCESS_DENIED',
    DIGITAL_ASSET_IN_USE: 'DIGITAL_ASSET_IN_USE',

    // ── DIGITAL ENTITLEMENT ───────────────────────────────────────────────────
    DIGITAL_ENTITLEMENT_CONFIG_MISSING: 'DIGITAL_ENTITLEMENT_CONFIG_MISSING',
    DIGITAL_ENTITLEMENT_CONFIG_INACTIVE: 'DIGITAL_ENTITLEMENT_CONFIG_INACTIVE',

    // ── DEVELOPER TOOLS ── the operational surface wi-admin drives (Phase 12) ─
    // Reached only through /api/internal/admin/dev-tools, never from /api/admin/*.
    DEV_TOOLS_WORKER_UNKNOWN: 'DEV_TOOLS_WORKER_UNKNOWN',
    DEV_TOOLS_WORKER_BUSY: 'DEV_TOOLS_WORKER_BUSY',
    DEV_TOOLS_CACHE_DB_UNKNOWN: 'DEV_TOOLS_CACHE_DB_UNKNOWN',
    DEV_TOOLS_CACHE_FLUSH_REFUSED: 'DEV_TOOLS_CACHE_FLUSH_REFUSED',
    DEV_TOOLS_CACHE_UNAVAILABLE: 'DEV_TOOLS_CACHE_UNAVAILABLE',
    // Phase 15 — the one new dangerous verb on that router.
    DEV_TOOLS_OUTBOX_PRUNE_REFUSED: 'DEV_TOOLS_OUTBOX_PRUNE_REFUSED',

    // ── SYSTEM ── the operations surface (Phase 14) ──────────────────────────
    // `SYSTEM_MAINTENANCE_ACTIVE` is the ONLY 503 this service raises deliberately, and it is
    // raised by middleware rather than a service — the one place a maintenance window turns
    // into an HTTP response.
    SYSTEM_MAINTENANCE_ACTIVE: 'SYSTEM_MAINTENANCE_ACTIVE',
    SYSTEM_MAINTENANCE_REASON_REQUIRED: 'SYSTEM_MAINTENANCE_REASON_REQUIRED',

    // ── SYSTEM ── developer tools (Phase 15) ─────────────────────────────────
    /**
     * Boot-time only. Raised by `assertExposedConfigSafe()` when the config whitelist names
     * something credential-shaped — the process must die rather than serve it once.
     */
    SYSTEM_CONFIG_EXPOSURE_UNSAFE: 'SYSTEM_CONFIG_EXPOSURE_UNSAFE',
    SYSTEM_LOGS_UNAVAILABLE: 'SYSTEM_LOGS_UNAVAILABLE',
    SYSTEM_DB_INSPECT_UNAVAILABLE: 'SYSTEM_DB_INSPECT_UNAVAILABLE',
    /** A Redis command that is not on the read-only allowlist. Should be unreachable. */
    SYSTEM_REDIS_COMMAND_REFUSED: 'SYSTEM_REDIS_COMMAND_REFUSED',

    // ── REQUEST — malformed BEFORE any schema sees it (Phase 16) ─────────────
    // Express rejects these inside `express.json()`, so no route and no Zod schema is ever
    // reached. Without them the global handler had no branch and a caller sending malformed
    // JSON was told `500 INTERNAL_SERVER_ERROR — Something went wrong`: our fault reported
    // for their payload, with nothing they could act on. Ported from wi-admin, which fixed
    // this first (ADR-005 D-9 records that jovi-mall still had it).
    //
    // Distinct from VALIDATION_ERROR, which means the JSON parsed and then failed a rule.

    /** The body is not parseable JSON at all. */
    REQUEST_BODY_INVALID: 'REQUEST_BODY_INVALID',
    /** The body exceeds the ceiling set on `express.json()` in `app.ts`. */
    REQUEST_BODY_TOO_LARGE: 'REQUEST_BODY_TOO_LARGE',
    /** An unsupported `Content-Type` or charset. */
    REQUEST_MEDIA_TYPE_UNSUPPORTED: 'REQUEST_MEDIA_TYPE_UNSUPPORTED',

    // ── RATE LIMITING (Phase 16) ─────────────────────────────────────────────
    /**
     * Raised by the rate-limit middleware only.
     *
     * Distinct from `COD_CODE_RESEND_TOO_SOON`, which is also a 429 but is a per-resource
     * cooldown on one delivery code rather than a request-volume ceiling. A client backs off
     * differently for each: this one clears on a clock, that one clears on a resend window.
     */
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

    // ── MIDDLEWARE / ROUTER FALLBACKS — DO NOT USE IN SERVICES ───────────────
    INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',  // assigned by global handler
    NOT_FOUND: 'NOT_FOUND',              // unmatched routes only
    VALIDATION_ERROR: 'VALIDATION_ERROR',       // ZodError catch in handler only
} as const);

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
