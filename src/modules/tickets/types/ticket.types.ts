/**
 * Ticketing Module - Type Definitions
 * 
 * Enums and types for the multi-actor ticketing system.
 */

/**
 * TicketType - Authoritative enum from ticket_types.txt
 */
export enum TicketType {
    // General Support
    GENERAL_SUPPORT = 'GENERAL_SUPPORT',
    ACCOUNT_ACCESS = 'ACCOUNT_ACCESS',
    ACCOUNT_VERIFICATION = 'ACCOUNT_VERIFICATION',
    PROFILE_UPDATE = 'PROFILE_UPDATE',
    SECURITY_ISSUE = 'SECURITY_ISSUE',

    // Order Issues
    ORDER_ISSUE = 'ORDER_ISSUE',
    ORDER_CANCELLATION = 'ORDER_CANCELLATION',
    ORDER_REFUND = 'ORDER_REFUND',
    ORDER_DISPUTE = 'ORDER_DISPUTE',
    ORDER_FULFILLMENT = 'ORDER_FULFILLMENT',

    // Payment Issues
    PAYMENT_ISSUE = 'PAYMENT_ISSUE',
    PAYMENT_FAILED = 'PAYMENT_FAILED',
    PAYMENT_CONFIRMATION = 'PAYMENT_CONFIRMATION',
    CHARGEBACK = 'CHARGEBACK',
    INVOICE_REQUEST = 'INVOICE_REQUEST',

    // Payout Issues
    PAYOUT_REQUEST = 'PAYOUT_REQUEST',
    PAYOUT_DELAY = 'PAYOUT_DELAY',
    PAYOUT_DISPUTE = 'PAYOUT_DISPUTE',
    COMMISSION_QUESTION = 'COMMISSION_QUESTION',

    // Booking Issues
    BOOKING_ISSUE = 'BOOKING_ISSUE',
    BOOKING_CANCELLATION = 'BOOKING_CANCELLATION',
    BOOKING_RESCHEDULE = 'BOOKING_RESCHEDULE',
    AVAILABILITY_PROBLEM = 'AVAILABILITY_PROBLEM',

    // Product Issues
    PRODUCT_ISSUE = 'PRODUCT_ISSUE',
    INVENTORY_PROBLEM = 'INVENTORY_PROBLEM',
    PRICING_ISSUE = 'PRICING_ISSUE',
    VARIANT_ISSUE = 'VARIANT_ISSUE',

    // Shipping/Delivery
    SHIPPING_ISSUE = 'SHIPPING_ISSUE',
    DELIVERY_DELAY = 'DELIVERY_DELAY',
    DELIVERY_CONFIRMATION = 'DELIVERY_CONFIRMATION',
    ADDRESS_CHANGE = 'ADDRESS_CHANGE',

    // Technical
    TECHNICAL_ISSUE = 'TECHNICAL_ISSUE',
    BUG_REPORT = 'BUG_REPORT',
    INTEGRATION_ISSUE = 'INTEGRATION_ISSUE',
    API_ACCESS = 'API_ACCESS',

    // Policy/Legal
    POLICY_QUESTION = 'POLICY_QUESTION',
    COMPLIANCE = 'COMPLIANCE',
    LEGAL_REQUEST = 'LEGAL_REQUEST',

    // Other
    OTHER = 'OTHER'
}

/**
 * TicketStatus - Lifecycle states
 */
export enum TicketStatus {
    OPEN = 'open',
    IN_PROGRESS = 'in_progress',
    WAITING_ON_ADMIN = 'waiting_on_admin',
    WAITING_ON_VENDOR = 'waiting_on_vendor',
    WAITING_ON_CUSTOMER = 'waiting_on_customer',
    WAITING_ON_AGENCY = 'waiting_on_agency',
    WAITING_ON_AGENT = 'waiting_on_agent',
    RESOLVED = 'resolved',
    CLOSED = 'closed'
}

/**
 * TicketPriority - Operational priority
 */
export enum TicketPriority {
    LOW = 'low',
    NORMAL = 'normal',
    HIGH = 'high',
    URGENT = 'urgent'
}

/**
 * TicketImportance - Creator's subjective urgency (immutable)
 */
export enum TicketImportance {
    LOW = 'low',
    MEDIUM = 'medium',
    HIGH = 'high',
    CRITICAL = 'critical'
}

/**
 * ActorRole - Platform actor types
 */
export enum ActorRole {
    ADMIN = 'admin',
    VENDOR = 'vendor',
    CUSTOMER = 'customer',
    AGENCY = 'agency',
    AGENT = 'agent'
}

/**
 * EntityType - Polymorphic domain entity types
 */
export enum EntityType {
    ORDER = 'ORDER',
    PRODUCT = 'PRODUCT',
    BOOKING = 'BOOKING',
    SHIPMENT = 'SHIPMENT',
    DELIVERY = 'DELIVERY',
    USER = 'USER',
    VENDOR = 'VENDOR',
    CUSTOMER = 'CUSTOMER',
    AGENT = 'AGENT',
    AGENCY = 'AGENCY',
    OTHER = 'OTHER'
}

/**
 * NoteVisibility - Note access control
 */
export enum NoteVisibility {
    PUBLIC = 'public',
    PRIVATE = 'private'
}

/**
 * Helper to get all ticket type values
 */
export const TICKET_TYPE_VALUES = Object.values(TicketType);

/**
 * Helper to get all status values
 */
export const TICKET_STATUS_VALUES = Object.values(TicketStatus);

/**
 * Terminal statuses — a ticket here is considered done. Entering one stamps
 * `terminalAt`; leaving it (reopen) clears it. The file-cleanup module uses
 * `terminalAt` as the grace clock for detaching ticket attachments.
 */
export const TERMINAL_TICKET_STATUSES: ReadonlyArray<TicketStatus> = [
    TicketStatus.RESOLVED,
    TicketStatus.CLOSED,
];

/** Whether a status is terminal (resolved/closed). */
export function isTerminalStatus(status: TicketStatus): boolean {
    return TERMINAL_TICKET_STATUSES.includes(status);
}

/**
 * Maps each actor-specific "waiting" status to the ActorRole it is waiting on.
 *
 * Used by the status update flow to enforce that a ticket can only be marked as
 * waiting on a party that actually participates in it. `waiting_on_admin` is the
 * exception: it is always allowed because platform admin support is implicit.
 */
export const WAITING_STATUS_TARGET_ROLE: Partial<Record<TicketStatus, ActorRole>> = {
    [TicketStatus.WAITING_ON_ADMIN]: ActorRole.ADMIN,
    [TicketStatus.WAITING_ON_VENDOR]: ActorRole.VENDOR,
    [TicketStatus.WAITING_ON_CUSTOMER]: ActorRole.CUSTOMER,
    [TicketStatus.WAITING_ON_AGENCY]: ActorRole.AGENCY,
    [TicketStatus.WAITING_ON_AGENT]: ActorRole.AGENT
};

/**
 * Whether a status is one of the actor-specific waiting statuses.
 */
export function isWaitingStatus(status: TicketStatus): boolean {
    return status in WAITING_STATUS_TARGET_ROLE;
}

/**
 * Helper to get all priority values
 */
export const TICKET_PRIORITY_VALUES = Object.values(TicketPriority);

/**
 * Helper to get all importance values
 */
export const TICKET_IMPORTANCE_VALUES = Object.values(TicketImportance);

/**
 * Helper to get all actor role values
 */
export const ACTOR_ROLE_VALUES = Object.values(ActorRole);

/**
 * Helper to get all entity type values
 */
export const ENTITY_TYPE_VALUES = Object.values(EntityType);

/**
 * Helper to get all note visibility values
 */
export const NOTE_VISIBILITY_VALUES = Object.values(NoteVisibility);
