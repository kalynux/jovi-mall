import { createAppError } from '../../../core/errors';
import { ERROR_CODES, ErrorCode } from '../../../core/error-codes';
import { PAYMENTS_CONFIG } from '../../payments/config/payments.config';
import { getPaymentGateway } from '../../payments/gateways/registry';
import { PaymentInstructions } from '../../payments/gateways/gateway.interface';

/**
 * Relaying a mobile-money one-time code for a BILLING purchase — a credit
 * top-up or a self-serve plan purchase.
 *
 * ── WHY THIS IS NOT `PaymentOrchestratorService.authorizePayment` ────────────
 * That method resolves its argument with `PaymentTransactionModel.findById`,
 * and **a billing purchase deliberately creates no row in that collection** —
 * see the note on `IPaymentTransaction.merchantRef`, which exists precisely
 * because a plan purchase and a top-up settle through their own tables. So the
 * orchestrator could only serve this by growing a three-collection fallback on
 * an endpoint that is UNAUTHENTICATED by design (payment links are shareable,
 * and the payer is often not the orderer — `payment.routes.ts`).
 *
 * That justification does not reach billing: a top-up is started by a
 * signed-in vendor/agency/agent from their own dashboard, and the OTP arrives
 * on the phone number they typed a moment earlier. There is no third party to
 * accommodate, so the code is submitted through the same owner-scoped routes
 * that started the purchase and that poll it afterwards.
 *
 * ── WHY ONE COPY AND NOT TWO ─────────────────────────────────────────────────
 * `CreditTopupService` and `PlanPurchaseService` mirror each other throughout,
 * and mirroring this too would be two chances to loosen an attempt cap on a
 * money path. The two rows differ only in which collection they live in and
 * which "not found" code they answer with, so the rule lives here once and
 * takes the row.
 *
 * ── THE FLOW ITSELF ──────────────────────────────────────────────────────────
 * My-CoolPay's Orange Money branch answers `REQUIRE_OTP` at initiation, with no
 * USSD code: the operator SMSes a code and **takes no money at all** until it
 * is relayed back. Before this existed, every Orange Money plan purchase and
 * top-up was initiated, charged nothing, and expired.
 *
 * Success here does NOT mean the money moved. The gateway's own reply is
 * "confirm the prompt on your phone" — the row stays `pending` and settles the
 * way it always did, through the webhook or the caller's `/verify` poll.
 */

/** The fields this rule needs. `ICreditTopup` and `IPlanPurchase` both satisfy it. */
export interface OtpAuthorizableRow {
  status: 'pending' | 'paid' | 'failed' | 'reversed';
  gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE' | null;
  gateway_ref: string | null;
  otp_attempts: number;
  save(): Promise<unknown>;
}

export interface GatewayOtpResult {
  instructions: PaymentInstructions | null;
  message: string;
}

/**
 * Submit `code` against `row`'s open charge.
 *
 * `invalidStateCode` is the caller's own "this row is not in a state that can
 * take a code" code (`BILLING_TOPUP_INVALID_STATE` /
 * `BILLING_PURCHASE_INVALID_STATE`), so the refusal names the thing the caller
 * asked about rather than a payment transaction that does not exist.
 *
 * The row must already have been resolved AND scoped to its owner by the
 * caller — this function does no authorization of its own.
 */
export async function submitGatewayOtp(
  row: OtpAuthorizableRow,
  code: string,
  invalidStateCode: ErrorCode
): Promise<GatewayOtpResult> {
  // A settled row takes no more codes. `paid` in particular must refuse rather
  // than pass through: a second accepted code on a completed purchase is a
  // second charge on the owner's phone.
  if (row.status !== 'pending') {
    throw createAppError(invalidStateCode, 409, undefined, { status: row.status });
  }
  if (!row.gateway || !row.gateway_ref) {
    throw createAppError(invalidStateCode, 409, 'This purchase has no gateway reference yet');
  }

  const gateway = getPaymentGateway(row.gateway);
  if (typeof gateway.authorizePayment !== 'function') {
    throw createAppError(ERROR_CODES.PAYMENT_OTP_NOT_REQUIRED, 422, undefined, {
      gateway: row.gateway,
    });
  }

  // Counted and PERSISTED before the call, so an attempt cannot be spent for
  // free by aborting the request while the gateway is still thinking. Same
  // order as `PaymentOrchestratorService.authorizePayment`, and for the same
  // reason.
  row.otp_attempts = (row.otp_attempts ?? 0) + 1;
  if (row.otp_attempts > PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS) {
    row.status = 'failed';
    await row.save();
    throw createAppError(ERROR_CODES.PAYMENT_OTP_ATTEMPTS_EXCEEDED, 422);
  }
  await row.save();

  const result = await gateway.authorizePayment({ gatewayRef: row.gateway_ref, code });

  if (!result.success) {
    throw createAppError(ERROR_CODES.PAYMENT_OTP_INVALID, 422, undefined, {
      attemptsRemaining: Math.max(0, PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS - row.otp_attempts),
    });
  }

  return {
    instructions: result.instructions ?? null,
    message: 'Code accepted. Confirm the payment prompt on your phone.',
  };
}
