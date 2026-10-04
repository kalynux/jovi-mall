import bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { UserRepository } from '../../users/user.repository';
import { CustomerRepository } from '../../customers/customer.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgentRepository } from '../../agents/repositories/agent.repository';
import { StoreModel } from '../../store/models/store.model';
import { AgencyMagazinModel } from '../../magazin/models/magazin.model';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { auditLogger } from '../../../core/audit/audit-logger';
import { ActorRef } from '../../../core/types/actor-source.types';
import { IRoleClosureRequest } from '../models/role-closure-request.model';
import { RoleClosureRequestRepository } from '../repositories/role-closure-request.repository';
import { RoleClosureBlockersService, roleClosureBlockersService } from './role-closure-blockers.service';
import { RoleClosureManifest, roleClosureManifest, EndedRelationships, countEnded } from '../role-closure.manifest';
import { ClosableRole, ROLE_CLOSURE_REQUEST_TTL_DAYS, RoleClosureOutcome } from '../role-closure.types';

/**
 * Role closure — the lifecycle (ADR-A10).
 *
 *   administrator  request ──► pending ──► cancel                       (wi-admin, users.close)
 *   user                         │  ├────► decline                      (/api/me, as that role)
 *                                │  └────► confirm ──► role anonymised  (/api/me, as that role)
 *                                └── 7 days pass ──► expired            (lazily, on read)
 *
 * ── The confirm is the only write that touches the role ───────────────────────
 * A request is a question; nothing about the role changes while it is pending. The confirm
 * re-checks the blockers (seven days is long enough for a new order), then runs ONE
 * transaction: the request's compare-and-set FIRST — so two confirms racing run the cascade
 * exactly once — then the manifest, then the account half. Events and the audit line are
 * post-commit, as `AccountClosureService` does: an event announcing a closure that rolled
 * back is worse than a late one.
 *
 * ── Who may answer ────────────────────────────────────────────────────────────
 * Only the account owner, signed in AS the role being closed. The controller passes the
 * caller's `role` and `role_entity._id` from `req.auth`; the request is found by (user, role)
 * and its snapshotted entity must match. An agent session cannot confirm the closure of the
 * same person's vendor role — they confirm it from the vendor dashboard.
 */
export class RoleClosureService {
  constructor(
    private readonly requests: RoleClosureRequestRepository = new RoleClosureRequestRepository(),
    private readonly blockers: RoleClosureBlockersService = roleClosureBlockersService,
    private readonly manifest: RoleClosureManifest = roleClosureManifest,
    private readonly users: UserRepository = new UserRepository(),
    private readonly customers: CustomerRepository = new CustomerRepository(),
    private readonly vendors: VendorRepository = new VendorRepository(),
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly agents: AgentRepository = new AgentRepository(),
  ) {}

  // ─── administrator ─────────────────────────────────────────────────────────

  /**
   * Ask the user to close one of their roles. Refuses up front on anything that would make
   * the user's confirm fail, so the administrator learns it now rather than the user later.
   */
  async request(input: {
    userId: string;
    role: ClosableRole;
    reason: string;
    actor: ActorRef;
  }): Promise<IRoleClosureRequest> {
    const { userId, role, reason, actor } = input;
    const user = Types.ObjectId.isValid(userId) ? await this.users.findById(userId) : null;
    if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);
    if (user.status !== 'active') {
      throw createAppError(ERROR_CODES.USER_STATUS_CONFLICT, 409, 'This account is not active', {
        expected: 'active',
        actual: user.status,
      });
    }
    if (!(user.roles ?? []).includes(role as any)) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_ROLE_NOT_HELD, 422, undefined, { role });
    }

    const entity = await this.findEntity(role, userId);
    if (!entity) throw createAppError(ERROR_CODES.ROLE_CLOSURE_ROLE_NOT_HELD, 422, undefined, { role });
    if (entity.closed_at) throw createAppError(ERROR_CODES.ROLE_CLOSED, 409, undefined, { role });
    const roleEntityId = entity._id.toString();

    const now = new Date();
    const existing = await this.requests.findPending(userId, role, now);
    if (existing) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_ALREADY_PENDING, 409, undefined, {
        requestId: existing._id.toString(),
        expiresAt: existing.expires_at.toISOString(),
      });
    }

    const blockers = await this.blockers.evaluate(role, roleEntityId, userId);
    if (blockers.length > 0) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_BLOCKED, 422, undefined, { role, blockers });
    }

    const warnings = await this.blockers.warnings(role, roleEntityId);

    // Lazy expiry's one write: a stale pending row would otherwise hold the partial unique index.
    await this.requests.expireStale(userId, role, now);

    let created: IRoleClosureRequest;
    try {
      created = await this.requests.create({
        userId,
        role,
        roleEntityId,
        reason,
        requestedBy: actor,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + ROLE_CLOSURE_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000),
        warnings,
      });
    } catch (error) {
      // Two administrators asking in the same instant: the index is what decided.
      if ((error as { code?: number })?.code === 11000) {
        throw createAppError(ERROR_CODES.ROLE_CLOSURE_ALREADY_PENDING, 409, undefined, { role });
      }
      throw error;
    }

    void eventBus
      .publish('role_closure.requested', {
        eventType: 'role_closure.requested',
        aggregateId: created._id.toString(),
        payload: {
          requestId: created._id.toString(),
          userId,
          role,
          roleEntityId,
          reason,
          expiresAt: created.expires_at.toISOString(),
        },
        occurredAt: now,
      })
      .catch((error) => console.error('[RoleClosure] requested publish failed:', error));

    return created;
  }

  /** Withdraw a pending request. 404 when there is none to withdraw. */
  async cancel(userId: string, role: ClosableRole, actor: ActorRef): Promise<IRoleClosureRequest> {
    const now = new Date();
    const pending = await this.requests.findPending(userId, role, now);
    if (!pending) throw createAppError(ERROR_CODES.ROLE_CLOSURE_REQUEST_NOT_FOUND, 404, undefined, { role });
    const cancelled = await this.requests.cancel(pending._id.toString(), actor, now);
    if (!cancelled) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_REQUEST_NOT_FOUND, 404, 'The request was answered a moment ago', { role });
    }
    return cancelled;
  }

  async listForUser(userId: string): Promise<IRoleClosureRequest[]> {
    if (!Types.ObjectId.isValid(userId)) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);
    return await this.requests.listForUser(userId);
  }

  // ─── the user ──────────────────────────────────────────────────────────────

  /**
   * The caller's pending request for the role they are signed in as, with the blockers as
   * they stand NOW — so a dashboard can say "settle these first" before offering the button.
   */
  async getForCaller(userId: string, role: ClosableRole, roleEntityId: string) {
    const request = await this.requests.findPending(userId, role, new Date());
    if (!request || request.role_entity_id.toString() !== roleEntityId) return null;
    const blockers = await this.blockers.evaluate(role, roleEntityId, userId);
    return { request, blockers };
  }

  async decline(userId: string, role: ClosableRole, roleEntityId: string, note: string | null): Promise<IRoleClosureRequest> {
    const request = await this.requirePendingForCaller(userId, role, roleEntityId);
    const declined = await this.requests.decline(
      request._id.toString(),
      { userId, source: 'platform', name: null },
      note,
      new Date(),
    );
    if (!declined) throw this.answeredOrExpired(role);
    void eventBus
      .publish('role_closure.declined', {
        eventType: 'role_closure.declined',
        aggregateId: declined._id.toString(),
        payload: { requestId: declined._id.toString(), userId, role, roleEntityId },
        occurredAt: new Date(),
      })
      .catch((error) => console.error('[RoleClosure] declined publish failed:', error));
    return declined;
  }

  async confirm(userId: string, role: ClosableRole, roleEntityId: string): Promise<{
    request: IRoleClosureRequest;
    outcome: RoleClosureOutcome;
  }> {
    const request = await this.requirePendingForCaller(userId, role, roleEntityId);

    const blockers = await this.blockers.evaluate(role, roleEntityId, userId);
    if (blockers.length > 0) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_BLOCKED, 422, undefined, { role, blockers });
    }

    // The closing party's name, read BEFORE it is anonymised — the counterparties' notices
    // say who left, and after the commit nobody can.
    const closingName = await this.displayNameOf(role, roleEntityId);

    // Hashed outside the transaction (bcrypt cost 12 is ~200 ms). Used only if this is the
    // account's last role; the plaintext is discarded the moment the digest exists.
    const replacementHash = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const closedAt = new Date();
    const actor = { userId, role };

    const { confirmed, ended, accountClosed } = await transactionManager.runInTransaction(async (session) => {
      const confirmed = await this.requests.confirm(
        request._id.toString(),
        { userId, source: 'platform', name: null },
        closedAt,
        session,
      );
      if (!confirmed) throw this.answeredOrExpired(role);

      let ended: EndedRelationships;
      switch (role) {
        case 'customer':
          ended = await this.manifest.closeCustomer(roleEntityId, closedAt, session);
          break;
        case 'vendor':
          ended = await this.manifest.closeVendor(roleEntityId, actor, closedAt, session);
          break;
        case 'agency':
          ended = await this.manifest.closeAgency(roleEntityId, actor, closedAt, session);
          break;
        case 'agent':
          ended = await this.manifest.closeAgent(roleEntityId, actor, closedAt, session);
          break;
      }

      const { accountClosed } = await this.manifest.closeAccountIfLastRole(
        userId,
        role,
        replacementHash,
        closedAt,
        session,
      );

      await this.requests.recordOutcome(
        request._id.toString(),
        { closedAt, accountClosed, endedRelationships: countEnded(ended) },
        session,
      );
      return { confirmed, ended, accountClosed };
    });

    const outcome: RoleClosureOutcome = { closedAt, accountClosed, endedRelationships: countEnded(ended) };

    await eventBus.publish('role_closure.confirmed', {
      eventType: 'role_closure.confirmed',
      aggregateId: confirmed._id.toString(),
      payload: { requestId: confirmed._id.toString(), userId, role, roleEntityId, ...outcome, closedAt: closedAt.toISOString() },
      occurredAt: closedAt,
    });

    if (role !== 'customer' && countEnded(ended) > 0) {
      await eventBus.publish('role_closure.relationships_ended', {
        eventType: 'role_closure.relationships_ended',
        aggregateId: confirmed._id.toString(),
        payload: { closingRole: role, closingName, contracts: ended.contracts, connections: ended.connections },
        occurredAt: closedAt,
      });
    }

    if (accountClosed) {
      // The same signal ADR-A02 self-closure emits, so anything listening for "this account
      // is gone" does not have to know there are two ways to get there.
      await eventBus.publish('user.account.closed', {
        eventType: 'user.account.closed',
        aggregateId: userId,
        payload: { userId, closedAt: closedAt.toISOString(), via: 'role_closure', requestId: confirmed._id.toString() },
        occurredAt: closedAt,
      });
    }

    await auditLogger.log({
      actor: { userId, role },
      action: 'ROLE_CLOSED',
      resource: { type: 'User', id: userId },
      // No `before` — the identifiers are what the closure removed (ADR-A02's reasoning).
      metadata: {
        role,
        roleEntityId,
        requestId: confirmed._id.toString(),
        requestedBy: confirmed.requested_by_user_id?.toString() ?? null,
        ...outcome,
      },
      timestamp: closedAt,
    });

    const final = await this.requests.findById(confirmed._id.toString());
    return { request: final ?? confirmed, outcome };
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private async requirePendingForCaller(userId: string, role: ClosableRole, roleEntityId: string): Promise<IRoleClosureRequest> {
    const now = new Date();
    const request = await this.requests.findPending(userId, role, now);
    if (!request && (await this.requests.findStalePending(userId, role, now))) {
      throw this.answeredOrExpired(role);
    }
    if (!request || request.role_entity_id.toString() !== roleEntityId) {
      throw createAppError(ERROR_CODES.ROLE_CLOSURE_REQUEST_NOT_FOUND, 404, undefined, { role });
    }
    return request;
  }

  /**
   * A compare-and-set miss on a request that WAS pending a moment ago: it was answered,
   * cancelled, or crossed its expiry in between. Expiry gets its own code because the remedy
   * differs (ask the administrator again); the rest is a 404 like any vanished request.
   */
  private answeredOrExpired(role: ClosableRole) {
    return createAppError(ERROR_CODES.ROLE_CLOSURE_REQUEST_EXPIRED, 409, 'This request is no longer waiting for an answer', { role });
  }

  private async findEntity(role: ClosableRole, userId: string): Promise<{ _id: Types.ObjectId; closed_at?: Date | null } | null> {
    switch (role) {
      case 'customer':
        return await this.customers.findByUserId(userId);
      case 'vendor':
        return await this.vendors.findByUserId(userId);
      case 'agency':
        return await this.agencies.findByUserId(userId);
      case 'agent':
        return await this.agents.findByUserId(userId);
    }
  }

  /** The name a counterparty knew this party by: the storefront's, else the profile's. */
  private async displayNameOf(role: ClosableRole, roleEntityId: string): Promise<string> {
    if (role === 'vendor') {
      const store = await StoreModel.findOne({ vendor_id: roleEntityId }, { name: 1 }).lean().exec();
      if (store?.name) return store.name;
      const vendor = await this.vendors.findById(roleEntityId);
      return vendor?.display_name ?? '';
    }
    if (role === 'agency') {
      const magazin = await AgencyMagazinModel.findOne({ agency_id: roleEntityId }, { name: 1 }).lean().exec();
      if (magazin?.name) return magazin.name;
      const agency = await this.agencies.findById(roleEntityId);
      return agency?.display_name ?? '';
    }
    if (role === 'agent') {
      const agent = await this.agents.findById(roleEntityId);
      return agent?.name ?? '';
    }
    return '';
  }
}

export const roleClosureService = new RoleClosureService();
