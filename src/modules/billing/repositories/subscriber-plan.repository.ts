import { Types, ClientSession } from 'mongoose';
import { SubscriberPlanModel, ISubscriberPlan, SubscriberPlanStatus } from '../models/subscriber-plan.model';
import { BillingOwnerType } from '../billing.types';

/**
 * Persistence for owner↔plan assignments. Thin wrapper; supports passing a
 * `ClientSession` so plan transitions and the matching credit grant commit
 * atomically.
 */
export class SubscriberPlanRepository {
  async create(data: Partial<ISubscriberPlan>, session?: ClientSession): Promise<ISubscriberPlan> {
    const [doc] = await SubscriberPlanModel.create([data], session ? { session } : {});
    return doc;
  }

  async findById(id: string | Types.ObjectId, session?: ClientSession): Promise<ISubscriberPlan | null> {
    const query = SubscriberPlanModel.findById(id);
    if (session) query.session(session);
    return query.exec();
  }

  async findByOwnerAndStatus(
    ownerType: BillingOwnerType,
    ownerId: string,
    status: SubscriberPlanStatus,
    session?: ClientSession
  ): Promise<ISubscriberPlan | null> {
    const query = SubscriberPlanModel.findOne({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      status,
    });
    if (session) query.session(session);
    return query.exec();
  }

  async setStatus(
    id: Types.ObjectId,
    updates: Partial<ISubscriberPlan>,
    session?: ClientSession
  ): Promise<ISubscriberPlan | null> {
    return SubscriberPlanModel.findByIdAndUpdate(id, { $set: updates }, { new: true, session: session ?? null });
  }

  /** Active paid plans whose term has ended (free tier has null expires_at, excluded). */
  async findExpiredActive(now: Date): Promise<ISubscriberPlan[]> {
    return SubscriberPlanModel.find({
      status: 'active',
      expires_at: { $ne: null, $lte: now },
    });
  }

  /** Active plans expiring on/before `threshold` (used for pre-expiry notifications). */
  async findActiveExpiringBefore(threshold: Date): Promise<ISubscriberPlan[]> {
    return SubscriberPlanModel.find({
      status: 'active',
      expires_at: { $ne: null, $lte: threshold, $gt: new Date() },
    });
  }

  /** All active plans for a given owner type (used by the agency soft-cap sweep). */
  async findAllActiveByOwnerType(ownerType: BillingOwnerType): Promise<ISubscriberPlan[]> {
    return SubscriberPlanModel.find({ owner_type: ownerType, status: 'active' });
  }
}
