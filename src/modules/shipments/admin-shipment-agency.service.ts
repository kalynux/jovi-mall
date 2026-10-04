import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { ShipmentRepository } from './shipment.repository';
import { ShipmentStatus } from './shipment.model';
import { DeliveryAgencyRepository } from '../delivery/delivery-agency.repository';
import { VendorOrderService } from '../orders/vendor-order.service';
import { OrderService } from '../orders/order.service';
import { OrderModel } from '../orders/order.model';
// Direct import, not the `../shipment-assignment` barrel — see `admin-shipment.controller.ts`.
import { shipmentAssignmentService } from '../shipment-assignment/domain/services/shipment-assignment.service';

/**
 * Shipments an administrator may move to another agency: the ones still sitting with an
 * agency and not yet with an agent. `rejected` is the one the agency handed back.
 */
const MOVABLE_STATUSES: ShipmentStatus[] = ['pending', 'assigned', 'rejected'];

export interface AdminMoveActor {
  id: string | null;
  name: string | null;
}

/**
 * AdminShipmentAgencyService — an administrator pushes a shipment to a different agency
 * (owner decision 2026-10-02).
 *
 * ── No second implementation ──────────────────────────────────────────────────
 * Moving an item between agencies already exists, as the vendor's
 * `VendorOrderService.moveItemsToAgency`: it detaches each item from its shipment
 * (deleting an emptied one), groups it into the destination agency's open shipment or
 * opens one, repoints the order item, runs the COD-limit gate and writes the timeline —
 * all items in ONE transaction (ADR-A11 D-12), so a shipment never ends up half-moved.
 * This service calls it once, with every item and the order's own `vendorId` resolved from the
 * record — the same move `AdminShipmentController` makes for reassignment — and an
 * `admin` actor so the timeline and any forced limit name the right party.
 *
 * ── What `force` bypasses ─────────────────────────────────────────────────────
 * The two agency-eligibility checks a move has: the destination agency being `active`,
 * and the COD limits (the agency's cash ceiling and the vendor's `maxCashPerAgency`).
 * Without force, either refuses. State rules are not eligibility and are never waived:
 * a shipment an agent has accepted or picked up is not movable here (reassign the agent,
 * or let them cancel, first), and the order's payment and dispute guards on dispatch
 * still apply.
 *
 * ── The push ──────────────────────────────────────────────────────────────────
 * When the shipment had already been handed to an agency (`assigned`, or `rejected` back
 * by one), the destination is dispatched (`pending` → `assigned`) so it lands on the new
 * agency's board straight away — that is what "push" means. Only that shipment: the
 * vendor's other undispatched shipments on the order are left alone.
 *
 * A shipment the vendor had NOT dispatched yet (`pending`) moves and stays `pending`: the
 * dispatch gate is where payment is checked, and an unpaid prepaid order must not reach an
 * agency because its agency changed. The administrator dispatches it with
 * `POST /api/internal/admin/orders/:orderId/dispatch` when that is the intent.
 */
export class AdminShipmentAgencyService {
  constructor(
    private readonly shipments: ShipmentRepository = new ShipmentRepository(),
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly vendorOrders: VendorOrderService = new VendorOrderService(),
    private readonly orders: OrderService = new OrderService()
  ) {}

  async moveToAgency(
    shipmentId: string,
    input: { agencyId: string; reason: string; force?: boolean },
    actor: AdminMoveActor
  ): Promise<{
    shipmentId: string;
    previousAgencyId: string;
    agencyId: string;
    destinationShipmentId: string;
    itemsMoved: number;
    dispatched: boolean;
    forced: boolean;
  }> {
    const force = input.force === true;

    const shipment = await this.shipments.findById(shipmentId);
    if (!shipment) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });

    const previousAgencyId = shipment.agency_id.toString();
    if (previousAgencyId === input.agencyId) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED, 422, 'The shipment is already with this agency', {
        agencyId: input.agencyId,
      });
    }
    if (shipment.agent_id) {
      throw createAppError(ERROR_CODES.SHIPMENT_ALREADY_HAS_AGENT, 409, undefined, {
        shipmentId,
        agentId: shipment.agent_id.toString(),
        hint: 'An agent holds this shipment. Reassign or release the agent before moving it to another agency.',
      });
    }
    if (!MOVABLE_STATUSES.includes(shipment.status)) {
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_NOT_ALLOWED, 422, undefined, {
        status: shipment.status,
        movableStatuses: MOVABLE_STATUSES,
      });
    }

    const agency = await this.agencies.findById(input.agencyId);
    if (!agency) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404, undefined, { agencyId: input.agencyId });
    }
    if (agency.status !== 'active' && !force) {
      throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_ACTIVE, 422, undefined, {
        agencyId: input.agencyId,
        status: agency.status,
      });
    }

    const order = await OrderModel.findById(shipment.order_id).select('vendor_id').lean().exec();
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    const orderId = shipment.order_id.toString();
    const vendorId = (order as { vendor_id: { toString(): string } }).vendor_id.toString();

    // Withdraw any live offer and the ranking at the OLD agency first — an agent there must
    // not be able to accept a shipment that is leaving.
    await shipmentAssignmentService.cancelActiveOffer(previousAgencyId, shipmentId);

    // Every item in ONE transaction (ADR-A11 D-12): the shipment moves whole or not at all.
    const itemIds = shipment.items.map((i) => i.order_item_id.toString());
    await this.vendorOrders.moveItemsToAgency(orderId, vendorId, itemIds, input.agencyId, {
      force,
      actor: { type: 'admin', id: actor.id, name: actor.name, reason: input.reason },
    });

    const destination = await this.shipments.findGroupableByOrderAndAgency(orderId, input.agencyId);
    if (!destination) {
      // Every item moved, so a destination exists; reaching this means a concurrent writer
      // dispatched or moved it in between. Report it rather than guess.
      throw createAppError(ERROR_CODES.SHIPMENT_REASSIGNMENT_CONFLICT, 409, undefined, { shipmentId });
    }
    const destinationShipmentId = destination._id!.toString();

    // Push: dispatch the destination shipment so the agency sees it now. An administrator's
    // dispatch is not COD-gated (`dispatchToAgency`); the move above already was, unless forced.
    let dispatched = destination.status !== 'pending';
    if (!dispatched && shipment.status !== 'pending') {
      const count = await this.orders.dispatchToAgency(
        orderId,
        { type: 'admin', id: actor.id },
        { shipmentIds: [destinationShipmentId] }
      );
      dispatched = count > 0;
    }

    console.log(
      `[AdminShipmentAgencyService] ${actor.name ?? actor.id ?? 'admin'} moved shipment ${shipmentId} ` +
        `(${itemIds.length} item(s)) from agency ${previousAgencyId} to ${input.agencyId}` +
        `${force ? ' with force' : ''}: ${input.reason}`
    );

    return {
      shipmentId,
      previousAgencyId,
      agencyId: input.agencyId,
      destinationShipmentId,
      itemsMoved: itemIds.length,
      dispatched,
      forced: force,
    };
  }
}

export const adminShipmentAgencyService = new AdminShipmentAgencyService();
