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
 * The agent's CONTACT DETAILS, their full legal name, and the free-text internal `note` on a
 * failed delivery. `delivery_failures[].note` is written by an agent for their agency ("gate
 * locked, dog") and `reason` is an internal enum; the notification copy already rephrases
 * both deliberately for the customer, and this endpoint must not undo that by shipping the
 * raw text. Only the *fact* of a failed attempt and its timestamp are surfaced.
 *
 * ⚠ The agent's IDENTITY used to be on that list, and is not any more — see
 * `docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md` and the `agent` field below. What replaced a
 * blanket refusal is a narrow window, not an opening: a partial name and a photo, only while
 * the parcel is physically in that agent's hands, and never a phone number.
 */
import { IShipment, ShipmentStatus } from '../../shipments/shipment.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { AgencyIdentity } from '../../magazin/read-models/agency-identity.resolver';

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

/**
 * The internal statuses at which the carrying agent's identity is published to the
 * customer (ADR-A06). A total map for the same reason `CUSTOMER_VISIBLE_STATUS` is one:
 * a twelfth `ShipmentStatus` must be a compile error here rather than inheriting a
 * default, and the default a person would reach for while adding a status is `true`.
 *
 * The window is "the parcel is in this agent's hands and the handover has not settled":
 *
 *  - BEFORE it, there is usually no agent bound at all (`agent_id` is null until an offer
 *    is accepted), and naming one the customer will never meet is worse than naming none.
 *  - `agent_delivered` stays open because the handover is done but unconfirmed — a
 *    customer disputing "I never received it" is the one person who most needs to say who
 *    turned up.
 *  - `failed` stays open: it is NOT terminal (`failed → in_transit → …`), the same agent
 *    still holds the parcel, and they are coming back.
 *  - `delivered` and `returned` close it. This is the revocation half of ADR-A06: the
 *    disclosure is scoped to a live delivery, not stamped into order history forever.
 */
const AGENT_IDENTITY_VISIBLE: Readonly<Record<ShipmentStatus, boolean>> = Object.freeze({
    pending: false,
    assigned: false,
    pending_agency_reassignment: false,
    rejected: false,
    picked_up: true,
    in_transit: true,
    handing_over: true,
    agent_delivered: true,
    failed: true,
    delivered: false,
    returned: false,
});

/**
 * The customer-facing status from which the agent becomes visible, echoed on the wire so a
 * client can explain the wait ("you'll see your courier once the parcel is picked up")
 * without hardcoding the policy.
 *
 * ⚠ It is `shipped`, and the frontend request said `out_for_delivery`. Those are the same
 * English phrase and different things HERE: this API's `out_for_delivery` maps from the
 * internal `agent_delivered`, i.e. the agent says they have already handed the parcel over.
 * Publishing the courier only from there would show a customer who came to their door
 * *after* they came, which defeats the entire safety argument the request was built on. So
 * the window opens at `shipped` — the parcel is out and moving — which is what the phrase
 * meant when it was written.
 */
export const AGENT_IDENTITY_VISIBLE_FROM: CustomerShipmentStatus = 'shipped';

export interface CustomerShipmentHistoryEntry {
    status: CustomerShipmentStatus;
    at: string;
}

/**
 * Who is carrying the parcel, as its recipient is allowed to see them (ADR-A06).
 *
 * Present only inside the window `AGENT_IDENTITY_VISIBLE` describes; `null` on the shipment
 * otherwise. Three fields and no more — in particular **no phone number**: the platform's
 * position is that a customer contacts the AGENCY (`agency.supportPhone`), which is a
 * business line, and never an individual worker's personal handset.
 */
export interface CustomerShipmentAgent {
    /**
     * Partial by design — "Jean T.", never the full legal name. Enough to recognise the
     * person at the door, not enough to look them up afterwards.
     */
    displayName: string;
    /** Their profile photo as the platform's canonical file reference. `null` is common. */
    photo: FileDetail | null;
    /** The customer-facing status from which this block appears. Constant; see above. */
    visibleFrom: CustomerShipmentStatus;
}

/**
 * The delivery company, as its customer sees it.
 *
 * The platform's existing `AgencyIdentity` read model verbatim — the same block the agent
 * and agency surfaces already serve — rather than a customer-only projection, because there
 * is one answer to "who is this agency" and a second copy is how the two drift. The support
 * contacts are the agency's published business lines and are exactly what a customer with a
 * question about their own delivery should be given.
 */
export type CustomerShipmentAgency = AgencyIdentity;

/**
 * Render an agent's stored name as the customer sees it: first name, then the initial of
 * the last, then a full stop. "Jean Pierre Talla" → "Jean T.".
 *
 * Pure, and deliberately not clever about particles or compound surnames — the goal is
 * recognition at a doorstep, and a wrong guess about which token is the family name costs
 * nothing there while a full name costs the disclosure ADR-A06 declined to make.
 *
 * A single-token name is returned whole (there is no initial to take, and truncating it to
 * one letter identifies nobody); a blank name yields `null`, and the caller then publishes
 * no agent block at all rather than an empty one.
 */
export function toAgentDisplayName(fullName: string | null | undefined): string | null {
    const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    // `Array.from` so a surname starting outside the BMP yields its whole character
    // rather than half a surrogate pair.
    const initial = Array.from(parts[parts.length - 1])[0];
    return `${parts[0]} ${initial.toUpperCase()}.`;
}

/** Whether this shipment's status is inside the ADR-A06 disclosure window. */
export function agentIdentityVisibleAt(status: ShipmentStatus): boolean {
    return AGENT_IDENTITY_VISIBLE[status];
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
    /**
     * The delivery company's business name, from its Magazin. Never the agent's.
     *
     * Duplicated inside `agency.name` and kept here deliberately: it shipped first and is
     * already consumed. Moving it would break a live screen to save one string.
     */
    agencyName: string | null;
    /**
     * The delivery company's identity and support contacts — logo, and the business lines a
     * customer with a question about this parcel should use. `null` when the agency has no
     * Magazin on file (in which case `agencyName` is null too, from the same absence).
     */
    agency: CustomerShipmentAgency | null;
    /**
     * Who is carrying it, while they are carrying it (ADR-A06). `null` before an agent is
     * bound, and `null` again once the parcel is `delivered` or `returned`.
     */
    agent: CustomerShipmentAgent | null;
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

/**
 * What the caller must resolve before a shipment can be projected. Both are looked up in
 * batch by `OrderService.listShipmentsForCustomer` — an order's parcels can span several
 * agencies and several agents, so neither is a per-row query.
 *
 * `agent` is passed already-resolved rather than as a raw agent document, so the decision
 * "may this customer see this person" is made in ONE place (the caller consults
 * `agentIdentityVisibleAt`) and cannot be half-made by a second projection later.
 */
export interface CustomerShipmentParties {
    agency: CustomerShipmentAgency | null;
    agent: CustomerShipmentAgent | null;
}

export function toCustomerShipmentDto(
    shipment: IShipment,
    parties: CustomerShipmentParties,
): CustomerShipmentDto {
    return {
        id: String(shipment._id),
        status: toCustomerShipmentStatus(shipment.status),
        trackingNumber: shipment.tracking_number ?? null,
        agencyName: parties.agency?.name ?? null,
        agency: parties.agency,
        agent: parties.agent,
        itemIds: (shipment.items ?? []).map((i) => i.order_item_id.toString()),
        statusHistory: toCustomerStatusHistory(shipment.status_history ?? []),
        estimatedDelivery: null,
        // The count is safe to publish; `delivery_failures[].reason` and `.note` are not —
        // see the header.
        failedAttempts: (shipment.delivery_failures ?? []).length,
    };
}
