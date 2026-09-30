import {
  PaymentGateway,
  PaymentGatewayName,
  GatewayCapabilities,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  PaymentAuthorizePayload,
  PaymentAuthorizeResult,
  PaymentGatewayStatus,
  WebhookVerifyInput,
  PayoutPayload,
  PayoutResult,
  PayoutBalance,
  PayoutVerifyPayload,
  PayoutVerifyResult,
} from './gateway.interface';
import { resolveCameroonOperator } from '../domain/cm-operator';
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
 * nothing links it to the original charge. So refunds stay manual here.
 *
 * ── PAYOUTS (ADR-A08) ────────────────────────────────────────────────────────
 * `payout` IS wired, for owner payouts only (`createPayout`), behind
 * `MYCOOLPAY_PAYOUTS_ENABLED`. Four facts from the provider shape it, read from
 * their Postman collection and their PHP SDK on 2026-09-30:
 *   - Every private-key call (payout, balance) is FIREWALLED to at most three
 *     server IPs registered by email. From any other address it HANGS rather
 *     than answering 403, so `createPayout` pre-flights with `GET /balance`
 *     and turns that into a refusal while nothing has been sent.
 *   - A payout callback is the collection callback with `transaction_type:
 *     PAYOUT`, signed the same way, so its status is confirmed the same way.
 *   - Each callback is sent ONCE, with no retry.
 *   - Their docs are silent on whether a repeated `app_transaction_ref` is
 *     refused, and `checkStatus` cannot be searched by it. So an answer that
 *     leaves the outcome unknown THROWS (the payout stays `processing`), and
 *     only an answer that proves nothing was sent returns `success: false`.
 */
export class MyCoolPayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'MYCOOLPAY';

  /**
   * Orange Money may answer REQUIRE_OTP (`instructions.requiresOtp`), so its flow is OTP; MTN is a
   * plain push. My-CoolPay derives the operator from the number itself. ADR-A08 D-2.
   */
  readonly capabilities: GatewayCapabilities = {
    collect: {
      MTN: { flow: 'PUSH', requires: ['phoneNumber'] },
      ORANGE: { flow: 'OTP', requires: ['phoneNumber'] },
    },
    settlesAsync: true,
  };

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
      // `transaction_type` is PAYIN or PAYOUT, and it is inside the signature. A PAYOUT callback
      // is money leaving: the processor routes it to the payout branch and never to an order.
      direction: myCoolPayDirection(body.transaction_type),
      eventType: `${String(body.transaction_type ?? 'PAYIN')}.${status || 'unknown'}`,
      gatewayRef,
      merchantRef: body.app_transaction_ref ? String(body.app_transaction_ref) : null,
      status: this.normalizeStatus(status),
      amount: body.transaction_amount ?? null,
      currency: body.transaction_currency ? String(body.transaction_currency) : null,
      raw: payload,
    };
  }

  /**
   * Re-read the transaction from My-CoolPay before a callback is acted on (ADR-A08 P2.0).
   *
   * ⛔ **Why My-CoolPay needs this.** Its callback signature (`myCoolPaySignature`) covers ref,
   * type, amount, currency and operator — NOT `transaction_status`. So a genuinely signed callback
   * for a FAILED charge, replayed with its status changed to SUCCESS, passes `verifyWebhook`; and
   * because the event id is derived from the status, it passes dedup too. The callback-IP pin
   * would stop it, but it is off by default and off in production.
   *
   * So the status acted on is `checkStatus`'s, never the body's:
   * - **The event id is rebuilt from the CONFIRMED status**, so a status-altered replay collides
   *   with the genuine event for the status My-CoolPay actually holds, instead of minting a new id.
   * - Amount, currency, ref and operator stay the body's: the signature covers them.
   * - A `checkStatus` answer about a different transaction or reference → null (`ignored`).
   * - **A transport failure THROWS** (`call` raises `MYCOOLPAY_UNREACHABLE` / `_REQUEST_FAILED` at
   *   5xx) → the webhook answers 5xx, My-CoolPay retries, the sweep backstops. It deliberately does
   *   NOT go through `verifyPayment`, which folds a failure into PENDING: that would acknowledge a
   *   genuine SUCCESS callback with a 200 during an outage and leave it to the sweep alone.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    const record = await this.call(`/checkStatus/${encodeURIComponent(event.gatewayRef)}`, 'GET');

    const recordRef = record?.transaction_ref ?? null;
    if (recordRef !== null && String(recordRef) !== event.gatewayRef) return null;
    const recordMerchantRef = record?.app_transaction_ref ?? null;
    if (recordMerchantRef !== null && event.merchantRef !== null && String(recordMerchantRef) !== event.merchantRef) {
      return null;
    }

    const body = (event.raw ?? {}) as Record<string, any>;
    // The record must be the same KIND of money: a PAYIN record may never confirm a PAYOUT
    // callback (or the reverse). The processor also refuses a direction change; this refuses it
    // one step earlier, from the provider's own field.
    const recordType = record?.transaction_type ?? null;
    if (recordType !== null && myCoolPayDirection(recordType) !== event.direction) return null;
    const status = String(record?.transaction_status ?? '');
    return {
      ...event,
      eventId: deriveEventId([event.gatewayRef, body.transaction_type, status]),
      eventType: `${String(body.transaction_type ?? 'PAYIN')}.${status || 'unknown'}`,
      status: this.normalizeStatus(status),
      raw: { callback: event.raw, confirmation: record },
    };
  }

  // ── Payouts ───────────────────────────────────────────────────────────────

  /**
   * On our account, not merely in their API: the switch, plus both keys (the private key is the
   * payout credential). Whether our server IP is registered cannot be known without calling, so
   * `createPayout`'s pre-flight reports that per attempt.
   */
  payoutAvailable(): boolean {
    return MYCOOLPAY_CONFIG.PAYOUTS_ENABLED && !!MYCOOLPAY_CONFIG.PUBLIC_KEY && !!MYCOOLPAY_CONFIG.PRIVATE_KEY;
  }

  /**
   * The one float (XAF). `destinationPhone` is ignored: My-CoolPay does not keep a float per
   * carrier. Null when it cannot be read, which the caller treats as "unknown", never as zero.
   */
  async payoutBalance(currency: string, _destinationPhone?: string): Promise<PayoutBalance | null> {
    if (currency.toUpperCase() !== 'XAF') return null;
    try {
      const available = await this.readBalance();
      return available === null ? null : { available, currency: 'XAF' };
    } catch {
      return null;
    }
  }

  /**
   * Send an owner payout.
   *
   * ⛔ **Two kinds of "no", and they must never be confused.**
   *   - `success: false` means NOTHING WAS SENT: the number has no known network, the pre-flight
   *     could not reach the firewalled API, the float is short, or the payout call itself was
   *     refused with a 400 / 401 / 403 / 422. The payout goes `failed`, the hold stays, and a
   *     retry with the same reference is safe.
   *   - A THROW means the outcome is UNKNOWN: a timeout, a 5xx, a 409, or a 2xx we cannot read.
   *     The payout stays `processing`. Their docs do not say a repeated `app_transaction_ref` is
   *     refused, so a retry after an unknown outcome could pay twice.
   *
   * The reference sent is `payload.reference` (our `jm_po_…`), and the operator is worked out
   * from the number: `CM_MOMO` for MTN, `CM_OM` for Orange.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    const refused = (message: string, unsupported = false): PayoutResult => ({
      success: false,
      gatewayRef: null,
      status: 'FAILED',
      message,
      ...(unsupported ? { unsupported: true } : {}),
    });

    if (payload.currency.toUpperCase() !== 'XAF') {
      return refused(`My-CoolPay pays out in XAF only, not ${payload.currency}.`, true);
    }
    const operator = myCoolPayPayoutOperator(payload.phone);
    if (!operator) {
      return refused('Could not determine the mobile network (MTN or Orange) for this number.', true);
    }

    /**
     * The pre-flight. Same private key and same firewall as the payout, and it moves nothing.
     * Anything short of a readable answer means the payout would not have gone through either,
     * and learning that here costs no uncertainty.
     */
    let available: number | null;
    try {
      available = await this.readBalance();
    } catch (error: any) {
      const status = (error?.details as { status?: number } | undefined)?.status;
      return refused(
        status === 401 || status === 403
          ? `My-CoolPay refused the payout credentials (${status}). Check MYCOOLPAY_PRIVATE_KEY and that this server's IP is registered with My-CoolPay.`
          : 'My-CoolPay did not answer the payout pre-flight. Is this server\'s IP registered with My-CoolPay support? Nothing was sent.',
        true,
      );
    }
    if (available !== null && available < payload.amount) {
      return refused(`My-CoolPay float is ${available} XAF, short of the ${payload.amount} XAF payout. Nothing was sent.`);
    }

    let response: any;
    try {
      response = await this.call(
        '/payout',
        'POST',
        {
          transaction_amount: payload.amount,
          transaction_currency: 'XAF',
          transaction_reason: (payload.description ?? 'Payout').slice(0, 120),
          transaction_operator: operator,
          app_transaction_ref: payload.reference,
          customer_phone_number: nationalCameroonNumber(payload.phone),
          customer_name: payload.name,
          customer_lang: 'fr',
        },
        { privateKey: true },
      );
    } catch (error: any) {
      const status = (error?.details as { status?: number } | undefined)?.status;
      if (error instanceof AppError && typeof status === 'number' && DEFINITE_PAYOUT_REFUSALS.has(status)) {
        const body = (error.details as { body?: any } | undefined)?.body;
        return refused(
          String(body?.message ?? `My-CoolPay refused the payout (${status})`),
          status === 401 || status === 403,
        );
      }
      throw error;
    }

    const gatewayRef = response?.transaction_ref ? String(response.transaction_ref) : null;
    if (response?.status !== 'success' || !gatewayRef) {
      // A 2xx that is neither a success nor a refusal we can read. Money may have moved.
      throw createAppError(
        ERROR_CODES.MYCOOLPAY_REQUEST_FAILED,
        502,
        'My-CoolPay answered the payout with a response we could not read. Its outcome is unknown.',
        { body: response },
      );
    }

    // 200 ("Successful transaction") and 202 ("in progress") alike: accepted, not settled. The
    // callback, or the status check behind it, decides.
    return { success: true, gatewayRef, status: 'PENDING' };
  }

  /**
   * Re-read a payout from My-CoolPay, for the payout sweep (it replaces a callback they will not
   * resend). Keyed on THEIR reference only: `checkStatus` cannot be searched by our `jm_po_…`.
   *
   * ⛔ **PENDING means "leave it"**, and it is the answer to anything short of a sure verdict: a
   * payout still moving, a transport failure or timeout, or a record that does not prove it is
   * THIS payout (not a PAYOUT, or naming another `app_transaction_ref`). The reason for an
   * unasked-for PENDING goes in `inconclusive`. Only SUCCEEDED, FAILED and CANCELLED move money.
   *
   */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    const leave = (inconclusive: string, raw?: unknown) =>
      ({ status: 'PENDING' as const, gatewayRef: payload.gatewayRef, inconclusive, raw });

    let record: any;
    try {
      record = await this.call(`/checkStatus/${encodeURIComponent(payload.gatewayRef)}`, 'GET');
    } catch (error: any) {
      return leave(`My-CoolPay status check failed: ${error?.message ?? String(error)}`);
    }

    if (record?.transaction_ref != null && String(record.transaction_ref) !== payload.gatewayRef) {
      return leave('the status record names a different My-CoolPay transaction', record);
    }
    if (myCoolPayDirection(record?.transaction_type) !== 'payout') {
      return leave(`the status record is not a PAYOUT (${String(record?.transaction_type ?? 'no type')})`, record);
    }
    const recordRef = record?.app_transaction_ref ?? null;
    if (recordRef !== null && payload.reference !== null && String(recordRef) !== payload.reference) {
      return leave('the status record names a different app_transaction_ref', record);
    }

    const status = this.normalizeStatus(record?.transaction_status);
    const failed = status === 'FAILED' || status === 'CANCELLED';
    return {
      status,
      gatewayRef: payload.gatewayRef,
      reason: failed ? String(record?.transaction_message ?? `My-CoolPay reported ${record?.transaction_status}`) : null,
      ...(status === 'PENDING' && String(record?.transaction_status ?? '').toUpperCase() !== 'PENDING'
        ? { inconclusive: `unrecognised My-CoolPay status "${String(record?.transaction_status ?? '')}"` }
        : {}),
      raw: record,
    };
  }

  /** `GET /balance` → the float, or null when the answer carries no number. Throws on transport. */
  private async readBalance(): Promise<number | null> {
    const response = await this.call('/balance', 'GET', undefined, { privateKey: true });
    const value = Number(response?.balance);
    return response?.status === 'success' && Number.isFinite(value) ? value : null;
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
    body?: Record<string, unknown>,
    options: { privateKey?: boolean } = {}
  ): Promise<any> {
    const { PUBLIC_KEY, PRIVATE_KEY } = MYCOOLPAY_CONFIG;
    if (!PUBLIC_KEY) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'My-CoolPay is not configured. Set MYCOOLPAY_PUBLIC_KEY in the environment.'
      );
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    // Payout and balance authenticate with the private key in a header (the body field is
    // deprecated). Never logged: errors below carry the status and the response body only.
    if (options.privateKey) {
      if (!PRIVATE_KEY) {
        throw createAppError(
          ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
          503,
          'My-CoolPay payouts need MYCOOLPAY_PRIVATE_KEY.'
        );
      }
      headers['X-PRIVATE-KEY'] = PRIVATE_KEY;
    }

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

// ── Module helpers (exported for test:mycoolpay-payout) ─────────────────────

/** `transaction_type` → direction. Only an explicit PAYOUT is money leaving. */
export function myCoolPayDirection(transactionType: unknown): 'payout' | 'collection' {
  return String(transactionType ?? '').toUpperCase() === 'PAYOUT' ? 'payout' : 'collection';
}

/** My-CoolPay's payout operator for a Cameroonian number, or null when the prefix is unknown. */
export function myCoolPayPayoutOperator(phone: string): 'CM_MOMO' | 'CM_OM' | null {
  const operator = resolveCameroonOperator(phone);
  if (operator === 'MTN') return 'CM_MOMO';
  if (operator === 'ORANGE') return 'CM_OM';
  return null;
}

/**
 * The nine national digits My-CoolPay's payout docs and SDK both use (`699009900`). A stored
 * `+237…` or `237…` number is reduced to them; anything else is sent as its digits.
 */
export function nationalCameroonNumber(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length === 12 && digits.startsWith('237') ? digits.slice(3) : digits;
}

/**
 * Payout-call statuses that prove the request was REJECTED, so nothing was sent. Everything else
 * that is not a 2xx (5xx, 409, anything unexpected) leaves the outcome unknown and is rethrown.
 * 409 is deliberately absent: on a repeated reference it may mean "already sent".
 */
export const DEFINITE_PAYOUT_REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 422]);
