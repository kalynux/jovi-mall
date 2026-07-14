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
   * COD: the collection moment IS the verified delivery, so allocations are
   * created already completed with their hold window running.
   */
  completed_at?: Date;
  hold_release_at?: Date;
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
  async existsForSource(sourceType: EarningsSourceType, sourceId: string): Promise<boolean> {
    const count = await EarningsAllocationModel.countDocuments({
      source_type: sourceType,
      source_id: new Types.ObjectId(sourceId),
    }).limit(1);
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
      $or: [{ requires_cash_settlement: false }, { cash_settled_at: { $ne: null } }],
    }).limit(limit);
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
      { _id: allocationId, status: 'held' },
      { $set: { status: 'released', released_at: releasedAt } },
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
