import { VendorOrderRepository, OrderFilters } from './vendor-order.repository';
import { OrderTimelineRepository } from './order-timeline.repository';
import { VendorOrderNoteRepository } from './vendor-order-note.repository';
import { IOrder, FulfillmentStatus } from './order.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
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
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
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
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        const currentStatus = order.fulfillment_status;

        // 2. Terminal state protection
        if (FULFILLMENT_STATE_MACHINE[currentStatus].length === 0) {
            throw createAppError(
                ERROR_CODES.ORDER_TERMINAL_STATE,
                422,
                undefined,
                { status: currentStatus }
            );
        }

        // 3. State machine validation
        const allowedTransitions = FULFILLMENT_STATE_MACHINE[currentStatus];
        if (!allowedTransitions.includes(newStatus)) {
            throw createAppError(
                ERROR_CODES.ORDER_INVALID_TRANSITION,
                400,
                undefined,
                { from: currentStatus, to: newStatus, allowed: allowedTransitions }
            );
        }

        // 4. Payment-fulfillment coupling
        if (newStatus === 'processing' && order.payment_status !== 'paid') {
            throw createAppError(
                ERROR_CODES.ORDER_PAYMENT_REQUIRED,
                422,
                undefined,
                { paymentStatus: order.payment_status }
            );
        }

        if (['failed', 'refunded'].includes(order.payment_status)) {
            throw createAppError(
                ERROR_CODES.ORDER_PAYMENT_FAILED_STATE,
                422,
                undefined,
                { paymentStatus: order.payment_status }
            );
        }

        // 5. Update status
        const updatedOrder = await this.vendorOrderRepo.updateFulfillmentStatus(
            orderId,
            vendorId,
            newStatus
        );

        if (!updatedOrder) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
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
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
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
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
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
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
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

    /**
     * Update delivery agency for physical order
     * 
     * NEW: Phase 1 - Delivery agency assignment
     * 
     * RULES:
     * - Only for physical orders
     * - Only for orders not yet delivered or cancelled
     * - Agency must exist (validated)
     * - Updates all order items
     * - Logs to timeline
     */
    async updateDeliveryAgency(
        orderId: string,
        vendorId: string,
        deliveryAgencyId: string
    ): Promise<any> {
        // 1. Validate order ownership and type
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        if (order.order_type !== 'physical') {
            throw createAppError(ERROR_CODES.ORDER_WRONG_TYPE, 400, 'Delivery agency can only be updated for physical orders');
        }

        // 2. Check order not yet delivered or cancelled
        if (['delivered', 'cancelled'].includes(order.fulfillment_status)) {
            throw createAppError(
                ERROR_CODES.ORDER_TERMINAL_STATE,
                422,
                undefined,
                { status: order.fulfillment_status }
            );
        }

        // 3. Validate delivery agency exists
        // Note: We're doing a simple existence check. Add .findOne({ isActive: true }) if needed
        const { default: mongoose } = await import('mongoose');

        if (!mongoose.connection.db) {
            throw createAppError(ERROR_CODES.DATABASE_CONNECTION_ERROR, 500);
        }

        const agencyExists = await mongoose.connection.db.collection('deliveryagencies').findOne({
            _id: new mongoose.Types.ObjectId(deliveryAgencyId)
        });

        if (!agencyExists) {
            throw createAppError(ERROR_CODES.ORDER_DELIVERY_AGENCY_NOT_FOUND, 404);
        }

        // 4. Update all order items with new agency
        const updatedOrder = await this.vendorOrderRepo.updateDeliveryAgency(
            orderId,
            vendorId,
            deliveryAgencyId
        );

        if (!updatedOrder) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        // 5. Append timeline entry
        await this.timelineRepo.appendEvent({
            orderId,
            eventType: 'delivery.agency_updated',
            description: `Delivery agency changed to ${agencyExists.name || deliveryAgencyId}`,
            metadata: {
                newAgencyId: deliveryAgencyId,
                agencyName: agencyExists.name || 'Unknown',
                previousAgencyId: order.items[0]?.delivery?.agency_id?.toString() || null
            },
            actorType: 'vendor',
            actorId: vendorId
        });

        // 6. Return updated order
        return this.getOrderDetails(orderId, vendorId);
    }

    /**
     * Get digital entitlements for an order
     * 
     * NEW: Phase 2 - Digital entitlement viewing
     * 
     * RULES:
     * - Only works for digital orders
     * - Shows download stats and status
     * - Customer information included
     */
    async getOrderEntitlements(
        orderId: string,
        vendorId: string
    ): Promise<any[]> {
        // 1. Validate order ownership and type
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        if (order.order_type !== 'digital') {
            throw createAppError(ERROR_CODES.ORDER_WRONG_TYPE, 400, 'Entitlements are only available for digital orders');
        }

        // 2. Fetch entitlements
        const { default: mongoose } = await import('mongoose');

        if (!mongoose.connection.db) {
            throw createAppError(ERROR_CODES.DATABASE_CONNECTION_ERROR, 500);
        }

        const entitlements = await mongoose.connection.db
            .collection('customerdigitalentitlements')
            .aggregate([
                {
                    $match: {
                        orderId: order._id,
                        vendorId: new mongoose.Types.ObjectId(vendorId),
                        deletedAt: null
                    }
                },
                {
                    $lookup: {
                        from: 'products',
                        localField: 'productId',
                        foreignField: '_id',
                        as: 'product'
                    }
                },
                {
                    $lookup: {
                        from: 'files',
                        localField: 'assetId',
                        foreignField: '_id',
                        as: 'asset'
                    }
                },
                {
                    $unwind: { path: '$product', preserveNullAndEmptyArrays: true }
                },
                {
                    $unwind: { path: '$asset', preserveNullAndEmptyArrays: true }
                }
            ])
            .toArray();

        const now = new Date();

        // 3. Transform to vendor-friendly DTO
        return entitlements.map((e: any) => {
            const isExpired = e.expiresAt !== null && e.expiresAt < now;
            const isRevoked = e.revokedAt !== null;
            const hasDownloadsRemaining =
                e.maxDownloads === null || e.downloadsUsed < e.maxDownloads;
            const isActive = !isExpired && !isRevoked && hasDownloadsRemaining;

            return {
                id: e._id.toString(),
                orderItemId: e.orderItemId.toString(),
                productId: e.productId.toString(),
                productTitle: e.product?.title || 'Unknown Product',
                assetId: e.assetId.toString(),
                assetName: e.asset?.originalName || 'Unknown Asset',
                customerId: e.customerId.toString(),

                // Download tracking
                downloadsUsed: e.downloadsUsed,
                maxDownloads: e.maxDownloads,
                downloadsRemaining: e.maxDownloads === null
                    ? 'unlimited'
                    : Math.max(0, e.maxDownloads - e.downloadsUsed),

                // Status
                grantedAt: e.createdAt,
                expiresAt: e.expiresAt,
                revokedAt: e.revokedAt,
                isExpired,
                isRevoked,
                isActive,

                // Metadata
                lastDownloadAt: e.lastDownloadAt || null
            };
        });
    }

    /**
     * Revoke digital entitlement
     * 
     * NEW: Phase 2 - Revoke customer access
     * 
     * RULES:
     * - Vendor must own the entitlement
     * - Cannot revoke already-revoked entitlement
     * - Reason required for audit trail
     * - Timeline entry created
     */
    async revokeEntitlement(
        entitlementId: string,
        vendorId: string,
        reason: string
    ): Promise<any> {
        // 1. Validate entitlement exists and vendor owns it
        const { default: mongoose } = await import('mongoose');

        if (!mongoose.connection.db) {
            throw createAppError(ERROR_CODES.DATABASE_CONNECTION_ERROR, 500);
        }

        const entitlement = await mongoose.connection.db
            .collection('customerdigitalentitlements')
            .findOne({
                _id: new mongoose.Types.ObjectId(entitlementId),
                vendorId: new mongoose.Types.ObjectId(vendorId),
                deletedAt: null
            });

        if (!entitlement) {
            throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404);
        }

        // 2. Check not already revoked
        if (entitlement.revokedAt !== null) {
            throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED, 422);
        }

        // 3. Revoke entitlement
        await mongoose.connection.db
            .collection('customerdigitalentitlements')
            .updateOne(
                { _id: new mongoose.Types.ObjectId(entitlementId) },
                {
                    $set: {
                        revokedAt: new Date(),
                        updatedAt: new Date()
                    }
                }
            );

        // 4. Append timeline entry to order
        await this.timelineRepo.appendEvent({
            orderId: entitlement.orderId.toString(),
            eventType: 'entitlement.revoked',
            description: `Digital entitlement revoked: ${reason}`,
            metadata: {
                entitlementId: entitlementId,
                productId: entitlement.productId.toString(),
                customerId: entitlement.customerId.toString(),
                reason
            },
            actorType: 'vendor',
            actorId: vendorId
        });

        // 5. Return revoked entitlement info
        return {
            id: entitlementId,
            revokedAt: new Date(),
            reason,
            message: 'Entitlement revoked successfully'
        };
    }

    /**
     * Restore revoked digital entitlement
     * 
     * NEW: Phase 2 - Restore customer access
     * 
     * RULES:
     * - Vendor must own the entitlement
     * - Can only restore revoked entitlements
     * - Cannot restore expired entitlements
     * - Reason required for audit trail
     * - Timeline entry created
     */
    async restoreEntitlement(
        entitlementId: string,
        vendorId: string,
        reason: string
    ): Promise<any> {
        // 1. Validate entitlement exists and vendor owns it
        const { default: mongoose } = await import('mongoose');

        if (!mongoose.connection.db) {
            throw createAppError(ERROR_CODES.DATABASE_CONNECTION_ERROR, 500);
        }

        const entitlement = await mongoose.connection.db
            .collection('customerdigitalentitlements')
            .findOne({
                _id: new mongoose.Types.ObjectId(entitlementId),
                vendorId: new mongoose.Types.ObjectId(vendorId),
                deletedAt: null
            });

        if (!entitlement) {
            throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404);
        }

        // 2. Check is currently revoked
        if (entitlement.revokedAt === null) {
            throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_REVOKED, 422);
        }

        // 3. Check not expired
        if (entitlement.expiresAt !== null && entitlement.expiresAt < new Date()) {
            throw createAppError(
                ERROR_CODES.DIGITAL_ENTITLEMENT_EXPIRED,
                422,
                undefined,
                { expiredAt: new Date(entitlement.expiresAt).toISOString() }
            );
        }

        // 4. Restore entitlement
        await mongoose.connection.db
            .collection('customerdigitalentitlements')
            .updateOne(
                { _id: new mongoose.Types.ObjectId(entitlementId) },
                {
                    $set: {
                        revokedAt: null,
                        updatedAt: new Date()
                    }
                }
            );

        // 5. Append timeline entry
        await this.timelineRepo.appendEvent({
            orderId: entitlement.orderId.toString(),
            eventType: 'entitlement.restored',
            description: `Digital entitlement restored: ${reason}`,
            metadata: {
                entitlementId: entitlementId,
                productId: entitlement.productId.toString(),
                customerId: entitlement.customerId.toString(),
                reason
            },
            actorType: 'vendor',
            actorId: vendorId
        });

        // 6. Return restored entitlement info
        return {
            id: entitlementId,
            restoredAt: new Date(),
            reason,
            message: 'Entitlement restored successfully'
        };
    }
}
