import { ErrorCode, ERROR_CODES } from './error-codes';
import { categoryFor, ErrorCategory } from './error-category';

/**
 * Base error class for all application errors.
 *
 * - `code`          — machine-readable, domain-prefixed identifier (from ERROR_CODES)
 * - `statusCode`    — HTTP status code
 * - `category`      — the Phase-16 taxonomy value, DERIVED from (code, statusCode)
 * - `isOperational` — expected domain error, or a bug on our side
 * - `details`       — optional supplemental data
 *
 * ── Why `category` is computed in the CONSTRUCTOR ─────────────────────────────
 * Not in `createAppError`. The four retained subclasses below call `super(...)` directly,
 * and so do six sites in `ticket.service.ts`, so the factory is not the only construction
 * path — the constructor is the only place that sees all of them. Putting the derivation
 * here is what makes "every AppError has a category" true by construction rather than by
 * everybody remembering.
 *
 * ── `isOperational` is now DERIVED, and it used to be a lie ───────────────────
 * `createAppError` hardcoded `true` for every error it ever made, so the masking this
 * field's own docstring promised has never once happened — a 500 raised through the factory
 * was logged as an expected business outcome. It now defaults to `statusCode < 500`,
 * matching wi-admin, and the explicit parameter survives only for the `ticket.service.ts`
 * sites that already pass `false` deliberately.
 *
 * The global handler uses `category` to decide what reaches the client and `isOperational`
 * to decide log severity. They answer different questions and neither substitutes for the
 * other: a 503 maintenance window is operational AND masked.
 */
export class AppError extends Error {
  public readonly isOperational: boolean;
  public readonly category: ErrorCategory;

  constructor(
    public readonly message: string,
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    isOperational?: boolean,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
    this.isOperational = isOperational ?? statusCode < 500;
    this.category = categoryFor(code, statusCode);
  }
}

/** The message a code with no registry entry resolves to. */
export const GENERIC_ERROR_MESSAGE = 'An unexpected error occurred';

/**
 * Default messages keyed to code — keeps throw-sites terse.
 *
 * ── Why this is at module scope ───────────────────────────────────────────────
 * It used to be declared INSIDE `createAppError`, which meant this ~330-line object literal
 * was rebuilt on every one of the 1517 throw sites in the service. Hoisting it changes no
 * behaviour and is the same lines; it is here rather than left alone because Phase 16 needs
 * to READ it from outside the factory — `error-detail-policy.ts` substitutes the registry
 * default for an `internal` or `external_service` error's thrown message, and it cannot
 * reach a local.
 *
 * Frozen for the same reason `ERROR_CODES` is: a message rewritten at runtime is a contract
 * changed at runtime.
 */
export const DEFAULT_ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = Object.freeze({
    [ERROR_CODES.INTERNAL_SERVER_ERROR]: 'Something went wrong',
    [ERROR_CODES.NOT_FOUND]: 'Resource not found',
    [ERROR_CODES.VALIDATION_ERROR]: 'Validation failed',

    [ERROR_CODES.KYC_SUBJECT_NOT_FOUND]: 'No verification record for this account',
    [ERROR_CODES.KYC_SLOT_UNKNOWN]: 'That is not a document this account can provide',
    [ERROR_CODES.KYC_LOCKED]: 'Your verification documents cannot be changed right now',
    [ERROR_CODES.KYC_SLOT_FULL]: 'No room left for another file in this slot',
    [ERROR_CODES.KYC_DOCUMENT_NOT_FOUND]: 'That document is not attached to this slot',
    [ERROR_CODES.KYC_FILE_REQUIRED]: 'Attach at least one file',

    [ERROR_CODES.AUTH_INVALID_CREDENTIALS]: 'Invalid credentials',
    [ERROR_CODES.AUTH_TOKEN_EXPIRED]: 'Access token expired',
    [ERROR_CODES.AUTH_TOKEN_INVALID]: 'Invalid token',
    [ERROR_CODES.AUTH_MISSING_TOKEN]: 'Authentication token required',
    [ERROR_CODES.AUTH_ROLE_NOT_FOUND]: 'User does not have this role',
    [ERROR_CODES.AUTH_ROLE_ALREADY_EXISTS]: 'User already has this role',
    [ERROR_CODES.AUTH_ROLE_REQUIRED]: 'Role selection required',
    [ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND]: 'Account not found',
    [ERROR_CODES.AUTH_PHONE_TAKEN]: 'User with this phone already exists',
    [ERROR_CODES.AUTH_EMAIL_TAKEN]: 'User with this email already exists',
    [ERROR_CODES.AUTH_EMAIL_ALREADY_VERIFIED]: 'Email is already verified',
    [ERROR_CODES.AUTH_EMAIL_MISSING]: 'No email address to verify',
    [ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID]: 'Invalid or expired verification token',
    [ERROR_CODES.AUTH_RESET_TOKEN_INVALID]: 'This password reset link is invalid or has expired. Please request a new one.',
    [ERROR_CODES.AUTH_PROFILE_NOT_FOUND]: 'Role profile not found',
    [ERROR_CODES.AUTH_UNSUPPORTED_ROLE]: 'This role is not supported',
    [ERROR_CODES.AUTH_REFRESH_TOKEN_INVALID]: 'Invalid or expired refresh token',
    [ERROR_CODES.AUTH_SESSION_EXPIRED]: 'Session expired, please log in again',
    [ERROR_CODES.AUTH_PASSWORD_CHANGED]: 'Your password was changed. Please sign in again',
    // Deliberately says nothing is wrong. The cap is routine, quarterly and not a security
    // event — but it is also not refreshable, so the copy must send the person to the login
    // screen rather than suggest waiting it out.
    [ERROR_CODES.AUTH_SESSION_CAP_REACHED]: "It's been a while — please sign in again",
    [ERROR_CODES.AUTH_USER_NOT_FOUND]: 'User not found',
    // Says "closed", never "deleted" — ADR-A02 D-2 is explicit that the promise is
    // anonymisation and must not be described to a customer as an erasure.
    [ERROR_CODES.AUTH_ACCOUNT_CLOSED]: 'This account has been closed',
    [ERROR_CODES.AUTH_ROLE_PROFILE_NOT_FOUND]: 'Role profile not found',

    [ERROR_CODES.EARNINGS_INVALID_SPLIT]: 'Order fees exceed the paid amount; cannot split earnings',
    [ERROR_CODES.EARNINGS_ALLOCATION_NOT_FOUND]: 'Earnings allocation not found',
    [ERROR_CODES.EARNINGS_ALREADY_COMPLETED]: 'This order has already been confirmed',
    [ERROR_CODES.EARNINGS_ORDER_NOT_CONFIRMABLE]: 'This order cannot be confirmed yet',
    [ERROR_CODES.EARNINGS_FORBIDDEN]: 'You are not allowed to access these earnings',
    [ERROR_CODES.EARNINGS_PAYOUT_ALREADY_PENDING]: 'A payout request is already pending',
    [ERROR_CODES.EARNINGS_PAYOUT_METHOD_MISSING]: 'No payout method is configured on this profile',
    [ERROR_CODES.EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE]: 'There is no available balance to request a payout for',
    [ERROR_CODES.EARNINGS_PAYOUT_BELOW_MINIMUM]: 'Available balance is below the minimum payout amount',
    [ERROR_CODES.EARNINGS_PAYOUT_UNVERIFIED_CAP_REACHED]:
        'This account has reached the payout allowance for unverified accounts — verification lifts it',
    [ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND]: 'Payout request not found',
    [ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_PENDING]: 'This payout request has already been resolved',
    [ERROR_CODES.EARNINGS_PAYOUT_NOT_SENDABLE]:
        'This payout cannot be sent in its current state',
    [ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT]:
        'A transfer for this payout is still in flight and must settle before it can be resolved',
    [ERROR_CODES.EARNINGS_PAYOUT_ALREADY_TRIAGED]: 'This payout request has already been reviewed',
    [ERROR_CODES.EARNINGS_PAYOUT_GATEWAY_UNSUPPORTED]:
        'No configured payment gateway can send to this payout destination',
    // The `internal` sentence the caller actually receives: the boundary replaces the thrown
    // message with this one and drops `details`, so it must name no setting and no provider.
    [ERROR_CODES.EARNINGS_PAYOUT_GATEWAY_NOT_CONFIGURED]: 'No payout gateway is configured',
    [ERROR_CODES.EARNINGS_PAYOUT_TRANSFER_FAILED]: 'The payment gateway refused the transfer',

    /**
     * ── COD ──────────────────────────────────────────────────────────────────
     *
     * Every one of these threw with `message: undefined` and NO registry entry, so all
     * of them rendered as the generic `An unexpected error occurred` — on a 422 whose
     * category is `business_rule` and whose `details` carry the real numbers. A dashboard
     * had the figures and no sentence to put beside them, and an operator reading the
     * response saw a message that says "this is a bug on our side" about a rule working
     * exactly as designed.
     *
     * Written for the person who has to ACT on them. The exposure and trust messages say
     * whose limit it is, because the single most common misreading of that refusal is
     * that the agency's own threshold is the number that applied — it is that threshold
     * scaled by the agent's trust tier, and `details.effectiveLimit` is the result.
     */
    [ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL]: 'Cash on delivery is not available for digital orders',
    [ERROR_CODES.COD_AGENCY_NOT_SUPPORTED]: 'This agency does not accept cash on delivery',
    [ERROR_CODES.COD_ORDER_AMOUNT_EXCEEDS_LIMIT]: 'This order is worth more than the cash-on-delivery limit allows',
    [ERROR_CODES.COD_COLLECTION_NOT_FOUND]: 'Cash collection not found',
    [ERROR_CODES.COD_COLLECTION_ALREADY_COLLECTED]: 'This cash has already been collected',
    [ERROR_CODES.COD_COLLECTION_NOT_COLLECTIBLE]: 'This collection cannot be collected in its current state',
    [ERROR_CODES.COD_INVALID_CODE]: 'That delivery code is not correct',
    [ERROR_CODES.COD_CODE_ATTEMPTS_EXCEEDED]: 'Too many incorrect delivery codes — a new code must be sent',
    [ERROR_CODES.COD_CODE_RESEND_TOO_SOON]: 'A delivery code was just sent; please wait before requesting another',
    [ERROR_CODES.COD_AGENT_NOT_ASSIGNED]: 'This agent is not assigned to that shipment',
    [ERROR_CODES.COD_AGENT_EXPOSURE_EXCEEDED]:
        'This agent is already holding more cash than this contract allows them to carry',
    [ERROR_CODES.COD_AGENT_TRUST_TOO_LOW]:
        "This agent's trust score is too low for cash-on-delivery work with this contract",
    [ERROR_CODES.COD_AGENT_HAS_OUTSTANDING_CASH]: 'This agent still holds cash that has not been deposited',
    [ERROR_CODES.COD_DEPOSIT_INVALID_AMOUNT]: 'That deposit amount is not valid',
    [ERROR_CODES.COD_DEPOSIT_EXCEEDS_BALANCE]: 'That deposit is more than the agent is holding',
    [ERROR_CODES.COD_DEPOSIT_NOT_FOUND]: 'Deposit not found',
    [ERROR_CODES.COD_DEPOSIT_ALREADY_RESOLVED]: 'This deposit has already been confirmed or rejected',
    [ERROR_CODES.COD_DEPOSIT_REFERENCE_REQUIRED]: 'A payment reference is required for this deposit',
    [ERROR_CODES.COD_DEPOSIT_AGENCY_ALREADY_SETTLED]: 'The agency has already remitted this cash to the platform',
    [ERROR_CODES.COD_DEPOSIT_WRONG_RECIPIENT]: 'This deposit was declared to a different recipient',
    [ERROR_CODES.COD_REMITTANCE_INVALID_AMOUNT]: 'That remittance amount is not valid',
    [ERROR_CODES.COD_REMITTANCE_EXCEEDS_LIABILITY]: 'That remittance is more than this agency owes',
    [ERROR_CODES.COD_REMITTANCE_NOT_FOUND]: 'Remittance not found',
    [ERROR_CODES.COD_REMITTANCE_ALREADY_RESOLVED]: 'This remittance has already been confirmed or rejected',
    [ERROR_CODES.COD_DISCREPANCY_NOT_FOUND]: 'Cash discrepancy not found',
    [ERROR_CODES.COD_DISCREPANCY_ALREADY_RESOLVED]: 'This discrepancy has already been resolved',

    /**
     * The four assignment gates, which had the same defect for the same reason — all
     * four throw with `message: undefined`. They are listed beside COD rather than with
     * the agent codes because they are the OTHER half of one refusal: a dispatch is
     * gated by the platform rules and by the contract terms, and an operator reading
     * either needs a sentence, not `An unexpected error occurred`.
     */
    [ERROR_CODES.AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT]:
        'This agent cannot take shipments right now — see details for every rule that failed',
    [ERROR_CODES.AGENT_MEMBERSHIP_NOT_APPROVED]: 'This agent has no active contract with this agency',
    [ERROR_CODES.CONTRACT_COVERAGE_REGION_NOT_COVERED]:
        'This delivery is outside the regions this contract covers',
    [ERROR_CODES.CONTRACT_SHIPMENT_VALUE_EXCEEDED]:
        'This shipment is worth more than this contract allows for a single delivery',

    /**
     * ── The rest of the dispatch vocabulary ──────────────────────────────────
     *
     * A scan for `createAppError(ERROR_CODES.X, <status>, undefined` against codes with no
     * registry entry found **52 codes across ~85 call sites** rendering
     * `An unexpected error occurred` — `SHIPMENT_NOT_FOUND` among them, at four sites.
     *
     * The agent · contract · shipment-assignment families are given messages here because
     * they ARE the vocabulary of "why can't I assign my agent", which is the question
     * `/assignability` exists to answer — a diagnostic that names a blocker the error
     * response cannot describe only moves the confusion.
     *
     * The remainder (payments · refunds · booking · tickets · product-share) are LEFT, and
     * are baselined in `scripts/test/test-errors.ts` § 8 so the list cannot grow. Writing
     * plausible-sounding copy for a domain without reading its rules is how a wrong message
     * gets believed, and a wrong message is worse than a generic one.
     */

    /**
     * ⚠ The scan above matches `createAppError(CODE, 404, undefined`. It does NOT match the
     * TWO-ARGUMENT form `createAppError(CODE, 404)`, which is the same declaration — "the
     * registry speaks for me" — written more briefly, and which is how the single worst
     * offender is written: `AGENT_NOT_FOUND` at **38 call sites**, rendering
     * `An unexpected error occurred` at every one. Found by calling the new diagnostic with
     * an id that does not exist, after the first pass had reported itself complete.
     * `test:errors` § 8 matches both forms now.
     */
    [ERROR_CODES.AGENT_NOT_FOUND]: 'Agent not found',
    [ERROR_CODES.AGENT_MEMBERSHIP_NOT_FOUND]: 'No contract between this agent and this agency',
    [ERROR_CODES.CONTRACT_NOT_FOUND]: 'Contract not found',
    [ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_FOUND]: 'Contract request not found',
    [ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_FOUND]: 'Terms proposal not found',
    [ERROR_CODES.SHIPMENT_OFFER_NOT_FOUND]: 'Assignment offer not found',

    /**
     * The two service-token refusals. A caller holding the wrong secret should be told the
     * credential was rejected, not that something went wrong on our side — the second reads
     * as an outage and sends an operator to look at the wrong service.
     */
    [ERROR_CODES.AUTH_ADMIN_CALLER_TOKEN_INVALID]: 'Invalid administrative service token',
    [ERROR_CODES.AGENT_SERVICE_TOKEN_INVALID]: 'Invalid service token',
    [ERROR_CODES.AUTH_ACCOUNT_SUSPENDED]: 'This account has been suspended',

    // Agent — platform gates and limits
    [ERROR_CODES.AGENT_NOT_ACTIVE]: 'This agent account is not active',
    [ERROR_CODES.AGENT_PLATFORM_BANNED]: 'This agent is banned from the platform',
    [ERROR_CODES.AGENT_KYC_NOT_VERIFIED]: "This agent's identity documents have not been verified",
    [ERROR_CODES.AGENT_TRACKING_NOT_ALLOWED]:
        'Tracking is disabled for this agent, and the platform will not dispatch without it',
    [ERROR_CODES.AGENT_AT_CAPACITY]: 'This agent is already carrying their maximum number of shipments',
    [ERROR_CODES.AGENT_CAPACITY_OUT_OF_BOUNDS]: 'That shipment capacity is outside the allowed range',
    [ERROR_CODES.AGENT_CAPACITY_BELOW_IN_USE]:
        'That capacity is below the number of shipments this agent is already carrying',
    [ERROR_CODES.AGENT_COD_THRESHOLD_OUT_OF_BOUNDS]: 'That COD threshold is outside the allowed range',
    [ERROR_CODES.AGENT_COD_THRESHOLD_BELOW_ALLOCATED]:
        'That COD pool is smaller than what this agent has already allocated to their agencies',
    [ERROR_CODES.AGENT_COD_POOL_ABOVE_CEILING]:
        'That COD pool is more than your plan allows — you can only lower it',
    [ERROR_CODES.AGENT_COD_POOL_CONFLICT]:
        'Your COD pool changed while this request was in flight — reload it and try again',
    [ERROR_CODES.AGENT_TRUST_OVERRIDE_OUT_OF_BOUNDS]: 'A pinned trust score must be between 0 and 100',
    [ERROR_CODES.AGENT_MEMBERSHIP_ALREADY_EXISTS]: 'This agent already has a contract with this agency',
    [ERROR_CODES.AGENT_MEMBERSHIP_LIMIT_REACHED]:
        'This agent has reached the maximum number of agency contracts',

    // Contract — lifecycle, terms and the negotiation workflow
    [ERROR_CODES.CONTRACT_INVALID_TRANSITION]: 'This contract cannot move to that status from its current one',
    [ERROR_CODES.CONTRACT_TRANSITION_NOT_PERMITTED]: 'You are not allowed to make that change to this contract',
    [ERROR_CODES.CONTRACT_HAS_OUTSTANDING_COD]:
        'This contract still has cash outstanding — it must be settled first',
    [ERROR_CODES.CONTRACT_HAS_UNPAID_EARNINGS]:
        'This contract still has unpaid earnings — they must be settled first',
    [ERROR_CODES.CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING]:
        'That settlement is more than this contract has outstanding',
    [ERROR_CODES.CONTRACT_FEE_SPLIT_INVALID]: 'That fee split is not valid',
    [ERROR_CODES.CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS]: 'That COD threshold is outside the allowed range',
    [ERROR_CODES.CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM]:
        "That COD threshold is more than the agent has left unallocated in their pool",
    [ERROR_CODES.CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING]:
        'That COD threshold is below what the agent already owes under this contract',
    [ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_PENDING]: 'This request has already been answered',
    [ERROR_CODES.CONTRACT_STATUS_REQUEST_ALREADY_PENDING]: 'A request on this contract is already pending',
    [ERROR_CODES.CONTRACT_STATUS_REQUEST_NOT_YOURS]: 'This request is not yours to answer',
    [ERROR_CODES.CONTRACT_TERMS_REQUIRED]: 'Contract terms must be stated before this contract can be approved',
    [ERROR_CODES.CONTRACT_TERMS_NOT_PROPOSED]: 'Nobody has proposed terms for this contract yet',
    [ERROR_CODES.CONTRACT_TERMS_NOT_NEGOTIABLE]: 'That term is not one you may propose',
    [ERROR_CODES.CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED]:
        'A live contract cannot be edited directly — propose the change instead',
    [ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_PENDING]: 'This proposal has already been answered',
    [ERROR_CODES.CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING]: 'A proposal on this contract is already pending',
    [ERROR_CODES.CONTRACT_TERMS_PROPOSAL_NOT_YOURS]: 'This proposal is not yours to answer',

    // Shipment assignment
    [ERROR_CODES.SHIPMENT_NOT_FOUND]: 'Shipment not found',
    [ERROR_CODES.SHIPMENT_NOT_OFFERABLE]: 'This shipment cannot be offered to an agent in its current status',
    [ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT]: 'This shipment already has an agent',
    [ERROR_CODES.SHIPMENT_ALREADY_HAS_PENDING_OFFER]: 'This agent already has a pending offer for this shipment',
    [ERROR_CODES.SHIPMENT_OFFER_NOT_PENDING]: 'This offer has already been answered or has expired',
    [ERROR_CODES.SHIPMENT_CANCEL_NOT_ALLOWED]: 'This shipment cannot be cancelled in its current status',
    [ERROR_CODES.SHIPMENT_CANCEL_CONFLICT]: 'This shipment changed while you were cancelling it — reload and retry',
    [ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED]:
        'This shipment cannot be reassigned in its current status',
    [ERROR_CODES.SHIPMENT_REASSIGNMENT_CONFLICT]:
        'This shipment changed while you were reassigning it — reload and retry',

    [ERROR_CODES.PAYMENT_ORDER_NOT_FOUND]: 'Order not found',
    [ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID]: 'Order is already paid',
    [ERROR_CODES.PAYMENT_INVALID_ORDER_STATUS]: 'Invalid order status for payment',
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED]: 'Payment gateway not supported',
    // The `internal` sentence a customer actually receives: the boundary replaces the thrown
    // message with this one and drops `details`, so it must say nothing about our secrets.
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_CONFIGURED]: 'No payment gateway is configured',
    [ERROR_CODES.PAYMENT_INITIATION_FAILED]: 'Payment initiation failed',
    [ERROR_CODES.PAYMENT_VERIFICATION_FAILED]: 'Payment verification failed',
    [ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND]: 'Booking not found',
    [ERROR_CODES.PAYMENT_BOOKING_CANCELLED]: 'Cannot pay for a cancelled booking',
    [ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED]: 'This booking does not require payment',
    [ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID]: 'Booking is already paid',
    [ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS]: 'Payment already in progress',
    [ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND]: 'Payment transaction not found',
    [ERROR_CODES.PAYMENT_WEBHOOK_INVALID_PAYLOAD]: 'Could not extract gateway reference from webhook payload',
    [ERROR_CODES.PAYMENT_MISSING_BOOKING_ID]: 'Transaction does not have a bookingId',
    [ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED]: 'Payment gateway not yet implemented',
    [ERROR_CODES.PAYMENT_CARD_DECLINED]: 'Card was declined',
    [ERROR_CODES.STRIPE_WEBHOOK_SIGNATURE_INVALID]: 'Stripe webhook signature verification failed',
    [ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED]:
        'We could not tell which mobile network this number belongs to. Please choose MTN or Orange.',
    [ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED]: 'This currency cannot be charged by mobile money',
    [ERROR_CODES.PAYMENT_WEBHOOK_AMOUNT_MISMATCH]:
        'The confirmed amount does not match the amount recorded for this payment',
    [ERROR_CODES.PAYMENT_OTP_INVALID]: 'That confirmation code is not correct',
    [ERROR_CODES.PAYMENT_OTP_NOT_REQUIRED]: 'This payment is not waiting for a confirmation code',
    [ERROR_CODES.PAYMENT_OTP_ATTEMPTS_EXCEEDED]:
        'Too many incorrect confirmation codes. Please start the payment again.',

    // The hosted card page (GAP-008).
    [ERROR_CODES.PAYMENT_LINK_NOT_FOUND]:
        'This payment link is not valid. Ask for a new one.',
    [ERROR_CODES.PAYMENT_LINK_NOT_APPLICABLE]:
        'This payment is completed on your phone and does not need a payment page',
    [ERROR_CODES.PAYMENT_LINK_NOT_PAYABLE]:
        'This payment is already finished, so no new payment page can be opened for it',

    // The four below are `external_service`, so THESE strings are what the client
    // receives — the thrown message and `details` are dropped at the boundary.
    [ERROR_CODES.NOTCHPAY_REQUEST_FAILED]: 'The mobile money provider rejected this request',
    [ERROR_CODES.NOTCHPAY_UNREACHABLE]: 'The mobile money provider could not be reached',
    [ERROR_CODES.MYCOOLPAY_REQUEST_FAILED]: 'The mobile money provider rejected this request',
    [ERROR_CODES.MYCOOLPAY_UNREACHABLE]: 'The mobile money provider could not be reached',

    [ERROR_CODES.BOOKING_NOT_FOUND]: 'Booking not found',
    [ERROR_CODES.BOOKING_INVALID_STATUS_TRANSITION]: 'Invalid status transition',

    [ERROR_CODES.TICKET_NOT_FOUND]: 'Ticket not found',
    [ERROR_CODES.TICKET_UPDATE_FAILED]: 'Failed to update ticket status',
    [ERROR_CODES.TICKET_ASSIGN_FAILED]: 'Failed to assign ticket',
    [ERROR_CODES.TICKET_PRIORITY_UPDATE_FAILED]: 'Failed to update priority',
    [ERROR_CODES.TICKET_CLOSE_FAILED]: 'Failed to close ticket',
    [ERROR_CODES.TICKET_REOPEN_FAILED]: 'Failed to reopen ticket',
    [ERROR_CODES.TICKET_GENERAL_UPDATE_FAILED]: 'Failed to update ticket',
    [ERROR_CODES.TICKET_ACCESS_DENIED]: 'Access to this ticket is denied',
    [ERROR_CODES.TICKET_FOLLOWER_LIMIT_EXCEEDED]: 'Maximum of 5 non-admin followers per ticket exceeded',
    [ERROR_CODES.TICKET_ATTACHMENT_LIMIT_EXCEEDED]: 'Maximum of 5 attachments per ticket exceeded',
    [ERROR_CODES.TICKET_ATTACHMENT_MISSING]: 'Attachment file is required',
    [ERROR_CODES.TICKET_PRIORITY_LOCKED]: 'Priority is locked and cannot be modified',
    [ERROR_CODES.TICKET_INVALID_STATUS_TRANSITION]: 'Invalid status transition',
    [ERROR_CODES.TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN]: 'Customers can only create public notes',

    [ERROR_CODES.DIGITAL_INVALID_ENTITLEMENT_ID]: 'Invalid entitlement ID',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND]: 'Entitlement not found',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_UNAUTHORIZED]: 'This entitlement does not belong to you',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_REVOKED]: 'This entitlement has been revoked',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED]: 'This entitlement has expired',
    [ERROR_CODES.DIGITAL_DOWNLOAD_LIMIT_EXCEEDED]: 'Download limit exceeded',
    [ERROR_CODES.DIGITAL_TOKEN_INVALID]: 'Invalid, expired, or already used token',

    // One message for absent / expired / malformed / already-spent, deliberately:
    // the response must not confirm whether a code was ever real. Same reasoning
    // as AUTH_RESET_TOKEN_INVALID.
    [ERROR_CODES.CONNECTION_CODE_INVALID]: 'That connection code is not valid',
    [ERROR_CODES.CONNECTION_CODE_EXPIRED]:
        'That connection code has expired. Send /connect to the bot again for a new one.',
    [ERROR_CODES.CONNECTION_CODE_ATTEMPTS_EXCEEDED]:
        'Too many connection attempts. Please wait a few minutes and try again.',
    [ERROR_CODES.CONNECTION_CODE_GENERATION_FAILED]: 'Could not generate a connection code',
    // Deliberately says nothing about WHICH account holds it — see the throw site.
    [ERROR_CODES.MESSAGING_IDENTITY_ALREADY_LINKED]:
        'That messaging account is already connected to a different account',
    [ERROR_CODES.MESSAGING_CONNECTION_NOT_FOUND]: 'No account connected on this channel',
    [ERROR_CODES.MESSAGING_IDENTITY_UNRESOLVED]:
        'Could not determine which messaging account sent this message',
    [ERROR_CODES.WEBHOOK_SECRET_INVALID]: 'Webhook authentication failed',

    // ── Passwordless sign-in ─────────────────────────────────────────────────
    // Written for a person staring at a sign-in screen, so each names the remedy
    // — which is always "get a new one from the bot", never "check your typing".
    //
    // EXPIRED and INVALID read differently on purpose, exactly as the connection
    // codes do: expiry is the common failure (somebody read the message, got
    // distracted, came back) and it is actionable. What is deliberately NOT
    // differentiated is anything inside MAGIC_CODE_INVALID — see error-codes.ts.
    [ERROR_CODES.MAGIC_LINK_INVALID]:
        'This sign-in link is not valid. Send /login to the bot again for a new one.',
    [ERROR_CODES.MAGIC_LINK_EXPIRED]:
        'This sign-in link has expired. Send /login to the bot again for a new one.',
    [ERROR_CODES.MAGIC_CODE_INVALID]:
        'That sign-in code is not valid. Send /login to the bot again for a new one.',
    [ERROR_CODES.MAGIC_CODE_EXPIRED]:
        'That sign-in code has expired. Send /login to the bot again for a new one.',
    [ERROR_CODES.MAGIC_ATTEMPTS_EXCEEDED]:
        'Too many sign-in attempts. Please wait a few minutes and try again.',
    // Reached only through the bot, so it is written for a chat window rather than
    // a form. It must not sound like an accusation: the ordinary way to hit it is
    // tapping the wrong contact, not an attempted takeover.
    [ERROR_CODES.MAGIC_CONTACT_UNVERIFIED]:
        'Please use the "Share my phone number" button so Telegram can confirm the number is yours.',
    [ERROR_CODES.MAGIC_SESSION_GENERATION_FAILED]: 'Could not start a sign-in session',

    // ── THE BOT SURFACE (`/api/internal/bot/*`) ───────────────────────────────
    // Written for the AUTOMATION LAYER, not for a chat window. The bot surface
    // never sends anything itself — the automation layer turns an outcome into
    // copy, in the customer's own language — so a message here that read like a
    // reply to a shopper would be a second, English, un-localised copy of a
    // sentence n8n already owns. Compare `MAGIC_CONTACT_UNVERIFIED` above, which
    // IS relayed verbatim and is written accordingly.
    [ERROR_CODES.BOT_IDENTITY_UNRESOLVED]:
        'No platform account is bound to this messaging identity',
    [ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT]:
        'This chat is anonymous — a verified contact must be shared before any customer-scoped operation',
    [ERROR_CODES.BOT_IDENTITY_NOT_CUSTOMER]:
        'This messaging identity does not resolve to a customer account',
    [ERROR_CODES.BOT_IDENTITY_TOKEN_INVALID]:
        'The sealed identity token is not valid',
    [ERROR_CODES.BOT_IDENTITY_TOKEN_EXPIRED]:
        'The sealed identity token has expired',
    [ERROR_CODES.BOT_IDEMPOTENCY_KEY_REQUIRED]:
        'Idempotency-Key is required on every mutating bot route',
    [ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS]:
        'A request carrying this Idempotency-Key is still in flight',
    // `external_service` at 503, so the boundary substitutes this registry default for
    // whatever was thrown and drops `details` — which is correct here: the operator needs
    // to know Redis is unreachable and the caller only needs to know to retry.
    [ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE]:
        'The idempotency store is unavailable, so the operation was not attempted',
    [ERROR_CODES.BOT_IDEMPOTENCY_KEY_REUSED]:
        'This Idempotency-Key was already spent by a different request',
    [ERROR_CODES.BOT_GEO_CANDIDATE_EXPIRED]:
        'That address candidate is unknown or has expired — run the search again',
    [ERROR_CODES.BOT_INBOUND_FILE_EXPIRED]:
        'That file reference is unknown or has expired — the customer must send the file again',
    [ERROR_CODES.BOT_PRODUCT_LIST_EXPIRED]:
        'That product list is unknown or has expired — run the search again',
    [ERROR_CODES.BOT_SCREEN_SESSION_EXPIRED]:
        'That screen session is unknown, spent or has expired — open the screen again',
    [ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN]:
        'That button carries a token this service does not recognise',
    [ERROR_CODES.BOT_PRODUCT_NOT_IN_LIST]:
        'Those products are not part of the list this page was opened for',
    [ERROR_CODES.BOT_REGISTRATION_IDENTITY_TAKEN]:
        'This messaging identity is already bound to a different platform account',
    [ERROR_CODES.BOT_ONBOARDING_NOT_REGISTERED]:
        'This sender has no account yet — only the phone step can be submitted',
    [ERROR_CODES.BOT_ONBOARDING_STEP_NOT_SKIPPABLE]:
        'That onboarding step is required and cannot be skipped',
    [ERROR_CODES.BOT_ONBOARDING_VALUE_REQUIRED]:
        'That onboarding step was provided with no value',
    [ERROR_CODES.BOT_SUPPORT_NO_CONTEXT]:
        'Nothing recent to route support from — no hint, no orders, nothing viewed',
    [ERROR_CODES.BOT_SUPPORT_SCOPE_UNAVAILABLE]:
        'The requested support scope has no party in this context',
    [ERROR_CODES.BOT_CONNECTION_ACTIVE_CHANNEL]:
        'A chat cannot disconnect the channel it arrived on — that is the binding this request was resolved by',
    [ERROR_CODES.BOT_CONTACT_CODE_RESEND_TOO_SOON]:
        'That code was sent moments ago — wait before asking for another',

    [ERROR_CODES.GOOGLE_MISSING_CLIENT_ID]: 'GOOGLE_CLIENT_ID is not configured',
    [ERROR_CODES.GOOGLE_MISSING_CLIENT_SECRET]: 'GOOGLE_CLIENT_SECRET is not configured',
    [ERROR_CODES.GOOGLE_MISSING_REDIRECT_URI]: 'GOOGLE_REDIRECT_URI is not configured',
    [ERROR_CODES.GOOGLE_PROFILE_FETCH_FAILED]: 'Failed to retrieve user profile from Google',
    [ERROR_CODES.GOOGLE_NO_ACCESS_TOKEN]: 'No access token received from Google',
    [ERROR_CODES.GOOGLE_NO_REFRESH_TOKEN]: 'No refresh token received. Please reconnect Google.',
    [ERROR_CODES.GOOGLE_CALENDAR_NOT_CONNECTED]: 'Google Calendar is not connected',
    [ERROR_CODES.GOOGLE_EVENT_MISSING_ID]: 'Google event is missing an ID',
    [ERROR_CODES.GOOGLE_EVENT_MISSING_DATETIME]: 'Google event is missing start/end dateTime',
    [ERROR_CODES.GOOGLE_TOKEN_ENCRYPTION_KEY_MISSING]: 'GOOGLE_TOKEN_ENCRYPTION_KEY is not defined',
    [ERROR_CODES.GOOGLE_TOKEN_INVALID_FORMAT]: 'Invalid encrypted token format',
    [ERROR_CODES.INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER]: 'Unsupported calendar provider',

    [ERROR_CODES.DATABASE_UNAVAILABLE]: 'Database connection not available',
    [ERROR_CODES.DATABASE_UNIQUE_CONSTRAINT_VIOLATION]: 'A record with this value already exists',

    [ERROR_CODES.ORDER_NOT_FOUND]: 'Order not found',
    [ERROR_CODES.ORDER_PAYMENT_FAILED]: 'Order payment failed',

    [ERROR_CODES.CONFIG_MISSING_WA_ACCESS_TOKEN]: 'WHATSAPP_ACCESS_TOKEN environment variable is required',
    [ERROR_CODES.CONFIG_MISSING_WA_PHONE_ID]: 'WHATSAPP_PHONE_NUMBER_ID environment variable is required',

    [ERROR_CODES.MAIL_TEMPLATE_NOT_FOUND]: 'Mail template not found',

    /**
     * Only the last of these six is `external_service` and therefore actually substituted at
     * the boundary; the other five are `validation`/`rate_limit` and keep their thrown message.
     * They are registered anyway so `test:errors` § 8 stays green and so a future site that
     * raises one at a 5xx does not suddenly render "An unexpected error occurred".
     */
    [ERROR_CODES.PHONE_VERIFICATION_NO_TARGET]: 'No phone number on this account to verify',
    [ERROR_CODES.PHONE_VERIFICATION_CODE_INVALID]: 'That verification code is not correct',
    [ERROR_CODES.PHONE_VERIFICATION_CODE_EXPIRED]: 'That verification code has expired',
    [ERROR_CODES.PHONE_VERIFICATION_TOO_MANY_ATTEMPTS]: 'Too many incorrect codes. Request a new one.',
    [ERROR_CODES.PHONE_VERIFICATION_RESEND_TOO_SOON]: 'A code was sent recently. Please wait before requesting another.',
    [ERROR_CODES.PHONE_VERIFICATION_DELIVERY_FAILED]: 'The verification code could not be delivered',

    /**
     * These seven matter more than most registry entries, because every one of them is
     * `external_service` or `internal` — the two categories whose thrown message the boundary
     * REPLACES with what is written here. Without an entry each renders as the generic
     * "An unexpected error occurred", which is the exact failure `test:errors` § 8 exists to
     * catch. The thrown messages name the provider and the status and are journaled; these are
     * what a client is allowed to read.
     */
    [ERROR_CODES.MAIL_PROVIDER_NOT_CONFIGURED]: 'No email provider is configured',
    [ERROR_CODES.MAIL_PROVIDER_QUOTA_EXCEEDED]: 'The email provider has no sending allowance left',
    [ERROR_CODES.MAIL_PROVIDER_RATE_LIMITED]: 'The email provider is rate limiting this platform',
    [ERROR_CODES.MAIL_PROVIDER_UNAVAILABLE]: 'The email provider is unreachable',
    [ERROR_CODES.MAIL_PROVIDER_AUTH_FAILED]: 'The email provider refused this platform\'s credentials',
    [ERROR_CODES.MAIL_SEND_REJECTED]: 'The email provider refused this message',
    [ERROR_CODES.MAIL_ALL_PROVIDERS_FAILED]: 'The message could not be sent by any configured email provider',
    [ERROR_CODES.CONFIG_INVALID_MAIL_PROVIDER]: 'Invalid mail provider configuration',

    [ERROR_CODES.VENDOR_FISCAL_CALENDAR_INVALID]: 'Invalid fiscal calendar configuration',
    [ERROR_CODES.VENDOR_ONBOARDING_CONCURRENT_MODIFICATION]: 'Vendor profile was modified by another request. Please refresh and try again.',

    [ERROR_CODES.CATALOG_INSUFFICIENT_STOCK]: 'Insufficient stock available',
    [ERROR_CODES.CATALOG_OVERSALE_NOT_ALLOWED]: 'Operation would result in negative stock. Overselling not allowed.',
    [ERROR_CODES.CATALOG_INVALID_CSV_FORMAT]: 'Invalid CSV format. Required headers: variantId, quantity',
    [ERROR_CODES.CATALOG_BULK_VALIDATION_FAILED]: 'Bulk validation failed',
    [ERROR_CODES.CATALOG_RESERVATION_EXPIRED]: 'Reservation has expired',
    [ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED]: 'Bulk update limit exceeded',
    [ERROR_CODES.CATALOG_TRANSACTION_LIMIT_EXCEEDED]: 'Batch size too large. Please reduce to fewer rows.',

    [ERROR_CODES.ANALYTICS_INVALID_DATE_RANGE]: 'Invalid date range provided',
    [ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE]: 'Timezone is not supported',
    [ERROR_CODES.ANALYTICS_AGGREGATION_NOT_READY]: 'Analytics data not yet available for requested period',
    [ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED]: 'Date range cannot exceed the maximum allowed',

    [ERROR_CODES.AUTH_FORBIDDEN]: 'auth forbidden',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED]: 'digital entitlement already revoked',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_REVOKED]: 'digital entitlement not revoked',
    [ERROR_CODES.DATABASE_CONNECTION_ERROR]: 'database connection error',
    [ERROR_CODES.ORDER_TERMINAL_STATE]: 'order terminal state',
    [ERROR_CODES.ORDER_INVALID_TRANSITION]: 'order invalid transition',
    [ERROR_CODES.ORDER_PAYMENT_REQUIRED]: 'order payment required',
    [ERROR_CODES.ORDER_PAYMENT_FAILED_STATE]: 'order payment failed state',
    [ERROR_CODES.ORDER_WRONG_TYPE]: 'order wrong type',
    [ERROR_CODES.ORDER_DELIVERY_AGENCY_NOT_FOUND]: 'order delivery agency not found',
    [ERROR_CODES.SHIPMENT_INVALID_STATUS_TRANSITION]: 'Invalid shipment status transition',
    [ERROR_CODES.SHIPMENT_REJECTION_NOT_ALLOWED]: 'This shipment can no longer be rejected',
    [ERROR_CODES.SHIPMENT_AGENT_NOT_IN_AGENCY]: 'This agent does not belong to your agency',
    [ERROR_CODES.SHIPMENT_ACCESS_DENIED]: 'You do not have access to this shipment',
    [ERROR_CODES.SHIPMENT_ALREADY_CONFIRMED]: 'This shipment has already been confirmed as delivered',
    [ERROR_CODES.SHIPMENT_CONFIRMATION_NOT_ALLOWED]: 'This shipment cannot be confirmed yet',
    [ERROR_CODES.CONFIG_MISSING_STORAGE_PROVIDER]: 'config missing storage provider',
    [ERROR_CODES.CONFIG_INVALID_STORAGE_PROVIDER]: 'config invalid storage provider',
    [ERROR_CODES.CONFIG_INVALID_UPLOAD_SCANNER]: 'File scanning is misconfigured',
    [ERROR_CODES.UPLOAD_VIRUS_SCAN_UNAVAILABLE]: 'File scanning is temporarily unavailable',
    [ERROR_CODES.STORAGE_UPLOAD_FAILED]: 'storage upload failed',
    [ERROR_CODES.UPLOAD_POLICY_VIOLATION]: 'upload policy violation',
    [ERROR_CODES.VENDOR_UNSUPPORTED_FISCAL_CALENDAR]: 'vendor unsupported fiscal calendar',
    [ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND]: 'catalog product not found',
    [ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED]: 'catalog product access denied',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE]: 'catalog product invalid state',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE]: 'catalog product invalid title',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DESCRIPTION]: 'A description is required to activate or publish a product',
    [ERROR_CODES.CATALOG_PRODUCT_ALREADY_PUBLISHED]: 'catalog product already published',
    // These four are the vendor-facing publish checklist: they are surfaced verbatim
    // as `activationBlockers[].message` by the simple-product endpoints, so they must
    // read as instructions to the vendor, not as code identifiers.
    [ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS]: 'This product needs at least one variant with a price before it can be published',
    [ERROR_CODES.INVENTORY_DEPOT_CHANGE_HOLDS_STOCK]: 'Move this stock to the new depot before changing where the product is stored',
    [ERROR_CODES.INVENTORY_INSUFFICIENT_STOCK]: 'That shelf does not hold enough stock for this movement',
    [ERROR_CODES.INVENTORY_TRANSFER_SAME_LOCATION]: 'That stock is already at this depot',
    [ERROR_CODES.STORAGE_INVOICE_NOT_FOUND]: 'Storage invoice not found',
    [ERROR_CODES.STORAGE_INVOICE_NOT_OPEN]: 'That storage invoice is no longer open',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT]: 'This product needs an active default variant before it can be published',
    [ERROR_CODES.CATALOG_PRODUCT_DIGITAL_NO_ASSET]: 'catalog product digital no asset',
    [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION]: 'catalog product service no duration',
    [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_AVAILABILITY]: 'Service products require at least one active availability rule to be activated',
    [ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_CAPACITY]: 'Capacity-mode service variants need a seat count of at least 1',
    [ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE]: 'Every active variant needs a price greater than 0',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DELIVERY_AGENCY]: 'Set an active default delivery agency on your vendor profile to publish physical products',
    [ERROR_CODES.CATALOG_PRODUCT_VENDOR_SUSPENDED]: 'This vendor is suspended, so their products cannot be put on sale',
    [ERROR_CODES.CATALOG_PRODUCT_NO_PICKUP_LOCATION]: 'Choose where the delivery agency should collect this product from',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_PICKUP_LOCATION]: 'The chosen pickup location is not compatible with your delivery agency',
    [ERROR_CODES.CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK]: 'A product stored in an agency warehouse must have a countable stock quantity. Turn off unlimited stock on every active variant',
    [ERROR_CODES.CATALOG_IMAGE_LIMIT_EXCEEDED]: 'Too many images for this product',
    [ERROR_CODES.CATALOG_PRODUCT_SIMPLE_MODE_LOCKED]: 'This product uses the simple editor. Convert it to the advanced editor to use this operation',
    [ERROR_CODES.CATALOG_PRODUCT_NOT_SIMPLE_MODE]: 'This product uses the advanced editor — use the standard product and variant endpoints to edit it',
    [ERROR_CODES.CATALOG_PRODUCT_NOT_DIGITAL]: 'catalog product not digital',
    [ERROR_CODES.CATALOG_PRODUCT_NO_DIGITAL_CONFIG]: 'catalog product no digital config',
    [ERROR_CODES.CATALOG_VARIANT_NOT_FOUND]: 'catalog variant not found',
    [ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED]: 'catalog variant access denied',
    [ERROR_CODES.CATALOG_VARIANT_ARCHIVED]: 'catalog variant archived',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_STOCK]: 'catalog variant invalid stock',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE]: 'catalog variant invalid price',
    [ERROR_CODES.CATALOG_VARIANT_COMPARE_PRICE_INVALID]: 'catalog variant compare price invalid',
    [ERROR_CODES.CATALOG_VARIANT_BARGAIN_NOT_SUPPORTED]: 'Bargainable pricing is not available on service products',
    [ERROR_CODES.CATALOG_VARIANT_BARGAIN_RANGE_INVALID]: 'The maximum bargain price must be at least the variant price',
    [ERROR_CODES.CATALOG_VARIANT_BARGAIN_PRICE_MISMATCH]: 'bargain.minPrice must equal the variant price',
    [ERROR_CODES.NEGOTIATION_PLAYBOOK_NOT_PUBLISHED]: 'No negotiation playbook is published — bargaining is unavailable',
    [ERROR_CODES.NEGOTIATION_LOCK_INVALID]: 'That agreed price could not be found',
    [ERROR_CODES.NEGOTIATION_LOCK_EXPIRED]: 'That agreed price has expired',
    [ERROR_CODES.NEGOTIATION_LOCK_CONSUMED]: 'That agreed price has already been used on an order',
    [ERROR_CODES.NEGOTIATION_LOCK_VARIANT_MISMATCH]: 'That agreed price was for a different item or quantity',
    [ERROR_CODES.NEGOTIATION_LOCK_WINDOW_MOVED]: 'The seller has changed this price since it was agreed',
    [ERROR_CODES.NEGOTIATION_SESSION_NOT_FOUND]: 'No negotiation session was found for this line',
    [ERROR_CODES.NEGOTIATION_SESSION_EXPIRED]: 'This negotiation has expired',
    [ERROR_CODES.NEGOTIATION_SESSION_CLOSED]: 'This negotiation is already closed',
    [ERROR_CODES.NEGOTIATION_PRICE_BELOW_FLOOR]: 'The proposed price is below the seller’s minimum',
    [ERROR_CODES.NEGOTIATION_PRICE_ABOVE_ASK]: 'The proposed price is above the asking price',
    [ERROR_CODES.NEGOTIATION_PRICE_INCREASED]: 'A quoted price may not go back up',
    [ERROR_CODES.NEGOTIATION_NOT_BARGAINABLE]: 'This item is not negotiable',
    [ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED]: 'Name the product first — pass a productId, variantId, sku or slug',
    [ERROR_CODES.NEGOTIATION_PROMOTIONS_UNAVAILABLE]: 'This platform runs no promotions or discount codes at all, so no code can be checked and none exists',
    [ERROR_CODES.CATALOG_VARIANT_LIMIT_EXCEEDED]: 'catalog variant limit exceeded',
    [ERROR_CODES.CATALOG_VARIANT_NO_OPTIONS]: 'catalog variant no options',
    [ERROR_CODES.CATALOG_VARIANT_OPTION_EMPTY]: 'catalog variant option empty',
    [ERROR_CODES.CATALOG_VARIANT_INSUFFICIENT_STOCK]: 'catalog variant insufficient stock',
    [ERROR_CODES.CATALOG_VARIANT_UNSUPPORTED_TYPE]: 'catalog variant unsupported type',
    [ERROR_CODES.CATALOG_VARIANT_NO_DIGITAL_ASSET]: 'catalog variant no digital asset',
    [ERROR_CODES.CATALOG_DIGITAL_VARIANT_LIMIT_EXCEEDED]: 'Digital products are limited to 5 active variants',
    [ERROR_CODES.CATALOG_SERVICE_VARIANT_EXISTS]: 'Service products may only have one variant',
    [ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY]: 'catalog variant invalid quantity',
    [ERROR_CODES.CATALOG_VARIANT_STOCK_ONLY_PHYSICAL]: 'catalog variant stock only physical',
    [ERROR_CODES.CATALOG_VARIANT_RESERVATION_CONFLICT]: 'catalog variant reservation conflict',
    [ERROR_CODES.CATALOG_OPTION_NOT_FOUND]: 'catalog option not found',
    [ERROR_CODES.CATALOG_OPTION_ACCESS_DENIED]: 'catalog option access denied',
    [ERROR_CODES.CATALOG_OPTION_LIMIT_EXCEEDED]: 'catalog option limit exceeded',
    [ERROR_CODES.CATALOG_OPTION_DUPLICATE_NAME]: 'catalog option duplicate name',
    [ERROR_CODES.CATALOG_OPTION_REQUIRES_VALUES]: 'catalog option requires values',
    [ERROR_CODES.CATALOG_OPTION_DUPLICATE_VALUE]: 'catalog option duplicate value',
    [ERROR_CODES.CATALOG_OPTION_VALUES_EXIST]: 'catalog option values exist',
    [ERROR_CODES.CATALOG_OPTION_REQUIRES_NO_OPTIONS]: 'catalog option requires no options',
    [ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE]: 'catalog product invalid type',
    [ERROR_CODES.CATALOG_VARIANT_SKU_EXISTS]: 'catalog variant sku exists',
    [ERROR_CODES.CATALOG_INVALID_OPTION_ID]: 'catalog invalid option id',
    [ERROR_CODES.CATALOG_INVALID_CSV]: 'catalog invalid csv',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS]: 'catalog digital asset already exists',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING]: 'catalog digital asset missing',
    [ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING]: 'catalog digital config missing',
    [ERROR_CODES.CATALOG_FILE_TOO_LARGE]: 'catalog file too large',
    [ERROR_CODES.CATALOG_FILE_TYPE_INVALID]: 'catalog file type invalid',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE]: 'catalog digital asset missing file',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND]: 'catalog digital asset not found',
    [ERROR_CODES.CATALOG_VARIANT_RESERVATION_NOT_FOUND]: 'catalog variant reservation not found',
    [ERROR_CODES.CATALOG_FILE_NOT_FOUND]: 'catalog file not found',
    [ERROR_CODES.CATALOG_FILE_ALREADY_ATTACHED]: 'catalog file already attached',
    [ERROR_CODES.CATALOG_FILE_STILL_REFERENCED]: 'catalog file still referenced',
    [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_FOUND]: 'catalog booking product not found',
    [ERROR_CODES.CATALOG_BOOKING_INVALID_PRODUCT_TYPE]: 'catalog booking invalid product type',
    [ERROR_CODES.CATALOG_BOOKING_MISSING_SERVICE_CONFIG]: 'catalog booking missing service config',
    [ERROR_CODES.CATALOG_BOOKING_PRODUCT_NOT_ACTIVE]: 'catalog booking product not active',
    [ERROR_CODES.CATALOG_BOOKING_INVALID_PRICE]: 'catalog booking invalid price',
    [ERROR_CODES.CATALOG_BOOKING_NOT_IMPLEMENTED]: 'catalog booking not implemented',
    [ERROR_CODES.CATALOG_BULK_EMPTY]: 'catalog bulk empty',
    [ERROR_CODES.CATALOG_BULK_TRANSACTION_LIMIT]: 'catalog bulk transaction limit',
    [ERROR_CODES.CATALOG_BULK_UPDATE_FAILED]: 'catalog bulk update failed',
    [ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND]: 'delivery agency not found',
    [ERROR_CODES.DELIVERY_AGENT_NOT_FOUND]: 'delivery agent not found',
    [ERROR_CODES.DELIVERY_AGENCY_ALREADY_EXISTS]: 'An agency profile already exists for this user',
    [ERROR_CODES.DELIVERY_ONBOARDING_STEP_INVALID]: 'Invalid onboarding step',
    [ERROR_CODES.DELIVERY_ONBOARDING_STEP_INCOMPLETE]: 'Previous onboarding step has not been completed',
    [ERROR_CODES.DELIVERY_ONBOARDING_ALREADY_COMPLETED]: 'Agency onboarding is already completed',
    [ERROR_CODES.DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION]: 'Agency profile was modified by another request. Please refresh and try again.',
    [ERROR_CODES.AGENT_ONBOARDING_ALREADY_COMPLETED]: 'Agent onboarding is already completed. Update your details from profile settings instead.',
    [ERROR_CODES.CONNECTION_NOT_FOUND]: 'Connection not found',
    [ERROR_CODES.CONNECTION_VENDOR_NOT_FOUND]: 'Vendor not found or not eligible to connect with',
    [ERROR_CODES.CONNECTION_ALREADY_EXISTS]: 'A connection already exists between you and this counterparty',
    [ERROR_CODES.CONNECTION_INVALID_STATUS_TRANSITION]: 'This connection cannot be moved to that status from its current status',
    [ERROR_CODES.CONNECTION_NOT_PENDING]: 'This action requires the connection to be pending',
    [ERROR_CODES.CONNECTION_NOT_PAUSED]: 'This connection is not currently awaiting reapproval',
    [ERROR_CODES.CONNECTION_NOT_REQUESTER]: 'Only the party that sent this request can perform this action',
    [ERROR_CODES.CONNECTION_NOT_APPROVER]: 'Only the party that received this request can perform this action',
    [ERROR_CODES.CONNECTION_WRONG_REAPPROVAL_PARTY]: 'The other party changed their policy — you are not the one who needs to reapprove this connection',
    [ERROR_CODES.CONNECTION_NOT_ACTIVE]: 'You need an active, approved connection with this party before you can do that',
    [ERROR_CODES.CUSTOMER_NOT_FOUND]: 'customer not found',
    [ERROR_CODES.WISHLIST_ITEM_NOT_FOUND]: 'That product is not on your wishlist',
    [ERROR_CODES.CUSTOMER_ADDRESS_NOT_FOUND]: 'customer address not found',
    [ERROR_CODES.CUSTOMER_PAYMENT_METHOD_NOT_FOUND]: 'customer payment method not found',
    [ERROR_CODES.PAYMENT_METHOD_NOT_FOUND]: 'Payment method not found',
    [ERROR_CODES.PAYMENT_METHOD_LIMIT_REACHED]: 'You have reached the maximum number of saved payment methods',
    [ERROR_CODES.USER_NOT_FOUND]: 'user not found',
    [ERROR_CODES.USER_INVALID_PASSWORD]: 'user invalid password',
    [ERROR_CODES.ACCOUNT_CLOSURE_ROLE_NOT_ELIGIBLE]:
        'Only a customer-only account can be closed here. Close your other roles first.',
    [ERROR_CODES.ACCOUNT_CLOSURE_ORDERS_IN_FLIGHT]:
        'You have orders still in progress. They have to finish before this account can be closed.',
    [ERROR_CODES.CONTACT_CHANGE_SAME_IDENTIFIER]: 'That is already the address on your account',
    [ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN]: 'That address is already in use on another account',
    [ERROR_CODES.CONTACT_CHANGE_NOT_PENDING]: 'There is no change waiting to be confirmed',
    [ERROR_CODES.CONTACT_CHANGE_EXPIRED]: 'That change request has expired — start again',
    [ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID]: 'That confirmation link is not valid',
    [ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN]:
        'That number has not been confirmed yet. Confirm it with the code we send to it on WhatsApp',
    [ERROR_CODES.STORE_NOT_FOUND]: 'store not found',
    [ERROR_CODES.STORE_SLUG_TAKEN]: 'store slug taken',
    [ERROR_CODES.VENDOR_NOTIFICATION_NOT_FOUND]: 'vendor notification not found',
    [ERROR_CODES.ORDER_CART_EMPTY]: 'order cart empty',
    [ERROR_CODES.ORDER_CART_INVALID]: 'order cart invalid',
    [ERROR_CODES.ORDER_DELIVERY_ADDRESS_REQUIRED]: 'A delivery address is required for physical orders',
    [ERROR_CODES.ORDER_PRODUCT_NOT_FOUND]: 'order product not found',
    [ERROR_CODES.ORDER_VENDOR_NOT_FOUND]: 'order vendor not found',
    [ERROR_CODES.ORDER_NO_DELIVERY_AGENCY]: 'order no delivery agency',
    [ERROR_CODES.CART_VARIANT_REQUIRED]: 'cart variant required',
    [ERROR_CODES.CART_PRODUCT_NOT_FOUND]: 'cart product not found',
    [ERROR_CODES.CART_SERVICE_PRODUCT_NOT_ALLOWED]: 'cart service product not allowed',
    [ERROR_CODES.CART_VARIANT_NOT_FOUND]: 'cart variant not found',
    [ERROR_CODES.CART_VARIANT_PRODUCT_MISMATCH]: 'cart variant product mismatch',
    [ERROR_CODES.CART_DIGITAL_QUANTITY_MUST_BE_ONE]: 'cart digital quantity must be one',
    [ERROR_CODES.CART_MIXED_PRODUCT_TYPES]: 'cart mixed product types',
    [ERROR_CODES.CART_DIGITAL_LIMIT_REACHED]: 'cart digital limit reached',
    [ERROR_CODES.CART_NOT_FOUND]: 'cart not found',
    [ERROR_CODES.CART_EMPTY_CHECKOUT]: 'cart empty checkout',
    [ERROR_CODES.CART_ITEM_NOT_FOUND]: 'cart item not found',
    [ERROR_CODES.BOOKING_PRODUCT_NOT_FOUND]: 'booking product not found',
    [ERROR_CODES.BOOKING_USER_NOT_FOUND]: 'booking user not found',
    [ERROR_CODES.BOOKING_UNAUTHORIZED]: 'booking unauthorized',
    [ERROR_CODES.BOOKING_ALREADY_CANCELLED]: 'booking already cancelled',
    [ERROR_CODES.BOOKING_CALENDAR_SYNC_FAILED]: 'booking calendar sync failed',
    [ERROR_CODES.BOOKING_PAYMENT_NOT_REQUIRED]: 'booking payment not required',
    [ERROR_CODES.BOOKING_ALREADY_PAID]: 'booking already paid',
    [ERROR_CODES.BOOKING_INVALID_PAYMENT_METHOD]: 'booking invalid payment method',
    [ERROR_CODES.BOOKING_TERMINAL_STATE]: 'booking terminal state',
    [ERROR_CODES.BOOKING_SLOT_NOT_LOCKED]: 'booking slot not locked',
    [ERROR_CODES.BOOKING_SLOT_LOCKED]: 'booking slot is held by another customer',
    [ERROR_CODES.BOOKING_FORBIDDEN]: 'booking forbidden',
    [ERROR_CODES.BOOKING_INVALID_SLOT_ID]: 'booking invalid slot id',
    [ERROR_CODES.ADMIN_NOT_FOUND]: 'admin not found',
    [ERROR_CODES.ADMIN_FORBIDDEN]: 'admin forbidden',
    [ERROR_CODES.AUTH_OAUTH_STATE_INVALID]: 'auth oauth state invalid',
    [ERROR_CODES.AUTH_OAUTH_STATE_EXPIRED]: 'auth oauth state expired',
    [ERROR_CODES.STORAGE_FILE_NOT_FOUND]: 'storage file not found',
    [ERROR_CODES.STORAGE_DELETE_FAILED]: 'storage delete failed',
    [ERROR_CODES.STORAGE_DOWNLOAD_NOT_SUPPORTED]:
        'This deployment’s storage provider cannot serve file contents',
    [ERROR_CODES.CATALOG_DIGITAL_ASSET_ACCESS_DENIED]: 'catalog digital asset access denied',
    [ERROR_CODES.CATALOG_SHIPPING_NOT_FOUND]: 'catalog shipping not found',
    [ERROR_CODES.CATALOG_SHIPPING_ACCESS_DENIED]: 'catalog shipping access denied',
    [ERROR_CODES.COMMAND_ALREADY_REGISTERED]: 'command already registered',
    [ERROR_CODES.COMMAND_NOT_FOUND]: 'command not found',
    [ERROR_CODES.WHATSAPP_INVALID_PAYLOAD]: 'whatsapp invalid payload',
    [ERROR_CODES.WHATSAPP_POLICY_VIOLATION]: 'whatsapp policy violation',
    [ERROR_CODES.WHATSAPP_PROVIDER_REJECTED]: 'whatsapp provider rejected',
    [ERROR_CODES.WHATSAPP_VALIDATION_ERROR]: 'whatsapp validation error',
    [ERROR_CODES.WHATSAPP_IDEMPOTENCY_REQUIRED]: 'whatsapp idempotency required',
    [ERROR_CODES.WHATSAPP_DUPLICATE_MESSAGE]: 'whatsapp duplicate message',
    [ERROR_CODES.WHATSAPP_UNSUPPORTED_MESSAGE_TYPE]: 'whatsapp unsupported message type',
    [ERROR_CODES.DIGITAL_ASSET_NOT_FOUND]: 'digital asset not found',
    [ERROR_CODES.DIGITAL_ASSET_ACCESS_DENIED]: 'digital asset access denied',
    [ERROR_CODES.DIGITAL_ASSET_IN_USE]: 'digital asset in use',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_MISSING]: 'digital entitlement config missing',
    [ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_INACTIVE]: 'digital entitlement config inactive',

    // Blog. The first three are reachable by a logged-out visitor, so they read as
    // explanations rather than as code identifiers.
    [ERROR_CODES.BLOG_ARTICLE_NOT_FOUND]: 'No published article at this address',
    [ERROR_CODES.BLOG_ARTICLE_MOVED]: 'This article has moved to a new address',
    [ERROR_CODES.BLOG_ARTICLE_GONE]: 'This article is no longer published',
    [ERROR_CODES.BLOG_ARTICLE_KEY_TAKEN]: 'An article already uses this id',
    [ERROR_CODES.BLOG_ARTICLE_NOT_PUBLISHABLE]: 'This article is not ready to be published',
    [ERROR_CODES.BLOG_ARTICLE_ALREADY_PUBLISHED]: 'This article is already published',
    [ERROR_CODES.BLOG_ARTICLE_DELETE_NOT_ALLOWED]:
      'This article has been published — archive it instead, so its URL can answer 410 rather than 404',
    [ERROR_CODES.BLOG_SLUG_TAKEN]: 'Another article already uses this slug in this language',
    [ERROR_CODES.BLOG_SLUG_RESERVED]: 'This slug would collide with a blog route',
    [ERROR_CODES.BLOG_AUTHOR_NOT_FOUND]: 'Author not found',
    [ERROR_CODES.BLOG_AUTHOR_KEY_TAKEN]: 'An author already uses this id',
    [ERROR_CODES.BLOG_AUTHOR_IN_USE]: 'This author is credited on one or more articles',

    // Reviews. Written for the person holding the form, because two of them are the
    // only explanation a shopper ever gets for a refused review — and "not eligible"
    // on its own reads as a bug rather than as the verified-purchase rule working.
    [ERROR_CODES.REVIEW_NOT_FOUND]: 'Review not found',
    [ERROR_CODES.REVIEW_ALREADY_EXISTS]: 'You have already reviewed this',
    [ERROR_CODES.REVIEW_NOT_ELIGIBLE]:
      'Only a completed purchase or a completed delivery can be reviewed, and only by the person it belonged to',
    [ERROR_CODES.REVIEW_SUBJECT_NOT_FOUND]: 'There is nothing to review at this reference',
    [ERROR_CODES.REVIEW_SUBJECT_NOT_REVIEWABLE]: 'This cannot be reviewed yet',
    [ERROR_CODES.REVIEW_NOT_PENDING]: 'This review has already been moderated',
    [ERROR_CODES.REVIEW_ROLE_NOT_ALLOWED]: 'Your account type cannot review this',

    // ── System operations (Phase 14) ──────────────────────────────────────────
    // The maintenance message is the one default here written for a CUSTOMER rather than an
    // operator — it is what a shopper sees mid-checkout. The operator's own reason is carried
    // in `details.reason` and overrides this when set.
    [ERROR_CODES.SYSTEM_MAINTENANCE_ACTIVE]:
      'The platform is temporarily unavailable for maintenance. Please try again shortly.',
    [ERROR_CODES.SYSTEM_MAINTENANCE_REASON_REQUIRED]:
      'A reason is required to open a maintenance window — it is shown to callers and recorded in the audit trail',
    [ERROR_CODES.DEV_TOOLS_CACHE_DB_UNKNOWN]: 'No cache database by that name',
    [ERROR_CODES.DEV_TOOLS_CACHE_FLUSH_REFUSED]: 'That cache flush is not permitted',
    [ERROR_CODES.DEV_TOOLS_CACHE_UNAVAILABLE]: 'The cache is not reachable from this process',

    // ── Request-level and rate limiting (Phase 16) ────────────────────────────
    // Each of the three request-body messages names the remedy, because they are the three
    // DIFFERENT things a caller has to do about it: fix the JSON, send less, send a
    // different Content-Type.
    [ERROR_CODES.REQUEST_BODY_INVALID]: 'The request body could not be read as JSON',
    [ERROR_CODES.REQUEST_BODY_TOO_LARGE]: 'The request body is too large',
    [ERROR_CODES.REQUEST_MEDIA_TYPE_UNSUPPORTED]:
      'Unsupported content type — send application/json; charset=utf-8',
    [ERROR_CODES.RATE_LIMIT_EXCEEDED]: 'Too many requests — please wait a moment and try again',
});

/**
 * createAppError — primary factory for throwing domain errors.
 *
 * Use this in services and middleware instead of `throw new Error(...)`.
 *
 * `isOperational` is deliberately NOT passed: the constructor derives it from the status.
 * This factory used to hardcode `true`, which made every 500 it produced look like an
 * expected business outcome in the logs.
 *
 * @example
 *   throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);
 *   throw createAppError(ERROR_CODES.PAYMENT_ORDER_NOT_FOUND, 404, undefined, { orderId });
 */
export function createAppError(
  code: ErrorCode,
  statusCode: number,
  message?: string,
  details?: Record<string, unknown>
): AppError {
  const resolvedMessage = message ?? DEFAULT_ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
  return new AppError(resolvedMessage, statusCode, code, undefined, details);
}

// ─── Retained Subclasses (non-standard constructors) ──────────────────────────

/**
 * BulkValidationError: carries per-row error details.
 */
export class BulkValidationError extends AppError {
  constructor(
    message: string,
    public readonly rowErrors: Array<{ row: number; error: string }>
  ) {
    super(message, 400, ERROR_CODES.CATALOG_BULK_VALIDATION_FAILED, true, { rowErrors });
  }
}

/**
 * UnsupportedTimezoneError: embeds the invalid timezone in the message.
 */
export class UnsupportedTimezoneError extends AppError {
  constructor(timezone: string) {
    super(
      `Timezone '${timezone}' is not supported`,
      400,
      ERROR_CODES.ANALYTICS_UNSUPPORTED_TIMEZONE,
      true,
      { timezone }
    );
  }
}

/**
 * BulkLimitExceededError: carries the limit value.
 */
export class BulkLimitExceededError extends AppError {
  constructor(limit: number = 1000) {
    super(
      `Bulk update limited to ${limit} rows`,
      400,
      ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED,
      true,
      { limit }
    );
  }
}

/**
 * DateRangeExceededError: carries the max allowed days.
 */
export class DateRangeExceededError extends AppError {
  constructor(maxDays: number = 365) {
    super(
      `Date range cannot exceed ${maxDays} days`,
      400,
      ERROR_CODES.ANALYTICS_DATE_RANGE_EXCEEDED,
      true,
      { maxDays }
    );
  }
}
