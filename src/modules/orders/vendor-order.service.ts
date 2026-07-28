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
import { ShipmentRepository } from '../shipments/shipment.repository';
import { ShipmentService } from '../shipments/shipment.service';
import { OrderService } from './order.service';
import { IProductRepository } from '../catalog/repositories/interfaces/product.repository.interface';
import { ProductRepositoryMongo } from '../catalog/repositories/mongo/product.repository.mongo';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider, IStorageProvider } from '../../core/storage';
import { resolveFileDetails, resolveFileDetail } from '../catalog/read-models/file-detail.resolver';

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

// Fulfillment State Machine — VENDOR-TRIGGERABLE transitions only.
//
// 'partially_shipped' / 'shipped' / 'partially_delivered' / 'delivered' are
// NEVER reachable here: they are computed exclusively by
// OrderFulfillmentAggregationService from the order's shipment statuses (agency
// pickup/transit/delivery actions + customer per-shipment confirmation). A
// vendor can no longer free-set an order to 'shipped'/'delivered' — doing so
// used to bypass whether the underlying shipments had actually moved.
const FULFILLMENT_STATE_MACHINE: Record<FulfillmentStatus, FulfillmentStatus[]> = {
    'pending': ['processing', 'cancelled'],
    'processing': ['cancelled'],  // 'shipped'/'partially_shipped' now system-derived only
    'partially_shipped': [],   // System-derived; terminal from the vendor's perspective
    'shipped': [],              // System-derived; terminal from the vendor's perspective
    'partially_delivered': [], // System-derived; terminal from the vendor's perspective
    'delivered': [],  // Terminal state
    'fulfilled': ['cancelled'],  // Legacy support
    'cancelled': [],  // Terminal state
    'returned': []    // Terminal state — set only by the dispute-lost handler, not by vendors
};

export class VendorOrderService {
    private vendorOrderRepo: VendorOrderRepository;
    private timelineRepo: OrderTimelineRepository;
    private noteRepo: VendorOrderNoteRepository;
    private shipmentRepo: ShipmentRepository;
    private shipmentService: ShipmentService;
    private orderService: OrderService;
    private productRepository: IProductRepository;
    private fileRepository: FileRepositoryMongo;
    private storageProvider: IStorageProvider;

    constructor() {
        this.vendorOrderRepo = new VendorOrderRepository();
        this.timelineRepo = new OrderTimelineRepository();
        this.noteRepo = new VendorOrderNoteRepository();
        this.shipmentRepo = new ShipmentRepository();
        this.shipmentService = new ShipmentService();
        this.orderService = new OrderService();
        this.productRepository = new ProductRepositoryMongo();
        this.fileRepository = new FileRepositoryMongo();
        this.storageProvider = getStorageProvider();
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
                paymentMethod: order.payment_method,
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

        // Fetch delivery info (per item), notes, customer data, and the merged
        // multi-agency shipment timeline in parallel.
        const [deliveryByItem, notes, customerData, deliveryTimeline] = await Promise.all([
            this._resolveDeliveryForItems(order),
            this.noteRepo.findByOrder(orderId, vendorId),
            this._resolveCustomerInfo(customerId, vendorId),
            order.order_type === 'physical' ? this.shipmentService.getMergedTimelineForOrder(orderId) : Promise.resolve([])
        ]);

        // Order-level overview: one entry per shipment (agencies handling this order).
        const deliveries = order.order_type === 'physical'
            ? Array.from(
                new Map(
                    Array.from(deliveryByItem.values())
                        .filter(d => d.shipmentId)
                        .map(d => [d.shipmentId, d])
                ).values()
            )
            : null;

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

            // Prefer the order's durable geocoded drop-off snapshot; fall back to
            // the customer's current default saved address for legacy orders.
            shippingAddress: this._resolveShippingAddress(order, customerData),

            // Line items with pricing snapshots. Each physical item carries its
            // own delivery block, since items can be split across agencies.
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
                currency: item.currency,
                delivery: deliveryByItem.get(item._id?.toString() ?? '') ?? null
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
            paymentMethod: order.payment_method,
            paymentStatus: order.payment_status,
            paymentIntentId: order.payment_intent_id,

            // Delivery overview: one entry per agency/shipment handling this order
            // (physical orders only, null for digital). Per-item agency lives on
            // each `items[].delivery`.
            deliveries,

            // Merged multi-agency status timeline (every shipment's history,
            // labeled by agency, chronological). Empty for digital orders.
            deliveryTimeline,

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
     * Resolve the delivery agency + agent for every physical order item.
     *
     * An order can be split across several agencies (one per item), so this
     * resolves each item's delivery independently and returns a map keyed by
     * the order item id. Agency / shipment / agent lookups are cached within
     * the call so a shared shipment is fetched only once.
     *
     * Returns an empty map for digital orders or items without delivery data.
     */
    private async _resolveDeliveryForItems(order: any): Promise<Map<string, any>> {
        const byItem = new Map<string, any>();

        if (order.order_type !== 'physical' || !order.items?.length) {
            return byItem;
        }

        const db = mongoose.connection.db;
        if (!db) {
            return byItem;
        }

        const agencyCache = new Map<string, any>();
        const shipmentCache = new Map<string, any>();
        const agentCache = new Map<string, any>();

        for (const item of order.items) {
            const deliveryData = item.delivery;
            if (!deliveryData) continue;

            const agencyId = deliveryData.agency_id?.toString() || null;
            const shipmentId = deliveryData.shipment_id?.toString() || null;

            // Agency (cached). The business name lives on the Magazin (keyed by
            // agency_id), so fetch it alongside the agency's contact fields.
            let agency: any = null;
            if (agencyId) {
                if (!agencyCache.has(agencyId)) {
                    const [agencyDoc, magazinDoc] = await Promise.all([
                        db.collection(COLLECTIONS.DELIVERY_AGENCY).findOne(
                            { _id: deliveryData.agency_id },
                            { projection: { phone: 1, email: 1 } }
                        ),
                        db.collection(COLLECTIONS.AGENCY_MAGAZIN).findOne(
                            { agency_id: deliveryData.agency_id },
                            { projection: { name: 1 } }
                        ),
                    ]);
                    agencyCache.set(agencyId, agencyDoc ? { ...agencyDoc, agency_name: magazinDoc?.name ?? null } : null);
                }
                agency = agencyCache.get(agencyId);
            }

            // Shipment (cached)
            let shipment: any = null;
            if (shipmentId) {
                if (!shipmentCache.has(shipmentId)) {
                    shipmentCache.set(shipmentId, await db.collection(COLLECTIONS.SHIPMENT).findOne({ _id: deliveryData.shipment_id }));
                }
                shipment = shipmentCache.get(shipmentId);
            }

            // Agent from shipment (cached as the built DTO, so its avatar File
            // reference is resolved to a URL once per distinct agent).
            let agent: any = null;
            if (shipment?.agent_id) {
                const agentId = shipment.agent_id.toString();
                if (!agentCache.has(agentId)) {
                    const agentDoc = await db.collection(COLLECTIONS.DELIVERY_AGENT).findOne(
                        { _id: shipment.agent_id },
                        { projection: { name: 1, phone: 1, avatar_file_id: 1, avatar_url: 1 } }
                    );
                    let built: any = null;
                    if (agentDoc) {
                        const avatar = await resolveFileDetail(agentDoc.avatar_file_id?.toString(), this.fileRepository, this.storageProvider);
                        built = {
                            id: agentDoc._id.toString(),
                            name: agentDoc.name,
                            phone: agentDoc.phone || null,
                            avatar
                        };
                    }
                    agentCache.set(agentId, built);
                }
                agent = agentCache.get(agentId);
            }

            byItem.set(item._id.toString(), {
                agencyId,
                agencyName: agency?.agency_name || null,
                agencyPhone: agency?.phone || null,
                deliveryStatus: deliveryData.status,
                shipmentId,
                trackingNumber: shipment?.tracking_number ?? null,
                agent,
                // Why the agency declined this delivery (so the vendor knows what
                // to fix before reassigning). Reason is a fixed code; `note` is the
                // agency's free-text explanation, required when reason is 'other'.
                rejection: shipment?.rejection
                    ? {
                        reason: shipment.rejection.reason,
                        note: shipment.rejection.note ?? null,
                        rejectedAt: shipment.rejection.rejectedAt ?? null
                    }
                    : null,
                freeDelivery: deliveryData.free_delivery ?? false
            });
        }

        return byItem;
    }

    /**
     * Resolve full customer profile + stats for the order detail view.
     *
     * Returns name, email, phone, avatar, and per-vendor order stats.
     * Also extracts the customer's default shipping address.
     */
    /**
     * The order's shipping address for the vendor detail view. Prefers the durable
     * geocoded drop-off snapshot taken at checkout (`order.delivery_address`),
     * exposing both the flat fields the UI already renders and the full `geo`;
     * falls back to the customer's derived default saved address for legacy orders.
     */
    private _resolveShippingAddress(order: any, customerData: any): any {
        const geo = order?.delivery_address;
        if (geo) {
            return {
                street: geo.components?.street ?? geo.formatted_address ?? '',
                city: geo.components?.city ?? '',
                state: geo.components?.region ?? null,
                country: geo.components?.country_code ?? geo.components?.country ?? '',
                geo,
            };
        }
        return customerData?.shippingAddress ?? null;
    }

    private async _resolveCustomerInfo(customerId: string, vendorId: string): Promise<any> {
        const [customer, stats] = await Promise.all([
            CustomerModel.findById(customerId)
                .select('name email phone avatar_file_id avatar_url saved_addresses')
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

        const avatar = await resolveFileDetail(customer.avatar_file_id?.toString(), this.fileRepository, this.storageProvider);

        return {
            name: customer.name,
            email: customer.email ?? null,
            phone: customer.phone ?? null,
            avatar,
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
            .select('name email avatar_file_id avatar_url')
            .lean()
            .exec() as any[];

        const avatarByFileId = await resolveFileDetails(
            customers.map((c) => c.avatar_file_id?.toString() ?? null),
            this.fileRepository,
            this.storageProvider,
        );

        const map = new Map<string, any>();
        for (const c of customers) {
            const fid = c.avatar_file_id?.toString();
            map.set(c._id.toString(), {
                name: c.name,
                email: c.email ?? null,
                avatar: fid ? avatarByFileId.get(fid) ?? null : null
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

        // 4. Payment-fulfillment coupling. Prepaid orders may only start
        // processing once paid; COD orders fulfil BEFORE payment by design —
        // the cash is collected at handoff, not up front.
        if (
            newStatus === 'processing' &&
            order.payment_status !== 'paid' &&
            order.payment_method !== 'cash_on_delivery'
        ) {
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
     * Bulk-update fulfillment status for many orders in one call.
     *
     * Each order is validated and mutated independently via the existing
     * single-order updateFulfillmentStatus (ownership, state machine, payment
     * coupling, dispute hold) — an order that fails its own check is recorded in
     * `failed` and does NOT block the rest of the batch. Same non-transactional,
     * best-effort loop idiom as reassignItemsFromDefaultAgency below.
     */
    async bulkUpdateFulfillmentStatus(
        orderIds: string[],
        vendorId: string,
        newStatus: FulfillmentStatus
    ): Promise<{
        total: number;
        succeeded: string[];
        failed: { orderId: string; code: string; reason: string }[];
    }> {
        const succeeded: string[] = [];
        const failed: { orderId: string; code: string; reason: string }[] = [];

        for (const orderId of orderIds) {
            try {
                await this.updateFulfillmentStatus(orderId, vendorId, newStatus);
                succeeded.push(orderId);
            } catch (err: any) {
                failed.push({
                    orderId,
                    code: err.code || 'UNKNOWN_ERROR',
                    reason: err.message || 'Unknown error'
                });
            }
        }

        return { total: orderIds.length, succeeded, failed };
    }

    /**
     * Bulk-dispatch many paid physical orders to their delivery agency/agencies.
     *
     * Each order goes through the same ownership + payment + dispute checks as
     * the single-order dispatchToAgency — orders that aren't dispatchable
     * (unpaid, digital, disputed, not found) are recorded in `failed` without
     * blocking the rest of the batch. `dispatchedShipments: 0` on a succeeded
     * entry means the order had nothing pending (already dispatched) — an
     * informational no-op, not a failure, matching the single-dispatch endpoint.
     */
    async bulkDispatchToAgency(
        orderIds: string[],
        vendorId: string
    ): Promise<{
        total: number;
        succeeded: { orderId: string; dispatchedShipments: number }[];
        failed: { orderId: string; code: string; reason: string }[];
    }> {
        const succeeded: { orderId: string; dispatchedShipments: number }[] = [];
        const failed: { orderId: string; code: string; reason: string }[] = [];

        for (const orderId of orderIds) {
            try {
                const result = await this.dispatchToAgency(orderId, vendorId);
                succeeded.push({ orderId, dispatchedShipments: result.dispatchedShipments });
            } catch (err: any) {
                failed.push({
                    orderId,
                    code: err.code || 'UNKNOWN_ERROR',
                    reason: err.message || 'Unknown error'
                });
            }
        }

        return { total: orderIds.length, succeeded, failed };
    }

    /**
     * Vendor explicitly dispatches a reviewed, paid order to its delivery
     * agency/agencies — the manual counterpart to the vendor's
     * `auto_redirect_orders_to_agency` setting. Advances the order's `pending`
     * shipments to `assigned`, which is what makes them visible on
     * `GET /agency/shipments` (that endpoint excludes `pending`).
     *
     * Ownership validated first (vendorOrderRepo.findByIdAndVendor); the
     * actual dispatch logic is shared with the payment-webhook auto-dispatch
     * path via OrderService.dispatchToAgency.
     */
    async dispatchToAgency(orderId: string, vendorId: string): Promise<any> {
        const owned = await this.vendorOrderRepo.findByIdAndVendor(orderId, vendorId);
        if (!owned) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        const dispatchedShipments = await this.orderService.dispatchToAgency(orderId, { type: 'vendor', id: vendorId });

        return {
            ...(await this.getOrderDetails(orderId, vendorId)),
            dispatchedShipments,
        };
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
     * Vendors → name from the Store (business-name source of truth, keyed by vendor_id).
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

        const [vendorStores, customers] = await Promise.all([
            vendorIds.length > 0 && db
                ? db.collection(COLLECTIONS.STORE)
                    .find({ vendor_id: { $in: vendorIds } })
                    .project({ vendor_id: 1, name: 1 })
                    .toArray()
                : Promise.resolve([]),
            customerIds.length > 0
                ? CustomerModel.find({ _id: { $in: customerIds } })
                    .select('name')
                    .lean()
                    .exec() as Promise<any[]>
                : Promise.resolve([])
        ]);

        for (const s of vendorStores as any[]) {
            nameMap.set(s.vendor_id.toString(), s.name);
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
        itemId: string,
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

        // 3. Locate the target item. Reassignment is item-scoped: only this item
        //    moves agency, the rest of the order is untouched.
        const item = order.items.find(i => i._id?.toString() === itemId);
        if (!item || !item.delivery) {
            throw createAppError(ERROR_CODES.ORDER_ITEM_NOT_FOUND, 404, undefined, { itemId });
        }

        const previousAgencyId = item.delivery.agency_id?.toString() || null;

        // No-op: item already with the requested agency.
        if (previousAgencyId === deliveryAgencyId) {
            return this.getOrderDetails(orderId, vendorId);
        }

        // 4. An item already picked up / in transit / delivered / returned cannot be
        //    handed to another agency — only items still pending, assigned, or held
        //    (agency vanished, awaiting reassignment) can move.
        if (!['pending', 'assigned', 'pending_agency_reassignment'].includes(item.delivery.status)) {
            throw createAppError(
                ERROR_CODES.ORDER_ITEM_NOT_REASSIGNABLE,
                422,
                'This item has already been dispatched and cannot be reassigned to another agency',
                { itemId, status: item.delivery.status }
            );
        }

        // 5. Validate the destination agency exists.
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

        // Business name lives on the Magazin (keyed by agency_id).
        const magazinDoc = await mongoose.connection.db.collection(COLLECTIONS.AGENCY_MAGAZIN).findOne(
            { agency_id: new mongoose.Types.ObjectId(deliveryAgencyId) },
            { projection: { name: 1 } }
        );
        const agencyName = magazinDoc?.name || null;

        // 6. Move the item between agency shipments (the dispatch source of truth).
        //    Reuse the destination agency's open shipment for this order if one
        //    exists, otherwise create a fresh one.
        let destShipment = await this.shipmentRepo.findGroupableByOrderAndAgency(orderId, deliveryAgencyId);
        if (destShipment) {
            await this.shipmentRepo.addItem(destShipment._id!.toString(), {
                order_item_id: item._id,
                product_id: item.product_id,
                quantity: item.quantity
            });
        } else {
            destShipment = await this.shipmentRepo.create({
                order_id: order._id as any,
                agency_id: new mongoose.Types.ObjectId(deliveryAgencyId) as any,
                status: 'pending',
                items: [{
                    order_item_id: item._id,
                    product_id: item.product_id,
                    quantity: item.quantity
                }]
            });
        }

        // Detach the item from its previous shipment (deletes it if now empty).
        const previousShipmentId = item.delivery.shipment_id?.toString() || null;
        if (previousShipmentId) {
            await this.shipmentRepo.removeItem(previousShipmentId, itemId);
        }

        // 7. Point the order item at its new agency + shipment. The item inherits
        //    the destination shipment's status (pending for a new one).
        const updatedOrder = await this.vendorOrderRepo.reassignItemDeliveryAgency(
            orderId,
            vendorId,
            itemId,
            deliveryAgencyId,
            destShipment._id!.toString(),
            destShipment.status
        );

        if (!updatedOrder) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        // 8. Append timeline entry (scoped to the item that moved).
        await this.timelineRepo.appendEvent({
            orderId,
            eventType: 'delivery.agency_updated',
            description: `Delivery agency for "${item.title}" changed to ${agencyName || deliveryAgencyId}`,
            metadata: {
                itemId,
                newAgencyId: deliveryAgencyId,
                agencyName: agencyName || 'Unknown',
                previousAgencyId,
                shipmentId: destShipment._id!.toString()
            },
            actorType: 'vendor',
            actorId: vendorId
        });

        // 9. Return updated order
        return this.getOrderDetails(orderId, vendorId);
    }

    /**
     * Auto-reassign order items riding on the vendor's OLD default delivery agency
     * over to the NEW one, when the vendor's default agency changes (either the
     * agency was deactivated and they picked a different one, or they just switched).
     *
     * Only items whose PRODUCT has no explicit delivery.agencyId override are
     * touched — a product with its own agency choice keeps it regardless of the
     * vendor's default changing; only items that were riding on "no override, use
     * the default" are considered "assigned to the default agency". Only items
     * still `pending`/`assigned` (not yet dispatched) are reassignable.
     *
     * Best-effort: runs outside any DB transaction (shipment/order writes in
     * updateDeliveryAgency aren't session-aware, matching that method's existing
     * behavior), reuses updateDeliveryAgency per item, and collects failures
     * rather than aborting the whole batch.
     */
    async reassignItemsFromDefaultAgency(
        vendorId: string,
        fromAgencyId: string,
        toAgencyId: string,
    ): Promise<{ reassignedCount: number; skipped: { orderId: string; itemId: string; reason: string }[] }> {
        const skipped: { orderId: string; itemId: string; reason: string }[] = [];
        let reassignedCount = 0;

        const candidates = await this.vendorOrderRepo.findReassignableByVendorAndAgency(vendorId, fromAgencyId);

        for (const order of candidates) {
            const orderId = (order._id as any).toString();

            for (const item of order.items) {
                if (!item.delivery) continue;
                if (item.delivery.agency_id?.toString() !== fromAgencyId) continue;
                if (!['pending', 'assigned', 'pending_agency_reassignment'].includes(item.delivery.status)) continue;

                const itemId = item._id.toString();

                const product = await this.productRepository.findById(item.product_id.toString(), vendorId);
                if (product?.delivery?.agencyId) {
                    skipped.push({ orderId, itemId, reason: 'Product has its own delivery agency override' });
                    continue;
                }

                try {
                    await this.updateDeliveryAgency(orderId, vendorId, itemId, toAgencyId);
                    reassignedCount++;
                } catch (err: any) {
                    skipped.push({ orderId, itemId, reason: err.message || 'Unknown error' });
                }
            }
        }

        return { reassignedCount, skipped };
    }

    /**
     * Auto-reassign a SINGLE PRODUCT's order items riding on its OLD delivery-agency
     * override over to the NEW one, when a vendor fixes that product's own override
     * (as opposed to reassignItemsFromDefaultAgency, which fires on a vendor
     * default change and applies across every product that has no override).
     * No product-override check needed here — every candidate item belongs to
     * this one product, and we already know it has an override (that's why this
     * path is firing).
     */
    async reassignItemsForProduct(
        vendorId: string,
        productId: string,
        fromAgencyId: string,
        toAgencyId: string,
    ): Promise<{ reassignedCount: number; skipped: { orderId: string; itemId: string; reason: string }[] }> {
        const skipped: { orderId: string; itemId: string; reason: string }[] = [];
        let reassignedCount = 0;

        const candidates = await this.vendorOrderRepo.findReassignableByProductAndAgency(vendorId, productId, fromAgencyId);

        for (const order of candidates) {
            const orderId = (order._id as any).toString();

            for (const item of order.items) {
                if (!item.delivery) continue;
                if (item.product_id.toString() !== productId) continue;
                if (item.delivery.agency_id?.toString() !== fromAgencyId) continue;
                if (!['pending', 'assigned', 'pending_agency_reassignment'].includes(item.delivery.status)) continue;

                const itemId = item._id.toString();

                try {
                    await this.updateDeliveryAgency(orderId, vendorId, itemId, toAgencyId);
                    reassignedCount++;
                } catch (err: any) {
                    skipped.push({ orderId, itemId, reason: err.message || 'Unknown error' });
                }
            }
        }

        return { reassignedCount, skipped };
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
