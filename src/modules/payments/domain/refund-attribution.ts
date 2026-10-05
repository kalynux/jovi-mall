/**
 * What a refund is FOR — goods, or delivery money (REFUND-FLOW-PLAN C-1, D-5). Pure; pinned by
 * `test:refund-flow`'s attribution table.
 *
 * The split matters downstream, not to the customer: the earnings recovery (§ 6.2) takes
 * `goods` from the order-source rows (vendor, platform commission, AI fee) and `delivery` from
 * the VENDOR's rows only — the agency and the agent always keep their delivery fee (C-1).
 *
 * ── The rule ──────────────────────────────────────────────────────────────────
 * - **Before delivery** (a cancellation, D-5): the full amount paid, delivery included. The
 *   parcel never travelled — there is no delivery to keep.
 * - **After delivery** (a return, or goodwill / a dispute settlement on a delivered order): the
 *   delivery money comes back ONLY when the vendor's return-shipping setting says so —
 *     `vendor`                        → refunded (charged to the vendor)
 *     `customer`                      → not refunded
 *     `customer_reimbursed_if_defect` → refunded only when the approver ticked "item defective"
 *   No setting at all reads as `customer` — the vendor onboarding default.
 *
 * ── A partial amount ──────────────────────────────────────────────────────────
 * Goods first, then delivery. A refund of 3000 on 5000 goods + 1000 refundable delivery is
 * `{ goods: 3000, delivery: 0 }`; one of 5500 is `{ goods: 5000, delivery: 500 }`. So
 * `goods + delivery === amount` always, and delivery money is only ever counted once the
 * goods are fully returned — the reading that recovers the vendor's own rows last.
 */

export type RefundReasonKind = 'cancellation' | 'return' | 'goodwill' | 'dispute_settlement';
export const REFUND_REASON_KINDS: readonly RefundReasonKind[] = Object.freeze([
  'cancellation',
  'return',
  'goodwill',
  'dispute_settlement',
] as RefundReasonKind[]);

export type ReturnShippingPayer = 'vendor' | 'customer' | 'customer_reimbursed_if_defect';

export interface RefundAttribution {
  goods: number;
  delivery: number;
}

export interface AttributionInput {
  reasonKind: RefundReasonKind;
  /** The vendor's `return_policy.return_shipping_payer`, or null when unset. */
  returnShippingPayer: ReturnShippingPayer | null;
  /** The approver's tick; only read under `customer_reimbursed_if_defect`. */
  itemDefective: boolean | null;
  /** The goods part of what the customer paid (items, after discount and tax). */
  goodsAmount: number;
  /** Delivery money the CUSTOMER paid (0 when the vendor paid delivery). */
  deliveryAmountPaid: number;
  /** Has the order been delivered? A `return` implies yes whatever this says. */
  delivered: boolean;
}

const nonNeg = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);

/** Whether the customer's delivery money is part of what may be refunded. */
export function deliveryRefundable(input: Omit<AttributionInput, 'goodsAmount' | 'deliveryAmountPaid'>): boolean {
  const afterDelivery = input.reasonKind === 'return' || (input.reasonKind !== 'cancellation' && input.delivered);
  if (!afterDelivery) return true; // D-5: a cancellation returns everything paid
  switch (input.returnShippingPayer) {
    case 'vendor':
      return true;
    case 'customer_reimbursed_if_defect':
      return input.itemDefective === true;
    case 'customer':
    default:
      return false;
  }
}

/** The most this attribution allows: all goods, plus delivery when it is refundable. */
export function maxAttributable(input: AttributionInput): number {
  return nonNeg(input.goodsAmount) + (deliveryRefundable(input) ? nonNeg(input.deliveryAmountPaid) : 0);
}

/**
 * Attribute `amount` (default: the maximum). Returns null when `amount` exceeds what the rule
 * allows — the caller answers `REFUND_AMOUNT_EXCEEDS_MAX`.
 */
export function attributeRefund(input: AttributionInput, amount?: number): RefundAttribution | null {
  const max = maxAttributable(input);
  const want = amount === undefined ? max : nonNeg(amount);
  if (want > max) return null;
  const goods = Math.min(want, nonNeg(input.goodsAmount));
  return { goods, delivery: want - goods };
}
