import { ActorRole, EntityType, TicketType } from '../types/ticket.types';

/**
 * Which support requests count as a customer REPORTING A PROBLEM with a purchase — the ones
 * that keep the purchase's earnings paused while they are open (owner decision, 2026-10-10).
 * Pure: `test:problem-report-hold` asserts every rule here without a database.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The platform can only make a customer whole out of money it still holds, and it holds an
 * order's money for `EARNINGS_HOLD_DAYS` after delivery. A complaint that did not stop that
 * clock would be a promise with nothing behind it: the request would sit in a queue while the
 * seller was paid. So a problem reported in time pauses the money.
 *
 * ── Why an allowlist of types, and why it is generous ────────────────────────
 * A question about an invoice or a change of address must not hold a seller's money. But a
 * customer who files a defect under "other" must still be protected, so the two catch-all
 * types are in the list: about an order or a booking, "other" is far more often a problem
 * than a question, and the cost of being wrong is a pause that ends when the request does.
 */
export const PROBLEM_REPORT_TICKET_TYPES: readonly TicketType[] = [
    TicketType.ORDER_ISSUE,
    TicketType.ORDER_CANCELLATION,
    TicketType.ORDER_REFUND,
    TicketType.ORDER_DISPUTE,
    TicketType.ORDER_FULFILLMENT,
    TicketType.PAYMENT_ISSUE,
    TicketType.CHARGEBACK,
    TicketType.BOOKING_ISSUE,
    TicketType.BOOKING_CANCELLATION,
    TicketType.PRODUCT_ISSUE,
    TicketType.SHIPPING_ISSUE,
    TicketType.DELIVERY_DELAY,
    TicketType.DELIVERY_CONFIRMATION,
    TicketType.GENERAL_SUPPORT,
    TicketType.OTHER,
];

/** What a request must be ABOUT to hold money: something that was paid for. */
export const PROBLEM_REPORT_ENTITY_TYPES: readonly EntityType[] = [
    EntityType.ORDER,
    EntityType.SHIPMENT,
    EntityType.BOOKING,
];

/**
 * Is this request a customer reporting a problem with a purchase?
 *
 * Only a CUSTOMER's request counts. A seller, an agency or an agent opening a request about
 * an order is not the buyer asking for protection, and a request the platform opens itself
 * (a refund owed, a card dispute) already pauses the money through its own reason.
 */
export function isProblemReport(ticket: {
    type: string;
    createdByRole: string;
    entityType: string;
}): boolean {
    return (
        ticket.createdByRole === ActorRole.CUSTOMER &&
        PROBLEM_REPORT_ENTITY_TYPES.includes(ticket.entityType as EntityType) &&
        PROBLEM_REPORT_TICKET_TYPES.includes(ticket.type as TicketType)
    );
}

/**
 * May the person ending a request also free the money it holds?
 *
 * An administrator, or the customer who opened it. NEVER anybody else: the order's seller,
 * agency and agent follow the request and can set any status on it, so if "resolved" freed
 * the money, a seller could pay themselves by marking a complaint against them resolved.
 */
export function mayReleaseHold(endedBy: { userId: string; role: string }, createdByUserId: string): boolean {
    return endedBy.role === ActorRole.ADMIN || endedBy.userId === createdByUserId;
}
