import { ClientSession } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CreditWalletRepository } from '../repositories/credit-wallet.repository';
import { CreditTransactionRepository } from '../repositories/credit-transaction.repository';
import { ICreditWallet, WalletOwnerType } from '../models/credit-wallet.model';
import { CreditTransactionType, CreditReasonCode } from '../models/credit-transaction.model';
import { publishWalletCredited } from '../domain/wallet-credited.event';
import { debtToWriteOff } from '../domain/wallet-debt';

/**
 * CreditWalletService - the single entry point for moving credits.
 *
 * Every mutation writes the wallet balance and a ledger row inside ONE
 * transaction, so balance and history can never diverge. Debits are guarded by
 * an atomic conditional update (see repository) and throw
 * `BILLING_INSUFFICIENT_CREDITS` when the balance can't cover the amount.
 *
 * ── A balance may be negative (SERVICE-LISTINGS-PLAN L-10, L-11) ─────────────
 * Only through `debitAllowingDebtInSession` (a provider's grace reveal). A credit is plain
 * arithmetic on whatever the balance is, so a top-up or a plan allowance PAYS THE DEBT FIRST
 * (−30 + 100 = 70) — nothing here clamps a credit, and nothing may.
 *
 * ── Every credit publishes `billing.wallet.credited` (§ C-5) ──────────────────
 * `credit()` publishes itself, after its own commit. `creditInSession()` cannot — the caller owns
 * the transaction, so the caller publishes after IT commits (`publishWalletCredited`).
 * `test:service-listings-billing` enumerates every caller of both.
 */
export class CreditWalletService {
  constructor(
    private readonly walletRepo: CreditWalletRepository = new CreditWalletRepository(),
    private readonly ledgerRepo: CreditTransactionRepository = new CreditTransactionRepository()
  ) {}

  /**
   * Credit the wallet within an EXISTING transaction (caller owns the session).
   *
   * ⚠ The caller must `publishWalletCredited(<the returned wallet>, reasonCode)` after its
   * transaction commits — never inside it — for any POSITIVE amount.
   */
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

  /** Credit the wallet in its own transaction (e.g. a refund), then publish the nudge. */
  async credit(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    type: CreditTransactionType,
    reasonCode: CreditReasonCode,
    ref: string | null = null
  ): Promise<ICreditWallet> {
    const updated = await transactionManager.runInTransaction((session) =>
      this.creditInSession(ownerType, ownerId, amount, type, reasonCode, ref, session)
    );
    // Post-commit (§ C-5). A non-positive "credit" moved nothing up and resumes nothing.
    if (amount > 0) publishWalletCredited(updated, reasonCode);
    return updated;
  }

  /**
   * Debit the wallet within an EXISTING transaction — the ordinary `debitIfSufficient` path,
   * for a caller that must debit and write its own rows atomically (a listing reveal). Throws
   * `BILLING_INSUFFICIENT_CREDITS` (402) when the balance is too low — always, while it is
   * negative.
   */
  async debitInSession(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    reasonCode: CreditReasonCode,
    ref: string | null,
    session: ClientSession
  ): Promise<ICreditWallet> {
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
    await this.writeDebitRow(wallet, updated, amount, reasonCode, ref, session);
    return updated;
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
    return transactionManager.runInTransaction((session) =>
      this.debitInSession(ownerType, ownerId, amount, reasonCode, ref, session)
    );
  }

  /**
   * The ONE debit that may take a balance below zero (L-10, L-11): a provider's grace reveal,
   * inside the reveal's own transaction. Succeeds only while `balance - amount >= floor`
   * (`floor: null` = no floor). Returns the updated wallet, or `null` at the floor — the caller
   * decides what that means (`LISTING_UNREACHABLE`); nothing is written.
   *
   * ⛔ **One caller: `ListingRevealService`.** `test:service-listings-billing` fails on a second.
   */
  async debitAllowingDebtInSession(
    ownerType: WalletOwnerType,
    ownerId: string,
    amount: number,
    floor: number | null,
    reasonCode: CreditReasonCode,
    ref: string | null,
    session: ClientSession
  ): Promise<ICreditWallet | null> {
    const wallet = await this.walletRepo.getOrCreate(ownerType, ownerId, session);
    const updated = await this.walletRepo.debitAllowingDebt(wallet._id, amount, floor, session);
    if (!updated) return null;
    await this.writeDebitRow(wallet, updated, amount, reasonCode, ref, session);
    return updated;
  }

  /**
   * L-12: write a closing role's credit DEBT off, inside the closure's transaction. Brings a
   * negative balance to exactly 0 with one `adjustment` ledger row (`credit_debt_written_off`,
   * `ref` = the closure request id) and returns the credits written off; 0 — and nothing
   * written — when the balance is not negative or there is no wallet. Wi-Mall absorbs the debt.
   *
   * Deliberately publishes NO `billing.wallet.credited`: the role is closing, and its listings
   * are archived in the same transaction — there is nothing for the nudge to resume.
   */
  async writeOffDebtInSession(
    ownerType: WalletOwnerType,
    ownerId: string,
    ref: string,
    session: ClientSession
  ): Promise<number> {
    const wallet = await this.walletRepo.findByOwner(ownerType, ownerId, session);
    if (!wallet || debtToWriteOff(wallet.balance) === 0) return 0;
    const before = await this.walletRepo.zeroNegativeBalance(wallet._id, session);
    const debt = before ? debtToWriteOff(before.balance) : 0;
    if (debt === 0) return 0;
    await this.ledgerRepo.create(
      {
        wallet_id: wallet._id,
        owner_type: ownerType,
        owner_id: wallet.owner_id,
        type: 'adjustment',
        amount: debt,
        balance_after: 0,
        reason_code: 'credit_debt_written_off',
        ref,
      },
      session
    );
    return debt;
  }

  /** Current balance for an owner (creates an empty wallet on first read). May be negative. */
  async getBalance(ownerType: WalletOwnerType, ownerId: string): Promise<number> {
    const wallet = await this.walletRepo.getOrCreate(ownerType, ownerId);
    return wallet.balance;
  }

  private async writeDebitRow(
    wallet: ICreditWallet,
    updated: ICreditWallet,
    amount: number,
    reasonCode: CreditReasonCode,
    ref: string | null,
    session: ClientSession
  ): Promise<void> {
    await this.ledgerRepo.create(
      {
        wallet_id: wallet._id,
        owner_type: wallet.owner_type,
        owner_id: wallet.owner_id,
        type: 'debit',
        amount: -amount,
        balance_after: updated.balance,
        reason_code: reasonCode,
        ref,
      },
      session
    );
  }
}

export const creditWalletService = new CreditWalletService();
