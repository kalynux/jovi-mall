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
 * ── LOOKUPS ARE BY NOVASEND'S OWN ID (live, 2026-11-04) ─────────────────────
 * The docs and the SDK say `GET /v1/payin/{reference}` and `GET /v1/direct/payout/{reference}`.
 * Live, on real transactions: `GET /v1/payin/{tr_ id}` and `GET /v1/payout/{tr_ id}` answer; our
 * reference is 404 on both, and `/v1/direct/payout/*` is no route at all. So `gatewayRef` is
 * NovaSend's `id`, and our `jm_…` reference is the `merchantRef`.
 * ⚠ A send whose answer we never saw has no id, so the sweep cannot read it. It stays PENDING and
 * the webhook, which carries both values, is what settles it.
 *
 * ── ORANGE IS A PUSH WITH NO CODE (live, 2026-11-04) ─────────────────────────
 * The docs and the SDK require `payin.otp`. Live, Orange Cameroon accepted a pay-in without one and
 * settled it, and no prompt reached the phone: the customer dialled `#150*50#`, saw the request and
 * entered their PIN. So a `paymentCode` a stale client still sends is never forwarded.
 *
 * ── THE NAME ON THE PHONE ────────────────────────────────────────────────────
 * The operator's screen names "Moon SARL", not Wi-Mall (the owner confirms that is correct), so every
 * instruction names it and `payeeName` carries it.
 *
 * ── LIMITS ───────────────────────────────────────────────────────────────────
 * Cameroon: 301–500,000 XAF for a pay-in and for a payout. The docs say 200; live refused 200 with
 * "supérieur à 300" and accepted 301 (300 itself is untested). Declared on the capability so routing
 * refuses an out-of-range charge before any write; a payout out of range is refused here with
 * nothing sent.
 *
 * ── THE NOTIFICATION IS SIGNED OVER THE WHOLE BODY ───────────────────────────
 * `hex(HMAC-SHA256(body, webhookSecret))`. The SDK signs the raw bytes; the docs' sample
 * re-serialises (`JSON.stringify(body)`). Both are accepted, both need the secret.
 * The header is `X-Webhook-Signature` (proven live 2026-11-04). The SDK's `X-Signature-Value` is
 * still read, and the one that verified is logged by name.
 * `confirmWebhookEvent` still re-reads NovaSend's record: the status vocabulary differs between
 * pages (`success` / `processed` / `failed` / `expired`), and the record is what is acted on.
 *
 * ── NO REFUND, NO BALANCE ────────────────────────────────────────────────────
 * `refundPayment` is deliberately ABSENT: NovaSend's refund has no amount field, and a
 * mobile-money refund on this platform is a PAYOUT (REFUND-FLOW-PLAN R-1). No balance endpoint is
 * documented, so `payoutBalance` is absent too.
 *
 * ⚠ ── WHAT REMAINS OPEN ───────────────────────────────────────────────────────
 * - the payout body key: the docs' `payout: {…}` is right (proven live); the SDK's `payin` is not.
 * - who pays the fee: live, a pay-in's `amount` and `chargedAmount` match and the fee comes out of
 *   what reaches the wallet; a payout's fee is added to what the wallet pays. We compare `amount`.
 * - NovaSend's prefix table calls 685-689 MTN; ours (`cm-operator.ts`) says Orange and stays
 *   authoritative. Untested live. It also lists only 699 of 690-699, and live accepted 691.
 */
export class NovaSendGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'NOVASEND';

  /** Both are charged with a number alone. MTN's prompt arrives; Orange's customer dials for it. */
  readonly capabilities: GatewayCapabilities = Object.freeze({
    collect: Object.freeze({
      MTN: Object.freeze({
        flow: 'PUSH' as const,
        requires: Object.freeze(['phoneNumber' as const]),
        limits: NOVASEND_CM_LIMITS,
      }),
      ORANGE: Object.freeze({
        flow: 'PUSH' as const,
        requires: Object.freeze(['phoneNumber' as const]),
        limits: NOVASEND_CM_LIMITS,
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

      const payin: Record<string, unknown> = {
        amount,
        msisdn,
        provider: novasendProvider(operator),
        country: 'CM',
      };

      const body: Record<string, unknown> = {
        reference: payload.merchantRef,
        customerName: payload.channel.customerName?.trim() || 'Client',
        payin,
        action: novasendAction(),
      };
      addSandboxScenario(body);

      const response: any = await this.call('/v1/direct/payin', 'POST', body, novasendIdempotencyKey('payin', payload.merchantRef));

      const gatewayRef = novasendLookupRef(response) ?? (response && typeof response === 'object' ? payload.merchantRef : null);
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
      // A typed error is a decision (unsupported currency, unknown operator, an out-of-range amount,
      // provider refused or unreachable) and reaches the caller as itself.
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

    const presented = NOVASEND_SIGNATURE_HEADERS.flatMap((name) => {
      const value = headerValue(input.headers, [name]);
      return value ? [{ name, value }] : [];
    });
    if (presented.length === 0) return { ok: false, reason: 'missing_signature' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };

    const rawBody = input.rawBody;
    const verifiedOn = presented.find((p) => novasendSignatureMatches(rawBody, parsed.value, p.value, secret));
    if (!verifiedOn) {
      return { ok: false, reason: 'bad_signature', detail: `presented on ${presented.map((p) => p.name).join(', ')}` };
    }
    // The header NAME only, never its value: this line is what settles which one live really sends.
    console.info(`[NOVASENDWebhook] signature verified on ${verifiedOn.name}`);
    return { ok: true, payload: parsed.value, rawBody };
  }

  /** The notification's claims. Re-read through `confirmWebhookEvent` before anything acts on them. */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    return novasendEventFrom(payload, payload);
  }

  /**
   * Replace a notification's claims with NovaSend's own record (ADR-A08 P2.0), read on the
   * endpoint of the direction the notification states. The record must name the same reference
   * and direction, or the answer is null. 404 → null (NovaSend does not know it, or a notification
   * carried no `id`, so the stored id and the sweep settle it); any other failure THROWS, so the
   * route answers 5xx and the reconciliation sweep is the backstop.
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

  /**
   * Read a sent payout back for the sweep: `GET /v1/payout/{id}`. With no stored id (a send whose
   * answer we never saw) the reference is tried, is 404 today, and the payout stays PENDING.
   */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    const lookup = payload.gatewayRef || payload.reference || '';
    try {
      const record = await this.call(novasendStatusPath('payout', lookup), 'GET');
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

    const gatewayRef = novasendLookupRef(response) ?? payload.reference;
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

  /**
   * A 409 on send: the reference is already known to NovaSend. Report what it holds, if it can be
   * read. We hold no id here and the reference is 404 today, so this normally throws the conflict:
   * unknown, the payout stays processing, and the webhook settles it. It never sends twice.
   */
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

/** NovaSend's Cameroon range for a pay-in and a payout: the docs' maximum, and the lowest amount seen to work live. */
export const NOVASEND_CM_LIMITS: CollectAmountLimits = Object.freeze({ min: 301, max: 500_000 });

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

/** NovaSend's own transaction id: the only value its status routes answer to (live, 2026-11-04). */
function novasendId(record: unknown): string | null {
  const value = (record as Record<string, unknown> | null)?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** What a record is looked up by: its id, else (a record without one) our reference. */
function novasendLookupRef(record: unknown): string | null {
  return novasendId(record) ?? novasendReference(record);
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

/** The status path for a direction. Neither has a `direct` segment: `/v1/direct/payout/*` is no route on live. */
function novasendStatusPath(direction: 'collection' | 'payout', lookup: string): string {
  const ref = encodeURIComponent(lookup);
  return direction === 'payout' ? `/v1/payout/${ref}` : `/v1/payin/${ref}`;
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
/** The name the operators show the customer. Correct, per the owner (2026-11-04). */
export const NOVASEND_PAYEE_NAME = 'Moon SARL';

export function novasendInstructions(operator: CameroonMobileOperator, record: unknown): PaymentInstructions {
  const r = (record ?? {}) as Record<string, unknown>;
  const ussdCode = operator === 'MTN' ? '*126#' : '#150*50#';
  const instructions: PaymentInstructions = {
    ussdCode,
    payeeName: NOVASEND_PAYEE_NAME,
    // French first, and both languages, because the bot relays this as written. Keep it under its
    // 200-character clip (`INSTRUCTION_CLIP`); test:novasend asserts that.
    message: operator === 'MTN'
      ? `Confirmez la demande de ${NOVASEND_PAYEE_NAME} avec votre code secret. Sinon, composez ${ussdCode}. / Confirm the request from ${NOVASEND_PAYEE_NAME} with your PIN. If none appears, dial ${ussdCode}.`
      : `Composez ${ussdCode}, vérifiez que la demande vient de ${NOVASEND_PAYEE_NAME}, puis entrez votre code secret. / Dial ${ussdCode}, check the request is from ${NOVASEND_PAYEE_NAME}, then enter your PIN.`,
  };
  if (r.confirmationRequired === true && typeof r.paymentUrl === 'string' && /^https:\/\//i.test(r.paymentUrl)) {
    instructions.redirectUrl = r.paymentUrl;
  }
  return instructions;
}

/** The two signature forms NovaSend's material describes: raw bytes (SDK) and re-serialised body (docs). */
export const NOVASEND_SIGNATURE_HEADERS = Object.freeze(['x-signature-value', 'x-webhook-signature'] as const);

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
  const reference = novasendReference(record);
  if (!reference) return null;
  const gatewayRef = novasendId(record) ?? reference;

  const type = String(record.type ?? '').trim().toLowerCase();
  if (type === 'refund') return null;
  const payout = type ? type === 'payout' : expectedDirection ? expectedDirection === 'payout' : isMoneyOutRef(reference);
  const merchantRef = merchantRefKind(reference) ? reference : null;
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
    gatewayRef: novasendId(r) ?? theirs,
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
  // NovaSend answers most refusals with 403 (docs § Erreurs Globales), a short wallet included,
  // so the documented code decides, not the status. The SDK reads the code out of `message`.
  if (/not_enough_cash/i.test(what)) {
    return { message: 'The NovaSend wallet does not hold enough to send this payout. Nothing was sent; top it up and retry.' };
  }
  if (status === 401 || /api_token_|client_kyc_not_approved/i.test(what)) {
    return {
      unsupported: true,
      message: `NovaSend refused the payout (${status}${what ? ` ${what}` : ''}). Check NOVASEND_API_KEY / NOVASEND_API_SECRET and that payouts are enabled on the NovaSend account.`,
    };
  }
  return { message: `NovaSend refused the payout (${status}${what ? ` ${what}` : ''}). Nothing was sent.` };
}
