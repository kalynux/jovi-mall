import { PaymentGatewayName } from '../../payments/gateways/gateway.interface';

/**
 * Which aggregator a payout's transfer goes through (ADR-A08, owner decision 3).
 *
 * ── THE STORED VALUE WINS, ALWAYS ────────────────────────────────────────────
 * The payout aggregator is an administrator's runtime switch, and a payout can outlive a switch:
 * a transfer that failed on NotchPay is retried after the platform moved to another aggregator.
 * That retry must go back through NotchPay. Its reference (`jm_po_…`) is reused on every attempt
 * precisely so the gateway that may already have paid deduplicates the resend; sending it to a
 * different gateway defeats that and can pay the owner twice. So `transfer_gateway` is stamped in
 * the same atomic claim that fixes the reference, and from then on it decides.
 *
 * ── A NULL IS NOT ONE THING ──────────────────────────────────────────────────
 * `transfer_gateway` is null on every row written before it existed, and on every row never sent.
 * They need opposite answers:
 *   - a row with a `transfer_reference` was SENT, and before ADR-A08 every send went through
 *     NotchPay (the old hardcoded `PAYOUT_GATEWAY`). It is NotchPay's.
 *   - a row with no reference has never reached a gateway. It takes the active aggregator.
 *
 * `active` is `resolvePayoutAggregator()`: null when the settings name no registered gateway,
 * and then only a row that already has a gateway can be resolved.
 *
 * Pure: no I/O.
 */
export const LEGACY_PAYOUT_GATEWAY: PaymentGatewayName = 'NOTCHPAY';

export interface PayoutGatewayRow {
  transfer_gateway?: PaymentGatewayName | null;
  transfer_reference?: string | null;
}

export function payoutGatewayFor(
  row: PayoutGatewayRow,
  active: PaymentGatewayName | null
): PaymentGatewayName | null {
  if (row.transfer_gateway) return row.transfer_gateway;
  if (row.transfer_reference) return LEGACY_PAYOUT_GATEWAY;
  return active;
}

/**
 * The gateway a transfer CALLBACK is judged against. A payout with no stored gateway can only
 * have been sent before ADR-A08, which means through NotchPay.
 */
export function storedPayoutGateway(row: PayoutGatewayRow): PaymentGatewayName {
  return row.transfer_gateway ?? LEGACY_PAYOUT_GATEWAY;
}
