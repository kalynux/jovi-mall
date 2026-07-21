import { ClientSession, Types, FilterQuery } from 'mongoose';
import {
  ShipmentAssignmentOfferModel,
  IShipmentAssignmentOffer,
  OfferStatus,
} from '../models/shipment-assignment-offer.model';
import { PaginationOptions, Page } from '../../../core/repositories/base.repository';

/**
 * Data access for shipment assignment offers.
 *
 * Plain repository over the model (like ShipmentRepository), not BaseRepository:
 * offers are never soft-deleted and the transitions here are guarded
 * compare-and-set writes, which the generic repository does not express.
 */
export class ShipmentAssignmentOfferRepository {
  async create(
    data: Partial<IShipmentAssignmentOffer>,
    session?: ClientSession
  ): Promise<IShipmentAssignmentOffer> {
    if (session) {
      const [offer] = await ShipmentAssignmentOfferModel.create([data], { session });
      return offer;
    }
    return await ShipmentAssignmentOfferModel.create(data);
  }

  async findById(offerId: string): Promise<IShipmentAssignmentOffer | null> {
    if (!Types.ObjectId.isValid(offerId)) return null;
    return await ShipmentAssignmentOfferModel.findById(offerId);
  }

  /** Scoped to the owning agent — ownership is never leaked (returns null instead). */
  async findByIdAndAgent(offerId: string, agentId: string): Promise<IShipmentAssignmentOffer | null> {
    if (!Types.ObjectId.isValid(offerId)) return null;
    return await ShipmentAssignmentOfferModel.findOne({ _id: offerId, agent_id: agentId });
  }

  /** The current live (pending) offer for a shipment, if any. */
  async findPendingForShipment(
    shipmentId: string,
    session?: ClientSession
  ): Promise<IShipmentAssignmentOffer | null> {
    const q = ShipmentAssignmentOfferModel.findOne({ shipment_id: shipmentId, status: 'pending' });
    if (session) q.session(session);
    return await q.exec();
  }

  /** The agent's offers, newest first, paginated; optional status filter. */
  async listForAgent(
    agentId: string,
    filters: { status?: OfferStatus } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<IShipmentAssignmentOffer>> {
    const { page, limit } = pagination;
    const filter: FilterQuery<IShipmentAssignmentOffer> = { agent_id: agentId };
    if (filters.status) filter.status = filters.status;

    const [total, data] = await Promise.all([
      ShipmentAssignmentOfferModel.countDocuments(filter).exec(),
      ShipmentAssignmentOfferModel.find(filter)
        // Pending first (so the work queue leads with what needs a decision),
        // then newest.
        .sort({ status: 1, created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return {
      data,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  /**
   * Atomically claim a pending, unexpired offer for acceptance. Returns the
   * updated offer, or null if it was not claimable (already responded, expired,
   * or not this agent's) — the double-accept / accept-after-timeout guard.
   *
   * MUST run inside the acceptance transaction: if the assignment later aborts,
   * this claim rolls back with it and the offer returns to pending.
   */
  async claimForAccept(
    offerId: string,
    agentId: string,
    now: Date,
    session: ClientSession
  ): Promise<IShipmentAssignmentOffer | null> {
    return await ShipmentAssignmentOfferModel.findOneAndUpdate(
      { _id: offerId, agent_id: agentId, status: 'pending', expires_at: { $gt: now } },
      { $set: { status: 'accepted', responded_at: now } },
      { new: true, session }
    ).exec();
  }

  /**
   * Guarded transition of a pending offer to a terminal status. Returns the
   * updated offer, or null if it was no longer pending (someone/the sweep beat
   * us to it). Used by reject / expire / cancel / supersede.
   */
  async transitionFromPending(
    offerId: string,
    to: Exclude<OfferStatus, 'pending' | 'accepted'>,
    patch: { rejection_reason?: string | null } = {},
    session?: ClientSession
  ): Promise<IShipmentAssignmentOffer | null> {
    return await ShipmentAssignmentOfferModel.findOneAndUpdate(
      { _id: offerId, status: 'pending' },
      {
        $set: {
          status: to,
          responded_at: new Date(),
          rejection_reason: patch.rejection_reason ?? null,
        },
      },
      { new: true, session: session ?? undefined }
    ).exec();
  }

  /**
   * Cancel any pending offer for a shipment (agency withdrawal or a
   * reassignment superseding the shipment). Returns how many were cancelled.
   */
  async cancelPendingForShipment(shipmentId: string, session?: ClientSession): Promise<number> {
    const res = await ShipmentAssignmentOfferModel.updateMany(
      { shipment_id: shipmentId, status: 'pending' },
      { $set: { status: 'cancelled', responded_at: new Date() } },
      { session: session ?? undefined }
    ).exec();
    return res.modifiedCount ?? 0;
  }

  /**
   * Pending offers whose deadline has passed — the expiry sweep's input.
   * Oldest first so the longest-waiting shipments are reaped first.
   */
  async findDueForExpiry(now: Date, limit: number): Promise<IShipmentAssignmentOffer[]> {
    return await ShipmentAssignmentOfferModel.find({
      status: 'pending',
      expires_at: { $lte: now },
    })
      .sort({ expires_at: 1 })
      .limit(limit)
      .exec();
  }
}

export const shipmentAssignmentOfferRepository = new ShipmentAssignmentOfferRepository();
