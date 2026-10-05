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
import { PAWAPAY_CONFIG } from '../config/payments.config';
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
 * PawaPayGateway — mobile money (MTN / Orange Cameroon), collections and payouts.
 *
 * Source: PawaPay's OpenAPI v2 (`docs.pawapay.io/v2/api-reference/openapi_v2.yaml`) and the v2
 * guides, read 2026-10-05. Where the two disagree the SPEC wins: the payouts guide's second
 * example sends `payer`, the spec (and its first example) `recipient`.
 * base `https://api.pawapay.io` (live) · `https://api.sandbox.pawapay.io` (sandbox, the default)
 *
 * ── AUTH ─────────────────────────────────────────────────────────────────────
 * `Authorization: Bearer <token>` on every call; one token serves collections AND payouts. Going
 * live changes the base URL and the token, nothing else.
 *
 * ── OUR ID IS A UUID DERIVED FROM OUR REFERENCE ──────────────────────────────
 * PawaPay requires the MERCHANT to mint `depositId` / `payoutId` as a UUIDv4, and deduplicates on
 * it (`DUPLICATE_IGNORED`). Our `jm_…` reference is not a UUID, so the id is a v4-shaped hash of
 * it (`pawapayPaymentId`). A retry of the same reference presents the same id and cannot charge
 * or pay twice. The id is the `gatewayRef` we store; our reference travels as
 * `clientReferenceId` AND as `metadata.jmRef`, because a CALLBACK carries metadata but not
 * `clientReferenceId`, and the processor needs our reference from both the callback and the re-read.
 *
 * ⚠ A payout that FAILED at PawaPay keeps its id forever, and resending it answers
 * `DUPLICATE_IGNORED`. So a retry walks to the next derived id (`attempt` 1, 2, …) — but only
 * after reading the previous one back as FAILED, which is final. See `createPayout`.
 *
 * ── CAMEROON ─────────────────────────────────────────────────────────────────
 * `MTN_MOMO_CMR` and `ORANGE_CMR`, XAF, both `PROVIDER_AUTH` (a PIN prompt), no decimals. Our
 * `cm-operator.ts` decides the operator, not PawaPay's `predict-provider`.
 *
 * ⛔ ── CALLBACKS MUST BE SIGNED, AND ARE STILL RE-READ ───────────────────────
 * Owner decision 2026-10-05: signed callbacks are switched on in the PawaPay dashboard, and an
 * unsigned callback is REFUSED. The signature is RFC 9421 (`Signature`, `Signature-Input`,
 * `Content-Digest`), checked against PawaPay's public key (`GET /v2/public-key/http`). That
 * check is synchronous, so the keys are cached: fetched in the background on the first outgoing
 * call, hourly after that, and again when a callback names a key id we do not hold — that
 * callback is refused, and PawaPay's 15-minute retry finds the refreshed key. Even a valid
 * signature is not acted on as it stands: `confirmWebhookEvent` re-reads the deposit or payout,
 * and PawaPay's record is what settles.
 *
 * ── NO REFUND API ────────────────────────────────────────────────────────────
 * `refundPayment` is deliberately ABSENT: a mobile-money refund on this platform is a PAYOUT
 * (REFUND-FLOW-PLAN R-1). A refund callback is ignored.
 */
export class PawaPayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'PAWAPAY';

  /** Both operators push a PIN prompt (`pinPrompt: AUTOMATIC`). ADR-A08 D-2. */
  readonly capabilities: GatewayCapabilities = Object.freeze({
    collect: Object.freeze({
      MTN: Object.freeze({
        flow: 'PUSH' as const,
        requires: Object.freeze(['phoneNumber' as const]),
        limits: PAWAPAY_CM_LIMITS.MTN,
      }),
      ORANGE: Object.freeze({
        flow: 'PUSH' as const,
        requires: Object.freeze(['phoneNumber' as const]),
        limits: PAWAPAY_CM_LIMITS.ORANGE,
      }),
    }),
    settlesAsync: true,
  });

  /** PawaPay's callback-signing keys by key id. See the header. */
  private readonly publicKeys = new Map<string, crypto.KeyObject>();
  private keysFetchedAt = 0;
  private keysRefresh: Promise<void> | null = null;

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      const operator = resolveCameroonOperator(payload.channel.phoneNumber, payload.channel.phoneOperator);
      const msisdn = pawapayMsisdn(payload.channel.phoneNumber);
      if (!operator || !msisdn) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      const amount = Math.trunc(payload.amount);
      const depositId = pawapayPaymentId('deposit', payload.merchantRef);
      const body = {
        depositId,
        amount: String(amount),
        currency: 'XAF',
        payer: { type: 'MMO', accountDetails: { phoneNumber: msisdn, provider: pawapayProvider(operator) } },
        clientReferenceId: payload.merchantRef,
        metadata: [{ jmRef: payload.merchantRef }],
      };

      let response: any;
      try {
        response = await this.call('/v2/deposits', 'POST', body);
      } catch (error) {
        const rejection = pawapayRejectionOf(error);
        if (rejection) throw depositRefusal(rejection, operator, amount);
        // 5xx (`UNKNOWN_ERROR`) or no answer: PawaPay may hold the deposit. Its own rule is that
        // only NOT_FOUND is safe to call failed, so ask once before deciding.
        return this.depositAfterUnknownOutcome(depositId, operator, error);
      }

      const word = String(response?.status ?? '').trim().toUpperCase();
      if (word === 'REJECTED') {
        throw depositRefusal(pawapayFailureOf(response) ?? { code: 'UNKNOWN', message: '' }, operator, amount);
      }
      if (word !== 'ACCEPTED' && word !== 'DUPLICATE_IGNORED') {
        // An answer with no initiation status: unknown, so treated like a 5xx.
        return this.depositAfterUnknownOutcome(depositId, operator, response);
      }

      return {
        success: true,
        gatewayRef: depositId,
        status: 'PENDING',
        instructions: pawapayInstructions(operator),
        rawResponse: response,
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator, an out-of-range
      // amount, a provider outage, PawaPay refused) and reaches the caller as itself.
      if (error instanceof AppError) throw error;
      console.error('[PawaPayGateway] initiatePayment error:', error?.message ?? error);
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
      const found = await this.lookup('deposit', payload.gatewayRef);
      if (!found) {
        // PawaPay: a deposit it has never seen never reached it, and is safe to call failed.
        return { success: false, status: 'FAILED', error: 'PawaPay has no record of this deposit', rawResponse: null };
      }
      const status = normalizePawapayStatus(found.status);
      return { success: status === 'SUCCEEDED', status, transactionDetails: found, rawResponse: found };
    } catch (error: any) {
      console.error('[PawaPayGateway] verifyPayment error:', error?.message ?? error);
      // PENDING, never FAILED: a verification we could not perform says nothing about the payment.
      return { success: false, status: 'PENDING', error: error?.message || 'Verification failed', rawResponse: null };
    }
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    // Refuse, never skip: without the token no key can be fetched and nothing can be re-read.
    if (!PAWAPAY_CONFIG.API_TOKEN) return { ok: false, reason: 'missing_secret' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }

    const check = verifyPawapaySignature({
      rawBody: input.rawBody,
      headers: input.headers,
      keyFor: (keyId) => this.keyFor(keyId),
      authorities: pawapayCallbackAuthorities(input.headers),
      paths: PAWAPAY_CONFIG.CALLBACK_PATHS,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!check.ok) {
      if (check.unknownKeyId) void this.refreshPublicKeys(true).catch(() => undefined);
      return { ok: false, reason: check.reason, detail: check.detail };
    }

    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };
    return { ok: true, payload: parsed.value, rawBody: input.rawBody };
  }

  /** The callback's claims. Re-read through `confirmWebhookEvent` before anything acts on them. */
  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    return pawapayEventFrom(payload, payload);
  }

  /**
   * Replace a callback's claims with PawaPay's own record (ADR-A08 P2.0), read on the endpoint of
   * the direction the callback states. The record must name the same id, direction and (when
   * both state one) reference, or the answer is null. NOT_FOUND → null; any failure to ask
   * THROWS, so the route answers 5xx and PawaPay retries.
   */
  async confirmWebhookEvent(event: NormalizedWebhookEvent): Promise<NormalizedWebhookEvent | null> {
    const record = await this.lookup(event.direction === 'payout' ? 'payout' : 'deposit', event.gatewayRef);
    if (!record) return null;

    const confirmed = pawapayEventFrom(record, { callback: event.raw, confirmed: record });
    if (!confirmed) return null;
    if (confirmed.gatewayRef !== event.gatewayRef) return null;
    if (confirmed.direction !== event.direction) return null;
    if (event.merchantRef && confirmed.merchantRef && confirmed.merchantRef !== event.merchantRef) return null;

    return { ...confirmed, merchantRef: confirmed.merchantRef ?? event.merchantRef };
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /** Switched on AND the token present. PawaPay's own payout enablement shows up per call. */
  payoutAvailable(): boolean {
    return PAWAPAY_CONFIG.PAYOUTS_ENABLED && PAWAPAY_CONFIG.API_TOKEN !== '';
  }

  /** The Cameroon XAF wallet, which collections fund and payouts draw on. */
  async payoutBalance(currency: string): Promise<PayoutBalance | null> {
    if (currency.toUpperCase() !== 'XAF') return null;
    const response = await this.call('/v2/wallet-balances?country=CMR', 'GET');
    const wallets: any[] = Array.isArray(response?.balances) ? response.balances : [];
    const wallet = wallets.find((w) => String(w?.currency ?? '').toUpperCase() === 'XAF');
    const available = Number(wallet?.balance);
    return wallet && Number.isFinite(available) ? { available, currency: 'XAF' } : null;
  }

  /**
   * Read a sent payout back for the sweep: `GET /v2/payouts/{id}`.
   *
   * With no stored id (a send whose answer was lost), the derived ids of our reference are walked
   * and the LAST one PawaPay knows is the payout's current attempt.
   */
  async verifyPayout(payload: PayoutVerifyPayload): Promise<PayoutVerifyResult> {
    try {
      if (isUuid(payload.gatewayRef)) {
        const record = await this.lookup('payout', payload.gatewayRef);
        if (!record) {
          return { status: 'FAILED', gatewayRef: payload.gatewayRef, reason: 'PawaPay has no record of this payout: it never reached PawaPay, so nothing was sent.' };
        }
        return pawapayPayoutVerdict(record, payload.reference);
      }
      if (!payload.reference) {
        return { status: 'PENDING', gatewayRef: null, inconclusive: 'Neither a PawaPay payout id nor our reference to derive one from' };
      }
      let latest: any = null;
      for (let attempt = 0; attempt < PAWAPAY_MAX_PAYOUT_ATTEMPTS; attempt++) {
        const record = await this.lookup('payout', pawapayPaymentId('payout', payload.reference, attempt));
        if (!record) break;
        latest = record;
      }
      if (!latest) {
        return { status: 'FAILED', gatewayRef: null, reason: 'PawaPay has no record of this payout: it never reached PawaPay, so nothing was sent.' };
      }
      return pawapayPayoutVerdict(latest, payload.reference);
    } catch (error: any) {
      return {
        status: 'PENDING',
        gatewayRef: null,
        inconclusive: `PawaPay status lookup failed: ${error?.message ?? error}`,
      };
    }
  }

  /**
   * Send money: `POST /v2/payouts`.
   *
   * The id is derived from the caller's `reference`, so a resend is deduplicated by PawaPay
   * (`DUPLICATE_IGNORED`). On a duplicate the existing payout is read back: still moving or
   * completed → reported, nothing sent; FAILED (final) → the next derived id is sent. A rejection
   * (any 4xx, or `REJECTED`) created nothing → `success: false`. A 5xx, `UNKNOWN_ERROR` or no
   * answer THROWS: the outcome is unknown and the payout stays `processing`.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const msisdn = pawapayMsisdn(payload.phone);
    if (!operator || !msisdn) {
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message: 'This destination number is not recognised as MTN or Orange Cameroon, which is all PawaPay can pay out to here.',
      };
    }
    if (!merchantRefKind(payload.reference)) {
      return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: 'This payout reference cannot be sent to PawaPay.' };
    }

    const amount = Math.trunc(payload.amount);
    for (let attempt = 0; attempt < PAWAPAY_MAX_PAYOUT_ATTEMPTS; attempt++) {
      const payoutId = pawapayPaymentId('payout', payload.reference, attempt);
      let response: any;
      try {
        response = await this.call('/v2/payouts', 'POST', {
          payoutId,
          amount: String(amount),
          currency: 'XAF',
          recipient: { type: 'MMO', accountDetails: { phoneNumber: msisdn, provider: pawapayProvider(operator) } },
          clientReferenceId: payload.reference,
          metadata: [{ jmRef: payload.reference }],
        });
      } catch (error) {
        const rejection = pawapayRejectionOf(error);
        if (rejection) return { success: false, gatewayRef: null, status: 'FAILED', ...pawapayPayoutRefusal(rejection) };
        throw error;
      }

      const word = String(response?.status ?? '').trim().toUpperCase();
      if (word === 'ACCEPTED') return { success: true, gatewayRef: payoutId, status: 'PENDING', raw: response };
      if (word === 'REJECTED') {
        const rejection = pawapayFailureOf(response) ?? { code: 'UNKNOWN', message: '' };
        return { success: false, gatewayRef: null, status: 'FAILED', ...pawapayPayoutRefusal(rejection), raw: response };
      }
      if (word !== 'DUPLICATE_IGNORED') {
        throw createAppError(ERROR_CODES.PAWAPAY_REQUEST_FAILED, 502, `PawaPay answered a payout with status "${word}"`, { body: response });
      }

      // This id was sent before. Read it: only a FINAL failure lets the next id go out.
      const existing = await this.lookup('payout', payoutId);
      if (!existing) {
        // PawaPay says it is a duplicate AND that it does not know it: unknown, stays processing.
        throw createAppError(ERROR_CODES.PAWAPAY_REQUEST_FAILED, 502, 'PawaPay reported a duplicate payout it cannot find', { payoutId });
      }
      const status = normalizePawapayStatus(existing.status);
      if (status !== 'FAILED') return { success: true, gatewayRef: payoutId, status, raw: existing };
    }

    return {
      success: false,
      gatewayRef: null,
      status: 'FAILED',
      message: `This payout already failed ${PAWAPAY_MAX_PAYOUT_ATTEMPTS} times at PawaPay. Nothing was sent; send it through another aggregator or by hand.`,
    };
  }

  // ── Callback-signing keys ─────────────────────────────────────────────────

  /**
   * Fetch PawaPay's callback-signing keys (`GET /v2/public-key/http`). Throttled: a `force`
   * refresh (a callback named an unknown key) runs at most once a minute, an ordinary one hourly.
   */
  async refreshPublicKeys(force = false): Promise<void> {
    const age = Date.now() - this.keysFetchedAt;
    if (age < (force ? PAWAPAY_KEY_FORCED_REFRESH_MS : PAWAPAY_KEY_REFRESH_MS)) return;
    if (this.keysRefresh) return this.keysRefresh;

    this.keysRefresh = (async () => {
      try {
        const response = await this.call('/v2/public-key/http', 'GET', undefined, false);
        const items: any[] = Array.isArray(response) ? response : [];
        const next = new Map<string, crypto.KeyObject>();
        for (const item of items) {
          if (typeof item?.id !== 'string' || typeof item?.key !== 'string') continue;
          try {
            next.set(item.id, crypto.createPublicKey(item.key));
          } catch {
            console.warn(`[PawaPayGateway] public key ${item.id} could not be parsed; skipped`);
          }
        }
        if (next.size > 0) {
          this.publicKeys.clear();
          for (const [id, key] of next) this.publicKeys.set(id, key);
        }
      } finally {
        // Stamped on failure too, so an outage is not hammered; the next window tries again.
        this.keysFetchedAt = Date.now();
        this.keysRefresh = null;
      }
    })();
    return this.keysRefresh;
  }

  /** How many callback-signing keys are held right now (a diagnostic for the integration inventory). */
  callbackKeysLoaded(): number {
    return (pinnedPublicKey() ? 1 : 0) + this.publicKeys.size;
  }

  /** The key for a callback: the pinned one when configured, else the fetched one by id. */
  private keyFor(keyId: string | null): crypto.KeyObject | null {
    const pinned = pinnedPublicKey();
    if (pinned) return pinned;
    return keyId ? this.publicKeys.get(keyId) ?? null : null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * A deposit initiation whose answer we did not get (5xx, `UNKNOWN_ERROR`, timeout). FOUND →
   * that record decides. NOT_FOUND → it never reached PawaPay: failed, nothing charged. The
   * lookup failing too → left PENDING with the id, so the reconciliation sweep settles it.
   */
  private async depositAfterUnknownOutcome(
    depositId: string,
    operator: CameroonMobileOperator,
    cause: unknown
  ): Promise<PaymentInitResult> {
    let found: any;
    try {
      found = await this.lookup('deposit', depositId);
    } catch {
      console.warn(`[PawaPayGateway] deposit ${depositId}: outcome unknown and the status read failed; left PENDING for the sweep`);
      return {
        success: true,
        gatewayRef: depositId,
        status: 'PENDING',
        instructions: pawapayInstructions(operator),
        rawResponse: { unknownOutcome: cause instanceof Error ? cause.message : cause ?? null },
      };
    }
    if (!found) {
      return {
        success: false,
        gatewayRef: depositId,
        status: 'FAILED',
        error: 'PawaPay did not take the payment request. Nothing was charged.',
        rawResponse: null,
      };
    }
    const status = normalizePawapayStatus(found.status);
    if (status === 'FAILED' || status === 'CANCELLED') {
      return { success: false, gatewayRef: depositId, status: 'FAILED', error: pawapayFailureText(found) ?? 'PawaPay reports this payment failed', rawResponse: found };
    }
    return { success: true, gatewayRef: depositId, status, instructions: pawapayInstructions(operator), rawResponse: found };
  }

  /**
   * `GET /v2/deposits/{id}` or `/v2/payouts/{id}`: the record when FOUND, null when NOT_FOUND.
   * Throws when PawaPay cannot be asked.
   */
  private async lookup(kind: 'deposit' | 'payout', id: string): Promise<Record<string, any> | null> {
    if (!isUuid(id)) return null;
    let response: any;
    try {
      response = await this.call(`/v2/${kind}s/${encodeURIComponent(id)}`, 'GET');
    } catch (error) {
      if (httpStatusOf(error) === 404) return null;
      throw error;
    }
    const word = String(response?.status ?? '').trim().toUpperCase();
    if (word === 'NOT_FOUND') return null;
    if (word === 'FOUND' && response?.data && typeof response.data === 'object') return response.data;
    throw createAppError(ERROR_CODES.PAWAPAY_REQUEST_FAILED, 502, `PawaPay answered a ${kind} lookup with status "${word}"`, { body: response });
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency) || currency.toUpperCase() !== 'XAF') {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `PawaPay cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /**
   * The one outbound HTTP call, in the Campay / Fapshi idiom: native fetch + AbortController with
   * a configured timeout; non-2xx is 502, unreachable is 503. The bearer token is never copied
   * into error details. Each call also keeps the callback-signing keys fresh (`warmKeys`).
   */
  private async call(path: string, method: 'GET' | 'POST', body?: Record<string, unknown>, warmKeys = true): Promise<any> {
    if (!PAWAPAY_CONFIG.API_TOKEN) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'PawaPay is not configured. Set PAWAPAY_API_TOKEN in the environment.'
      );
    }
    // A callback follows every deposit and payout; fetch the key that will sign it now, in the
    // background, so the callback does not arrive to an empty cache.
    if (warmKeys) void this.refreshPublicKeys().catch(() => undefined);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${PAWAPAY_CONFIG.API_TOKEN}`,
    };
    if (body) headers['Content-Type'] = 'application/json';

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAWAPAY_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${PAWAPAY_CONFIG.BASE_URL}${path}`, {
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
          ERROR_CODES.PAWAPAY_REQUEST_FAILED,
          502,
          `PawaPay ${method} ${path} answered ${response.status}`,
          { status: response.status, body: parsed }
        );
        recordIntegrationCall('pawapay', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('pawapay', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 above would be rewritten as a 503 here.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.PAWAPAY_UNREACHABLE,
        503,
        `PawaPay ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('pawapay', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Pure helpers (exported for test:pawapay) ────────────────────────────────

/**
 * PawaPay's Cameroon range per provider, the same for a deposit and a payout, as `GET
 * /v2/active-conf?country=CMR` reported it for our account (`verify:pawapay` R1, 2026-10-06,
 * sandbox). ⚠ Limits are ACCOUNT-specific: re-run R1 against the live account at go-live and
 * update these if they differ. `AMOUNT_OUT_OF_BOUNDS` stays mapped as the backstop.
 */
export const PAWAPAY_CM_LIMITS: Readonly<Record<CameroonMobileOperator, CollectAmountLimits>> = Object.freeze({
  MTN: Object.freeze({ min: 1, max: 1_000_000 }),
  ORANGE: Object.freeze({ min: 1, max: 500_000 }),
});

/** How many derived ids one payout reference may use before it is sent elsewhere. */
export const PAWAPAY_MAX_PAYOUT_ATTEMPTS = 10;
const PAWAPAY_KEY_REFRESH_MS = 60 * 60 * 1000;
const PAWAPAY_KEY_FORCED_REFRESH_MS = 60 * 1000;
/** Clock skew allowed on a callback signature's `created` / `expires`. */
export const PAWAPAY_SIGNATURE_SKEW_S = 300;

function httpStatusOf(error: unknown): number | undefined {
  return error instanceof AppError ? (error.details as { status?: number } | undefined)?.status : undefined;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * PawaPay's `depositId` / `payoutId` for one of our references: a UUIDv4-SHAPED hash.
 *
 * Deterministic on purpose: a retry of the same reference MUST present the same id, or PawaPay's
 * deduplication protects nothing. `attempt` > 0 is a payout's next id after its previous one
 * FAILED (see `createPayout`). The version and variant bits are set as for a random v4, which is
 * the format PawaPay asks for; the bits underneath come from SHA-256 instead of a random source.
 */
export function pawapayPaymentId(purpose: 'deposit' | 'payout', reference: string, attempt = 0): string {
  const bytes = crypto
    .createHash('sha256')
    .update(`pawapay:${purpose}:${reference}${attempt > 0 ? `#${attempt}` : ''}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** PawaPay's provider code for an operator. */
export function pawapayProvider(operator: CameroonMobileOperator): 'MTN_MOMO_CMR' | 'ORANGE_CMR' {
  return operator === 'MTN' ? 'MTN_MOMO_CMR' : 'ORANGE_CMR';
}

/** The MSISDN PawaPay takes: country code, no `+`, no leading zero (`237` + 9 digits), or null. */
export function pawapayMsisdn(phone: string | null | undefined): string | null {
  const national = toCameroonNationalNumber(phone);
  return national ? `237${national}` : null;
}

/**
 * One status table, for deposit and payout records and callbacks alike. `SUBMITTED` appears in
 * the sandbox test-number tables. Unknown → PENDING, never FAILED.
 */
export function normalizePawapayStatus(raw: unknown): PaymentGatewayStatus {
  const map: Record<string, PaymentGatewayStatus> = {
    ACCEPTED: 'PENDING',
    ENQUEUED: 'PENDING',
    SUBMITTED: 'PENDING',
    PROCESSING: 'PENDING',
    IN_RECONCILIATION: 'PENDING',
    COMPLETED: 'SUCCEEDED',
    FAILED: 'FAILED',
  };
  return map[String(raw ?? '').trim().toUpperCase()] ?? 'PENDING';
}

/** What the customer is told while the PIN prompt is on their phone. */
export function pawapayInstructions(operator: CameroonMobileOperator): PaymentInstructions {
  return {
    ussdCode: operator === 'MTN' ? '*126#' : '#150*50#',
    message: 'Approve the payment request on your phone by entering your mobile money PIN.',
  };
}

/** Our `jm_…` reference out of a record: `metadata.jmRef`, else `clientReferenceId`. Only a `jm_` value counts. */
export function pawapayMerchantRef(record: Record<string, unknown> | null | undefined): string | null {
  const metadata = record?.metadata;
  const candidates: unknown[] = [];
  if (Array.isArray(metadata)) {
    for (const item of metadata) candidates.push((item as Record<string, unknown> | null)?.jmRef);
  } else if (metadata && typeof metadata === 'object') {
    candidates.push((metadata as Record<string, unknown>).jmRef);
  }
  candidates.push(record?.clientReferenceId);
  for (const value of candidates) {
    if (typeof value === 'string' && merchantRefKind(value)) return value;
  }
  return null;
}

/** A rejection or failure reason, as PawaPay states it. */
export interface PawapayFailure {
  code: string;
  message: string;
}

/** `failureReason` on a record or an initiation answer, or null when it carries none. */
export function pawapayFailureOf(record: unknown): PawapayFailure | null {
  const reason = (record as { failureReason?: unknown } | null)?.failureReason as Record<string, unknown> | undefined;
  if (!reason || typeof reason !== 'object') return null;
  const code = typeof reason.failureCode === 'string' ? reason.failureCode.trim().toUpperCase() : '';
  if (!code) return null;
  return { code, message: typeof reason.failureMessage === 'string' ? reason.failureMessage : '' };
}

function pawapayFailureText(record: unknown): string | null {
  const failure = pawapayFailureOf(record);
  return failure ? [failure.code, failure.message].filter(Boolean).join(': ') : null;
}

/**
 * A thrown call that PawaPay ANSWERED with a refusal (any 4xx), as its failure reason. PawaPay
 * created nothing in that case. Null for a 5xx or no answer: those are unknown outcomes.
 */
export function pawapayRejectionOf(error: unknown): PawapayFailure | null {
  if (!(error instanceof AppError) || error.code !== ERROR_CODES.PAWAPAY_REQUEST_FAILED) return null;
  const details = (error.details ?? {}) as { status?: number; body?: unknown };
  if (details.status === undefined || details.status < 400 || details.status >= 500) return null;
  return pawapayFailureOf(details.body) ?? { code: `HTTP_${details.status}`, message: '' };
}

/** `"… more than '100' and less than '2000000' …"` → `{ min: 100, max: 2000000 }`, when it says so. */
export function pawapayLimitsFrom(message: string): { min: number; max: number } | null {
  const match = /more than\s*'?(\d+(?:\.\d+)?)'?\s*and less than\s*'?(\d+(?:\.\d+)?)'?/i.exec(message);
  return match ? { min: Number(match[1]), max: Number(match[2]) } : null;
}

/**
 * A refused deposit, as the error the caller receives. Each is raised with nothing charged:
 * PawaPay refused the request outright.
 */
export function depositRefusal(failure: PawapayFailure, operator: CameroonMobileOperator, amount: number): AppError {
  switch (failure.code) {
    case 'AMOUNT_OUT_OF_BOUNDS': {
      const limits = pawapayLimitsFrom(failure.message);
      return createAppError(
        ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE,
        422,
        limits
          ? `Mobile money payments must be between ${limits.min} and ${limits.max} XAF right now.`
          : 'This amount is outside what mobile money accepts in one payment right now.',
        { provider: operator, amount, min: limits?.min ?? null, max: limits?.max ?? null, spent: false }
      );
    }
    case 'PROVIDER_TEMPORARILY_UNAVAILABLE':
      return createAppError(
        ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
        422,
        `${operator === 'MTN' ? 'MTN Mobile Money' : 'Orange Money'} is temporarily unavailable. Try the other network, or try again later. Nothing was charged.`,
        { provider: operator, temporary: true, spent: false }
      );
    case 'INVALID_PHONE_NUMBER':
    case 'INVALID_PROVIDER':
      return createAppError(
        ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
        422,
        `This number cannot pay with ${operator === 'MTN' ? 'MTN Mobile Money' : 'Orange Money'}. Check the number and the network.`,
        { phoneOperator: operator, spent: false }
      );
    default:
      // Our account or our request (token, deposits not enabled, a malformed field): an
      // operator's problem, filed as external_service so the provider's text stays in our logs.
      return createAppError(
        ERROR_CODES.PAWAPAY_REQUEST_FAILED,
        502,
        `PawaPay refused the deposit: ${failure.code}${failure.message ? ` (${failure.message})` : ''}`,
        { failureCode: failure.code, failureMessage: failure.message }
      );
  }
}

/** A refused payout (nothing created), as `PayoutResult` fields. */
export function pawapayPayoutRefusal(failure: PawapayFailure): { message: string; unsupported?: boolean } {
  const said = `${failure.code}${failure.message ? `: ${failure.message}` : ''}`;
  switch (failure.code) {
    case 'PAYOUTS_NOT_ALLOWED':
    case 'NO_AUTHENTICATION':
    case 'AUTHENTICATION_ERROR':
    case 'AUTHORISATION_ERROR':
    case 'HTTP_SIGNATURE_ERROR':
    case 'HTTP_401':
    case 'HTTP_403':
      return {
        unsupported: true,
        message: `PawaPay refused the payout (${said}). Check PAWAPAY_API_TOKEN and that payouts are enabled for this provider on the PawaPay account. Nothing was sent.`,
      };
    case 'AMOUNT_OUT_OF_BOUNDS':
    case 'INVALID_PHONE_NUMBER':
    case 'INVALID_PROVIDER':
    case 'INVALID_CURRENCY':
      return {
        unsupported: true,
        message: `PawaPay cannot send this payout (${said}). Nothing was sent — use another payout aggregator or send it by hand.`,
      };
    case 'PAWAPAY_WALLET_OUT_OF_FUNDS':
      return { message: 'The PawaPay wallet does not hold enough to send this payout. Nothing was sent; top it up and retry.' };
    case 'PROVIDER_TEMPORARILY_UNAVAILABLE':
      return { message: 'The mobile network is temporarily unavailable at PawaPay. Nothing was sent; retry later.' };
    default:
      return { message: `PawaPay refused the payout (${said}). Nothing was sent.` };
  }
}

/**
 * A callback body or a status record, as the normalized event.
 *
 * Direction is the record's SHAPE: `depositId` → collection, `payoutId` → payout. A refund record
 * (`refundId`) is not ours to act on — the platform never calls PawaPay's refund. A reference of
 * the other direction's kind (a `po`/`rf` on a deposit, a `pt` on a payout) is a contradiction →
 * null. There is no event id, so one is derived from direction + id + status.
 */
export function pawapayEventFrom(record: Record<string, unknown>, raw: unknown): NormalizedWebhookEvent | null {
  let direction: 'collection' | 'payout';
  let gatewayRef: string;
  if (typeof record.depositId === 'string' && record.depositId.trim()) {
    direction = 'collection';
    gatewayRef = record.depositId.trim();
  } else if (typeof record.payoutId === 'string' && record.payoutId.trim()) {
    direction = 'payout';
    gatewayRef = record.payoutId.trim();
  } else {
    return null;
  }

  const merchantRef = pawapayMerchantRef(record);
  if (merchantRef && isMoneyOutRef(merchantRef) !== (direction === 'payout')) return null;

  const word = String(record.status ?? '').trim().toUpperCase();
  return {
    eventId: deriveEventId(['pawapay', direction, gatewayRef, word]),
    eventType: `${direction === 'payout' ? 'transfer' : 'payment'}.${word.toLowerCase() || 'unknown'}`,
    direction,
    gatewayRef,
    merchantRef,
    status: normalizePawapayStatus(word),
    amount: typeof record.amount === 'number' || typeof record.amount === 'string' ? record.amount : null,
    currency: typeof record.currency === 'string' && record.currency ? record.currency : null,
    raw,
  };
}

/**
 * A payout record, reduced to a verdict. Acted on only when it proves it is THIS payout: it must
 * be a payout record (`payoutId`), and our reference, when it states one, must be ours.
 */
export function pawapayPayoutVerdict(record: unknown, reference: string | null): PayoutVerifyResult {
  if (!record || typeof record !== 'object') {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'PawaPay returned no payout record', raw: record };
  }
  const r = record as Record<string, unknown>;
  const payoutId = typeof r.payoutId === 'string' && r.payoutId ? r.payoutId : null;
  if (!payoutId) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: 'PawaPay record is not a payout', raw: record };
  }
  const ours = pawapayMerchantRef(r);
  if (ours && reference && ours !== reference) {
    return { status: 'PENDING', gatewayRef: null, inconclusive: `PawaPay record ${ours} is not this payout's (${reference})`, raw: record };
  }

  const status = normalizePawapayStatus(r.status);
  return {
    status,
    gatewayRef: payoutId,
    reason: status === 'FAILED' ? pawapayFailureText(r) ?? 'PawaPay reported the payout failed' : null,
    raw: record,
  };
}

// ── RFC 9421 callback signatures ────────────────────────────────────────────

/** The pinned callback key (`PAWAPAY_CALLBACK_PUBLIC_KEY`), parsed once. */
let pinnedKeyCache: { pem: string; key: crypto.KeyObject | null } | null = null;
function pinnedPublicKey(): crypto.KeyObject | null {
  const pem = PAWAPAY_CONFIG.CALLBACK_PUBLIC_KEY;
  if (!pem) return null;
  if (pinnedKeyCache?.pem !== pem) {
    let key: crypto.KeyObject | null = null;
    try {
      key = crypto.createPublicKey(pem);
    } catch {
      console.error('[PawaPayGateway] PAWAPAY_CALLBACK_PUBLIC_KEY is not a valid PEM public key; ignored');
    }
    pinnedKeyCache = { pem, key };
  }
  return pinnedKeyCache.key;
}

/**
 * The `@authority` values a callback may have been signed with: what the request arrived as
 * (`x-forwarded-host`, `host`) plus the configured public hosts. All of them are ours, so a
 * signature that verifies under any one of them is PawaPay's.
 */
export function pawapayCallbackAuthorities(headers: Record<string, string | string[] | undefined>): string[] {
  const seen = new Set<string>();
  const add = (value: unknown) => {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== 'string') return;
    const host = first.split(',')[0].trim().toLowerCase();
    if (host) seen.add(host);
  };
  add(headers['x-forwarded-host']);
  add(headers.host);
  for (const host of PAWAPAY_CONFIG.CALLBACK_AUTHORITIES) add(host);
  return [...seen];
}

/** One header's value as RFC 9421 uses it: every field line, trimmed, joined with `, `. */
function headerField(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const raw = headers[name.toLowerCase()];
  if (raw === undefined) return null;
  const values = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v).trim());
  return values.join(', ');
}

/**
 * Split a Structured-Field dictionary (`a=…, b=…`) into its members, keeping each value's raw
 * text. Commas inside a quoted string or a `( … )` inner list do not split.
 */
export function splitSfDictionary(value: string): Map<string, string> {
  const members = new Map<string, string>();
  let depth = 0;
  let quoted = false;
  let start = 0;
  const flush = (end: number) => {
    const part = value.slice(start, end).trim();
    const eq = part.indexOf('=');
    if (eq > 0) members.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === ',') {
      flush(i);
      start = i + 1;
    }
  }
  flush(value.length);
  return members;
}

/** `("@method" "content-digest");alg="…";keyid="…";created=1;expires=2` → its parts. */
export function parseSignatureParams(raw: string): {
  components: string[];
  params: Record<string, string | number>;
} | null {
  const match = /^\(([^)]*)\)(.*)$/.exec(raw.trim());
  if (!match) return null;
  const components = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1].toLowerCase());
  const params: Record<string, string | number> = {};
  for (const m of match[2].matchAll(/;\s*([a-z0-9_-]+)=("([^"]*)"|-?\d+)/gi)) {
    params[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : Number(m[2]);
  }
  return { components, params };
}

/** Does `Content-Digest` match the body? Every supported algorithm listed must match, and one must be listed. */
export function contentDigestMatches(header: string | null, rawBody: Buffer): boolean {
  if (!header) return false;
  let checked = 0;
  for (const [alg, value] of splitSfDictionary(header)) {
    const nodeAlg = alg.toLowerCase() === 'sha-256' ? 'sha256' : alg.toLowerCase() === 'sha-512' ? 'sha512' : null;
    if (!nodeAlg) continue;
    const presented = /^:(.*):$/.exec(value)?.[1];
    if (!presented) return false;
    const actual = crypto.createHash(nodeAlg).update(rawBody).digest('base64');
    if (presented.length !== actual.length || !crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(actual))) return false;
    checked++;
  }
  return checked > 0;
}

/** Verify one signature with the algorithm `alg` names, or the key's own kind when it names none. */
export function verifyWithAlgorithm(alg: string | null, key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
  const ecdsa = (hash: string) => {
    for (const dsaEncoding of ['der', 'ieee-p1363'] as const) {
      try {
        if (crypto.verify(hash, data, { key, dsaEncoding }, signature)) return true;
      } catch {
        // A signature in the other encoding throws rather than answering false.
      }
    }
    return false;
  };
  const attempt = (fn: () => boolean) => {
    try {
      return fn();
    } catch {
      return false;
    }
  };
  const pss = () => attempt(() => crypto.verify('sha512', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 }, signature));
  const pkcs1 = () => attempt(() => crypto.verify('sha256', data, key, signature));

  switch ((alg ?? '').toLowerCase()) {
    case 'ecdsa-p256-sha256':
      return ecdsa('sha256');
    case 'ecdsa-p384-sha384':
      return ecdsa('sha384');
    case 'rsa-pss-sha512':
      return pss();
    case 'rsa-v1_5-sha256':
      return pkcs1();
    case '': {
      if (key.asymmetricKeyType === 'ec') {
        const curve = (key.asymmetricKeyDetails as { namedCurve?: string } | undefined)?.namedCurve;
        return ecdsa(curve === 'secp384r1' ? 'sha384' : 'sha256');
      }
      if (key.asymmetricKeyType === 'rsa') return pkcs1() || pss();
      return false;
    }
    default:
      return false;
  }
}

export interface PawapaySignatureInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  keyFor: (keyId: string | null) => crypto.KeyObject | null;
  authorities: readonly string[];
  paths: readonly string[];
  nowSeconds: number;
}

export type PawapaySignatureCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'bad_signature'; detail: string; unknownKeyId?: boolean };

/**
 * Verify a PawaPay callback's RFC 9421 signature.
 *
 * The body must be covered (`content-digest` among the signed components, and matching the raw
 * bytes), the signature must not have expired, and the key named by `keyid` must verify the
 * signature base rebuilt from the components PawaPay lists — in PawaPay's order, with the
 * `@signature-params` line copied verbatim from `Signature-Input`.
 */
export function verifyPawapaySignature(input: PawapaySignatureInput): PawapaySignatureCheck {
  const signatureHeader = headerField(input.headers, 'signature');
  const inputHeader = headerField(input.headers, 'signature-input');
  if (!signatureHeader || !inputHeader) {
    return { ok: false, reason: 'missing_signature', detail: 'unsigned callback — enable signed callbacks in the PawaPay dashboard' };
  }

  const signatures = splitSfDictionary(signatureHeader);
  const inputs = splitSfDictionary(inputHeader);
  const label = inputs.has('sig-pp') && signatures.has('sig-pp') ? 'sig-pp' : [...inputs.keys()].find((l) => signatures.has(l));
  if (!label) return { ok: false, reason: 'bad_signature', detail: 'Signature and Signature-Input name no common label' };

  const paramsRaw = inputs.get(label)!;
  const parsed = parseSignatureParams(paramsRaw);
  const signatureB64 = /^:(.*):$/.exec(signatures.get(label)!.trim())?.[1];
  if (!parsed || !signatureB64) return { ok: false, reason: 'bad_signature', detail: 'malformed signature headers' };

  if (!parsed.components.includes('content-digest')) {
    return { ok: false, reason: 'bad_signature', detail: 'the signature does not cover the body (no content-digest)' };
  }
  if (!contentDigestMatches(headerField(input.headers, 'content-digest'), input.rawBody)) {
    return { ok: false, reason: 'bad_signature', detail: 'Content-Digest does not match the body' };
  }

  const expires = typeof parsed.params.expires === 'number' ? parsed.params.expires : null;
  const created = typeof parsed.params.created === 'number' ? parsed.params.created : null;
  if (expires !== null && expires + PAWAPAY_SIGNATURE_SKEW_S < input.nowSeconds) {
    return { ok: false, reason: 'bad_signature', detail: 'signature expired' };
  }
  if (created !== null && created - PAWAPAY_SIGNATURE_SKEW_S > input.nowSeconds) {
    return { ok: false, reason: 'bad_signature', detail: 'signature created in the future' };
  }

  const keyId = typeof parsed.params.keyid === 'string' ? parsed.params.keyid : null;
  const key = input.keyFor(keyId);
  if (!key) {
    return { ok: false, reason: 'bad_signature', detail: `no PawaPay public key for keyid ${keyId ?? '(none)'}`, unknownKeyId: true };
  }

  const alg = typeof parsed.params.alg === 'string' ? parsed.params.alg : null;
  const signature = Buffer.from(signatureB64, 'base64');
  for (const authority of input.authorities.length ? input.authorities : ['']) {
    for (const path of input.paths) {
      const base = pawapaySignatureBase(parsed.components, paramsRaw, input.headers, authority, path);
      if (base !== null && verifyWithAlgorithm(alg, key, Buffer.from(base, 'utf8'), signature)) return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature', detail: 'the signature does not verify' };
}

/** The RFC 9421 signature base, or null when a covered component cannot be produced. */
export function pawapaySignatureBase(
  components: readonly string[],
  paramsRaw: string,
  headers: Record<string, string | string[] | undefined>,
  authority: string,
  path: string
): string | null {
  const lines: string[] = [];
  for (const component of components) {
    let value: string | null;
    switch (component) {
      case '@method':
        value = 'POST';
        break;
      case '@authority':
        value = authority || null;
        break;
      case '@path':
        value = path;
        break;
      case '@scheme':
        value = 'https';
        break;
      case '@target-uri':
        value = authority ? `https://${authority}${path}` : null;
        break;
      case '@request-target':
        value = path;
        break;
      default:
        value = component.startsWith('@') ? null : headerField(headers, component);
    }
    if (value === null) return null;
    lines.push(`"${component}": ${value}`);
  }
  lines.push(`"@signature-params": ${paramsRaw}`);
  return lines.join('\n');
}
