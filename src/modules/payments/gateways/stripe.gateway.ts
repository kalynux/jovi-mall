import Stripe from 'stripe';
import {
  PaymentGateway,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  RefundPayload,
  RefundResult,
  PaymentGatewayStatus
} from './gateway.interface';
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
      const { amount } = toStripeCharge(payload.amount, payload.metadata?.currency ?? 'xaf');

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
