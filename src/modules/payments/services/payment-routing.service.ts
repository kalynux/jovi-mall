import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { PaymentGatewayName, ProviderCollectCapability } from '../gateways/gateway.interface';
import { buildRoutingFacts, findPaymentGateway } from '../gateways/registry';
import { PaymentProvider } from '../domain/payment-provider';
import {
  ChargeRequestChannel,
  ChargeRequestCheck,
  ProviderDerivationInput,
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

/** `checkChargeRequest` followed by `enforceChargeRequestCheck`. */
export function checkChargeRequestOrThrow(
  provider: PaymentProvider,
  channel: ChargeRequestChannel | null | undefined,
  capability?: ProviderCollectCapability,
): ChargeRequestOutcome {
  return enforceChargeRequestCheck(checkChargeRequest(provider, channel, capability));
}
