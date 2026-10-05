/**
 * WHERE a clawback's money comes from, and how debt is paid back — REFUND-FLOW-PLAN § 6.1.
 *
 * PURE. The repositories apply the same arithmetic atomically (`EarningsAccountRepository`'s
 * pipeline updates); `test:earnings-clawback` asserts these functions and scans the repository
 * for the matching `$min` on `clawback_balance`.
 *
 * ── The take order ───────────────────────────────────────────────────────────────
 *  - a HELD share: its money is still in `pending_balance`, so that is where it comes from;
 *  - a RELEASED share: first its own COD reserve slice if that is still held, then
 *    `available_balance`, and whatever neither covers becomes DEBT (`clawback_balance`);
 *  - money charged to the vendor beyond their shares (`vendorBeyond`): available, then debt.
 *
 * Netting is eager: debt only appears once available is empty, so `clawback_balance > 0`
 * implies `available_balance === 0` — and every later inflow to available pays debt first.
 */

export type ClawedShareStatus = 'held' | 'released';

export interface TakenFrom {
  pending: number;
  reserve: number;
  available: number;
  debt: number;
}

export const NOTHING_TAKEN: TakenFrom = Object.freeze({ pending: 0, reserve: 0, available: 0, debt: 0 });

export function totalTaken(t: TakenFrom): number {
  return t.pending + t.reserve + t.available + t.debt;
}

/**
 * Where a claw of `amount` on one share is taken from.
 *
 * `reserveHeld` is that share's own reserve slice still held (0 when it has none — only COD
 * agency shares carry one); `available` the owner's available balance right now. A held share
 * draws on pending alone — its money is there by construction, so a shortfall is drift and
 * the caller's transaction fails rather than inventing debt.
 */
export function planTake(
  amount: number,
  share: { status: ClawedShareStatus; reserveHeld: number },
  available: number
): TakenFrom {
  if (amount <= 0) return { ...NOTHING_TAKEN };
  if (share.status === 'held') return { pending: amount, reserve: 0, available: 0, debt: 0 };
  const reserve = Math.min(amount, Math.max(0, share.reserveHeld));
  const fromAvailable = Math.min(amount - reserve, Math.max(0, available));
  return { pending: 0, reserve, available: fromAvailable, debt: amount - reserve - fromAvailable };
}

/** Money charged to the owner with no share behind it: available first, then debt. */
export function planBeyond(amount: number, available: number): TakenFrom {
  if (amount <= 0) return { ...NOTHING_TAKEN };
  const fromAvailable = Math.min(amount, Math.max(0, available));
  return { pending: 0, reserve: 0, available: fromAvailable, debt: amount - fromAvailable };
}

/**
 * An inflow of `amount` to available while `debt` is owed: the debt is paid first, the rest
 * reaches available. The atomic form is the `*Netting` pipeline updates in the repository.
 */
export function planRecovery(amount: number, debt: number): { recovered: number; toAvailable: number } {
  const recovered = Math.max(0, Math.min(amount, debt));
  return { recovered, toAvailable: amount - recovered };
}

/** What the release worker moves for a held share: whatever refunds have not taken back. */
export function releasableAmount(row: { amount: number; clawed_amount?: number | null }): number {
  return Math.max(0, row.amount - (row.clawed_amount ?? 0));
}
