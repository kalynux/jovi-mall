import { Types, ClientSession } from 'mongoose';
import { CreditWalletModel, ICreditWallet, WalletOwnerType } from '../models/credit-wallet.model';

/**
 * Persistence for credit wallets. Balance mutations are expressed as atomic
 * conditional `$inc` updates (no read-modify-write) so concurrent debits cannot
 * over-spend; `version` is bumped on every change for optimistic-lock semantics.
 */
export class CreditWalletRepository {
  /** Fetch the owner's wallet, creating an empty one if absent. */
  async getOrCreate(
    ownerType: WalletOwnerType,
    ownerId: string,
    session?: ClientSession
  ): Promise<ICreditWallet> {
    const wallet = await CreditWalletModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) },
      { $setOnInsert: { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId), balance: 0, version: 0 } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session: session ?? null }
    );
    return wallet!;
  }

  /** Add credits. Always succeeds. Returns the updated wallet. */
  async credit(walletId: Types.ObjectId, amount: number, session?: ClientSession): Promise<ICreditWallet> {
    const updated = await CreditWalletModel.findByIdAndUpdate(
      walletId,
      { $inc: { balance: amount, version: 1 } },
      { new: true, session: session ?? null }
    );
    return updated!;
  }

  /**
   * Atomically debit `amount` only if the balance can cover it. Returns the
   * updated wallet, or `null` when the balance is insufficient (no change made).
   */
  async debitIfSufficient(
    walletId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<ICreditWallet | null> {
    return CreditWalletModel.findOneAndUpdate(
      { _id: walletId, balance: { $gte: amount } },
      { $inc: { balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }
}
