import { Types } from 'mongoose';
import { ShipmentRepository } from './shipment.repository';
import { IShipment, ShipmentStatus, ShipmentRejectionReason } from './shipment.model';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { OrderModel } from '../orders/order.model';
import { OrderRepository } from '../orders/order.repository';
import { OrderFulfillmentAggregationService, orderFulfillmentAggregationService } from '../orders/domain/services/OrderFulfillmentAggregationService';
import { OrderCompletionService, orderCompletionService } from '../orders/order-completion.service';
import { transactionManager } from '../../core/database/transaction.manager';
import { VendorRepository } from '../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../delivery/delivery-agent.repository';
import { CustomerModel } from '../customers/customer.model';

// Shipment-status transitions an AGENCY may trigger directly via PATCH .../status.
// 'assigned' (system, on payment dispatch), 'delivered' (system, on customer
// confirmation only), 'rejected' (its own dedicated endpoint), and
// 'pending_agency_reassignment' (admin-deactivation cascade) are excluded.
const AGENCY_TRIGGERABLE_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
    assigned: ['picked_up'],
    picked_up: ['in_transit'],
    in_transit: ['agent_delivered', 'failed'],
    failed: ['in_transit', 'returned'],
};

/**
 * Shipment Service
 *
 * Business logic for the delivery-side shipment operations: agency self-service
 * (list/detail/status/reject/assign-agent) and the customer per-shipment
 * delivery confirmation. Every status-changing operation mirrors the new status
 * onto the order's items and recomputes the order's fulfillment_status inside
 * the same transaction (OrderFulfillmentAggregationService is the only writer
 * of the system-derived fulfillment states).
 */
export class ShipmentService {
    private shipmentRepo: ShipmentRepository;
    private orderRepo: OrderRepository;
    private vendorRepo: VendorRepository;
    private agencyRepo: DeliveryAgencyRepository;
    private agentRepo: DeliveryAgentRepository;
    private aggregationService: OrderFulfillmentAggregationService;
    private completionService: OrderCompletionService;

    constructor() {
        this.shipmentRepo = new ShipmentRepository();
        this.orderRepo = new OrderRepository();
        this.vendorRepo = new VendorRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.agentRepo = new DeliveryAgentRepository();
        this.aggregationService = orderFulfillmentAggregationService;
        this.completionService = orderCompletionService;
    }

    /**
     * Set the carrier tracking number on a shipment.
     *
     * Ownership is enforced at the query level: an agency may only touch its own
     * shipments (`agency_id`), an agent only the ones assigned to them
     * (`agent_id`). A shipment that does not match the actor's scope is reported
     * as not found, so existence of other actors' shipments is never leaked.
     */
    async setTrackingNumber(
        role: string,
        roleEntityId: string,
        shipmentId: string,
        trackingNumber: string
    ): Promise<any> {
        const filter: Record<string, unknown> = { _id: shipmentId };

        if (role === 'agency') {
            filter.agency_id = roleEntityId;
        } else if (role === 'agent') {
            filter.agent_id = roleEntityId;
        } else {
            // Routes already restrict to agency/agent; defensive guard.
            throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403);
        }

        const shipment = await this.shipmentRepo.setTrackingNumber(filter, trackingNumber);

        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        return this.toSummary(shipment);
    }

    /**
     * List shipments assigned to an agency (requirement #1), newest first.
     * Each entry carries the vendor (#4) and a redacted customer/order summary.
     */
    async listForAgency(
        agencyId: string,
        filters: { status?: ShipmentStatus } = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<Page<any>> {
        const page = await this.shipmentRepo.findByAgencyPaginated(agencyId, filters, pagination);
        if (page.data.length === 0) return { data: [], meta: page.meta };

        const orderIds = [...new Set(page.data.map(s => s.order_id.toString()))];
        const orders = await OrderModel.find({ _id: { $in: orderIds } })
            .select('order_number vendor_id customer_id')
            .lean()
            .exec();
        const orderMap = new Map(orders.map((o: any) => [o._id.toString(), o]));

        const vendorIds = [...new Set(orders.map((o: any) => o.vendor_id.toString()))];
        const customerIds = [...new Set(orders.map((o: any) => o.customer_id.toString()))];

        const [vendorMap, customerMap] = await Promise.all([
            this._batchResolveVendorNames(vendorIds),
            this._batchResolveCustomerNames(customerIds),
        ]);

        const data = page.data.map(shipment => {
            const order = orderMap.get(shipment.order_id.toString());
            const vendor = order ? vendorMap.get(order.vendor_id.toString()) : null;
            const customer = order ? customerMap.get(order.customer_id.toString()) : null;

            return {
                ...this.toSummary(shipment),
                orderNumber: order?.order_number ?? null,
                vendor: vendor ?? null,
                customer: customer ?? null,
                itemCount: shipment.items.length,
            };
        });

        return { data, meta: page.meta };
    }

    /**
     * Full detail for one of the agency's own shipments (requirements #3, #4,
     * #5): items, vendor, customer + delivery address, pickup location, and the
     * merged multi-agency timeline for the parent order.
     */
    async getDetailForAgency(agencyId: string, shipmentId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        // 'pending' means the vendor hasn't dispatched this shipment yet (or
        // auto-redirect hasn't fired) — report as not found, same as the list.
        if (!shipment || shipment.status === 'pending') {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        const order = await OrderModel.findById(shipment.order_id).lean().exec();
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        const [agency, vendor, customer, agent, siblingShipments] = await Promise.all([
            this.agencyRepo.findById(agencyId),
            this.vendorRepo.findById((order as any).vendor_id.toString()),
            CustomerModel.findById((order as any).customer_id).select('name email phone avatar_url saved_addresses').lean().exec() as Promise<any>,
            shipment.agent_id ? this.agentRepo.findById(shipment.agent_id.toString()) : Promise.resolve(null),
            this.shipmentRepo.findByOrderId(shipment.order_id.toString()),
        ]);

        // Items: join shipment's order_item_id references against the order's own
        // item snapshots for title/sku/price.
        const orderItemsById = new Map((order as any).items.map((i: any) => [i._id.toString(), i]));
        const items = shipment.items.map(si => {
            const orderItem: any = orderItemsById.get(si.order_item_id.toString());
            return {
                orderItemId: si.order_item_id.toString(),
                productId: si.product_id.toString(),
                quantity: si.quantity,
                title: orderItem?.title ?? null,
                sku: orderItem?.sku ?? null,
                variantTitle: orderItem?.variant_title ?? null,
            };
        });

        // Pickup location (#3): if the agency warehouses vendor stock
        // (storage_based), the item already sits at the agency's own HQ — nothing
        // to go pick up. Otherwise (pickup_based), the agency must collect from
        // the vendor's business address.
        const storageBasedEnabled = agency?.policies?.pricing?.storage_based?.enabled ?? false;
        const vendorAddress = vendor?.business_addresses?.[0] ?? null;
        const agencyHq = agency?.headquarters_addresses?.[0] ?? null;
        const pickupLocation = storageBasedEnabled
            ? { mode: 'storage_based' as const, alreadyInYourStorage: true, address: agencyHq }
            : { mode: 'pickup_based' as const, alreadyInYourStorage: false, address: vendorAddress };

        const defaultAddr = customer?.saved_addresses?.find((a: any) => a.is_default) ?? customer?.saved_addresses?.[0] ?? null;

        // Merged multi-agency timeline: every sibling shipment's history for this
        // order, labeled by agency, sorted chronologically.
        const timeline = await this._mergeShipmentTimelines(siblingShipments);

        return {
            ...this.toSummary(shipment),
            orderId: shipment.order_id.toString(),
            orderNumber: (order as any).order_number,
            items,
            vendor: vendor ? { id: vendor._id.toString(), businessName: vendor.business_name, phone: vendor.phone ?? null, email: vendor.email ?? null } : null,
            customer: customer ? {
                id: customer._id.toString(),
                name: customer.name,
                phone: customer.phone ?? null,
                email: customer.email ?? null,
                deliveryAddress: defaultAddr ? {
                    label: defaultAddr.label,
                    addressLine1: defaultAddr.address_line1,
                    addressLine2: defaultAddr.address_line2,
                    city: defaultAddr.city,
                    state: defaultAddr.state,
                    country: defaultAddr.country,
                } : null,
            } : null,
            pickupLocation,
            agent: agent ? { id: agent._id.toString(), name: agent.name, phone: agent.phone ?? null, avatarUrl: agent.avatar_url ?? null } : null,
            statusHistory: shipment.status_history.map(h => ({
                status: h.status,
                changedAt: h.changed_at,
                changedByUserId: h.changed_by_user_id?.toString() ?? null,
                changedByRole: h.changed_by_role,
            })),
            rejection: shipment.rejection ? {
                reason: shipment.rejection.reason,
                rejectedAt: shipment.rejection.rejectedAt,
                rejectedBy: shipment.rejection.rejectedBy.toString(),
            } : null,
            customerConfirmation: shipment.customer_confirmation ? {
                confirmedAt: shipment.customer_confirmation.confirmed_at,
                confirmedBy: shipment.customer_confirmation.confirmed_by.toString(),
            } : null,
            orderTimeline: timeline,
        };
    }

    /**
     * Agency-driven status transition (requirement #10): picked_up, in_transit,
     * agent_delivered, or a failed→in_transit/returned retry. Validated against
     * AGENCY_TRIGGERABLE_TRANSITIONS. Mirrors the new status onto every order
     * item riding this shipment and recomputes the order's fulfillment_status,
     * all inside one transaction.
     */
    async updateStatus(agencyId: string, shipmentId: string, newStatus: ShipmentStatus, actorUserId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        const allowed = AGENCY_TRIGGERABLE_TRANSITIONS[shipment.status] ?? [];
        if (!allowed.includes(newStatus)) {
            throw createAppError(ERROR_CODES.SHIPMENT_INVALID_STATUS_TRANSITION, 400, undefined, {
                from: shipment.status,
                to: newStatus,
                allowed,
            });
        }

        const orderId = shipment.order_id.toString();

        await transactionManager.runInTransaction(async (session) => {
            await this.shipmentRepo.applyStatusChange(shipmentId, newStatus, { userId: actorUserId, role: 'agency' }, session);
            await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, newStatus, session);
            await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
        });

        const updated = await this.shipmentRepo.findById(shipmentId);
        return this.toSummary(updated!);
    }

    /**
     * Reject an assigned shipment with a scoped reason (requirement #2). Only
     * allowed while still `assigned` (not yet picked up). Puts every item riding
     * it on hold (`pending_agency_reassignment`) via the same mechanism used by
     * the admin agency-deactivation cascade, so the vendor's existing
     * updateDeliveryAgency endpoint can reassign them without new logic.
     */
    async reject(agencyId: string, shipmentId: string, reason: ShipmentRejectionReason, actorUserId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        if (shipment.status !== 'assigned') {
            throw createAppError(ERROR_CODES.SHIPMENT_REJECTION_NOT_ALLOWED, 422, undefined, { status: shipment.status });
        }

        await transactionManager.runInTransaction(async (session) => {
            await this.shipmentRepo.applyRejection(shipmentId, reason, actorUserId, session);
            await this.orderRepo.holdItemsForRejectedShipment(shipmentId, session);
        });

        const updated = await this.shipmentRepo.findById(shipmentId);
        return this.toSummary(updated!);
    }

    /**
     * Assign one of the agency's own agents to a shipment (requirement #6).
     * `Shipment.agent_id` is modeled but was previously never written anywhere.
     */
    async assignAgent(agencyId: string, shipmentId: string, agentId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        const agent = await this.agentRepo.findById(agentId);
        if (!agent || agent.agency_id?.toString() !== agencyId) {
            throw createAppError(ERROR_CODES.SHIPMENT_AGENT_NOT_IN_AGENCY, 422);
        }

        const updated = await this.shipmentRepo.assignAgent(shipmentId, agentId);
        return this.toSummary(updated!);
    }

    /**
     * Customer confirms THIS shipment arrived (agent_delivered → delivered).
     * Mirrors the status onto the order's items and recomputes
     * fulfillment_status; if that recompute lands on 'delivered' (i.e. this was
     * the LAST outstanding shipment), the order's own completion is triggered
     * too — no separate order-level confirmation click required.
     */
    async confirmDeliveryByCustomer(customerId: string, orderId: string, shipmentId: string, actorUserId: string): Promise<any> {
        const order = await OrderModel.findById(orderId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }
        if (order.customer_id.toString() !== customerId) {
            throw createAppError(ERROR_CODES.SHIPMENT_ACCESS_DENIED, 403);
        }

        const shipment = await this.shipmentRepo.findById(shipmentId);
        if (!shipment || shipment.order_id.toString() !== orderId) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }
        if (shipment.status === 'delivered') {
            throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_CONFIRMED, 409);
        }
        if (shipment.status !== 'agent_delivered') {
            throw createAppError(ERROR_CODES.SHIPMENT_CONFIRMATION_NOT_ALLOWED, 422, undefined, { status: shipment.status });
        }

        await transactionManager.runInTransaction(async (session) => {
            await this.shipmentRepo.applyCustomerConfirmation(shipmentId, actorUserId, session);
            await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, 'delivered', session);
            await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
        });

        // Post-commit: if every shipment is now confirmed, complete the order too
        // (idempotent — a no-op if already completed).
        const refreshedOrder = await OrderModel.findById(orderId);
        if (refreshedOrder && refreshedOrder.fulfillment_status === 'delivered' && !refreshedOrder.completion?.confirmed_at) {
            await this.completionService.complete(refreshedOrder, 'customer', false, actorUserId);
        }

        const updated = await this.shipmentRepo.findById(shipmentId);
        return {
            ...this.toSummary(updated!),
            orderFulfillmentStatus: refreshedOrder?.fulfillment_status ?? order.fulfillment_status,
        };
    }

    /**
     * The merged multi-agency timeline for an order: every one of its
     * shipments' status_history entries, labeled by agency, sorted
     * chronologically. Used by both the agency shipment detail view and the
     * vendor's order detail view.
     */
    async getMergedTimelineForOrder(orderId: string): Promise<any[]> {
        const shipments = await this.shipmentRepo.findByOrderId(orderId);
        return this._mergeShipmentTimelines(shipments);
    }

    private async _batchResolveVendorNames(vendorIds: string[]): Promise<Map<string, any>> {
        const map = new Map<string, any>();
        await Promise.all(vendorIds.map(async id => {
            const vendor = await this.vendorRepo.findById(id);
            if (vendor) {
                map.set(id, { id, businessName: vendor.business_name, phone: vendor.phone ?? null });
            }
        }));
        return map;
    }

    private async _batchResolveCustomerNames(customerIds: string[]): Promise<Map<string, any>> {
        if (customerIds.length === 0) return new Map();
        const customers = await CustomerModel.find({ _id: { $in: customerIds } })
            .select('name phone')
            .lean()
            .exec() as any[];
        const map = new Map<string, any>();
        for (const c of customers) {
            map.set(c._id.toString(), { id: c._id.toString(), name: c.name, phone: c.phone ?? null });
        }
        return map;
    }

    /** Merge every shipment's status_history for an order into one sorted, agency-labeled timeline. */
    private async _mergeShipmentTimelines(shipments: IShipment[]): Promise<any[]> {
        const agencyIds = [...new Set(shipments.map(s => s.agency_id.toString()))];
        const agencyNameMap = new Map<string, string>();
        await Promise.all(agencyIds.map(async id => {
            const agency = await this.agencyRepo.findById(id);
            if (agency) agencyNameMap.set(id, agency.agency_name);
        }));

        const entries = shipments.flatMap(s =>
            s.status_history.map(h => ({
                shipmentId: (s._id as Types.ObjectId).toString(),
                agencyId: s.agency_id.toString(),
                agencyName: agencyNameMap.get(s.agency_id.toString()) ?? null,
                status: h.status,
                changedAt: h.changed_at,
                changedByRole: h.changed_by_role,
            }))
        );

        return entries.sort((a, b) => a.changedAt.getTime() - b.changedAt.getTime());
    }

    private toSummary(shipment: IShipment) {
        return {
            id: (shipment._id as any).toString(),
            orderId: shipment.order_id.toString(),
            agencyId: shipment.agency_id.toString(),
            agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
            status: shipment.status,
            trackingNumber: shipment.tracking_number ?? null,
            createdAt: shipment.created_at,
            updatedAt: shipment.updated_at,
        };
    }
}
