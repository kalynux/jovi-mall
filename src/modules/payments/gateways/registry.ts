import { PaymentGateway, PaymentGatewayName, PAYMENT_GATEWAY_NAMES } from './gateway.interface';
import { NotchPayGateway } from './notchpay.gateway';
import { MyCoolPayGateway } from './mycoolpay.gateway';
import { StripeGateway } from './stripe.gateway';
import { CampayGateway } from './campay.gateway';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { campayEnabled, myCoolPayEnabled, notchPayEnabled, stripeEnabled } from '../config/payments.config';
import { getPaymentSettingsSync } from '../services/payment-settings.service';
import type { AggregatorFacts, RoutingFacts } from '../domain/payment-routing';

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
  ['CAMPAY', new CampayGateway()],
]);

export const PAYMENT_GATEWAYS = gateways;

/**
 * Every gateway name the platform knows. Defined once in `gateway.interface.ts` (ADR-A08) and
 * re-exported here for the importers that already read it from the registry. `test:payment-routing`
 * asserts the map above registers exactly these names.
 */
export { PAYMENT_GATEWAY_NAMES };

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

/**
 * Which gateways may OPEN a new charge on this deployment — a question about configuration, and
 * a different one from "does the platform know this gateway".
 *
 * ── WHY IT IS NOT `getPaymentGateway` ────────────────────────────────────────
 * That lookup serves verify, webhooks, refunds and the reconciliation sweep too, and every one of
 * those must keep working for a gateway that has since been switched off: a payment already
 * taken still settles, still reconciles and can still be refunded. Only a NEW charge is refused.
 *
 * ── WHY A TABLE KEYED BY NAME ────────────────────────────────────────────────
 * `Record<PaymentGatewayName, …>` makes a fourth gateway without an answer a compile error, the
 * same property `PAYMENT_GATEWAYS` gives the webhook verifiers.
 *
 * ⛔ **This is the ONLY routing input read from the environment** (ADR-A08). Credentials say
 * whether an aggregator CAN be used; the administrator's `payment_settings` say which one IS.
 * `test:payment-settings` fails if any other file makes a decision from these predicates
 * (the integration inventory reads them as a diagnostic, and is allowed to).
 *
 * ⚠ Cards need BOTH now: Stripe's secrets AND `stripe_enabled` in the settings (owner decision 2).
 * Setting the secrets alone no longer turns cards on.
 */
const CONFIGURED: Readonly<Record<PaymentGatewayName, () => boolean>> = Object.freeze({
  NOTCHPAY: notchPayEnabled,
  MYCOOLPAY: myCoolPayEnabled,
  STRIPE: stripeEnabled,
  CAMPAY: campayEnabled,
});

/**
 * Whether this gateway's credentials are present on this deployment. False for an unknown name.
 *
 * Only half of "may a new charge be opened here" since ADR-A08: the other half is the
 * administrator's `payment_settings`. See `gatewayAcceptsNewPayments`.
 */
export function gatewayConfigured(name: string): boolean {
  if (!gateways.has(name as PaymentGatewayName)) return false;
  return CONFIGURED[name as PaymentGatewayName]();
}

/**
 * Whether a new charge may be opened on this gateway right now. False for an unknown name.
 *
 * ADR-A08: configured AND (it is the active collection aggregator, OR it is Stripe while Stripe
 * is switched on). With no settings document the defaults apply: NotchPay only, Stripe off.
 *
 * Since C1 no door opens a charge on a gateway its caller named; the one reader left is the
 * pay-link mint (`assertGatewayOffered`), for a transaction that already exists. (The version-0
 * "configured alone" transition bridge was removed in C1.)
 */
export function gatewayAcceptsNewPayments(name: string): boolean {
  if (!gatewayConfigured(name)) return false;
  const settings = getPaymentSettingsSync();
  return name === settings.collection_aggregator || (name === 'STRIPE' && settings.stripe_enabled);
}

/** The gateways a new charge may be opened on, in registration order. Same rule as above. */
export function offeredPaymentGateways(): PaymentGatewayName[] {
  return PAYMENT_GATEWAY_NAMES.filter((name) => gatewayAcceptsNewPayments(name));
}

/**
 * The per-aggregator facts payment routing decides from (ADR-A08). Built here because every
 * input is the registry's: credentials, the adapter's declared capabilities, and its payout
 * support. `payments/domain/payment-routing.ts` stays pure by taking these as an argument.
 */
export function buildRoutingFacts(): RoutingFacts {
  const facts = {} as Record<PaymentGatewayName, AggregatorFacts>;
  for (const name of PAYMENT_GATEWAY_NAMES) {
    facts[name] = {
      configured: gatewayConfigured(name),
      capabilities: gateways.get(name)!.capabilities,
      payoutImplemented: gatewayImplementsPayout(name),
      payoutAvailable: gatewaySupportsPayout(name),
    };
  }
  return facts;
}

/**
 * Refuse a new charge on a gateway this deployment does not offer — BEFORE anything is written.
 *
 * ⚠ **`PAYMENT_GATEWAY_NOT_SUPPORTED` at 400, the code and status `getPaymentGateway` already
 * raises for a name it does not know.** To the caller the two are one situation — "you named a
 * gateway that is not on offer here; name another" — and `test:errors` allows one status per
 * code. It is NOT `PAYMENT_GATEWAY_NOT_CONFIGURED` (500), which means the deployment has no
 * gateway at all and is our fault; nor `PAYMENT_GATEWAY_NOT_IMPLEMENTED` (503), which the
 * adapters raise from INSIDE a call that has already opened a row.
 *
 * `details.offered` names what the caller may use instead, so a client can recover without a
 * second request. It is configuration, not a secret.
 */
export function assertGatewayOffered(name: string): void {
  if (gatewayAcceptsNewPayments(name)) return;
  throw createAppError(
    ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED,
    400,
    name === 'STRIPE'
      ? 'Card payments are not available right now. Please pay with mobile money.'
      : `Payments through ${name} are not available right now.`,
    { gateway: name, offered: offeredPaymentGateways() }
  );
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

/**
 * Can this gateway send money right now?
 *
 * Both halves matter and they answer different questions — exactly as
 * `gatewaySupportsRefund` above. The METHOD is a capability of the integration;
 * `payoutAvailable()` is a fact about the account. A gateway that implements transfers on an
 * account where they are off must report false, or an administrator is offered a send button
 * that fails the instant it is pressed.
 *
 * ⚠ On this side the account-level half has a cause the refund one does not: NotchPay
 * IP-allowlists transfers, so a correctly-configured integration on an unregistered host
 * refuses every call. That is why the switch is deployment configuration rather than
 * something derived from the credentials being present.
 */
export function gatewaySupportsPayout(name: string): boolean {
  const gateway = findPaymentGateway(name);
  if (typeof gateway?.createPayout !== 'function') return false;
  return gateway.payoutAvailable?.() ?? true;
}

/**
 * Does this gateway have a disbursement integration at all, regardless of whether our
 * account or our host may use it?
 *
 * Kept separate for the reason `gatewayImplementsRefund` is: "this provider cannot send"
 * and "ours is switched off" are different conversations, and only one is fixable by an
 * email.
 */
export function gatewayImplementsPayout(name: string): boolean {
  return typeof findPaymentGateway(name)?.createPayout === 'function';
}

/** Whether this gateway has an OTP step (`POST /payments/:id/authorize`). */
export function gatewaySupportsOtp(name: string): boolean {
  const gateway = findPaymentGateway(name);
  return typeof gateway?.authorizePayment === 'function';
}
