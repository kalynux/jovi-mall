/**
 * Why money was taken from (or given to) somebody — the sentence a vendor, an agency or an agent
 * reads next to every movement a refund, a dispute or a damage claim makes (owner objective,
 * 2026-10-22: "clearly explain the customer why he is getting less, explain the agency why
 * their cash was refunded"). Pure; pinned by `test:refund-fees`.
 *
 * Each explanation is stored three ways on the `earnings_adjustments` row (or the claim):
 *  - `reason_code`   a closed vocabulary a screen can switch on;
 *  - `reason_params` the numbers and dates the sentence uses, so a screen can render its own
 *                    language (French) from the code without parsing English;
 *  - `explanation`   the English sentence, ready to show.
 */

export const ADJUSTMENT_REASON_CODES = [
  /** A refund took back this share of the sale (goods or delivery money). */
  'refund_share',
  /** A refund charged the vendor beyond their share: delivery money, courier cost, seller fees. */
  'refund_beyond_share',
  /** The delivery was at fault, inside the agency's window: its fee for the parcel went back. */
  'refund_delivery_fault',
  /** A lost card dispute took back this share. */
  'dispute_share',
  /** A lost card dispute charged the vendor the pay-in fee as well. */
  'dispute_payin_fee',
  /** A damage claim charged the agency for a parcel. */
  'damage_claim',
] as const;
export type AdjustmentReasonCode = (typeof ADJUSTMENT_REASON_CODES)[number];

export interface Explanation {
  reason_code: AdjustmentReasonCode;
  reason_params: Record<string, string | number | boolean | null>;
  explanation: string;
}

const money = (n: number, currency: string) => `${Math.round(n).toLocaleString('en-US')} ${currency}`;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'an unknown date');
const order = (n: string | null | undefined) => (n ? `order ${n}` : 'this order');
const parcel = (t: string | null | undefined) => (t ? `parcel ${t}` : 'this parcel');

export function explainRefundShare(p: { orderNumber: string | null; amount: number; currency: string; dispute?: boolean }): Explanation {
  return {
    reason_code: p.dispute ? 'dispute_share' : 'refund_share',
    reason_params: { orderNumber: p.orderNumber, amount: p.amount, currency: p.currency },
    explanation: p.dispute
      ? `The customer won a card dispute on ${order(p.orderNumber)}: ${money(p.amount, p.currency)} of your share was taken back.`
      : `The customer was refunded on ${order(p.orderNumber)}: ${money(p.amount, p.currency)} of your share was returned.`,
  };
}

/** The vendor's charge beyond their shares, with every part named. */
export function explainVendorBeyond(p: {
  orderNumber: string | null;
  currency: string;
  /** Delivery money refunded under the vendor's return-shipping setting, beyond their rows. */
  delivery: number;
  /** The courier cost of a free (vendor-paid) delivery, or a share the vendor's rows no longer had. */
  goods: number;
  /** Seller-cancel fees (payment + transfer) or a lost dispute's pay-in fee. */
  fees: number;
  feesReason: 'seller_cancelled' | 'dispute_lost' | null;
}): Explanation {
  const parts: string[] = [];
  if (p.goods > 0) parts.push(`${money(p.goods, p.currency)} of the sale your share no longer covered (including the courier cost of a free delivery)`);
  if (p.delivery > 0) parts.push(`${money(p.delivery, p.currency)} of delivery money refunded under your return-shipping setting`);
  if (p.fees > 0) {
    parts.push(
      p.feesReason === 'dispute_lost'
        ? `${money(p.fees, p.currency)}: the 2% payment fee the provider kept on the disputed payment`
        : `${money(p.fees, p.currency)} of payment and transfer fees, because the order was cancelled by you after the customer paid`
    );
  }
  return {
    reason_code: p.feesReason === 'dispute_lost' ? 'dispute_payin_fee' : 'refund_beyond_share',
    reason_params: {
      orderNumber: p.orderNumber,
      currency: p.currency,
      goods: p.goods,
      delivery: p.delivery,
      fees: p.fees,
      feesReason: p.feesReason,
    },
    explanation: `Charged on ${order(p.orderNumber)}, beyond your share of the sale: ${parts.join('; ') || 'nothing'}.`,
  };
}

/** An agency's or rider's delivery fee returned because the delivery was at fault, inside the window. */
export function explainDeliveryFault(p: {
  orderNumber: string | null;
  trackingNumber: string | null;
  amount: number;
  currency: string;
  raisedAt: Date;
  deliveredAt: Date | null;
  windowDays: number;
  claimDeadlineDays: number | null;
  returnsPaidByAgency: boolean;
  role: 'agency' | 'agent';
}): Explanation {
  const terms = [
    p.claimDeadlineDays !== null ? `a ${p.claimDeadlineDays}-day damage-claim deadline` : null,
    p.returnsPaidByAgency ? 'returns paid by the agency' : null,
  ].filter(Boolean).join(' and ');
  const whose = p.role === 'agency' ? 'your' : "your agency's";
  return {
    reason_code: 'refund_delivery_fault',
    reason_params: {
      orderNumber: p.orderNumber,
      trackingNumber: p.trackingNumber,
      amount: p.amount,
      currency: p.currency,
      raisedAt: p.raisedAt.toISOString(),
      deliveredAt: p.deliveredAt ? p.deliveredAt.toISOString() : null,
      windowDays: p.windowDays,
      claimDeadlineDays: p.claimDeadlineDays,
      returnsPaidByAgency: p.returnsPaidByAgency,
      role: p.role,
    },
    explanation:
      `The customer was refunded on ${order(p.orderNumber)}, ${parcel(p.trackingNumber)}, and the delivery was found at fault. ` +
      `The problem was raised on ${day(p.raisedAt)}, within ${whose} ${p.windowDays}-day window after delivery on ${day(p.deliveredAt)}` +
      `${terms ? ` (${terms})` : ''}, so ${money(p.amount, p.currency)} of the delivery fee was returned.`,
  };
}

/** A damage claim charged to an agency. */
export function explainDamageClaim(p: {
  orderNumber: string | null;
  trackingNumber: string | null;
  itemCount: number;
  maxPerItem: number;
  amount: number;
  investigationFee: number;
  currency: string;
  raisedAt: Date;
  windowDays: number;
}): Explanation {
  const fee = p.investigationFee > 0 ? `, plus your investigation fee of ${money(p.investigationFee, p.currency)}` : '';
  return {
    reason_code: 'damage_claim',
    reason_params: {
      orderNumber: p.orderNumber,
      trackingNumber: p.trackingNumber,
      itemCount: p.itemCount,
      maxPerItem: p.maxPerItem,
      amount: p.amount,
      investigationFee: p.investigationFee,
      currency: p.currency,
      raisedAt: p.raisedAt.toISOString(),
      windowDays: p.windowDays,
    },
    explanation:
      `Damage claim on ${order(p.orderNumber)}, ${parcel(p.trackingNumber)}: ${p.itemCount} item(s) damaged in delivery, ` +
      `reported on ${day(p.raisedAt)}, within your ${p.windowDays}-day damage-claim window. Your terms allow up to ` +
      `${money(p.maxPerItem, p.currency)} per item, so ${money(p.amount, p.currency)} was charged${fee}.`,
  };
}
