import type { ProductStatus } from '../../models/product.model';

/**
 * May a vendor permanently delete this product? — the whole decision, pure.
 *
 * ── The rule (owner decision, 2026-10-18, "option A") ───────────────────────────
 * A product may be deleted for good only if it is ARCHIVED and NOTHING ANYBODY BOUGHT
 * OR IS BUYING points at it. "Never sold" is deliberately the bar, not "every order is
 * finished": an order line snapshots the title, SKU and price, but four readers still
 * resolve the product LIVE afterwards — the order-history picture, a purchased digital
 * download, a booking's service name and the product's public reviews — and a hard
 * delete would break each of them silently, plus destroy the listing a card dispute
 * months later needs as evidence. A product that sold stays archived, which already
 * hides it from every shopper.
 *
 * ── Why it reports EVERY blocker ──────────────────────────────────────────────────
 * Same argument `AgentEligibilityService` and the unsuspend checklist make: a refusal
 * that names only the first reason sends the vendor round the loop once per reason.
 *
 * Archiving is the gate in front of all of this, and it already does a lot of work:
 * only an `active` or `draft` product can be archived, so a product suspended by an
 * administrator, an agency, the vendor cascade or the plan quota can never reach here.
 */

export const PRODUCT_DELETE_BLOCKER_REASONS = [
  'not_archived',
  'has_orders',
  'has_bookings',
  'has_digital_purchases',
  'has_reviews',
  'checkout_in_progress',
  'negotiation_in_progress',
  'agency_stock_counted',
  'stock_request_pending',
] as const;

export type ProductDeleteBlockerReason = (typeof PRODUCT_DELETE_BLOCKER_REASONS)[number];

/** Everything the decision needs, gathered by the service inside its transaction. */
export interface ProductDeleteFacts {
  status: ProductStatus;
  /** Orders with a line on this product — any status, ever. */
  orderCount: number;
  /** Bookings of this (service) product — any status, ever. */
  bookingCount: number;
  /** Digital entitlements granted for this product — any status, ever. */
  digitalEntitlementCount: number;
  /** Reviews about this product, live or deleted. */
  reviewCount: number;
  /** Checkout stock holds still `active` and not yet expired. */
  activeReservationCount: number;
  /** Open haggling sessions, or agreed prices not yet spent, that have not expired. */
  liveNegotiationCount: number;
  /** Agency depot rows somebody has COUNTED (they carry a movement ledger). */
  countedAgencyStockRowCount: number;
  /** Stock adjustment requests still awaiting an answer. */
  pendingStockRequestCount: number;
}

export interface ProductDeleteBlocker {
  reason: ProductDeleteBlockerReason;
  /** How many records hold it back — absent for `not_archived`. */
  count?: number;
  /** Vendor-facing sentence, rendered verbatim by the dashboard. */
  message: string;
}

const MESSAGES: Record<ProductDeleteBlockerReason, string> = {
  not_archived: 'Archive this product before deleting it permanently.',
  has_orders: 'This product has been ordered. A product that has been sold can only be archived, never deleted.',
  has_bookings: 'This service has been booked. A booked service can only be archived, never deleted.',
  has_digital_purchases: 'Customers have bought this download. It must stay available to them, so it can only be archived.',
  has_reviews: 'This product has reviews. A reviewed product can only be archived, never deleted.',
  checkout_in_progress: 'A customer is checking out with this product right now. Try again in about 30 minutes.',
  negotiation_in_progress: 'A customer is negotiating a price for this product, or holds an agreed price not yet used. Try again once it expires.',
  agency_stock_counted: 'A delivery agency has recorded stock of this product in its warehouse, so it can only be archived.',
  stock_request_pending: 'A stock change request for this product is waiting for an answer. Withdraw it or wait for the agency to answer.',
};

/** The vendor-facing sentence for one reason — exported so the docs and tests read one copy. */
export function productDeleteBlockerMessage(reason: ProductDeleteBlockerReason): string {
  return MESSAGES[reason];
}

/** Every reason this product cannot be deleted; empty means it may be. Pure. */
export function evaluateProductDeletion(facts: ProductDeleteFacts): ProductDeleteBlocker[] {
  const blockers: ProductDeleteBlocker[] = [];

  if (facts.status !== 'archived') {
    blockers.push({ reason: 'not_archived', message: MESSAGES.not_archived });
  }

  const counted: Array<[ProductDeleteBlockerReason, number]> = [
    ['has_orders', facts.orderCount],
    ['has_bookings', facts.bookingCount],
    ['has_digital_purchases', facts.digitalEntitlementCount],
    ['has_reviews', facts.reviewCount],
    ['checkout_in_progress', facts.activeReservationCount],
    ['negotiation_in_progress', facts.liveNegotiationCount],
    ['agency_stock_counted', facts.countedAgencyStockRowCount],
    ['stock_request_pending', facts.pendingStockRequestCount],
  ];

  for (const [reason, count] of counted) {
    if (count > 0) blockers.push({ reason, count, message: MESSAGES[reason] });
  }

  return blockers;
}
