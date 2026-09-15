import {
  PaymentGateway,
  PaymentGatewayName,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  PaymentAuthorizePayload,
  PaymentAuthorizeResult,
  PaymentGatewayStatus,
  WebhookVerifyInput,
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  myCoolPaySignature,
  timingSafeEqualString,
  parseRawJson,
  deriveEventId,
} from '../domain/webhook-verification';
import { MYCOOLPAY_CONFIG } from '../config/payments.config';
import { isZeroDecimalCurrency } from '../domain/money';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * MyCoolPayGateway — mobile money (MTN / Orange Cameroon).
 *
 * API: https://documenter.getpostman.com/view/17178321/UV5ZCx8f
 * Base: `https://my-coolpay.com/api/{public_key}` — the public key is in the
 * PATH, not a header, which is why `MYCOOLPAY_BASE_URL` stops one segment short
 * of where a base URL usually stops.
 *
 * ── THERE IS NO REFUND METHOD ON THIS CLASS, AND THAT IS THE CONTRACT ────────
 * My-CoolPay's API is `paylink · payin · payin/authorize · payout ·
 * checkStatus · balance`. It has no refund endpoint — verified against both the
 * API documentation and the public surface of their official PHP SDK.
 *
 * So `refundPayment` is **absent**, not a stub that throws. The orchestrator
 * asks `typeof gateway.refundPayment !== 'function'` and raises
 * `REFUND_GATEWAY_NOT_SUPPORTED`, which `BookingRefundService` already handles
 * as an expected outcome (`refund_pending` + earnings reversal + a HIGH support
 * ticket) and which `AdminRefundService` reports up front so the button is
 * never offered. Defining a method that always fails would make that guard dead
 * code and turn a knowable "no" into a runtime failure discovered after the
 * operator pressed the button.
 *
 * `payout` could in principle push money back to the customer's phone, but it
 * is a disbursement rather than a refund — the gateway fee is not returned and
 * nothing links it to the original charge — and it requires our server IPs to
 * be pre-authorised. That is a product decision, deliberately not smuggled in
 * here.
 */
export class MyCoolPayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'MYCOOLPAY';

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      // No operator is sent: My-CoolPay resolves the network from the number
      // itself. The asymmetry with NotchPay (which requires an explicit
      // channel) is real and is not worth hiding behind a common shape.
      const response = await this.call('/payin', 'POST', {
        transaction_amount: payload.amount,
        transaction_currency: payload.currency.toUpperCase(),
        transaction_reason: `Order #${payload.orderId}`,
        app_transaction_ref: payload.merchantRef,
        customer_phone_number: payload.channel.phoneNumber,
        customer_name: payload.channel.customerName,
        customer_email: payload.channel.customerEmail,
      });

      const gatewayRef: string | undefined = response?.transaction_ref;
      if (response?.status !== 'success' || !gatewayRef) {
        return {
          success: false,
          gatewayRef: gatewayRef ?? '',
          status: 'FAILED',
          error: response?.message || 'My-CoolPay refused the charge',
          rawResponse: response,
        };
      }

      const action = String(response?.action ?? '').toUpperCase();

      // REQUIRE_OTP is a real branch, not a variant of PENDING: the operator
      // SMSes a code and NOTHING happens until it is relayed back through
      // `authorizePayment`. Rendering "dial the USSD code" here would show the
      // customer a prompt that never arrives.
      if (action === 'REQUIRE_OTP') {
        return {
          success: true,
          gatewayRef,
          status: 'PENDING',
          instructions: {
            requiresOtp: true,
            message:
              'Enter the confirmation code sent to your phone by SMS to complete this payment.',
          },
          rawResponse: response,
        };
      }

      return {
        success: true,
        gatewayRef,
        status: 'PENDING',
        instructions: {
          ussdCode: response?.ussd,
          message: 'Confirm the payment prompt on your phone to complete this payment.',
        },
        rawResponse: response,
      };
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      console.error('[MyCoolPayGateway] initiatePayment error:', error?.message ?? error);
      return {
        success: false,
        gatewayRef: '',
        status: 'FAILED',
        error: error?.message || 'Gateway communication error',
        rawResponse: null,
      };
    }
  }

  async authorizePayment(payload: PaymentAuthorizePayload): Promise<PaymentAuthorizeResult> {
    try {
      const response = await this.call('/payin/authorize', 'POST', {
        transaction_ref: payload.gatewayRef,
        code: payload.code,
      });

      if (response?.status !== 'success') {
        return {
          success: false,
          status: 'PENDING',
          error: response?.message || 'The confirmation code was refused',
          rawResponse: response,
        };
      }

      return {
        success: true,
        status: 'PENDING',
        instructions: {
          ussdCode: response?.ussd,
          message: 'Confirm the payment prompt on your phone to complete this payment.',
        },
        rawResponse: response,
      };
    } catch (error: any) {
      // A 401 from `payin/authorize` means "wrong code" — a business outcome,
      // not an outage — so it is unwrapped into a refusal rather than being
      // allowed to surface as a 502 about the provider.
      if (error instanceof AppError && this.isWrongCode(error)) {
        return {
          success: false,
          status: 'PENDING',
          error: 'The confirmation code was refused',
          rawResponse: error.details ?? null,
        };
      }
      if (error instanceof AppError) throw error;
      console.error('[MyCoolPayGateway] authorizePayment error:', error?.message ?? error);
      return {
        success: false,
        status: 'PENDING',
        error: error?.message || 'Authorization failed',
        rawResponse: null,
      };
    }
  }

  async verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult> {
    try {
      const response = await this.call(
        `/checkStatus/${encodeURIComponent(payload.gatewayRef)}`,
        'GET'
      );
      const status = this.normalizeStatus(response?.transaction_status);
      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: response,
        rawResponse: response,
      };
    } catch (error: any) {
      console.error('[MyCoolPayGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, not FAILED — see the same note on NotchPayGateway.verifyPayment.
      // A verification we could not perform says nothing about the payment, and
      // only a PENDING row is re-read by the reconciliation sweep.
      return {
        success: false,
        status: 'PENDING',
        error: error?.message || 'Verification failed',
        rawResponse: null,
      };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const { PUBLIC_KEY, PRIVATE_KEY } = MYCOOLPAY_CONFIG;
    // The private key IS the callback signer here — there is no separate
    // webhook secret, which is why `MYCOOLPAY_WEBHOOK_SECRET` was documented
    // for a while and read by nothing.
    if (!PUBLIC_KEY || !PRIVATE_KEY) return { ok: false, reason: 'missing_secret' };

    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: Buffer.isBuffer(input.rawBody)
          ? 'body was not JSON'
          : 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const body = parsed.value as Record<string, any>;

    // Off by default: behind a proxy or a tunnel `req.ip` is the hop, not the
    // origin, so enabling this without the matching `trust proxy` hop configured
    // refuses every genuine callback.
    if (MYCOOLPAY_CONFIG.VERIFY_CALLBACK_IP) {
      const source = (input.sourceIp ?? '').replace(/^::ffff:/, '');
      if (source !== MYCOOLPAY_CONFIG.CALLBACK_IP) {
        return { ok: false, reason: 'untrusted_source', detail: source || 'unknown' };
      }
    }

    // `application` is the public key echoed back. Checking it is not
    // redundant with the signature: it is what stops a callback signed for a
    // DIFFERENT My-CoolPay application being replayed at us, and it is one of
    // the three things compensating for the MD5 construction.
    if (String(body.application ?? '') !== PUBLIC_KEY) {
      return { ok: false, reason: 'wrong_application' };
    }

    const presented = typeof body.signature === 'string' ? body.signature.trim() : '';
    if (!presented) return { ok: false, reason: 'missing_signature' };

    const expected = myCoolPaySignature(
      {
        transaction_ref: body.transaction_ref,
        transaction_type: body.transaction_type,
        transaction_amount: body.transaction_amount,
        transaction_currency: body.transaction_currency,
        transaction_operator: body.transaction_operator,
      },
      PRIVATE_KEY
    );
    if (!timingSafeEqualString(presented, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    return { ok: true, payload: parsed.value, rawBody: input.rawBody as Buffer };
  }

  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    const body = payload as Record<string, any>;
    const gatewayRef = String(body.transaction_ref ?? '');
    if (!gatewayRef) return null;

    const status = String(body.transaction_status ?? '');

    return {
      // My-CoolPay mints no event id, so one is derived from the fields that
      // DEFINE the event: this transaction reaching this status. Stable across
      // a redelivery, distinct across PENDING -> SUCCESS. A hash of the whole
      // body would be neither.
      eventId: deriveEventId([gatewayRef, body.transaction_type, status]),
      // Collection-only integration: `payout` exists in their API and is deliberately
      // not wired (see the header), so no callback here can be money leaving.
      direction: 'collection' as const,
      eventType: `${String(body.transaction_type ?? 'PAYIN')}.${status || 'unknown'}`,
      gatewayRef,
      merchantRef: body.app_transaction_ref ? String(body.app_transaction_ref) : null,
      status: this.normalizeStatus(status),
      amount: body.transaction_amount ?? null,
      currency: body.transaction_currency ? String(body.transaction_currency) : null,
      raw: payload,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** One status table for this gateway — initiate, verify and webhook alike. */
  private normalizeStatus(raw: unknown): PaymentGatewayStatus {
    const map: Record<string, PaymentGatewayStatus> = {
      pending: 'PENDING',
      processing: 'PENDING',
      success: 'SUCCEEDED',
      successful: 'SUCCEEDED',
      completed: 'SUCCEEDED',
      failed: 'FAILED',
      error: 'FAILED',
      canceled: 'CANCELLED',
      cancelled: 'CANCELLED',
    };
    const key = String(raw ?? '').toLowerCase();
    // Unknown reads as PENDING, never FAILED: calling a live payment dead
    // strands the customer's money, and only a PENDING row is swept again.
    return map[key] ?? 'PENDING';
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency)) {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `My-CoolPay cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  private isWrongCode(error: AppError): boolean {
    return (
      error.code === ERROR_CODES.MYCOOLPAY_REQUEST_FAILED &&
      (error.details as { status?: number } | undefined)?.status === 401
    );
  }

  /**
   * The one outbound call. Native `fetch` + `AbortController` with a
   * config-supplied timeout, per the house idiom; non-2xx maps to 502 and
   * unreachable to 503, per `nominatim.provider.ts`.
   */
  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<any> {
    const { PUBLIC_KEY } = MYCOOLPAY_CONFIG;
    if (!PUBLIC_KEY) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'My-CoolPay is not configured. Set MYCOOLPAY_PUBLIC_KEY in the environment.'
      );
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MYCOOLPAY_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const url = `${MYCOOLPAY_CONFIG.BASE_URL}/${encodeURIComponent(PUBLIC_KEY)}${path}`;
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }

      // 202 Accepted is a documented success for payout/in-progress, so the
      // whole 2xx band is accepted rather than 200 alone.
      if (response.status < 200 || response.status >= 300) {
        const failure = createAppError(
          ERROR_CODES.MYCOOLPAY_REQUEST_FAILED,
          502,
          `My-CoolPay ${method} ${path} answered ${response.status}`,
          { status: response.status, body: parsed }
        );
        recordIntegrationCall('mycoolpay', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('mycoolpay', startedAt);
      return parsed;
    } catch (error: any) {
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.MYCOOLPAY_UNREACHABLE,
        503,
        `My-CoolPay ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('mycoolpay', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}
