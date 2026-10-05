import { PaymentChannelInfo, PaymentGatewayName } from '../../payments/gateways/gateway.interface';
import { PaymentProvider, isMobileMoneyProvider } from '../../payments/domain/payment-provider';
import {
  assertAmountWithinRoute,
  checkChargeRequestOrThrow,
  isCustomerChargeRefusal,
  missingFieldValidationError,
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
 * A missing field is the payment doors' own `400 VALIDATION_ERROR` on `channel.<field>`
 * (`missingFieldValidationError`, one builder shared with the orchestrator since C1). Billing had
 * no such refusal before: a missing number reached the adapter and failed after the row was
 * written.
 */
export function resolveBillingCharge(
  selection: BillingChargeSelection,
  channel: PaymentChannelInfo,
  /** What will be charged: checked against the route's limits (`422 PAYMENT_AMOUNT_OUT_OF_RANGE`). */
  amount: number,
): BillingChargeRoute {
  const { provider } = selection;

  const baseline = checkChargeRequestOrThrow(provider, channel);
  if (!baseline.ok) throw missingFieldValidationError(baseline.missing);

  const route = resolveCollectionRoute(provider);

  const full = checkChargeRequestOrThrow(provider, channel, route.capability);
  if (!full.ok) throw missingFieldValidationError(full.missing);
  assertAmountWithinRoute(route, amount);

  return {
    aggregator: route.aggregator,
    provider,
    // The declared provider is what the adapter charges: NotchPay otherwise re-derives the
    // operator, and a stale `phoneOperator` from the client would outrank the customer's choice.
    channel: isMobileMoneyProvider(provider) ? { ...channel, phoneOperator: provider } : channel,
  };
}

/**
 * Run the adapter call; when the provider refuses in a way the customer must act on (a payment
 * code refused, an amount out of range — `isCustomerChargeRefusal`), mark the pending row failed
 * before the refusal reaches them, so it is not left `pending` with nothing at the gateway.
 * Every other throw keeps its historical behaviour (the row stays as it was).
 */
export async function chargeOrMarkFailed<T>(
  charge: () => Promise<T>,
  markFailed: () => Promise<unknown>,
): Promise<T> {
  try {
    return await charge();
  } catch (error) {
    if (isCustomerChargeRefusal(error)) await markFailed().catch(() => undefined);
    throw error;
  }
}
