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
  headerValue,
  parseRawJson,
  timingSafeEqualString,
} from '../domain/webhook-verification';
import { FAPSHI_CONFIG } from '../config/payments.config';
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
 * FapshiGateway — mobile money (MTN / Orange Cameroon).
 *
 * Source: docs.fapshi.com (pages + OpenAPI spec, read 2026-10-02) and github.com/Fapshi/SDKs.
 * base `https://live.fapshi.com` (live) · `https://sandbox.fapshi.com` (sandbox, the default)
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────────
 * `apiuser` + `apikey` HEADERS on every call; no token exchange. Errors are 4xx with a
 * `{ message }` body (400 bad request, 403 bad credentials OR an IP not on the whitelist,
 * 404 not found, 429 rate limit).
 *
 * ── TWO SERVICES, TWO CREDENTIAL PAIRS ───────────────────────────────────────
 * A Fapshi service either collects or pays out, never both. So collections use the collection
 * pair and payouts (send, balance, status) the disbursement pair. A status lookup is made with
 * the pair of the service the transaction belongs to.
 *
 * ── ONE CALL CHARGES ─────────────────────────────────────────────────────────
 * `POST /direct-pay` pushes the PIN prompt. Phone is the 9-digit national number; `medium` is
 * `mobile money` (MTN) or `orange money`. Our full `jm_…` reference fits `externalId`
 * (1–100 of `[a-zA-Z0-9_-]`), so it travels unchanged. ⚠ Direct pay is DISABLED on a live
 * service until Fapshi support enables it.
 *
 * ── NO REFUND API, NO CARD ───────────────────────────────────────────────────
 * `refundPayment` is deliberately ABSENT (see the interface header).
 *
 * ⛔ ── THE CALLBACK IS AUTHENTICATED BY A STATIC SECRET, NOT A SIGNATURE ──────
 * `x-wh-secret` carries the secret set on the dashboard, verbatim. It proves the sender knows
 * the secret; it covers nothing in the body. So `confirmWebhookEvent` re-reads
 * `GET /payment-status/{transId}` and only Fapshi's record is acted on (Fapshi's own SDK webhook
 * example does exactly this). Fapshi sends each callback ONCE and never retries, so a callback
 * lost to an outage is recovered by the reconciliation sweep alone.
 *
 * ⚠ ── PAYOUTS HAVE NO DOCUMENTED IDEMPOTENCY ─────────────────────────────────
 * Nothing says a repeated `externalId` is refused. So `createPayout` first asks
 * `GET /transaction/{userId}` (our payout reference IS the userId) whether this payout was
 * already sent, and resends only when every earlier attempt FAILED.
 */
export class FapshiGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'FAPSHI';

  /** Both operators push a PIN prompt (`/direct-pay`). ADR-A08 D-2. */
  readonly capabilities: GatewayCapabilities = Object.freeze({
    collect: Object.freeze({
      MTN: Object.freeze({ flow: 'PUSH' as const, requires: Object.freeze(['phoneNumber' as const]) }),
      ORANGE: Object.freeze({ flow: 'PUSH' as const, requires: Object.freeze(['phoneNumber' as const]) }),
    }),
    settlesAsync: true,
  });

  /** Recent PENDING status answers, keyed by transId. See `FAPSHI_CONFIG.STATUS_CACHE_MS`. */
  private readonly pendingStatus = new Map<string, { at: number; record: any }>();

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      const operator = resolveCameroonOperator(payload.channel.phoneNumber, payload.channel.phoneOperator);
      const phone = toCameroonNationalNumber(payload.channel.phoneNumber);
      if (!operator || !phone) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      const body: Record<string, unknown> = {
        amount: Math.trunc(payload.amount),
        phone,
        medium: fapshiMedium(operator),
        externalId: payload.merchantRef,
        message: `Order #${payload.orderId}`,
      };
      if (fapshiIdSafe(payload.userId)) body.userId = payload.userId;
      const name = payload.channel.customerName?.trim();
      if (name) body.name = name;
      const email = payload.channel.customerEmail?.trim();
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) body.email = email;

      const response = await this.call('collection', '/direct-pay', 'POST', body);
      const gatewayRef = typeof response?.transId === 'string' ? response.transId : '';
      if (!gatewayRef) {
        return {
          success: false,
          gatewayRef: '',
          status: 'FAILED',
          error: response?.message || 'Fapshi did not return a transaction id',
          rawResponse: response,
        };
      }

      return {
        success: true,
        gatewayRef,
        // `/direct-pay` answers no status; a direct payment ends SUCCESSFUL or FAILED later.
        status: 'PENDING',
        instructions: {
          ussdCode: operator === 'MTN' ? '*126#' : '#150*50#',
          message: 'Approve the payment request on your phone by entering your mobile money PIN.',
        },
        rawResponse: response,
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator, provider refused or
      // unreachable) and reaches the caller as itself; anything else is a failed initiation.
      if (error instanceof AppError) throw error;
      console.error('[FapshiGateway] initiatePayment error:', error?.message ?? error);
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
      const record = await this.status('collection', payload.gatewayRef, true);
      const status = normalizeFapshiStatus(record?.status);
      return { success: status === 'SUCCEEDED', status, transactionDetails: record, rawResponse: record };
    } catch (error: any) {
      console.error('[FapshiGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, never FAILED: a verification we could not perform (a 429 included) says nothing
      // about the payment, and the sweep re-reads a PENDING row where it would never re-read a FAILED one.
      return { success: false, status: 'PENDING', error: error?.message || 'Verification failed', rawResponse: null };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const secret = FAPSHI_CONFIG.WEBHOOK_SECRET;
    // Refuse, never skip.
    if (!secret) return { ok: false, reason: 'missing_secret' };

    const presented = headerValue(input.headers, ['x-wh-secret']);
    if (!presented) return { ok: false, reason: 'missing_signature' };
    if (!timingSafeEqualString(presented, secret)) return { ok: false, reason: 'bad_signature' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };
    return { ok: true, payload: parsed.value, rawBody: input.rawBody };
  }

  /**
   * The CALLBACK's claims. Its body is a payment-status record. Never acted on as it stands:
   * the processor passes it through `confirmWebhookEvent` first.
   */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    return fapshiEventFrom(payload, payload);
  }

  /**
   * Replace a callback's claims with Fapshi's own record (ADR-A08 P2.0), read with the pair of
   * the service the callback says it belongs to. The record must name the same transId, the
   * same direction and (when it states one) the same externalId, or the answer is null.
   *
   * 404 → null (Fapshi does not know it). Any other failure THROWS, so the route answers 5xx;
   * Fapshi will not retry, so the reconciliation sweep is what settles it after an outage.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    let record: any;
    try {
      record = await this.status(event.direction === 'payout' ? 'payout' : 'collection', event.gatewayRef, false);
    } catch (error) {
      // Measured on the sandbox 2026-10-02: an unknown but well-formed transId is 404 "Resource
      // not found"; a malformed one is 400 "Invalid request URL". Neither is a transaction of ours.
      const status = httpStatusOf(error);
      if (status === 404 || status === 400) return null;
      throw error;
    }

    const confirmed = fapshiEventFrom(record ?? {}, { callback: event.raw, confirmed: record });
    if (!confirmed) return null;
    if (confirmed.gatewayRef !== event.gatewayRef) return null;
    if (confirmed.direction !== event.direction) return null;
    if (event.merchantRef && confirmed.merchantRef && confirmed.merchantRef !== event.merchantRef) return null;

    return { ...confirmed, merchantRef: confirmed.merchantRef ?? event.merchantRef };
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /** Switched on AND a disbursement service configured. Fapshi's own live activation is invisible here. */
  payoutAvailable(): boolean {
    return FAPSHI_CONFIG.PAYOUTS_ENABLED && fapshiPayoutCredentialsSet();
  }

  /** The disbursement service's balance, `GET /balance`. (Random in the sandbox, per Fapshi.) */
  async payoutBalance(currency: string): Promise<PayoutBalance | null> {
    if (currency.toUpperCase() !== 'XAF') return null;
    const response = await this.call('payout', '/balance', 'GET');
    const available = Number(response?.balance);
    return Number.isFinite(available) ? { available, currency: 'XAF' } : null;
  }

  /** Read a sent payout back for the sweep: `GET /payment-status/{transId}` on the payout service. */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    try {
      const record = await this.status('payout', payload.gatewayRef, false);
      return fapshiPayoutVerdict(record, payload.reference);
    } catch (error: any) {
      return {
        status: 'PENDING',
        gatewayRef: null,
        inconclusive: `Fapshi status lookup failed: ${error?.message ?? error}`,
      };
    }
  }

  /**
   * Send money: `POST /payout` on the disbursement service.
   *
   * `reference` is the caller's and travels as BOTH `userId` and `externalId`. Because Fapshi
   * documents no idempotency, the earlier attempts are looked up first (`GET /transaction/{userId}`):
   *   - one that succeeded or is still moving → report it, send nothing;
   *   - none, or only failed ones → send;
   *   - the lookup itself failed → send NOTHING and say so (`success: false`, retryable),
   *     because a resend we cannot rule out is how a payout is paid twice.
   * A 4xx from `POST /payout` means Fapshi refused the request and created nothing. A 5xx or no
   * answer THROWS: the outcome is unknown and the payout stays `processing`.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const phone = toCameroonNationalNumber(payload.phone);
    if (!operator || !phone) {
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: 'This destination number is not recognised as MTN or Orange Cameroon, which is all Fapshi can pay out to here.',
      };
    }
    if (!fapshiIdSafe(payload.reference)) {
      return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: 'This payout reference cannot be sent to Fapshi.' };
    }

    let earlier: any[];
    try {
      earlier = await this.payoutsFor(payload.reference);
    } catch (error: any) {
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        message: `Could not check Fapshi for an earlier send of this payout (${error?.message ?? error}). Nothing was sent; retry.`,
      };
    }
    const live = earlier.find((r) => normalizeFapshiStatus(r?.status) !== 'FAILED');
    if (live) {
      const status = normalizeFapshiStatus(live.status);
      return { success: true, gatewayRef: String(live.transId), status, raw: live };
    }

    try {
      const response = await this.call('payout', '/payout', 'POST', {
        amount: Math.trunc(payload.amount),
        phone,
        medium: fapshiMedium(operator),
        name: payload.name,
        userId: payload.reference,
        externalId: payload.reference,
        message: payload.description ?? 'Payout',
      });
      const gatewayRef = typeof response?.transId === 'string' && response.transId ? response.transId : null;
      if (!gatewayRef) {
        // Accepted-looking with nothing to track: the outcome is unknown, so it stays processing.
        throw createAppError(ERROR_CODES.FAPSHI_REQUEST_FAILED, 502, 'Fapshi accepted a payout without a transId', { body: response });
      }
      return { success: true, gatewayRef, status: 'PENDING', raw: response };
    } catch (error) {
      const refusal = fapshiPayoutRefusal(error);
      if (refusal) return { success: false, gatewayRef: null, status: 'FAILED', ...refusal };
      throw error;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Earlier payouts for this reference, newest first. A 404 is "none". */
  private async payoutsFor(reference: string): Promise<any[]> {
    try {
      const list = await this.call('payout', `/transaction/${encodeURIComponent(reference)}`, 'GET');
      const records = Array.isArray(list) ? list : [];
      return records.filter((r) => r && typeof r === 'object' && (r.externalId === undefined || r.externalId === reference));
    } catch (error) {
      if (httpStatusOf(error) === 404) return [];
      throw error;
    }
  }

  /** A payment-status read; a PENDING answer is reused briefly when `cached` (see STATUS_CACHE_MS). */
  private async status(service: FapshiService, transId: string, cached: boolean): Promise<any> {
    const now = Date.now();
    if (cached) {
      const hit = this.pendingStatus.get(transId);
      if (hit && now - hit.at < FAPSHI_CONFIG.STATUS_CACHE_MS) return hit.record;
    }
    const record = await this.call(service, `/payment-status/${encodeURIComponent(transId)}`, 'GET');
    if (normalizeFapshiStatus(record?.status) === 'PENDING') {
      this.pendingStatus.set(transId, { at: now, record });
      if (this.pendingStatus.size > 1000) {
        for (const [key, value] of this.pendingStatus) {
          if (now - value.at >= FAPSHI_CONFIG.STATUS_CACHE_MS) this.pendingStatus.delete(key);
        }
      }
    } else {
      this.pendingStatus.delete(transId);
    }
    return record;
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency) || currency.toUpperCase() !== 'XAF') {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `Fapshi cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /**
   * The one outbound HTTP call, in the Campay idiom: native fetch + AbortController with a
   * configured timeout; non-2xx is 502, unreachable is 503. The credential headers are never
   * copied into error details.
   */
  private async call(
    service: FapshiService,
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<any> {
    const credentials = fapshiCredentials(service);
    if (!credentials) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        service === 'payout'
          ? 'Fapshi payouts are not configured. Set FAPSHI_PAYOUT_API_USER and FAPSHI_PAYOUT_API_KEY.'
          : 'Fapshi is not configured. Set FAPSHI_API_USER and FAPSHI_API_KEY in the environment.'
      );
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      apiuser: credentials.user,
      apikey: credentials.key,
    };
    // Fapshi refuses a GET that carries a body, so only a POST gets one.
    if (body) headers['Content-Type'] = 'application/json';

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FAPSHI_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${FAPSHI_CONFIG.BASE_URL}${path}`, {
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
          ERROR_CODES.FAPSHI_REQUEST_FAILED,
          502,
          `Fapshi ${method} ${path} answered ${response.status}`,
          { status: response.status, body: parsed }
        );
        recordIntegrationCall('fapshi', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('fapshi', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 above would be rewritten as a 503 here.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.FAPSHI_UNREACHABLE,
        503,
        `Fapshi ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('fapshi', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for test:fapshi) ─────────────────────────────────

type FapshiService = 'collection' | 'payout';

/** The disbursement pair is set (both halves). */
export function fapshiPayoutCredentialsSet(): boolean {
  return FAPSHI_CONFIG.PAYOUT_API_USER !== '' && FAPSHI_CONFIG.PAYOUT_API_KEY !== '';
}

/**
 * The pair for a service. A payout read falls back to the collection pair only when no
 * disbursement pair exists, so a deployment without payouts can still look up a payout id.
 */
function fapshiCredentials(service: FapshiService): { user: string; key: string } | null {
  if (service === 'payout' && fapshiPayoutCredentialsSet()) {
    return { user: FAPSHI_CONFIG.PAYOUT_API_USER, key: FAPSHI_CONFIG.PAYOUT_API_KEY };
  }
  if (service === 'payout') return null;
  return FAPSHI_CONFIG.API_USER && FAPSHI_CONFIG.API_KEY ? { user: FAPSHI_CONFIG.API_USER, key: FAPSHI_CONFIG.API_KEY } : null;
}

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
}

/**
 * One status table. Fapshi's words are CREATED / PENDING / SUCCESSFUL / FAILED / EXPIRED. A
 * direct payment never EXPIRES (Fapshi: it ends SUCCESSFUL or FAILED); EXPIRED is mapped to FAILED
 * for completeness. Unknown → PENDING, never FAILED.
 */
export function normalizeFapshiStatus(raw: unknown): PaymentGatewayStatus {
  const map: Record<string, PaymentGatewayStatus> = {
    CREATED: 'PENDING',
    PENDING: 'PENDING',
    SUCCESSFUL: 'SUCCEEDED',
    FAILED: 'FAILED',
    EXPIRED: 'FAILED',
  };
  return map[String(raw ?? '').trim().toUpperCase()] ?? 'PENDING';
}

/** Fapshi's `medium` for an operator. */
export function fapshiMedium(operator: CameroonMobileOperator): 'mobile money' | 'orange money' {
  return operator === 'MTN' ? 'mobile money' : 'orange money';
}

/** Does this value fit Fapshi's `userId` / `externalId` rule (1–100 of `[a-zA-Z0-9_-]`)? */
export function fapshiIdSafe(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

/** Our `jm_…` reference out of a record's `externalId`. Only a `jm_` value counts. */
export function fapshiMerchantRef(record: Record<string, unknown> | null | undefined): string | null {
  const value = record?.externalId;
  return typeof value === 'string' && merchantRefKind(value) ? value : null;
}

/**
 * A callback body or a payment-status record, as the normalized event.
 *
 * Direction is `transType` (`Payout` | `Collection`). When it is absent, our reference's kind
 * decides (`po` = payout). There is no event id, so it is derived from transId + status.
 */
export function fapshiEventFrom(record: Record<string, unknown>, raw: unknown): NormalizedWebhookEvent | null {
  const gatewayRef = typeof record.transId === 'string' ? record.transId.trim() : '';
  if (!gatewayRef) return null;

  const merchantRef = fapshiMerchantRef(record);
  const transType = String(record.transType ?? '').trim().toLowerCase();
  // With no transType, `po` (a payout) AND `rf` (a refund sent as a transfer) are money out.
  const payout = transType ? transType === 'payout' : isMoneyOutRef(merchantRef);
  const word = String(record.status ?? '').trim().toUpperCase();
  return {
    eventId: deriveEventId(['fapshi', gatewayRef, word]),
    eventType: `${payout ? 'transfer' : 'payment'}.${word.toLowerCase() || 'unknown'}`,
    direction: payout ? 'payout' : 'collection',
    gatewayRef,
    merchantRef,
    status: normalizeFapshiStatus(word),
    amount: typeof record.amount === 'number' || typeof record.amount === 'string' ? record.amount : null,
    // Fapshi is XAF-only and its records carry no currency field.
    currency: null,
    raw,
  };
}

/**
 * A payment-status record, reduced to a payout verdict. Acted on only when the record proves it
 * is THIS payout: `transType`, when present, must be `Payout`; `externalId`, when present, must
 * be our reference; and at least one of the two must be present.
 */
export function fapshiPayoutVerdict(record: unknown, reference: string | null): PayoutVerifyResult {
  if (!record || typeof record !== 'object') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'Fapshi returned no transaction record', raw: record };
  }
  const r = record as Record<string, unknown>;
  const transType = typeof r.transType === 'string' ? r.transType.trim().toLowerCase() : '';
  const ours = typeof r.externalId === 'string' ? r.externalId : null;

  if (transType && transType !== 'payout') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: `Fapshi record is a ${String(r.transType)}, not a payout`, raw: record };
  }
  if (ours && reference && ours !== reference) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: `Fapshi record ${ours} is not this payout's (${reference})`, raw: record };
  }
  if (!transType && !(ours && reference)) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'Fapshi record states neither its type nor our reference', raw: record };
  }

  const status = normalizeFapshiStatus(r.status);
  return {
    status,
    gatewayRef: typeof r.transId === 'string' && r.transId ? r.transId : null,
    reason: status === 'FAILED' ? String(r.reason ?? `Fapshi reported ${String(r.status ?? 'failure')}`) : null,
    raw: record,
  };
}

/**
 * A `POST /payout` failure that provably created nothing (any 4xx), as `PayoutResult` fields.
 * Null for anything else (5xx, unreachable): those are unknown outcomes and must throw.
 */
export function fapshiPayoutRefusal(error: unknown): { message: string; unsupported?: boolean } | null {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.FAPSHI_REQUEST_FAILED) return null;
  const details = (error.details ?? {}) as { status?: number; body?: { message?: unknown } };
  const status = details.status;
  if (status === undefined || status < 400 || status >= 500) return null;
  const said = typeof details.body?.message === 'string' ? details.body.message : '';
  if (status === 403) {
    return {
      unsupported: true,
      message: `Fapshi refused the payout (403${said ? `: ${said}` : ''}). Either payouts are not yet enabled on the live disbursement service, the credentials are wrong, or this server's IP is not on the service's whitelist.`,
    };
  }
  if (status === 429) return { message: 'Fapshi rate-limited the payout request (429). Nothing was sent; retry shortly.' };
  return { message: `Fapshi refused the payout (${status}${said ? `: ${said}` : ''}). Nothing was sent.` };
}
