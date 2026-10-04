import type { DeliveryPayer, DeliveryPayerReason } from '../../vendors/domain/delivery-terms';

/**
 * Who pays a shipment's delivery fee, and how much of it — the pure readers every money path
 * shares (ADR-A11, customer-paid delivery, 2026-10-03).
 *
 * PURE: types only, no Mongoose, no I/O. The checkout writes the facts (`order.delivery_payer`,
 * `shipment.delivery_payer`, `shipment.customer_delivery_fee`); the splits, the COD expected
 * amount, the exposure twin and the analytics read them through THIS file, so "how much did
 * the customer pay for this delivery" has one answer.
 *
 * ── The two fields, and why there are two ────────────────────────────────────
 *   `delivery_fee_snapshot`  what the AGENCY is paid for the run (the split divides it). Written
 *                            at checkout for every physical shipment since ADR-A11; a vendor-
 *                            approved override replaces it.
 *   `customer_delivery_fee`  what the CUSTOMER was charged for that run. Written at checkout
 *                            (= the snapshot on a customer-paid shipment, 0 on a vendor-paid
 *                            one). W-E (customer-approved fee changes) moves it together with
 *                            the top-up / partial refund. Kept separate so a fee change awaiting
 *                            the customer's money never makes the split read a number the
 *                            customer did not pay.
 *
 * Whatever the agency is paid beyond what the customer covered is VENDOR-borne
 * (`max(0, fee − customerFee)`); whatever the customer paid beyond the fee is owed back to the
 * customer (`max(0, customerFee − fee)`, recorded on `shipment.customer_fee_refundable`).
 */

export const DELIVERY_PAYERS: readonly DeliveryPayer[] = Object.freeze(['vendor', 'customer']) as readonly DeliveryPayer[];

export const DELIVERY_PAYER_REASONS: readonly DeliveryPayerReason[] = Object.freeze([
  'shop_always',
  'shop_never',
  'shop_threshold_met',
  'threshold_not_met',
  'cap_fallback',
]) as readonly DeliveryPayerReason[];

interface PayerCarrier {
  delivery_payer?: DeliveryPayer | null;
}

/**
 * The payer of a shipment: the shipment's own copy, else the order's, else `vendor` — the
 * pre-ADR-A11 behaviour every legacy row predates the field with.
 */
export function deliveryPayerOf(
  order: PayerCarrier | null | undefined,
  shipment?: PayerCarrier | null,
): DeliveryPayer {
  return shipment?.delivery_payer ?? order?.delivery_payer ?? 'vendor';
}

/**
 * What the CUSTOMER pays for this shipment's delivery. 0 on a vendor-paid (or legacy)
 * shipment. ⚠ Never falls back to `delivery_fee_snapshot`: a shipment created after checkout
 * (an item moved to another agency) gets a snapshot later, and reading it here would credit
 * the customer with a payment they never made.
 */
export function customerDeliveryFeeOf(
  order: PayerCarrier | null | undefined,
  shipment: PayerCarrier & { customer_delivery_fee?: number | null },
): number {
  if (deliveryPayerOf(order, shipment) !== 'customer') return 0;
  const fee = shipment.customer_delivery_fee;
  return typeof fee === 'number' && Number.isFinite(fee) && fee > 0 ? fee : 0;
}

export interface DeliveryFeeShares {
  /** The part of the agency's fee the customer's payment covers. */
  customerCovered: number;
  /** The part of the agency's fee the VENDOR bears (deducted from their net). */
  vendorBorne: number;
  /** What the customer paid beyond the fee — owed back to the customer. */
  customerExcess: number;
}

/** Divide one shipment's agency fee between what the customer paid and what the vendor bears. */
export function deliveryFeeShares(fee: number, customerFee: number): DeliveryFeeShares {
  const f = Math.max(0, fee);
  const c = Math.max(0, customerFee);
  return {
    customerCovered: Math.min(f, c),
    vendorBorne: Math.max(0, f - c),
    customerExcess: Math.max(0, c - f),
  };
}

/**
 * On a returned (RTO) prepaid shipment, who gets the unspent `reserved − earned` back. The
 * customer first, up to what their payment covered; the remainder to the vendor (who bore it).
 * Vendor-paid: the vendor gets it all (unchanged). Customer-paid: the customer gets it all.
 */
export function rtoLeftoverShares(
  reservedFee: number,
  earnedFee: number,
  customerCovered: number,
): { toCustomer: number; toVendor: number } {
  const leftover = Math.max(0, reservedFee - earnedFee);
  const toCustomer = Math.min(leftover, Math.max(0, customerCovered));
  return { toCustomer, toVendor: leftover - toCustomer };
}

/**
 * The ITEMS gross of an order — what the goods sold for, before any customer-paid delivery.
 * `price_breakdown.base` when present (every order since checkout wrote it), else the total
 * minus the delivery the customer was charged. The splits and the analytics measure the vendor
 * on THIS, never on `total_amount` (which includes customer-paid delivery since ADR-A11).
 */
export function orderItemsGrossOf(order: {
  total_amount: number;
  price_breakdown?: { base?: number | null; delivery?: number | null } | null;
}): number {
  const base = order.price_breakdown?.base;
  if (typeof base === 'number' && Number.isFinite(base)) return base;
  return order.total_amount - (order.price_breakdown?.delivery ?? 0);
}

/**
 * A COD collection's cash, split into goods and customer-paid delivery. Rows written before
 * ADR-A11 carry no breakdown: all of their cash was goods.
 */
export function collectionBreakdownOf(collection: {
  expected_amount: number;
  items_amount?: number | null;
  delivery_fee_amount?: number | null;
}): { itemsAmount: number; deliveryFeeAmount: number } {
  const deliveryFeeAmount = Math.max(0, collection.delivery_fee_amount ?? 0);
  const itemsAmount =
    typeof collection.items_amount === 'number' ? collection.items_amount : collection.expected_amount - deliveryFeeAmount;
  return { itemsAmount, deliveryFeeAmount };
}
