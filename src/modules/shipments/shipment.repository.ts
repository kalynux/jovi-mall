import { ClientSession, FilterQuery, Types } from 'mongoose';
import { ShipmentModel, IShipment, IShipmentItem, ShipmentStatus, ShipmentRejectionReason } from './shipment.model';
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

  /** Record a rejection with reason and set `status = 'rejected'`. */
  async applyRejection(
    shipmentId: string,
    reason: ShipmentRejectionReason,
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
          rejection: { reason, rejectedAt: now, rejectedBy: new Types.ObjectId(rejectedByUserId) },
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

  /** Assign one of the agency's own agents to a shipment. Ownership of the agent is validated by the caller. */
  async assignAgent(shipmentId: string, agentId: string, session?: ClientSession): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $set: { agent_id: new Types.ObjectId(agentId) } },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Customer confirms this shipment's delivery: `agent_delivered` → `delivered`.
   * Caller has already validated the current status allows confirmation.
   */
  async applyCustomerConfirmation(
    shipmentId: string,
    confirmedByUserId: string,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          status: 'delivered',
          customer_confirmation: { confirmed_at: now, confirmed_by: new Types.ObjectId(confirmedByUserId) },
        },
        $push: {
          status_history: {
            status: 'delivered',
            changed_at: now,
            changed_by_user_id: new Types.ObjectId(confirmedByUserId),
            changed_by_role: 'customer',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }
}
