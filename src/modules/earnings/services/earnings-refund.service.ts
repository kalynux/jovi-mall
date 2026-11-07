import { EarningsSourceType } from '../models/earnings-allocation.model';
import { ClawbackOutcome, EarningsClawbackService, earningsClawbackService } from './earnings-clawback.service';

/**
 * EarningsRefundService — the OLD entry point for "this order/booking was refunded", kept as a
 * thin wrapper over `EarningsClawbackService` so its callers (`dispute.service.ts`,
 * `booking-refund.service.ts`, the payment orchestrator) keep compiling while wave 2 of the
 * refund flow rewires them (REFUND-FLOW-PLAN § 4, § 6).
 *
 * ── What changed underneath (2026-10-05) ────────────────────────────────────────────────
 * It used to reverse only still-`held` rows and log "manual clawback required" for released
 * ones — so almost every return refund recovered nothing, since earnings release 3 days after
 * delivery and returns run 14. It now means "take back everything still unclawed"
 * (`reverseRemaining`): held shares from pending, released ones from their reserve slice, then
 * available, then as debt. That is the dispute-lost semantics the plan asks for.
 *
 * Two deliberate differences from the old behaviour, both owner decisions:
 *  - agency and agent shares (the delivery fee) are NEVER reversed (C-1) — the run happened. A
 *    delivery AT FAULT is a refund request's business (`applyRefund`), never a dispute's;
 *  - the agency's COD handling fee is never reversed (C-3).
 *
 * Idempotent on `refundKey`. A caller that passes none gets a key derived from the source, so a
 * re-fired refund of the same order still recovers nothing the second time.
 */
/**
 * A lost card dispute (owner F-9, 2026-10-22): `vendorCharge` is the pay-in fee the vendor carries
 * on top of their share (`payments/domain/refund-fees.ts` `disputeVendorCharge`); `dispute` makes
 * the explanations say "dispute" rather than "refund".
 */
export interface DisputeRecoveryOptions {
  vendorCharge?: number;
  dispute?: boolean;
}

export class EarningsRefundService {
  constructor(private readonly clawback: EarningsClawbackService = earningsClawbackService) {}

  /** Every share of a refunded order (order rows + its goods COD collections). */
  async onOrderRefund(
    orderId: string,
    refundKey: string = `order-refund:${orderId}`,
    options: DisputeRecoveryOptions = {}
  ): Promise<ClawbackOutcome> {
    return this.clawback.reverseRemaining({ kind: 'order', id: orderId }, refundKey, options);
  }

  /**
   * A refunded booking (its own rows AND its balance-payment rows), or an order. Other source
   * types are not refund targets on their own — an order's COD collections and shipments are
   * reached through the order.
   */
  async onRefund(
    sourceType: EarningsSourceType,
    sourceId: string,
    refundKey: string = `${sourceType}-refund:${sourceId}`,
    options: DisputeRecoveryOptions = {}
  ): Promise<ClawbackOutcome | null> {
    if (sourceType === 'booking') return this.clawback.reverseRemaining({ kind: 'booking', id: sourceId }, refundKey, options);
    if (sourceType === 'order') return this.onOrderRefund(sourceId, refundKey, options);
    console.warn(`[EarningsRefundService] ${sourceType} ${sourceId} is not a refund target on its own; nothing reversed`);
    return null;
  }
}

export const earningsRefundService = new EarningsRefundService();
