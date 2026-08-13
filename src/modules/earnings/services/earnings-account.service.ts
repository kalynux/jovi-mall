import { ClientSession } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { EarningsAccountRepository } from '../repositories/earnings-account.repository';
import { EarningsLedgerRepository } from '../repositories/earnings-ledger.repository';
import { IEarningsAllocation, EarningsSourceType } from '../models/earnings-allocation.model';
import { IEarningsAccount, EarningsOwnerType } from '../models/earnings-account.model';
import { EarningsLedgerReasonCode } from '../models/earnings-ledger.model';
import { EARNINGS_CONFIG } from '../config/earnings.config';

/**
 * Which split a `hold` ledger row came from. One reason code per source type so
 * a beneficiary's history says *why* money arrived: at payment (`order_split`),
 * on a COD cash handoff (`cod_split`), or when a prepaid shipment was delivered
 * and its delivery fee was divided between agency and agent (`delivery_split`).
 */
function holdReasonCode(sourceType: EarningsSourceType): EarningsLedgerReasonCode {
  if (sourceType === 'cod_collection') return 'cod_split';
  if (sourceType === 'shipment') return 'delivery_split';
  return 'order_split';
}

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
        reason_code: holdReasonCode(allocation.source_type),
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
   * Release an allocation with a COD rolling-reserve carve-out: pending loses
   * the full amount, available gains `amount - reserveAmount`, reserve gains
   * `reserveAmount`. Two ledger rows keep the split auditable. The caller
   * creates the matching EarningsReserveHold in the same transaction.
   */
  async releaseWithReserveInSession(
    allocation: IEarningsAllocation,
    reserveAmount: number,
    session: ClientSession
  ): Promise<IEarningsAccount> {
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const updated = await this.accountRepo.releaseWithReserve(
      account._id,
      allocation.amount,
      reserveAmount,
      session
    );
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    const base = {
      account_id: account._id,
      owner_type: account.owner_type,
      owner_id: account.owner_id,
      source_type: allocation.source_type,
      source_id: allocation.source_id.toString(),
      allocation_id: allocation._id,
    };
    await this.ledgerRepo.create(
      {
        ...base,
        entry_type: 'release',
        amount: allocation.amount - reserveAmount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        reason_code: 'hold_release',
      },
      session
    );
    await this.ledgerRepo.create(
      {
        ...base,
        entry_type: 'reserve_hold',
        amount: reserveAmount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        reason_code: 'cod_rolling_reserve',
      },
      session
    );
    return account;
  }

  /** Move a matured reserve hold's amount from reserve → available. */
  async releaseReserveInSession(
    allocation: IEarningsAllocation,
    amount: number,
    session: ClientSession
  ): Promise<void> {
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const updated = await this.accountRepo.releaseReserve(account._id, amount, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Reserve release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: 'reserve_release',
        amount,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'reserve_matured',
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

  /** Current pending/available/reserve/requested balances for a beneficiary (read-only). */
  async getBalances(
    ownerType: EarningsOwnerType,
    ownerId: string | null
  ): Promise<{ pending: number; available: number; reserve: number; requested: number; currency: string }> {
    const account: IEarningsAccount | null = await this.accountRepo.find(ownerType, ownerId);
    return {
      pending: account?.pending_balance ?? 0,
      available: account?.available_balance ?? 0,
      reserve: account?.reserve_balance ?? 0,
      requested: account?.requested_balance ?? 0,
      currency: account?.currency ?? 'XAF',
    };
  }

  /** Paginated earnings ledger (still used by the admin platform-earnings view). */
  async getLedger(ownerType: EarningsOwnerType, ownerId: string | null, page: number, limit: number) {
    return this.ledgerRepo.listByOwner(ownerType, ownerId, page, limit);
  }

  /**
   * Every owner's balances, ranked by what is withdrawable — the administrative
   * "who are we holding money for" view.
   *
   * Goes through this service rather than letting a caller read `earnings_accounts`
   * directly, for the same reason `getBalances` does: four sub-balances only this
   * service's transactions move, and a second reader deriving them elsewhere would
   * be a second opinion about how much money exists. The platform singleton is
   * excluded by the repository — see `listForAdmin`.
   */
  async listAccountsForAdmin(
    ownerType: EarningsOwnerType | null,
    page: number,
    limit: number
  ): Promise<{
    data: Array<{
      ownerType: EarningsOwnerType;
      ownerId: string | null;
      pending: number;
      available: number;
      reserve: number;
      requested: number;
      currency: string;
      updatedAt: string;
    }>;
    total: number;
  }> {
    const { data, total } = await this.accountRepo.listForAdmin(ownerType, page, limit);
    return {
      data: data.map((account) => ({
        ownerType: account.owner_type,
        ownerId: account.owner_id ? account.owner_id.toString() : null,
        pending: account.pending_balance,
        available: account.available_balance,
        reserve: account.reserve_balance,
        requested: account.requested_balance,
        currency: account.currency,
        updatedAt: account.updated_at.toISOString(),
      })),
      total,
    };
  }

  /**
   * Payout request created: move the account's ENTIRE available balance into
   * `requested_balance`. Throws if there's nothing to move (zero available) or
   * if a concurrent mutation changed the balance between read and write (the
   * caller retries the whole request rather than moving a stale amount).
   *
   * No EarningsLedger row is written here — that ledger is scoped to
   * order/booking/COD-split allocations (`source_type`/`source_id`/
   * `allocation_id` are required and a payout request has none of these).
   * PayoutRequest's own status/timestamps are the audit trail for this money
   * movement instead.
   */
  async moveAvailableToRequestedInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    session: ClientSession
  ): Promise<{ amount: number; currency: string }> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const amount = account.available_balance;
    if (amount <= 0) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE,
        409,
        'There is no available balance to request a payout for'
      );
    }
    if (amount < EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_BELOW_MINIMUM,
        409,
        `Available balance must be at least ${EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT} ${account.currency} to request a payout`,
        { minAmount: EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT, available: amount }
      );
    }
    const updated = await this.accountRepo.moveAvailableToRequested(account._id, amount, session);
    if (!updated) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE,
        409,
        'Available balance changed concurrently — please try again'
      );
    }
    return { amount, currency: updated.currency };
  }

  /** Payout marked paid: the earmarked amount permanently leaves the ledger. */
  async markPayoutPaidInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    amount: number,
    session: ClientSession
  ): Promise<void> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const updated = await this.accountRepo.deductFromRequested(account._id, amount, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Payout mark-paid underflow', {
        ownerType,
        ownerId,
      });
    }
  }

  /** Payout rejected: the earmarked amount returns to the available balance. */
  async revertPayoutToAvailableInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    amount: number,
    session: ClientSession
  ): Promise<void> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const updated = await this.accountRepo.releaseRequestedToAvailable(account._id, amount, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Payout revert underflow', {
        ownerType,
        ownerId,
      });
    }
  }
}

export const earningsAccountService = new EarningsAccountService();
