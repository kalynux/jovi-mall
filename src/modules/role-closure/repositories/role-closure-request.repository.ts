import { ClientSession, Types } from 'mongoose';
import { IRoleClosureRequest, RoleClosureRequestModel } from '../models/role-closure-request.model';
import { ActorRef, actorStamp } from '../../../core/types/actor-source.types';
import { ClosableRole, RoleClosureWarning } from '../role-closure.types';

export interface CreateRoleClosureRequestInput {
  userId: string;
  role: ClosableRole;
  roleEntityId: string;
  reason: string;
  requestedBy: ActorRef;
  requestedAt: Date;
  expiresAt: Date;
  warnings: RoleClosureWarning[];
}

/**
 * Every write leaving `pending` is a compare-and-set on `{ status: 'pending' }`, and the
 * ones a USER makes also require `expires_at > now`. A null return is a CONFLICT the service
 * explains (already answered, cancelled, expired), never a not-found.
 */
export class RoleClosureRequestRepository {
  async create(input: CreateRoleClosureRequestInput): Promise<IRoleClosureRequest> {
    // Array form, so a future caller passing `{ session }` gets the transaction it asked for
    // — Mongoose reads the options argument only when the first one is an array.
    const [doc] = await RoleClosureRequestModel.create([
      {
        user_id: input.userId,
        role: input.role,
        role_entity_id: input.roleEntityId,
        status: 'pending',
        reason: input.reason,
        ...actorStamp('requested_by', input.requestedBy),
        requested_at: input.requestedAt,
        expires_at: input.expiresAt,
        warnings: input.warnings,
      },
    ]);
    return doc;
  }

  /** The live pending request for (user, role), ignoring one past its expiry. */
  async findPending(userId: string, role: ClosableRole, now: Date): Promise<IRoleClosureRequest | null> {
    return await RoleClosureRequestModel.findOne({
      user_id: userId,
      role,
      status: 'pending',
      expires_at: { $gt: now },
    }).exec();
  }

  /** A pending row whose expiry has already passed — so a late answer is told "expired". */
  async findStalePending(userId: string, role: ClosableRole, now: Date): Promise<IRoleClosureRequest | null> {
    return await RoleClosureRequestModel.findOne({
      user_id: userId,
      role,
      status: 'pending',
      expires_at: { $lte: now },
    }).exec();
  }

  async findById(requestId: string): Promise<IRoleClosureRequest | null> {
    if (!Types.ObjectId.isValid(requestId)) return null;
    return await RoleClosureRequestModel.findById(requestId).exec();
  }

  /** Newest first. Unpaginated: a user collects a handful of these in a lifetime. */
  async listForUser(userId: string): Promise<IRoleClosureRequest[]> {
    return await RoleClosureRequestModel.find({ user_id: userId }).sort({ created_at: -1 }).limit(50).exec();
  }

  /**
   * Retire pending rows past their expiry, so the partial unique index admits a new request.
   * Lazy expiry's only write.
   */
  async expireStale(userId: string, role: ClosableRole, now: Date): Promise<number> {
    const result = await RoleClosureRequestModel.updateMany(
      { user_id: userId, role, status: 'pending', expires_at: { $lte: now } },
      { $set: { status: 'expired', resolved_at: now } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  /** Administrator cancel. No expiry condition: cancelling a stale request is harmless. */
  async cancel(requestId: string, actor: ActorRef, now: Date): Promise<IRoleClosureRequest | null> {
    return await RoleClosureRequestModel.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status: 'cancelled', resolved_at: now, ...actorStamp('resolved_by', actor) } },
      { new: true },
    ).exec();
  }

  async decline(
    requestId: string,
    actor: ActorRef,
    note: string | null,
    now: Date,
  ): Promise<IRoleClosureRequest | null> {
    return await RoleClosureRequestModel.findOneAndUpdate(
      { _id: requestId, status: 'pending', expires_at: { $gt: now } },
      {
        $set: {
          status: 'declined',
          resolved_at: now,
          decline_note: note,
          ...actorStamp('resolved_by', actor),
        },
      },
      { new: true },
    ).exec();
  }

  /**
   * The confirm's compare-and-set — run FIRST inside the closure transaction, so two confirms
   * racing (two tabs, a tap and a dashboard) run the cascade exactly once.
   */
  async confirm(
    requestId: string,
    actor: ActorRef,
    now: Date,
    session: ClientSession,
  ): Promise<IRoleClosureRequest | null> {
    return await RoleClosureRequestModel.findOneAndUpdate(
      { _id: requestId, status: 'pending', expires_at: { $gt: now } },
      { $set: { status: 'confirmed', resolved_at: now, ...actorStamp('resolved_by', actor) } },
      { new: true, session },
    ).exec();
  }

  /**
   * Fill in the outcome counts once the cascade has run, inside the same transaction. Split
   * from `confirm` because the CAS must come first and the counts are only known after.
   */
  async recordOutcome(
    requestId: string,
    outcome: { closedAt: Date; accountClosed: boolean; endedRelationships: number },
    session: ClientSession,
  ): Promise<void> {
    await RoleClosureRequestModel.updateOne(
      { _id: requestId },
      {
        $set: {
          outcome: {
            closed_at: outcome.closedAt,
            account_closed: outcome.accountClosed,
            ended_relationships: outcome.endedRelationships,
          },
        },
      },
      { session },
    ).exec();
  }
}
