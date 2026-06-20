import { ClientSession } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CreditWalletRepository } from '../repositories/credit-wallet.repository';
import { CreditTransactionRepository } from '../repositories/credit-transaction.repository';
import { ICreditWallet, WalletOwnerType } from '../models/credit-wallet.model';
import { CreditTransactionType, CreditReasonCode } from '../models/credit-transaction.model';

/**
 * CreditWalletService - the single entry point for moving credits.
 *
 * Every mutation writes the wallet balance and a ledger row inside ONE
 * transaction, so balance and history can never diverge. Debits are guarded by
 * an atomic conditional update (see repository) and throw
 * `BILLING_INSUFFICIENT_CREDITS` when the balance can't cover the amount.
 */
export class CreditWalletService {
  constructor(
    private readonly walletRepo: CreditWalletRepository = new CreditWalletRepository(),
    private readonly ledgerRepo: CreditTransactionRepository = new CreditTransactionRepository()
  ) {}

  /** Credit the wallet within an EXISTING transaction (caller owns the session). */
  async creditInSession(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    type: CreditTransactionType,
    reasonCode: CreditReasonCode,
    ref: string | null,
    session: ClientSession
  ): Promise<ICreditWallet> {
    const wallet = await this.walletRepo.getOrCreate(ownerType, ownerId, session);
    const updated = await this.walletRepo.credit(wallet._id, amount, session);
    await this.ledgerRepo.create(
      {
        wallet_id: wallet._id,
        owner_type: ownerType,
        owner_id: wallet.owner_id,
        type,
        amount,
        balance_after: updated.balance,
        reason_code: reasonCode,
        ref,
      },
      session
    );
    return updated;
  }

  /** Credit the wallet in its own transaction (e.g. top-up completion). */
  async credit(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    type: CreditTransactionType,
    reasonCode: CreditReasonCode,
    ref: string | null = null
  ): Promise<ICreditWallet> {
    return transactionManager.runInTransaction((session) =>
      this.creditInSession(ownerType, ownerId, amount, type, reasonCode, ref, session)
    );
  }

  /**
   * Debit the wallet in its own transaction. Throws
   * `BILLING_INSUFFICIENT_CREDITS` (402) when the balance is too low.
   */
  async debit(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    reasonCode: CreditReasonCode,
    ref: string | null = null
  ): Promise<ICreditWallet> {
    return transactionManager.runInTransaction(async (session) => {
      const wallet = await this.walletRepo.getOrCreate(ownerType, ownerId, session);
      const updated = await this.walletRepo.debitIfSufficient(wallet._id, amount, session);
      if (!updated) {
        throw createAppError(
          ERROR_CODES.BILLING_INSUFFICIENT_CREDITS,
          402,
          'Not enough credits to perform this action',
          { balance: wallet.balance, requested: amount }
        );
      }
      await this.ledgerRepo.create(
        {
          wallet_id: wallet._id,
          owner_type: ownerType,
          owner_id: wallet.owner_id,
          type: 'debit',
          amount: -amount,
          balance_after: updated.balance,
          reason_code: reasonCode,
          ref,
        },
        session
      );
      return updated;
    });
  }

  /** Current balance for an owner (creates an empty wallet on first read). */
  async getBalance(ownerType: WalletOwnerType, ownerId: string): Promise<number> {
    const wallet = await this.walletRepo.getOrCreate(ownerType, ownerId);
    return wallet.balance;
  }

  async getLedger(ownerType: WalletOwnerType, ownerId: string, page: number, limit: number) {
    return this.ledgerRepo.listByOwner(ownerType, ownerId, page, limit);
  }
}

export const creditWalletService = new CreditWalletService();
