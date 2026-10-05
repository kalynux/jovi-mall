import { Types } from 'mongoose';
import { CashCollectionModel } from '../models/cash-collection.model';
import { CodCollectionCoverage, coverageOf, CoverageSourceRow } from '../domain/cod-coverage';

/**
 * CodCoverageService — how much of an order's COD cash has reached the PLATFORM
 * (REFUND-FLOW-PLAN § 11.2 / § 11.4, owner rule R-6).
 *
 * This is the read the refund side's `CodCoveragePort` is wired to: a COD refund waits in
 * `waiting_for_cash` until every collection it needs reports `settledAt` (R-5: full coverage
 * only — a half-covered collection is not covered). It is a projection of
 * `cash_collections.settled_amount` / `settled_at`, which only `CodSettlementService`'s FIFO
 * writes, so it can never claim cash the platform does not hold: a collection the agent took
 * from the customer is `status: 'collected'` with `settledAt: null` until a confirmed
 * remittance or platform-recipient deposit reaches it.
 *
 * Every collection of the order is returned, `pending` and `cancelled` included, so the
 * caller decides what a returned shipment means for its refund rather than this read
 * silently dropping it. An unknown or malformed id is an empty list, never an error.
 */
export class CodCoverageService {
  async coverageForOrder(orderId: string): Promise<CodCollectionCoverage[]> {
    if (!Types.ObjectId.isValid(orderId)) return [];

    const rows = await CashCollectionModel.find(
      { order_id: new Types.ObjectId(orderId) },
      { shipment_id: 1, kind: 1, expected_amount: 1, settled_amount: 1, settled_at: 1, status: 1 }
    )
      .sort({ _id: 1 })
      .lean<CoverageSourceRow[]>()
      .exec();

    return rows.map(coverageOf);
  }
}

export const codCoverageService = new CodCoverageService();
