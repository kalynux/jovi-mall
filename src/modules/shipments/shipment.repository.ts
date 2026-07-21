import { ClientSession, FilterQuery, Types } from 'mongoose';
import { ShipmentModel, IShipment, IShipmentItem, ShipmentStatus, ShipmentRejectionReason, IShipmentHandover } from './shipment.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';

export class ShipmentRepository {
  /**
   * Create a shipment. Pass a `session` to enrol the write in a transaction
   * (used by the multi-vendor cart split, which creates orders + shipments atomically).
   */
  async create(data: Partial<IShipment>, session?: ClientSession): Promise<IShipment> {
    if (session) {
      const [shipment] = await ShipmentModel.create([data], { session });
      return shipment;
    }
    return await ShipmentModel.create(data);
  }

  async findById(shipmentId: string): Promise<IShipment | null> {
    return await ShipmentModel.findById(shipmentId);
  }

  async findByOrderId(orderId: string): Promise<IShipment[]> {
    return await ShipmentModel.find({ order_id: orderId });
  }

  /**
   * Find a shipment scoped to the owning agency. Returns null if it doesn't
   * exist or isn't owned by this agency — ownership is never leaked.
   */
  async findByIdAndAgency(shipmentId: string, agencyId: string): Promise<IShipment | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    return await ShipmentModel.findOne({ _id: shipmentId, agency_id: agencyId });
  }

  /**
   * List shipments assigned to an agency, newest first, paginated. Filters by
   * status when provided.
   *
   * Always excludes `pending` — a shipment exists in that status from the
   * moment the (unpaid) order is created, before any vendor review or
   * dispatch. An agency must never see a shipment before the vendor has
   * explicitly dispatched it (see VendorOrderService.dispatchToAgency) or
   * auto-redirect kicked in on payment.
   */
  async findByAgencyPaginated(
    agencyId: string,
    filters: { status?: ShipmentStatus } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<IShipment>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IShipment> = { agency_id: agencyId, status: { $ne: 'pending' } };
    // A requested filter narrows the set, but can never re-include 'pending'.
    if (filters.status && filters.status !== 'pending') filter.status = filters.status;

    const [total, docs] = await Promise.all([
      ShipmentModel.countDocuments(filter).exec(),
      ShipmentModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Find a shipment scoped to the assigned agent. Returns null if it doesn't
   * exist or isn't assigned to this agent — ownership is never leaked.
   */
  async findByIdAndAgent(shipmentId: string, agentId: string): Promise<IShipment | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    return await ShipmentModel.findOne({ _id: shipmentId, agent_id: agentId });
  }

  /**
   * List shipments assigned to an agent, newest first, paginated. Mirrors
   * findByAgencyPaginated — 'pending' shipments have no agent yet, so the
   * exclusion is implicit, but kept explicit for symmetry.
   */
  async findByAgentPaginated(
    agentId: string,
    filters: { status?: ShipmentStatus } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<IShipment>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IShipment> = { agent_id: agentId, status: { $ne: 'pending' } };
    if (filters.status && filters.status !== 'pending') filter.status = filters.status;

    const [total, docs] = await Promise.all([
      ShipmentModel.countDocuments(filter).exec(),
      ShipmentModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Set/replace the carrier tracking number on a shipment matching `filter`
   * (used to enforce agency/agent ownership at the query level). Returns the
   * updated shipment, or null when no shipment matches.
   */
  async setTrackingNumber(
    filter: Record<string, unknown>,
    trackingNumber: string
  ): Promise<IShipment | null> {
    return await ShipmentModel.findOneAndUpdate(
      filter,
      { $set: { tracking_number: trackingNumber } },
      { new: true }
    );
  }

  /**
   * Find a shipment for an order/agency pair that can still accept more items.
   * Only shipments that have not yet left the agency (`pending` or `assigned`)
   * are groupable — once a courier has picked up, a late item gets its own
   * shipment instead. Returns null when no such shipment exists.
   */
  async findGroupableByOrderAndAgency(orderId: string, agencyId: string): Promise<IShipment | null> {
    return await ShipmentModel.findOne({
      order_id: orderId,
      agency_id: agencyId,
      status: { $in: ['pending', 'assigned'] }
    });
  }

  /** Append a line item to a shipment. Returns the updated shipment. */
  async addItem(shipmentId: string, item: IShipmentItem): Promise<IShipment | null> {
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $push: { items: item } },
      { new: true }
    );
  }

  /**
   * Remove a line item from a shipment. If the shipment is left with no items,
   * it is deleted (an empty shipment has nothing to dispatch). Returns the
   * remaining shipment, or null when it was deleted / not found.
   */
  async removeItem(shipmentId: string, orderItemId: string): Promise<IShipment | null> {
    const updated = await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $pull: { items: { order_item_id: orderItemId } } },
      { new: true }
    );

    if (updated && updated.items.length === 0) {
      await ShipmentModel.deleteOne({ _id: shipmentId });
      return null;
    }

    return updated;
  }

  /**
   * Advance all `pending` shipments of an order to `assigned` (the hand-off to
   * the agency). Returns the shipments that were updated (so callers can
   * notify each shipment's agency) — empty when nothing was pending. Only
   * `pending` shipments are touched, so this is safe to call idempotently.
   */
  async assignPendingByOrderId(orderId: string): Promise<IShipment[]> {
    const pending = await ShipmentModel.find({ order_id: orderId, status: 'pending' });
    if (pending.length === 0) return [];

    await ShipmentModel.updateMany(
      { order_id: orderId, status: 'pending' },
      { $set: { status: 'assigned' } }
    );

    pending.forEach(s => { s.status = 'assigned'; });
    return pending;
  }

  /**
   * Apply an already-validated status transition: sets `status` and appends a
   * `status_history` entry in one atomic update. Callers (ShipmentService) own
   * transition validation — this is a dumb write.
   */
  async applyStatusChange(
    shipmentId: string,
    newStatus: ShipmentStatus,
    actor: { userId: string | null; role: string },
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: { status: newStatus },
        $push: {
          status_history: {
            status: newStatus,
            changed_at: new Date(),
            changed_by_user_id: actor.userId ? new Types.ObjectId(actor.userId) : null,
            changed_by_role: actor.role,
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /** Record a rejection with reason (+ optional note) and set `status = 'rejected'`. */
  async applyRejection(
    shipmentId: string,
    reason: ShipmentRejectionReason,
    note: string | null,
    rejectedByUserId: string,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          status: 'rejected',
          rejection: { reason, note: note ?? null, rejectedAt: now, rejectedBy: new Types.ObjectId(rejectedByUserId) },
        },
        $push: {
          status_history: {
            status: 'rejected',
            changed_at: now,
            changed_by_user_id: new Types.ObjectId(rejectedByUserId),
            changed_by_role: 'agency',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Bind an agent to a shipment — the moment an offer is accepted. Sets
   * `agent_id` (the authoritative binding, which makes the agent trackable) and
   * mirrors it onto the `assignment` sub-doc for the agency dashboard.
   * Ownership/eligibility is validated by the caller.
   */
  async assignAgent(shipmentId: string, agentId: string, session?: ClientSession): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          agent_id: new Types.ObjectId(agentId),
          assignment: {
            state: 'accepted',
            current_offer_id: null,
            offered_agent_id: new Types.ObjectId(agentId),
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Mark a shipment as having a live offer out to an agent (workflow mirror
   * only — `agent_id` stays null until they accept).
   */
  async markOffered(
    shipmentId: string,
    offerId: string,
    agentId: string,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          assignment: {
            state: 'offered',
            current_offer_id: new Types.ObjectId(offerId),
            offered_agent_id: new Types.ObjectId(agentId),
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Return a shipment to the agency queue (no live offer, no agent) — used when
   * an offer is rejected/expired/cancelled and there is no next candidate.
   */
  async markUnassigned(shipmentId: string, session?: ClientSession): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          assignment: {
            state: 'unassigned',
            current_offer_id: null,
            offered_agent_id: null,
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Detach the current agent for an agent → agent reassignment — a guarded
   * compare-and-set that is the race guard for the whole reassignment flow.
   *
   * The update matches ONLY when the shipment still has exactly the agent and
   * status the caller read (`agent_id: prevAgentId, status: prevStatus`), so any
   * concurrent transition (a second reassign, an accept, a pickup, a COD collect
   * that moved it on) makes this miss and return null — the caller then reports a
   * conflict rather than double-detaching. On a match it clears `agent_id`, sets
   * `status` to the reassignment target (`assigned` pre-pickup, `handing_over`
   * post-pickup), resets the `assignment` mirror to `unassigned`, and appends a
   * `status_history` entry so the timeline records the reassignment moment.
   */
  async claimForReassignment(
    shipmentId: string,
    agencyId: string,
    prevAgentId: string,
    prevStatus: ShipmentStatus,
    targetStatus: ShipmentStatus,
    actorUserId: string | null,
    handover: IShipmentHandover | null,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, agency_id: agencyId, agent_id: prevAgentId, status: prevStatus },
      {
        $set: {
          agent_id: null,
          status: targetStatus,
          assignment: {
            state: 'unassigned',
            current_offer_id: null,
            offered_agent_id: null,
            updated_at: now,
          },
          // The reassignment-handover collection point (null on a pre-pickup
          // reassignment, where the parcel never left the agency).
          handover,
        },
        $push: {
          status_history: {
            status: targetStatus,
            changed_at: now,
            changed_by_user_id: actorUserId ? new Types.ObjectId(actorUserId) : null,
            changed_by_role: 'agency',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Shipments an agent marked delivered that the customer never confirmed, past
   * the dispute window — the auto-confirm sweep's candidate set.
   *
   * The window is measured from `updated_at` rather than from the moment the
   * status became `agent_delivered`, which the shipment does not record as a
   * field. That errs the right way: any later write (a tracking number, say) can
   * only push `updated_at` forward, so the window can only ever be LONGER than
   * intended, never shorter. A customer is never given less time to dispute than
   * the configured window. Same convention as the order-level sweep.
   */
  async findStaleAgentDelivered(cutoff: Date, limit: number): Promise<IShipment[]> {
    return await ShipmentModel.find({
      status: 'agent_delivered',
      updated_at: { $lte: cutoff },
    }).limit(limit);
  }

  /**
   * Confirm this shipment's delivery: `agent_delivered` → `delivered`.
   *
   * Guarded on the current status rather than trusting the caller's read: the
   * confirmation window sweep and a customer clicking confirm can land at the
   * same instant, and this must produce one confirmation. Returns null when the
   * shipment was no longer `agent_delivered` — treat that as "someone else got
   * there first", not as an error.
   *
   * `confirmedByUserId` is null for an auto-confirmation; nobody clicked.
   */
  async applyCustomerConfirmation(
    shipmentId: string,
    confirmedByUserId: string | null,
    auto = false,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    const actorId = confirmedByUserId ? new Types.ObjectId(confirmedByUserId) : null;
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, status: 'agent_delivered' },
      {
        $set: {
          status: 'delivered',
          customer_confirmation: { confirmed_at: now, confirmed_by: actorId, auto },
        },
        $push: {
          status_history: {
            status: 'delivered',
            changed_at: now,
            changed_by_user_id: actorId,
            changed_by_role: auto ? 'system' : 'customer',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }
}
