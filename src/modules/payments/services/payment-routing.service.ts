import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ZodError } from 'zod';
import { CollectField, PaymentGatewayName, ProviderCollectCapability } from '../gateways/gateway.interface';
import { buildRoutingFacts, findPaymentGateway } from '../gateways/registry';
import { PaymentProvider } from '../domain/payment-provider';
import {
  ChargeRequestChannel,
  ChargeRequestCheck,
  ProviderDerivationInput,
  checkAmountLimits,
  checkChargeRequest,
  deriveProvider,
  effectiveProviders,
  routeCollection,
} from '../domain/payment-routing';
import { getPaymentSettingsSync } from './payment-settings.service';

/**
 * The one door for choosing an aggregator for a NEW charge (ADR-A08).
 *
 * The decisions are made in `domain/payment-routing.ts`, which is pure. This file supplies the
 * live inputs (the cached settings and the registry's facts) and turns a refusal into the
 * platform error. It never opens a charge and never writes.
 *
 * ⛔ **Verify, refund, authorize, webhooks, reconciliation and pay-link sessions must not call
 * anything here.** They read `transaction.gateway` from the stored row, so money opened on one
 * aggregator settles through it after a switch (ADR-A08 D-6).
 *
 * Order at a charging door (W2a):
 *   1. `deriveProviderOrThrow(body)`: which provider is meant.
 *   2. `checkChargeRequestOrThrow(provider, channel)`: required fields and the number mismatch,
 *      before anything is written. A missing field comes back for the door's own error.
 *   3. idempotency and live-attempt reuse (the door's own logic).
 *   4. `resolveCollectionRoute(provider)`: which aggregator opens the new charge.
 */

export { buildRoutingFacts };

export interface CollectionRouteResult {
  aggregator: PaymentGatewayName;
  provider: PaymentProvider;
  capability: ProviderCollectCapability;
}

/** The providers a customer may choose right now, in catalogue order. What `/options` lists. */
export function offeredProviders(): PaymentProvider[] {
  return effectiveProviders(getPaymentSettingsSync(), buildRoutingFacts()).map((e) => e.provider);
}

/**
 * Which aggregator opens a new charge for `provider`. Routing ONLY: the request checks run
 * before this, separately.
 *
 * Throws `422 PAYMENT_PROVIDER_UNAVAILABLE` with `{ provider, offered }` when the provider is
 * disabled or no aggregator can route it. Nothing has been written at that point.
 */
export function resolveCollectionRoute(provider: PaymentProvider): CollectionRouteResult {
  const settings = getPaymentSettingsSync();
  const facts = buildRoutingFacts();
  const route = routeCollection(provider, settings, facts);
  if (route.ok) return { aggregator: route.aggregator, provider, capability: route.capability };

  throw createAppError(
    ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE,
    422,
    provider === 'CARD'
      ? 'Card payments are not available right now. Please choose another payment method.'
      : `${provider} payments are not available right now. Please choose another payment method.`,
    { provider, offered: effectiveProviders(settings, facts).map((e) => e.provider) },
  );
}

/**
 * The aggregator payouts go through, from the settings. Null when the stored name is not a
 * registered gateway. Whether it can actually send stays the payout service's question
 * (`gatewaySupportsPayout`), so its existing errors keep their meaning.
 */
export function resolvePayoutAggregator(): PaymentGatewayName | null {
  const name = getPaymentSettingsSync().payout_aggregator;
  return findPaymentGateway(name) ? name : null;
}

/** The provider a request means (see `deriveProvider`), or `400 PAYMENT_PROVIDER_REQUIRED`. */
export function deriveProviderOrThrow(input: ProviderDerivationInput): PaymentProvider {
  const provider = deriveProvider(input);
  if (provider) return provider;
  throw createAppError(
    ERROR_CODES.PAYMENT_PROVIDER_REQUIRED,
    400,
    'Please choose a payment method (provider: MTN, ORANGE or CARD)',
  );
}

/** What a door gets back after the mismatch has been raised: pass, or a missing field. */
export type ChargeRequestOutcome = Exclude<ChargeRequestCheck, { refusal: 'PHONE_MISMATCH' }>;

/**
 * Raise a `checkChargeRequest` mismatch as `422 PAYMENT_PROVIDER_PHONE_MISMATCH`
 * (`{ provider, detected, spent: false }`). A `FIELD_MISSING` refusal is RETURNED, not raised,
 * because each door already has its own error for a missing number (HTTP `400
 * VALIDATION_ERROR`, bot `422 PAYMENT_PAYER_NUMBER_REQUIRED`) and keeps it.
 */
export function enforceChargeRequestCheck(check: ChargeRequestCheck): ChargeRequestOutcome {
  if (check.ok || check.refusal !== 'PHONE_MISMATCH') return check;
  throw createAppError(
    ERROR_CODES.PAYMENT_PROVIDER_PHONE_MISMATCH,
    422,
    `This number is on ${check.detected}, not ${check.provider}. Please check the number or choose ${check.detected}.`,
    { provider: check.provider, detected: check.detected, spent: false },
  );
}

/**
 * The HTTP doors' error for a missing channel field: `400 VALIDATION_ERROR` on
 * `channel.<field>`, in the shape the pre-ADR-A08 request schemas raised it. The payment
 * orchestrator and the billing doors both use this ONE builder (C1 merged their two copies), so
 * a checkout and a plan purchase word the refusal identically. Doors with their own error for a
 * missing number (the bot's `PAYMENT_PAYER_NUMBER_REQUIRED`) pass that instead.
 */
export function missingFieldValidationError(missing: CollectField[]): ZodError {
  return new ZodError(
    missing.map((field) => ({
      code: 'custom' as const,
      path: ['channel', field],
      message: field === 'phoneNumber'
        ? 'phoneNumber is required for mobile money payments'
        : `${field} is required for this payment method`,
    })),
  );
}

/**
 * `checkChargeRequest` followed by `enforceChargeRequestCheck`.
 *
 * ⚠ **A missing `paymentCode` is RAISED, not returned** — `422 PAYMENT_CODE_REQUIRED`
 * `{ provider, ussd, spent: false }` — because no door has an error of its own for it, and a
 * generic "field required" would leave the customer without the one thing they need: what to
 * dial. Only once the number is present: a missing number keeps each door's own error, and the
 * code is asked for on the next try.
 */
export function checkChargeRequestOrThrow(
  provider: PaymentProvider,
  channel: ChargeRequestChannel | null | undefined,
  capability?: ProviderCollectCapability,
): ChargeRequestOutcome {
  const outcome = enforceChargeRequestCheck(checkChargeRequest(provider, channel, capability));
  if (outcome.ok || !outcome.missing.includes('paymentCode')) return outcome;
  if (!outcome.missing.includes('phoneNumber')) throw paymentCodeRequiredError(provider, capability);
  return { ...outcome, missing: outcome.missing.filter((field) => field !== 'paymentCode') };
}

/** `422 PAYMENT_CODE_REQUIRED` for a `CODE_FIRST` route charged without its code. */
export function paymentCodeRequiredError(provider: PaymentProvider, capability?: ProviderCollectCapability) {
  const ussd = capability?.codeUssd ?? null;
  return createAppError(
    ERROR_CODES.PAYMENT_CODE_REQUIRED,
    422,
    ussd
      ? `To pay with ${providerLabel(provider)}, dial ${ussd} to get a payment code, then enter it and pay again.`
      : `To pay with ${providerLabel(provider)}, get a payment code from your mobile money menu, then enter it and pay again.`,
    { provider, ussd, spent: false },
  );
}

/**
 * Refuse an amount the route's aggregator does not accept: `422 PAYMENT_AMOUNT_OUT_OF_RANGE`
 * `{ provider, amount, min, max, spent: false }`. Call where the route AND the amount are known,
 * before anything is written (owner decision 2026-10-05: a clear refusal, no automatic failover).
 */
export function assertAmountWithinRoute(route: CollectionRouteResult, amount: number): void {
  const check = checkAmountLimits(route.capability, amount);
  if (check.ok) return;
  throw createAppError(
    ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE,
    422,
    amount > check.max
      ? `${providerLabel(route.provider)} payments are limited to ${formatXaf(check.max)} right now, and this one is ${formatXaf(amount)}. Please contact support to pay this amount.`
      : `${providerLabel(route.provider)} payments must be at least ${formatXaf(check.min)}.`,
    { provider: route.provider, amount, min: check.min, max: check.max, spent: false },
  );
}

/**
 * The charge refusals a client must see AS THEMSELVES, never folded into a generic
 * `PAYMENT_INITIATION_FAILED`: each tells the customer exactly what to do next (enter a code, get
 * a new one, pay a different amount, use the other network).
 *
 * `PAYMENT_PROVIDER_UNAVAILABLE` from an ADAPTER means the aggregator says that one network is
 * temporarily down (PawaPay `PROVIDER_TEMPORARILY_UNAVAILABLE`, `details.temporary`): nothing was
 * charged, and "try the other network or later" is the useful answer. Owner decision 2026-10-06.
 */
export function isCustomerChargeRefusal(error: unknown): error is AppError {
  return error instanceof AppError && (
    error.code === ERROR_CODES.PAYMENT_CODE_REQUIRED ||
    error.code === ERROR_CODES.PAYMENT_CODE_REJECTED ||
    error.code === ERROR_CODES.PAYMENT_AMOUNT_OUT_OF_RANGE ||
    error.code === ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE
  );
}

function providerLabel(provider: PaymentProvider): string {
  return provider === 'MTN' ? 'MTN Mobile Money' : provider === 'ORANGE' ? 'Orange Money' : provider;
}

function formatXaf(amount: number): string {
  return `${Math.trunc(amount).toLocaleString('en-US')} FCFA`;
}
