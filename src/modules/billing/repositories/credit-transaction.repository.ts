import { Types, ClientSession } from 'mongoose';
import { CreditTransactionModel, ICreditTransaction } from '../models/credit-transaction.model';

/** Persistence for the append-only credit ledger. */
export class CreditTransactionRepository {
  async create(data: Partial<ICreditTransaction>, session?: ClientSession): Promise<ICreditTransaction> {
    const [doc] = await CreditTransactionModel.create([data], session ? { session } : {});
    return doc;
  }

  async listByOwner(
    ownerType: string,
    ownerId: string,
    page: number,
    limit: number
  ): Promise<{ data: ICreditTransaction[]; total: number }> {
    const filter = { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) };
    const [data, total] = await Promise.all([
      CreditTransactionModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      CreditTransactionModel.countDocuments(filter),
    ]);
    return { data, total };
  }
}
