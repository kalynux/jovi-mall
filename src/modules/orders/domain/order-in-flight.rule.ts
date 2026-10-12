import { FulfillmentStatus } from '../order.model';

/**
 * "Is this order still moving?" — the one rule the closure paths share.
 *
 * An order is SETTLED when either:
 *   - its fulfilment status says nothing more will happen (`fulfilled` is digital-only,
 *     `cancelled` and `returned` end any order), or
 *   - it is COMPLETED (`completion.confirmed_at` set) — the customer confirmed, the COD code
 *     was handed over, or the auto-confirm sweep ran.
 *
 * ⚠ **The second clause is the one that matters for physical orders.** A physical order's
 * fulfilment status never moves past `delivered` (or `partially_delivered` when an item came
 * back) — confirmation stamps `completion` and leaves `fulfillment_status` where it was. A rule
 * reading only `fulfillment_status` therefore treats every delivered physical order as in
 * flight forever, which is how account closure came to refuse customers whose every order was
 * delivered and confirmed. `completion.confirmed_at` is the platform's own "finished" signal —
 * `OrderCompletionService.isSettled` gates every path that writes it, and reviews read it for
 * the same reason.
 *
 * A delivered-but-unconfirmed order stays in flight on purpose: the customer can still confirm
 * or dispute it, and the auto-confirm sweep settles it on its own within the window.
 *
 * The fulfilment list is still derived by exclusion, so a status added later counts as in flight
 * until somebody deliberately says otherwise — the safe direction, since the cost of the wrong
 * answer is an undeliverable parcel.
 *
 * And an order under a dispute hold is in flight whatever else is true: it needs the parties
 * answerable.
 */
export const SETTLED_FULFILMENT: readonly FulfillmentStatus[] = ['fulfilled', 'cancelled', 'returned'];

/**
 * Mongo filter fragment matching orders still in flight. Spread it beside the owner key:
 * `{ customer_id, ...ORDER_IN_FLIGHT_FILTER }`. `confirmed_at: null` matches an absent field too.
 */
export const ORDER_IN_FLIGHT_FILTER = {
  $or: [
    { fulfillment_status: { $nin: [...SETTLED_FULFILMENT] }, 'completion.confirmed_at': null },
    { 'dispute_hold.active': true },
  ],
};
