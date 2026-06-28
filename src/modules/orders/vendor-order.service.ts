import mongoose, { Types } from 'mongoose';
import { VendorOrderRepository, OrderFilters } from './vendor-order.repository';
import { OrderTimelineRepository } from './order-timeline.repository';
import { VendorOrderNoteRepository } from './vendor-order-note.repository';
import { IOrder, OrderModel, FulfillmentStatus } from './order.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { eventBus } from '../../core/events/event-bus';
import { CustomerModel } from '../customers/customer.model';
import { COLLECTIONS } from '../../core/database/collections';

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
    'cancelled': [],  // Terminal state
    'returned': []    // Terminal state — set only by the dispute-lost handler, not by vendors
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

        // Batch-fetch customer profiles for all orders in this page
        const uniqueCustomerIds = [...new Set(result.data.map(o => o.customer_id.toString()))];
        const customerMap = await this._batchResolveCustomers(uniqueCustomerIds);

        // Transform to DTO
        const dtoData = result.data.map(order => {
            const customerId = order.customer_id.toString();
            const customerProfile = customerMap.get(customerId);
            return {
                id: order._id.toString(),
                orderNumber: order.order_number,
                orderType: order.order_type,
                createdAt: order.created_at,

                customer: {
                    id: customerId,
                    name: customerProfile?.name ?? null,
                    email: customerProfile?.email ?? null,
                    avatar: customerProfile?.avatar ?? null
                },

                // Totals (immutable snapshot)
                subtotal: order.price_breakdown.base,
                tax: order.price_breakdown.tax,
                shipping: 0,
                total: order.total_amount,
                currency: order.currency,

                // Status
                fulfillmentStatus: order.fulfillment_status,
                paymentStatus: order.payment_status,

                // Item count
                itemCount: order.items.length
            };
        });

        return {
            data: dtoData,
            meta: result.meta
        };
    }

    /**
     * Get order details
     *
     * Ownership validated. Returns 404 if not found or not owned.
     * Includes delivery agency/agent info (physical orders) and vendor notes.
     */
    async getOrderDetails(orderId: string, vendorId: string): Promise<any> {
        const order = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);

        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        const customerId = order.customer_id.toString();

        // Fetch delivery info, notes, and customer data in parallel
        const [delivery, notes, customerData] = await Promise.all([
            this._resolveDeliveryInfo(order),
            this.noteRepo.findByOrder(orderId, vendorId),
            this._resolveCustomerInfo(customerId, vendorId)
        ]);

        // Transform to detailed DTO
        return {
            id: order._id.toString(),
            orderNumber: order.order_number,
            orderType: order.order_type,
            createdAt: order.created_at,
            updatedAt: order.updated_at,

            customer: {
                id: customerId,
                name: customerData?.name ?? null,
                email: customerData?.email ?? null,
                phone: customerData?.phone ?? null,
                avatar: customerData?.avatar ?? null,
                orderCount: customerData?.orderCount ?? 0,
                totalSpent: customerData?.totalSpent ?? 0
            },

            shippingAddress: customerData?.shippingAddress ?? null,

            // Line items with pricing snapshots
            items: order.items.map(item => ({
                id: item._id?.toString(),
                productId: item.product_id.toString(),
                variantId: item.variant_id.toString(),
                title: item.title,
                variantTitle: item.variant_title,
                sku: item.sku,
                optionsSnapshot: item.options_snapshot,
                quantity: item.quantity,
                price: item.price,
                subtotal: item.price * item.quantity,
                currency: item.currency
            })),

            // Pricing
            priceBreakdown: {
                base: order.price_breakdown.base,
                tax: order.price_breakdown.tax,
                discount: order.price_breakdown.discount,
                shipping: 0,
                total: order.price_breakdown.total
            },
            totalAmount: order.total_amount,
            currency: order.currency,

            // Status
            fulfillmentStatus: order.fulfillment_status,
            paymentStatus: order.payment_status,
            paymentIntentId: order.payment_intent_id,

            // Delivery (physical orders only, null for digital)
            delivery,

            // Vendor-internal notes
            notes: notes.map(note => ({
                id: note._id.toString(),
                message: note.message,
                authorId: note.author_id.toString(),
                createdAt: note.created_at
            }))
        };
    }

    /**
     * Resolve delivery agency and agent info for a physical order.
     *
     * Returns null for digital orders or orders without delivery data.
     * Looks up agency name and agent details via shipment reference.
     */
    private async _resolveDeliveryInfo(order: any): Promise<any> {
        if (order.order_type !== 'physical' || !order.items?.length) {
            return null;
        }

        const deliveryData = order.items[0].delivery;
        if (!deliveryData) {
            return null;
        }

        const db = mongoose.connection.db;

        if (!db) {
            return null;
        }

        // Look up agency name and contact in parallel with shipment lookup
        const [agency, shipment] = await Promise.all([
            deliveryData.agency_id
                ? db.collection(COLLECTIONS.DELIVERY_AGENCY).findOne(
                    { _id: deliveryData.agency_id },
                    { projection: { agency_name: 1, phone: 1, email: 1 } }
                )
                : Promise.resolve(null),
            deliveryData.shipment_id
                ? db.collection(COLLECTIONS.SHIPMENT).findOne({ _id: deliveryData.shipment_id })
                : Promise.resolve(null)
        ]);

        // Look up agent from shipment
        let agent: any = null;
        if (shipment?.agent_id) {
            const agentDoc = await db.collection(COLLECTIONS.DELIVERY_AGENT).findOne(
                { _id: shipment.agent_id },
                { projection: { name: 1, phone: 1, avatar_url: 1 } }
            );
            if (agentDoc) {
                agent = {
                    id: agentDoc._id.toString(),
                    name: agentDoc.name,
                    phone: agentDoc.phone || null,
                    avatarUrl: agentDoc.avatar_url || null
                };
            }
        }

        return {
            agencyId: deliveryData.agency_id?.toString() || null,
            agencyName: agency?.agency_name || null,
            agencyPhone: agency?.phone || null,
            deliveryStatus: deliveryData.status,
            shipmentId: deliveryData.shipment_id?.toString() || null,
            agent
        };
    }

    /**
     * Resolve full customer profile + stats for the order detail view.
     *
     * Returns name, email, phone, avatar, and per-vendor order stats.
     * Also extracts the customer's default shipping address.
     */
    private async _resolveCustomerInfo(customerId: string, vendorId: string): Promise<any> {
        const [customer, stats] = await Promise.all([
            CustomerModel.findById(customerId)
                .select('name email phone avatar_url saved_addresses')
                .lean()
                .exec() as Promise<any>,
            OrderModel.aggregate([
                {
                    $match: {
                        customer_id: new Types.ObjectId(customerId),
                        vendor_id: new Types.ObjectId(vendorId)
                    }
                },
                {
                    $group: {
                        _id: null,
                        orderCount: { $sum: 1 },
                        totalSpent: { $sum: '$total_amount' }
                    }
                }
            ])
        ]);

        if (!customer) {
            return null;
        }

        // Use the customer's default address, falling back to first address
        const defaultAddr = customer.saved_addresses?.find((a: any) => a.is_default)
            ?? customer.saved_addresses?.[0]
            ?? null;

        const shippingAddress = defaultAddr ? {
            street: defaultAddr.address_line1,
            city: defaultAddr.city,
            state: defaultAddr.state ?? null,
            country: defaultAddr.country
        } : null;

        return {
            name: customer.name,
            email: customer.email ?? null,
            phone: customer.phone ?? null,
            avatar: customer.avatar_url ?? null,
            orderCount: stats[0]?.orderCount ?? 0,
            totalSpent: stats[0]?.totalSpent ?? 0,
            shippingAddress
        };
    }

    /**
     * Batch-fetch customer profiles for a list of customer IDs.
     *
     * Returns a Map keyed by customer ID string for O(1) lookup during DTO mapping.
     */
    private async _batchResolveCustomers(customerIds: string[]): Promise<Map<string, any>> {
        if (customerIds.length === 0) return new Map();

        const customers = await CustomerModel.find({ _id: { $in: customerIds } })
            .select('name email avatar_url')
            .lean()
            .exec() as any[];

        const map = new Map<string, any>();
        for (const c of customers) {
            map.set(c._id.toString(), {
                name: c.name,
                email: c.email ?? null,
                avatar: c.avatar_url ?? null
            });
        }
        return map;
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

        // 4b. Dispute hold — a disputed charge freezes the order. No forward
        // transition (vendor or admin) is allowed until the dispute settles.
        if (order.dispute_hold?.active) {
            throw createAppError(
                ERROR_CODES.ORDER_DISPUTE_HOLD,
                423,
                undefined,
                {
                    disputeId: order.dispute_hold.gateway_dispute_id,
                    reason: order.dispute_hold.reason
                }
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
                newStatus
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
     * Ownership validated. Actor names resolved via batch lookup.
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

        // Resolve actor names in batch
        const actorNameMap = await this._resolveActorNames(result.data);

        // Transform to DTO matching frontend contract
        const dtoData = result.data.map(entry => {
            const actorId = entry.actor_id?.toString() || null;
            return {
                _id: entry._id.toString(),
                orderId: entry.order_id.toString(),
                eventType: entry.event_type,
                oldValue: entry.metadata?.previousStatus ?? null,
                newValue: entry.metadata?.newStatus ?? null,
                noteId: entry.metadata?.noteId ?? null,
                description: entry.metadata?.reason ?? entry.metadata?.messagePreview ?? entry.description,
                actor: {
                    type: entry.actor_type,
                    id: actorId,
                    name: actorId ? (actorNameMap.get(actorId) ?? null) : null
                },
                created_at: entry.created_at
            };
        });

        return {
            data: dtoData,
            meta: {
                total: result.meta.total,
                page: result.meta.page,
                limit: result.meta.limit,
                pages: result.meta.pages
            }
        };
    }

    /**
     * Batch-resolve actor display names for timeline entries.
     *
     * Vendors → business_name from vendors collection.
     * Customers → name from customers collection.
     * System → "System".
     */
    private async _resolveActorNames(entries: any[]): Promise<Map<string, string>> {
        const nameMap = new Map<string, string>();

        const vendorIds: Types.ObjectId[] = [];
        const customerIds: string[] = [];

        for (const entry of entries) {
            if (!entry.actor_id) continue;
            if (entry.actor_type === 'vendor') {
                vendorIds.push(entry.actor_id);
            } else if (entry.actor_type === 'customer') {
                customerIds.push(entry.actor_id.toString());
            }
        }

        const db = mongoose.connection.db;

        const [vendors, customers] = await Promise.all([
            vendorIds.length > 0 && db
                ? db.collection(COLLECTIONS.VENDOR)
                    .find({ _id: { $in: vendorIds } })
                    .project({ business_name: 1 })
                    .toArray()
                : Promise.resolve([]),
            customerIds.length > 0
                ? CustomerModel.find({ _id: { $in: customerIds } })
                    .select('name')
                    .lean()
                    .exec() as Promise<any[]>
                : Promise.resolve([])
        ]);

        for (const v of vendors as any[]) {
            nameMap.set(v._id.toString(), v.business_name);
        }
        for (const c of customers) {
            nameMap.set((c as any)._id.toString(), (c as any).name);
        }

        return nameMap;
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
            actorId: vendorId
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
     * Get a single vendor note by ID.
     *
     * Ownership validated via vendorId — returns 404 if note not found or not owned.
     */
    async getNoteById(noteId: string, vendorId: string): Promise<any> {
        const note = await this.noteRepo.findById(noteId, vendorId);

        if (!note) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        return {
            id: note._id.toString(),
            orderId: note.order_id.toString(),
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

        const agencyExists = await mongoose.connection.db.collection(COLLECTIONS.DELIVERY_AGENCY).findOne({
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
            .collection(COLLECTIONS.CUSTOMER_DIGITAL_ENTITLEMENT)
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
                        from: COLLECTIONS.PRODUCT,
                        localField: 'productId',
                        foreignField: '_id',
                        as: 'product'
                    }
                },
                {
                    $lookup: {
                        from: COLLECTIONS.FILE,
                        localField: 'assetId',
                        foreignField: '_id',
                        as: 'asset'
                    }
                },
                {
                    $lookup: {
                        from: COLLECTIONS.PRODUCT_VARIANT,
                        localField: 'variantId',
                        foreignField: '_id',
                        as: 'variant'
                    }
                },
                {
                    $unwind: { path: '$product', preserveNullAndEmptyArrays: true }
                },
                {
                    $unwind: { path: '$asset', preserveNullAndEmptyArrays: true }
                },
                {
                    $unwind: { path: '$variant', preserveNullAndEmptyArrays: true }
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
                variantId: e.variantId ? e.variantId.toString() : null,
                variantName: e.variant?.name || e.variant?.sku || null,
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
            .collection(COLLECTIONS.CUSTOMER_DIGITAL_ENTITLEMENT)
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
            .collection(COLLECTIONS.CUSTOMER_DIGITAL_ENTITLEMENT)
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
            .collection(COLLECTIONS.CUSTOMER_DIGITAL_ENTITLEMENT)
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
            .collection(COLLECTIONS.CUSTOMER_DIGITAL_ENTITLEMENT)
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
