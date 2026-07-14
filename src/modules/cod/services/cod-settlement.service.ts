import { ClientSession } from 'mongoose';
import { CashCollectionModel } from '../models/cash-collection.model';
import { EarningsAllocationRepository } from '../../earnings/repositories/earnings-allocation.repository';

/**
 * CodSettlementService - applies a confirmed agency remittance to that
 * agency's collected CashCollections, OLDEST FIRST (FIFO).
 *
 * Each collection tracks `settled_amount`; when it reaches `expected_amount`
 * the collection is stamped `settled_at` and every `cod_collection` earnings
 * allocation it backs gets `cash_settled_at` — which is what unlocks their
 * escrow release (the platform has physically received the covering cash).
 *
 * FIFO is deterministic and auditable: a partial remittance settles the
 * oldest handoffs first and leaves at most ONE partially-covered collection
 * carrying the remainder forward.
 */
export class CodSettlementService {
  constructor(
    private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
  ) {}

  /**
   * Apply `amount` to the agency's unsettled collections. Runs inside the
   * remittance-confirmation transaction. Returns how much was applied and
   * which collections became fully settled.
   */
  async applyFifoInSession(
    agencyId: string,
    amount: number,
    session: ClientSession
  ): Promise<{ applied: number; settledCollectionIds: string[] }> {
    let remaining = amount;
    const settledCollectionIds: string[] = [];
    const now = new Date();

    // Oldest collected-first. The remittance amount is validated (≤ agency
    // liability) before confirmation, so `remaining` can cover at most the
    // outstanding total.
    const openCollections = await CashCollectionModel.find({
      agency_id: agencyId,
      status: 'collected',
      $expr: { $lt: ['$settled_amount', '$expected_amount'] },
    })
      .sort({ collected_at: 1 })
      .session(session);

    for (const collection of openCollections) {
      if (remaining <= 0) break;

      const outstanding = collection.expected_amount - collection.settled_amount;
      const applied = Math.min(outstanding, remaining);

      collection.settled_amount += applied;
      remaining -= applied;

      const fullySettled = collection.settled_amount >= collection.expected_amount;
      if (fullySettled) {
        collection.settled_at = now;
        settledCollectionIds.push(collection._id.toString());
      }
      await collection.save({ session });

      if (fullySettled) {
        // Unlock the escrow release of every allocation this cash backs.
        await this.allocationRepo.markCashSettledBySource(
          'cod_collection',
          collection._id.toString(),
          now,
          session
        );
      }
    }

    return { applied: amount - remaining, settledCollectionIds };
  }
}

export const codSettlementService = new CodSettlementService();
