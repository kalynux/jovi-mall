/**
 * Money helpers shared by every gateway.
 *
 * These lived in `stripe.client.ts` while Stripe was the only real gateway.
 * They moved here when the mobile-money gateways became real, because both of
 * them need to *assert* the zero-decimal property that Stripe merely used to
 * convert: NotchPay documents its `amount` as "the smallest currency unit" and
 * My-CoolPay's `transaction_amount` is a plain number, so sending 4500000 for
 * a 45 000 XAF order — the mistake a minor-unit habit produces — charges a
 * customer a hundred times the price and the provider accepts it.
 *
 * `stripe.client.ts` imports from here; it is not a second copy.
 */

/**
 * Currencies with no minor unit: the `amount` is the value itself, with no
 * multiplication by 100. (Subset of https://stripe.com/docs/currencies)
 *
 * XAF — the platform's currency — is one of them, which is why every amount in
 * this codebase is a plain whole number and no `cents` field exists anywhere.
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set<string>([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** True when the currency has no minor unit. */
export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has((currency || '').toLowerCase());
}

/** Convert a major-unit amount to the gateway's minor unit for the given currency. */
export function toMinorUnit(amount: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) return Math.round(amount);
  return Math.round(amount * 100);
}

/** Convert a gateway minor-unit amount back to its major unit. */
export function fromMinorUnit(amount: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) return amount;
  return amount / 100;
}

/**
 * Compare two money amounts for equality.
 *
 * Used by the webhook money cross-check, where the two sides come from
 * different places: ours from `amountSnapshot` (a whole XAF integer) and
 * theirs from a JSON body that may arrive as a string or carry a `.00`. An
 * exact `===` would report a mismatch on `"4500"` vs `4500` and refuse a
 * genuine callback, which is the wrong failure direction for a payment that
 * really did settle.
 */
export function amountsEqual(a: number | string, b: number | string): boolean {
  const left = typeof a === 'number' ? a : Number(a);
  const right = typeof b === 'number' ? b : Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  // Tolerance of half a minor unit: enough to absorb a float round-trip,
  // far too small to absorb a wrong amount.
  return Math.abs(left - right) < 0.005;
}

/** Case-insensitive currency comparison. Absent on either side is NOT a match. */
export function currenciesEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}
