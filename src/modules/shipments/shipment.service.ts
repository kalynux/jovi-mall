import { Types } from 'mongoose';
import { ShipmentRepository } from './shipment.repository';
import { AgentShipmentScope } from './shipment.validator';
import { IShipment, ShipmentStatus, ShipmentRejectionReason, IShipmentHandover, IShipmentHandoverPickup, AgentCancellationReason, IShipmentAgentCancellation, IShipmentDeliveryFailure, ShipmentFailureReason } from './shipment.model';
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
import { StoreRepository } from '../store/repositories/store.repository';
import { MagazinRepository } from '../magazin/repositories/magazin.repository';
import { IAgencyHeadquartersAddress } from '../magazin/models/magazin.model';
import { resolveHqAddress, resolveHqAddressFor } from '../magazin/domain/hq-address.resolver';
import { AgencyIdentity, resolveAgencyIdentities, resolveAgencyIdentity } from '../magazin/read-models/agency-identity.resolver';
import {
    AgentRepository,
    agentCapacityService,
} from '../agents';
import { CustomerModel } from '../customers/customer.model';
import { FileRepositoryMongo } from '../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider, IStorageProvider } from '../../core/storage';
import { resolveFileDetail } from '../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../catalog/read-models/product-detail.read-model';
import { ProductImageRef, productImageKey, resolveProductImages } from '../catalog/read-models/product-image.resolver';
import {
    AddressDetail,
    toAddressDetail,
    fromSavedAddress,
    fromPickupSnapshot,
    fromHqAddress,
    fromHandoverPickup,
} from '../../core/read-models/address-detail.resolver';
import {
    EarningsQuoteService,
    earningsQuoteService,
    AgentEarningQuoteResult,
    AgencyEarningQuoteResult,
} from '../earnings/services/earnings-quote.service';
import { earningsSplitService } from '../earnings/services/earnings-split.service';
import { cashCollectionService, CodShipmentSummary } from '../cod/services/cash-collection.service';
import { eventBus } from '../../core/events/event-bus';
import { agentActionAuditService } from '../tracking-integration/services/agent-action-audit.service';
import { shipmentAssignmentOfferRepository } from '../shipment-assignment/repositories/shipment-assignment-offer.repository';
import { geoRoutingClient } from '../shipment-assignment/services/geo-routing.client';
import { haversineKm } from '../../core/utils/geo-distance.util';
import { IGeoPoint } from '../../core/types/geo.types';
import { RoleActorRef } from '../../core/types/actor-source.types';

/**
 * Shipment-status transitions that may be triggered directly on the status
 * endpoints — `PATCH /api/agency/shipments/:id/status` for the agency, and
 * `POST /api/agent/shipments/:id/status` for the assigned agent.
 *
 * ONE map, shared by both actors, because they have the same rights over the
 * lifecycle: the agent is the person physically collecting, driving and
 * knocking on the door, and the agency's endpoint is the desk mirroring that.
 * A reassigned shipment is no different from a first-assigned one — the
 * replacement agent records their own pickup out of `handing_over` just as the
 * original agent does out of `assigned`.
 *
 * Whoever moves it is recorded in `status_history.changed_by_role`; ownership
 * (agency_id vs agent_id) is what differs between the two doors, not the rules.
 * If the two ever need to genuinely diverge, split this into two maps and
 * select on `actor.role` in `_transitionStatus` — do NOT let a role-specific
 * exception creep in here.
 *
 * Excluded on purpose: 'assigned' (system, on payment dispatch), 'delivered'
 * (system — the customer's confirmation, or for COD the delivery code),
 * 'rejected' (its own dedicated agency endpoint), and
 * 'pending_agency_reassignment' (admin-deactivation cascade).
 */
export const TRIGGERABLE_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
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
    // replacement agent picks the parcel up — guarded on agent_id, so the new
    // agent must have accepted first, which is also what makes this reachable
    // from the AGENT endpoint: acceptance binds agent_id while the status is
    // still `handing_over` (see ShipmentRepository.bindAgentIfUnassigned and
    // OFFERABLE_STATUSES). 'returned' is the escape hatch when the handover is
    // abandoned.
    handing_over: ['picked_up', 'returned'],
};

/**
 * The agent-driven transitions the shipment's AGENCY is told about. `in_transit`
 * is excluded: it is a routine progress ping, not something an agency needs
 * pushed at it. Filtered here, in the domain, rather than in the notification
 * layer — so the product decision lives with the state machine and no needless
 * event reaches the bus.
 */
export const AGENT_TRANSITIONS_NOTIFYING_AGENCY: ShipmentStatus[] = [
    'picked_up',
    'agent_delivered',
    'failed',
    'returned',
];

/**
 * Statuses that carry an agent-reported non-delivery reason. Used to decide
 * whether a `failure` payload is persisted onto `delivery_failures`.
 */
const FAILURE_REPORTING_STATUSES: ShipmentStatus[] = ['failed', 'returned'];

/**
 * How many item thumbnails a LIST row carries (`itemImages`). A list row is
 * deliberately item-less — it reports `itemCount`, not the items — so this is a
 * capped, deduplicated preview stack, not the item array in disguise: enough for
 * an agent to recognise the job in their queue, bounded so a 30-item shipment
 * cannot make a 20-row page enormous. The full per-item image is on the detail.
 */
const SHIPMENT_LIST_IMAGE_LIMIT = 3;

/**
 * Who is driving a status transition. A discriminated union rather than
 * `{ role, agencyId?, agentId? }`: the ownership scope only exists for the role
 * that has one, so the shared core can never read an `agencyId` off an agent
 * transition. `role` doubles as the value written to
 * `status_history.changed_by_role` and as the `actorRole` on the geo-tracker
 * agent-action audit.
 */
type ShipmentStatusActor =
    | { role: 'agency'; agencyId: string; userId: string }
    | { role: 'agent'; agentId: string; userId: string };

/**
 * Who is READING a shipment. The list and detail payloads are shared between the
 * agency and the agent, but each sees money the other must not: the agent gets
 * their own cut (`earning`), the agency gets what is left after that cut
 * (`agencyEarning`) — the two are complementary halves of one delivery fee and
 * neither role should be handed the other's.
 *
 * A discriminated union rather than an optional `agentId`, for the same reason
 * as `ShipmentStatusActor`: an absent agent id used to mean BOTH "this is the
 * agency's view" and "no agent is bound", which are different facts — a shipment
 * on the agency's list has no agent id either way.
 */
type ShipmentViewer =
    | { role: 'agency'; agencyId: string }
    | { role: 'agent'; agentId: string };

/**
 * A non-delivery outcome an AGENT reported alongside `failed`/`returned`. Never
 * set on the agency path — the agency status endpoint is deliberately
 * reason-less.
 */
export interface AgentFailureReport {
    reason: ShipmentFailureReason | null;
    note: string | null;
}

/**
 * Agency id → that agency's depots, in stored order (index 0 is the primary).
 * The batch result of `MagazinRepository.findHqAddressListsByAgencyIds`; read it
 * through `resolveHqAddressFor`, never by index.
 */
type HqAddressMap = Map<string, IAgencyHeadquartersAddress[]>;

/**
 * Where a shipment is collected from, and how many distinct collection points it
 * has. `count > 1` means `address` is only the first of several — the detail
 * view carries the full breakdown.
 */
export interface PickupSummary {
    address: AddressDetail | null;
    mode: 'pickup_based' | 'storage_based' | 'mixed' | null;
    count: number;
}

/** A shipment's two ends: where the parcel is collected, and where it goes. */
export interface ShipmentEndpoints {
    pickup: PickupSummary;
    deliveryAddress: AddressDetail | null;
}

/**
 * Everything the assignment module needs to render a shipment an agent cannot
 * yet read — see `buildShipmentContext`. `agency` is who is dispatching it.
 */
export interface ShipmentContext {
    items: any[];
    vendor: any;
    agency: AgencyIdentity | null;
    pickup: PickupSummary;
    deliveryAddress: AddressDetail | null;
}

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

// Agent-initiated mid-delivery cancellation: the status a shipment resets to
// when its own agent walks away. Pre-pickup it returns to the agency queue as
// `assigned` (the parcel never left); once picked up (or already handing over),
// the parcel is physically with that agent, so it enters `handing_over` — an
// offerable state — until a replacement picks it up. Auto-assignment then RESUMES
// from where it had reached. `returned`/`agent_delivered`/terminal are not
// agent-cancellable (the shipment has left the agent's active delivery).
const AGENT_CANCEL_TARGET_STATUS: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
    assigned: 'assigned',
    handing_over: 'handing_over',
    picked_up: 'handing_over',
    in_transit: 'handing_over',
    failed: 'handing_over',
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
    private storeRepo: StoreRepository;
    private magazinRepo: MagazinRepository;
    private agentRepo: AgentRepository;
    private aggregationService: OrderFulfillmentAggregationService;
    private completionService: OrderCompletionService;
    private fileRepository: FileRepositoryMongo;
    private storageProvider: IStorageProvider;
    private earningsQuotes: EarningsQuoteService;

    constructor() {
        this.shipmentRepo = new ShipmentRepository();
        this.orderRepo = new OrderRepository();
        this.vendorRepo = new VendorRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.storeRepo = new StoreRepository();
        this.magazinRepo = new MagazinRepository();
        this.agentRepo = new AgentRepository();
        this.aggregationService = orderFulfillmentAggregationService;
        this.completionService = orderCompletionService;
        this.fileRepository = new FileRepositoryMongo();
        this.storageProvider = getStorageProvider();
        this.earningsQuotes = earningsQuoteService;
    }

    /**
     * List shipments assigned to an agency (requirement #1), newest first.
     * Each entry carries the vendor (#4) and a redacted customer/order summary.
     */
    async listForAgency(
        agencyId: string,
        filters: { status?: ShipmentStatus; q?: string } = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<Page<any>> {
        const page = await this.shipmentRepo.findByAgencyPaginated(agencyId, filters, pagination);
        return this._enrichShipmentPage(page, { role: 'agency', agencyId });
    }

    /**
     * List shipments assigned to an AGENT (the agent app's work queue), with
     * the same vendor/customer enrichment as the agency list, plus the two
     * things only an agent needs: where to collect and drop off, and what the
     * delivery pays them.
     *
     * `filters.scope` splits the queue into what is still theirs to finish and
     * what is over — see findByAgentPaginated for why that is not a `status`.
     */
    async listForAgent(
        agentId: string,
        filters: { status?: ShipmentStatus; q?: string; scope?: AgentShipmentScope } = {},
        pagination: PaginationOptions = { page: 1, limit: 20 }
    ): Promise<Page<any>> {
        const page = await this.shipmentRepo.findByAgentPaginated(agentId, filters, pagination);
        return this._enrichShipmentPage(page, { role: 'agent', agentId });
    }

    /**
     * Shared list enrichment: vendor + redacted customer/order summary per
     * shipment, plus the pickup/drop-off addresses that make a row actionable
     * (an agent navigates from the list, not the detail).
     *
     * `paymentMethod` is on every row for both roles — it decides whether the
     * person at the door has to take money, which is the first thing either one
     * needs to know about a shipment and was previously only on the detail.
     *
     * The money each role sees is theirs alone. The AGENT's queue carries
     * `earning` (their own cut); the AGENCY's carries `agencyEarning` (what is
     * left of the fee once that cut is paid) and the `cod` block — the cash to
     * collect, which the agency needs while choosing who to send, i.e. before any
     * collection row exists. See EarningsQuoteService and
     * `getProjectedCodSummariesForShipments`.
     *
     * Rows also carry `itemImages`: a capped preview of what is in the parcel,
     * so a queue is scannable by sight rather than by reading titles.
     */
    private async _enrichShipmentPage(page: Page<IShipment>, viewer: ShipmentViewer): Promise<Page<any>> {
        if (page.data.length === 0) return { data: [], meta: page.meta };

        const orderIds = [...new Set(page.data.map(s => s.order_id.toString()))];
        // `items` and `delivery_address` are needed for the per-row pickup and
        // drop-off; `payment_method`/`total_amount`/`currency` for the money.
        const orders = await OrderModel.find({ _id: { $in: orderIds } })
            .select('order_number vendor_id customer_id items delivery_address payment_method total_amount currency')
            .lean()
            .exec();
        const orderMap = new Map(orders.map((o: any) => [o._id.toString(), o]));

        const vendorIds = [...new Set(orders.map((o: any) => o.vendor_id.toString()))];
        const customerIds = [...new Set(orders.map((o: any) => o.customer_id.toString()))];
        const agencyIds = [...new Set(page.data.map(s => s.agency_id.toString()))];

        const [vendorMap, customerMap, hqMap, earningMap, codMap] = await Promise.all([
            this._batchResolveVendorNames(vendorIds),
            this._batchResolveCustomerNames(customerIds),
            // Storage-based items are collected from the agency's own HQ, which
            // is resolved live rather than snapshotted onto the order.
            this.magazinRepo.findHqAddressListsByAgencyIds(agencyIds),
            viewer.role === 'agent'
                ? this.earningsQuotes.quoteForShipments(page.data, orderMap as any, viewer.agentId)
                : Promise.resolve(new Map<string, AgentEarningQuoteResult>()),
            viewer.role === 'agency'
                ? cashCollectionService.getProjectedCodSummariesForShipments(page.data, orderMap as any)
                : Promise.resolve(new Map<string, CodShipmentSummary>()),
        ]);

        // Sequential on `codMap`, not parallel with it: a percentage
        // `cod_handling_fee` is a share of the cash being collected, so the
        // agency's earning cannot be quoted until that figure is known.
        const agencyEarningMap = viewer.role === 'agency'
            ? await this.earningsQuotes.quoteAgencyForShipments(
                  page.data,
                  orderMap as any,
                  new Map([...codMap].map(([shipmentId, cod]) => [shipmentId, cod.expectedAmount]))
              )
            : new Map<string, AgencyEarningQuoteResult>();

        // Legacy orders predate `order.delivery_address`; those rows fall back
        // to the customer's current default saved address, so the saved list has
        // to come along on the customer lookup.
        const customerAddressMap = await this._batchResolveCustomerAddresses(
            orders.filter((o: any) => !o.delivery_address).map((o: any) => o.customer_id.toString())
        );

        // Item thumbnails for every row in one pass — see SHIPMENT_LIST_IMAGE_LIMIT.
        const refsByShipment = new Map(
            page.data.map(s => [
                (s._id as Types.ObjectId).toString(),
                this._imageRefsFor(s, orderMap.get(s.order_id.toString())),
            ])
        );
        const imageMap = await resolveProductImages(
            [...refsByShipment.values()].flat(),
            this.fileRepository,
            this.storageProvider
        );

        const data = page.data.map(shipment => {
            const shipmentId = (shipment._id as Types.ObjectId).toString();
            const order = orderMap.get(shipment.order_id.toString());
            const vendor = order ? vendorMap.get(order.vendor_id.toString()) : null;
            const customer = order ? customerMap.get(order.customer_id.toString()) : null;
            const earning = earningMap.get(shipmentId);
            const agencyEarning = agencyEarningMap.get(shipmentId);

            return {
                ...this.toSummary(shipment),
                orderNumber: order?.order_number ?? null,
                // Whether the agent has to take money at the door.
                paymentMethod: order?.payment_method ?? 'online',
                vendor: vendor ?? null,
                customer: customer ?? null,
                itemCount: shipment.items.length,
                itemImages: this._previewImages(refsByShipment.get(shipmentId) ?? [], imageMap),
                pickup: this._resolvePickup(shipment, order, hqMap),
                deliveryAddress: this._resolveDeliveryAddress(
                    order,
                    order ? customerAddressMap.get(order.customer_id.toString()) : null
                ),
                ...(viewer.role === 'agent'
                    ? {
                          earning: earning?.earning ?? null,
                          earningUnavailable: earning?.earningUnavailable ?? null,
                      }
                    : {
                          // Null on a prepaid shipment — there is no cash to collect.
                          cod: codMap.get(shipmentId) ?? null,
                          agencyEarning: agencyEarning?.agencyEarning ?? null,
                          agencyEarningUnavailable: agencyEarning?.agencyEarningUnavailable ?? null,
                      }),
            };
        });

        return { data, meta: page.meta };
    }

    /**
     * The (product, variant) pairs whose pictures this shipment needs.
     *
     * The variant is not on the shipment — a shipment item carries `product_id`
     * and a reference back to the order item, and it is the order item that
     * records which variant was sold. So the pair can only be assembled by
     * joining the two, exactly as the item views already do. A shipment item
     * whose order snapshot is missing (a legacy row) still yields a ref: the
     * resolver falls back to the product's own media.
     */
    private _imageRefsFor(shipment: IShipment, order: any): ProductImageRef[] {
        const orderItemsById = new Map<string, any>(
            (order?.items ?? []).map((i: any) => [i._id.toString(), i])
        );
        return shipment.items.map(si => ({
            productId: si.product_id.toString(),
            variantId: orderItemsById.get(si.order_item_id.toString())?.variant_id?.toString() ?? null,
        }));
    }

    /**
     * A list row's thumbnail stack: the shipment's item images, deduplicated by
     * file (two variants of one product share a cover shot) and capped.
     */
    private _previewImages(refs: ProductImageRef[], imageMap: Map<string, FileDetail[]>): FileDetail[] {
        const seen = new Set<string>();
        const images: FileDetail[] = [];
        for (const ref of refs) {
            // One thumbnail per item — the gallery belongs to the detail view.
            const image = imageMap.get(productImageKey(ref.productId, ref.variantId))?.[0];
            if (!image || seen.has(image.id)) continue;
            seen.add(image.id);
            images.push(image);
            if (images.length === SHIPMENT_LIST_IMAGE_LIMIT) break;
        }
        return images;
    }

    /**
     * The pickup → drop-off route for one of the agent's own shipments, for
     * drawing the delivery on a map.
     *
     * Road-network geometry from geo-tracker when it is reachable
     * (`source: 'road'`), otherwise the straight line between the endpoints
     * (`source: 'straight'`) with a haversine distance and no duration. Never
     * throws on a geo-tracker problem: geo-tracker is off the critical path by
     * contract, and a missing polyline must not cost the agent their address.
     *
     * When either endpoint has no coordinates — a legacy order with no
     * `delivery_address`, or a vendor address that was never geocoded — the
     * response is still 200 with `source: 'unavailable'` and a `reason`, since
     * "this shipment cannot be drawn" is an answer, not a failure.
     */
    async getRouteForAgent(agentId: string, shipmentId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        const order = await OrderModel.findById(shipment.order_id)
            .select('customer_id items delivery_address')
            .lean()
            .exec() as any;
        if (!order) {
            throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
        }

        const hqMap = await this.magazinRepo.findHqAddressListsByAgencyIds([shipment.agency_id.toString()]);
        const pickups = this._resolveAllPickups(shipment, order, hqMap);
        const origin = pickups[0] ?? null;
        const waypoints = pickups.slice(1);

        const fallbackSaved = order.delivery_address
            ? null
            : (await this._batchResolveCustomerAddresses([order.customer_id.toString()])).get(order.customer_id.toString());
        const destination = this._resolveDeliveryAddress(order, fallbackSaved);

        const base = { origin, destination, waypoints };

        if (!origin?.coordinates) {
            return { ...base, source: 'unavailable', reason: 'missing_pickup_coordinates', distanceMeters: null, durationSeconds: null, geometry: [] };
        }
        if (!destination?.coordinates) {
            return { ...base, source: 'unavailable', reason: 'missing_delivery_coordinates', distanceMeters: null, durationSeconds: null, geometry: [] };
        }

        const toPoint = (a: AddressDetail): IGeoPoint => ({
            type: 'Point',
            coordinates: [a.coordinates!.lng, a.coordinates!.lat],
        });
        const viaPoints = waypoints.filter(w => w?.coordinates).map(w => toPoint(w!));

        const road = await geoRoutingClient.route(toPoint(origin), toPoint(destination), viaPoints);
        if (road) {
            return { ...base, source: 'road', reason: null, ...road };
        }

        // Straight-line fallback: the endpoints in order, and the great-circle
        // distance through any intermediate pickups.
        const line = [origin, ...waypoints.filter(w => w?.coordinates), destination] as AddressDetail[];
        let distanceMeters = 0;
        for (let i = 1; i < line.length; i++) {
            distanceMeters += haversineKm(toPoint(line[i - 1]), toPoint(line[i])) * 1000;
        }

        return {
            ...base,
            source: 'straight',
            reason: null,
            distanceMeters: Math.round(distanceMeters),
            // Unknown without a road network — a straight-line ETA would be a
            // guess dressed as a number.
            durationSeconds: null,
            geometry: line.map(a => ({ lat: a.coordinates!.lat, lng: a.coordinates!.lng })),
        };
    }

    /**
     * The pickup → drop-off endpoints for a set of shipments, keyed by shipment
     * id: the map-drawing subset of `buildShipmentContext`, without the item,
     * vendor and image enrichment a map does not need.
     *
     * Exists so the agency live-tracking board can plot a delivery's two ends
     * without reimplementing any of the resolution rules — `handover.pickup`
     * winning after a reassignment, agency-HQ vs vendor snapshot per item, and
     * the order's checkout snapshot winning over the customer's current saved
     * address. Each of those, got wrong, draws the delivery in the wrong place.
     *
     * `ordersById` is supplied by the caller (it has already loaded the orders),
     * keyed by order id string.
     */
    async resolveShipmentEndpoints(
        shipments: IShipment[],
        ordersById: Map<string, any>
    ): Promise<Map<string, ShipmentEndpoints>> {
        const result = new Map<string, ShipmentEndpoints>();
        if (shipments.length === 0) return result;

        const orders = [...ordersById.values()];
        const agencyIds = [...new Set(shipments.map(s => s.agency_id.toString()))];

        const [hqMap, customerAddressMap] = await Promise.all([
            // Storage-based items are collected from the agency's own HQ, which
            // is resolved live rather than snapshotted onto the order.
            this.magazinRepo.findHqAddressListsByAgencyIds(agencyIds),
            // Legacy orders predate `order.delivery_address` and fall back to
            // the customer's current default saved address.
            this._batchResolveCustomerAddresses(
                orders.filter((o: any) => !o.delivery_address).map((o: any) => o.customer_id.toString())
            ),
        ]);

        for (const shipment of shipments) {
            const order = ordersById.get(shipment.order_id.toString());
            result.set((shipment._id as Types.ObjectId).toString(), {
                pickup: this._resolvePickup(shipment, order, hqMap),
                deliveryAddress: this._resolveDeliveryAddress(
                    order,
                    order ? customerAddressMap.get(order.customer_id.toString()) : null
                ),
            });
        }

        return result;
    }

    /**
     * The decision context for a set of shipments — items, vendor, pickup and
     * drop-off — keyed by shipment id.
     *
     * Exists so the ASSIGNMENT module can show an agent what they are being
     * offered without reimplementing any of this. An offer references a shipment
     * the agent cannot yet read (`findByIdAndAgent` is scoped on `agent_id`,
     * still null before acceptance), so the offer list has to assemble the same
     * view from the same rules — and it must be the same rules, or the job an
     * agent accepts is not the job they were shown.
     *
     * `ordersById` is supplied by the caller (it has already loaded the orders),
     * keyed by order id string.
     */
    async buildShipmentContext(
        shipments: IShipment[],
        ordersById: Map<string, any>
    ): Promise<Map<string, ShipmentContext>> {
        const result = new Map<string, ShipmentContext>();
        if (shipments.length === 0) return result;

        const orders = [...ordersById.values()];
        const vendorIds = [...new Set(orders.map((o: any) => o.vendor_id?.toString()).filter(Boolean))];
        const agencyIds = [...new Set(shipments.map(s => s.agency_id.toString()))];

        const [endpointMap, vendorMap, agencyMap, imageMap] = await Promise.all([
            // The pickup/drop-off rules live in ONE place — see resolveShipmentEndpoints.
            this.resolveShipmentEndpoints(shipments, ordersById),
            this._batchResolveVendorNames(vendorIds),
            // An agent serves several agencies at once, so a page of offers can
            // span several — resolve them all in one pass, not per row.
            resolveAgencyIdentities(agencyIds, this.magazinRepo, this.fileRepository, this.storageProvider),
            resolveProductImages(
                shipments.flatMap(s => this._imageRefsFor(s, ordersById.get(s.order_id.toString()))),
                this.fileRepository,
                this.storageProvider
            ),
        ]);

        for (const shipment of shipments) {
            const shipmentId = (shipment._id as Types.ObjectId).toString();
            const order = ordersById.get(shipment.order_id.toString());
            const endpoints = endpointMap.get(shipmentId);
            const orderItemsById = new Map<string, any>(
                (order?.items ?? []).map((i: any) => [i._id.toString(), i])
            );

            result.set(shipmentId, {
                items: shipment.items.map(si => {
                    const orderItem = orderItemsById.get(si.order_item_id.toString());
                    return {
                        productId: si.product_id.toString(),
                        quantity: si.quantity,
                        title: orderItem?.title ?? null,
                        variantTitle: orderItem?.variant_title ?? null,
                        // What it looks like — the deciding detail for an agent
                        // judging an offer they cannot open the shipment for.
                        // The thumbnail only; the full gallery is on the detail.
                        image:
                            imageMap.get(
                                productImageKey(si.product_id.toString(), orderItem?.variant_id?.toString() ?? null)
                            )?.[0] ?? null,
                    };
                }),
                vendor: order ? (vendorMap.get(order.vendor_id.toString()) ?? null) : null,
                // Which agency is offering this job — an agent decides partly on
                // who they'd be working for, so it has to be on the offer itself.
                agency: agencyMap.get(shipment.agency_id.toString()) ?? null,
                pickup: endpoints?.pickup ?? { address: null, mode: null, count: 0 },
                deliveryAddress: endpoints?.deliveryAddress ?? null,
            });
        }

        return result;
    }

    /**
     * Where this shipment's agent physically collects the parcel, and how many
     * distinct pickup points it has.
     *
     * Precedence matters: after an agent→agent reassignment the replacement
     * collects from `handover.pickup` (the previous agent's location, the
     * agency's counter, …) and NOT from the vendor address the order snapshot
     * still names. Getting that order wrong sends the agent to the wrong place.
     *
     * A shipment can legitimately have several pickups — one vendor with two
     * business addresses, or a mix of vendor-collected and agency-stored items —
     * so `count` reports that and `mode: 'mixed'` flags it. The detail view
     * keeps the full per-item breakdown; this is the summary.
     */
    private _resolvePickup(
        shipment: IShipment,
        order: any,
        hqMap: HqAddressMap
    ): PickupSummary {
        const resolved = this._resolvePickupEntries(shipment, order, hqMap);
        if (resolved.length === 0) return { address: null, mode: null, count: 0 };
        const modes = new Set(resolved.map(r => r.mode));
        return {
            address: resolved[0].address,
            mode: modes.size > 1 ? 'mixed' : resolved[0].mode,
            count: resolved.length,
        };
    }

    /** Every distinct pickup address for a shipment, in collection order. */
    private _resolveAllPickups(shipment: IShipment, order: any, hqMap: HqAddressMap): Array<AddressDetail | null> {
        return this._resolvePickupEntries(shipment, order, hqMap).map(r => r.address);
    }

    /**
     * The shipment's distinct pickup points, deduped by what the agent would
     * actually drive to.
     *
     * Precedence matters: after an agent→agent reassignment the replacement
     * collects from `handover.pickup` (the previous agent's location, the
     * agency's counter, …) and NOT from the vendor address the order snapshot
     * still names. Getting that order wrong sends the agent to the wrong place.
     */
    private _resolvePickupEntries(
        shipment: IShipment,
        order: any,
        hqMap: HqAddressMap
    ): Array<{ address: AddressDetail | null; mode: 'pickup_based' | 'storage_based' }> {
        if (shipment.handover?.pickup) {
            return [{ address: fromHandoverPickup(shipment.handover.pickup), mode: 'pickup_based' }];
        }

        const orderItemsById = new Map<string, any>(
            (order?.items ?? []).map((i: any) => [i._id.toString(), i])
        );

        const resolved: Array<{ address: AddressDetail | null; mode: 'pickup_based' | 'storage_based' }> = [];
        const seen = new Set<string>();
        for (const item of shipment.items) {
            const pl = orderItemsById.get(item.order_item_id.toString())?.delivery?.pickup_location;
            if (!pl) continue; // legacy order item predating the pickup snapshot
            // Resolved PER ITEM, not once per shipment: two items can name two
            // different depots of the same agency, and the dedupe below then
            // correctly reports two stops.
            const entry =
                pl.source === 'agency_storage'
                    ? {
                        address: fromHqAddress(
                            resolveHqAddressFor(hqMap, shipment.agency_id, pl.agency_address_id)
                        ),
                        mode: 'storage_based' as const,
                    }
                    : { address: fromPickupSnapshot(pl.address_snapshot), mode: 'pickup_based' as const };
            const key = `${entry.mode}:${entry.address?.formattedAddress ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            resolved.push(entry);
        }
        return resolved;
    }

    /**
     * The drop-off for a shipment: the order's geocoded checkout snapshot,
     * falling back to the customer's current default saved address.
     *
     * The snapshot must win. It is the address the customer actually ordered
     * to; their saved default can be edited or replaced afterwards, and reading
     * it live would silently re-route an in-flight delivery. The fallback exists
     * only for orders created before `order.delivery_address` existed.
     */
    private _resolveDeliveryAddress(order: any, fallbackSavedAddress: any): AddressDetail | null {
        if (order?.delivery_address) return toAddressDetail(order.delivery_address);
        return fromSavedAddress(fallbackSavedAddress);
    }

    /** Batch-resolve customer ids → their default saved address (legacy fallback only). */
    private async _batchResolveCustomerAddresses(customerIds: string[]): Promise<Map<string, any>> {
        const ids = [...new Set(customerIds)];
        if (ids.length === 0) return new Map();
        const customers = await CustomerModel.find({ _id: { $in: ids } })
            .select('saved_addresses')
            .lean()
            .exec() as any[];
        const map = new Map<string, any>();
        for (const c of customers) {
            const addr = c.saved_addresses?.find((a: any) => a.is_default) ?? c.saved_addresses?.[0] ?? null;
            if (addr) map.set(c._id.toString(), addr);
        }
        return map;
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
        return this._buildDetail(shipment, { role: 'agency', agencyId });
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
        return this._buildDetail(shipment, { role: 'agent', agentId });
    }

    /**
     * Shared detail assembly for the agency and agent views. The `viewer` decides
     * only which side of the delivery fee is reported — the agent their own cut,
     * the agency what is left after it. Everything else is identical.
     */
    private async _buildDetail(shipment: IShipment, viewer: ShipmentViewer): Promise<any> {
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

        // The vendor's business name lives on the Store (source of truth).
        const vendorBusinessName = vendor ? await this.storeRepo.findNameByVendorId(vendor._id.toString()) : null;

        // Items: join shipment's order_item_id references against the order's own
        // item snapshots for title/sku/price. Pickup location (#3) is resolved
        // per item from the snapshot taken at order-creation time (the product's
        // configured pickup_location — see ProductStatusValidationService /
        // order.service.ts) rather than guessed from the vendor's first address —
        // a shipment can carry several of the vendor's products, each configured
        // differently. The agency's own depot address is still resolved live (not
        // snapshotted) since only WHICH depot is product-specific — the address
        // itself is the agency's record and must follow their corrections.
        // HQ addresses live on the Magazin now.
        const agencyMagazin = agency ? await this.magazinRepo.findByAgencyIdOrNull(agency._id.toString()) : null;
        const agencyDepots = agencyMagazin?.headquarters_addresses ?? null;
        const orderItemsById = new Map((order as any).items.map((i: any) => [i._id.toString(), i]));
        // What each item looks like: the variant's own media, else the product's.
        // Resolved live rather than from the order snapshot — see the resolver.
        // The detail carries EVERY image (thumbnail first): this is the screen an
        // agent stares at while matching a parcel on a counter to their job, and
        // one angle is often not enough to tell two boxes apart.
        const imageMap = await resolveProductImages(
            this._imageRefsFor(shipment, order),
            this.fileRepository,
            this.storageProvider
        );
        const items = shipment.items.map(si => {
            const orderItem: any = orderItemsById.get(si.order_item_id.toString());
            const pl = orderItem?.delivery?.pickup_location;
            const pickupLocation = !pl
                ? null // legacy order item predating this feature
                : pl.source === 'agency_storage'
                    ? {
                        mode: 'storage_based' as const,
                        alreadyInYourStorage: true,
                        // Per item — two items can name two different depots.
                        address: fromHqAddress(resolveHqAddress(agencyDepots, pl.agency_address_id)),
                    }
                    : { mode: 'pickup_based' as const, alreadyInYourStorage: false, address: fromPickupSnapshot(pl.address_snapshot) };
            return {
                orderItemId: si.order_item_id.toString(),
                productId: si.product_id.toString(),
                quantity: si.quantity,
                title: orderItem?.title ?? null,
                sku: orderItem?.sku ?? null,
                variantTitle: orderItem?.variant_title ?? null,
                // Every image, thumbnail first — `images[0]` is exactly the
                // `image` the list and offer views show for the same item.
                images:
                    imageMap.get(
                        productImageKey(si.product_id.toString(), orderItem?.variant_id?.toString() ?? null)
                    ) ?? [],
                pickupLocation,
            };
        });

        // Drop-off: the geocoded snapshot taken at checkout is authoritative —
        // it is the address the customer ordered to. Their saved default is only
        // a fallback for orders predating `order.delivery_address`; reading it
        // live (as this once did) silently re-routes an in-flight delivery when
        // the customer edits their profile, and throws away the coordinates.
        const fallbackSavedAddr = (order as any).delivery_address
            ? null
            : customer?.saved_addresses?.find((a: any) => a.is_default) ?? customer?.saved_addresses?.[0] ?? null;
        const deliveryAddress = this._resolveDeliveryAddress(order, fallbackSavedAddr);

        // Resolve the agent's avatar File reference into a FileDetail object.
        const agentAvatar = await resolveFileDetail(agent?.avatar_file_id?.toString(), this.fileRepository, this.storageProvider);

        // Who dispatched this shipment. The agent works for several agencies at
        // once, so "which one sent me this?" is not answerable from the token —
        // and `agencyId` alone is not an answer a human can act on. The magazin
        // is already loaded above for the HQ address, so only the logo is fetched.
        const agencyIdentity = await resolveAgencyIdentity(agencyId, agencyMagazin, this.fileRepository, this.storageProvider);

        // Resolve the (optional, agency-owned) delivery-proof image.
        const deliveryProof = await resolveFileDetail(shipment.delivery_proof_file_id?.toString(), this.fileRepository, this.storageProvider);

        // Merged multi-agency timeline: every sibling shipment's history for this
        // order, labeled by agency, sorted chronologically.
        const timeline = await this._mergeShipmentTimelines(siblingShipments);

        // COD: the cash this shipment's agent must collect + collection state.
        // Never includes the delivery code — that is customer-only. Projected
        // rather than merely read, so an agency still deciding who to send gets
        // the amount before any agent has accepted (`status: null` says so).
        const cod = (order as any).payment_method === 'cash_on_delivery'
            ? await cashCollectionService.getProjectedCodSummaryForShipment(order as any, shipment)
            : null;

        // Each role sees its own half of the delivery fee: the agent their cut,
        // the agency what is left once that cut is paid (plus the COD handling
        // fee, which is never shared). See EarningsQuoteService.
        const earning = viewer.role === 'agent'
            ? await this.earningsQuotes.quoteForShipment(shipment, order as any, viewer.agentId)
            : null;
        const agencyEarning = viewer.role === 'agency'
            ? await this.earningsQuotes.quoteAgencyForShipment(shipment, order as any, cod?.expectedAmount ?? 0)
            : null;

        return {
            ...this.toSummary(shipment),
            orderId: shipment.order_id.toString(),
            orderNumber: (order as any).order_number,
            paymentMethod: (order as any).payment_method ?? 'online',
            cod,
            // The value of the WHOLE order. Distinct from `cod.expectedAmount`,
            // which is only this shipment's cash: an order can split into
            // several shipments across agencies. Do not conflate them.
            orderValue: {
                total: (order as any).total_amount ?? null,
                currency: (order as any).currency ?? null,
            },
            ...(viewer.role === 'agent'
                ? { earning: earning?.earning ?? null, earningUnavailable: earning?.earningUnavailable ?? null }
                : {
                      agencyEarning: agencyEarning?.agencyEarning ?? null,
                      agencyEarningUnavailable: agencyEarning?.agencyEarningUnavailable ?? null,
                  }),
            items,
            // The dispatching agency's identity: name, logo and support contacts.
            // Null only when the agency has no magazin yet (provisioning gap).
            agency: agencyIdentity,
            vendor: vendor ? { id: vendor._id.toString(), businessName: vendorBusinessName ?? '', phone: vendor.phone ?? null, email: vendor.email ?? null } : null,
            customer: customer ? {
                id: customer._id.toString(),
                name: customer.name,
                phone: customer.phone ?? null,
                email: customer.email ?? null,
                deliveryAddress,
            } : null,
            // The single pickup an agent navigates to (handover point after a
            // reassignment, else the item snapshot), summarising `items[].pickupLocation`.
            pickup: this._resolvePickup(
                shipment,
                order,
                new Map(agency ? [[agency._id.toString(), agencyDepots ?? []]] : [])
            ),
            agent: agent ? { id: agent._id.toString(), name: agent.name, phone: agent.phone ?? null, avatar: agentAvatar } : null,
            // Reassignment handover: where the (replacement) agent collects this
            // shipment, when it was reassigned. Null for a first-assigned shipment.
            handover: shipment.handover ? {
                pickup: {
                    source: shipment.handover.pickup.source,
                    address: fromHandoverPickup(shipment.handover.pickup),
                    note: shipment.handover.pickup.note ?? null,
                    isFallback: shipment.handover.pickup.is_fallback ?? false,
                },
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
            // Append-only log of agent-reported non-delivery outcomes, oldest
            // first — two `customer_unreachable` attempts then a return is a
            // different story from one. Empty when every failure/return on this
            // shipment was driven by the agency (that endpoint records no reason).
            deliveryFailures: (shipment.delivery_failures ?? []).map(f => ({
                status: f.status,
                reason: f.reason ?? null,
                note: f.note ?? null,
                fromStatus: f.from_status,
                reportedByAgentId: f.reported_by_agent_id?.toString() ?? null,
                reportedAt: f.reported_at,
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
            // Optional delivery-proof image (agency-owned), or null.
            deliveryProof,
            orderTimeline: timeline,
        };
    }

    /**
     * Agency-driven status transition (requirement #10): picked_up, in_transit,
     * agent_delivered, or a failed→in_transit/returned retry. Validated against
     * TRIGGERABLE_TRANSITIONS. Mirrors the new status onto every order item
     * riding this shipment and recomputes the order's fulfillment_status, all
     * inside one transaction.
     *
     * A thin scoping wrapper over `_transitionStatus`, which the agent path
     * shares. The signature is unchanged from before agents could transition,
     * and the agency never supplies a failure reason — see
     * `updateStatusByAgent` for why the two are separate entry points.
     */
    async updateStatus(agencyId: string, shipmentId: string, newStatus: ShipmentStatus, actorUserId: string): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        return await this._transitionStatus(
            shipment,
            newStatus,
            { role: 'agency', agencyId, userId: actorUserId },
            null
        );
    }

    /**
     * Agent-driven status transition on the agent's OWN shipment: picked_up,
     * in_transit, agent_delivered, or a failed→in_transit/returned retry.
     * Validated against the SAME `TRIGGERABLE_TRANSITIONS` the agency uses — an
     * agent has the same rights over the lifecycle whether the shipment was
     * assigned to them first or handed over by a reassignment, so a replacement
     * agent records their own pickup out of `handing_over` too.
     *
     * A SEPARATE entry point rather than an actor parameter on `updateStatus`:
     * the agent path takes a `failure` argument that must never be reachable
     * from the agency call (the agency endpoint is deliberately reason-less),
     * and a shared optional parameter would be silently acceptable there.
     *
     * Ownership is enforced at the query level — a shipment that is not this
     * agent's reads as not-found, so existence is never leaked (404, not 403).
     */
    async updateStatusByAgent(
        agentId: string,
        shipmentId: string,
        newStatus: ShipmentStatus,
        actorUserId: string,
        failure: AgentFailureReport | null
    ): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        return await this._transitionStatus(
            shipment,
            newStatus,
            { role: 'agent', agentId, userId: actorUserId },
            // Belt and braces over the Zod schema: a reason on a status that
            // records none is dropped rather than persisted where nothing reads it.
            FAILURE_REPORTING_STATUSES.includes(newStatus) ? failure : null
        );
    }

    /**
     * The shared transition core, driven by an already ownership-scoped shipment
     * and a discriminated actor. Everything below this line is identical for the
     * agency and the agent — only the transition map, the recorded actor role,
     * and whether a failure reason is captured differ.
     */
    private async _transitionStatus(
        shipment: IShipment,
        newStatus: ShipmentStatus,
        actor: ShipmentStatusActor,
        failure: AgentFailureReport | null
    ): Promise<any> {
        const shipmentId = shipment._id.toString();
        // The status the transition was validated against — and therefore the
        // `from` the compare-and-set below must still find on the document.
        const fromStatus = shipment.status;

        // One map for both actors — see TRIGGERABLE_TRANSITIONS. What differs
        // between the agency and the agent is ownership scoping (already applied
        // by the caller) and the recorded role, never the rules.
        const allowed = TRIGGERABLE_TRANSITIONS[shipment.status] ?? [];
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
        //
        // Unreachable on the AGENT path (findByIdAndAgent returning a document
        // already implies `agent_id`), load-bearing on the agency one. Do not
        // "simplify" it away after reading only the agent flow.
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

        // The non-delivery outcome this agent reported, persisted in the same
        // atomic write as the transition. Null on the agency path and on any
        // status that records no reason.
        const recordedFailure: IShipmentDeliveryFailure | null =
            actor.role === 'agent' && failure && FAILURE_REPORTING_STATUSES.includes(newStatus)
                ? {
                    status: newStatus as 'failed' | 'returned',
                    reason: failure.reason,
                    note: failure.note,
                    from_status: fromStatus,
                    reported_by_agent_id: new Types.ObjectId(actor.agentId),
                    reported_by_user_id: actor.userId ? new Types.ObjectId(actor.userId) : null,
                    reported_at: new Date(),
                }
                : null;

        // Captured inside the transaction, used for the post-commit customer
        // notification (the plaintext code never lives in the txn scope alone).
        // `code` is null when the collection already existed — nothing to send.
        let issuedCode: { collection: ICashCollection; code: string | null } | null = null;
        // The document the guarded write returned — the authoritative post-state
        // of THIS transition. Every side effect below reads it rather than a
        // fresh findById, so a concurrent transition landing between commit and
        // read can never make this call emit verdicts for a status it did not set.
        let committed: IShipment | null = null;

        // ...WithRetry, not runInTransaction: the compare-and-set below is a
        // contended write now that two actors drive the same document (the same
        // reasoning as releaseForAgentCancel). A CAS miss is not transient, so it
        // aborts and rethrows rather than spinning.
        await transactionManager.runInTransactionWithRetry(async (session) => {
            // Reset per attempt — a value from an aborted attempt must not leak
            // into the post-commit notify below.
            issuedCode = null;

            committed = await this.shipmentRepo.applyStatusChangeIfCurrent({
                shipmentId,
                fromStatus,
                toStatus: newStatus,
                actor: { userId: actor.userId, role: actor.role },
                agencyId: actor.role === 'agency' ? actor.agencyId : null,
                agentId: actor.role === 'agent' ? actor.agentId : null,
                failure: recordedFailure,
            }, session);

            if (!committed) {
                // Someone else moved the shipment between the read that
                // validated this transition and this write — the other of
                // agency/agent got there first. Fail rather than clobber: the
                // post-commit block below (earnings split, capacity release, COD
                // return handling) would otherwise run for a status nobody is in.
                throw createAppError(ERROR_CODES.SHIPMENT_STATUS_CONFLICT, 409,
                    'This shipment was updated by someone else — reload it and try again', {
                    expectedStatus: fromStatus,
                    to: newStatus,
                });
            }

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

        const updated = committed as IShipment | null;
        this._emitTrackingStatusChanged(updated!, order.customer_id?.toString() ?? null);
        // A returned shipment has left the agent's active set — give the capacity
        // slot reserved on acceptance back. ('failed' stays active: the agent is
        // still holding the parcel and may retry via failed → in_transit.)
        if (newStatus === 'returned') {
            this._releaseAgentCapacity(updated, 'returned');
        }
        // Phase 6: record the agent-action audit for a pickup/delivery/return/
        // cancel transition (fire-and-forget; a no-op for other statuses or when
        // the shipment carries no agent). `actor.role` is the audit's actorRole —
        // geo-tracker stores it as free text and already receives 'agent' from
        // the COD collect path, so agent-driven transitions need no change there.
        void agentActionAuditService
            .emitShipmentTransition(updated!, actor.role)
            .catch((err) => console.error('[ShipmentService] agent-action audit emit failed:', err));

        // Tell the agency its agent moved the shipment. Agent-driven only — an
        // agency does not need to be notified of its own dashboard action — and
        // only for the outcomes worth pushing (in_transit is a routine progress
        // ping; see AGENT_TRANSITIONS_NOTIFYING_AGENCY).
        if (actor.role === 'agent' && AGENT_TRANSITIONS_NOTIFYING_AGENCY.includes(newStatus)) {
            this._emitAgentStatusChanged(
                updated!,
                actor.agentId,
                fromStatus,
                (order as any).order_number ?? null,
                recordedFailure
            );
        }

        // The delivery run is over: divide the fee the vendor was charged at
        // payment between this agency and the agent who actually made it. THIS is
        // what pays an agent on an online-paid order — COD pays them off the cash
        // collection instead, so it is excluded here.
        //
        // Hooked at `agent_delivered` rather than the customer's confirmation so
        // an agent learns what they earned on finishing the job; the rows are
        // created `held` with no maturity, so nothing becomes withdrawable until
        // the ORDER completes and the hold window elapses. `returned` splits too:
        // the run happened, and the agency's rto_fee is what it earned.
        //
        // Post-commit and best-effort, like the emits above — an earnings failure
        // must never block a delivery. The release worker's recovery stage
        // re-splits anything that never landed.
        if (!isCod && (newStatus === 'agent_delivered' || newStatus === 'returned')) {
            // `agent_delivered` IS the successful outcome here — it is the point
            // the run ended, and the later customer confirmation only matures
            // what this creates.
            const outcome = newStatus === 'returned' ? 'returned' : 'delivered';
            void earningsSplitService
                .splitShipmentDelivery(order, updated!, outcome)
                .catch((err) => console.error('[ShipmentService] delivery earnings split failed:', err));
        }

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
            // Echo of the entry appended to `delivery_failures`, or null. Always
            // present (null on the agency path) so both status endpoints return
            // one shape.
            recordedFailure: recordedFailure
                ? {
                    status: recordedFailure.status,
                    reason: recordedFailure.reason,
                    note: recordedFailure.note,
                    fromStatus: recordedFailure.from_status,
                    reportedAt: recordedFailure.reported_at,
                }
                : null,
        };
    }

    /**
     * Fire-and-forget announcement that a shipment's status changed.
     *
     * TWO AUDIENCES, and the method name predates the second:
     *
     * 1. **The live-tracking integration** (geo-tracker, via the outbox) — so an
     *    agency/customer that can no longer track its agent loses access
     *    immediately. Terminal statuses are what actually revoke; other
     *    transitions are re-checked and kept if still valid on the geo-tracker side.
     * 2. **The customer notification stack** — which turns four of these statuses
     *    into "on its way" / "out for delivery" / "delivered" / "attempt failed".
     *
     * Best-effort: a failure here never affects the delivery flow (mirrors the
     * codebase's post-commit event emission pattern).
     *
     * ── Why the descriptive fields are on the payload, not re-read ────────────
     *
     * `trackingNumber` and the failure reason are taken from the shipment this
     * transition produced — the document the CAS returned — for the same reason
     * `status` is: a burst of transitions must produce one honest payload each.
     * `delivery_failures` is APPEND-ONLY and `failed → in_transit → failed` is an
     * allowed cycle, so a consumer re-reading it later could describe the wrong
     * attempt. Both are already in hand at every call site; this costs no query.
     *
     * NOTE: adding fields here does NOT change what reaches geo-tracker.
     * `TrackingEventSubscriber` reads named fields into a fixed outbox row, so
     * anything it does not name is invisible to the other service.
     */
    private _emitTrackingStatusChanged(shipment: IShipment, customerId: string | null): void {
        // The attempt THIS event is about: the newest entry matching the status
        // being reported, not merely the newest entry.
        const failure = [...(shipment.delivery_failures ?? [])]
            .reverse()
            .find((f) => f.status === shipment.status);

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
                // Descriptive only — no consumer branches on these.
                trackingNumber: shipment.tracking_number ?? null,
                failureReason: failure?.reason ?? null,
                failureNote: failure?.note ?? null,
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
    async reject(agencyId: string, shipmentId: string, reason: ShipmentRejectionReason, note: string | null, actor: RoleActorRef): Promise<any> {
        const shipment = await this.shipmentRepo.findByIdAndAgency(shipmentId, agencyId);
        if (!shipment) {
            throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        }

        if (shipment.status !== 'assigned') {
            throw createAppError(ERROR_CODES.SHIPMENT_REJECTION_NOT_ALLOWED, 422, undefined, { status: shipment.status });
        }

        await transactionManager.runInTransaction(async (session) => {
            // Guarded compare-and-set on the (agency, 'assigned') pair read above. A miss
            // means somebody else moved the shipment in between — the agent picked it up,
            // or a second reject landed first. Fail rather than clobber: everything below
            // and every post-commit side effect assumes THIS rejection is the one that
            // happened.
            const rejected = await this.shipmentRepo.applyRejection(shipmentId, agencyId, reason, note, actor, session);
            if (!rejected) {
                throw createAppError(ERROR_CODES.SHIPMENT_STATUS_CONFLICT, 409,
                    'This shipment was updated by someone else — reload it and try again', {
                    expectedStatus: 'assigned',
                    to: 'rejected',
                });
            }
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
        const agencyName = await this.magazinRepo.findNameByAgencyId(shipment.agency_id.toString());

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
                agencyName: agencyName ?? null,
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
        // Role as well as id: the reassignment's `status_history` entry records who drove
        // it, and an administrator reassigning through `/api/internal/admin/shipments` is
        // not the agency desk. `role` was hardcoded 'agency' before this had a second
        // caller.
        actor: { userId: string | null; role: string },
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
                shipmentId, agencyId, previousAgentId, previousStatus, targetStatus, actor, handover, session
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
     * Release a shipment because ITS OWN AGENT cancelled it mid-delivery — the
     * agent-initiated counterpart of `reassignAgent`.
     *
     * Structurally identical to a reassignment detach, but:
     *   • agent-SCOPED (a guarded CAS on `agent_id: thisAgent`, so an agent can
     *     only cancel a shipment that is actually theirs), and
     *   • it records the cancellation reason + note on the shipment
     *     (`agent_cancellation`) for the audit the requirement asks for.
     *
     * It clears `agent_id`, resets the status to the offerable target (`assigned`
     * pre-pickup, `handing_over` post-pickup), releases the agent's capacity and
     * tracking session, and re-mirrors the order. The caller (the assignment
     * service) then RESUMES the auto-assignment broadcast from its stored cursor.
     * A settled order is never re-opened.
     */
    async releaseForAgentCancel(
        agentId: string,
        shipmentId: string,
        reason: AgentCancellationReason,
        note: string | null,
        handoverPickup: IShipmentHandoverPickup | null
    ): Promise<{ shipment: IShipment; previousStatus: ShipmentStatus }> {
        const shipment = await this.shipmentRepo.findByIdAndAgent(shipmentId, agentId);
        if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);

        const previousStatus = shipment.status;
        const targetStatus = AGENT_CANCEL_TARGET_STATUS[previousStatus];
        if (!targetStatus) {
            throw createAppError(ERROR_CODES.SHIPMENT_CANCEL_NOT_ALLOWED, 422, undefined, { status: previousStatus });
        }

        const orderId = shipment.order_id.toString();
        const order = await OrderModel.findById(orderId);
        if (order?.completion?.confirmed_at) {
            throw createAppError(ERROR_CODES.SHIPMENT_CANCEL_NOT_ALLOWED, 422,
                'This order has already been completed and can no longer be cancelled', { status: previousStatus });
        }

        const now = new Date();
        const handover: IShipmentHandover | null = handoverPickup
            ? { pickup: handoverPickup, from_agent_id: new Types.ObjectId(agentId), from_status: previousStatus, reassigned_at: now }
            : null;
        const cancellation: IShipmentAgentCancellation = {
            reason,
            note: note ?? null,
            cancelled_by_agent_id: new Types.ObjectId(agentId),
            from_status: previousStatus,
            cancelled_at: now,
        };

        let detached: IShipment | null = null;
        await transactionManager.runInTransactionWithRetry(async (session) => {
            detached = await this.shipmentRepo.claimForAgentCancel(
                shipmentId, agentId, previousStatus, targetStatus, cancellation, handover, session
            );
            // The CAS missed — the shipment moved since we read it (a concurrent
            // reassign / status change). Fail closed, don't double-detach.
            if (!detached) {
                throw createAppError(ERROR_CODES.SHIPMENT_CANCEL_CONFLICT, 409, undefined, {
                    expectedAgentId: agentId,
                    expectedStatus: previousStatus,
                });
            }
            if (targetStatus !== previousStatus) {
                await this.orderRepo.setItemDeliveryStatusByShipment(shipmentId, targetStatus, session);
                await this.aggregationService.recomputeFulfillmentStatus(orderId, session);
            }
            // Deliberately does NOT cancel the OTHER agents' standing offers: those
            // ignored offers stay acceptable, and the broadcast resumes from cursor.
        });

        // ── post-commit teardown of the cancelling agent ────────────────────────
        this._emitAgentReleased(detached!, agentId, order?.customer_id?.toString() ?? null);
        void agentCapacityService
            .release(agentId, 'cancelled')
            .catch((err) => console.error('[ShipmentService] agent-cancel capacity release failed:', err));
        this._emitAgentCancelled(detached!, agentId, previousStatus, reason, note, order?.order_number ?? null);

        return { shipment: detached!, previousStatus };
    }

    /**
     * Fire-and-forget business audit of an agent-initiated cancellation. The
     * tracking release rides `_emitAgentReleased`; the durable record is the
     * shipment's `agent_cancellation` + `status_history`. Carries the reason so an
     * agency dashboard / future consumer can surface why an agent walked away.
     */
    private _emitAgentCancelled(
        shipment: IShipment,
        agentId: string,
        previousStatus: ShipmentStatus,
        reason: AgentCancellationReason,
        note: string | null,
        orderNumber: string | null
    ): void {
        void eventBus.publish('shipment.agent_cancelled', {
            eventType: 'shipment.agent_cancelled',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                orderNumber,
                agencyId: shipment.agency_id.toString(),
                agentId,
                previousStatus,
                newStatus: shipment.status,
                reason,
                note,
            },
        }).catch((err) => console.error('[ShipmentService] agent_cancelled emit failed:', err));
    }

    /**
     * Fire-and-forget notify the AGENCY that its agent moved one of its
     * shipments (POST /api/agent/shipments/:id/status). Emitted only for the
     * transitions worth pushing — see AGENT_TRANSITIONS_NOTIFYING_AGENCY, which
     * excludes `in_transit`.
     *
     * Distinct from `shipment.status_changed`, which is the geo-tracker outbox
     * feed and fires for every transition by every actor: this one exists purely
     * so the agency notification stack has an agent-scoped event to render, and
     * carries the reason so the notification can say WHY a delivery failed.
     */
    private _emitAgentStatusChanged(
        shipment: IShipment,
        agentId: string,
        previousStatus: ShipmentStatus,
        orderNumber: string | null,
        failure: IShipmentDeliveryFailure | null
    ): void {
        void eventBus.publish('shipment.agent_status_changed', {
            eventType: 'shipment.agent_status_changed',
            aggregateId: shipment._id.toString(),
            occurredAt: new Date(),
            payload: {
                shipmentId: shipment._id.toString(),
                orderId: shipment.order_id.toString(),
                orderNumber,
                agencyId: shipment.agency_id.toString(),
                agentId,
                previousStatus,
                status: shipment.status,
                reason: failure?.reason ?? null,
                note: failure?.note ?? null,
            },
        }).catch((err) => console.error('[ShipmentService] agent_status_changed emit failed:', err));
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
        // Business names come from the Store (source of truth); contact phone from the vendor.
        const storeNames = await this.storeRepo.findNamesByVendorIds(vendorIds);
        await Promise.all(vendorIds.map(async id => {
            const vendor = await this.vendorRepo.findById(id);
            if (vendor) {
                map.set(id, { id, businessName: storeNames.get(id)?.name ?? '', phone: vendor.phone ?? null });
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
        // Business names live on the Magazin (source of truth), keyed by agency_id.
        const magazinNames = await this.magazinRepo.findNamesByAgencyIds(agencyIds);
        const agencyNameMap = new Map<string, string>();
        for (const id of agencyIds) {
            const name = magazinNames.get(id)?.name;
            if (name) agencyNameMap.set(id, name);
        }

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
