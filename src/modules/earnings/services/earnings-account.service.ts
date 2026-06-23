import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { EarningsAccountRepository } from '../repositories/earnings-account.repository';
import { EarningsLedgerRepository } from '../repositories/earnings-ledger.repository';
import { IEarningsAllocation } from '../models/earnings-allocation.model';
import { IEarningsAccount, EarningsOwnerType } from '../models/earnings-account.model';

/**
 * EarningsAccountService - the single entry point for moving MONEY between an
 * account's pending (escrow) and available (withdrawable) balances.
 *
 * Every mutation writes the account balance AND an append-only ledger row inside
 * ONE caller-owned transaction, so balance and history can never diverge. Mirrors
 * `CreditWalletService`, but for real money rather than metering credits.
 *
 * All methods take an existing `ClientSession`; the caller owns the transaction
 * (a split/release/reversal touches several accounts atomically).
 */
export class EarningsAccountService {
  constructor(
    private readonly accountRepo: EarningsAccountRepository = new EarningsAccountRepository(),
    private readonly ledgerRepo: EarningsLedgerRepository = new EarningsLedgerRepository()
  ) {}

  /** Hold an allocation's amount in the beneficiary's pending balance. */
  async holdInSession(allocation: IEarningsAllocation, session: ClientSession): Promise<void> {
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const updated = await this.accountRepo.hold(account._id, allocation.amount, session);
    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: 'hold',
        amount: allocation.amount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'order_split',
      },
      session
    );
  }

  /** Move an allocation's amount from pending → available (hold released). */
  async releaseInSession(allocation: IEarningsAllocation, session: ClientSession): Promise<void> {
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const updated = await this.accountRepo.release(account._id, allocation.amount, session);
    if (!updated) {
      // Pending could not cover the amount — should not happen given the hold,
      // but guard against double-release / drift by failing the transaction.
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: 'release',
        amount: allocation.amount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'hold_release',
      },
      session
    );
  }

  /**
   * Reverse an allocation (refund). Pulls the amount from `pending` when the
   * allocation was still held, or from `available` when it had already been
   * released (clawback).
   */
  async reverseInSession(
    allocation: IEarningsAllocation,
    fromAvailable: boolean,
    session: ClientSession
  ): Promise<void> {
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const updated = fromAvailable
      ? await this.accountRepo.reverseFromAvailable(account._id, allocation.amount, session)
      : await this.accountRepo.reverseFromPending(account._id, allocation.amount, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings reversal underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: 'reversal',
        amount: allocation.amount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'refund_reversal',
      },
      session
    );
  }

  /** Current pending/available balances for a beneficiary (read-only). */
  async getBalances(
    ownerType: EarningsOwnerType,
    ownerId: string | null
  ): Promise<{ pending: number; available: number; currency: string }> {
    const account: IEarningsAccount | null = await this.accountRepo.find(ownerType, ownerId);
    return {
      pending: account?.pending_balance ?? 0,
      available: account?.available_balance ?? 0,
      currency: account?.currency ?? 'XAF',
    };
  }

  async getLedger(ownerType: EarningsOwnerType, ownerId: string | null, page: number, limit: number) {
    return this.ledgerRepo.listByOwner(ownerType, ownerId, page, limit);
  }
}

export const earningsAccountService = new EarningsAccountService();
