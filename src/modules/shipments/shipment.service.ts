import { Types } from 'mongoose';
import { ShipmentRepository } from './shipment.repository';
import { IShipment, ShipmentStatus, ShipmentRejectionReason, IShipmentHandover, IShipmentHandoverPickup } from './shipment.model';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { IOrder, OrderModel } from '../orders/order.model';
import { ICashCollection } from '../cod/models/cash-collection.model';
import { OrderRepository } from '../orders/order.repository';
import { OrderFulfillmentAggregationService, orderFulfillmentAggregationService } from '../orders/domain/services/OrderFulfillmentAggregationService';
import { OrderCompletionService, orderCompletionService } from '../orders/order-completion.service';
import { transactionManager } from '../../core/database/transaction.manager';
import { VendorRepository } from '../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../delivery/delivery-agency.repository';
import {
    AgentRepository,
    agentCapacityService,
} from '../agents';
import { CustomerModel } from '../customers/customer.model';
import { cashCollectionService } from '../cod/services/cash-collection.service';
import { eventBus } from '../../core/events/event-bus';
import { agentActionAuditService } from '../tracking-integration/services/agent-action-audit.service';
import { shipmentAssignmentOfferRepository } from '../shipment-assignment/repositories/shipment-assignment-offer.repository';

// Shipment-status transitions an AGENCY may trigger directly via PATCH .../status.
// 'assigned' (system, on payment dispatch), 'delivered' (system, on customer
// confirmation only), 'rejected' (its own dedicated endpoint), and
// 'pending_agency_reassignment' (admin-deactivation cascade) are excluded.
const AGENCY_TRIGGERABLE_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
    assigned: ['picked_up'],
    picked_up: ['in_transit'],
    in_transit: ['agent_delivered', 'failed'],
    // A claim of arrival is not proof of one. It can still fail — the customer
    // is out, refuses the parcel, or (COD) will not pay — and without this the
    // shipment would be stranded: 'delivered' is reachable only by the customer
    // confirming or, for COD, by the delivery code, and neither is coming.
    agent_delivered: ['failed'],
    failed: ['in_transit', 'returned'],
    // A shipment handed over after a post-pickup reassignment resumes when its
    // replacement agent picks the parcel up (guarded on agent_id, so the new
    // agent must have accepted first); 'returned' is the escape hatch.
    handing_over: ['picked_up', 'returned'],
};

// Agent → agent reassignment: the status a shipment resets to when it is pulled
// off its current agent. Pre-pickup it goes back to the agency queue as
// `assigned` (the parcel never left); once picked up, the parcel is physically
// with the old agent, so it enters `handing_over` until a replacement agent picks
// it up. Statuses absent here are not reassignable (pending / agent_delivered /
// terminal / already-held).
const REASSIGNMENT_TARGET_STATUS: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
    assigned: 'assigned',
    picked_up: 'handing_over',
    in_transit: 'handing_over',
    failed: 'handing_over',
    // A returned parcel is re-dispatched to a new agent (Rule 2: original pickup).
    returned: 'handing_over',
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
    private agentRepo: AgentRepository;
    private aggregationService: OrderFulfillmentAggregationService;
    private completionService: OrderCompletionService;

    constructor() {
        this.shipmentRepo = new ShipmentRepository();
        this.orderRepo = new OrderRepository();
        this.vendorRepo = new VendorRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.agentRepo = new AgentRepository();
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
        return this._enrichShipmentPage(page);
    }

    /**
     * List shipments assigned to an AGENT (the agent app's work queue), with
     * the same vendor/customer enrichment as the agency list.
     */
    async listForAgent(
        agentId: string,
        filters: { status?: ShipmentStatus } = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<Page<any>> {
        const page = await this.shipmentRepo.findByAgentPaginated(agentId, filters, pagination);
        return this._enrichShipmentPage(page);
    }

    /** Shared list enrichment: vendor + redacted customer/order summary per shipment. */
    private async _enrichShipmentPage(page: Page<IShipment>): Promise<Page<any>> {
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
        return this._buildDetail(shipment);
    }

    /**
     * Full detail for a shipment assigned to this AGENT — same payload as the
     * agency detail (items, pickup locations, customer + delivery address,
     * COD summary), scoped by agent_id.
     */
    async getDetailForAgent(agentId: string, shipmentId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }
        return this._buildDetail(shipment);
    }

    /** Shared detail assembly for the agency and agent views. */
    private async _buildDetail(shipment: IShipment): Promise<any> {
        const agencyId = shipment.agency_id.toString();

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
        // item snapshots for title/sku/price. Pickup location (#3) is resolved
        // per item from the snapshot taken at order-creation time (the product's
        // configured pickup_location — see ProductStatusValidationService /
        // order.service.ts) rather than guessed from the vendor's first address —
        // a shipment can carry several of the vendor's products, each configured
        // differently. The agency's own HQ address is still resolved live (not
        // snapshotted) since it isn't vendor/product-specific.
        const agencyHq = agency?.headquarters_addresses?.[0] ?? null;
        const orderItemsById = new Map((order as any).items.map((i: any) => [i._id.toString(), i]));
        const items = shipment.items.map(si => {
            const orderItem: any = orderItemsById.get(si.order_item_id.toString());
            const pl = orderItem?.delivery?.pickup_location;
            const pickupLocation = !pl
                ? null // legacy order item predating this feature
                : pl.source === 'agency_storage'
                    ? { mode: 'storage_based' as const, alreadyInYourStorage: true, address: agencyHq }
                    : { mode: 'pickup_based' as const, alreadyInYourStorage: false, address: pl.address_snapshot ?? null };
            return {
                orderItemId: si.order_item_id.toString(),
                productId: si.product_id.toString(),
                quantity: si.quantity,
                title: orderItem?.title ?? null,
                sku: orderItem?.sku ?? null,
                variantTitle: orderItem?.variant_title ?? null,
                pickupLocation,
            };
        });

        const defaultAddr = customer?.saved_addresses?.find((a: any) => a.is_default) ?? customer?.saved_addresses?.[0] ?? null;

        // Merged multi-agency timeline: every sibling shipment's history for this
        // order, labeled by agency, sorted chronologically.
        const timeline = await this._mergeShipmentTimelines(siblingShipments);

        // COD: the cash this shipment's agent must collect + collection state.
        // Never includes the delivery code — that is customer-only.
        const cod = (order as any).payment_method === 'cash_on_delivery'
            ? await cashCollectionService.getCodSummaryForShipment((shipment._id as Types.ObjectId).toString())
            : null;

        return {
            ...this.toSummary(shipment),
            orderId: shipment.order_id.toString(),
            orderNumber: (order as any).order_number,
            paymentMethod: (order as any).payment_method ?? 'online',
            cod,
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
            agent: agent ? { id: agent._id.toString(), name: agent.name, phone: agent.phone ?? null, avatarUrl: agent.avatar_url ?? null } : null,
            // Reassignment handover: where the (replacement) agent collects this
            // shipment, when it was reassigned. Null for a first-assigned shipment.
            handover: shipment.handover ? {
                pickup: shipment.handover.pickup,
                fromAgentId: shipment.handover.from_agent_id?.toString() ?? null,
                fromStatus: shipment.handover.from_status,
                reassignedAt: shipment.handover.reassigned_at,
            } : null,
            statusHistory: shipment.status_history.map(h => ({
                status: h.status,
                changedAt: h.changed_at,
                changedByUserId: h.changed_by_user_id?.toString() ?? null,
                changedByRole: h.changed_by_role,
            })),
            rejection: shipment.rejection ? {
                reason: shipment.rejection.reason,
                note: shipment.rejection.note ?? null,
                rejectedAt: shipment.rejection.rejectedAt,
                rejectedBy: shipment.rejection.rejectedBy.toString(),
            } : null,
            customerConfirmation: shipment.customer_confirmation ? {
                confirmedAt: shipment.customer_confirmation.confirmed_at,
                // null when the dispute window lapsed and the sweep confirmed it.
                confirmedBy: shipment.customer_confirmation.confirmed_by?.toString() ?? null,
                auto: shipment.customer_confirmation.auto ?? false,
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
        const order = await OrderModel.findById(orderId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }
        const isCod = order.payment_method === 'cash_on_delivery';

        // An agent must have ACCEPTED the shipment before it can be picked up.
        // Under the agent-acceptance workflow `agent_id` is written only on
        // acceptance, so its absence means no agent has taken the job. (This was
        // previously a COD-only guard for cash accountability; it now holds for
        // prepaid too — a shipment must not leave the agency unaccepted.)
        if (newStatus === 'picked_up' && !shipment.agent_id) {
            throw createAppError(ERROR_CODES.SHIPMENT_AGENT_NOT_ASSIGNED, 422,
                'An agent must accept this shipment before it can be picked up');
        }

        if (isCod) {
            // A COD agent MAY claim arrival with `agent_delivered` — it means "I
            // am at the door", not "this is delivered". It is deliberately a
            // dead end for COD: only the customer's code moves it to 'delivered'
            // (see CashCollectionService.collect), because an unverified "agent
            // says delivered" claim is exactly what the code exists to prevent.
            // The response tells the agent to submit the code next.
            if (newStatus === 'delivered') {
                throw createAppError(ERROR_CODES.SHIPMENT_INVALID_STATUS_TRANSITION, 400,
                    'COD shipments are delivered by the agent submitting the customer delivery code, not by a status change', {
                    from: shipment.status,
                    to: newStatus,
                });
            }
        }

        // Captured inside the transaction, used for the post-commit customer
        // notification (the plaintext code never lives in the txn scope alone).
        // `code` is null when the collection already existed — nothing to send.
        let issuedCode: { collection: ICashCollection; code: string | null } | null = null;

        await transactionManager.runInTransaction(async (session) => {
            await this.shipmentRepo.applyStatusChange(shipmentId, newStatus, { userId: actorUserId, role: 'agency' }, session);
            await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, newStatus, session);
            await this.aggregationService.recomputeFulfillmentStatus(orderId, session);

            if (isCod && newStatus === 'picked_up') {
                // Safety net, not the normal path: the collection is normally
                // created at agent assignment (see assignAgent), which for COD
                // always precedes pickup. This keeps the older invariant — a
                // picked-up COD shipment can never exist without its collection
                // record — true for shipments assigned before that hook existed.
                // Idempotent: an existing collection yields code: null.
                issuedCode = await cashCollectionService.ensureForShipmentInSession(order, shipment, session);
            }
            if (isCod && newStatus === 'returned') {
                await cashCollectionService.handleShipmentReturnedInSession(shipmentId, orderId, session);
            }
        });

        // Only notify when a code was actually minted here; a collection that
        // already existed (the normal case now, created at assignment) returns
        // code: null and the customer already has it.
        const picked = issuedCode as { collection: any; code: string | null } | null;
        if (picked?.code) {
            await cashCollectionService.notifyCodeIssued(order, picked.collection, picked.code);
        }

        const updated = await this.shipmentRepo.findById(shipmentId);
        this._emitTrackingStatusChanged(updated!, order.customer_id?.toString() ?? null);
        // A returned shipment has left the agent's active set — give the capacity
        // slot reserved on acceptance back. ('failed' stays active: the agent is
        // still holding the parcel and may retry via failed → in_transit.)
        if (newStatus === 'returned') {
            this._releaseAgentCapacity(updated, 'returned');
        }
        // Phase 6: record the agent-action audit for a pickup/delivery/return/
        // cancel transition (fire-and-forget; a no-op for other statuses or when
        // the shipment carries no agent).
        void agentActionAuditService
            .emitShipmentTransition(updated!, 'agency')
            .catch((err) => console.error('[ShipmentService] agent-action audit emit failed:', err));

        // A COD agent who has just announced arrival is not finished: the parcel
        // is handed over against the customer's code, and only that code marks it
        // delivered. Say so in the response rather than leaving the app to infer
        // it from payment_method — this is the one moment the agent must be told
        // what to do next.
        const requiresDeliveryCode = isCod && updated!.status === 'agent_delivered';

        return {
            ...this.toSummary(updated!),
            requiresDeliveryCode,
            ...(requiresDeliveryCode
                ? { nextAction: 'Ask the customer for their delivery code and submit it to record the cash and complete the delivery.' }
                : {}),
        };
    }

    /**
     * Fire-and-forget notify the live-tracking integration (geo-tracker, via the
     * outbox) that a shipment's status changed, so an agency/customer that can no
     * longer track its agent loses access immediately. Best-effort: a failure
     * here never affects the delivery flow (mirrors the codebase's post-commit
     * event emission pattern). Terminal statuses are what actually revoke; other
     * transitions are re-checked and kept if still valid on the geo-tracker side.
     */
    private _emitTrackingStatusChanged(shipment: IShipment, customerId: string | null): void {
        void eventBus.publish('shipment.status_changed', {
            eventType: 'shipment.status_changed',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                agencyId: shipment.agency_id.toString(),
                agentId: shipment.agent_id ? shipment.agent_id.toString() : null,
                customerId,
                status: shipment.status,
            },
        }).catch((err) => console.error('[ShipmentService] tracking emit failed:', err));
    }

    /**
     * Fire-and-forget notify the live-tracking integration that a specific agent
     * was RELEASED from a shipment (an agent → agent reassignment), so geo-tracker
     * closes that agent's tracking session and the agency/customer immediately
     * lose visibility of them for this shipment. Unlike a terminal status this is
     * a *release* — the shipment is not over, so no outcome is stamped and a fresh
     * session opens the moment the replacement agent accepts. Carries the RELEASED
     * agent's id (not the shipment's current `agent_id`, which is now null).
     */
    private _emitAgentReleased(shipment: IShipment, releasedAgentId: string, customerId: string | null): void {
        void eventBus.publish('shipment.agent_released', {
            eventType: 'shipment.agent_released',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                agencyId: shipment.agency_id.toString(),
                agentId: releasedAgentId,
                customerId,
            },
        }).catch((err) => console.error('[ShipmentService] agent_released emit failed:', err));
    }

    /**
     * Fire-and-forget business audit of an agent → agent reassignment (for
     * dashboards / future consumers). Purely observational — the tracking release
     * rides `_emitAgentReleased`, and the durable record is the shipment's
     * `status_history` + the assignment offer rows.
     */
    private _emitReassigned(shipment: IShipment, previousAgentId: string, previousStatus: ShipmentStatus, reason: string, orderNumber: string | null): void {
        void eventBus.publish('shipment.reassigned', {
            eventType: 'shipment.reassigned',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                orderNumber,
                agencyId: shipment.agency_id.toString(),
                previousAgentId,
                previousStatus,
                newStatus: shipment.status,
                reason,
            },
        }).catch((err) => console.error('[ShipmentService] reassigned emit failed:', err));
    }

    /**
     * Give back the capacity slot an agent reserved when they accepted this
     * shipment, now that it has left their active set (delivered / returned /
     * rejected). Best-effort and post-commit: `release` guards against a
     * double-release (it never throws), and the nightly capacity reconcile is the
     * backstop for any missed release. A no-op when the shipment had no agent.
     */
    private _releaseAgentCapacity(shipment: IShipment | null, reason: 'delivered' | 'returned' | 'rejected'): void {
        const agentId = shipment?.agent_id?.toString();
        if (!agentId) return;
        void agentCapacityService
            .release(agentId, reason)
            .catch((err) => console.error('[ShipmentService] capacity release failed:', err));
    }

    /**
     * Reject an assigned shipment with a scoped reason (requirement #2). Only
     * allowed while still `assigned` (not yet picked up). Puts every item riding
     * it on hold (`pending_agency_reassignment`) via the same mechanism used by
     * the admin agency-deactivation cascade, so the vendor's existing
     * updateDeliveryAgency endpoint can reassign them without new logic.
     */
    async reject(agencyId: string, shipmentId: string, reason: ShipmentRejectionReason, note: string | null, actorUserId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        if (shipment.status !== 'assigned') {
            throw createAppError(ERROR_CODES.SHIPMENT_REJECTION_NOT_ALLOWED, 422, undefined, { status: shipment.status });
        }

        await transactionManager.runInTransaction(async (session) => {
            await this.shipmentRepo.applyRejection(shipmentId, reason, note, actorUserId, session);
            await this.orderRepo.holdItemsForRejectedShipment(shipmentId, session);
            // Kill any live offer on this shipment: the agency is declining the
            // whole shipment for reassignment, so an outstanding offer must not
            // remain acceptable on a shipment that has left this agency.
            await shipmentAssignmentOfferRepository.cancelPendingForShipment(shipmentId, session);
        });

        const updated = await this.shipmentRepo.findById(shipmentId);
        this._emitTrackingStatusChanged(updated!, null);
        // If an agent had already accepted (agent_id set while still 'assigned'),
        // free the capacity slot they reserved — the shipment is leaving them.
        this._releaseAgentCapacity(updated, 'rejected');
        // Phase 6: a rejection is an audited 'cancel' action for the agent on the
        // shipment (no-op if it was never assigned to one).
        void agentActionAuditService
            .emitShipmentTransition(updated!, 'agency')
            .catch((err) => console.error('[ShipmentService] agent-action audit emit failed:', err));
        // Tell the vendor their delivery was declined so they can reassign — the
        // reason + note live on the order view (this only alerts + deep-links).
        void this._emitShipmentRejected(updated!, reason, note ?? null)
            .catch((err) => console.error('[ShipmentService] shipment.rejected emit failed:', err));
        return this.toSummary(updated!);
    }

    /**
     * Notify the vendor that an agency declined a shipment's delivery. Enriches
     * the event with the recipient (vendorId), order number, and agency name at
     * emit time — the notification handler does no DB enrichment of its own.
     * Best-effort and post-commit: a failure here never affects the rejection.
     */
    private async _emitShipmentRejected(shipment: IShipment, reason: ShipmentRejectionReason, note: string | null): Promise<void> {
        const order = await OrderModel.findById(shipment.order_id).select('order_number vendor_id').lean().exec();
        if (!order) return;
        const agency = await this.agencyRepo.findById(shipment.agency_id.toString());

        await eventBus.publish('shipment.rejected', {
            eventType: 'shipment.rejected',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                orderNumber: (order as any).order_number ?? null,
                vendorId: (order as any).vendor_id?.toString() ?? null,
                agencyId: shipment.agency_id.toString(),
                agencyName: agency?.agency_name ?? null,
                reason,
                note,
            },
        });
    }

    /**
     * Detach a shipment's current agent for an agent → agent reassignment — the
     * primitive the assignment orchestrator (ShipmentAssignmentService.reassign)
     * calls before offering the shipment to a replacement. This is deliberately
     * NOT a public re-offer: it only removes the old agent, leaving the shipment
     * offerable again.
     *
     * The status the shipment resets to depends on whether the parcel has left
     * the agency (REASSIGNMENT_TARGET_STATUS): pre-pickup it returns to the queue
     * as `assigned`; post-pickup it enters `handing_over` (the parcel is with the
     * old agent, awaiting physical handover to the replacement) and its order
     * items are re-mirrored + fulfillment recomputed, exactly as a forward
     * transition would.
     *
     * The detach is a guarded compare-and-set (`claimForReassignment`) on the
     * exact (agent, status) read here, so a concurrent accept / pickup / collect /
     * second reassign makes it miss and raise `SHIPMENT_REASSIGNMENT_CONFLICT`
     * rather than double-detaching — the race guard.
     *
     * Post-commit and best-effort, the OLD agent is torn down: its tracking
     * session is RELEASED (not terminated — the shipment is not over, it merely
     * left this agent) and its reserved capacity slot is returned. Working-state
     * recompute is left to the caller (it owns the availability service).
     */
    async reassignAgent(
        agencyId: string,
        shipmentId: string,
        reason: string,
        actorUserId: string | null,
        handoverPickup: IShipmentHandoverPickup | null = null
    ): Promise<{ shipment: IShipment; previousAgentId: string; previousStatus: ShipmentStatus }> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        const previousAgentId = shipment.agent_id ? shipment.agent_id.toString() : null;
        if (!previousAgentId) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_REASSIGNABLE, 422,
                'This shipment has no agent bound to reassign from');
        }

        const previousStatus = shipment.status;
        const targetStatus = REASSIGNMENT_TARGET_STATUS[previousStatus];
        if (!targetStatus) {
            throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED, 422, undefined, {
                status: previousStatus,
            });
        }

        const orderId = shipment.order_id.toString();
        const order = await OrderModel.findById(orderId);
        // Never re-open a settled order: reassigning a `returned`/`failed` shipment
        // whose order has already completed (escrow released, COD settled) would
        // strand money. Refuse and tell the agency the order is closed.
        if (order?.completion?.confirmed_at) {
            throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED, 422,
                'This order has already been completed and its shipments can no longer be reassigned', {
                status: previousStatus,
            });
        }

        // The handover record captured atomically with the detach — where the
        // replacement collects, and the agent/status it came from.
        const handover: IShipmentHandover | null = handoverPickup
            ? {
                pickup: handoverPickup,
                from_agent_id: new Types.ObjectId(previousAgentId),
                from_status: previousStatus,
                reassigned_at: new Date(),
            }
            : null;

        let detached: IShipment | null = null;
        // Set when re-opening a RETURNED COD shipment for re-delivery — a fresh
        // delivery code to send the customer post-commit.
        let reopened: { collection: ICashCollection; code: string } | { collection: null; code: null } = { collection: null, code: null };
        await transactionManager.runInTransaction(async (session) => {
            detached = await this.shipmentRepo.claimForReassignment(
                shipmentId, agencyId, previousAgentId, previousStatus, targetStatus, actorUserId, handover, session
            );
            // The CAS missed — the shipment moved since we read it (a concurrent
            // accept / pickup / collect / reassign). Fail closed, don't double-detach.
            if (!detached) {
                throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_CONFLICT, 409, undefined, {
                    expectedAgentId: previousAgentId,
                    expectedStatus: previousStatus,
                });
            }
            // Re-mirror the order items + recompute fulfillment only when the status
            // actually moved (post-pickup → handing_over); an `assigned → assigned`
            // reset leaves item statuses untouched.
            if (targetStatus !== previousStatus) {
                await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, targetStatus, session);
                await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
            }
            // Re-opening a RETURNED shipment for re-delivery: returning it cancelled
            // its COD code and drove payment to a terminal `failed`. Revive both, or
            // the replacement can never record the cash and reach `delivered`.
            if (previousStatus === 'returned' && order) {
                reopened = await cashCollectionService.reopenForRedeliveryInSession(order, detached, session);
            }
            // Defensive: a bound agent has no pending offer, but cancel any stray one
            // so nothing can be accepted onto a shipment that just changed hands.
            await shipmentAssignmentOfferRepository.cancelPendingForShipment(shipmentId, session);
        });

        // ── post-commit, best-effort teardown of the OLD agent ──────────────────
        // Release (not terminate) the old agent's tracking session and drop the
        // agency/customer's visibility of them for this shipment.
        this._emitAgentReleased(detached!, previousAgentId, order?.customer_id?.toString() ?? null);
        // Give back the capacity slot the old agent reserved on acceptance — UNLESS
        // the shipment was `returned`, which already released it (double-release
        // would only trip the drift warning).
        if (previousStatus !== 'returned') {
            void agentCapacityService
                .release(previousAgentId, 'reassigned')
                .catch((err) => console.error('[ShipmentService] reassign capacity release failed:', err));
        }
        // Send the customer their fresh delivery code, if we re-opened a returned
        // COD shipment.
        const reissued = reopened as { collection: ICashCollection; code: string } | { collection: null; code: null };
        if (reissued.code && order) {
            await cashCollectionService.notifyCodeIssued(order, reissued.collection, reissued.code);
        }
        // Business audit of the reassignment + the old agent's "you're off this
        // shipment" notification (the handler keys on this event).
        this._emitReassigned(detached!, previousAgentId, previousStatus, reason, order?.order_number ?? null);

        return { shipment: detached!, previousAgentId, previousStatus };
    }

    /**
     * Customer confirms THIS shipment arrived (agent_delivered → delivered).
     * Mirrors the status onto the order's items and recomputes
     * fulfillment_status; if that recompute lands on 'delivered' (i.e. this was
     * the LAST outstanding shipment), the order's own completion is triggered
     * too — no separate order-level confirmation click required.
     *
     * ONLINE-PAID ONLY. For COD the customer's confirmation IS their delivery
     * code, and it must arrive through `CashCollectionService.collect` so the
     * cash is recorded in the same transaction as the delivery. Letting this
     * endpoint confirm a COD shipment would mark it delivered with its
     * collection still `pending` — no allocations for anyone (not even the
     * vendor), no cash liability on the agent, an order whose payment status
     * stays a lie, and nothing downstream able to notice: the split-recovery
     * sweep only looks at `collected` collections, and the shipment auto-confirm
     * sweep only at `agent_delivered` shipments. It breaks the invariant
     * `recomputeCodPaymentStatusInSession` is built on — for COD, delivered ⟺
     * cash collected.
     *
     * COD only became reachable here in step 3d, which let a COD agent mark
     * `agent_delivered` on arrival; before that the state machine kept COD out
     * of this path on its own.
     */
    async confirmDeliveryByCustomer(customerId: string, orderId: string, shipmentId: string, actorUserId: string): Promise<any> {
        const order = await OrderModel.findById(orderId);
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }
        if (order.customer_id.toString() !== customerId) {
            throw createAppError(ERROR_CODES.SHIPMENT_ACCESS_DENIED, 403);
        }
        if (order.payment_method === 'cash_on_delivery') {
            throw createAppError(
                ERROR_CODES.SHIPMENT_CONFIRMATION_NOT_ALLOWED,
                422,
                'Cash-on-delivery shipments are confirmed by giving the agent your delivery code, not by confirming here',
                { paymentMethod: order.payment_method }
            );
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

        const { order: refreshedOrder } = await this._applyDeliveryConfirmation(shipmentId, orderId, actorUserId, false);

        const updated = await this.shipmentRepo.findById(shipmentId);
        this._emitTrackingStatusChanged(updated!, customerId);
        return {
            ...this.toSummary(updated!),
            orderFulfillmentStatus: refreshedOrder?.fulfillment_status ?? order.fulfillment_status,
        };
    }

    /**
     * Confirm one shipment's delivery and, if that finished the order, complete
     * the order too.
     *
     * Shared by the customer's explicit confirmation and the auto-confirm sweep,
     * so a lapsed dispute window and a customer clicking confirm produce
     * identical state — the only difference being who is recorded as having done
     * it. Completing the order here is what starts the escrow hold window for
     * every actor on it, so a second path that forgot to would silently strand
     * everyone's money.
     *
     * Returns the refreshed order, plus whether the confirmation actually landed
     * — `applied: false` means the shipment had already left `agent_delivered`
     * (a customer and the sweep can arrive together, and only one may confirm).
     * The order is returned either way, so the two cannot be told apart from it
     * alone; the sweep needs the distinction to count honestly.
     */
    private async _applyDeliveryConfirmation(
        shipmentId: string,
        orderId: string,
        actorUserId: string | null,
        auto: boolean
    ): Promise<{ order: IOrder | null; applied: boolean }> {
        let applied = false;

        await transactionManager.runInTransaction(async (session) => {
            // Guarded on status: the sweep and a customer can land together, and
            // only one may confirm.
            const confirmed = await this.shipmentRepo.applyCustomerConfirmation(
                shipmentId,
                actorUserId,
                auto,
                session
            );
            if (!confirmed) return;
            applied = true;

            await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, 'delivered', session);
            await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
        });

        if (!applied) return { order: await OrderModel.findById(orderId), applied: false };

        // Delivered → the shipment left the agent's active set; free their slot.
        // (Prepaid path; the COD delivered path releases from CashCollectionService.)
        this._releaseAgentCapacity(await this.shipmentRepo.findById(shipmentId), 'delivered');

        // Post-commit: if every item has now reached a terminal state, complete
        // the order too (idempotent — a no-op if already completed). `isSettled`
        // rather than `fulfillment_status === 'delivered'`: an order whose other
        // shipment was returned is finished, and must still complete or its
        // escrow never releases.
        const refreshedOrder = await OrderModel.findById(orderId);
        if (refreshedOrder && !refreshedOrder.completion?.confirmed_at && this.completionService.isSettled(refreshedOrder)) {
            await this.completionService.complete(
                refreshedOrder,
                auto ? 'system' : 'customer',
                auto,
                actorUserId
            );
        }
        return { order: refreshedOrder, applied: true };
    }

    /**
     * Auto-confirm shipments an agent marked delivered that the customer never
     * confirmed, once the dispute window has elapsed.
     *
     * Without this, `agent_delivered → delivered` has exactly ONE trigger — the
     * customer clicking confirm (or, for COD, releasing their code) — and a
     * customer who does neither leaves the order permanently short of
     * `delivered`. It never completes, and the vendor, platform, agency and
     * agent are never paid. `AUTO_CONFIRM_DAYS` does not cover it: that
     * auto-confirms the ORDER, but only once fulfilment already reached
     * `delivered`, which itself requires every shipment to have been confirmed.
     * It is a backstop for the order-level click with no backstop for the
     * per-shipment one.
     *
     * ── COD TAKES A DIFFERENT ROUTE, AND THE DIFFERENCE IS LOAD-BEARING ─────
     *
     * A prepaid shipment just needs confirming. A COD shipment sitting at
     * `agent_delivered` also has uncollected cash hanging off it, and confirming
     * it the prepaid way — flipping the status, skipping the collection — is the
     * one thing that must never happen here. It would not wrongly release money
     * (`requires_cash_settlement` sees to that), it would quietly ensure nobody
     * is paid at ALL: no collection means no `splitCodCollection`, so no
     * allocations exist to release, and the order's COD payment status never
     * recomputes. A delivered, completed order that nobody earns from and whose
     * payment status is a lie.
     *
     * So COD is routed THROUGH the collection instead —
     * `CashCollectionService.autoCollectWithoutCode` records the cash as
     * collected-without-code and delivers the shipment in one transaction,
     * leaving every downstream mechanism intact. See that method for why the
     * cash lands on the agent and why no discrepancy is raised.
     *
     * Branched on the order's payment method rather than trusting the shipment
     * state machine to tell COD apart. It could once, and that guarantee was
     * deliberately removed so a COD agent can signal arrival before entering the
     * code (step 3d) — a hole this sweep must not fall into.
     *
     * Returns the number of shipments confirmed, by either route.
     */
    async autoConfirmStaleDeliveries(cutoff: Date, limit: number): Promise<number> {
        const stale = await this.shipmentRepo.findStaleAgentDelivered(cutoff, limit);
        if (stale.length === 0) return 0;

        const orderIds = [...new Set(stale.map((s) => s.order_id.toString()))];
        const orders = await OrderModel.find({ _id: { $in: orderIds } }).select('payment_method');
        const paymentMethodByOrder = new Map(
            orders.map((o) => [o._id.toString(), o.payment_method])
        );

        let confirmed = 0;
        for (const shipment of stale) {
            const orderId = shipment.order_id.toString();
            const paymentMethod = paymentMethodByOrder.get(orderId);

            // Unknown order → skip. Never auto-confirm on an assumption.
            if (!paymentMethod) continue;

            try {
                const applied = paymentMethod === 'cash_on_delivery'
                    ? await cashCollectionService.autoCollectWithoutCode(shipment)
                    : (await this._applyDeliveryConfirmation(shipment._id.toString(), orderId, null, true)).applied;
                if (applied) confirmed++;
            } catch (error) {
                console.error(
                    `[ShipmentService] Failed to auto-confirm shipment ${shipment._id.toString()}:`,
                    error
                );
            }
        }
        return confirmed;
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
