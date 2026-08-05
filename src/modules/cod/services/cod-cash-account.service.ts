import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
  CodCashAccountModel,
  ICodCashAccount,
  CodCashOwnerType,
} from '../models/cod-cash-account.model';
import {
  CodCashLedgerModel,
  CodCashLedgerEntryType,
  CodCashLedgerRefType,
} from '../models/cod-cash-ledger.model';

/**
 * CodCashAccountService - the single entry point for moving PHYSICAL-CASH
 * liability balances (agent holds / agency owes platform).
 *
 * Every mutation writes the account balance AND an append-only ledger row
 * inside ONE caller-owned transaction, so balance and history can never
 * diverge. Mirrors EarningsAccountService, but for cash liabilities rather
 * than escrowed earnings.
 *
 * **An `agent` balance here is the PERSON's pot across every agency they serve,
 * so it is never an agency-facing figure.** The agency's view of what its agent
 * is holding is `contract.cod.outstanding_balance` — the per-contract slice this
 * pot is attributed into on collection and drawn down from on deposit. A batch
 * `getBalances` helper used to exist for exactly the agency views that must not
 * use it, and was removed with them; agent-scoped (`GET /api/agent/cod/summary`)
 * and admin-scoped reads are the only legitimate consumers of the pot.
 */
export class CodCashAccountService {
  /** Raise a liability (cash collected). */
  async creditInSession(
    ownerType: CodCashOwnerType,
    ownerId: string,
    amount: number,
    currency: string,
    entryType: CodCashLedgerEntryType,
    refType: CodCashLedgerRefType,
    refId: string,
    session: ClientSession
  ): Promise<void> {
    const account = await this.getOrCreate(ownerType, ownerId, currency, session);
    const updated = await CodCashAccountModel.findByIdAndUpdate(
      account._id,
      { $inc: { balance: amount, version: 1 } },
      { new: true, session }
    );
    await this.appendLedger(updated!, entryType, amount, refType, refId, session);
  }

  /**
   * Lower a liability (deposit / remittance confirmed). Guarded: the balance
   * can never go negative — an over-deposit is rejected, forcing the caller
   * to record what was actually outstanding.
   */
  async debitInSession(
    ownerType: CodCashOwnerType,
    ownerId: string,
    amount: number,
    entryType: CodCashLedgerEntryType,
    refType: CodCashLedgerRefType,
    refId: string,
    session: ClientSession
  ): Promise<void> {
    const updated = await CodCashAccountModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: ownerId, balance: { $gte: amount } },
      { $inc: { balance: -amount, version: 1 } },
      { new: true, session }
    );
    if (!updated) {
      throw createAppError(ERROR_CODES.COD_DEPOSIT_EXCEEDS_BALANCE, 422, undefined, {
        ownerType,
        ownerId,
        amount,
      });
    }
    await this.appendLedger(updated, entryType, -amount, refType, refId, session);
  }

  /** Current cash liability balance (0 when no account exists yet). */
  async getBalance(ownerType: CodCashOwnerType, ownerId: string): Promise<{ balance: number; currency: string }> {
    const account = await CodCashAccountModel.findOne({ owner_type: ownerType, owner_id: ownerId });
    return { balance: account?.balance ?? 0, currency: account?.currency ?? 'XAF' };
  }

  /** Paginated append-only cash ledger for one owner. */
  async getLedger(ownerType: CodCashOwnerType, ownerId: string, page: number, limit: number) {
    const filter = { owner_type: ownerType, owner_id: ownerId };
    const [total, docs] = await Promise.all([
      CodCashLedgerModel.countDocuments(filter).exec(),
      CodCashLedgerModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);
    return {
      data: docs.map((e) => ({
        id: e._id.toString(),
        entryType: e.entry_type,
        amount: e.amount,
        balanceAfter: e.balance_after,
        refType: e.ref_type,
        refId: e.ref_id.toString(),
        createdAt: e.created_at,
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  private async getOrCreate(
    ownerType: CodCashOwnerType,
    ownerId: string,
    currency: string,
    session: ClientSession
  ): Promise<ICodCashAccount> {
    const existing = await CodCashAccountModel.findOne({
      owner_type: ownerType,
      owner_id: ownerId,
    }).session(session);
    if (existing) return existing;
    const [created] = await CodCashAccountModel.create(
      [{ owner_type: ownerType, owner_id: ownerId, balance: 0, currency, version: 0 }],
      { session }
    );
    return created;
  }

  private async appendLedger(
    account: ICodCashAccount,
    entryType: CodCashLedgerEntryType,
    amount: number,
    refType: CodCashLedgerRefType,
    refId: string,
    session: ClientSession
  ): Promise<void> {
    await CodCashLedgerModel.create(
      [
        {
          account_id: account._id,
          owner_type: account.owner_type,
          owner_id: account.owner_id,
          entry_type: entryType,
          amount,
          balance_after: account.balance,
          ref_type: refType,
          ref_id: new Types.ObjectId(refId),
        },
      ],
      { session }
    );
  }
}

export const codCashAccountService = new CodCashAccountService();
