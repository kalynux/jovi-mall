import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { AccountSnapshot, EarningsAccountRepository } from '../repositories/earnings-account.repository';
import { EarningsAdjustmentRepository } from '../repositories/earnings-adjustment.repository';
import { EarningsReserveHoldModel } from '../models/earnings-reserve-hold.model';
import { NOTHING_TAKEN, TakenFrom, releasableAmount } from '../domain/clawback-netting';
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
    private readonly ledgerRepo: EarningsLedgerRepository = new EarningsLedgerRepository(),
    private readonly adjustmentRepo: EarningsAdjustmentRepository = new EarningsAdjustmentRepository()
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

  /**
   * Move a HELD allocation's beneficiary pending balance by `delta` — the account half of an
   * in-place re-pricing (`EarningsAllocationRepository.adjustHeldAmount`, same transaction).
   *
   * Positive `delta` holds more (a `hold` ledger row); negative pulls it back out of pending
   * (a `reversal` row) and throws on underflow so the caller's transaction aborts. Both rows
   * carry `delivery_fee_adjustment`, so a beneficiary's history says WHY their pending moved
   * after the split. A zero delta writes nothing.
   */
  async adjustHeldInSession(
    allocation: IEarningsAllocation,
    delta: number,
    session: ClientSession
  ): Promise<void> {
    if (delta === 0) return;
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const magnitude = Math.abs(delta);
    const updated =
      delta > 0
        ? await this.accountRepo.hold(account._id, magnitude, session)
        : await this.accountRepo.reverseFromPending(account._id, magnitude, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings adjustment underflow', {
        allocationId: allocation._id.toString(),
        delta,
      });
    }
    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: delta > 0 ? 'hold' : 'reversal',
        amount: magnitude,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'delivery_fee_adjustment',
      },
      session
    );
  }

  /**
   * Move a released allocation's REMAINDER from pending → available (hold released).
   *
   * The remainder is `amount − clawed_amount` (REFUND-FLOW-PLAN § 6.1 (6)): a refund that
   * already took part of a held share back took it out of pending, so only the rest is there to
   * release. The inflow nets the owner's refund debt first (`release` is a netting update); the
   * ledger then carries a `release` row for what reached available and a `clawback_recovery`
   * row for what paid the debt.
   */
  async releaseInSession(allocation: IEarningsAllocation, session: ClientSession): Promise<void> {
    const amount = releasableAmount(allocation);
    if (amount <= 0) return;
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const netted = await this.accountRepo.release(account._id, amount, session);
    if (!netted) {
      // Pending could not cover the amount — should not happen given the hold,
      // but guard against double-release / drift by failing the transaction.
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    const updated = netted.account;
    if (amount - netted.recovered > 0) {
      await this.ledgerRepo.create(
        {
          account_id: account._id,
          owner_type: account.owner_type,
          owner_id: account.owner_id,
          entry_type: 'release',
          amount: amount - netted.recovered,
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
    await this.recordRecovery(allocation, updated, netted.recovered, `recovery:${allocation._id.toString()}`, session);
  }

  /**
   * Release an allocation's REMAINDER with a COD rolling-reserve carve-out: pending loses the
   * remainder, available gains `remainder − reserveAmount` (netting debt first), reserve gains
   * `reserveAmount`. The caller computes `reserveAmount` ON THE REMAINDER and creates the
   * matching EarningsReserveHold in the same transaction.
   */
  async releaseWithReserveInSession(
    allocation: IEarningsAllocation,
    reserveAmount: number,
    session: ClientSession
  ): Promise<AccountSnapshot> {
    const amount = releasableAmount(allocation);
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );
    const netted = await this.accountRepo.releaseWithReserve(account._id, amount, reserveAmount, session);
    if (!netted) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    const updated = netted.account;
    const base = {
      account_id: account._id,
      owner_type: account.owner_type,
      owner_id: account.owner_id,
      source_type: allocation.source_type,
      source_id: allocation.source_id.toString(),
      allocation_id: allocation._id,
    };
    if (amount - reserveAmount - netted.recovered > 0) {
      await this.ledgerRepo.create(
        {
          ...base,
          entry_type: 'release',
          amount: amount - reserveAmount - netted.recovered,
          pending_after: updated.pending_balance,
          available_after: updated.available_balance,
          reason_code: 'hold_release',
        },
        session
      );
    }
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
    await this.recordRecovery(allocation, updated, netted.recovered, `recovery:${allocation._id.toString()}`, session);
    return updated;
  }

  /** Move a matured reserve hold's amount from reserve → available, netting debt first. */
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
    const netted = await this.accountRepo.releaseReserve(account._id, amount, session);
    if (!netted) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Reserve release underflow', {
        allocationId: allocation._id.toString(),
      });
    }
    const updated = netted.account;
    if (amount - netted.recovered > 0) {
      await this.ledgerRepo.create(
        {
          account_id: account._id,
          owner_type: account.owner_type,
          owner_id: account.owner_id,
          entry_type: 'reserve_release',
          amount: amount - netted.recovered,
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
    // One reserve slice per allocation (unique `source_allocation_id`), so the key is unique.
    await this.recordRecovery(
      allocation,
      updated,
      netted.recovered,
      `recovery:reserve:${allocation._id.toString()}`,
      session
    );
  }

  /**
   * The record of debt paid down by an allocation's own inflow: a `clawback_recovery` ledger
   * row and the matching `earnings_adjustments` row, same transaction. Nothing when 0.
   */
  private async recordRecovery(
    allocation: IEarningsAllocation,
    updated: AccountSnapshot,
    recovered: number,
    key: string,
    session: ClientSession
  ): Promise<void> {
    if (recovered <= 0) return;
    await this.ledgerRepo.create(
      {
        account_id: updated._id,
        owner_type: updated.owner_type,
        owner_id: updated.owner_id,
        entry_type: 'clawback_recovery',
        amount: recovered,
        pending_after: updated.pending_balance,
        available_after: updated.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'clawback_recovery',
      },
      session
    );
    await this.adjustmentRepo.create(
      {
        refund_key: key,
        allocation_id: allocation._id as Types.ObjectId,
        source_type: allocation.source_type,
        source_id: allocation.source_id,
        beneficiary_type: updated.owner_type,
        beneficiary_id: updated.owner_id,
        amount: recovered,
        currency: updated.currency,
        taken_from: { pending: 0, reserve: 0, available: 0, debt: recovered },
        kind: 'clawback_recovery',
      },
      session
    );
  }

  // ── Clawback (REFUND-FLOW-PLAN § 6.1) ─────────────────────────────────────────────

  /**
   * Take `claw` back from ONE share, in the take order of `domain/clawback-netting.ts`:
   * a held share from pending; a released share from its own still-held reserve slice, then
   * available, then debt. Writes the `clawback` ledger row. Does NOT touch the allocation row
   * (the caller's `addClawed`) nor write the adjustment (the caller knows the refund).
   *
   * Throws on a held share whose pending cannot cover the claw — drift, not debt.
   */
  async clawInSession(
    allocation: IEarningsAllocation,
    claw: number,
    session: ClientSession,
    now: Date = new Date()
  ): Promise<TakenFrom> {
    if (claw <= 0) return { ...NOTHING_TAKEN };
    const account = await this.accountRepo.getOrCreate(
      allocation.beneficiary_type,
      allocation.beneficiary_id ? allocation.beneficiary_id.toString() : null,
      session
    );

    let taken: TakenFrom;
    let after: { pending_balance: number; available_balance: number };

    if (allocation.status === 'held') {
      const updated = await this.accountRepo.reverseFromPending(account._id, claw, session);
      if (!updated) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings clawback underflow', {
          allocationId: allocation._id.toString(),
          claw,
        });
      }
      taken = { pending: claw, reserve: 0, available: 0, debt: 0 };
      after = updated;
    } else {
      // The share's own reserve slice first, while it is still held.
      let fromReserve = 0;
      const hold = await EarningsReserveHoldModel.findOne(
        { source_allocation_id: allocation._id, status: 'held' },
        null,
        { session }
      );
      if (hold && hold.amount > 0) {
        fromReserve = Math.min(claw, hold.amount);
        const holdUpdate =
          fromReserve === hold.amount
            ? { $set: { status: 'clawed' as const, released_at: now } }
            : { $inc: { amount: -fromReserve } };
        const claimed = await EarningsReserveHoldModel.findOneAndUpdate(
          { _id: hold._id, status: 'held', amount: hold.amount },
          holdUpdate,
          { new: true, session }
        );
        const fromAccount = claimed ? await this.accountRepo.clawFromReserve(account._id, fromReserve, session) : null;
        if (!claimed || !fromAccount) {
          throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings clawback reserve conflict', {
            allocationId: allocation._id.toString(),
          });
        }
      }
      const rest = claw - fromReserve;
      const clawed = await this.accountRepo.clawFromAvailable(account._id, rest, session);
      if (!clawed) {
        throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings account vanished mid-clawback', {
          allocationId: allocation._id.toString(),
        });
      }
      taken = { pending: 0, reserve: fromReserve, available: clawed.fromAvailable, debt: clawed.toDebt };
      after = clawed.account;
    }

    await this.ledgerRepo.create(
      {
        account_id: account._id,
        owner_type: account.owner_type,
        owner_id: account.owner_id,
        entry_type: 'clawback',
        amount: claw,
        pending_after: after.pending_balance,
        available_after: after.available_balance,
        source_type: allocation.source_type,
        source_id: allocation.source_id.toString(),
        allocation_id: allocation._id,
        reason_code: 'refund_clawback',
      },
      session
    );
    return taken;
  }

  /**
   * Charge an owner money with NO share behind it (the vendor's part beyond their rows, C-1):
   * available first, then debt. Ledger row only when an allocation gives it a home.
   */
  async clawBeyondInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    amount: number,
    ledgerHome: IEarningsAllocation | null,
    session: ClientSession
  ): Promise<TakenFrom> {
    if (amount <= 0) return { ...NOTHING_TAKEN };
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const clawed = await this.accountRepo.clawFromAvailable(account._id, amount, session);
    if (!clawed) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Earnings account vanished mid-clawback', {
        ownerType,
        ownerId,
      });
    }
    if (ledgerHome) {
      await this.ledgerRepo.create(
        {
          account_id: account._id,
          owner_type: account.owner_type,
          owner_id: account.owner_id,
          entry_type: 'clawback',
          amount,
          pending_after: clawed.account.pending_balance,
          available_after: clawed.account.available_balance,
          source_type: ledgerHome.source_type,
          source_id: ledgerHome.source_id.toString(),
          allocation_id: ledgerHome._id,
          reason_code: 'refund_clawback',
        },
        session
      );
    }
    return { pending: 0, reserve: 0, available: clawed.fromAvailable, debt: clawed.toDebt };
  }

  /** Forgive `amount` of an owner's debt (C-6). Throws 409 when they owe less. */
  async writeOffInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    amount: number,
    session: ClientSession
  ): Promise<AccountSnapshot> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const owed = account.clawback_balance ?? 0;
    if (owed <= 0) {
      throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_NOTHING_OWED, 409);
    }
    const updated = await this.accountRepo.writeOffDebt(account._id, amount, session);
    if (!updated) {
      throw createAppError(ERROR_CODES.EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT, 409, undefined, { owed, amount });
    }
    return {
      _id: updated._id as Types.ObjectId,
      owner_type: updated.owner_type,
      owner_id: updated.owner_id,
      currency: updated.currency,
      pending_balance: updated.pending_balance,
      available_balance: updated.available_balance,
      reserve_balance: updated.reserve_balance,
      requested_balance: updated.requested_balance,
      clawback_balance: updated.clawback_balance ?? 0,
    };
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

  /**
   * Current balances for a beneficiary (read-only).
   *
   * `clawback` (REFUND-FLOW-PLAN § 6) is what the owner OWES BACK after a refund took more than
   * their balances held. It runs the OTHER way from the four before it — never add it to them;
   * while it is above 0, `available` is 0 and every future release pays it down first.
   */
  async getBalances(
    ownerType: EarningsOwnerType,
    ownerId: string | null
  ): Promise<{ pending: number; available: number; reserve: number; requested: number; clawback: number; currency: string }> {
    const account: IEarningsAccount | null = await this.accountRepo.find(ownerType, ownerId);
    return {
      pending: account?.pending_balance ?? 0,
      available: account?.available_balance ?? 0,
      reserve: account?.reserve_balance ?? 0,
      requested: account?.requested_balance ?? 0,
      clawback: account?.clawback_balance ?? 0,
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
   *
   * ── `totals` answers a question the page cannot ────────────────────────────
   * A client can sum the twenty rows it was handed; it cannot sum the other four
   * hundred, so "how much do we owe in total" is unanswerable from a page. The
   * totals are computed here over the SAME filtered population, one entry per
   * currency, and carry **no sum across the four balances** — see
   * `EarningsAccountRepository.totalsForAdmin` for why that sum must not exist.
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
      /** Owed BACK by the owner (refund clawback) — the opposite direction; never summed with the rest. */
      clawback: number;
      currency: string;
      updatedAt: string;
    }>;
    total: number;
    totals: Array<{
      currency: string;
      pending: number;
      available: number;
      reserve: number;
      requested: number;
      clawback: number;
    }>;
  }> {
    const [{ data, total }, totals] = await Promise.all([
      this.accountRepo.listForAdmin(ownerType, page, limit),
      this.accountRepo.totalsForAdmin(ownerType),
    ]);
    return {
      data: data.map((account) => ({
        ownerType: account.owner_type,
        ownerId: account.owner_id ? account.owner_id.toString() : null,
        pending: account.pending_balance,
        available: account.available_balance,
        reserve: account.reserve_balance,
        requested: account.requested_balance,
        clawback: account.clawback_balance ?? 0,
        currency: account.currency,
        updatedAt: account.updated_at.toISOString(),
      })),
      total,
      totals,
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
  /**
   * Move an owner's WHOLE available balance into `requested_balance`.
   *
   * There is no partial form: a `maxAmount` parameter existed only for the unverified-account
   * payout cap, deleted 2026-09-27 (owner decision — verification never holds back somebody's
   * money). Do not re-add one for that purpose.
   */
  async moveAvailableToRequestedInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    session: ClientSession
  ): Promise<{ amount: number; currency: string }> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const available = account.available_balance;
    if (available <= 0) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE,
        409,
        'There is no available balance to request a payout for'
      );
    }

    const amount = available;

    if (amount < EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT) {
      throw createAppError(
        ERROR_CODES.EARNINGS_PAYOUT_BELOW_MINIMUM,
        409,
        `Available balance must be at least ${EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT} ${account.currency} to request a payout`,
        {
          minAmount: EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT,
          available,
        }
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

  /**
   * Payout rejected (or its ticket failed): the earmarked amount returns to the available
   * balance — NETTING the owner's refund debt first (C-7). What paid the debt is recorded as a
   * `clawback_recovery` adjustment under `recoveryKey`; no ledger row, as no payout movement
   * has ever written one (the ledger is allocation-scoped).
   *
   * `recoveryKey` must be unique per event (`recovery:payout:<id>:<event>`); a caller that
   * passes none gets a fresh id, so the recovery is still recorded.
   */
  async revertPayoutToAvailableInSession(
    ownerType: EarningsOwnerType,
    ownerId: string | null,
    amount: number,
    session: ClientSession,
    recoveryKey: string = `recovery:payout:${new Types.ObjectId().toString()}`
  ): Promise<void> {
    const account = await this.accountRepo.getOrCreate(ownerType, ownerId, session);
    const netted = await this.accountRepo.releaseRequestedToAvailable(account._id, amount, session);
    if (!netted) {
      throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Payout revert underflow', {
        ownerType,
        ownerId,
      });
    }
    if (netted.recovered > 0) {
      await this.adjustmentRepo.create(
        {
          refund_key: recoveryKey,
          allocation_id: null,
          source_type: null,
          source_id: null,
          beneficiary_type: netted.account.owner_type,
          beneficiary_id: netted.account.owner_id,
          amount: netted.recovered,
          currency: netted.account.currency,
          taken_from: { pending: 0, reserve: 0, available: 0, debt: netted.recovered },
          kind: 'clawback_recovery',
        },
        session
      );
    }
  }
}

export const earningsAccountService = new EarningsAccountService();
