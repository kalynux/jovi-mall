/**
 * Who gives back what when a refund lands — REFUND-FLOW-PLAN § 6.2, contract § 11.3.
 *
 * PURE: integers in, integers out, no I/O and no clock. `test:earnings-clawback` drives it.
 * The I/O half (which rows are in scope, where each claw is taken from) is
 * `services/earnings-clawback.service.ts`; WHERE the money comes from is `clawback-netting.ts`.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────
 *  - `goods` is spread PRO RATA over the in-scope rows' ORIGINAL amounts (C-2): the vendor, the
 *    platform commission and the AI bargain fee give back in proportion to what each was given.
 *  - `delivery` (money the customer gets back for delivery under C-1) is spread over the
 *    VENDOR's rows only. Agency and agent rows are never in scope (C-1, C-3).
 *  - Each row gives at most what it still has (`remaining = amount − clawed_amount`).
 *
 * ── Partial refunds add up to the full refund, EXACTLY ──────────────────────────────
 * Each refund is computed CUMULATIVELY: `target(prior + this) − target(prior)`, where `prior` is
 * what earlier refunds of the same scope were worth. The targets telescope, so two refunds of
 * 3000 and 7000 take from every row exactly what one refund of 10000 would have.
 *
 * ── Why not plain largest-remainder (the plan's wording) ───────────────────────────
 * Largest-remainder rounding sums exactly but is not MONOTONE in the total (the "Alabama
 * paradox"): raising the total by one can LOWER a row's share, so cumulatively a later partial
 * refund would hand a row money back. The integers are apportioned instead by HIGHEST AVERAGES
 * (D'Hondt): the C units go to the C largest quotients `amount / k`, ties to the earlier row.
 * That is a prefix of one fixed ordering, so it is monotone by construction; it sums exactly;
 * every row gets at least `floor` of its exact share (lower quota), and at the full total every
 * row gets exactly its amount. The rounding units lean to the LARGER row — the vendor's, in
 * practice — never to a 1-XAF platform share.
 *
 * ── Beyond the rows ────────────────────────────────────────────────────────────────
 * Everything turns on `deliverySpent`: was the order's delivery money ever DIVIDED — to the
 * courier (agency/agent rows) or back to the vendor (an RTO leftover row)?
 *  - DELIVERY spent: delivery beyond what the vendor's rows have left is still the vendor's
 *    (C-1: "charged to the vendor") → `vendorBeyond`, taken from available and then owed as debt.
 *  - DELIVERY never spent (a cancellation before the parcel travelled): nobody was given that
 *    money — the platform still holds it unallocated, so it is returned from there →
 *    `unrecovered`, and NO vendor row or vendor balance is touched for it (review finding 1).
 *  - A VENDOR row's goods share it can no longer cover (spent by an earlier delivery claw) is
 *    the vendor's too → `vendorBeyond`.
 *  - GOODS beyond the rows' original total (the gap is the vendor-borne delivery fee the
 *    vendor's net was reduced by):
 *      · delivery spent → the VENDOR's (`vendorBeyond`). C-8 (owner, 2026-10-05): on a refund
 *        after delivery/return of a vendor-paid delivery, the vendor absorbs the delivery cost
 *        already paid to the courier — the platform does not;
 *      · delivery never spent → `unrecovered`: the platform still holds that money unallocated.
 *  - A platform row that cannot cover its share is `unrecovered`: the platform absorbs it.
 */

/** One in-scope allocation, as the plan sees it. */
export interface ClawPlanRow {
  id: string;
  /** `vendor` rows take delivery claws; the rest are the platform's. */
  isVendor: boolean;
  /** The split's ORIGINAL amount — the pro-rata weight. Never the remainder. */
  amount: number;
  /** `amount − clawed_amount` (0 for a reversed row). The most this row can still give. */
  remaining: number;
}

export interface ClawPlanInput {
  rows: ClawPlanRow[];
  goods: number;
  delivery: number;
  /** What earlier refunds of this scope were worth (their attributions, summed). */
  priorGoods: number;
  priorDelivery: number;
  /**
   * Was the delivery money divided to anyone (a `shipment`-source row, or an agency/agent row on
   * the order or its COD collections)? REQUIRED, so no caller can forget to decide: false sends
   * the delivery part and the goods gap to `unrecovered` (the platform returns money it holds
   * unallocated); true charges both to the vendor (C-1, C-8).
   */
  deliverySpent: boolean;
}

export interface ClawPlanLine {
  id: string;
  goods: number;
  delivery: number;
  /** goods + delivery: what this row gives back now (≤ its remaining). */
  total: number;
}

export interface ClawPlan {
  lines: ClawPlanLine[];
  /** Charged to the vendor beyond their rows: taken from available, then debt. */
  vendorBeyond: { goods: number; delivery: number; total: number };
  /**
   * What nobody gives back: money the split never allocated (an unspent delivery — the platform
   * still holds it), or a platform share already gone. The platform bears it.
   */
  unrecovered: number;
}

function assertWhole(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer (got ${n})`);
}

/** `floor(a × b / c)` without leaving the safe-integer range (amounts × amounts can exceed 2^53). */
function mulDivFloor(a: number, b: number, c: number): number {
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/**
 * The cumulative share of each weight when `total` has been spread over them: D'Hondt
 * (highest averages). Exact sum (`min(total, Σweights)`), MONOTONE in `total`, never above a
 * weight. Exported for the test.
 *
 * Fast form: D'Hondt satisfies lower quota, so every row's share is at least
 * `floor(C × w / W)`; starting there leaves fewer units than rows, each given to the row with
 * the largest next quotient `w / (share + 1)` (exact cross-multiplication; ties → earlier row).
 * That selects exactly the C largest quotients — the same answer as handing out C units one by
 * one — without walking millions of XAF.
 */
export function cumulativeShares(total: number, weights: number[]): number[] {
  assertWhole('total', total);
  weights.forEach((w, i) => assertWhole(`weight[${i}]`, w));
  const W = weights.reduce((s, w) => s + w, 0);
  if (W === 0 || weights.length === 0) return weights.map(() => 0);
  const C = Math.min(total, W);
  const shares = weights.map((w) => mulDivFloor(C, w, W));
  let left = C - shares.reduce((s, x) => s + x, 0);
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] === 0) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      // w_i / (s_i + 1) > w_best / (s_best + 1), exactly.
      const lhs = BigInt(weights[i]) * BigInt(shares[best] + 1);
      const rhs = BigInt(weights[best]) * BigInt(shares[i] + 1);
      if (lhs > rhs) best = i;
    }
    shares[best] += 1;
    left -= 1;
  }
  return shares;
}

/**
 * The INCREMENT this refund adds to each weight's cumulative share. Never negative; sums to
 * `min(prior + amount, W) − min(prior, W)` exactly. Exported for the test.
 */
export function incrementalShares(prior: number, amount: number, weights: number[]): number[] {
  const before = cumulativeShares(prior, weights);
  const after = cumulativeShares(prior + amount, weights);
  // Never negative: `cumulativeShares` is monotone in its total.
  return after.map((x, i) => x - before[i]);
}

/** Who gives back what for one refund. */
export function planClawback(input: ClawPlanInput): ClawPlan {
  assertWhole('goods', input.goods);
  assertWhole('delivery', input.delivery);
  assertWhole('priorGoods', input.priorGoods);
  assertWhole('priorDelivery', input.priorDelivery);
  input.rows.forEach((r) => {
    assertWhole(`amount of ${r.id}`, r.amount);
    assertWhole(`remaining of ${r.id}`, r.remaining);
  });

  const rows = input.rows;
  const left = rows.map((r) => Math.min(r.remaining, r.amount));
  const lines: ClawPlanLine[] = rows.map((r) => ({ id: r.id, goods: 0, delivery: 0, total: 0 }));
  let vendorBeyondGoods = 0;
  let vendorBeyondDelivery = 0;
  let unrecovered = 0;

  // ── Goods: every in-scope row, by its original amount ─────────────────────────────
  if (input.goods > 0) {
    const weights = rows.map((r) => r.amount);
    const shares = rows.length ? incrementalShares(input.priorGoods, input.goods, weights) : [];
    const allocated = shares.reduce((s, x) => s + x, 0);
    // Beyond the rows' original total (only reachable when goods exceed what was allocated):
    // the vendor-borne delivery fee. Spent on a courier → the vendor's (C-8); never spent → the
    // platform still holds it.
    if (input.deliverySpent) vendorBeyondGoods += input.goods - allocated;
    else unrecovered += input.goods - allocated;
    shares.forEach((share, i) => {
      const take = Math.min(share, left[i]);
      left[i] -= take;
      lines[i].goods += take;
      const short = share - take;
      if (short > 0) {
        if (rows[i].isVendor) vendorBeyondGoods += short;
        else unrecovered += short;
      }
    });
  }

  // ── Delivery never divided (finding 1): the platform returns money it still holds ─────
  if (input.delivery > 0 && !input.deliverySpent) {
    unrecovered += input.delivery;
  }

  // ── Delivery: the vendor's rows only; anything they cannot cover is still the vendor's ──
  if (input.delivery > 0 && input.deliverySpent) {
    const vendorIdx = rows.map((r, i) => (r.isVendor ? i : -1)).filter((i) => i >= 0);
    const weights = vendorIdx.map((i) => rows[i].amount);
    const shares = vendorIdx.length
      ? incrementalShares(input.priorDelivery, input.delivery, weights)
      : [];
    const allocated = shares.reduce((s, x) => s + x, 0);
    vendorBeyondDelivery += input.delivery - allocated;
    shares.forEach((share, k) => {
      const i = vendorIdx[k];
      const take = Math.min(share, left[i]);
      left[i] -= take;
      lines[i].delivery += take;
      vendorBeyondDelivery += share - take;
    });
  }

  for (const line of lines) line.total = line.goods + line.delivery;
  return {
    lines: lines.filter((l) => l.total > 0),
    vendorBeyond: {
      goods: vendorBeyondGoods,
      delivery: vendorBeyondDelivery,
      total: vendorBeyondGoods + vendorBeyondDelivery,
    },
    unrecovered,
  };
}

/** Dispute lost (`reverseRemaining`): every in-scope row gives back everything it still has. */
export function planRemaining(rows: ClawPlanRow[]): ClawPlanLine[] {
  return rows
    .map((r) => {
      const total = Math.min(r.remaining, r.amount);
      return { id: r.id, goods: total, delivery: 0, total };
    })
    .filter((l) => l.total > 0);
}
