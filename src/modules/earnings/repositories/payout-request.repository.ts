import { ClientSession, Types } from 'mongoose';
import { PayoutRequestModel, IPayoutRequest, PayoutRequestOrigin } from '../models/payout-request.model';
import { EarningsOwnerType } from '../models/earnings-account.model';
import { IPayoutMethod } from '../../../core/types/payout.types';

export interface CreatePayoutRequestInput {
  owner_type: EarningsOwnerType;
  owner_id: string;
  amount: number;
  currency: string;
  origin: PayoutRequestOrigin;
  payout_method_snapshot: IPayoutMethod;
  requested_by_user_id: string;
}

export interface ListPayoutRequestsFilters {
  status?: string;
  ownerType?: string;
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

/** Persistence for PayoutRequest documents. See the model for domain rules. */
export class PayoutRequestRepository {
  async create(input: CreatePayoutRequestInput, session?: ClientSession): Promise<IPayoutRequest> {
    const [doc] = await PayoutRequestModel.create(
      [
        {
          owner_type: input.owner_type,
          owner_id: new Types.ObjectId(input.owner_id),
          amount: input.amount,
          currency: input.currency,
          status: 'pending',
          origin: input.origin,
          payout_method_snapshot: input.payout_method_snapshot,
          ticket_id: null,
          requested_by_user_id: new Types.ObjectId(input.requested_by_user_id),
          resolved_at: null,
          resolved_by: null,
          paid_reference: null,
          rejection_reason: null,
        },
      ],
      { session: session ?? null }
    );
    return doc;
  }

  async findPendingForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOne({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      status: 'pending',
    });
  }

  async findLatestForOwner(ownerType: EarningsOwnerType, ownerId: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOne({ owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) }).sort({
      created_at: -1,
    });
  }

  async findById(id: string): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findById(id);
  }

  async setTicketId(id: string, ticketId: string): Promise<void> {
    await PayoutRequestModel.updateOne({ _id: id }, { $set: { ticket_id: new Types.ObjectId(ticketId) } });
  }

  /** Guarded on `status: 'pending'` — returns null if already resolved (race lost). */
  async markPaid(
    id: string,
    adminUserId: string,
    reference: string | null,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: 'paid',
          resolved_at: new Date(),
          resolved_by: new Types.ObjectId(adminUserId),
          paid_reference: reference,
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /** Guarded on `status: 'pending'` — returns null if already resolved (race lost). */
  async markRejected(
    id: string,
    adminUserId: string,
    reason: string,
    session?: ClientSession
  ): Promise<IPayoutRequest | null> {
    return PayoutRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      {
        $set: {
          status: 'rejected',
          resolved_at: new Date(),
          resolved_by: new Types.ObjectId(adminUserId),
          rejection_reason: reason,
        },
      },
      { new: true, session: session ?? null }
    );
  }

  /** Only used to compensate a request whose ticket failed to create. */
  async hardDeleteById(id: string): Promise<void> {
    await PayoutRequestModel.deleteOne({ _id: id });
  }

  async listForAdmin(
    filters: ListPayoutRequestsFilters,
    pagination: PaginationOptions
  ): Promise<{ data: IPayoutRequest[]; total: number }> {
    const query: Record<string, unknown> = {};
    if (filters.status) query.status = filters.status;
    if (filters.ownerType) query.owner_type = filters.ownerType;

    const skip = (pagination.page - 1) * pagination.limit;
    const [data, total] = await Promise.all([
      PayoutRequestModel.find(query).sort({ created_at: -1 }).skip(skip).limit(pagination.limit),
      PayoutRequestModel.countDocuments(query),
    ]);
    return { data, total };
  }
}
