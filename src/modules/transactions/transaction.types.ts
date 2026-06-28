/**
 * Unified vendor transaction feed — a single normalized shape over the vendor's
 * heterogeneous money/credit movements (plan purchases, credit top-ups, credit
 * usage, and sales earnings). `payout` is reserved for when cash-out is built.
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
  /** From the vendor's perspective: value coming in vs leaving. */
  direction: 'in' | 'out';
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
