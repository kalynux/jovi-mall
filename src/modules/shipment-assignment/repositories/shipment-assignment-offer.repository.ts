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

  /** ALL live (pending) offers for a shipment — plural under auto-assignment. */
  async listPendingForShipment(
    shipmentId: string,
    session?: ClientSession
  ): Promise<IShipmentAssignmentOffer[]> {
    const q = ShipmentAssignmentOfferModel.find({ shipment_id: shipmentId, status: 'pending' });
    if (session) q.session(session);
    return await q.exec();
  }

  /**
   * This agent's standing (pending) offer for a shipment, if any — the broadcast
   * uses it to avoid re-offering an agent who already holds an acceptable offer
   * (idempotent re-entry / round-2 re-nudge reuse the same offer).
   */
  async findPendingForShipmentAndAgent(
    shipmentId: string,
    agentId: string,
    session?: ClientSession
  ): Promise<IShipmentAssignmentOffer | null> {
    const q = ShipmentAssignmentOfferModel.findOne({
      shipment_id: shipmentId,
      agent_id: agentId,
      status: 'pending',
    });
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
   * Atomically claim a pending offer for acceptance. Returns the updated offer,
   * or null if it was not claimable (already responded, or not this agent's) —
   * the double-accept guard for THIS offer.
   *
   * There is deliberately no `expires_at` guard: under auto-assignment a
   * timed-out (ignored) agent keeps an acceptable offer, so the offer's deadline
   * does not gate acceptance. The real "is the shipment still available" check is
   * the shipment-level bind CAS the accept transaction runs next. MUST run inside
   * that transaction: if the assignment later aborts, this claim rolls back.
   */
  async claimForAccept(
    offerId: string,
    agentId: string,
    session: ClientSession
  ): Promise<IShipmentAssignmentOffer | null> {
    return await ShipmentAssignmentOfferModel.findOneAndUpdate(
      { _id: offerId, agent_id: agentId, status: 'pending' },
      { $set: { status: 'accepted', responded_at: new Date() } },
      { new: true, session }
    ).exec();
  }

  /**
   * Retire every OTHER standing (pending) offer for a shipment once one agent has
   * won it — the losing ignored agents' offers become `superseded` so their app
   * stops showing a stale "accept" button. Best-effort, run post-commit: a
   * straggler that misses it self-heals on its own accept attempt (the shipment
   * bind CAS fails and returns "already assigned"). Returns how many were retired.
   */
  async supersedeOtherPendingForShipment(
    shipmentId: string,
    exceptOfferId: string,
    session?: ClientSession
  ): Promise<number> {
    const res = await ShipmentAssignmentOfferModel.updateMany(
      { shipment_id: shipmentId, status: 'pending', _id: { $ne: exceptOfferId } },
      { $set: { status: 'superseded', responded_at: new Date() } },
      { session: session ?? undefined }
    ).exec();
    return res.modifiedCount ?? 0;
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
   * MANUAL offers whose deadline has passed — the manual-expiry sweep's input.
   * Auto offers (`session_id` set) are EXCLUDED: they never expire on timeout;
   * their lifecycle is driven by the assignment session, not the offer deadline.
   * Oldest first so the longest-waiting shipments are reaped first.
   */
  async findDueForExpiry(now: Date, limit: number): Promise<IShipmentAssignmentOffer[]> {
    return await ShipmentAssignmentOfferModel.find({
      status: 'pending',
      session_id: null,
      expires_at: { $lte: now },
    })
      .sort({ expires_at: 1 })
      .limit(limit)
      .exec();
  }
}

export const shipmentAssignmentOfferRepository = new ShipmentAssignmentOfferRepository();
