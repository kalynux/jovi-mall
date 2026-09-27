/**
 * Unified vendor transaction feed — a single normalized shape over the vendor's
 * heterogeneous money/credit movements (plan purchases, credit top-ups, credit
 * usage, earnings, and payouts). `payout` rows are served since 2026-09-27 — before that the
 * category existed and always answered empty, although payouts were live.
 */

export type TransactionCategory = 'plan' | 'credit' | 'earning' | 'payout';

export const TRANSACTION_CATEGORIES: ReadonlyArray<TransactionCategory> = [
  'plan',
  'credit',
  'earning',
  'payout',
];

export interface VendorTransaction {
  /** Source document id. */
  id: string;
  category: TransactionCategory;
  /**
   * Fine-grained type, e.g. `plan_purchase`, `credit_topup`, `credit_allowance`,
   * `credit_usage`, `credit_adjustment`, `earning_hold`, `earning_release`,
   * `earning_reversal`.
   */
  type: string;
  /** Source-specific status (e.g. paid/pending/failed/reversed, held/released, completed). */
  status: string;
  /** `money` rows carry `currency`; `credit` rows carry credit units. */
  unit: 'money' | 'credit';
  /**
   * From the owner's perspective: value coming in, leaving, or `internal` — moving between the
   * owner's own balances (escrow → available on a release; available ↔ COD reserve; available →
   * requested while a payout is pending). ⚠ Added 2026-09-27. Before it, a hold and its release
   * were both `in`, so every earning counted TWICE in any sum. Rule now: Σ in − Σ out over the
   * `earning` and `payout` rows equals the change in the owner's total earnings balance.
   */
  direction: 'in' | 'out' | 'internal';
  /** Magnitude in `unit` (always positive; use `direction` for sign). */
  amount: number;
  currency?: string;
  /** Credits granted (top-up) or the magnitude of a credit-unit movement. */
  credits?: number;
  description: string;
  gateway?: string;
  source?: { type: string; id: string };
  createdAt: Date;
}
