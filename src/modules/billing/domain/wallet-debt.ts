/**
 * The credit wallet's debt rules (SERVICE-LISTINGS-PLAN L-10, L-11, L-12) — pure, so the
 * DB-free suite can drive every boundary.
 *
 * A wallet may go NEGATIVE on exactly one path: a provider's grace reveal (a customer already
 * engaged on a listing that ran out of credits), through `debitAllowingDebt`. Every other debit
 * — indexing, templates, AI copy, a listing's submission, an ordinary reveal — goes through
 * `debitIfSufficient`, whose `balance >= amount` filter refuses anything a balance cannot cover,
 * and therefore refuses EVERY debit while the balance is negative. That filter, not the schema,
 * is what keeps sellers, agencies and agents at or above zero now.
 */

/**
 * Would debiting `amount` leave the balance at or above `floor`? `floor: null` means no floor
 * (L-11's default): the debit always succeeds. The floor is the vendor's `debt_floor`, ≤ 0.
 *
 * Inclusive: a balance landing EXACTLY on the floor is allowed — "you may go down to −50" means
 * −50 is reachable.
 */
export function wouldStayAboveFloor(balance: number, amount: number, floor: number | null): boolean {
  if (floor === null) return true;
  return balance - amount >= floor;
}

/**
 * The Mongo filter that makes `wouldStayAboveFloor` atomic: `balance - amount >= floor` is
 * `balance >= floor + amount`, which a conditional `$inc` can test in the same write. `null` adds
 * no condition at all. Exported so the suite can pin it against the pure rule.
 */
export function debtFloorFilter(amount: number, floor: number | null): Record<string, unknown> {
  return floor === null ? {} : { balance: { $gte: floor + amount } };
}

/**
 * L-12: the credits written off when a role closes in debt — the debt as a POSITIVE number, or 0
 * when there is none. The write-off brings the balance to exactly 0; a positive balance is
 * forfeited, never written off (that is `credit_balance_forfeited`, a warning, not a ledger row).
 */
export function debtToWriteOff(balance: number): number {
  return balance < 0 ? -balance : 0;
}
