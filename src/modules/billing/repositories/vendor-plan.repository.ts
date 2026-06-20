import { Types, ClientSession } from 'mongoose';
import { VendorPlanModel, IVendorPlan, VendorPlanStatus } from '../models/vendor-plan.model';

/**
 * Persistence for vendor↔plan assignments. Thin wrapper; supports passing a
 * `ClientSession` so plan transitions and the matching credit grant commit
 * atomically.
 */
export class VendorPlanRepository {
  async create(data: Partial<IVendorPlan>, session?: ClientSession): Promise<IVendorPlan> {
    const [doc] = await VendorPlanModel.create([data], session ? { session } : {});
    return doc;
  }

  async findByVendorAndStatus(
    vendorId: string,
    status: VendorPlanStatus,
    session?: ClientSession
  ): Promise<IVendorPlan | null> {
    const query = VendorPlanModel.findOne({ vendor_id: new Types.ObjectId(vendorId), status });
    if (session) query.session(session);
    return query.exec();
  }

  async setStatus(
    id: Types.ObjectId,
    updates: Partial<IVendorPlan>,
    session?: ClientSession
  ): Promise<IVendorPlan | null> {
    return VendorPlanModel.findByIdAndUpdate(id, { $set: updates }, { new: true, session: session ?? null });
  }

  /** Active paid plans whose term has ended (free tier has null expires_at, excluded). */
  async findExpiredActive(now: Date): Promise<IVendorPlan[]> {
    return VendorPlanModel.find({
      status: 'active',
      expires_at: { $ne: null, $lte: now },
    });
  }

  /** Active plans expiring on/before `threshold` (used for pre-expiry notifications). */
  async findActiveExpiringBefore(threshold: Date): Promise<IVendorPlan[]> {
    return VendorPlanModel.find({
      status: 'active',
      expires_at: { $ne: null, $lte: threshold, $gt: new Date() },
    });
  }
}
