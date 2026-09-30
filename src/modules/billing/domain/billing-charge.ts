import { ZodError } from 'zod';
import { CollectField, PaymentChannelInfo, PaymentGatewayName } from '../../payments/gateways/gateway.interface';
import { PaymentProvider, isMobileMoneyProvider } from '../../payments/domain/payment-provider';
import {
  checkChargeRequestOrThrow,
  resolveCollectionRoute,
} from '../../payments/services/payment-routing.service';

/**
 * Which aggregator opens a NEW billing charge (a credit top-up or a plan purchase), and what the
 * adapter is sent (ADR-A08).
 *
 * ── THE DOOR ORDER, AND WHY IT IS ALL HERE ───────────────────────────────────
 * Billing used to take the aggregator from the client and go straight to `getPaymentGateway`,
 * skipping the "is this gateway offered" check every other door made. This function is the
 * single place both billing services pass through, in the order the other doors use:
 *
 *   1. the provider (derived by the controller: `deriveProviderOrThrow`)
 *   2. the no-I/O checks: a required field, then the provider/number mismatch
 *   3. the route: which aggregator, from the settings (`resolveCollectionRoute`)
 *   4. the route's own capability, which may require more fields than the baseline
 *
 * Every refusal is raised here, BEFORE the caller writes its pending row. A refused charge
 * leaves nothing behind.
 *
 * ⛔ **New charges only.** Verify, authorize and the webhook settle through the gateway stored on
 * the row. None of them may call this: after an administrator switches aggregator, a pending
 * top-up must still be confirmed by the gateway that opened it.
 */
export interface BillingChargeSelection {
  provider: PaymentProvider;
}

export interface BillingChargeRoute {
  aggregator: PaymentGatewayName;
  provider: PaymentProvider;
  /** What the adapter receives. On a mobile provider, `phoneOperator` is the provider. */
  channel: PaymentChannelInfo;
}

/**
 * The HTTP billing doors' error for a missing field: a `400 VALIDATION_ERROR` on
 * `channel.<field>`, the same shape the payment doors raise. Billing had no such refusal before
 * (a missing number reached the adapter and failed after the row was written).
 *
 * TODO(C1): the payment orchestrator carries an identical private builder; merge the two when
 * the deprecated overloads go.
 */
export function missingBillingFieldError(missing: CollectField[]): ZodError {
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

export function resolveBillingCharge(
  selection: BillingChargeSelection,
  channel: PaymentChannelInfo,
): BillingChargeRoute {
  const { provider } = selection;

  const baseline = checkChargeRequestOrThrow(provider, channel);
  if (!baseline.ok) throw missingBillingFieldError(baseline.missing);

  const route = resolveCollectionRoute(provider);

  const full = checkChargeRequestOrThrow(provider, channel, route.capability);
  if (!full.ok) throw missingBillingFieldError(full.missing);

  return {
    aggregator: route.aggregator,
    provider,
    // The declared provider is what the adapter charges: NotchPay otherwise re-derives the
    // operator, and a stale `phoneOperator` from the client would outrank the customer's choice.
    channel: isMobileMoneyProvider(provider) ? { ...channel, phoneOperator: provider } : channel,
  };
}
