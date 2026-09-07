import { EARNINGS_CONFIG } from '../config/earnings.config';

/**
 * The platform's AI margin on a negotiated line — the pure half.
 *
 * Extracted onto its own module for the same reason `EarningsQuoteService` was:
 * `EarningsSplitService` reaches Mongo, the transaction manager and the event
 * bus, so arithmetic living inside it cannot be tested without a database. Every
 * function here is pure and takes plain numbers — `test:negotiation-pricing`
 * runs the real code with no connection.
 *
 * ── What it computes (BARGAINING-AGENT-PLAN D-5) ─────────────────────────────
 *
 *   U          = (P − floor) × qty          the uplift the bargaining agent won
 *   aiMargin   = floor(0.30 × U)            the platform's share of it
 *   vendorGross= (P × qty) − aiMargin       what commission and delivery come off
 *
 * ⚠ **`vendorGross` is `P×qty − aiMargin`, NEVER `floor×qty + 0.7×U`.** The two
 * are equal only when `0.30 × U` is a whole number and differ by a franc
 * otherwise, and only the first reconciles exactly — it is defined as the
 * complement of what was actually allocated, so `aiMargin + vendorGross === gross`
 * is true by construction rather than by the rounding happening to agree. The
 * second form is the intuitive one and it is the trap; see the test's § 2.
 *
 * ── The quantity is the CALLER'S, and the two split paths disagree ───────────
 *
 * `splitOrder` passes the order item's own `quantity` — it splits the whole
 * order. `splitCodCollection` passes the SHIPMENT item's quantity, because its
 * gross is `collection.expected_amount`, which is one shipment's slice
 * (`Σ orderItem.price × shipmentItem.quantity`) and an order item can be split
 * across shipments. Passing the order quantity there would allocate the whole
 * order's margin once per collection and could drive `vendorNet` negative.
 */

/** One line's contribution, as the split paths see it. */
export interface NegotiatedLineInput {
  /** The agreed unit price, P. */
  unitPrice: number;
  /**
   * The vendor's floor as of the verdict that honoured the lock, NOT re-read
   * now. `null`/`undefined` means the line was never negotiated.
   */
  floorPrice?: number | null;
  /** The quantity being split — see the note above on which one. */
  quantity: number;
}

/** What one negotiated line yields. Every field is minor units. */
export interface NegotiatedLineSplit {
  /** `P × qty` — what the customer paid for this line. */
  lineGross: number;
  /** `(P − floor) × qty` — the uplift bargaining won. Zero on an un-negotiated line. */
  uplift: number;
  /** `floor(AI_MARGIN_PERCENT% × uplift)` — the platform's share. */
  aiMargin: number;
  /** `lineGross − aiMargin` — the base commission and delivery come off. */
  vendorGross: number;
}

/**
 * The platform's share of one uplift.
 *
 * Floored, so a rounding franc always favours the vendor rather than the
 * platform — the same direction every other fee in this service rounds
 * (`computeCodHandlingFee`, `applyFeeSplit`, the commission).
 *
 * A non-positive uplift yields 0 rather than a negative margin. That is not
 * defensive noise: `P === floor` is a perfectly ordinary outcome (the agent
 * conceded the whole window), and `P < floor` should be impossible — the gate
 * refuses it and `PriceResolverService` re-checks at consume time — so if one
 * ever arrives, the answer is to take nothing, not to hand the vendor a bill.
 */
export function computeAiMargin(uplift: number): number {
  if (!Number.isFinite(uplift) || uplift <= 0) return 0;
  return Math.floor((uplift * EARNINGS_CONFIG.AI_MARGIN_PERCENT) / 100);
}

/**
 * One line's whole split. An un-negotiated line (no floor) yields zero uplift
 * and zero margin, so a caller may run every line through this unconditionally.
 */
export function computeNegotiatedLineSplit(line: NegotiatedLineInput): NegotiatedLineSplit {
  const quantity = Math.max(0, line.quantity);
  const lineGross = line.unitPrice * quantity;

  const negotiated = line.floorPrice !== null && line.floorPrice !== undefined;
  const uplift = negotiated ? Math.max(0, (line.unitPrice - line.floorPrice!) * quantity) : 0;
  const aiMargin = computeAiMargin(uplift);

  return { lineGross, uplift, aiMargin, vendorGross: lineGross - aiMargin };
}

/**
 * The order-level margin: the SUM of the per-line margins, never a margin on the
 * summed uplift.
 *
 * An order can mix negotiated and un-negotiated lines, and the two forms are not
 * equal — `floor(a) + floor(b) ≤ floor(a + b)` — so summing first would allocate
 * a franc nobody's line produced and leave the reconciliation a franc short.
 */
export function computeOrderAiMargin(lines: NegotiatedLineInput[]): number {
  return lines.reduce((sum, line) => sum + computeNegotiatedLineSplit(line).aiMargin, 0);
}

/**
 * The floor the whole set of lines guarantees the vendor — `Σ floor × qty`,
 * where an un-negotiated line's floor is its own price (nothing was conceded on
 * it, so its full gross is the vendor's).
 *
 * This is invariant 1's right-hand side, and it is exported because the invariant
 * is worth ASSERTING rather than trusting to the algebra above: `vendorGross`
 * flooring is where an off-by-one would hide.
 */
export function computeVendorFloorTotal(lines: NegotiatedLineInput[]): number {
  return lines.reduce((sum, line) => {
    const quantity = Math.max(0, line.quantity);
    const floor = line.floorPrice ?? line.unitPrice;
    return sum + floor * quantity;
  }, 0);
}
