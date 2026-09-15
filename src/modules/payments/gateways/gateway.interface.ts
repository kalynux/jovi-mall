// Type-only, on both sides: `webhook-verification.ts` imports `PaymentGatewayStatus`
// back from here. `import type` guarantees both are erased, so the cycle never
// exists at runtime.
import type { WebhookVerification, NormalizedWebhookEvent } from '../domain/webhook-verification';

/**
 * Payment Gateway Interface
 *
 * Gateway-agnostic abstraction for payment processing.
 * All gateways (NotchPay, MyCoolPay, Stripe) implement this interface.
 * 
 * DESIGN PRINCIPLES:
 * - Pure adapter pattern (no business logic in implementations)
 * - Normalized responses (orchestrator handles all differences)
 * - Stateless (all state in PaymentTransaction model)
 */

export interface PaymentInitPayload {
  orderId: string;
  userId: string;
  amount: number;
  currency: string;
  channel: PaymentChannelInfo;
  /**
   * OUR reference, minted per attempt and echoed back by the gateway on its
   * callback (NotchPay `reference`, My-CoolPay `app_transaction_ref`).
   *
   * Required, not optional, so the compiler finds every construction site. It
   * replaced `metadata.idempotencyKey`, which the gateways used to send: that
   * value is `sha256(orderId:userId:amount)` and all three inputs are
   * knowable, so it was never safe as a gateway-facing identifier. See
   * `domain/merchant-reference.ts`.
   */
  merchantRef: string;
  metadata?: Record<string, any>;
}

export interface PaymentChannelInfo {
  // For mobile money (NotchPay, MyCoolPay)
  phoneNumber?: string;
  phoneOperator?: 'MTN' | 'ORANGE' | 'MOOV';
  
  // For card (Stripe)
  cardToken?: string;
  
  // Common
  customerEmail?: string;
  customerName?: string;
}

export interface PaymentInitResult {
  success: boolean;
  gatewayRef: string;           // Gateway's transaction reference
  status: PaymentGatewayStatus; // Normalized status
  instructions?: PaymentInstructions;
  error?: string;
  rawResponse: any;             // Original gateway response
}

export interface PaymentInstructions {
  // For mobile money
  ussdCode?: string;            // e.g., "*126#"
  message?: string;             // User instructions
  /**
   * The customer must submit a one-time code before the charge proceeds.
   *
   * My-CoolPay answers `action: "REQUIRE_OTP"` for Orange Money: the operator
   * SMSes a code and nothing happens until it is relayed back. Without this
   * flag the client renders "dial the USSD code" over a payment that will
   * never move, so it is not cosmetic — it selects a different screen.
   *
   * The code goes to `POST /api/payments/:transactionId/authorize`.
   */
  requiresOtp?: boolean;

  // For card (Stripe)
  clientSecret?: string;        // For frontend confirmation
  chargedAmount?: number;       // Amount actually charged, in chargedCurrency (e.g. USD)
  chargedCurrency?: string;     // Presentment currency Stripe charges in (e.g. "usd")

  // Common
  expiresAt?: Date;             // Payment session expiry
}

export interface PaymentVerifyPayload {
  gatewayRef: string;
  metadata?: Record<string, any>;
}

export interface PaymentVerifyResult {
  success: boolean;
  status: PaymentGatewayStatus;
  transactionDetails?: any;
  error?: string;
  rawResponse: any;
}

export interface RefundPayload {
  gatewayRef: string;
  amount: number;
  /**
   * The currency the original charge was recorded in.
   *
   * Required. It used to be absent, and Stripe compensated by reading
   * `payload.metadata?.currency ?? 'xaf'` — a default that is correct for this
   * platform today and silently wrong the moment anything else is charged, in
   * the one operation where being wrong means refunding the incorrect amount.
   */
  currency: string;
  reason?: string;
  metadata?: Record<string, any>;
}

/** Payload for the mobile-money OTP step (My-CoolPay `payin/authorize`). */
export interface PaymentAuthorizePayload {
  gatewayRef: string;
  code: string;
}

export interface PaymentAuthorizeResult {
  success: boolean;
  status: PaymentGatewayStatus;
  instructions?: PaymentInstructions;
  error?: string;
  rawResponse: any;
}

export interface RefundResult {
  success: boolean;
  refundRef?: string;
  /**
   * The provider will not refund through its API **as a matter of policy**, not
   * because the call failed.
   *
   * Distinct from `success: false`, and the distinction decides where the money
   * goes. A failure is a fault — retryable, worth a 502, worth an alert. This
   * is an answer: the refund has to be made by hand, and the platform already
   * has a path for that (`refund_pending` + earnings reversal + a HIGH support
   * ticket). Mapping it to a generic failure sends an operator looking for an
   * outage that is not happening, and `VendorRefundService` — which has no
   * fallback at all — would surface a 502 to a vendor instead of the documented
   * outcome.
   *
   * Set by NotchPay when `POST /refunds` answers 403: the endpoint exists and
   * authenticates (its `GET` is 200), but refund CREATION is forbidden on the
   * account. Verified against the live sandbox, 2026-08-18.
   */
  unsupported?: boolean;
  error?: string;
  rawResponse: any;
}

/**
 * Gateway-normalized status
 * Maps to PaymentTransaction.status
 */
export type PaymentGatewayStatus = 
  | 'INITIATED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * PaymentGateway Interface
 *
 * All payment gateways must implement this interface.
 *
 * ── WHAT IS REQUIRED AND WHAT IS OPTIONAL, AND WHY ───────────────────────────
 * `verifyWebhook` and `parseWebhookEvent` are **required**. They were added
 * because the interface had no seat for webhook verification at all, so the
 * only implementation lived inside the Stripe route handler and the other two
 * gateways simply had none — their routes read a signature header into a
 * variable and passed it to a method that never referenced the argument.
 *
 * Required rather than optional is the load-bearing part: `test:payments`
 * enumerates the gateway registry and asserts every member implements both, so
 * a fourth gateway cannot be added without a signature check. Optional, and
 * that test could only ever assert what already exists.
 *
 * `refundPayment` and `authorizePayment` stay optional because a provider
 * genuinely may not offer them — and the ABSENCE is the contract. My-CoolPay
 * has no refund endpoint, so `MyCoolPayGateway` does not define the method and
 * the orchestrator's `typeof … !== 'function'` guard raises
 * `REFUND_GATEWAY_NOT_SUPPORTED`. Defining a method that always fails would
 * make that guard dead and turn a knowable "no" into a runtime error.
 */
/**
 * What a gateway needs in order to SEND money.
 *
 * Deliberately not a mirror of `PaymentInitPayload`: a collection is pulled from a customer
 * we are talking to, a payout is pushed to a beneficiary who is not present. There is no
 * order, no session and no OTP — only a destination and an amount.
 */
export interface PayoutPayload {
  /**
   * Our merchant reference, and the idempotency key for the whole operation.
   *
   * ⛔ **On a retry this MUST be the reference the previous attempt used.** It is what lets
   * the provider recognise a resend of a transfer that actually succeeded and refuse to send
   * it twice. The caller reads it off the payout row; a gateway must never mint its own.
   */
  reference: string;
  amount: number;
  currency: string;
  /** The beneficiary mobile number, as stored on the payout destination snapshot. */
  phone: string;
  /** The beneficiary name, for the provider record and their statement. */
  name: string;
  description?: string;
}

/**
 * The outcome of asking a gateway to send money.
 *
 * ⚠ `success: true` means ACCEPTED, not settled. Every mobile-money transfer is asynchronous;
 * the terminal answer arrives on a callback. A caller that treats acceptance as payment has
 * recorded money as delivered that may still fail.
 */
export interface PayoutResult {
  success: boolean;
  /** The provider transfer id, when one was issued. Null when the call never got that far. */
  gatewayRef: string | null;
  status: PaymentGatewayStatus;
  /** Provider-supplied explanation, on a refusal. */
  message?: string;
  /**
   * The provider or our account cannot do this at all — a knowable no rather than a fault.
   * Same distinction `refundAvailable` draws, reported per call because the commonest cause
   * (an unregistered egress IP) is invisible until a transfer is actually attempted.
   */
  unsupported?: boolean;
  raw?: unknown;
}

/** What a gateway reports about the float it can pay out of. */
export interface PayoutBalance {
  available: number;
  currency: string;
}

export interface PaymentGateway {
  /** Stable identifier, used for logging and for the registry's own assertions. */
  readonly name: PaymentGatewayName;

  /**
   * Initiate a new payment
   * @param payload - Payment initiation data
   * @returns Normalized payment initiation result
   */
  initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult>;

  /**
   * Verify payment status
   * @param payload - Verification data
   * @returns Normalized payment verification result
   */
  verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult>;

  /**
   * Authenticate an inbound webhook against the RAW request bytes.
   *
   * Must never throw and must never fall back to "accept when unconfigured" —
   * an unconfigured gateway returns `missing_secret` and its callback is
   * refused. Skipping verification when a secret is absent is precisely the
   * shape of the bug this replaced.
   */
  verifyWebhook(input: WebhookVerifyInput): WebhookVerification;

  /**
   * Reduce a verified callback to the fields the orchestrator acts on.
   *
   * Only ever called with an `ok: true` verification, so it may assume the
   * payload is authentic — but not that it is well-formed. Returns null when
   * the body is authentic and still not something we can act on (an event type
   * we do not handle, a missing reference).
   */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null;

  /**
   * Refund a payment. **Absent when the provider has no refund API** — see the
   * header above; do not add a stub.
   */
  refundPayment?(payload: RefundPayload): Promise<RefundResult>;

  /**
   * Is refunding available **on our account**, as opposed to available in the
   * provider's API at all?
   *
   * Two different questions, and conflating them puts a button in front of an
   * operator that cannot work. NotchPay is the case that forced the split:
   * `/refunds` exists and reads fine with our keys, but creation answers 403 —
   * refunds are not enabled on the merchant account. The method's PRESENCE is a
   * capability of the integration; this is a fact about the account, and it
   * moves without a deploy.
   *
   * Absent means "yes" — a gateway that implements `refundPayment` and says
   * nothing more is assumed refundable, which keeps Stripe unaffected.
   */
  refundAvailable?(): boolean;

  /**
   * Submit a one-time code for a charge that reported `requiresOtp`. Absent on
   * gateways whose flow has no OTP step.
   */
  authorizePayment?(payload: PaymentAuthorizePayload): Promise<PaymentAuthorizeResult>;

  /**
   * Send money to a beneficiary. **Absent when the provider has no disbursement API, or when
   * we have deliberately not wired the one it has** — see the header above; do not add a
   * stub that always fails, because the absence is what `gatewaySupportsPayout` reads.
   */
  createPayout?(payload: PayoutPayload): Promise<PayoutResult>;

  /**
   * Is sending available **on our account**, as opposed to implemented here?
   *
   * The same split `refundAvailable` draws, and it matters more on this side: a disbursement
   * API typically also requires the caller IP to be registered with the provider, which is
   * configuration living nowhere in this repository and changing without a deploy.
   *
   * Absent means "yes" for any gateway that implements `createPayout`.
   */
  payoutAvailable?(): boolean;

  /** The float this gateway can pay out of, when it can report one. */
  payoutBalance?(currency: string): Promise<PayoutBalance | null>;
}

/** Input to `verifyWebhook`: the untouched bytes plus the request headers. */
export interface WebhookVerifyInput {
  rawBody: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** Remote address, for the one provider that publishes a fixed callback IP. */
  sourceIp?: string | null;
}

export type PaymentGatewayName = 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE';
