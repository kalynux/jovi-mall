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

  /** Held allocations whose hold window has elapsed (release-worker sweep). */
  async findMaturedHeld(now: Date, limit: number): Promise<IEarningsAllocation[]> {
    return EarningsAllocationModel.find({
      status: 'held',
      hold_release_at: { $ne: null, $lte: now },
    }).limit(limit);
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
