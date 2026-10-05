import { ClientSession } from 'mongoose';
import { eventBus } from '../../../core/events/event-bus';
import { CashCollectionModel } from '../models/cash-collection.model';
import { EarningsAllocationRepository } from '../../earnings/repositories/earnings-allocation.repository';
import { FIFO_SORT, planFifoSettlement } from '../domain/cod-fifo';
import { COD_COLLECTIONS_SETTLED_EVENT, CodCollectionsSettledPayload } from '../domain/cod-coverage';

/** What one confirmed deposit did to the coverage queue. */
export interface FifoSettlementResult {
  /** How much of the deposit was put against collections. */
  applied: number;
  /** Collections this deposit took to FULLY settled (covered). */
  settledCollectionIds: string[];
  /** Their orders, de-duplicated, in the order first met. */
  settledOrderIds: string[];
  /** The `settled_at` stamped on every one of them. */
  settledAt: Date;
}

/**
 * CodSettlementService - applies cash that reached the PLATFORM to an agency's collected
 * CashCollections, OLDEST DELIVERY FIRST (FIFO; REFUND-FLOW-PLAN R-6).
 *
 * Two callers, and only two — the two ways cash reaches the platform:
 *  - `AgencyRemittanceService.confirm` (an admin confirms the agency's remittance);
 *  - `AgentDepositService` for a `recipient: 'platform'` deposit (confirm or admin record).
 * An agent → agency deposit never reaches here: that cash is still with the agency.
 *
 * Each collection tracks `settled_amount`; when it reaches `expected_amount`
 * the collection is stamped `settled_at` and every `cod_collection` earnings
 * allocation it backs gets `cash_settled_at` — which is what unlocks their
 * escrow release (the platform has physically received the covering cash).
 *
 * The ORDER and the arithmetic live in `cod/domain/cod-fifo.ts` (pure, tested without a
 * database by `test:cod-settlement`); this class is the reads and writes around them. A
 * partial deposit settles the oldest deliveries first and leaves at most ONE partially-covered
 * collection carrying the remainder forward.
 */
export class CodSettlementService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
  ) {}

  /**
   * Apply `amount` to the agency's unsettled collections. Runs inside the
   * confirming transaction. Returns how much was applied and which collections
   * (and orders) became fully settled — the caller publishes
   * `cod.collections.settled` from that AFTER its commit (`publishCollectionsSettled`).
   */
  async applyFifoInSession(
    agencyId: string,
    amount: number,
    session: ClientSession
  ): Promise<FifoSettlementResult> {
    const now = new Date();

    // The amount is validated (≤ agency liability) before confirmation, so the plan can
    // cover at most the outstanding total.
    const openCollections = await CashCollectionModel.find({
      agency_id: agencyId,
      status: 'collected',
      $expr: { $lt: ['$settled_amount', '$expected_amount'] },
    })
      .sort(FIFO_SORT)
      .session(session);

    const plan = planFifoSettlement(
      openCollections.map((c) => ({
        id: c._id.toString(),
        deliveredAt: c.delivered_at ?? null,
        expectedAmount: c.expected_amount,
        settledAmount: c.settled_amount,
      })),
      amount
    );

    const byId = new Map(openCollections.map((c) => [c._id.toString(), c]));
    const settledCollectionIds: string[] = [];
    const settledOrderIds: string[] = [];

    for (const step of plan.steps) {
      const collection = byId.get(step.id)!;
      collection.settled_amount = step.settledAmount;
      if (step.fullySettled) collection.settled_at = now;
      await collection.save({ session });

      if (step.fullySettled) {
        settledCollectionIds.push(step.id);
        const orderId = collection.order_id.toString();
        if (!settledOrderIds.includes(orderId)) settledOrderIds.push(orderId);

        // Unlock the escrow release of every allocation this cash backs.
        await this.allocationRepo.markCashSettledBySource(
          'cod_collection',
          step.id,
          now,
          session
        );
      }
    }

    return { applied: plan.applied, settledCollectionIds, settledOrderIds, settledAt: now };
  }

  /**
   * Publish `cod.collections.settled` (§ 11.4) — call it AFTER the confirming transaction
   * commits, never inside it. A no-op when nothing became fully settled: a deposit that only
   * advanced a half-covered collection covers no shipment, and an event saying otherwise
   * would send a COD refund for cash the platform does not fully hold (R-5).
   *
   * Fire-and-forget, the bus's documented convention: the confirming request does not wait
   * on a subscriber (a refund claim is a gateway call), and a lost event is caught by the
   * refund side's nightly re-check, which reads `settled_at` directly.
   */
  publishCollectionsSettled(
    result: Pick<FifoSettlementResult, 'settledCollectionIds' | 'settledOrderIds' | 'settledAt'> | null,
    aggregateId: string
  ): void {
    if (!result || result.settledCollectionIds.length === 0) return;

    const payload: CodCollectionsSettledPayload = {
      collectionIds: [...result.settledCollectionIds],
      orderIds: [...result.settledOrderIds],
      settledAt: result.settledAt.toISOString(),
    };
    void eventBus
      .publish(COD_COLLECTIONS_SETTLED_EVENT, {
        eventType: COD_COLLECTIONS_SETTLED_EVENT,
        aggregateId,
        occurredAt: new Date(),
        payload: { ...payload },
      })
      .catch((error) =>
        console.error(`[CodSettlementService] Failed to emit ${COD_COLLECTIONS_SETTLED_EVENT}:`, error)
      );
  }
}

export const codSettlementService = new CodSettlementService();
