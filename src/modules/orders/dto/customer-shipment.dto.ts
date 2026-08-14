/**
 * A parcel, as its recipient is allowed to see it.
 *
 * ── Why this endpoint exists ────────────────────────────────────────────────
 *
 * There was **no customer-facing shipment endpoint of any kind** — every
 * `ShipmentController` handler is mounted under `/agency`, `/agent` or `/admin`. That left a
 * dead end rather than merely a gap: two shipped customer endpoints,
 *
 *     POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery
 *     POST /api/customer/orders/:orderId/shipments/:shipmentId/resend-delivery-code
 *
 * both require a `:shipmentId`, and **no customer-facing response returned one** except
 * inside `codCollections`, which is `undefined` for every online-paid order. So a prepaid
 * customer could never confirm a delivery, and the tracking number was disclosed exactly
 * once — by the confirm call itself, after delivery, when it is useless.
 *
 * ── The status vocabulary is collapsed, not passed through ──────────────────
 *
 * `ShipmentStatus` has eleven members, and most of them describe the platform's internal
 * dispatch machinery rather than the parcel's journey: `assigned` means an agency accepted
 * it, `handing_over` means one agent is passing it to another mid-route,
 * `pending_agency_reassignment` means dispatch is being redone. Telling a customer their
 * parcel is "handing over" leaks how the operation works and answers a question they did not
 * ask; worse, it invites support contacts about states they can do nothing about.
 *
 * So the wire vocabulary is the **four the customer notification catalog already commits
 * to** — `shipped`, `out_for_delivery`, `delivered`, `delivery_failed` — plus `preparing`
 * for everything before a parcel physically moves. A customer who received "your order is on
 * its way" and then opens the app sees the same word, which is the whole point of reusing
 * that vocabulary rather than inventing a second one.
 *
 * ── What is deliberately never published ────────────────────────────────────
 *
 * The agent's identity or contact details, and the free-text internal `note` on a failed
 * delivery. `delivery_failures[].note` is written by an agent for their agency ("gate locked,
 * dog") and `reason` is an internal enum; the notification copy already rephrases both
 * deliberately for the customer, and this endpoint must not undo that by shipping the raw
 * text. Only the *fact* of a failed attempt and its timestamp are surfaced.
 */
import { IShipment, ShipmentStatus } from '../../shipments/shipment.model';

/** The five states a customer is shown. See the header for why it is not eleven. */
export type CustomerShipmentStatus =
    | 'preparing'
    | 'shipped'
    | 'out_for_delivery'
    | 'delivered'
    | 'delivery_failed';

/**
 * Internal status → what the customer is told.
 *
 * A total map rather than a switch with a default: adding a twelfth `ShipmentStatus` should
 * be a compile error here, because the alternative is a new internal state silently leaking
 * onto a customer's screen under whatever the fallback happened to be.
 */
const CUSTOMER_VISIBLE_STATUS: Readonly<Record<ShipmentStatus, CustomerShipmentStatus>> = Object.freeze({
    // Nothing has physically moved yet — dispatch detail the customer cannot act on.
    pending: 'preparing',
    assigned: 'preparing',
    pending_agency_reassignment: 'preparing',
    rejected: 'preparing',
    // In the agent's hands and moving.
    picked_up: 'shipped',
    in_transit: 'shipped',
    // A reassignment mid-route: still shipped from where the customer stands, because the
    // parcel is out and on its way — which agent carries it is the platform's business.
    handing_over: 'shipped',
    // At the door, or as good as.
    agent_delivered: 'out_for_delivery',
    delivered: 'delivered',
    // An attempt that did not land. `returned` is terminal for the parcel but reads to a
    // customer as the same fact: it did not arrive.
    failed: 'delivery_failed',
    returned: 'delivery_failed',
});

export interface CustomerShipmentHistoryEntry {
    status: CustomerShipmentStatus;
    at: string;
}

export interface CustomerShipmentDto {
    id: string;
    status: CustomerShipmentStatus;
    /**
     * `ACR-YYMMDD-HHMMSS-XXXXX`. Null on legacy shipments predating the generator.
     * Published from the moment a shipment exists — the point of a tracking number is to
     * hold it *during* the delivery.
     */
    trackingNumber: string | null;
    /** The delivery company's business name, from its Magazin. Never the agent's. */
    agencyName: string | null;
    /** Which order lines are in this parcel, so the UI can group them. */
    itemIds: string[];
    /**
     * The journey so far, collapsed to the same five-word vocabulary and de-duplicated:
     * `picked_up` then `in_transit` are both `shipped` and would otherwise render as the
     * same line twice.
     */
    statusHistory: CustomerShipmentHistoryEntry[];
    /**
     * Always `null` today, and present rather than omitted on purpose.
     *
     * Nothing in the platform estimates a delivery date — there is no promised-date model
     * and no routing ETA on this side (geo-tracker computes live ETAs, but only for an
     * in-progress run, and jovi-mall never stores one). Shipping the key as an explicit null
     * lets the UI build the row once instead of changing shape the day estimates arrive.
     */
    estimatedDelivery: string | null;
    /** How many delivery attempts have failed. The reasons and notes stay internal. */
    failedAttempts: number;
}

export function toCustomerShipmentStatus(status: ShipmentStatus): CustomerShipmentStatus {
    return CUSTOMER_VISIBLE_STATUS[status];
}

/**
 * Collapse the internal history to the customer's vocabulary.
 *
 * Consecutive entries mapping to the same customer status are folded into the **first** of
 * them — the moment that state was entered, which is what a timeline should show. Without
 * this, `picked_up → in_transit → handing_over` renders as "shipped" three times.
 */
export function toCustomerStatusHistory(
    history: Array<{ status: ShipmentStatus; changed_at: Date }>,
): CustomerShipmentHistoryEntry[] {
    const out: CustomerShipmentHistoryEntry[] = [];
    for (const entry of history) {
        const status = toCustomerShipmentStatus(entry.status);
        if (out.length > 0 && out[out.length - 1].status === status) continue;
        out.push({ status, at: new Date(entry.changed_at).toISOString() });
    }
    return out;
}

export function toCustomerShipmentDto(
    shipment: IShipment,
    agencyName: string | null,
): CustomerShipmentDto {
    return {
        id: String(shipment._id),
        status: toCustomerShipmentStatus(shipment.status),
        trackingNumber: shipment.tracking_number ?? null,
        agencyName,
        itemIds: (shipment.items ?? []).map((i) => i.order_item_id.toString()),
        statusHistory: toCustomerStatusHistory(shipment.status_history ?? []),
        estimatedDelivery: null,
        // The count is safe to publish; `delivery_failures[].reason` and `.note` are not —
        // see the header.
        failedAttempts: (shipment.delivery_failures ?? []).length,
    };
}
