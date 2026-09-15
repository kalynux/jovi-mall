import {
  PaymentGateway,
  PaymentGatewayName,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  RefundPayload,
  RefundResult,
  PayoutPayload,
  PayoutResult,
  PayoutBalance,
  PaymentGatewayStatus,
  WebhookVerifyInput,
} from './gateway.interface';
import {
  WebhookVerification,
  NormalizedWebhookEvent,
  NOTCHPAY_SIGNATURE_HEADERS,
  notchPaySignature,
  timingSafeEqualString,
  headerValue,
  parseRawJson,
  deriveEventId,
  directionOfEventType,
} from '../domain/webhook-verification';
import { NOTCHPAY_CONFIG } from '../config/payments.config';
import { isZeroDecimalCurrency } from '../domain/money';
import { resolveCameroonOperator, notchPayChannelFor } from '../domain/cm-operator';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * NotchPayGateway — mobile money (MTN / Orange Cameroon).
 *
 * API: https://developer.notchpay.co · base `https://api.notchpay.co`
 *
 * ── AUTHENTICATION USES TWO OF THREE KEYS ────────────────────────────────────
 * `Authorization` carries the PUBLIC key (`pk_…`) on every call. `X-Grant`
 * carries the PRIVATE key (`sk_…`) and is required only on sensitive endpoints
 * — for us, refunds. The third key, the Hash Key (`hsk_…`), signs webhooks and
 * is never sent anywhere; it only verifies. Putting the wrong one in
 * `Authorization` fails with a 401 that reads like a revoked account.
 *
 * ── THE CHARGE IS TWO CALLS, NOT ONE ─────────────────────────────────────────
 * `POST /payments` only *initialises* — it returns a reference in `pending` and
 * takes no money. The charge is `POST /payments/{reference}` with an explicit
 * `channel`. Stopping after the first call yields a transaction that looks
 * healthy, is never presented to the customer, and expires quietly. Both calls
 * happen inside `initiatePayment` so a caller cannot get that half-state.
 *
 * ── AMOUNTS ──────────────────────────────────────────────────────────────────
 * NotchPay documents `amount` as the smallest currency unit. XAF has no minor
 * unit, so the platform's whole-XAF number passes through unchanged — and the
 * gateway refuses any currency that DOES have one rather than guessing whether
 * to multiply.
 */
export class NotchPayGateway implements PaymentGateway {
  readonly name: PaymentGatewayName = 'NOTCHPAY';

  // ── Collection ────────────────────────────────────────────────────────────

  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      this.assertChargeable(payload.currency);

      const operator = resolveCameroonOperator(
        payload.channel.phoneNumber,
        payload.channel.phoneOperator
      );
      if (!operator) {
        throw createAppError(
          ERROR_CODES.PAYMENT_OPERATOR_UNDETERMINED,
          422,
          'Could not determine the mobile network for this number.',
          { phoneOperator: payload.channel.phoneOperator ?? null }
        );
      }

      // Step 1 — initialise. `reference` is OUR merchant reference; NotchPay
      // echoes it back on the callback and it is what routes the settlement.
      const created = await this.call('/payments', 'POST', {
        amount: payload.amount,
        currency: payload.currency.toUpperCase(),
        phone: payload.channel.phoneNumber,
        email: payload.channel.customerEmail,
        description: `Order #${payload.orderId}`,
        reference: payload.merchantRef,
      });

      const gatewayRef: string | undefined =
        created?.transaction?.reference ?? created?.transaction?.id;
      if (!gatewayRef) {
        return {
          success: false,
          gatewayRef: '',
          status: 'FAILED',
          error: created?.message || 'NotchPay did not return a transaction reference',
          rawResponse: created,
        };
      }

      // Step 2 — charge. Without this the transaction sits `pending` forever
      // and the customer is never prompted for anything.
      //
      // ── THE REFERENCE MUST SURVIVE A FAILURE HERE ─────────────────────────
      // Step 1 has already opened a real transaction under `gatewayRef`. If this call fails
      // and the error goes up as it stands, that reference is lost, and the caller records a
      // row saying no charge was ever opened. It uses exactly that to decide whether a retry
      // is safe (`PaymentOrchestratorService.releaseDeadAttempt`), so losing it here is how a
      // timed-out charge gets placed a second time. Carried out on `details` rather than
      // returned, because the failure kinds this call raises — a refusal, an unreachable
      // provider — are decisions the caller must still see as themselves.
      let charged: any;
      try {
        charged = await this.call(`/payments/${encodeURIComponent(gatewayRef)}`, 'POST', {
          channel: notchPayChannelFor(operator),
          data: { phone: payload.channel.phoneNumber },
        });
      } catch (error: any) {
        if (error instanceof AppError) {
          throw createAppError(error.code, error.statusCode, error.message, {
            ...(error.details ?? {}),
            gatewayRef,
          });
        }
        throw error;
      }

      const status = this.normalizeStatus(charged?.transaction?.status ?? charged?.status);

      if (status === 'FAILED' || status === 'CANCELLED') {
        return {
          success: false,
          gatewayRef,
          status,
          error: charged?.message || 'NotchPay refused the charge',
          rawResponse: { created, charged },
        };
      }

      return {
        success: true,
        gatewayRef,
        status,
        instructions: {
          // Often absent. Verified against the live sandbox: a `cm.mtn` charge
          // answers `action: "confirm"` with NO `ussd` field — the operator
          // pushes the prompt to the handset and there is nothing to dial.
          ussdCode: charged?.ussd ?? charged?.ussd_code,
          // OUR copy first, theirs only as a fallback — the reverse of what
          // this used to do. NotchPay always sends a `message`, and in the
          // confirm flow it is "Payment is being processed", which tells a
          // customer standing at a checkout nothing about what to do next.
          // Their text is preserved in `rawResponse` either way.
          message: this.customerInstruction(charged),
          expiresAt: charged?.expires_at ? new Date(charged.expires_at) : undefined,
        },
        rawResponse: { created, charged },
      };
    } catch (error: any) {
      // A typed error is a decision (unsupported currency, unknown operator,
      // provider unreachable) and must reach the caller as itself; anything else
      // is normalised to a failed initiation.
      if (error instanceof AppError) throw error;
      console.error('[NotchPayGateway] initiatePayment error:', error?.message ?? error);
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
      const response = await this.call(
        `/payments/${encodeURIComponent(payload.gatewayRef)}`,
        'GET'
      );
      const status = this.normalizeStatus(response?.transaction?.status ?? response?.status);
      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: response?.transaction,
        rawResponse: response,
      };
    } catch (error: any) {
      console.error('[NotchPayGateway] verifyPayment error:', error?.message ?? error);
      // Deliberately NOT 'FAILED'. A verification we could not perform says
      // nothing about the payment, and the reconciliation sweep re-reads a
      // PENDING row where it would never re-read a FAILED one — so mapping an
      // outage to FAILED abandons money that settled.
      return {
        success: false,
        status: 'PENDING',
        error: error?.message || 'Verification failed',
        rawResponse: null,
      };
    }
  }

  /**
   * The integration exists; the account may not be allowed to use it. See
   * `NOTCHPAY_CONFIG.REFUNDS_ENABLED` — verified 403 on this account today, so
   * the up-front verdict reports "no" rather than offering a button that fails.
   */
  refundAvailable(): boolean {
    return NOTCHPAY_CONFIG.REFUNDS_ENABLED;
  }

  async refundPayment(payload: RefundPayload): Promise<RefundResult> {
    try {
      const response = await this.call(
        '/refunds',
        'POST',
        {
          payment: payload.gatewayRef,
          // Omitted entirely for a full refund — NotchPay treats an absent
          // amount as "all of it", and sending the full figure explicitly is
          // rejected by some accounts.
          ...(payload.amount > 0 ? { amount: payload.amount } : {}),
          reason: payload.reason || 'Refund issued by the merchant',
        },
        { grant: true }
      );

      const refundRef: string | undefined = response?.refund?.id ?? response?.refund?.reference;
      const refundStatus: string = String(response?.refund?.status ?? response?.status ?? '');
      const settled = ['complete', 'completed', 'success', 'pending', 'processing'].includes(
        refundStatus.toLowerCase()
      );

      return {
        success: Boolean(refundRef) && settled,
        refundRef,
        error: settled ? undefined : response?.message || 'NotchPay refused the refund',
        rawResponse: response,
      };
    } catch (error: any) {
      // ⚠ 403 is an ANSWER, not a fault. Verified against the live sandbox on
      // 2026-08-18: `GET /refunds` returns 200 with the same credentials, and
      // `POST /refunds` returns a bare `{"code":"403","status":"Forbidden"}`
      // for every body shape tried — `payment`, `transaction`, `reference`,
      // with and without `amount`. So the endpoint exists, the keys are right,
      // and refund CREATION is disabled on the account.
      //
      // Reporting that as a failure would send an operator hunting an outage
      // and would surface a 502 to a vendor through `VendorRefundService`,
      // which has no fallback. Reporting it as unsupported routes the money
      // through the manual-payout ticket that already exists for My-CoolPay.
      //
      // If NotchPay enables refunds on this merchant account, this branch stops
      // firing on its own and the real refund path takes over — no code change.
      if (error instanceof AppError && this.isRefundForbidden(error)) {
        console.warn('[NotchPayGateway] refunds are not enabled on this account (403)');
        return {
          success: false,
          unsupported: true,
          error: 'NotchPay refunds are not enabled on this merchant account',
          rawResponse: error.details ?? null,
        };
      }
      console.error('[NotchPayGateway] refundPayment error:', error?.message ?? error);
      return {
        success: false,
        error: error?.message || 'Refund failed',
        rawResponse: null,
      };
    }
  }

  /**
   * What to tell the customer, derived from the charge response's `action`.
   *
   * The three observed actions mean genuinely different things to the person
   * holding the phone, and rendering the wrong one is how a payment stalls: a
   * customer told to "dial a code" when their operator has already pushed a
   * confirmation prompt will wait for a code that never comes.
   */
  private customerInstruction(charged: any): string {
    const ussd = charged?.ussd ?? charged?.ussd_code;
    if (ussd) return `Dial ${ussd} on your phone to approve this payment.`;

    switch (String(charged?.action ?? '').toLowerCase()) {
      case 'confirm':
        return 'Approve the payment request on your phone to complete this payment.';
      case 'otp':
      case 'require_otp':
        return 'Enter the confirmation code sent to your phone by SMS.';
      default:
        return 'Follow the prompt on your phone to complete this payment.';
    }
  }

  private isRefundForbidden(error: AppError): boolean {
    return (
      error.code === ERROR_CODES.NOTCHPAY_REQUEST_FAILED &&
      (error.details as { status?: number } | undefined)?.status === 403
    );
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  verifyWebhook(input: WebhookVerifyInput): WebhookVerification {
    const secret = NOTCHPAY_CONFIG.WEBHOOK_SECRET;
    // Refuse, never skip. "No secret configured" used to mean "accept anything".
    if (!secret) return { ok: false, reason: 'missing_secret' };

    if (!Buffer.isBuffer(input.rawBody)) {
      return {
        ok: false,
        reason: 'unparsable',
        detail: 'raw body unavailable — express.raw is not mounted for this path',
      };
    }

    const presented = headerValue(input.headers, NOTCHPAY_SIGNATURE_HEADERS);
    if (!presented) return { ok: false, reason: 'missing_signature' };

    const expected = notchPaySignature(input.rawBody, secret);
    if (!timingSafeEqualString(presented, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    // Parsed only AFTER the digest passes, so malformed JSON from an
    // authenticated sender is distinguishable from an unauthenticated caller.
    const parsed = parseRawJson(input.rawBody);
    if (!parsed.ok) return { ok: false, reason: 'unparsable' };

    return { ok: true, payload: parsed.value, rawBody: input.rawBody };
  }

  parseWebhookEvent(payload: Record<string, unknown>): NormalizedWebhookEvent | null {
    // NotchPay sends `{ type, data }`; some events carry the transaction at the
    // top level instead. Both shapes are read rather than one being assumed.
    const type = String((payload as any).type ?? (payload as any).event ?? '');
    const data = ((payload as any).data ?? payload) as Record<string, any>;
    const trx = (data.transaction ?? data) as Record<string, any>;

const direction = directionOfEventType(type);

    /**
     * ⛔ **The two reference fields swap meaning between a payment and a transfer, and
     * getting this backwards means a transfer callback never finds its payout.**
     *
     * Verified against NotchPay's own OpenAPI document (notchpay-php/openapi.yaml), which is
     * the only source that agrees with itself — the prose docs contradict each other on this
     * in three places:
     *
     *   Payment object   `reference` = THEIRS   `merchant_reference` = ours
     *   Transfer object  `id` = THEIRS (trf_…)  `reference`          = OURS
     *
     * So a transfer carries our reference in the field a payment uses for the gateway's own,
     * and carries no `merchant_reference` at all. Reading it the payment way yields
     * `merchantRef: null` and a `gatewayRef` holding our own value — the settler then looks
     * up a payout by nothing and answers `unknown_transaction` for every single callback,
     * silently, while the money has actually moved.
     */
    const gatewayRef: string =
      direction === 'payout'
        ? String(trx.id ?? trx.reference ?? '')
        : String(trx.reference ?? trx.id ?? '');
    if (!gatewayRef) return null;

    // `merchant_reference` is what NotchPay echoes our `reference` back as on
    // some payment event shapes; on others it comes back as `reference` while their own
    // id lives in `id`. Read both, and never treat OUR reference as THEIR ref.
    const merchantRefRaw =
      direction === 'payout'
        ? (trx.reference ?? trx.merchant_reference ?? null)
        : (trx.merchant_reference ?? data.merchant_reference ?? null);
    const merchantRef = merchantRefRaw ? String(merchantRefRaw) : null;

    const rawStatus = String(trx.status ?? (payload as any).status ?? '');
    return {
      eventId: String((payload as any).id ?? deriveEventId([gatewayRef, type, rawStatus])),
      eventType: type || `payment.${rawStatus || 'unknown'}`,
      /**
       * ⚠ Derived from the event TYPE, which until transfers landed this adapter read only
       * for the audit row — every decision was driven by the status alone. It is load-bearing
       * now: it is the single thing standing between a `transfer.*` callback and the order
       * orchestrator.
       *
       * Note the fallback above: an event with no type at all becomes
       * `payment.<status>`, so it classifies as a collection, which is what every existing
       * NotchPay callback should do.
       */
      direction,
      gatewayRef,
      merchantRef,
      status: this.normalizeStatus(rawStatus),
      amount: trx.amount ?? null,
      currency: trx.currency ? String(trx.currency) : null,
      raw: payload,
    };
  }

  // ── Disbursement ──────────────────────────────────────────────────────────

  /**
   * Is sending switched on for this deployment? See `PAYOUTS_ENABLED` in the config for why
   * this is a flag rather than something derived from the credentials being present.
   */
  payoutAvailable(): boolean {
    return NOTCHPAY_CONFIG.PAYOUTS_ENABLED;
  }

  /**
   * The float NotchPay will pay out of, for one currency.
   *
   * `available` and `pending` are reported separately by the provider and only the first can
   * fund a transfer, so only the first is returned — a caller adding them would approve a
   * payout against money that has not cleared.
   *
   * Returns null rather than throwing when the currency is absent from the response: an
   * account that has never held XAF reports no XAF key, and that is not an error, it is a
   * zero the caller should treat as unknown rather than as a refusal.
   */
  async payoutBalance(currency: string): Promise<PayoutBalance | null> {
    const response = await this.call('/balance', 'GET', undefined, { grant: true });
    const available = (response?.balance?.available ?? response?.data?.balance?.available) as
      | Record<string, unknown>
      | undefined;
    if (!available) return null;

    const key = Object.keys(available).find((k) => k.toUpperCase() === currency.toUpperCase());
    if (!key) return null;

    const amount = Number(available[key]);
    if (!Number.isFinite(amount)) return null;
    return { available: amount, currency: currency.toUpperCase() };
  }

  /**
   * Send money to a beneficiary — `POST /transfers`.
   *
   * ── Three things about this call are worth knowing before changing it ────────
   *
   * **`reference` is the caller's, and is never minted here.** It is the idempotency key for
   * money leaving the platform: a retry carries the reference of the attempt it is retrying,
   * so a transfer that actually succeeded and merely failed to report is deduplicated by
   * NotchPay instead of being sent twice. A gateway that minted its own reference per call
   * would defeat that silently.
   *
   * **`X-Grant` is required**, which means `NOTCHPAY_PRIVATE_KEY`. Without it the call
   * answers 403, and a 403 here is ambiguous in a way it is not for refunds — it is equally
   * the signature of an egress IP that was never registered in the NotchPay dashboard. Both
   * are reported as `unsupported` with a message naming both causes, because neither is a
   * transient fault worth retrying.
   *
   * ⚠ **A TRANSFER IS TWO CALLS, NOT ONE** — the same shape as the charge above, and for
   * the same reason it is worth a heading. `POST /transfers` will not accept a destination
   * inline: its body requires EITHER an existing `beneficiary` id or a `recipient` +
   * `channel` pair. So the beneficiary is created first and the transfer names it.
   *
   * ⚠ **This contradicts NotchPay's own prose documentation, and the prose is wrong.** The
   * API-reference page describes a `beneficiary_data` object accepted inline; the send-money
   * guide describes `type: "cm.mtn"` on a recipient; the PHP SDK README passes `recipient`
   * as an object. None of those three agree with each other. The shape used here is from
   * `openapi.yaml` in NotchPay's own PHP SDK repository, which is machine-readable, is what
   * their client is generated against, and is the only source that is self-consistent:
   *
   *     POST /beneficiaries  required: channel, name, account_number + (email | phone)
   *     POST /transfers      required: amount, currency, description
   *                          oneOf:    [beneficiary] | [recipient, channel]
   *
   * If the sandbox disagrees, believe the sandbox and update this comment with what it said.
   */
  async createPayout(payload: PayoutPayload): Promise<PayoutResult> {
    this.assertChargeable(payload.currency);

    const operator = resolveCameroonOperator(payload.phone);
    const channel = operator ? notchPayChannelFor(operator) : null;
    if (!channel) {
      // Not a refusal by NotchPay — we cannot tell which network to send on, and guessing
      // sends somebody else's money to the wrong rail.
      return {
        success: false,
        gatewayRef: null,
        status: 'FAILED',
        unsupported: true,
        message:
          'This destination number is not recognised as MTN or Orange Cameroon, so no NotchPay transfer channel applies.',
      };
    }

    try {
      /**
       * Step 1 — the beneficiary.
       *
       * A fresh one per transfer. Reusing them would mean storing a NotchPay id against each
       * owner's destination and keeping the two in step when the owner edits their number —
       * a second source of truth for where somebody's money goes, which is exactly the thing
       * `payout_method_snapshot` exists to avoid. The cost is one extra call on an
       * administrator-initiated action.
       *
       * `reference` carries OUR payout reference so the two records can be tied together in
       * the NotchPay dashboard during a reconciliation.
       */
      const beneficiaryResponse = await this.call(
        '/beneficiaries',
        'POST',
        {
          channel,
          name: payload.name,
          account_number: payload.phone,
          phone: payload.phone,
          country: 'CM',
          description: payload.description ?? 'Payout beneficiary',
          reference: payload.reference,
        },
        { grant: true }
      );

      const beneficiary = (beneficiaryResponse?.beneficiary ??
        beneficiaryResponse?.data ??
        beneficiaryResponse ??
        {}) as Record<string, any>;
      const beneficiaryId = beneficiary.id ? String(beneficiary.id) : null;

      if (!beneficiaryId) {
        // Nothing has moved: the transfer was never attempted. Reported as a refusal rather
        // than thrown so the payout lands in `failed` with a readable cause.
        return {
          success: false,
          gatewayRef: null,
          status: 'FAILED',
          message: 'NotchPay accepted the beneficiary but returned no id, so no transfer could be created.',
          raw: beneficiaryResponse,
        };
      }

      // Step 2 — the transfer.
      const response = await this.call(
        '/transfers',
        'POST',
        {
          amount: payload.amount,
          currency: payload.currency.toUpperCase(),
          beneficiary: beneficiaryId,
          channel,
          reference: payload.reference,
          description: payload.description ?? 'Payout',
        },
        { grant: true }
      );

      const transfer = (response?.transfer ?? response?.data ?? response ?? {}) as Record<string, any>;
      const rawStatus = String(transfer.status ?? 'pending');
      const status = this.normalizeStatus(rawStatus);

      return {
        success: status !== 'FAILED' && status !== 'CANCELLED',
        gatewayRef: transfer.id ? String(transfer.id) : null,
        status,
        message: status === 'FAILED' ? String(transfer.message ?? rawStatus) : undefined,
        raw: response,
      };
    } catch (error) {
      const blocked = this.payoutBlockedReason(error);
      if (blocked) {
        return { success: false, gatewayRef: null, status: 'FAILED', unsupported: true, message: blocked };
      }
      throw error;
    }
  }

  /**
   * Is this failure a knowable "cannot send" rather than a fault?
   *
   * Mirrors `isRefundForbidden` and differs in one respect that matters: a 403 on
   * `/transfers` has two plausible causes — transfers disabled on the account, or an egress
   * IP that is not on the allowlist — and from here they are indistinguishable. Both are
   * configuration, neither is transient, and an operator told only "forbidden" will check
   * the credentials, which are the one thing that is fine. So the message names both.
   */
  private payoutBlockedReason(error: unknown): string | null {
    if (!(error instanceof AppError)) return null;
    if (error.code !== ERROR_CODES.NOTCHPAY_REQUEST_FAILED) return null;

    const status = (error.details as { status?: number } | undefined)?.status;
    if (status === 403) {
      return (
        'NotchPay refused the transfer with 403. Two causes look identical here: transfers may '
        + 'not be enabled on this merchant account, or this server IP may not be registered on '
        + 'the NotchPay transfer allowlist (dashboard → Settings → Developer → IPs). The API '
        + 'credentials are NOT the likely problem — a bad key answers 401.'
      );
    }
    if (status === 422) {
      const body = (error.details as { body?: { message?: string } } | undefined)?.body;
      return `NotchPay rejected the transfer: ${body?.message ?? 'insufficient balance, or an invalid beneficiary or channel'}.`;
    }
    return null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * One status table for this gateway, used by initiate, verify AND the
   * webhook.
   *
   * There used to be two — one here and a smaller copy on the orchestrator that
   * the webhook path read — and they disagreed on `error` and on the
   * single-l `canceled` NotchPay actually sends. A webhook reporting a
   * cancellation therefore mapped to the default, `FAILED`, on one path and to
   * `CANCELLED` on the other for the same word.
   */
  private normalizeStatus(raw: unknown): PaymentGatewayStatus {
    const map: Record<string, PaymentGatewayStatus> = {
      pending: 'PENDING',
      processing: 'PENDING',
      /**
       * Transfer-only, and PENDING rather than SUCCEEDED: NotchPay reports `sent` when a
       * transfer has reached the mobile-money network and not yet been accepted by it.
       * Treating it as settled would mark a payout paid — and release its hold — on money
       * that can still bounce.
       */
      sent: 'PENDING',
      complete: 'SUCCEEDED',
      completed: 'SUCCEEDED',
      success: 'SUCCEEDED',
      successful: 'SUCCEEDED',
      failed: 'FAILED',
      error: 'FAILED',
      expired: 'FAILED',
      rejected: 'FAILED',
      cancelled: 'CANCELLED',
      canceled: 'CANCELLED',
      /**
       * Transfer-only. The money went and came back.
       *
       * ⚠ Mapped to FAILED because for a payout still `processing` that is exactly what it
       * means — nothing was delivered, and the hold stays. A `reversed` arriving on a payout
       * ALREADY marked paid is a different and much worse situation, and it is deliberately
       * not handled here: see `applyTransferOutcome` in the payout service, which records it
       * for a human rather than attempting an automatic accounting rollback it cannot do.
       */
      reversed: 'FAILED',
    };
    const key = String(raw ?? '').toLowerCase();
    // Unknown maps to PENDING, not FAILED. An unrecognised word is ignorance,
    // and calling a live payment dead strands the customer's money; the sweep
    // re-reads a PENDING row and settles it.
    return map[key] ?? 'PENDING';
  }

  private assertChargeable(currency: string): void {
    if (!isZeroDecimalCurrency(currency)) {
      throw createAppError(
        ERROR_CODES.PAYMENT_CURRENCY_NOT_SUPPORTED,
        422,
        `NotchPay cannot be charged in ${currency}.`,
        { currency }
      );
    }
  }

  /**
   * The one outbound call.
   *
   * Native `fetch` + `AbortController` with a config-supplied timeout is the
   * house idiom (`tracking-dispatch.worker.ts:172`), and the error mapping
   * follows `nominatim.provider.ts:123` — non-2xx is 502, unreachable is 503.
   * Diagnostics go in `details`, which is safe because the boundary drops
   * `details` for every `external_service` category.
   */
  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    options: { grant?: boolean } = {}
  ): Promise<any> {
    const publicKey = NOTCHPAY_CONFIG.PUBLIC_KEY;
    if (!publicKey) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'NotchPay is not configured. Set NOTCHPAY_PUBLIC_KEY in the environment.'
      );
    }
    if (options.grant && !NOTCHPAY_CONFIG.PRIVATE_KEY) {
      throw createAppError(
        ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
        503,
        'NotchPay refunds need NOTCHPAY_PRIVATE_KEY (the X-Grant credential).'
      );
    }

    const headers: Record<string, string> = {
      Authorization: publicKey,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (options.grant) headers['X-Grant'] = NOTCHPAY_CONFIG.PRIVATE_KEY;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTCHPAY_CONFIG.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${NOTCHPAY_CONFIG.BASE_URL}${path}`, {
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
          ERROR_CODES.NOTCHPAY_REQUEST_FAILED,
          502,
          `NotchPay ${method} ${path} answered ${response.status}`,
          { status: response.status, body: parsed }
        );
        recordIntegrationCall('notchpay', startedAt, failure);
        throw failure;
      }

      recordIntegrationCall('notchpay', startedAt);
      return parsed;
    } catch (error: any) {
      // Re-throw an AppError untouched, or the 502 raised just above would be
      // rewritten as a 503 by its own catch.
      if (error instanceof AppError) throw error;
      const unreachable = createAppError(
        ERROR_CODES.NOTCHPAY_UNREACHABLE,
        503,
        `NotchPay ${method} ${path} did not respond`,
        { cause: error?.message ?? String(error) }
      );
      recordIntegrationCall('notchpay', startedAt, unreachable);
      throw unreachable;
    } finally {
      clearTimeout(timer);
    }
  }
}
