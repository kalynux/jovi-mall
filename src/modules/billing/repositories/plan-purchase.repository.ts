import { Types } from 'mongoose';
import { PlanPurchaseModel, IPlanPurchase, PlanPurchaseStatus } from '../models/plan-purchase.model';
import { BillingOwnerType } from '../billing.types';

/** Persistence for owner self-serve plan purchases. */
export class PlanPurchaseRepository {
  async create(data: Partial<IPlanPurchase>): Promise<IPlanPurchase> {
    return PlanPurchaseModel.create(data);
  }

  async findById(id: string): Promise<IPlanPurchase | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return PlanPurchaseModel.findById(id);
  }

  /** Locate a purchase by its gateway PaymentIntent reference (for dispute/refund routing). */
  async findByGatewayRef(gatewayRef: string): Promise<IPlanPurchase | null> {
    return PlanPurchaseModel.findOne({ gateway_ref: gatewayRef });
  }

  /** Locate a purchase by the reference WE minted and the gateway echoed back. */
  async findByMerchantRef(merchantRef: string): Promise<IPlanPurchase | null> {
    return PlanPurchaseModel.findOne({ merchant_ref: merchantRef });
  }

  /**
   * Mark a still-pending purchase failed, as a compare-and-set.
   *
   * Guarded on `pending` so a late terminal callback cannot un-settle a
   * purchase that a verify poll already applied — the plan is granted and the
   * row must not contradict it.
   */
  async failIfPending(id: string): Promise<void> {
    if (!Types.ObjectId.isValid(id)) return;
    await PlanPurchaseModel.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'failed' } });
  }

  async setStatus(
    id: Types.ObjectId,
    status: PlanPurchaseStatus,
    updates: Partial<IPlanPurchase> = {}
  ): Promise<IPlanPurchase | null> {
    return PlanPurchaseModel.findByIdAndUpdate(id, { $set: { status, ...updates } }, { new: true });
  }

  /**
   * Atomically claim a pending purchase by flipping it to a target status only if
   * it is still `pending`. Returns the updated doc, or null if it wasn't pending
   * (already paid/failed or claimed by a concurrent request) — guards against
   * double-applying the plan.
   */
  async claimIfPending(id: Types.ObjectId, toStatus: PlanPurchaseStatus): Promise<IPlanPurchase | null> {
    return PlanPurchaseModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: toStatus } },
      { new: true }
    );
  }

  async listByOwner(
    ownerType: BillingOwnerType,
    ownerId: string,
    page: number,
    limit: number
  ): Promise<{ data: IPlanPurchase[]; total: number }> {
    const filter = { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) };
    const [data, total] = await Promise.all([
      PlanPurchaseModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      PlanPurchaseModel.countDocuments(filter),
    ]);
    return { data, total };
  }
}
