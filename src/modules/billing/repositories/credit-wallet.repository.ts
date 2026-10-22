import { Types, ClientSession } from 'mongoose';
import { CreditWalletModel, ICreditWallet, WalletOwnerType } from '../models/credit-wallet.model';
import { debtFloorFilter } from '../domain/wallet-debt';

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

  /** The owner's wallet, or `null` — WITHOUT creating one (a closure must not mint a wallet). */
  async findByOwner(
    ownerType: WalletOwnerType,
    ownerId: string,
    session?: ClientSession
  ): Promise<ICreditWallet | null> {
    if (!Types.ObjectId.isValid(ownerId)) return null;
    return CreditWalletModel.findOne({ owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) })
      .session(session ?? null)
      .exec();
  }

  /**
   * Atomically debit `amount` only if the balance can cover it. Returns the
   * updated wallet, or `null` when the balance is insufficient (no change made).
   *
   * ⚠ Since the schema stopped saying `min: 0` (SERVICE-LISTINGS-PLAN L-10), THIS filter is what
   * keeps every ordinary debit from crossing zero — and it refuses every debit at all while the
   * balance is negative, which is what "top-ups pay the debt first" rests on.
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

  /**
   * The ONE debit that may take a balance below zero (L-10, L-11): a provider's grace reveal.
   * Atomically debits `amount` only if `balance - amount >= floor`; `floor: null` means no floor
   * and the debit always lands. Returns the updated wallet, or `null` at the floor (no change).
   *
   * ⛔ **Callable from `credit-wallet.service.ts` only**, and that service method from
   * `ListingRevealService` only — `test:service-listings-billing` pins both. Every other debit
   * goes through `debitIfSufficient`.
   */
  async debitAllowingDebt(
    walletId: Types.ObjectId,
    amount: number,
    floor: number | null,
    session?: ClientSession
  ): Promise<ICreditWallet | null> {
    return CreditWalletModel.findOneAndUpdate(
      { _id: walletId, ...debtFloorFilter(amount, floor) },
      { $inc: { balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * L-12: bring a NEGATIVE balance to exactly 0, atomically, and return the wallet as it was
   * BEFORE the write (so the caller knows the debt it wrote off). `null` when the balance is not
   * negative — nothing is written. A pipeline update rather than `$inc: -balance`, so the value
   * written is decided by the server in the same operation that tests it.
   */
  async zeroNegativeBalance(walletId: Types.ObjectId, session?: ClientSession): Promise<ICreditWallet | null> {
    return CreditWalletModel.findOneAndUpdate(
      { _id: walletId, balance: { $lt: 0 } },
      [{ $set: { balance: 0, version: { $add: [{ $ifNull: ['$version', 0] }, 1] }, updated_at: '$$NOW' } }],
      { new: false, session: session ?? null }
    );
  }
}
