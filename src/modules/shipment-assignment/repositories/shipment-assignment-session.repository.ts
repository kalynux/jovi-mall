import { ClientSession, Types } from 'mongoose';
import {
  ShipmentAssignmentSessionModel,
  IShipmentAssignmentSession,
  AssignmentSessionStatus,
} from '../models/shipment-assignment-session.model';

/** The observable state the sweep reads before deciding the next advance. */
export interface SessionAdvanceExpectation {
  status: AssignmentSessionStatus;
  round: number;
  cursor: number;
  renudge_index: number;
  frontier_at: Date | null;
}

/** The next state to write when an advance is claimed. */
export interface SessionAdvancePatch {
  status?: AssignmentSessionStatus;
  round?: number;
  cursor?: number;
  renudge_index?: number;
  frontier_at?: Date | null;
}

const LIVE_STATUSES: AssignmentSessionStatus[] = ['active', 'assigned', 'exhausted'];

/**
 * Data access for the temporary assignment-session ranking.
 *
 * Plain repository (not BaseRepository): sessions are hard-deleted when their
 * shipment finishes (the requirement's "deleted after the lifecycle"), and the
 * advance is a guarded compare-and-set the generic repository cannot express.
 */
export class ShipmentAssignmentSessionRepository {
  async create(
    data: Partial<IShipmentAssignmentSession>,
    session?: ClientSession
  ): Promise<IShipmentAssignmentSession> {
    if (session) {
      const [doc] = await ShipmentAssignmentSessionModel.create([data], { session });
      return doc;
    }
    return await ShipmentAssignmentSessionModel.create(data);
  }

  /** The live (non-deleted) session for a shipment, if any. */
  async findLiveForShipment(
    shipmentId: string,
    session?: ClientSession
  ): Promise<IShipmentAssignmentSession | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    const q = ShipmentAssignmentSessionModel.findOne({
      shipment_id: shipmentId,
      status: { $in: LIVE_STATUSES },
    });
    if (session) q.session(session);
    return await q.exec();
  }

  async findById(sessionId: string): Promise<IShipmentAssignmentSession | null> {
    if (!Types.ObjectId.isValid(sessionId)) return null;
    return await ShipmentAssignmentSessionModel.findById(sessionId);
  }

  /**
   * Sessions whose frontier tick is due — the sweep's input. Only `active`
   * sessions broadcast; `assigned`/`exhausted` ones have `frontier_at = null`.
   */
  async findDueForAdvance(now: Date, limit: number): Promise<IShipmentAssignmentSession[]> {
    return await ShipmentAssignmentSessionModel.find({
      status: 'active',
      frontier_at: { $ne: null, $lte: now },
    })
      .sort({ frontier_at: 1 })
      .limit(limit)
      .exec();
  }

  /**
   * Guarded advance: apply `patch` ONLY if the session still holds exactly the
   * observed (status, round, cursor, renudge_index, frontier_at). Returns the
   * updated doc, or null if another instance advanced it first — the
   * multi-instance safety guarantee, no lock required.
   */
  async advanceState(
    sessionId: string,
    expected: SessionAdvanceExpectation,
    patch: SessionAdvancePatch,
    session?: ClientSession
  ): Promise<IShipmentAssignmentSession | null> {
    return await ShipmentAssignmentSessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        status: expected.status,
        round: expected.round,
        cursor: expected.cursor,
        renudge_index: expected.renudge_index,
        frontier_at: expected.frontier_at,
      },
      { $set: patch },
      { new: true, session: session ?? undefined }
    ).exec();
  }

  /**
   * Bind the session to the accepting agent and stop advancing. Called inside the
   * accept transaction, AFTER the shipment-level bind CAS has already picked the
   * single winner — so this is not itself the race guard, just the bookkeeping.
   */
  async markAssigned(
    sessionId: string,
    agentId: string,
    session?: ClientSession
  ): Promise<IShipmentAssignmentSession | null> {
    return await ShipmentAssignmentSessionModel.findOneAndUpdate(
      { _id: sessionId, status: { $in: ['active', 'exhausted', 'assigned'] } },
      { $set: { status: 'assigned', assigned_agent_id: new Types.ObjectId(agentId), frontier_at: null } },
      { new: true, session: session ?? undefined }
    ).exec();
  }

  /**
   * Resume the broadcast after the assigned agent cancelled: reopen the session
   * and schedule an immediate frontier tick, WITHOUT resetting the cursor — the
   * broadcast continues from where it had reached (the requirement's STEP 8).
   */
  async resumeForShipment(
    shipmentId: string,
    now: Date,
    session?: ClientSession
  ): Promise<IShipmentAssignmentSession | null> {
    return await ShipmentAssignmentSessionModel.findOneAndUpdate(
      { shipment_id: shipmentId, status: { $in: ['assigned', 'exhausted'] } },
      { $set: { status: 'active', assigned_agent_id: null, frontier_at: now } },
      { new: true, session: session ?? undefined }
    ).exec();
  }

  /**
   * Dispose of a shipment's ranking — the requirement's "delete only when the
   * shipment is completed or permanently cancelled". A hard delete: the durable
   * audit of who was offered what lives on the offer rows, not here.
   */
  async deleteForShipment(shipmentId: string, session?: ClientSession): Promise<number> {
    if (!Types.ObjectId.isValid(shipmentId)) return 0;
    const res = await ShipmentAssignmentSessionModel.deleteMany(
      { shipment_id: shipmentId },
      { session: session ?? undefined }
    ).exec();
    return res.deletedCount ?? 0;
  }
}

export const shipmentAssignmentSessionRepository = new ShipmentAssignmentSessionRepository();
