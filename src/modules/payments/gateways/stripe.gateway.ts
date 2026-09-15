import Stripe from 'stripe';
import {
  PaymentGateway,
  PaymentGatewayName,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  RefundPayload,
  RefundResult,
  PaymentGatewayStatus,
  WebhookVerifyInput
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  headerValue
} from '../domain/webhook-verification';
import { getStripeClient, toStripeCharge, fromMinorUnit } from './stripe.client';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * StripeGateway - Card Payment Gateway
 *
 * Stripe Payment Intents API for card payments.
 *
 * ADAPTER PATTERN:
 * - No business logic
 * - Pure Stripe API wrapper
 * - Normalizes Stripe responses to the standard PaymentGateway interface
 *
 * CURRENCY:
 * The catalog is priced in XAF, but the WiMall Stripe account settles in USD.
 * `toStripeCharge` converts the incoming amount to the account's presentment
 * currency (USD) at a fixed configured rate before charging. The same helper is
 * used for refunds so amounts stay consistent.
 *
 * FLOW:
 * 1. Create PaymentIntent (returns client_secret)
 * 2. Frontend confirms payment with Stripe.js / Payment Element
 * 3. Webhook notifies backend of status change
 * 4. Backend verifies payment status
 *
 * API DOCS: https://stripe.com/docs/payments/payment-intents
 */
export class StripeGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'STRIPE';

  /**
   * Initiate card payment (create PaymentIntent).
   */
  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    // Reachability for `/system/integrations`. Stripe is `never` probed — a health check is an
    // authenticated call against a live merchant account, consuming rate limit and appearing in
    // the gateway's own logs — so a real checkout is the only honest signal.
    const observedAt = Date.now();

    try {
      const stripe = getStripeClient();
      const { amount, currency } = toStripeCharge(payload.amount, payload.currency);

      // Stable idempotency key so retries (or double submits) reuse the same intent.
      const idempotencyKey =
        payload.metadata?.purchaseId ||
        payload.metadata?.topupId ||
        `order_${payload.orderId}`;

      const intent = await stripe.paymentIntents.create(
        {
          amount,
          currency,
          description: `Order #${payload.orderId}`,
          receipt_email: payload.channel.customerEmail,
          automatic_payment_methods: { enabled: true },
          metadata: {
            orderId: payload.orderId,
            userId: payload.userId,
            source_amount: String(payload.amount),
            source_currency: (payload.currency || '').toLowerCase(),
            ...(payload.metadata ?? {}),
          },
        },
        { idempotencyKey: `pi_${idempotencyKey}` }
      );

      recordIntegrationCall('stripe', observedAt);
      const status = this.normalizeStripeStatus(intent.status);

      return {
        success: true,
        gatewayRef: intent.id,
        status,
        instructions: {
          clientSecret: intent.client_secret ?? undefined,
          // Charged amount in the presentment currency, so the frontend can show dollars.
          chargedAmount: fromMinorUnit(intent.amount, intent.currency),
          chargedCurrency: intent.currency,
          message: `Complete payment of ${fromMinorUnit(intent.amount, intent.currency)} ${intent.currency.toUpperCase()} with card`,
        },
        rawResponse: {
          ...intent,
          chargedAmount: fromMinorUnit(intent.amount, intent.currency),
          chargedCurrency: intent.currency,
        },
      };
    } catch (error: any) {
      recordIntegrationCall('stripe', observedAt, error);
      return this.toFailure(error, 'initiatePayment');
    }
  }

  /**
   * Verify payment status (retrieve PaymentIntent).
   */
  async verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult> {
    try {
      const stripe = getStripeClient();
      const intent = await stripe.paymentIntents.retrieve(payload.gatewayRef);
      const status = this.normalizeStripeStatus(intent.status);

      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: {
          paymentIntentId: intent.id,
          amount: fromMinorUnit(intent.amount, intent.currency),
          currency: intent.currency,
          latestCharge: intent.latest_charge,
        },
        rawResponse: intent,
      };
    } catch (error: any) {
      console.error('[StripeGateway] Verify payment error:', error?.message ?? error);
      return {
        success: false,
        status: 'FAILED',
        error: error?.message || 'Verification failed',
        rawResponse: { error: error?.message },
      };
    }
  }

  /**
   * Refund a payment (full or partial). The XAF amount is converted to the
   * presentment currency with the same fixed rate used at charge time.
   */
  async refundPayment(payload: RefundPayload): Promise<RefundResult> {
    try {
      const stripe = getStripeClient();
      // `payload.currency` is now a required field on RefundPayload. It used to
      // be absent and this line read `payload.metadata?.currency ?? 'xaf'` — a
      // default that is right for this platform today and silently wrong the
      // first time anything else is charged, in the one operation where being
      // wrong means refunding the incorrect amount.
      const { amount } = toStripeCharge(payload.amount, payload.currency);

      const refund = await stripe.refunds.create(
        {
          payment_intent: payload.gatewayRef,
          amount,
          reason: this.normalizeRefundReason(payload.reason),
          metadata: payload.metadata as Stripe.MetadataParam | undefined,
        },
        { idempotencyKey: `re_${payload.gatewayRef}_${amount}` }
      );

      return {
        success: refund.status === 'succeeded' || refund.status === 'pending',
        refundRef: refund.id,
        rawResponse: refund,
      };
    } catch (error: any) {
      console.error('[StripeGateway] Refund error:', error?.message ?? error);
      return {
        success: false,
        error: error?.message || 'Refund failed',
        rawResponse: { error: error?.message },
      };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Verify a Stripe webhook.
   *
   * This is the behaviour that already lived inline in `webhook.routes.ts:26-51`
   * and it is unchanged — `constructEvent` against the raw bytes, with a 400 on
   * a missing secret or a missing header. It moved onto the gateway so the
   * three routes share one policy rather than one route having a policy and the
   * other two having none.
   */
  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return { ok: false, reason: 'missing_secret' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }

    const signature = headerValue(input.headers, ['stripe-signature']);
    if (!signature) return { ok: false, reason: 'missing_signature' };

    try {
      const event = getStripeClient().webhooks.constructEvent(input.rawBody, signature, secret);
      return {
        ok: true,
        payload: event as unknown as Record<string, unknown>,
        rawBody: input.rawBody,
      };
    } catch (error: any) {
      return { ok: false, reason: 'bad_signature', detail: error?.message };
    }
  }

  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    const event = payload as unknown as Stripe.Event;
    const object = event.data?.object as
      | { id?: string; amount?: number; currency?: string; metadata?: Record<string, string> }
      | undefined;

    const gatewayRef = String(object?.id ?? event.id ?? '');
    if (!gatewayRef) return null;

    // Only the three PaymentIntent outcomes are mapped. Everything else maps to
    // PENDING and the orchestrator leaves the transaction alone — the previous
    // code defaulted every unrelated event to PENDING and WROTE it, so an
    // unrelated `charge.updated` could walk a SUCCEEDED transaction backwards.
    const statusByType: Record<string, PaymentGatewayStatus> = {
      'payment_intent.succeeded': 'SUCCEEDED',
      'payment_intent.payment_failed': 'FAILED',
      'payment_intent.canceled': 'CANCELLED',
    };

    // The cross-check compares against our own `amountSnapshot`, which is XAF —
    // but `object.amount` is in the PRESENTMENT currency (USD), converted at
    // charge time. Reporting the Stripe figure here would make every card
    // payment look like a mismatch. `source_amount`/`source_currency` are
    // stamped into the intent's metadata at creation for exactly this reason.
    const sourceAmount = object?.metadata?.source_amount;
    const sourceCurrency = object?.metadata?.source_currency;

    return {
      // Stripe mints a real event id, stable across redeliveries — the ideal
      // dedup key, and the reason its own docs tell integrators to key on it.
      eventId: event.id,
      // Collection-only integration: Stripe payouts/transfers are not wired here.
      direction: 'collection' as const,
      eventType: event.type,
      gatewayRef,
      merchantRef: object?.metadata?.merchantRef ?? null,
      status: statusByType[event.type] ?? 'PENDING',
      amount: sourceAmount !== undefined ? Number(sourceAmount) : null,
      currency: sourceCurrency ?? null,
      raw: payload,
    };
  }

  /**
   * Normalize Stripe PaymentIntent status to the standard gateway status.
   */
  private normalizeStripeStatus(stripeStatus: string): PaymentGatewayStatus {
    const statusMap: Record<string, PaymentGatewayStatus> = {
      requires_payment_method: 'INITIATED',
      requires_confirmation: 'INITIATED',
      requires_action: 'PENDING',
      processing: 'PENDING',
      requires_capture: 'PENDING', // manual capture
      succeeded: 'SUCCEEDED',
      canceled: 'CANCELLED',
    };

    return statusMap[stripeStatus] || 'FAILED';
  }

  private normalizeRefundReason(
    reason?: string
  ): Stripe.RefundCreateParams.Reason | undefined {
    if (reason === 'duplicate' || reason === 'fraudulent' || reason === 'requested_by_customer') {
      return reason;
    }
    return reason ? 'requested_by_customer' : undefined;
  }

  /**
   * Map a thrown Stripe error to the normalized failure result. Card declines
   * are surfaced distinctly so callers can map them to PAYMENT_CARD_DECLINED.
   */
  private toFailure(error: any, op: string): PaymentInitResult {
    const isCardError = error?.type === 'StripeCardError' || error instanceof Stripe.errors.StripeCardError;
    console.error(`[StripeGateway] ${op} error:`, error?.message ?? error);

    return {
      success: false,
      gatewayRef: '',
      status: 'FAILED',
      error: isCardError ? `card_declined: ${error.message}` : error?.message || 'Gateway communication error',
      rawResponse: { error: error?.message, code: error?.code, declineCode: error?.decline_code },
    };
  }
}
