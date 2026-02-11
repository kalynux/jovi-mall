import { VendorOrderRepository, OrderFilters } from './vendor-order.repository';
import { OrderTimelineRepository } from './order-timeline.repository';
import { VendorOrderNoteRepository } from './vendor-order-note.repository';
import { IOrder, FulfillmentStatus } from './order.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { NotFoundError, UnprocessableEntityError, ValidationError } from '../../core/errors';
import { eventBus } from '../../core/events/event-bus';

/**
 * Vendor Order Service
 * 
 * Business logic for vendor order management.
 * 
 * SECURITY:
 * - All operations enforce vendor ownership
 * - No cross-vendor data leakage
 * 
 * BUSINESS RULES:
 * - Fulfillment state machine enforced
 * - Payment-fulfillment coupling enforced
 * - Terminal states cannot be updated
 * - Domain events emitted (fire-and-forget)
 */

// Fulfillment State Machine
const FULFILLMENT_STATE_MACHINE: Record<FulfillmentStatus, FulfillmentStatus[]> = {
    'pending': ['processing', 'cancelled'],
    'processing': ['shipped', 'cancelled'],
    'shipped': ['delivered', 'cancelled'],
    'delivered': [],  // Terminal state
    'fulfilled': ['cancelled'],  // Legacy support
    'cancelled': []   // Terminal state
};

export class VendorOrderService {
    private vendorOrderRepo: VendorOrderRepository;
    private timelineRepo: OrderTimelineRepository;
    private noteRepo: VendorOrderNoteRepository;

    constructor() {
        this.vendorOrderRepo = new VendorOrderRepository();
        this.timelineRepo = new OrderTimelineRepository();
        this.noteRepo = new VendorOrderNoteRepository();
    }

    /**
     * List orders for vendor
     * 
     * Ownership enforced at repository level.
     */
    async listOrders(
        vendorId: string,
        filters: OrderFilters = {},
        pagination: PaginationOptions = { page: 1, limit: 20, sort: { created_at: -1 } }
    ): Promise<Page<any>> {
        const result = await this.vendorOrderRepo.findByVendor(vendorId, filters, pagination);

        // Transform to DTO
        const dtoData = result.data.map(order => ({
            id: order._id.toString(),
            orderNumber: order.order_number,
            orderType: order.order_type,
            createdAt: order.created_at,

            // Customer summary (no sensitive data)
            customer: {
                id: order.customer_id.toString()
                // TODO: Populate customer name/email from customer service
            },

            // Totals (immutable snapshot)
            subtotal: order.price_breakdown.base,
            tax: order.price_breakdown.tax,
            shipping: 0,  // TODO: Calculate shipping from delivery
            total: order.total_amount,
            currency: order.currency,

            // Status
            fulfillmentStatus: order.fulfillment_status,
            paymentStatus: order.payment_status,

            // Item count
            itemCount: order.items.length
        }));

        return {
            data: dtoData,
            meta: result.meta
        };
    }

    /**
     * Get order details
     * 
     * Ownership validated. Returns 404 if not found or not owned.
     */
    async getOrderDetails(orderId: string, vendorId: string): Promise<any> {
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw new NotFoundError('Order not found');
        }

        // Transform to detailed DTO
        return {
            id: order._id.toString(),
            orderNumber: order.order_number,
            orderType: order.order_type,
            createdAt: order.created_at,
            updatedAt: order.updated_at,

            // Customer (read-only)
            customer: {
                id: order.customer_id.toString()
                // TODO: Populate from customer service
            },

            // Shipping address (read-only)
            // TODO: Fetch from order or customer service

            // Line items with pricing snapshots
            items: order.items.map(item => ({
                id: item._id.toString(),
                productId: item.product_id.toString(),
                variantId: item.variant_id.toString(),
                title: item.title,
                variantTitle: item.variant_title,
                sku: item.sku,
                optionsSnapshot: item.options_snapshot,
                quantity: item.quantity,
                price: item.price,
                currency: item.currency
            })),

            // Pricing
            priceBreakdown: order.price_breakdown,
            totalAmount: order.total_amount,
            currency: order.currency,

            // Status
            fulfillmentStatus: order.fulfillment_status,
            paymentStatus: order.payment_status,
            paymentIntentId: order.payment_intent_id
        };
    }

    /**
     * Update fulfillment status
     * 
     * Enforces:
     * - Vendor ownership
     * - State machine transitions
     * - Payment-fulfillment coupling
     * - Terminal state protection
     * 
     * Emits domain events (fire-and-forget).
     */
    async updateFulfillmentStatus(
        orderId: string,
        vendorId: string,
        newStatus: FulfillmentStatus
    ): Promise<any> {
        // 1. Fetch order with ownership check
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw new NotFoundError('Order not found');
        }

        const currentStatus = order.fulfillment_status;

        // 2. Terminal state protection
        if (FULFILLMENT_STATE_MACHINE[currentStatus].length === 0) {
            throw new UnprocessableEntityError(
                `Cannot update fulfillment status: order is in terminal state '${currentStatus}'`
            );
        }

        // 3. State machine validation
        const allowedTransitions = FULFILLMENT_STATE_MACHINE[currentStatus];
        if (!allowedTransitions.includes(newStatus)) {
            throw new ValidationError(
                `Invalid state transition: cannot transition from '${currentStatus}' to '${newStatus}'. ` +
                `Allowed transitions: ${allowedTransitions.join(', ')}`
            );
        }

        // 4. Payment-fulfillment coupling
        if (newStatus === 'processing' && order.payment_status !== 'paid') {
            throw new UnprocessableEntityError(
                `Cannot start processing: payment status is '${order.payment_status}'. ` +
                `Order must be paid before fulfillment can begin.`
            );
        }

        if (['failed', 'refunded'].includes(order.payment_status)) {
            throw new UnprocessableEntityError(
                `Cannot advance fulfillment: payment status is '${order.payment_status}'`
            );
        }

        // 5. Update status
        const updatedOrder = await this.vendorOrderRepo.updateFulfillmentStatus(
            orderId,
            vendorId,
            newStatus
        );

        if (!updatedOrder) {
            throw new NotFoundError('Order not found after update');
        }

        // 6. Append timeline entry
        await this.timelineRepo.appendEvent({
            orderId,
            eventType: 'fulfillment.updated',
            description: `Fulfillment status changed from '${currentStatus}' to '${newStatus}'`,
            metadata: {
                previousStatus: currentStatus,
                newStatus,
                vendorId
            },
            actorType: 'vendor',
            actorId: vendorId
        });

        // 7. Emit domain events (fire-and-forget, no synchronous side effects)
        const eventType = `vendor.order.${newStatus}`;
        await eventBus.publish(eventType, {
            eventType,
            aggregateId: orderId,
            payload: {
                orderId,
                vendorId,
                previousStatus: currentStatus,
                newStatus,
                updatedAt: new Date()
            },
            occurredAt: new Date()
        });

        // 7b. Emit order.cancelled event for vendor notifications
        if (newStatus === 'cancelled') {
            await eventBus.publish('order.cancelled', {
                eventType: 'order.cancelled',
                aggregateId: orderId,
                payload: {
                    orderId,
                    vendorId,
                    orderNumber: updatedOrder.order_number,
                    cancelledAt: new Date()
                },
                occurredAt: new Date()
            });
            console.log(`[VendorOrderService] Emitted order.cancelled event for order ${orderId}`);
        }

        // 8. Return updated order DTO
        return this.getOrderDetails(orderId, vendorId);
    }

    /**
     * Get order timeline
     * 
     * Ownership validated.
     */
    async getTimeline(
        orderId: string,
        vendorId: string,
        pagination: PaginationOptions = { page: 1, limit: 20, sort: { created_at: -1 } }
    ): Promise<Page<any>> {
        // Validate ownership first
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw new NotFoundError('Order not found');
        }

        // Fetch timeline
        const result = await this.timelineRepo.findByOrder(orderId, pagination);

        // Transform to DTO
        const dtoData = result.data.map(entry => ({
            id: entry._id.toString(),
            eventType: entry.event_type,
            description: entry.description,
            metadata: entry.metadata,
            actorType: entry.actor_type,
            actorId: entry.actor_id?.toString() || null,
            createdAt: entry.created_at
        }));

        return {
            data: dtoData,
            meta: result.meta
        };
    }

    /**
     * Add vendor note
     * 
     * Ownership validated. Appends timeline entry.
     */
    async addNote(
        orderId: string,
        vendorId: string,
        authorId: string,
        message: string
    ): Promise<any> {
        // Validate ownership
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw new NotFoundError('Order not found');
        }

        // Create note
        const note = await this.noteRepo.create({
            orderId,
            vendorId,
            authorId,
            message
        });

        // Append timeline entry
        await this.timelineRepo.appendEvent({
            orderId,
            eventType: 'note.added',
            description: 'Vendor note added',
            metadata: {
                noteId: note._id.toString(),
                messagePreview: message.substring(0, 100)
            },
            actorType: 'vendor',
            actorId: authorId
        });

        // Return note DTO
        return {
            id: note._id.toString(),
            message: note.message,
            authorId: note.author_id.toString(),
            createdAt: note.created_at
        };
    }

    /**
     * Get vendor notes for order
     * 
     * Ownership validated.
     */
    async getNotes(orderId: string, vendorId: string): Promise<any[]> {
        // Validate ownership
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw new NotFoundError('Order not found');
        }

        // Fetch notes
        const notes = await this.noteRepo.findByOrder(orderId, vendorId);

        // Transform to DTO
        return notes.map(note => ({
            id: note._id.toString(),
            message: note.message,
            authorId: note.author_id.toString(),
            createdAt: note.created_at
        }));
    }
}
