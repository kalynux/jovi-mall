import { Types, ClientSession } from 'mongoose';
import { CreditTopupModel, ICreditTopup, CreditTopupStatus } from '../models/credit-topup.model';
import { BillingOwnerType } from '../billing.types';

/** Persistence for credit top-up purchases. */
export class CreditTopupRepository {
  async create(data: Partial<ICreditTopup>): Promise<ICreditTopup> {
    return CreditTopupModel.create(data);
  }

  async findById(id: string, session?: ClientSession): Promise<ICreditTopup | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const query = CreditTopupModel.findById(id);
    if (session) query.session(session);
    return query.exec();
  }

  async setStatus(
    id: Types.ObjectId,
    status: CreditTopupStatus,
    updates: Partial<ICreditTopup> = {},
    session?: ClientSession
  ): Promise<ICreditTopup | null> {
    return CreditTopupModel.findByIdAndUpdate(
      id,
      { $set: { status, ...updates } },
      { new: true, session: session ?? null }
    );
  }

  async listByOwner(
    ownerType: BillingOwnerType,
    ownerId: string,
    page: number,
    limit: number
  ): Promise<{ data: ICreditTopup[]; total: number }> {
    const filter = { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) };
    const [data, total] = await Promise.all([
      CreditTopupModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CreditTopupModel.countDocuments(filter),
    ]);
    return { data, total };
  }
}
