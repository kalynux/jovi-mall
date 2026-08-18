import { PaymentGateway, PaymentGatewayName } from './gateway.interface';
import { NotchPayGateway } from './notchpay.gateway';
import { MyCoolPayGateway } from './mycoolpay.gateway';
import { StripeGateway } from './stripe.gateway';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * The one gateway registry.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * There used to be three identical `Map<PaymentGatewayType, PaymentGateway>`
 * literals — on `PaymentOrchestratorService`, on `CreditTopupService` and on
 * `PlanPurchaseService` — and the orchestrator itself is constructed twice at
 * import (once by each router). Five instances of every gateway, each reading
 * `process.env` in its constructor, each logging its own "not configured"
 * warning at boot.
 *
 * Three copies of a lookup table is a drift problem before it is a tidiness
 * one: a gateway added to the orchestrator and not to billing is a gateway
 * that silently cannot sell a plan, and nothing fails to compile.
 *
 * ── THE REGISTRY IS ALSO THE TEST SURFACE ────────────────────────────────────
 * `test:payments` enumerates `PAYMENT_GATEWAYS` and asserts every member
 * implements `verifyWebhook` and `parseWebhookEvent`. That assertion is the
 * thing standing between "someone adds a fourth gateway" and "a fourth
 * unverified webhook endpoint goes live", and it only works because there is
 * exactly one list to enumerate.
 *
 * Construction is cheap and side-effect-free — every gateway reads its
 * configuration lazily, at call time — so a module-scope map costs nothing at
 * boot and cannot warn about credentials nobody has needed yet.
 */
const gateways: ReadonlyMap<PaymentGatewayName, PaymentGateway> = new Map<
  PaymentGatewayName,
  PaymentGateway
>([
  ['NOTCHPAY', new NotchPayGateway()],
  ['MYCOOLPAY', new MyCoolPayGateway()],
  ['STRIPE', new StripeGateway()],
]);

export const PAYMENT_GATEWAYS = gateways;

/** Every gateway name the platform knows, in registration order. */
export const PAYMENT_GATEWAY_NAMES: readonly PaymentGatewayName[] = Object.freeze([
  ...gateways.keys(),
]);

/**
 * Resolve a gateway, or refuse.
 *
 * 400 rather than 500: the gateway name arrives from a client-supplied enum, so
 * an unknown one is a bad request rather than a broken service.
 */
export function getPaymentGateway(name: string): PaymentGateway {
  const gateway = gateways.get(name as PaymentGatewayName);
  if (!gateway) {
    throw createAppError(
      ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED,
      400,
      `Unsupported payment gateway: ${name}`,
      { gateway: name }
    );
  }
  return gateway;
}

/** Non-throwing lookup, for the webhook router and the reconciliation sweep. */
export function findPaymentGateway(name: string): PaymentGateway | null {
  return gateways.get(name as PaymentGatewayName) ?? null;
}

/**
 * Whether this gateway can refund through its API.
 *
 * **Derived, never listed.** There used to be a hardcoded
 * `NON_REFUNDABLE_GATEWAYS = ['NOTCHPAY','MYCOOLPAY']` in
 * `orders/admin-refund.service.ts` answering the same question a few files
 * away from the guard that actually enforces it — two sources of truth for
 * "can this be refunded", free to disagree. They did: both mobile gateways
 * *defined* `refundPayment`, so the orchestrator's `typeof` guard never fired
 * and the code actually raised was `REFUND_GATEWAY_FAILED` rather than the
 * `REFUND_GATEWAY_NOT_SUPPORTED` the list promised and the api-doc documented.
 *
 * Now NotchPay has a real refund API and My-CoolPay has none, and this one
 * predicate is what both the up-front verdict and the enforcement read.
 */
export function gatewaySupportsRefund(name: string): boolean {
  const gateway = findPaymentGateway(name);
  if (typeof gateway?.refundPayment !== 'function') return false;
  // Two questions, not one — see `refundAvailable` on the interface. The method
  // existing says the integration is built; this says the merchant account will
  // actually accept the call. NotchPay ships the first and, today, not the
  // second: `POST /refunds` answers 403 while `GET /refunds` is 200.
  return gateway.refundAvailable?.() ?? true;
}

/**
 * Does this gateway have a refund integration at all, regardless of whether our
 * account may use it?
 *
 * Kept separate so a diagnostic surface can tell an operator *why* a refund is
 * unavailable — "this provider has no refund API" and "ours is switched off"
 * are different conversations, and only one of them is fixable by an email.
 */
export function gatewayImplementsRefund(name: string): boolean {
  return typeof findPaymentGateway(name)?.refundPayment === 'function';
}

/** Whether this gateway has an OTP step (`POST /payments/:id/authorize`). */
export function gatewaySupportsOtp(name: string): boolean {
  const gateway = findPaymentGateway(name);
  return typeof gateway?.authorizePayment === 'function';
}
