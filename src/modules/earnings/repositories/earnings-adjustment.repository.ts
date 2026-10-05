import { Types, ClientSession } from 'mongoose';
import {
  AdjustmentTakenFrom,
  EarningsAdjustmentKind,
  EarningsAdjustmentModel,
  IEarningsAdjustment,
} from '../models/earnings-adjustment.model';
import { EarningsOwnerType } from '../models/earnings-account.model';
import { EarningsSourceType } from '../models/earnings-allocation.model';

export interface CreateAdjustmentInput {
  refund_key: string;
  allocation_id: Types.ObjectId | null;
  source_type: EarningsSourceType | null;
  source_id: Types.ObjectId | string | null;
  beneficiary_type: EarningsOwnerType;
  beneficiary_id: Types.ObjectId | string | null;
  amount: number;
  currency: string;
  taken_from: AdjustmentTakenFrom;
  kind: EarningsAdjustmentKind;
  goods_amount?: number;
  delivery_amount?: number;
  refund_attribution?: { goods: number; delivery: number } | null;
  actor?: { id: string | null; name: string | null } | null;
  reason?: string | null;
}

function oid(value: Types.ObjectId | string | null): Types.ObjectId | null {
  if (value === null) return null;
  return typeof value === 'string' ? new Types.ObjectId(value) : value;
}

/** Append-only persistence for `earnings_adjustments`. There is no update and no delete. */
export class EarningsAdjustmentRepository {
  /**
   * Insert one row. ⚠ ARRAY form on purpose: Mongoose reads `{ session }` only when the first
   * argument is an array — `create(doc, { session })` would write OUTSIDE the transaction.
   * A duplicate `(refund_key, allocation_id, kind)` throws E11000, which aborts the caller's
   * transaction: that is the idempotency guarantee.
   */
  async create(input: CreateAdjustmentInput, session?: ClientSession): Promise<IEarningsAdjustment> {
    const [doc] = await EarningsAdjustmentModel.create(
      [
        {
          refund_key: input.refund_key,
          allocation_id: input.allocation_id,
          source_type: input.source_type,
          source_id: oid(input.source_id),
          beneficiary_type: input.beneficiary_type,
          beneficiary_id: oid(input.beneficiary_id),
          amount: input.amount,
          currency: input.currency,
          taken_from: input.taken_from,
          kind: input.kind,
          goods_amount: input.goods_amount ?? 0,
          delivery_amount: input.delivery_amount ?? 0,
          refund_attribution: input.refund_attribution ?? null,
          actor: input.actor ?? null,
          reason: input.reason ?? null,
        },
      ],
      { session: session ?? undefined }
    );
    return doc;
  }

  /** True when this refund already wrote its clawback (any row). */
  async existsForRefund(refundKey: string, session?: ClientSession): Promise<boolean> {
    const query = EarningsAdjustmentModel.countDocuments({ refund_key: refundKey, kind: 'refund_clawback' }).limit(1);
    if (session) query.session(session);
    return (await query) > 0;
  }

  /**
   * Every earlier clawback of this scope — rows on these allocations, plus the vendor-beyond
   * rows of these sources (`allocation_id: null`).
   */
  async findPriorClawbacks(
    allocationIds: Types.ObjectId[],
    sources: Array<{ sourceType: EarningsSourceType; sourceId: string }>,
    session?: ClientSession
  ): Promise<IEarningsAdjustment[]> {
    const or: Array<Record<string, unknown>> = [];
    if (allocationIds.length) or.push({ allocation_id: { $in: allocationIds } });
    for (const s of sources) {
      or.push({ allocation_id: null, source_type: s.sourceType, source_id: new Types.ObjectId(s.sourceId) });
    }
    if (or.length === 0) return [];
    return EarningsAdjustmentModel.find({ kind: 'refund_clawback', $or: or }, null, { session: session ?? undefined });
  }

  /** One owner's adjustments, newest first (the admin debt view). */
  async listForOwner(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    limit: number
  ): Promise<IEarningsAdjustment[]> {
    return EarningsAdjustmentModel.find({
      beneficiary_type: ownerType,
      beneficiary_id: ownerId ? new Types.ObjectId(ownerId) : null,
    })
      .sort({ created_at: -1 })
      .limit(limit);
  }
}

export const earningsAdjustmentRepository = new EarningsAdjustmentRepository();
