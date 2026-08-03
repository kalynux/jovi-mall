import { Types } from 'mongoose';
import { IShipment, ShipmentModel, ShipmentStatus } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';
import { ShipmentService, ShipmentEndpoints, PickupSummary } from '../../shipments/shipment.service';
import { AddressDetail } from '../../../core/read-models/address-detail.resolver';
import { AgentRepository, IDeliveryAgent, IAgentVehicleInfo } from '../../agents';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider } from '../../../core/storage';
import { resolveFileDetails } from '../../catalog/read-models/file-detail.resolver';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { trackableShipmentsForAgency } from './visible-agents.service';
import { TRACKING_INTEGRATION_CONFIG } from '../config/tracking-integration.config';

/**
 * The agency live-tracking map's one load: every agent this agency may currently
 * watch, and each of their active shipments with the two points that draw the
 * delivery — where the parcel was collected and where it is going.
 *
 * WHAT THIS IS NOT: it carries no position. `agent.last_known_tracking_state` is
 * a business mirror, stale by construction, and serving it here would put a
 * plausible-looking marker on a map that has stopped moving. Live movement comes
 * only from geo-tracker's WebSocket (`subscribe {agentId}` → `location_broadcast`).
 *
 * It also never calls geo-tracker. geo-tracker is off the critical path by
 * contract, and the board must still render — addresses and all — when it is
 * down; only the moving markers go missing.
 *
 * The agent set is deliberately identical to what `visible-agents.service.ts`
 * grants this agency (both select on `trackableShipmentsForAgency`), because
 * geo-tracker gates the WebSocket subscription on that policy: a board built
 * from a wider filter would offer a subscribe geo-tracker then refuses.
 */

/** One active shipment, reduced to what a map needs to draw it. */
export interface TrackingBoardShipment {
  shipmentId: string;
  trackingNumber: string | null;
  orderNumber: string | null;
  status: ShipmentStatus;
  itemCount: number;
  /** The start pin: vendor pickup, agency HQ, or the post-reassignment handover point. */
  origin: PickupSummary;
  /** The end pin: the order's geocoded checkout snapshot. */
  destination: AddressDetail | null;
  /**
   * Both ends have coordinates, so this delivery can actually be drawn. False on
   * legacy orders predating `order.delivery_address` and on vendor addresses that
   * were never geocoded — the addresses are still returned as text.
   */
  mappable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One watchable agent and the deliveries they are currently running. */
export interface TrackingBoardAgent {
  agentId: string;
  name: string | null;
  avatar: FileDetail | null;
  phone: string | null;
  vehicleType: IAgentVehicleInfo['vehicle_type'] | null;
  shipments: TrackingBoardShipment[];
}

export interface TrackingBoard {
  agents: TrackingBoardAgent[];
  meta: {
    agentCount: number;
    shipmentCount: number;
    /** The agency has more trackable shipments than TRACKING_BOARD_MAX_SHIPMENTS. */
    truncated: boolean;
  };
}

/**
 * Assemble the board from already-loaded parts. Pure — no I/O — so the grouping
 * and the `mappable` derivation are testable without Mongo, following the
 * codebase convention of extracting derivations off the I/O path.
 *
 * `shipments` arrives newest-first and that order is preserved within each agent;
 * agents are ordered by their most recent shipment, so the agent who just picked
 * something up is at the top of the list.
 */
export function buildTrackingBoard(
  shipments: IShipment[],
  endpointsById: Map<string, ShipmentEndpoints>,
  ordersById: Map<string, { order_number?: string | null }>,
  agentsById: Map<string, IDeliveryAgent>,
  avatarsByAgentId: Map<string, FileDetail | null>,
  truncated: boolean,
): TrackingBoard {
  const byAgent = new Map<string, TrackingBoardAgent>();

  for (const shipment of shipments) {
    // Guarded by `trackableShipmentsForAgency`, but a null here would silently
    // key an agent as "null" rather than fail, so drop it explicitly.
    if (!shipment.agent_id) continue;

    const agentId = shipment.agent_id.toString();
    const shipmentId = (shipment._id as Types.ObjectId).toString();
    const endpoints = endpointsById.get(shipmentId);
    const origin: PickupSummary = endpoints?.pickup ?? { address: null, mode: null, count: 0 };
    const destination = endpoints?.deliveryAddress ?? null;

    let entry = byAgent.get(agentId);
    if (!entry) {
      const agent = agentsById.get(agentId);
      entry = {
        agentId,
        name: agent?.name ?? null,
        avatar: avatarsByAgentId.get(agentId) ?? null,
        phone: agent?.phone ?? null,
        vehicleType: agent?.vehicle_info?.vehicle_type ?? null,
        shipments: [],
      };
      byAgent.set(agentId, entry);
    }

    entry.shipments.push({
      shipmentId,
      trackingNumber: shipment.tracking_number ?? null,
      orderNumber: ordersById.get(shipment.order_id.toString())?.order_number ?? null,
      status: shipment.status,
      itemCount: shipment.items.length,
      origin,
      destination,
      mappable: Boolean(origin.address?.coordinates && destination?.coordinates),
      createdAt: shipment.created_at,
      updatedAt: shipment.updated_at,
    });
  }

  const agents = [...byAgent.values()];
  return {
    agents,
    meta: {
      agentCount: agents.length,
      shipmentCount: agents.reduce((n, a) => n + a.shipments.length, 0),
      truncated,
    },
  };
}

export class AgencyTrackingBoardService {
  private shipmentService: ShipmentService;
  private agentRepo: AgentRepository;
  private fileRepository: FileRepositoryMongo;

  constructor() {
    this.shipmentService = new ShipmentService();
    this.agentRepo = new AgentRepository();
    this.fileRepository = new FileRepositoryMongo();
  }

  async forAgency(agencyId: string): Promise<TrackingBoard> {
    const max = TRACKING_INTEGRATION_CONFIG.TRACKING_BOARD_MAX_SHIPMENTS;

    // One extra row is the truncation probe — cheaper than a second count query
    // for a snapshot that is expected to sit well under the cap.
    const found = await ShipmentModel.find(trackableShipmentsForAgency(agencyId))
      .sort({ created_at: -1 })
      .limit(max + 1)
      .exec();

    const truncated = found.length > max;
    const shipments = truncated ? found.slice(0, max) : found;

    if (shipments.length === 0) {
      return { agents: [], meta: { agentCount: 0, shipmentCount: 0, truncated: false } };
    }

    // Only the fields the endpoint resolution and the row need: `items` and
    // `delivery_address` for the two pins, `customer_id` for the legacy saved-
    // address fallback, `order_number` for the label.
    const orderIds = [...new Set(shipments.map((s) => s.order_id.toString()))];
    const orders = await OrderModel.find({ _id: { $in: orderIds } })
      .select('order_number customer_id items delivery_address')
      .lean()
      .exec();
    const ordersById = new Map(orders.map((o: any) => [o._id.toString(), o]));

    const agentIds = [...new Set(shipments.map((s) => s.agent_id!.toString()))];

    const [endpointsById, agents] = await Promise.all([
      // The pickup/drop-off rules stay in ShipmentService — this board must not
      // grow its own copy of them.
      this.shipmentService.resolveShipmentEndpoints(shipments, ordersById),
      this.agentRepo.findManyByIds(agentIds),
    ]);

    const agentsById = new Map(agents.map((a) => [a._id.toString(), a]));
    const avatarsByAgentId = await this._resolveAvatars(agents);

    return buildTrackingBoard(shipments, endpointsById, ordersById, agentsById, avatarsByAgentId, truncated);
  }

  /** Batch-resolve agent avatars into `FileDetail` objects, keyed by agent id. */
  private async _resolveAvatars(agents: IDeliveryAgent[]): Promise<Map<string, FileDetail | null>> {
    const byFileId = await resolveFileDetails(
      agents.map((a) => a.avatar_file_id?.toString() ?? null),
      this.fileRepository,
      getStorageProvider(),
    );
    return new Map(
      agents.map((a) => {
        const fileId = a.avatar_file_id?.toString() ?? null;
        return [a._id.toString(), fileId ? byFileId.get(fileId) ?? null : null];
      }),
    );
  }
}

export const agencyTrackingBoardService = new AgencyTrackingBoardService();
