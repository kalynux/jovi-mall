/**
 * The COD coverage contract other modules read (REFUND-FLOW-PLAN § 11.2 / § 11.4). Pure types
 * and one projection — importable by the refund side without pulling in a model.
 *
 * "Covered" means the collection's cash reached the PLATFORM: `settled_amount` has reached
 * `expected_amount` and `settled_at` is stamped. That happens in exactly one place,
 * `CodSettlementService.applyFifoInSession`, run by an admin-confirmed agency remittance or an
 * admin-confirmed `recipient: 'platform'` agent deposit. Collected-from-the-customer is NOT
 * covered (R-6) — a refund of COD cash still in an agent's pocket would be the platform paying
 * out money it does not hold.
 */
import type { CashCollectionKind } from '../../orders/domain/delivery-payer';

/** § 11.2 — the shape `CodCoveragePort.coverageForOrder` returns, one row per collection. */
export interface CodCollectionCoverage {
  collectionId: string;
  shipmentId: string;
  kind: 'order' | 'delivery_fee';
  /** The cash to collect (`expected_amount`). */
  expected: number;
  /** How much of it confirmed deposits have covered so far (`settled_amount`). */
  settled: number;
  /** Set only when `settled >= expected` — the collection is covered. */
  settledAt: Date | null;
  status: 'pending' | 'collected' | 'cancelled';
}

/** § 11.4 — published after commit when at least one collection became fully settled. */
export const COD_COLLECTIONS_SETTLED_EVENT = 'cod.collections.settled' as const;

export interface CodCollectionsSettledPayload {
  /** Every collection this confirmation took to fully settled. Never empty. */
  collectionIds: string[];
  /** Their orders, de-duplicated. */
  orderIds: string[];
  /** ISO-8601 — the `settled_at` stamped on every one of them. */
  settledAt: string;
}

/** The fields of a `cash_collections` row the projection reads. */
export interface CoverageSourceRow {
  _id: { toString(): string };
  shipment_id: { toString(): string };
  kind?: CashCollectionKind | null;
  expected_amount: number;
  settled_amount?: number | null;
  settled_at?: Date | null;
  status: 'pending' | 'collected' | 'cancelled';
}

export function coverageOf(row: CoverageSourceRow): CodCollectionCoverage {
  return {
    collectionId: row._id.toString(),
    shipmentId: row.shipment_id.toString(),
    // A missing field is a pre-W-F row, and those were all COD order cash (`collectionKindOf`).
    kind: row.kind === 'delivery_fee' ? 'delivery_fee' : 'order',
    expected: row.expected_amount,
    settled: row.settled_amount ?? 0,
    settledAt: row.settled_at ?? null,
    status: row.status,
  };
}

/** Covered = the platform holds all of this collection's cash. */
export function isCovered(coverage: Pick<CodCollectionCoverage, 'settledAt'>): boolean {
  return coverage.settledAt !== null;
}
