import crypto from 'crypto';
import {
  PaymentGateway,
  PaymentGatewayName,
  GatewayCapabilities,
  CollectAmountLimits,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentInstructions,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  PayoutPayload,
  PayoutResult,
  PayoutVerifyPayload,
  PayoutVerifyResult,
  PaymentGatewayStatus,
  WebhookVerifyInput,
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  deriveEventId,
  headerValue,
  parseRawJson,
  timingSafeEqualString,
} from '../domain/webhook-verification';
import { NOVASEND_CONFIG, NOVASEND_SANDBOX_BASE_URL } from '../config/payments.config';
import { isZeroDecimalCurrency } from '../domain/money';
import { merchantRefKind, isMoneyOutRef } from '../domain/merchant-reference';
import {
  CameroonMobileOperator,
  resolveCameroonOperator,
  toCameroonNationalNumber,
} from '../domain/cm-operator';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * NovaSendGateway — mobile money (MTN / Orange Cameroon), collections and payouts.
 *
 * Source: docs.novasend.app/fr/docs (read 2026-10-05) and the official `novasend-sdk` 1.0.1.
 * base `https://business.novasend.app` (live) · `https://sandbox.novasend.app` (sandbox, the default)
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────────
 * HTTP Basic `base64(API_KEY:API_SECRET)` on every call; no token exchange. Every WRITE carries
 * `X-Idempotency-Key`, which NovaSend documents as REQUIRED and "must be a UUID". Ours is a UUID
 * DERIVED from our `jm_…` reference (`novasendIdempotencyKey`), so a retry of the same reference
 * presents the same key and cannot charge or pay twice. Errors are `{ code, message, statusCode }`.
 *
 * ── LOOKUPS ARE BY OUR REFERENCE ─────────────────────────────────────────────
 * `GET /v1/payin/{reference}` and `GET /v1/direct/payout/{reference}` take the MERCHANT reference,
 * so our `jm_…` reference is also the `gatewayRef` we store; NovaSend's own `id` stays in the raw
 * record. One value to look up by, and no second id to lose between the call and the row.
 *
 * ── ORANGE MONEY NEEDS A CODE FIRST (`CODE_FIRST`) ───────────────────────────
 * The Direct API requires `payin.otp` for ORANGE: a code the customer gets by dialling
 * `NOVASEND_ORANGE_CODE_USSD` BEFORE paying. Routing refuses a charge without it
 * (`422 PAYMENT_CODE_REQUIRED`, nothing written); a code NovaSend refuses is
 * `422 PAYMENT_CODE_REJECTED`. The code goes to NovaSend and nowhere else.
 *
 * ── LIMITS ───────────────────────────────────────────────────────────────────
 * Cameroon: 200–500,000 XAF for a pay-in and for a payout. Declared on the capability so
 * routing refuses an out-of-range charge before any write; a payout out of range is refused
 * here with nothing sent.
 *
 * ── THE NOTIFICATION IS SIGNED OVER THE WHOLE BODY ───────────────────────────
 * `X-Signature-Value: hex(HMAC-SHA256(body, webhookSecret))`. The SDK signs the raw bytes; the
 * docs' sample re-serialises (`JSON.stringify(body)`). Both are accepted, both need the secret.
 * `confirmWebhookEvent` still re-reads NovaSend's record: the status vocabulary differs between
 * pages (`success` / `processed` / `failed` / `expired`), and the record is what is acted on.
 *
 * ── NO REFUND, NO BALANCE ────────────────────────────────────────────────────
 * `refundPayment` is deliberately ABSENT: NovaSend's refund has no amount field, and a
 * mobile-money refund on this platform is a PAYOUT (REFUND-FLOW-PLAN R-1). No balance endpoint is
 * documented, so `payoutBalance` is absent too.
 *
 * ⚠ ── WHAT THE DOCS LEAVE OPEN (settled by `npm run verify:novasend`) ──────────
 * - the payout body key: the docs say `payout: {…}`, the SDK sends `payin: {…}`. Built per the docs.
 * - who pays the fee: a pay-in response shows `chargedAmount = amount + fee`. We compare `amount`.
 * - NovaSend's prefix table calls 685-689 MTN; ours (`cm-operator.ts`) says Orange and stays authoritative.
 */
export class NovaSendGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'NOVASEND';

  /** MTN pushes the PIN prompt; Orange needs the code first. ADR-A08 D-2. */
  readonly capabilities: GatewayCapabilities = Object.freeze({
    collect: Object.freeze({
      MTN: Object.freeze({
        flow: 'PUSH' as const,
        requires: Object.freeze(['phoneNumber' as const]),
        limits: NOVASEND_CM_LIMITS,
      }),
      ORANGE: Object.freeze({
        flow: 'CODE_FIRST' as const,
        requires: Object.freeze(['phoneNumber' as const, 'paymentCode' as const]),
        limits: NOVASEND_CM_LIMITS,
        codeUssd: NOVASEND_CONFIG.ORANGE_CODE_USSD,
      }),
    }),
    settlesAsync: true,
  });

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      const operator = resolveCameroonOperator(payload.channel.phoneNumber, payload.channel.phoneOperator);
      const msisdn = novasendMsisdn(payload.channel.phoneNumber);
      if (!operator || !msisdn) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      const amount = Math.trunc(payload.amount);
      assertWithinLimits(operator, amount);

      const code = (payload.channel.paymentCode ?? '').trim();
      if (operator === 'ORANGE' && !code) {
        // Routing refuses this before any write; reaching here means a door skipped it.
        throw paymentCodeRequired();
      }

      const payin: Record<string, unknown> = {
        amount,
        msisdn,
        provider: novasendProvider(operator),
        country: 'CM',
      };
      if (operator === 'ORANGE') payin.otp = code;

      const body: Record<string, unknown> = {
        reference: payload.merchantRef,
        customerName: payload.channel.customerName?.trim() || 'Client',
        payin,
        action: novasendAction(),
      };
      addSandboxScenario(body);

      let response: any;
      try {
        response = await this.call('/v1/direct/payin', 'POST', body, novasendIdempotencyKey('payin', payload.merchantRef));
      } catch (error) {
        if (operator === 'ORANGE' && isNovasendCodeRefusal(error)) throw paymentCodeRejected();
        throw error;
      }

      const gatewayRef = novasendReference(response) ?? (response && typeof response === 'object' ? payload.merchantRef : null);
      if (!gatewayRef) {
        return {
          success: false,
          gatewayRef: '',
          status: 'FAILED',
          error: 'NovaSend did not acknowledge the payment',
          rawResponse: response,
        };
      }

      const status = normalizeNovasendStatus(response?.status);
      if (status === 'FAILED' || status === 'CANCELLED') {
        return {
          success: false,
          gatewayRef,
          status: 'FAILED',
          error: novasendFailureReason(response) ?? 'NovaSend refused the payment',
          rawResponse: response,
        };
      }

      return {
        success: true,
        gatewayRef,
        status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING',
        instructions: novasendInstructions(operator, response),
        rawResponse: response,
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator, a missing or refused
      // code, an out-of-range amount, provider refused or unreachable) and reaches the caller as itself.
      if (error instanceof AppError) throw error;
      console.error('[NovaSendGateway] initiatePayment error:', error?.message ?? error);
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
      const record = await this.call(`/v1/payin/${encodeURIComponent(payload.gatewayRef)}`, 'GET');
      const status = normalizeNovasendStatus(record?.status);
      return { success: status === 'SUCCEEDED', status, transactionDetails: record, rawResponse: record };
    } catch (error: any) {
      console.error('[NovaSendGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, never FAILED: a verification we could not perform says nothing about the payment,
      // and the sweep re-reads a PENDING row where it would never re-read a FAILED one.
      return { success: false, status: 'PENDING', error: error?.message || 'Verification failed', rawResponse: null };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const secret = NOVASEND_CONFIG.WEBHOOK_SECRET;
    // Refuse, never skip.
    if (!secret) return { ok: false, reason: 'missing_secret' };

    const presented = headerValue(input.headers, ['x-signature-value']);
    if (!presented) return { ok: false, reason: 'missing_signature' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };

    if (!novasendSignatureMatches(input.rawBody, parsed.value, presented, secret)) {
      return { ok: false, reason: 'bad_signature' };
    }
    return { ok: true, payload: parsed.value, rawBody: input.rawBody };
  }

  /** The notification's claims. Re-read through `confirmWebhookEvent` before anything acts on them. */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    return novasendEventFrom(payload, payload);
  }

  /**
   * Replace a notification's claims with NovaSend's own record (ADR-A08 P2.0), read on the
   * endpoint of the direction the notification states. The record must name the same reference
   * and direction, or the answer is null. 404 → null (NovaSend does not know it); any other
   * failure THROWS, so the route answers 5xx and the reconciliation sweep is the backstop.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    let record: any;
    try {
      record = await this.call(novasendStatusPath(event.direction, event.gatewayRef), 'GET');
    } catch (error) {
      if (httpStatusOf(error) === 404) return null;
      throw error;
    }

    const confirmed = novasendEventFrom(record ?? {}, { callback: event.raw, confirmed: record }, event.direction);
    if (!confirmed) return null;
    if (confirmed.gatewayRef !== event.gatewayRef) return null;
    if (confirmed.direction !== event.direction) return null;
    if (event.merchantRef && confirmed.merchantRef && confirmed.merchantRef !== event.merchantRef) return null;

    return { ...confirmed, merchantRef: confirmed.merchantRef ?? event.merchantRef };
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /** Switched on AND the credentials present. One pair serves both directions. */
  payoutAvailable(): boolean {
    return NOVASEND_CONFIG.PAYOUTS_ENABLED && novasendCredentialsSet();
  }

  /** Read a sent payout back for the sweep: `GET /v1/direct/payout/{reference}`. */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    const reference = payload.reference || payload.gatewayRef;
    try {
      const record = await this.call(novasendStatusPath('payout', reference), 'GET');
      return novasendPayoutVerdict(record, payload.reference);
    } catch (error: any) {
      return {
        status: 'PENDING',
        gatewayRef: null,
        inconclusive: `NovaSend status lookup failed: ${error?.message ?? error}`,
      };
    }
  }

  /**
   * Send money: `POST /v1/direct/payout`.
   *
   * The caller's `reference` travels as `reference` AND (as a derived UUID) as the idempotency
   * key, so a retry of a payout that actually went out is recognised by NovaSend, not resent.
   * A 4xx means NovaSend refused and created nothing → `success: false`; a 409 "already processed"
   * is answered by reading the existing payout back. A 5xx or no answer THROWS: the outcome is
   * unknown and the payout stays `processing`.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const msisdn = novasendMsisdn(payload.phone);
    if (!operator || !msisdn) {
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: 'This destination number is not recognised as MTN or Orange Cameroon, which is all NovaSend can pay out to here.',
      };
    }
    const amount = Math.trunc(payload.amount);
    if (!amountWithin(NOVASEND_CM_LIMITS, amount)) {
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: `NovaSend pays out between ${NOVASEND_CM_LIMITS.min} and ${NOVASEND_CM_LIMITS.max} XAF in Cameroon; this payout is ${amount} XAF. Nothing was sent — use another payout aggregator or send it by hand.`,
      };
    }
    if (!novasendReferenceSafe(payload.reference)) {
      return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: 'This payout reference cannot be sent to NovaSend.' };
    }

    const body: Record<string, unknown> = {
      reference: payload.reference,
      customerName: payload.name?.trim() || 'Beneficiary',
      payout: { amount, msisdn, provider: novasendProvider(operator), country: 'CM' },
    };
    addSandboxScenario(body);

    let response: any;
    try {
      response = await this.call('/v1/direct/payout', 'POST', body, novasendIdempotencyKey('payout', payload.reference));
    } catch (error) {
      if (httpStatusOf(error) === 409) return this.existingPayout(payload.reference, error);
      const refusal = novasendPayoutRefusal(error);
      if (refusal) return { success: false, gatewayRef: null, status: 'FAILED', ...refusal };
      throw error;
    }

    const gatewayRef = novasendReference(response) ?? payload.reference;
    const status = normalizeNovasendStatus(response?.status);
    if (status === 'FAILED' || status === 'CANCELLED') {
      // NovaSend credits a failed payout back to the merchant wallet (its own rule), so nothing left.
      return {
        success: false,
        gatewayRef,
        status: 'FAILED',
        message: novasendFailureReason(response) ?? 'NovaSend refused the payout. Nothing was sent.',
        raw: response,
      };
    }
    return { success: true, gatewayRef, status, raw: response };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** A 409 on send: the reference is already known to NovaSend. Report what it holds. */
  private async existingPayout(reference: string, conflict: unknown): Promise<PayoutResult> {
    let record: any;
    try {
      record = await this.call(novasendStatusPath('payout', reference), 'GET');
    } catch {
      // We know it exists and cannot see how it went: unknown, so it stays processing.
      throw conflict;
    }
    const verdict = novasendPayoutVerdict(record, reference);
    if (verdict.inconclusive) throw conflict;
    if (verdict.status === 'FAILED' || verdict.status === 'CANCELLED') {
      return {
        success: false,
        gatewayRef: verdict.gatewayRef ?? reference,
        status: 'FAILED',
        message: verdict.reason ?? 'NovaSend reports this payout failed.',
        raw: record,
      };
    }
    return { success: true, gatewayRef: verdict.gatewayRef ?? reference, status: verdict.status, raw: record };
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency) || currency.toUpperCase() !== 'XAF') {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `NovaSend cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /**
   * The one outbound HTTP call, in the Campay / Fapshi idiom: native fetch + AbortController with
   * a configured timeout; non-2xx is 502, unreachable is 503. The Authorization header is never
   * copied into error details, and neither is the request body (it may carry a payment code).
   */
  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<any> {
    if (!novasendCredentialsSet()) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'NovaSend is not configured. Set NOVASEND_API_KEY and NOVASEND_API_SECRET in the environment.'
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': 'en',
      Authorization: `Basic ${Buffer.from(`${NOVASEND_CONFIG.API_KEY}:${NOVASEND_CONFIG.API_SECRET}`).toString('base64')}`,
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOVASEND_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${NOVASEND_CONFIG.BASE_URL}${path}`, {
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
        parsed = { raw: text.slice(0, 500) };
      }

      if (response.status < 200 || response.status >= 300) {
        const failure = createAppError(
          ERROR_CODES.NOVASEND_REQUEST_FAILED,
          502,
          `NovaSend ${method} ${path} answered ${response.status}`,
          { status: response.status, body: parsed }
        );
        recordIntegrationCall('novasend', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('novasend', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 above would be rewritten as a 503 here.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.NOVASEND_UNREACHABLE,
        503,
        `NovaSend ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('novasend', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for test:novasend) ───────────────────────────────

/** NovaSend's Cameroon range, the same for a pay-in and a payout (docs § Options de Paiement et Limites). */
export const NOVASEND_CM_LIMITS: CollectAmountLimits = Object.freeze({ min: 200, max: 500_000 });

/** Both halves of the credential pair are set. */
export function novasendCredentialsSet(): boolean {
  return NOVASEND_CONFIG.API_KEY !== '' && NOVASEND_CONFIG.API_SECRET !== '';
}

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
}

export function amountWithin(limits: CollectAmountLimits, amount: number): boolean {
  return Number.isFinite(amount) && amount >= limits.min && amount <= limits.max;
}

function assertWithinLimits(operator: CameroonMobileOperator, amount: number): void {
  if (amountWithin(NOVASEND_CM_LIMITS, amount)) return;
  throw createAppError(
    ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE,
    422,
    `Mobile money payments must be between ${NOVASEND_CM_LIMITS.min} and ${NOVASEND_CM_LIMITS.max} XAF right now.`,
    { provider: operator, amount, min: NOVASEND_CM_LIMITS.min, max: NOVASEND_CM_LIMITS.max, spent: false }
  );
}

function paymentCodeRequired(): AppError {
  return createAppError(
    ERROR_CODES.PAYMENT_CODE_REQUIRED,
    422,
    `To pay with Orange Money, dial ${NOVASEND_CONFIG.ORANGE_CODE_USSD} to get a payment code, then enter it and pay again.`,
    { provider: 'ORANGE', ussd: NOVASEND_CONFIG.ORANGE_CODE_USSD, spent: false }
  );
}

function paymentCodeRejected(): AppError {
  return createAppError(
    ERROR_CODES.PAYMENT_CODE_REJECTED,
    422,
    `Orange Money did not accept that payment code. Dial ${NOVASEND_CONFIG.ORANGE_CODE_USSD} for a new code and pay again. Nothing was charged.`,
    { provider: 'ORANGE', ussd: NOVASEND_CONFIG.ORANGE_CODE_USSD }
  );
}

/**
 * Did NovaSend refuse the request because of the OTP / payment code?
 *
 * Only a 4xx counts (a 5xx says nothing about the code). The documented code is
 * `transaction_otp_required`; any error code or message naming the OTP is treated the same,
 * because the docs list only the "required" case and a wrong code must not read as an outage.
 */
export function isNovasendCodeRefusal(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.NOVASEND_REQUEST_FAILED) return false;
  const details = (error.details ?? {}) as { status?: number; body?: { code?: unknown; message?: unknown } };
  if (details.status === undefined || details.status < 400 || details.status >= 500) return false;
  const words = `${String(details.body?.code ?? '')} ${String(details.body?.message ?? '')}`;
  return /otp/i.test(words);
}

/**
 * The `X-Idempotency-Key` for a write: a name-based (version 5) UUID of `<purpose>:<reference>`.
 *
 * Deterministic on purpose: a retry of the same reference MUST present the same key, or the
 * idempotency NovaSend offers protects nothing. NovaSend requires a UUID, and our `jm_…`
 * references are not one, so the reference itself cannot be the key.
 */
export function novasendIdempotencyKey(purpose: 'payin' | 'payout', reference: string): string {
  const bytes = crypto
    .createHash('sha1')
    .update(Buffer.from(NOVASEND_UUID_NAMESPACE, 'hex'))
    .update(`${purpose}:${reference}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fixed, arbitrary namespace for `novasendIdempotencyKey`. Changing it changes every key. */
const NOVASEND_UUID_NAMESPACE = '4e6f7661-5365-6e64-8a3b-6a6f76696d61'.replace(/-/g, '');

/**
 * One status table. NovaSend's words differ between pages: `processing` / `processed` /
 * `expired` (pay-in), `success` / `failed` (notification), `pending` / `completed` (refund).
 * Unknown → PENDING, never FAILED.
 */
export function normalizeNovasendStatus(raw: unknown): PaymentGatewayStatus {
  const map: Record<string, PaymentGatewayStatus> = {
    created: 'PENDING',
    initiated: 'PENDING',
    pending: 'PENDING',
    processing: 'PENDING',
    none: 'PENDING',
    accepted: 'PENDING',
    processed: 'SUCCEEDED',
    success: 'SUCCEEDED',
    successful: 'SUCCEEDED',
    succeeded: 'SUCCEEDED',
    completed: 'SUCCEEDED',
    failed: 'FAILED',
    failure: 'FAILED',
    error: 'FAILED',
    expired: 'FAILED',
    declined: 'FAILED',
    rejected: 'FAILED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
  };
  return map[String(raw ?? '').trim().toLowerCase()] ?? 'PENDING';
}

/** NovaSend's provider word for an operator. */
export function novasendProvider(operator: CameroonMobileOperator): 'MOMO' | 'ORANGE' {
  return operator === 'MTN' ? 'MOMO' : 'ORANGE';
}

/** The E.164 form NovaSend takes (`+237` + 9 digits), or null. */
export function novasendMsisdn(phone: string | null | undefined): string | null {
  const national = toCameroonNationalNumber(phone);
  return national ? `+237${national}` : null;
}

/** Fits the SDK's reference rule: 1–128 characters, no control characters. */
export function novasendReferenceSafe(value: unknown): value is string {
  // `\p{Cc}` is every control character (C0, DEL and C1), without a literal control range in the
  // pattern, which `no-control-regex` refuses.
  return typeof value === 'string' && value.trim() !== '' && value.length <= 128 && !/\p{Cc}/u.test(value);
}

/** The merchant reference a NovaSend record echoes, when it echoes one. */
function novasendReference(record: unknown): string | null {
  const value = (record as Record<string, unknown> | null)?.reference;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** NovaSend's explanation on a failed record: `failure.message`, else `failure.code`. */
export function novasendFailureReason(record: unknown): string | null {
  const failure = (record as { failure?: unknown } | null)?.failure;
  if (!failure) return null;
  if (typeof failure === 'string') return failure;
  if (typeof failure === 'object') {
    const f = failure as Record<string, unknown>;
    const text = f.message ?? f.reason ?? f.code;
    return typeof text === 'string' && text ? text : null;
  }
  return null;
}

/** The status path for a direction. Pay-ins are read without the `direct` segment (docs). */
function novasendStatusPath(direction: 'collection' | 'payout', reference: string): string {
  const ref = encodeURIComponent(reference);
  return direction === 'payout' ? `/v1/direct/payout/${ref}` : `/v1/payin/${ref}`;
}

/** `action.successUrl` / `failureUrl`, required on every pay-in. */
function novasendAction(): { successUrl: string; failureUrl: string } {
  const base = NOVASEND_CONFIG.RETURN_URL.replace(/\/+$/, '') || 'https://wi-mall.com';
  return { successUrl: `${base}/payment/success`, failureUrl: `${base}/payment/failure` };
}

/** `sandboxScenario`, only while pointed at the sandbox host. Never reaches the live API. */
function addSandboxScenario(body: Record<string, unknown>): void {
  const scenario = NOVASEND_CONFIG.SANDBOX_SCENARIO;
  if (!scenario || NOVASEND_CONFIG.BASE_URL !== NOVASEND_SANDBOX_BASE_URL) return;
  if (scenario === 'completed' || scenario === 'failed' || scenario === 'pending') body.sandboxScenario = scenario;
}

/**
 * What the client shows after a pay-in was accepted. A NovaSend `paymentUrl` becomes
 * `redirectUrl` only when NovaSend says the customer must confirm there (`confirmationRequired`):
 * a direct handset prompt also comes back with a link, and sending the customer to a web page
 * while their phone is ringing would be the wrong instruction.
 */
export function novasendInstructions(operator: CameroonMobileOperator, record: unknown): PaymentInstructions {
  const r = (record ?? {}) as Record<string, unknown>;
  const instructions: PaymentInstructions = {
    ussdCode: operator === 'MTN' ? '*126#' : '#150*50#',
    message: 'Approve the payment request on your phone by entering your mobile money PIN.',
  };
  if (r.confirmationRequired === true && typeof r.paymentUrl === 'string' && /^https:\/\//i.test(r.paymentUrl)) {
    instructions.redirectUrl = r.paymentUrl;
  }
  return instructions;
}

/** The two signature forms NovaSend's material describes: raw bytes (SDK) and re-serialised body (docs). */
export function novasendSignatureMatches(
  rawBody: Buffer,
  parsed: Record<string, unknown>,
  presented: string,
  secret: string
): boolean {
  const given = presented.trim().toLowerCase();
  const overRaw = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (timingSafeEqualString(given, overRaw)) return true;
  const overJson = crypto.createHmac('sha256', secret).update(JSON.stringify(parsed)).digest('hex');
  return timingSafeEqualString(given, overJson);
}

/**
 * A notification body or a status record, as the normalized event.
 *
 * Direction is the record's `type` (`payin` | `payout`); a `refund` record is not ours to act on
 * (the platform never calls NovaSend's refund). With no type, the caller's expected direction
 * (a confirming re-read) or our reference's kind decides. There is no reliable event id, so it is
 * derived from reference + status.
 */
export function novasendEventFrom(
  record: Record<string, unknown>,
  raw: unknown,
  expectedDirection?: 'collection' | 'payout'
): NormalizedWebhookEvent | null {
  const gatewayRef = novasendReference(record);
  if (!gatewayRef) return null;

  const type = String(record.type ?? '').trim().toLowerCase();
  if (type === 'refund') return null;
  const payout = type ? type === 'payout' : expectedDirection ? expectedDirection === 'payout' : isMoneyOutRef(gatewayRef);
  const merchantRef = merchantRefKind(gatewayRef) ? gatewayRef : null;
  const word = String(record.status ?? '').trim().toLowerCase();
  return {
    eventId: deriveEventId(['novasend', payout ? 'payout' : 'collection', gatewayRef, word]),
    eventType: `${payout ? 'transfer' : 'payment'}.${word || 'unknown'}`,
    direction: payout ? 'payout' : 'collection',
    gatewayRef,
    merchantRef,
    status: normalizeNovasendStatus(word),
    amount: typeof record.amount === 'number' || typeof record.amount === 'string' ? record.amount : null,
    currency: typeof record.currency === 'string' && record.currency ? record.currency : null,
    raw,
  };
}

/**
 * A status record, reduced to a payout verdict. Acted on only when the record proves it is THIS
 * payout: `type`, when present, must be `payout`; `reference`, when present, must be ours; and at
 * least one of the two must be present.
 */
export function novasendPayoutVerdict(record: unknown, reference: string | null): PayoutVerifyResult {
  if (!record || typeof record !== 'object') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'NovaSend returned no transaction record', raw: record };
  }
  const r = record as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type.trim().toLowerCase() : '';
  const theirs = novasendReference(r);

  if (type && type !== 'payout') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: `NovaSend record is a ${String(r.type)}, not a payout`, raw: record };
  }
  if (theirs && reference && theirs !== reference) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: `NovaSend record ${theirs} is not this payout's (${reference})`, raw: record };
  }
  if (!type && !(theirs && reference)) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'NovaSend record states neither its type nor our reference', raw: record };
  }

  const status = normalizeNovasendStatus(r.status);
  return {
    status,
    gatewayRef: theirs,
    reason: status === 'FAILED' || status === 'CANCELLED'
      ? novasendFailureReason(r) ?? `NovaSend reported ${String(r.status ?? 'failure')}`
      : null,
    raw: record,
  };
}

/**
 * A `POST /v1/direct/payout` failure that provably created nothing (a 4xx other than 409), as
 * `PayoutResult` fields. Null for anything else (5xx, unreachable): those are unknown outcomes
 * and must throw.
 */
export function novasendPayoutRefusal(error: unknown): { message: string; unsupported?: boolean } | null {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.NOVASEND_REQUEST_FAILED) return null;
  const details = (error.details ?? {}) as { status?: number; body?: { code?: unknown; message?: unknown } };
  const status = details.status;
  if (status === undefined || status < 400 || status >= 500 || status === 409) return null;
  const code = typeof details.body?.code === 'string' ? details.body.code : '';
  const said = typeof details.body?.message === 'string' ? details.body.message : '';
  const what = [code, said].filter(Boolean).join(': ');
  if (status === 401 || status === 403) {
    return {
      unsupported: true,
      message: `NovaSend refused the payout (${status}${what ? ` ${what}` : ''}). Check NOVASEND_API_KEY / NOVASEND_API_SECRET and that payouts are enabled on the NovaSend account.`,
    };
  }
  if (/not_enough_cash/i.test(code)) {
    return { message: 'The NovaSend wallet does not hold enough to send this payout. Nothing was sent; top it up and retry.' };
  }
  return { message: `NovaSend refused the payout (${status}${what ? ` ${what}` : ''}). Nothing was sent.` };
}
