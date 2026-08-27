/**
 * Turning a code a person TYPED into the SKU a vendor STORED (GAP-003).
 *
 * Pure and query-free, deliberately: this is the whole of the judgement in
 * `GET /api/public/variants/by-sku/:sku`, and it is the part most likely to be got wrong —
 * so it is extracted where `test:public-catalog` can drive it with no database, the same
 * reason `public-catalog.filter.ts` and the availability window helpers sit here.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * `ProductVariant.sku` carries a **unique, case-SENSITIVE** index and no normalisation on
 * write — a SKU is whatever the vendor typed. The customer, meanwhile, is reading a code off
 * a package into a phone keyboard that capitalises the first letter of a message. Those two
 * facts do not meet on their own.
 *
 * ── WHY NOT A CASE-INSENSITIVE MATCH ────────────────────────────────────────
 * `{ $regex: ..., $options: 'i' }` and a `strength: 2` collation both stop the query using
 * that unique index, because the index has no collation of its own. On a world-readable,
 * unauthenticated route that turns **every miss into a collection scan** — and a miss is the
 * common case for a mistyped code. Three exact values in an `$in` stay a point lookup.
 */

/**
 * The spellings worth trying, most-faithful first.
 *
 * At most three, deduplicated, and always led by what the customer actually typed. Uppercase
 * before lowercase because SKUs are conventionally upper (`DRESS-WAX-M`), so on a two-way tie
 * that ordering is the likelier hit — though `pickSkuMatch` is what decides a real collision,
 * not this order.
 */
export function skuCandidates(typed: string): string[] {
    const trimmed = typed.trim();
    if (!trimmed) return [];
    return [...new Set([trimmed, trimmed.toUpperCase(), trimmed.toLowerCase()])];
}

/**
 * Which row answers, when more than one spelling exists.
 *
 * ⚠ **The as-typed spelling wins.** `abc` and `ABC` are two different SKUs to a case-sensitive
 * unique index, so a catalogue really can hold both — and the only defensible answer is the
 * one the customer typed. Stating it here rather than relying on the order a pipeline happened
 * to return is the difference between a rule and an accident.
 *
 * Falls back to the first row so a lone case-variant still resolves, which is the entire point
 * of trying more than one spelling.
 */
export function pickSkuMatch<T extends { sku: string }>(rows: readonly T[], typed: string): T | null {
    if (rows.length === 0) return null;
    const trimmed = typed.trim();
    return rows.find((row) => row.sku === trimmed) ?? rows[0];
}
