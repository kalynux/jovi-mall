import { Types, ClientSession } from 'mongoose';
import {
  EarningsLedgerModel,
  IEarningsLedger,
  EarningsLedgerEntryType,
  EarningsLedgerReasonCode,
  EarningsLedgerSourceType,
} from '../models/earnings-ledger.model';
import { EarningsOwnerType, isPlatformOwnerType } from '../models/earnings-account.model';

export interface CreateLedgerInput {
  account_id: Types.ObjectId;
  owner_type: EarningsOwnerType;
  owner_id: Types.ObjectId | null;
  entry_type: EarningsLedgerEntryType;
  amount: number;
  pending_after: number;
  available_after: number;
  /** A billing source (`plan_purchase` | `credit_topup`) only on a referral reward (2026-11-08). */
  source_type: EarningsLedgerSourceType;
  source_id: string;
  /** Null only with a billing source — see `LEDGER_SOURCES_WITHOUT_ALLOCATION`. */
  allocation_id: Types.ObjectId | null;
  reason_code: EarningsLedgerReasonCode;
}

/** Append-only persistence for the earnings ledger. */
export class EarningsLedgerRepository {
  async create(input: CreateLedgerInput, session?: ClientSession): Promise<IEarningsLedger> {
    const [doc] = await EarningsLedgerModel.create(
      [
        {
          account_id: input.account_id,
          owner_type: input.owner_type,
          owner_id: input.owner_id,
          entry_type: input.entry_type,
          amount: input.amount,
          pending_after: input.pending_after,
          available_after: input.available_after,
          source_type: input.source_type,
          source_id: new Types.ObjectId(input.source_id),
          allocation_id: input.allocation_id,
          reason_code: input.reason_code,
        },
      ],
      { session: session ?? undefined }
    );
    return doc;
  }

  async listByOwner(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    page = 1,
    limit = 20
  ): Promise<{ items: IEarningsLedger[]; total: number; page: number; limit: number }> {
    const filter = {
      owner_type: ownerType,
      owner_id: isPlatformOwnerType(ownerType) ? null : new Types.ObjectId(ownerId!),
    };
    const [items, total] = await Promise.all([
      EarningsLedgerModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      EarningsLedgerModel.countDocuments(filter),
    ]);
    return { items, total, page, limit };
  }
}
