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
  PaymentGatewayStatus,
  WebhookVerifyInput,
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  campayCallbackTokenValid,
  deriveEventId,
  parseRawJson,
} from '../domain/webhook-verification';
import { CAMPAY_CONFIG } from '../config/payments.config';
import { isZeroDecimalCurrency } from '../domain/money';
import {
  CameroonMobileOperator,
  resolveCameroonOperator,
  toCameroonNationalNumber,
} from '../domain/cm-operator';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * CampayGateway — mobile money (MTN / Orange Cameroon). ADR-A08 P2.1.
 *
 * API: https://documenter.getpostman.com/view/2391374/T1LV8PVA
 * base `https://www.campay.net/api` (live) · `https://demo.campay.net/api` (demo, the default)
 *
 * ── THE AUTH SCHEME IS `Token`, NOT `Bearer` ─────────────────────────────────
 * `Authorization: Token <x>`, where x is a JWT from `POST /token/` (the application's API
 * username and password) that lives `expires_in` seconds. The app's permanent token is
 * accepted only when no username is configured, because it never expires.
 *
 * ── ONE CALL CHARGES, AND THERE IS NO NETWORK FIELD ──────────────────────────
 * `POST /collect/` pushes the PIN prompt to the handset at once. Campay picks the operator
 * from the number itself; `ER102` means neither MTN nor Orange. The operator is still
 * resolved here first, so a number we cannot place is refused before anything is sent.
 * The provider/number mismatch rule has already run by then (routing service); this is a
 * second line, not the check.
 *
 * ── NUMBERS AND AMOUNTS ──────────────────────────────────────────────────────
 * Numbers are `237XXXXXXXXX` with no `+` (`ER101`). Amounts are integers, sent as strings
 * (`ER201`: "Decimal numbers are NOT allowed").
 *
 * ── NO REFUND API, NO CARD ───────────────────────────────────────────────────
 * Campay has no refund endpoint, so `refundPayment` is deliberately ABSENT (see the interface
 * header): the orchestrator's guard raises REFUND_GATEWAY_NOT_SUPPORTED and the manual path
 * takes over, as for My-CoolPay. Cards exist only behind Campay's hosted payment link and are
 * not verified for our account, so CARD is not declared.
 *
 * ⛔ ── THE CALLBACK BODY IS NOT AUTHENTICATED ─────────────────────────────────
 * The `signature` field is an HS256 JWT keyed by the webhook key, and its claims are only
 * timestamps. It proves the sender holds our key; it says nothing about the `status` or
 * `amount` beside it (`campayCallbackTokenValid`). So `confirmWebhookEvent` re-reads the
 * transaction from Campay and rebuilds the event from Campay's record, and the processor acts
 * on that, never on the callback. The callback is a doorbell.
 */
export class CampayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'CAMPAY';

  /** Both operators push a PIN prompt; Campay infers the operator from the number. ADR-A08 D-2. */
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
      const msisdn = campayMsisdn(payload.channel.phoneNumber);
      if (!operator || !msisdn) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      const response = await this.call('/collect/', 'POST', {
        amount: String(Math.trunc(payload.amount)),
        currency: payload.currency.toUpperCase(),
        from: msisdn,
        description: `Order #${payload.orderId}`,
        ...campayReferenceFields(payload.merchantRef, CAMPAY_CONFIG.REF_MODE),
      });

      const gatewayRef: string | undefined = response?.reference ? String(response.reference) : undefined;
      if (!gatewayRef) {
        return {
          success: false,
          gatewayRef: '',
          status: 'FAILED',
          error: response?.message || 'Campay did not return a transaction reference',
          rawResponse: response,
        };
      }

      return {
        success: true,
        gatewayRef,
        // `/collect/` answers no status. The documented initial state is PENDING.
        status: 'PENDING',
        instructions: {
          ussdCode: campayUssdFor(response?.ussd_code, operator),
          message: 'Approve the payment request on your phone by entering your mobile money PIN.',
        },
        rawResponse: response,
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator, provider refused or
      // unreachable) and reaches the caller as itself; anything else is a failed initiation.
      if (error instanceof AppError) throw error;
      console.error('[CampayGateway] initiatePayment error:', error?.message ?? error);
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
      const response = await this.call(`/transaction/${encodeURIComponent(payload.gatewayRef)}/`, 'GET');
      const status = normalizeCampayStatus(response?.status);
      return { success: status === 'SUCCEEDED', status, transactionDetails: response, rawResponse: response };
    } catch (error: any) {
      console.error('[CampayGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, never FAILED: a verification we could not perform says nothing about the
      // payment, and the sweep re-reads a PENDING row where it would never re-read a FAILED one.
      return { success: false, status: 'PENDING', error: error?.message || 'Verification failed', rawResponse: null };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * ⚠ The signature is INSIDE the body, so the body is parsed before it is authenticated. That
   * is the reverse of NotchPay's order and unavoidable here, and still safe: nothing parsed is
   * acted on until the token passes AND `confirmWebhookEvent` has re-read the transaction.
   *
   * The Campay application's callback must be set to POST. A GET callback carries its fields in
   * the query string, the raw-body mount receives nothing, and every callback is `unparsable`.
   */
  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const key = CAMPAY_CONFIG.WEBHOOK_KEY;
    // Refuse, never skip.
    if (!key) return { ok: false, reason: 'missing_secret' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }
    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };

    const signature = parsed.value.signature;
    if (typeof signature !== 'string' || signature.trim() === '') {
      return { ok: false, reason: 'missing_signature' };
    }
    if (!campayCallbackTokenValid(signature, key)) {
      return { ok: false, reason: 'bad_signature' };
    }

    return { ok: true, payload: parsed.value, rawBody: input.rawBody };
  }

  /**
   * The CALLBACK's claims, read into the normalized shape. For Campay these are never acted on
   * as they stand: the processor passes the result through `confirmWebhookEvent` first.
   */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    return campayEventFrom(payload, payload);
  }

  /**
   * Replace a callback's claims with Campay's own record of the transaction (ADR-A08 P2.0).
   *
   * - Campay's answer supplies the status, amount and currency; the callback supplies nothing
   *   but the reference to look up.
   * - Returns null when Campay's record contradicts the callback about WHICH transaction this
   *   is (reference, merchant reference or direction), or when Campay does not know the
   *   reference at all. That is a forged or crossed body, refused rather than half-applied.
   * - Any other failure THROWS, so the route answers 5xx and the reconciliation sweep
   *   (`settlesAsync: true`) remains the backstop.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    let record: any;
    try {
      record = await this.call(`/transaction/${encodeURIComponent(event.gatewayRef)}/`, 'GET');
    } catch (error) {
      const status = error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
      if (status === 404) return null;
      throw error;
    }

    const confirmed = campayEventFrom(record ?? {}, { callback: event.raw, confirmed: record });
    if (!confirmed) return null;
    if (confirmed.gatewayRef !== event.gatewayRef) return null;
    if (confirmed.direction !== event.direction) return null;
    if (event.merchantRef && confirmed.merchantRef && confirmed.merchantRef !== event.merchantRef) return null;

    return { ...confirmed, merchantRef: confirmed.merchantRef ?? event.merchantRef };
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /**
   * Is sending switched on for this deployment? The Campay application must ALSO allow API
   * withdrawals in its settings, which is invisible from here; a refusal for that reason comes
   * back per call as `unsupported` (`payoutBlockedReason`).
   */
  payoutAvailable(): boolean {
    return CAMPAY_CONFIG.PAYOUTS_ENABLED;
  }

  /**
   * The float a payout can be drawn from.
   *
   * ⚠ Campay holds its float PER CARRIER (`mtn_balance`, `orange_balance`), and a withdrawal
   * draws only on the destination's carrier (`ER301`). So with a destination this reports THAT
   * carrier's float. Without one it reports the total, which is an account-level figure and can
   * overstate what any single payout can use. `createPayout` still maps ER301 to a message that
   * names the carrier, because the balance can move between this read and the send.
   */
  async payoutBalance(currency: string, destinationPhone?: string): Promise<PayoutBalance | null> {
    if (currency.toUpperCase() !== 'XAF') return null;
    const response = await this.call('/balance/', 'GET');
    const operator = destinationPhone ? resolveCameroonOperator(destinationPhone) : null;
    const raw =
      operator === 'MTN'
        ? response?.mtn_balance
        : operator === 'ORANGE'
          ? response?.orange_balance
          : response?.total_balance;
    const available = Number(raw);
    return Number.isFinite(available) ? { available, currency: 'XAF' } : null;
  }

  /**
   * Send money to a beneficiary: `POST /withdraw/`, one call.
   *
   * `reference` is the caller's and is never minted here. It travels as `external_reference`,
   * which Campay documents as idempotent: a retry carrying the same reference gets the first
   * attempt's result back rather than a second transfer. The full `jm_po_…` also travels in
   * `external_user`, which is what the payout callback is routed on.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const msisdn = campayMsisdn(payload.phone);
    if (!operator || !msisdn) {
      // Not a refusal by Campay: we cannot place the number, and guessing sends somebody's
      // money down the wrong rail.
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: 'This destination number is not recognised as MTN or Orange Cameroon, which is all Campay can pay out to.',
      };
    }

    try {
      const response = await this.call('/withdraw/', 'POST', {
        amount: String(Math.trunc(payload.amount)),
        to: msisdn,
        description: payload.description ?? 'Payout',
        ...campayReferenceFields(payload.reference, CAMPAY_CONFIG.REF_MODE),
      });
      const status = normalizeCampayStatus(response?.status ?? 'PENDING');
      return {
        success: status !== 'FAILED' && status !== 'CANCELLED',
        gatewayRef: response?.reference ? String(response.reference) : null,
        status,
        message: status === 'FAILED' ? String(response?.reason ?? response?.message ?? 'FAILED') : undefined,
        raw: response,
      };
    } catch (error) {
      const blocked = payoutBlockedReason(error, operator);
      if (blocked) return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: blocked };
      throw error;
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency) || currency.toUpperCase() !== 'XAF') {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `Campay cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /**
   * A token with at least TOKEN_REFRESH_MARGIN_MS left, fetched at most once at a time. Without
   * the single flight, a burst of checkouts at expiry would mint one token each.
   */
  private async accessToken(): Promise<string> {
    if (!CAMPAY_CONFIG.USERNAME && CAMPAY_CONFIG.PERMANENT_TOKEN) return CAMPAY_CONFIG.PERMANENT_TOKEN;
    if (this.token && this.token.expiresAt - Date.now() > CAMPAY_CONFIG.TOKEN_REFRESH_MARGIN_MS) {
      return this.token.value;
    }
    if (!this.tokenInFlight) {
      this.tokenInFlight = (async () => {
        const response = await this.request('/token/', 'POST', {
          username: CAMPAY_CONFIG.USERNAME,
          password: CAMPAY_CONFIG.PASSWORD,
        });
        const value = response?.token;
        const ttlSeconds = Number(response?.expires_in);
        if (typeof value !== 'string' || value === '' || !Number.isFinite(ttlSeconds)) {
          throw createAppError(ERROR_CODES.CAMPAY_REQUEST_FAILED, 502, 'Campay /token/ returned no usable token');
        }
        this.token = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
        return value;
      })().finally(() => {
        this.tokenInFlight = null;
      });
    }
    return this.tokenInFlight;
  }

  /**
   * An authenticated call. One 401 drops the cached token and retries once: a token revoked
   * early (a password rotation) would otherwise fail every call until its nominal expiry.
   */
  private async call(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<any> {
    const hasPassword = CAMPAY_CONFIG.USERNAME !== '' && CAMPAY_CONFIG.PASSWORD !== '';
    if (!hasPassword && !CAMPAY_CONFIG.PERMANENT_TOKEN) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'Campay is not configured. Set CAMPAY_USERNAME and CAMPAY_PASSWORD in the environment.'
      );
    }
    try {
      return await this.request(path, method, body, await this.accessToken());
    } catch (error) {
      const status = error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
      if (status !== 401 || !hasPassword) throw error;
      this.token = null;
      return this.request(path, method, body, await this.accessToken());
    }
  }

  /**
   * The one outbound HTTP call, in the NotchPay idiom: native fetch + AbortController with a
   * configured timeout; non-2xx is 502, unreachable is 503. Diagnostics go in `details`, which
   * the boundary drops for every `external_service` error. The `/token/` body is never copied
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
    if (token) headers.Authorization = `Token ${token}`;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAMPAY_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${CAMPAY_CONFIG.BASE_URL}${path}`, {
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
          ERROR_CODES.CAMPAY_REQUEST_FAILED,
          502,
          `Campay ${method} ${path} answered ${response.status}`,
          { status: response.status, body: path === '/token/' ? null : parsed }
        );
        recordIntegrationCall('campay', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('campay', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 above would be rewritten as a 503 here.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.CAMPAY_UNREACHABLE,
        503,
        `Campay ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('campay', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for test:campay) ─────────────────────────────────

/**
 * One status table for this gateway, used by initiate, verify, payout and the webhook.
 * The documented words are PENDING / SUCCESSFUL / FAILED; the rest are defensive. Unknown maps
 * to PENDING, never FAILED: an unrecognised word is ignorance, and the sweep re-reads PENDING.
 */
export function normalizeCampayStatus(raw: unknown): PaymentGatewayStatus {
  const map: Record<string, PaymentGatewayStatus> = {
    pending: 'PENDING',
    processing: 'PENDING',
    successful: 'SUCCEEDED',
    success: 'SUCCEEDED',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
    canceled: 'CANCELLED',
  };
  return map[String(raw ?? '').trim().toLowerCase()] ?? 'PENDING';
}

/** `+237 6 70 00 00 00` / `670000000` / `237670000000` → `237670000000`; null when not a Cameroon mobile. */
export function campayMsisdn(phone: string | null | undefined): string | null {
  const national = toCameroonNationalNumber(phone);
  return national ? `237${national}` : null;
}

/**
 * How our reference travels (ADR-A08 P2.1 ruling).
 *
 * `external_user` ALWAYS carries the full `jm_…` reference: Campay echoes it on the callback
 * and on `/transaction/`, and routing reads it there. `external_reference` carries either the
 * same value (`raw`) or the 32 hex digits formatted as a UUID (`uuid`), for the case where
 * Campay insists on its documented UUID4 format.
 */
export function campayReferenceFields(
  merchantRef: string,
  mode: 'raw' | 'uuid'
): { external_reference: string; external_user: string } {
  if (mode !== 'uuid') return { external_reference: merchantRef, external_user: merchantRef };
  const hex = merchantRef.slice(-32).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return { external_reference: merchantRef, external_user: merchantRef };
  // Version nibble forced to 4 and variant bits to 10xx, so the value is a well-formed UUID4.
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { external_reference: uuid, external_user: merchantRef };
}

/**
 * Our reference out of a callback or a `/transaction/` record.
 *
 * `external_user` first, because it is never reformatted. Only a `jm_` value counts: Campay
 * renders an absent value as the STRING "None" in some shapes, and in `uuid` mode
 * `external_reference` is not ours in a form routing can read.
 */
export function campayMerchantRef(record: Record<string, unknown> | null | undefined): string | null {
  for (const candidate of [record?.external_user, record?.external_reference]) {
    if (typeof candidate === 'string' && candidate.startsWith('jm_')) return candidate;
  }
  return null;
}

/**
 * The USSD code to show this customer, out of Campay's `ussd_code`.
 *
 * Two shapes. The live demo (2026-09-30) answered a plain operator-specific code (`"*126#"`
 * for an MTN number). The Postman documentation shows a SENTENCE covering both operators
 * ("*126# for MTN or #150*50# for ORANGE"), which rendered as-is tells an MTN customer about
 * Orange. So a bare code passes through, a sentence yields this operator's half, and anything
 * else yields nothing.
 */
export function campayUssdFor(value: unknown, operator: CameroonMobileOperator): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (/^[*#][0-9*#]+$/.test(trimmed)) return trimmed;
  const match = trimmed.match(operator === 'MTN' ? /([*#][0-9*#]+)\s+for\s+MTN/i : /([*#][0-9*#]+)\s+for\s+ORANGE/i);
  return match?.[1];
}

/**
 * A callback body or a `/transaction/` record, reduced to the normalized event.
 *
 * - `endpoint` is the one field that says which way the money went: `collect` or `withdraw`.
 * - There is no event id, so it is derived from reference + status: stable across redeliveries
 *   of one verdict, different between PENDING and a later SUCCESSFUL.
 * - The event type is spelled `transfer.*` for a withdrawal, so it agrees with
 *   `directionOfEventType` everywhere else it is read.
 */
export function campayEventFrom(
  record: Record<string, unknown>,
  raw: unknown
): NormalizedWebhookEvent | null {
  const gatewayRef = typeof record.reference === 'string' ? record.reference.trim() : '';
  if (!gatewayRef) return null;

  const payout = String(record.endpoint ?? '').toLowerCase() === 'withdraw';
  const rawStatus = String(record.status ?? '').trim();
  return {
    eventId: deriveEventId(['campay', gatewayRef, rawStatus.toUpperCase()]),
    eventType: `${payout ? 'transfer' : 'payment'}.${rawStatus.toLowerCase() || 'unknown'}`,
    direction: payout ? 'payout' : 'collection',
    gatewayRef,
    merchantRef: campayMerchantRef(record),
    status: normalizeCampayStatus(rawStatus),
    amount: (record.amount as number | string | undefined) ?? null,
    currency: typeof record.currency === 'string' ? record.currency : null,
    raw,
  };
}

/** An `ER…` code out of a Campay error body, wherever it is carried. */
export function campayErrorCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const field of [b.error_code, b.code, b.error]) {
      if (typeof field === 'string' && /^ER\d{3}$/.test(field)) return field;
    }
  }
  const match = JSON.stringify(body ?? '').match(/\bER\d{3}\b/);
  return match ? match[0] : null;
}

/**
 * Is this failure a knowable "cannot send" rather than a fault? Matched on Campay's documented
 * error CODES rather than on HTTP status, which Campay does not document.
 */
export function payoutBlockedReason(error: unknown, operator: CameroonMobileOperator): string | null {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.CAMPAY_REQUEST_FAILED) return null;
  const details = (error.details ?? {}) as { status?: number; body?: unknown };
  const code = campayErrorCode(details.body);
  const carrier = operator === 'MTN' ? 'MTN' : 'Orange';

  if (code === 'ER301') {
    return `Campay's ${carrier} balance cannot cover this payout. Campay keeps a separate float per carrier, so its total can look sufficient while the ${carrier} float is not. Top up the ${carrier} float or pay this one by hand.`;
  }
  if (code === 'ER101' || code === 'ER102') {
    return `Campay refused the destination number (${code}): it is not a valid MTN or Orange Cameroon number.`;
  }
  if (details.status === 403) {
    return 'Campay refused the withdrawal with 403. "Allow withdrawals through the API" may be off in this application\'s Campay settings.';
  }
  return null;
}
