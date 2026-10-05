import { Types, ClientSession } from 'mongoose';
import {
  EarningsAccountModel,
  IEarningsAccount,
  EarningsOwnerType,
  isPlatformOwnerType,
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
    // Both platform-owned types are singletons — `platform` (commission) and
    // `platform_ai` (the bargaining agent's share of a negotiated uplift). Read
    // from ONE list rather than compared to a literal: a second `=== 'platform'`
    // written here would have thrown INTERNAL_SERVER_ERROR on every AI-margin
    // allocation, on the money path, for want of an `owner_id` that by design
    // does not exist.
    if (isPlatformOwnerType(ownerType)) return null;
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
          clawback_balance: 0,
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
   * ── Every inflow to `available_balance` NETS DEBT (REFUND-FLOW-PLAN § 6.1 (5)) ─────────
   * The four methods below are the ONLY writes in this module that add to available, and
   * each is one atomic pipeline update: `recovered = min(inflow, clawback_balance)` pays the
   * owner's refund debt down and only `inflow − recovered` reaches available. The pipeline
   * reads the debt and writes the balances in the same document operation, so a concurrent
   * clawback can never slip between "read the debt" and "credit available".
   *
   * Each returns the account AS IT IS AFTER the update (computed from the pre-image the
   * operation returns, which is the only way to learn `recovered` atomically) and the amount
   * recovered, or `null` when the guarded source balance is too low. The caller writes the
   * ledger and `earnings_adjustments` rows for `recovered`. `test:earnings-clawback` scans
   * this file: an `available_balance` increase outside a netting pipeline fails it.
   */

  /** Atomically move `amount` from pending → available, netting debt. `null` when pending is too low. */
  async release(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<NettedInflow | null> {
    return this.nettingInflow(
      { _id: accountId, pending_balance: { $gte: amount } },
      amount,
      { pending_balance: { $subtract: ['$pending_balance', amount] } },
      (before) => ({ pending_balance: before.pending_balance - amount }),
      session
    );
  }

  /**
   * Atomically move `totalAmount` out of pending, splitting it into
   * `totalAmount - reserveAmount` → available (netting debt) and `reserveAmount` → reserve
   * (COD rolling reserve on agency releases). `null` when pending is too low.
   */
  async releaseWithReserve(
    accountId: Types.ObjectId,
    totalAmount: number,
    reserveAmount: number,
    session?: ClientSession
  ): Promise<NettedInflow | null> {
    return this.nettingInflow(
      { _id: accountId, pending_balance: { $gte: totalAmount } },
      totalAmount - reserveAmount,
      {
        pending_balance: { $subtract: ['$pending_balance', totalAmount] },
        reserve_balance: { $add: [{ $ifNull: ['$reserve_balance', 0] }, reserveAmount] },
      },
      (before) => ({
        pending_balance: before.pending_balance - totalAmount,
        reserve_balance: (before.reserve_balance ?? 0) + reserveAmount,
      }),
      session
    );
  }

  /** Atomically move `amount` from reserve → available (matured reserve hold), netting debt. */
  async releaseReserve(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<NettedInflow | null> {
    return this.nettingInflow(
      { _id: accountId, reserve_balance: { $gte: amount } },
      amount,
      { reserve_balance: { $subtract: ['$reserve_balance', amount] } },
      (before) => ({ reserve_balance: before.reserve_balance - amount }),
      session
    );
  }

  /**
   * The shared netting pipeline. `inflow` is what WOULD reach available; `otherSet` moves the
   * source balance in the same operation, and `otherAfter` mirrors it on the pre-image.
   */
  private async nettingInflow(
    filter: Record<string, unknown>,
    inflow: number,
    otherSet: Record<string, unknown>,
    otherAfter: (before: AccountSnapshot) => Partial<AccountSnapshot>,
    session?: ClientSession
  ): Promise<NettedInflow | null> {
    const debt = { $ifNull: ['$clawback_balance', 0] };
    const before = await EarningsAccountModel.findOneAndUpdate(
      filter,
      [
        { $set: { __recovered: { $min: [inflow, debt] } } },
        {
          $set: {
            ...otherSet,
            available_balance: { $add: ['$available_balance', { $subtract: [inflow, '$__recovered'] }] },
            clawback_balance: { $subtract: [debt, '$__recovered'] },
            version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
            updated_at: '$$NOW',
          },
        },
        { $unset: '__recovered' },
      ],
      { new: false, session: session ?? null }
    ).lean<AccountSnapshot>();
    if (!before) return null;
    const recovered = Math.min(inflow, before.clawback_balance ?? 0);
    const account: AccountSnapshot = {
      ...before,
      ...otherAfter(before),
      available_balance: before.available_balance + inflow - recovered,
      clawback_balance: (before.clawback_balance ?? 0) - recovered,
    };
    return { account, recovered };
  }

  // ── Clawback (REFUND-FLOW-PLAN § 6.1) ─────────────────────────────────────────────

  /**
   * Take up to `amount` from available and owe the rest: `fromAvailable = min(amount,
   * available)`, `clawback_balance += amount − fromAvailable`, in ONE atomic pipeline update.
   * Never fails for lack of money — what cannot be paid becomes debt; that is the point.
   */
  async clawFromAvailable(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<{ account: AccountSnapshot; fromAvailable: number; toDebt: number } | null> {
    const before = await EarningsAccountModel.findOneAndUpdate(
      { _id: accountId },
      [
        { $set: { __take: { $min: [amount, { $max: [0, '$available_balance'] }] } } },
        {
          $set: {
            available_balance: { $subtract: ['$available_balance', '$__take'] },
            clawback_balance: {
              $add: [{ $ifNull: ['$clawback_balance', 0] }, { $subtract: [amount, '$__take'] }],
            },
            version: { $add: [{ $ifNull: ['$version', 0] }, 1] },
            updated_at: '$$NOW',
          },
        },
        { $unset: '__take' },
      ],
      { new: false, session: session ?? null }
    ).lean<AccountSnapshot>();
    if (!before) return null;
    const fromAvailable = Math.min(amount, Math.max(0, before.available_balance));
    const toDebt = amount - fromAvailable;
    return {
      account: {
        ...before,
        available_balance: before.available_balance - fromAvailable,
        clawback_balance: (before.clawback_balance ?? 0) + toDebt,
      },
      fromAvailable,
      toDebt,
    };
  }

  /** Remove `amount` from the reserve (a released share's own slice). `null` when too low. */
  async clawFromReserve(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, reserve_balance: { $gte: amount } },
      { $inc: { reserve_balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /** Forgive `amount` of debt (C-6). `null` when the account owes less than that. */
  async writeOffDebt(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, clawback_balance: { $gte: amount } },
      { $inc: { clawback_balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /** Accounts that owe money back, largest debt first — the write-off queue (§ 6.4, § 6.6). */
  async listDebtors(
    ownerType: EarningsOwnerType | null,
    page: number,
    limit: number
  ): Promise<{ data: IEarningsAccount[]; total: number }> {
    const query: Record<string, unknown> = { clawback_balance: { $gt: 0 } };
    if (ownerType) query.owner_type = ownerType;
    const [data, total] = await Promise.all([
      EarningsAccountModel.find(query)
        .sort({ clawback_balance: -1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      EarningsAccountModel.countDocuments(query),
    ]);
    return { data, total };
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

  /**
   * Vendor/agency accounts whose `available_balance` has reached `threshold`
   * — used by EarningsReleaseWorker's daily auto-payout sweep. Never includes
   * the platform account (it has no payout concept).
   */
  async findOverThreshold(threshold: number): Promise<IEarningsAccount[]> {
    return EarningsAccountModel.find({
      owner_type: { $in: ['vendor', 'agency'] },
      available_balance: { $gte: threshold },
    });
  }

  /**
   * Every owner's account, ranked by what the platform owes them.
   *
   * Added for wi-admin's cross-owner balances table, which previously had no way to
   * ask this question — the repository could find ONE account, or every account over
   * a threshold, and nothing in between.
   *
   * The platform singleton is excluded: it is the marketplace's own commission, it
   * pays itself nothing, and mixing it into a ranking of what is owed to other
   * people makes the largest row on the page mean the opposite of the rest.
   *
   * Sorted by `available_balance` — the withdrawable figure, i.e. the one an
   * operator is deciding about — with `_id` as a tiebreaker so paging is stable
   * across two accounts holding the same amount.
   */
  async listForAdmin(
    ownerType: EarningsOwnerType | null,
    page: number,
    limit: number
  ): Promise<{ data: IEarningsAccount[]; total: number }> {
    const query = adminScopeFilter(ownerType);

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      EarningsAccountModel.find(query).sort({ available_balance: -1, _id: 1 }).skip(skip).limit(limit),
      EarningsAccountModel.countDocuments(query),
    ]);
    return { data, total };
  }

  /**
   * The four balances summed **down each column, across every owner in scope** —
   * one row per currency.
   *
   * ── Why this is not the sum `EarningsAccountDto` forbids ────────────────────
   * There is a sum that must never exist: `pending + available + reserve + requested`
   * for one owner. Those are stages of one pipeline, not four pots — `requested` is a
   * claim already staked against `available`, so adding them double-counts. Nothing
   * here does that, and nothing here should.
   *
   * This is the other axis: one field, one currency, across owners. Same unit, same
   * direction (`owed_to_owner`), and **only this service can compute it honestly**,
   * because it is the only party that can see past page 1 of the caller's list.
   *
   * Grouped by currency rather than coerced into one, because an account carries its
   * own `currency` and picking a single one would be inventing an exchange rate.
   *
   * ⚠ It MUST share `adminScopeFilter` with `listForAdmin`. A total computed over a
   * different population than the table above it is worse than no total at all — it
   * disagrees with the rows the operator can see and there is no way to tell from the
   * screen which of the two is wrong.
   */
  async totalsForAdmin(
    ownerType: EarningsOwnerType | null
  ): Promise<Array<{ currency: string; pending: number; available: number; reserve: number; requested: number; clawback: number }>> {
    const rows = await EarningsAccountModel.aggregate<{
      _id: string;
      pending: number;
      available: number;
      reserve: number;
      requested: number;
      clawback: number;
    }>([
      { $match: adminScopeFilter(ownerType) },
      {
        $group: {
          _id: '$currency',
          pending: { $sum: '$pending_balance' },
          available: { $sum: '$available_balance' },
          reserve: { $sum: '$reserve_balance' },
          requested: { $sum: '$requested_balance' },
          // What owners OWE BACK (refund clawback). The opposite direction to the four above —
          // summed down its own column, never into theirs.
          clawback: { $sum: { $ifNull: ['$clawback_balance', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({
      currency: row._id,
      pending: row.pending,
      available: row.available,
      reserve: row.reserve,
      requested: row.requested,
      clawback: row.clawback,
    }));
  }

  /**
   * Atomically move the account's ENTIRE `available_balance` into
   * `requested_balance` (payout request). `amount` must be the value the
   * caller just read in the same session — the exact-match guard means this
   * returns `null` if a concurrent write changed `available_balance` first
   * (race lost; caller surfaces a "try again" error rather than moving a
   * stale/wrong amount).
   */
  async moveAvailableToRequested(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, available_balance: amount },
      { $inc: { available_balance: -amount, requested_balance: amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Mark-paid: permanently remove `amount` from `requested_balance` — the
   * funds have left the platform's ledger. Returns `null` when requested is
   * too low.
   */
  async deductFromRequested(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<IEarningsAccount | null> {
    return EarningsAccountModel.findOneAndUpdate(
      { _id: accountId, requested_balance: { $gte: amount } },
      { $inc: { requested_balance: -amount, version: 1 } },
      { new: true, session: session ?? null }
    );
  }

  /**
   * Reject (or a failed payout ticket): move `amount` back from `requested_balance` to
   * `available_balance`, NETTING DEBT on the way (C-7: "if an administrator rejects it, the
   * money pays off the debt on its way back"). `null` when requested is too low.
   */
  async releaseRequestedToAvailable(
    accountId: Types.ObjectId,
    amount: number,
    session?: ClientSession
  ): Promise<NettedInflow | null> {
    return this.nettingInflow(
      { _id: accountId, requested_balance: { $gte: amount } },
      amount,
      { requested_balance: { $subtract: ['$requested_balance', amount] } },
      (before) => ({ requested_balance: before.requested_balance - amount }),
      session
    );
  }
}

/** The balances of an account, as a plain object (what the netting pipelines return). */
export interface AccountSnapshot {
  _id: Types.ObjectId;
  owner_type: EarningsOwnerType;
  owner_id: Types.ObjectId | null;
  currency: string;
  pending_balance: number;
  available_balance: number;
  reserve_balance: number;
  requested_balance: number;
  clawback_balance: number;
}

/** An inflow to available, after netting: the account after the update and the debt it repaid. */
export interface NettedInflow {
  account: AccountSnapshot;
  recovered: number;
}

/**
 * The population the administrative reads work over — the page AND its totals.
 *
 * Extracted so the two cannot drift. The platform singleton is excluded here rather
 * than at each call site, because it is the marketplace's own commission: it pays
 * itself nothing, and folding it into "what we owe people" makes the largest number
 * on the screen mean the opposite of every other row.
 */
function adminScopeFilter(ownerType: EarningsOwnerType | null): Record<string, unknown> {
  return ownerType ? { owner_type: ownerType } : { owner_type: { $in: ['vendor', 'agency', 'agent'] } };
}
