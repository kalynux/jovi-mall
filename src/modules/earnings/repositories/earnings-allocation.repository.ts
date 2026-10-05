import { Types, ClientSession } from 'mongoose';
import {
  EarningsAllocationModel,
  IEarningsAllocation,
  EarningsSourceType,
} from '../models/earnings-allocation.model';
import { EarningsOwnerType } from '../models/earnings-account.model';

export interface CreateAllocationInput {
  source_type: EarningsSourceType;
  source_id: string;
  beneficiary_type: EarningsOwnerType;
  beneficiary_id: string | null;
  gross_snapshot: number;
  commission_percent_snapshot: number;
  amount: number;
  currency: string;
  /** COD: release additionally gated on the covering cash being remitted. */
  requires_cash_settlement?: boolean;
  /**
   * Normally omitted — an allocation matures when its ORDER completes, and
   * OrderCompletionService stamps it then. Pass these only when splitting a
   * source whose order has ALREADY completed (the COD collect path completes
   * before it splits, and the recovery sweep re-splits long afterwards);
   * otherwise the row would sit held forever, since `findMaturedHeld` skips a
   * null `hold_release_at`.
   */
  completed_at?: Date;
  hold_release_at?: Date;
}

/** One source an allocation hangs off. An order's money spans `order`, `shipment` and `cod_collection`. */
export interface SourceRef {
  sourceType: EarningsSourceType;
  sourceId: string;
}

function sourceFilters(sources: SourceRef[]): Array<Record<string, unknown>> {
  return sources.map((s) => ({ source_type: s.sourceType, source_id: new Types.ObjectId(s.sourceId) }));
}

/**
 * Persistence for earnings allocations (the per-beneficiary split rows that are
 * the source of truth for escrow).
 */
export class EarningsAllocationRepository {
  async create(input: CreateAllocationInput, session?: ClientSession): Promise<IEarningsAllocation> {
    const [doc] = await EarningsAllocationModel.create(
      [
        {
          source_type: input.source_type,
          source_id: new Types.ObjectId(input.source_id),
          beneficiary_type: input.beneficiary_type,
          beneficiary_id: input.beneficiary_id ? new Types.ObjectId(input.beneficiary_id) : null,
          gross_snapshot: input.gross_snapshot,
          commission_percent_snapshot: input.commission_percent_snapshot,
          amount: input.amount,
          currency: input.currency,
          status: 'held',
          requires_cash_settlement: input.requires_cash_settlement ?? false,
          completed_at: input.completed_at ?? null,
          hold_release_at: input.hold_release_at ?? null,
        },
      ],
      { session: session ?? undefined }
    );
    return doc;
  }

  /** All allocations for a given source order/booking. */
  async findBySource(
    sourceType: EarningsSourceType,
    sourceId: string,
    session?: ClientSession
  ): Promise<IEarningsAllocation[]> {
    return EarningsAllocationModel.find(
      { source_type: sourceType, source_id: new Types.ObjectId(sourceId) },
      null,
      { session: session ?? undefined }
    );
  }

  /** True when this source has already been split (idempotency guard). */
  async existsForSource(sourceType: EarningsSourceType, sourceId: string, session?: ClientSession): Promise<boolean> {
    const query = EarningsAllocationModel.countDocuments({
      source_type: sourceType,
      source_id: new Types.ObjectId(sourceId),
    }).limit(1);
    // Optional: read as a caller's transaction sees it (the change of agency's decrease, D-12).
    if (session) query.session(session);
    const count = await query;
    return count > 0;
  }

  /**
   * Stamp completion on every still-`held` allocation for a source. Idempotent:
   * only rows without a completion date are touched. Returns the modified count.
   */
  async markCompletedBySource(
    sourceType: EarningsSourceType,
    sourceId: string,
    completedAt: Date,
    holdReleaseAt: Date,
    session?: ClientSession
  ): Promise<number> {
    const res = await EarningsAllocationModel.updateMany(
      {
        source_type: sourceType,
        source_id: new Types.ObjectId(sourceId),
        status: 'held',
        completed_at: null,
      },
      { $set: { completed_at: completedAt, hold_release_at: holdReleaseAt } },
      { session: session ?? undefined }
    );
    return res.modifiedCount ?? 0;
  }

  /**
   * Held allocations whose hold window has elapsed (release-worker sweep).
   * COD-sourced allocations additionally require their covering cash to have
   * been settled up the remittance chain — the platform never releases money
   * it hasn't physically received.
   */
  async findMaturedHeld(now: Date, limit: number): Promise<IEarningsAllocation[]> {
    return EarningsAllocationModel.find({
      status: 'held',
      hold_release_at: { $ne: null, $lte: now },
      // Paused money never matures. In the QUERY, not only in the worker: a batch-limited
      // sweep that fetched paused rows and skipped them would re-fetch the same rows every
      // night and could crowd out money that is genuinely due.
      paused_at: null,
      $or: [{ requires_cash_settlement: false }, { cash_settled_at: { $ne: null } }],
    }).limit(limit);
  }

  /** Still-`held` rows of any of these sources (one order spans several source types). */
  async findHeldBySources(sources: SourceRef[]): Promise<IEarningsAllocation[]> {
    if (sources.length === 0) return [];
    return EarningsAllocationModel.find({ status: 'held', $or: sourceFilters(sources) });
  }

  /** Copy a pause onto every still-`held` row of these sources. Returns the count touched. */
  async markPausedBySources(sources: SourceRef[], pausedAt: Date): Promise<number> {
    if (sources.length === 0) return 0;
    const res = await EarningsAllocationModel.updateMany(
      { status: 'held', paused_at: null, $or: sourceFilters(sources) },
      { $set: { paused_at: pausedAt } }
    );
    return res.modifiedCount ?? 0;
  }

  /** Stamp the pause on one row the worker found unmarked under a paused source. */
  async markPaused(allocationId: Types.ObjectId, pausedAt: Date): Promise<void> {
    await EarningsAllocationModel.updateOne(
      { _id: allocationId, status: 'held', paused_at: null },
      { $set: { paused_at: pausedAt } }
    );
  }

  /**
   * Lift the pause on one held row and move its release date (computed by the caller with
   * `resumedHoldReleaseAt`). Compare-and-set on `status: 'held'`: a row released or reversed
   * meanwhile is left exactly as it is.
   */
  async markResumed(allocationId: Types.ObjectId, holdReleaseAt: Date | null): Promise<void> {
    await EarningsAllocationModel.updateOne(
      { _id: allocationId, status: 'held' },
      { $set: { paused_at: null, hold_release_at: holdReleaseAt } }
    );
  }

  /**
   * Start the hold on every still-`held`, not-yet-started row of these sources — the
   * multi-source sibling of `markCompletedBySource`, with the same idempotence rule.
   */
  async markCompletedBySources(
    sources: SourceRef[],
    completedAt: Date,
    holdReleaseAt: Date
  ): Promise<number> {
    if (sources.length === 0) return 0;
    const res = await EarningsAllocationModel.updateMany(
      { status: 'held', completed_at: null, $or: sourceFilters(sources) },
      { $set: { completed_at: completedAt, hold_release_at: holdReleaseAt } }
    );
    return res.modifiedCount ?? 0;
  }

  /**
   * Un-start the hold on still-`held` rows: a parcel the courier delivered went back to
   * `failed`, so the order is not delivered after all. Released money is never touched.
   */
  async clearHoldBySources(sources: SourceRef[]): Promise<number> {
    if (sources.length === 0) return 0;
    const res = await EarningsAllocationModel.updateMany(
      { status: 'held', completed_at: { $ne: null }, $or: sourceFilters(sources) },
      { $set: { completed_at: null, hold_release_at: null } }
    );
    return res.modifiedCount ?? 0;
  }

  /**
   * Stamp `cash_settled_at` on a source's allocations (remittance FIFO fully
   * covered its collection). Idempotent: already-stamped rows are untouched.
   */
  async markCashSettledBySource(
    sourceType: EarningsSourceType,
    sourceId: string,
    settledAt: Date,
    session?: ClientSession
  ): Promise<number> {
    const res = await EarningsAllocationModel.updateMany(
      {
        source_type: sourceType,
        source_id: new Types.ObjectId(sourceId),
        requires_cash_settlement: true,
        cash_settled_at: null,
      },
      { $set: { cash_settled_at: settledAt } },
      { session: session ?? undefined }
    );
    return res.modifiedCount ?? 0;
  }

  /** Still-`held` allocations for a source (used when reversing a refund). */
  async findHeldBySource(
    sourceType: EarningsSourceType,
    sourceId: string,
    session?: ClientSession
  ): Promise<IEarningsAllocation[]> {
    return EarningsAllocationModel.find(
      { source_type: sourceType, source_id: new Types.ObjectId(sourceId), status: 'held' },
      null,
      { session: session ?? undefined }
    );
  }

  /**
   * Atomically flip an allocation `held` → `released`. Returns the updated doc,
   * or `null` if it was already transitioned (idempotent / concurrency-safe).
   */
  async markReleased(
    allocationId: Types.ObjectId,
    releasedAt: Date,
    session?: ClientSession
  ): Promise<IEarningsAllocation | null> {
    return EarningsAllocationModel.findOneAndUpdate(
      // `paused_at: null` in the claim too: a pause landing between the sweep's query and
      // this write must win, or a paused order could be paid out by a sweep already running.
      { _id: allocationId, status: 'held', paused_at: null },
      { $set: { status: 'released', released_at: releasedAt } },
      { new: true, session: session ?? null }
    );
  }

  /** One beneficiary's row for a source, or null. Session-aware for in-transaction reads. */
  async findOneBySourceAndBeneficiary(
    sourceType: EarningsSourceType,
    sourceId: string,
    beneficiaryType: EarningsOwnerType,
    beneficiaryId: string | null,
    session?: ClientSession
  ): Promise<IEarningsAllocation | null> {
    return EarningsAllocationModel.findOne(
      {
        source_type: sourceType,
        source_id: new Types.ObjectId(sourceId),
        beneficiary_type: beneficiaryType,
        beneficiary_id: beneficiaryId ? new Types.ObjectId(beneficiaryId) : null,
      },
      null,
      { session: session ?? undefined }
    );
  }

  /**
   * Re-price a still-`held` allocation in place — the approved delivery-fee change
   * (modules/delivery-fee-proposals) moves the vendor's payment-time net by the fee delta.
   *
   * A compare-and-set on BOTH `status: 'held'` and the amount the caller read: a released
   * row is money already withdrawable and must never be re-priced silently, and a
   * concurrent adjustment must not be overwritten. `null` on a miss; the caller aborts its
   * transaction. The caller owns the matching account movement + ledger row
   * (`EarningsAccountService.adjustHeldInSession`).
   */
  async adjustHeldAmount(
    allocationId: Types.ObjectId,
    expectedAmount: number,
    newAmount: number,
    session?: ClientSession
  ): Promise<IEarningsAllocation | null> {
    return EarningsAllocationModel.findOneAndUpdate(
      { _id: allocationId, status: 'held', amount: expectedAmount },
      { $set: { amount: newAmount } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Atomically flip an allocation `held` → `reversed`. Returns the updated doc,
   * or `null` if it was already transitioned.
   */
  async markReversed(
    allocationId: Types.ObjectId,
    reversedAt: Date,
    session?: ClientSession
  ): Promise<IEarningsAllocation | null> {
    return EarningsAllocationModel.findOneAndUpdate(
      { _id: allocationId, status: 'held' },
      { $set: { status: 'reversed', reversed_at: reversedAt } },
      { new: true, session: session ?? null }
    );
  }
}
