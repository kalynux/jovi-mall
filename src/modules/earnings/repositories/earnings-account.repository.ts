import { Types, ClientSession } from 'mongoose';
import {
  EarningsAccountModel,
  IEarningsAccount,
  EarningsOwnerType,
} from '../models/earnings-account.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { EARNINGS_CONFIG } from '../config/earnings.config';

/**
 * Persistence for earnings (money) accounts. Balance mutations are atomic,
 * guarded `$inc` updates so concurrent releases/reversals cannot drive a balance
 * negative; `version` is bumped on every change for optimistic-lock semantics.
 *
 * The platform account is a singleton keyed by `owner_type:'platform'` with a
 * `null` owner_id.
 */
export class EarningsAccountRepository {
  private toOwnerId(ownerType: EarningsOwnerType, ownerId: string | null): Types.ObjectId | null {
    if (ownerType === 'platform') return null;
    if (!ownerId) {
      throw createAppError(
        ERROR_CODES.INTERNAL_SERVER_ERROR,
        500,
        'owner_id is required for non-platform earnings accounts'
      );
    }
    return new Types.ObjectId(ownerId);
  }

  /** Fetch the beneficiary's account, creating an empty one if absent. */
  async getOrCreate(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    session?: ClientSession
  ): Promise<IEarningsAccount> {
    const oid = this.toOwnerId(ownerType, ownerId);
    const account = await EarningsAccountModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: oid },
      {
        $setOnInsert: {
          owner_type: ownerType,
          owner_id: oid,
          currency: EARNINGS_CONFIG.DEFAULT_CURRENCY,
          pending_balance: 0,
          available_balance: 0,
          version: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, session: session ?? null }
    );
    return account!;
  }

  /** Move `amount` into pending (escrow hold). Always succeeds. */
  async hold(accountId: Types.ObjectId, amount: number, session?: ClientSession): Promise<IEarningsAccount> {
    const updated = await EarningsAccountModel.findByIdAndUpdate(
      accountId,
      { $inc: { pending_balance: amount, version: 1 } },
      { new: true, session: session ?? null }
    );
    return updated!;
  }

  /**
   * Atomically move `amount` from pending → available, only if pending can
   * cover it. Returns the updated account, or `null` when pending is too low.
   */
  async release(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, pending_balance: { $gte: amount } },
      { $inc: { pending_balance: -amount, available_balance: amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Atomically remove `amount` from pending (refund before release). Returns the
   * updated account, or `null` when pending is too low.
   */
  async reverseFromPending(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, pending_balance: { $gte: amount } },
      { $inc: { pending_balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Atomically remove `amount` from available (refund clawback after release).
   * Returns the updated account, or `null` when available is too low.
   */
  async reverseFromAvailable(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, available_balance: { $gte: amount } },
      { $inc: { available_balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /** Read-only balance lookup (does not create the account). */
  async find(
    ownerType: EarningsOwnerType,
    ownerId: string | null
  ): Promise<IEarningsAccount | null> {
    const oid = this.toOwnerId(ownerType, ownerId);
    return EarningsAccountModel.findOne({ owner_type: ownerType, owner_id: oid });
  }
}
