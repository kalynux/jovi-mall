import { ShipmentModel, ShipmentStatus } from '../../shipments/shipment.model';
import { OrderModel } from '../../orders/order.model';

/**
 * Computes the set of delivery agents a given actor is currently allowed to
 * see the live location of. This is the authorization *policy* for live
 * tracking, and it lives here (in jovi-mall, the source of truth for
 * shipments and orders) rather than in geo-tracker — geo-tracker calls this
 * as the viewer and caches the result.
 *
 * Rules (mirrors the tracking spec):
 *   - admin    → everyone (wildcard)
 *   - agent    → only themselves
 *   - agency   → agents on its currently approved+active shipments
 *   - customer → agents on their active orders
 *   - vendor   → none
 */

// A shipment is "approved and active" (agent trackable) once it has been
// dispatched to the agency and before it reaches a terminal state. `handing_over`
// is trackable too: a picked-up parcel being reassigned is tracked again the
// moment its replacement agent accepts (the interval before that carries no
// agent, so nobody is tracked).
const TRACKABLE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  'assigned',
  'handing_over',
  'picked_up',
  'in_transit',
  'agent_delivered',
];

/**
 * How a shipment's terminal status maps to the outcome geo-tracker stamps on the
 * tracking session it ends. Only genuinely FINAL statuses appear here.
 *
 * `rejected`, `pending_agency_reassignment` and `handing_over` are deliberately
 * absent: the shipment is not over, it is merely no longer this agent's. That
 * makes it a *release* (geo-tracker closes the session with no outcome) rather
 * than a terminal — and a new session opens when the replacement agent accepts.
 * `pending` is likewise a not-yet, not an ending.
 */
const SHIPMENT_TERMINAL_STATUS: Partial<Record<ShipmentStatus, ShipmentTerminal>> = {
  delivered: 'delivered',
  returned: 'returned',
  failed: 'failed',
};

// An order still in flight (its shipments may be trackable). Terminal states
// (delivered/fulfilled/cancelled/returned) are excluded.
const ACTIVE_ORDER_FULFILLMENT = ['pending', 'processing', 'partially_shipped', 'shipped', 'partially_delivered'];

export interface VisibleAgents {
  all: boolean;
  agents: string[];
}

/** The shipment-ending outcomes geo-tracker understands. */
export type ShipmentTerminal = 'delivered' | 'returned' | 'cancelled' | 'failed';

/**
 * geo-tracker's per-shipment tracking-session signal: does THIS shipment warrant
 * a tracking session, and did it just end?
 *
 * A tracking session in geo-tracker spans exactly one shipment — it opens when
 * `trackable` turns true and closes when `terminal` is set (or `trackable` turns
 * false with no terminal, i.e. the shipment left this agent). geo-tracker holds
 * no shipment model, so it cannot derive any of this; it receives these verdicts
 * and honours them. The policy stays here, in the source of truth, computed from
 * the same TRACKABLE_SHIPMENT_STATUSES that drives agency visibility.
 */
export interface ShipmentTrackability {
  trackable: boolean;
  terminal: ShipmentTerminal | null;
}

export class VisibleAgentsService {
  async resolve(role: string, roleEntityId: string): Promise<VisibleAgents> {
    switch (role) {
      case 'admin':
        return { all: true, agents: [] };
      case 'agent':
        return { all: false, agents: roleEntityId ? [roleEntityId] : [] };
      case 'agency':
        return { all: false, agents: await this.forAgency(roleEntityId) };
      case 'customer':
        return { all: false, agents: await this.forCustomer(roleEntityId) };
      default: // vendor and anything else: no access
        return { all: false, agents: [] };
    }
  }

  /**
   * Whether an agent currently has any ACTIVE (trackable) shipment. This is the
   * aggregate — it names no shipment, so on the geo-tracker side it is only a
   * backstop: `false` closes every session the agent has open (catching a lost
   * terminal event), but it can never open one, because a tracking session needs
   * a shipment to be about.
   *
   * Reuses the same TRACKABLE_SHIPMENT_STATUSES an agency's visibility is
   * computed from, so an agent is trackable-by-shipment exactly while some agency
   * can see them.
   */
  async agentHasActiveShipment(agentId: string): Promise<boolean> {
    if (!agentId) return false;
    const exists = await ShipmentModel.exists({
      agent_id: agentId,
      status: { $in: TRACKABLE_SHIPMENT_STATUSES },
    }).exec();
    return exists != null;
  }

  /**
   * The per-shipment tracking-session verdict for one status — what actually
   * opens and closes a tracking session in geo-tracker.
   *
   * Pure and status-driven on purpose: the caller passes the status the event was
   * emitted *for*, so a burst of transitions produces one honest verdict each,
   * rather than every event reporting whatever the shipment's status happens to
   * be by the time the outbox is drained.
   */
  shipmentTrackability(status: ShipmentStatus | null | undefined): ShipmentTrackability {
    if (!status) return { trackable: false, terminal: null };
    return {
      trackable: TRACKABLE_SHIPMENT_STATUSES.includes(status),
      terminal: SHIPMENT_TERMINAL_STATUS[status] ?? null,
    };
  }

  /**
   * The current status of one shipment, for events whose payload doesn't carry it
   * (a COD collection knows cash was taken, not what that made the shipment).
   * Returns null if the shipment is gone.
   */
  async shipmentStatus(shipmentId: string | null): Promise<ShipmentStatus | null> {
    if (!shipmentId) return null;
    const shipment = await ShipmentModel.findById(shipmentId).select('status').lean().exec();
    return (shipment?.status as ShipmentStatus) ?? null;
  }

  private async forAgency(agencyId: string): Promise<string[]> {
    const agentIds = await ShipmentModel.distinct('agent_id', {
      agency_id: agencyId,
      status: { $in: TRACKABLE_SHIPMENT_STATUSES },
      agent_id: { $ne: null },
    }).exec();
    return agentIds.map((id) => id.toString());
  }

  private async forCustomer(customerId: string): Promise<string[]> {
    const orderIds = await OrderModel.distinct('_id', {
      customer_id: customerId,
      fulfillment_status: { $in: ACTIVE_ORDER_FULFILLMENT },
    }).exec();
    if (orderIds.length === 0) return [];

    const agentIds = await ShipmentModel.distinct('agent_id', {
      order_id: { $in: orderIds },
      status: { $in: TRACKABLE_SHIPMENT_STATUSES },
      agent_id: { $ne: null },
    }).exec();
    return agentIds.map((id) => id.toString());
  }
}

export const visibleAgentsService = new VisibleAgentsService();
