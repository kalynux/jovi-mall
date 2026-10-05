import {
  PaymentGateway,
  PaymentGatewayName,
  GatewayCapabilities,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  PayoutPayload,
  PayoutResult,
  PayoutBalance,
  PayoutVerifyPayload,
  PayoutVerifyResult,
  PaymentGatewayStatus,
  WebhookVerifyInput,
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  deriveEventId,
  parseRawJson,
} from '../domain/webhook-verification';
import { CINETPAY_CONFIG } from '../config/payments.config';
import { isZeroDecimalCurrency } from '../domain/money';
import { MerchantRefKind, isMoneyOutRef } from '../domain/merchant-reference';
import {
  CameroonMobileOperator,
  resolveCameroonOperator,
  toCameroonNationalNumber,
} from '../domain/cm-operator';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * CinetPayGateway — mobile money (MTN / Orange Cameroon) over CinetPay API v1.
 *
 * Source: CinetPay's own JS SDK, github.com/cinetpay/cinetpay-js (2026-03). Their documentation
 * host (docs.cinetpay.com) no longer resolves, so the SDK's source is the spec. Every claim below
 * is from that source unless it says "measured".
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────────
 * `POST /v1/oauth/login` with `api_key` + `api_password` returns a bearer JWT valid 24 h. Cached
 * per process with a single flight; a `1003 EXPIRED_TOKEN` / `1002 INVALID_TOKEN` (or a 401)
 * drops it and retries once.
 *
 * ── ERRORS CAN ARRIVE WITH HTTP 200 ──────────────────────────────────────────
 * The SDK treats a response as an error when the HTTP status is ≥ 400 OR the body `code` is not
 * one of 200 / 100 / 2001 / 2002. So `request` throws only on the HTTP status, and every caller
 * reads the body `status` itself (`cinetpayStatusOf`).
 *
 * ── OUR REFERENCE DOES NOT FIT ───────────────────────────────────────────────
 * `merchant_transaction_id` is capped at 30 characters; ours is `jm_<kind>_<32 hex>` = 38. It
 * travels in a compact, REVERSIBLE form (`toCinetpayMerchantId`) and is decoded back on every
 * read, so routing still sees the full `jm_…` reference.
 *
 * ── ONE CHARGE, PUSHED OR REDIRECTED ─────────────────────────────────────────
 * `POST /v1/payment` with `direct_pay` asks CinetPay to push the PIN prompt to the handset. An
 * account without direct mode (or an operator that needs it) answers `must_be_redirected`, and
 * the client is handed CinetPay's hosted page as `redirectUrl`, which every client must honour.
 *
 * ── NO REFUND API, NO CARD ───────────────────────────────────────────────────
 * The v1 SDK has no refund endpoint, so `refundPayment` is deliberately ABSENT (see the interface
 * header). Cards are not declared.
 *
 * ⛔ ── THE NOTIFICATION IS NOT AUTHENTICATED ─────────────────────────────────
 * It carries `notify_token`, `merchant_transaction_id`, `transaction_id` and the payer — no
 * status, no amount, no signature. The `notify_token` could only be checked against the value
 * stored at initiation, and this adapter is stateless. So `confirmWebhookEvent` re-reads the
 * transaction from CinetPay and the processor acts only on that record: a forged notification
 * can at most cause one extra status lookup. The notification is a doorbell.
 */
export class CinetPayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'CINETPAY';

  /** Both operators push a PIN prompt (or fall back to the hosted page). ADR-A08 D-2. */
  readonly capabilities: GatewayCapabilities = Object.freeze({
    collect: Object.freeze({
      MTN: Object.freeze({ flow: 'PUSH' as const, requires: Object.freeze(['phoneNumber' as const]) }),
      ORANGE: Object.freeze({ flow: 'PUSH' as const, requires: Object.freeze(['phoneNumber' as const]) }),
    }),
    settlesAsync: true,
  });

  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      const operator = resolveCameroonOperator(payload.channel.phoneNumber, payload.channel.phoneOperator);
      const phone = cinetpayPhone(payload.channel.phoneNumber);
      if (!operator || !phone) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      const merchantId = toCinetpayMerchantId(payload.merchantRef);
      if (!merchantId) {
        // Every reference minted since `merchant-reference.ts` encodes; a legacy one cannot.
        throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED, 503, 'This payment reference cannot be sent to CinetPay.');
      }

      const names = cinetpayCustomerNames(payload.channel.customerName);
      const email = cinetpayCustomerEmail(payload.channel.customerEmail, CINETPAY_CONFIG.FALLBACK_EMAIL);
      const response = await this.call('/v1/payment', 'POST', {
        currency: payload.currency.toUpperCase(),
        merchant_transaction_id: merchantId,
        amount: Math.trunc(payload.amount),
        lang: 'fr',
        designation: `Order #${payload.orderId}`.slice(0, 255),
        client_email: email,
        client_first_name: names.first,
        client_last_name: names.last,
        client_phone_number: phone,
        success_url: CINETPAY_CONFIG.RETURN_URL,
        failed_url: CINETPAY_CONFIG.RETURN_URL,
        notify_url: CINETPAY_CONFIG.NOTIFY_URL,
        channel: 'PUSH',
        payment_method: cinetpayPaymentMethod(operator),
        direct_pay: CINETPAY_CONFIG.DIRECT_PAY,
      });

      const topStatus = cinetpayStatusOf(response);
      const gatewayRef = typeof response?.transaction_id === 'string' ? response.transaction_id : '';
      const detailStatus = normalizeCinetpayStatus(response?.details?.status);
      if (topStatus !== 'OK' || !gatewayRef || detailStatus === 'FAILED') {
        return {
          success: false,
          gatewayRef,
          status: 'FAILED',
          error: cinetpayDescription(response) || 'CinetPay did not open the payment',
          rawResponse: response,
        };
      }

      const redirectUrl =
        response?.details?.must_be_redirected === true && typeof response?.payment_url === 'string'
          ? response.payment_url
          : undefined;

      return {
        success: true,
        gatewayRef,
        // Never SUCCEEDED from here, even if `details.status` says so: settlement is decided by
        // the confirmed notification or the sweep, the same path every other charge takes.
        status: 'PENDING',
        instructions: redirectUrl
          ? { redirectUrl, message: 'Complete the payment on the CinetPay page.' }
          : {
              ussdCode: operator === 'MTN' ? '*126#' : '#150*50#',
              message: 'Approve the payment request on your phone by entering your mobile money PIN.',
            },
        rawResponse: response,
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator, provider refused or
      // unreachable) and reaches the caller as itself; anything else is a failed initiation.
      if (error instanceof AppError) throw error;
      console.error('[CinetPayGateway] initiatePayment error:', error?.message ?? error);
      return {
        success: false,
        gatewayRef: '',
        status: 'FAILED',
        error: error?.message || 'Gateway communication error',
        rawResponse: null,
      };
    }
  }

  async verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult> {
    try {
      const response = await this.call(`/v1/payment/${encodeURIComponent(payload.gatewayRef)}`, 'GET');
      const status = normalizeCinetpayStatus(cinetpayStatusOf(response));
      return { success: status === 'SUCCEEDED', status, transactionDetails: response, rawResponse: response };
    } catch (error: any) {
      console.error('[CinetPayGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, never FAILED: a verification we could not perform says nothing about the
      // payment, and the sweep re-reads a PENDING row where it would never re-read a FAILED one.
      return { success: false, status: 'PENDING', error: error?.message || 'Verification failed', rawResponse: null };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * There is no signature to check (see the header). This refuses what is certainly not a
   * CinetPay notification — an unconfigured gateway, an unparsable body, no `notify_token` —
   * and lets the rest through to `confirmWebhookEvent`, which is the real check.
   *
   * JSON is what the v1 SDK parses; a form-encoded body is accepted too, because CinetPay's
   * older API posted forms and the cost of reading both is nothing.
   */
  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    // Refuse, never skip: unconfigured, nothing could confirm the notification.
    if (!CINETPAY_CONFIG.API_KEY || !CINETPAY_CONFIG.API_PASSWORD) return { ok: false, reason: 'missing_secret' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const payload = parseCinetpayNotification(input.rawBody);
    if (!payload) return { ok: false, reason: 'unparsable' };

    const token = payload.notify_token;
    if (typeof token !== 'string' || token.trim() === '') {
      return { ok: false, reason: 'missing_signature' };
    }

    return { ok: true, payload, rawBody: input.rawBody };
  }

  /**
   * The NOTIFICATION's claims. It states no status, so this event is a placeholder (PENDING) and
   * is never acted on as it stands: the processor passes it through `confirmWebhookEvent` first.
   */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    const gatewayRef = typeof payload.transaction_id === 'string' ? payload.transaction_id.trim() : '';
    const merchantRef = fromCinetpayMerchantId(payload.merchant_transaction_id);
    if (!gatewayRef || !merchantRef) return null;
    return cinetpayEvent(gatewayRef, merchantRef, payload, payload);
  }

  /**
   * Replace a notification's claims with CinetPay's own record (ADR-A08 P2.0).
   *
   * Collections are read at `GET /v1/payment/{id}`, payouts at `GET /v1/transfer/{id}` — the
   * direction comes from OUR reference's kind (`po` = payout, `rf` = a refund sent as a transfer), so a forged notification cannot
   * steer a payout lookup at a collection record. The record must name the same CinetPay id AND
   * the same merchant id, or it is not this money and the answer is null.
   *
   * 404 → null (CinetPay does not know it). Any other failure THROWS, so the route answers 5xx
   * and the reconciliation sweep (`settlesAsync: true`) remains the backstop.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    if (!event.merchantRef) return null;
    const path = event.direction === 'payout' ? '/v1/transfer/' : '/v1/payment/';

    let record: any;
    try {
      record = await this.call(`${path}${encodeURIComponent(event.gatewayRef)}`, 'GET');
    } catch (error) {
      // Measured on the sandbox 2026-10-02: an unknown id is HTTP 422 with `code: 404` in the body.
      if (cinetpayNotFound(error)) return null;
      throw error;
    }
    if (cinetpayStatusOf(record) === 'NOT_FOUND') return null;

    const recordRef = typeof record?.transaction_id === 'string' ? record.transaction_id : null;
    const recordMerchantRef = fromCinetpayMerchantId(record?.merchant_transaction_id);
    if (recordRef !== event.gatewayRef || recordMerchantRef !== event.merchantRef) return null;

    return cinetpayEvent(event.gatewayRef, event.merchantRef, record, { callback: event.raw, confirmed: record });
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /** Is sending switched on for this deployment? The IP whitelist is invisible from here. */
  payoutAvailable(): boolean {
    return CINETPAY_CONFIG.PAYOUTS_ENABLED;
  }

  /** The merchant float, `GET /v1/balances`. One float for the account, so the phone is unused. */
  async payoutBalance(currency: string): Promise<PayoutBalance | null> {
    const response = await this.call('/v1/balances', 'GET');
    const available = Number(response?.available_balance);
    const reported = typeof response?.currency === 'string' ? response.currency.toUpperCase() : null;
    if (!Number.isFinite(available) || reported !== currency.toUpperCase()) return null;
    return { available, currency: reported };
  }

  /**
   * Read a sent transfer back, `GET /v1/transfer/{transaction_id}`, for the payout sweep.
   *
   * The endpoint serves transfers only, so a record from it is a payout. It must still be OURS:
   * when it states a merchant id that does not decode to this payout's reference, it is not.
   */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    let record: any;
    try {
      record = await this.call(`/v1/transfer/${encodeURIComponent(payload.gatewayRef)}`, 'GET');
    } catch (error: any) {
      return {
        status: 'PENDING',
        gatewayRef: null,
        inconclusive: `CinetPay transfer lookup failed: ${error?.message ?? error}`,
      };
    }
    return cinetpayTransferVerdict(record, payload.reference);
  }

  /**
   * Send money: `POST /v1/transfer`, one call.
   *
   * `reference` is the caller's and never minted here. A retry reuses it, and CinetPay answers a
   * repeated `merchant_transaction_id` with `1200 TRANSACTION_EXIST` rather than a second
   * transfer. That answer is NOT a failure (the first send may have gone through), so the
   * existing transfer is looked up and reported; if it cannot be found, this throws and the
   * payout stays `processing` with its outcome unknown.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const phone = cinetpayPhone(payload.phone);
    if (!operator || !phone) {
      // Not a refusal by CinetPay: we cannot place the number, and guessing sends somebody's
      // money down the wrong rail.
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: 'This destination number is not recognised as MTN or Orange Cameroon, which is all CinetPay can pay out to here.',
      };
    }
    const merchantId = toCinetpayMerchantId(payload.reference);
    if (!merchantId) {
      return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: 'This payout reference cannot be sent to CinetPay.' };
    }

    let response: any;
    try {
      response = await this.call('/v1/transfer', 'POST', {
        currency: payload.currency.toUpperCase(),
        merchant_transaction_id: merchantId,
        phone_number: phone,
        amount: Math.trunc(payload.amount),
        payment_method: cinetpayPaymentMethod(operator),
        reason: (payload.description ?? 'Payout').slice(0, 255),
        notify_url: CINETPAY_CONFIG.NOTIFY_URL,
      });
    } catch (error) {
      const body = error instanceof AppError && error.code === ERROR_CODES.CINETPAY_REQUEST_FAILED
        ? (error.details as { body?: unknown } | undefined)?.body
        : undefined;
      if (body === undefined) throw error; // unreachable or unexpected: the outcome is unknown
      response = body;
    }

    const status = cinetpayStatusOf(response);
    if (status === 'TRANSACTION_EXIST') return this.existingPayout(merchantId, payload.reference);

    // The specific reason may be nested: measured on the sandbox 2026-10-02, a short float is a
    // top-level `2010 FAILED` with `details: { code: 2005, status: 'INSUFFICIENT_BALANCE' }`.
    const refusal =
      cinetpayPayoutRefusal(cinetpayStatusOf(response?.details), cinetpayDescription(response)) ??
      cinetpayPayoutRefusal(status, cinetpayDescription(response));
    if (refusal) return { success: false, gatewayRef: null, status: 'FAILED', ...refusal, raw: response };

    const gatewayRef = typeof response?.transaction_id === 'string' && response.transaction_id ? response.transaction_id : null;
    const normalized = normalizeCinetpayStatus(status);
    if (normalized === 'FAILED' || normalized === 'CANCELLED') {
      return { success: false, gatewayRef, status: normalized, message: cinetpayDescription(response) || status || 'FAILED', raw: response };
    }
    if (!gatewayRef) {
      // Accepted-looking but with nothing to track it by. Throwing keeps the payout `processing`
      // and its outcome unknown, which is the truth; reporting a failure could pay it twice.
      throw createAppError(ERROR_CODES.CINETPAY_REQUEST_FAILED, 502, 'CinetPay accepted a transfer without a transaction id', {
        body: response,
      });
    }
    return { success: true, gatewayRef, status: normalized, raw: response };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** A resent payout CinetPay already holds: report the transfer it has, or admit we do not know. */
  private async existingPayout(merchantId: string, reference: string): Promise<PayoutResult> {
    const record = await this.call(`/v1/transfer/${encodeURIComponent(merchantId)}`, 'GET');
    const verdict = cinetpayTransferVerdict(record, reference);
    if (verdict.inconclusive || !verdict.gatewayRef) {
      throw createAppError(
        ERROR_CODES.CINETPAY_REQUEST_FAILED,
        502,
        'CinetPay reports this payout already exists but its transfer could not be read back',
        { body: record }
      );
    }
    return {
      success: verdict.status !== 'FAILED' && verdict.status !== 'CANCELLED',
      gatewayRef: verdict.gatewayRef,
      status: verdict.status,
      message: verdict.reason ?? undefined,
      raw: record,
    };
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency) || currency.toUpperCase() !== 'XAF') {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `CinetPay cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /** A token with at least TOKEN_REFRESH_MARGIN_MS left, fetched at most once at a time. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - Date.now() > CINETPAY_CONFIG.TOKEN_REFRESH_MARGIN_MS) {
      return this.token.value;
    }
    if (!this.tokenInFlight) {
      this.tokenInFlight = (async () => {
        const response = await this.request('/v1/oauth/login', 'POST', {
          api_key: CINETPAY_CONFIG.API_KEY,
          api_password: CINETPAY_CONFIG.API_PASSWORD,
        });
        const value = response?.access_token;
        const ttlSeconds = Number(response?.expires_in);
        if (typeof value !== 'string' || value === '') {
          throw createAppError(
            ERROR_CODES.CINETPAY_REQUEST_FAILED,
            502,
            `CinetPay login returned no token (${cinetpayStatusOf(response) ?? 'no status'})`
          );
        }
        this.token = { value, expiresAt: Date.now() + (Number.isFinite(ttlSeconds) ? ttlSeconds : 86400) * 1000 };
        return value;
      })().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  /**
   * An authenticated call. An expired or rejected token (HTTP 401, or body code 1003 / 1002)
   * drops the cached token and retries once.
   */
  private async call(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<any> {
    if (!CINETPAY_CONFIG.API_KEY || !CINETPAY_CONFIG.API_PASSWORD) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'CinetPay is not configured. Set CINETPAY_API_KEY and CINETPAY_API_PASSWORD in the environment.'
      );
    }
    let response: any;
    try {
      response = await this.request(path, method, body, await this.accessToken());
    } catch (error) {
      if (!cinetpayTokenRejected(error)) throw error;
      this.token = null;
      return this.request(path, method, body, await this.accessToken());
    }
    if (!cinetpayTokenRejected(response)) return response;
    this.token = null;
    return this.request(path, method, body, await this.accessToken());
  }

  /**
   * The one outbound HTTP call, in the Campay idiom: native fetch + AbortController with a
   * configured timeout; HTTP non-2xx is 502, unreachable is 503. Diagnostics go in `details`,
   * which the boundary drops for every `external_service` error. The login body is never copied
   * into them.
   */
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    token?: string
  ): Promise<any> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CINETPAY_CONFIG.REQUEST_TIMEOUT_MS);
    const isLogin = path === '/v1/oauth/login';

    try {
      const response = await fetch(`${CINETPAY_CONFIG.BASE_URL}${path}`, {
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

      if (response.status < 200 || response.status >= 300) {
        const failure = createAppError(
          ERROR_CODES.CINETPAY_REQUEST_FAILED,
          502,
          `CinetPay ${method} ${path} answered ${response.status}`,
          { status: response.status, body: isLogin ? null : parsed, apiStatus: cinetpayStatusOf(parsed) }
        );
        recordIntegrationCall('cinetpay', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('cinetpay', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 above would be rewritten as a 503 here.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.CINETPAY_UNREACHABLE,
        503,
        `CinetPay ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('cinetpay', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for test:cinetpay) ───────────────────────────────

/**
 * One status table for this gateway, for charges, transfers and notifications.
 *
 * The words are CinetPay's (`TRANSACTION_STATUSES` in the SDK). Only SUCCESS settles. The
 * failures are the SDK's final statuses plus the ones that cannot recover (expired, blocked,
 * unknown user). `INITIATED` / `PENDING` / `OTP_ERROR` are still moving. Anything else maps to
 * PENDING, never FAILED: an unrecognised word is ignorance, and the sweep re-reads PENDING.
 */
export function normalizeCinetpayStatus(raw: unknown): PaymentGatewayStatus {
  const map: Record<string, PaymentGatewayStatus> = {
    SUCCESS: 'SUCCEEDED',
    FAILED: 'FAILED',
    EXPIRED: 'FAILED',
    OTP_EXPIRED: 'FAILED',
    INSUFFICIENT_BALANCE: 'FAILED',
    USER_NOT_FOUND: 'FAILED',
    USER_IS_BLOCKED: 'FAILED',
    INITIATED: 'PENDING',
    PENDING: 'PENDING',
    OTP_ERROR: 'PENDING',
  };
  return map[String(raw ?? '').trim().toUpperCase()] ?? 'PENDING';
}

/** CinetPay's numeric codes, for a body that carries a code and no status word (SDK `API_CODES`). */
const CINETPAY_CODE_STATUS: Readonly<Record<number, string>> = Object.freeze({
  200: 'OK',
  100: 'SUCCESS',
  [-1]: 'OPERATION_ERROR',
  404: 'NOT_FOUND',
  1005: 'INVALID_CREDENTIALS',
  1004: 'INVALID_PARAMS',
  1003: 'EXPIRED_TOKEN',
  1002: 'INVALID_TOKEN',
  1200: 'TRANSACTION_EXIST',
  2001: 'INITIATED',
  2002: 'PENDING',
  2003: 'EXPIRED',
  2004: 'OTP_ERROR',
  2008: 'OTP_EXPIRED',
  2005: 'INSUFFICIENT_BALANCE',
  2006: 'USER_NOT_FOUND',
  2007: 'USER_IS_BLOCKED',
  2010: 'FAILED',
  2011: 'NOT_ALLOWED',
});

/** The status word of a CinetPay body: `status` when it is a string, else the word for `code`. */
export function cinetpayStatusOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.status === 'string' && b.status.trim() !== '') return b.status.trim().toUpperCase();
  const code = Number(b.code);
  return Number.isFinite(code) ? CINETPAY_CODE_STATUS[code] ?? null : null;
}

function cinetpayDescription(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, any>;
  const text = b.description ?? b.message ?? b.details?.message;
  return typeof text === 'string' ? text : '';
}

/**
 * Did CinetPay answer "no such transaction"? It says so with HTTP 422 and `code: 404` in the body
 * (measured on the sandbox, 2026-10-02); a bare HTTP 404 is accepted too.
 */
export function cinetpayNotFound(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.CINETPAY_REQUEST_FAILED) return false;
  const details = (error.details ?? {}) as { status?: number; apiStatus?: string | null };
  return details.status === 404 || details.apiStatus === 'NOT_FOUND';
}

/** Did CinetPay refuse the bearer token itself? Reads a thrown 401 or an expired/invalid code. */
export function cinetpayTokenRejected(errorOrBody: unknown): boolean {
  if (errorOrBody instanceof AppError) {
    if (errorOrBody.code !== ERROR_CODES.CINETPAY_REQUEST_FAILED) return false;
    const details = (errorOrBody.details ?? {}) as { status?: number; apiStatus?: string | null };
    return details.status === 401 || details.apiStatus === 'EXPIRED_TOKEN' || details.apiStatus === 'INVALID_TOKEN';
  }
  const status = cinetpayStatusOf(errorOrBody);
  return status === 'EXPIRED_TOKEN' || status === 'INVALID_TOKEN';
}

/**
 * A transfer refusal that provably sent nothing, as `PayoutResult` fields. Null for anything
 * that is not one. `unsupported` marks the knowable "cannot send from here" answers.
 */
export function cinetpayPayoutRefusal(
  status: string | null,
  description: string
): { message: string; unsupported?: boolean } | null {
  switch (status) {
    case 'NOT_ALLOWED':
      return {
        unsupported: true,
        message: 'CinetPay refused the transfer as NOT_ALLOWED: this server\'s IP address is probably not on the account\'s whitelist. Register the VPS egress IP with CinetPay, or pay this one by hand.',
      };
    case 'INSUFFICIENT_BALANCE':
      return {
        unsupported: true,
        message: 'The CinetPay balance cannot cover this payout. Top up the CinetPay account or pay this one by hand.',
      };
    case 'INVALID_CREDENTIALS':
      return { unsupported: true, message: 'CinetPay refused our API credentials. Check CINETPAY_API_KEY and CINETPAY_API_PASSWORD.' };
    case 'INVALID_PARAMS':
      return { message: `CinetPay refused the transfer request as invalid${description ? `: ${description}` : ''}.` };
    case 'USER_NOT_FOUND':
    case 'USER_IS_BLOCKED':
      return { message: `CinetPay refused the destination account (${status}).` };
    default:
      return null;
  }
}

/** A `/v1/transfer/{id}` record, reduced to a payout verdict. See `PayoutVerifyResult`. */
export function cinetpayTransferVerdict(record: unknown, reference: string | null): PayoutVerifyResult {
  if (!record || typeof record !== 'object') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'CinetPay returned no transfer record', raw: record };
  }
  const r = record as Record<string, unknown>;
  const word = cinetpayStatusOf(r);
  if (word === 'NOT_FOUND') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'CinetPay does not know this transfer', raw: record };
  }
  const ours = fromCinetpayMerchantId(r.merchant_transaction_id);
  if (typeof r.merchant_transaction_id === 'string' && reference && ours !== reference) {
    return {
      status: 'PENDING',
      gatewayRef: null,
      inconclusive: `CinetPay transfer ${String(r.merchant_transaction_id)} is not this payout's (${reference})`,
      raw: record,
    };
  }
  const status = normalizeCinetpayStatus(word);
  return {
    status,
    gatewayRef: typeof r.transaction_id === 'string' && r.transaction_id ? r.transaction_id : null,
    reason: status === 'FAILED' || status === 'CANCELLED' ? cinetpayDescription(r) || `CinetPay reported ${word}` : null,
    raw: record,
  };
}

/** A notification or a status record, as the normalized event. */
function cinetpayEvent(
  gatewayRef: string,
  merchantRef: string,
  record: Record<string, unknown>,
  raw: unknown
): NormalizedWebhookEvent {
  // `po` (a payout) AND `rf` (a refund sent as a transfer) are money out — never `=== 'po'`.
  const payout = isMoneyOutRef(merchantRef);
  // A notification carries no status at all; it reads as PENDING and is never acted on as such.
  const word = cinetpayStatusOf(record) ?? 'NOTIFIED';
  const amount = record.amount;
  return {
    eventId: deriveEventId(['cinetpay', gatewayRef, word]),
    eventType: `${payout ? 'transfer' : 'payment'}.${word.toLowerCase()}`,
    direction: payout ? 'payout' : 'collection',
    gatewayRef,
    merchantRef,
    status: normalizeCinetpayStatus(word),
    // The SDK's payment status type carries no amount; a transfer's does. Null skips the
    // orchestrator's amount cross-check, which the lookup BY OUR OWN merchant id makes safe.
    amount: typeof amount === 'number' || (typeof amount === 'string' && amount.trim() !== '') ? amount : null,
    currency: typeof record.currency === 'string' ? record.currency : null,
    raw,
  };
}

/** The notification body: JSON, or (as the older API sent) form-encoded. Null when neither. */
export function parseCinetpayNotification(rawBody: Buffer): Record<string, unknown> | null {
  const json = parseRawJson(rawBody);
  if (json.ok) return json.value;
  const text = rawBody.toString('utf8').trim();
  if (!text || !text.includes('=')) return null;
  const form = Object.fromEntries(new URLSearchParams(text).entries());
  return Object.keys(form).length > 0 ? form : null;
}

const MERCHANT_ID_PATTERN = /^jm(pt|pp|ct|po|rf)([0-9a-z]{25})$/;
const MERCHANT_REF_PATTERN = /^jm_(pt|pp|ct|po|rf)_([0-9a-f]{32})$/;

/**
 * `jm_pt_<32 hex>` (38 chars) → `jmpt<25 base-36>` (29 chars), under CinetPay's 30-character
 * cap on `merchant_transaction_id`. Lossless: the 128 random bits are re-written in base 36 and
 * zero-padded, so `fromCinetpayMerchantId` returns the exact original. Null for anything that is
 * not a current `jm_` reference.
 */
export function toCinetpayMerchantId(merchantRef: string): string | null {
  const match = MERCHANT_REF_PATTERN.exec(merchantRef);
  if (!match) return null;
  return `jm${match[1]}${BigInt(`0x${match[2]}`).toString(36).padStart(25, '0')}`;
}

/** The inverse of `toCinetpayMerchantId`. Null for any value it could not have produced. */
export function fromCinetpayMerchantId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = MERCHANT_ID_PATTERN.exec(value.trim());
  if (!match) return null;
  let n = BigInt(0);
  for (const digit of match[2]) n = n * BigInt(36) + BigInt(parseInt(digit, 36));
  const hex = n.toString(16);
  if (hex.length > 32) return null;
  return `jm_${match[1] as MerchantRefKind}_${hex.padStart(32, '0')}`;
}

/** `670000000` / `237670000000` / `+237 6 70…` → `+237670000000`; null when not a Cameroon mobile. */
export function cinetpayPhone(phone: string | null | undefined): string | null {
  const national = toCameroonNationalNumber(phone);
  return national ? `+237${national}` : null;
}

/** CinetPay's method code for a Cameroon operator. */
export function cinetpayPaymentMethod(operator: CameroonMobileOperator): 'MTN_CM' | 'OM_CM' {
  return operator === 'MTN' ? 'MTN_CM' : 'OM_CM';
}

/**
 * First and last name, each 2–255 characters as CinetPay requires. A one-word or missing name
 * is padded with neutral words rather than refused: a customer is not asked for a surname to
 * pay by mobile money.
 */
export function cinetpayCustomerNames(fullName: string | null | undefined): { first: string; last: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  const fit = (value: string | undefined, fallback: string) =>
    value && value.length >= 2 ? value.slice(0, 255) : fallback;
  return {
    first: fit(parts[0], 'Client'),
    last: fit(parts.slice(1).join(' '), 'Wi-Mall'),
  };
}

/** The customer's email when it looks like one, else the configured fallback. */
export function cinetpayCustomerEmail(email: string | null | undefined, fallback: string): string {
  const candidate = (email ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : fallback;
}
