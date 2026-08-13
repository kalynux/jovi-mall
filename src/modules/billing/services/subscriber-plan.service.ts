import { ClientSession, Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { SubscriberPlanRepository } from '../repositories/subscriber-plan.repository';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { CreditWalletService, creditWalletService } from './credit-wallet.service';
import { ISubscriberPlan } from '../models/subscriber-plan.model';
import { IPricingPlan } from '../models/pricing-plan.model';
import { BillingOwnerType, freePlanCode } from '../billing.types';
import { ActorRef } from '../../../core/types/actor-source.types';

export interface AssignPlanOptions {
  paymentRef?: string | null;
  /**
   * Who assigned the plan, when a human did.
   *
   * An `ActorRef` rather than a bare id: an administrator assigning a plan now arrives
   * through `requireAdminCaller` and holds no `users` row here, so `assigned_by` alone
   * would be an id resolving in no collection with nothing to say so. `null` for the
   * self-service purchase path and for the lazily-created free default — nobody assigned
   * those. See `core/types/actor-source.types.ts`.
   */
  assignedBy?: ActorRef | null;
}

/** The three columns one actor stamp writes, for a create (not an update) path. */
function assignedByFields(actor: ActorRef | null | undefined) {
  return {
    assigned_by: actor ? new Types.ObjectId(actor.userId) : null,
    assigned_by_source: actor?.source ?? 'platform',
    assigned_by_name: actor?.name ?? null,
  };
}

export interface SubscriberPlanView {
  active: { plan: IPricingPlan; subscriberPlan: ISubscriberPlan } | null;
  pending: { plan: IPricingPlan; subscriberPlan: ISubscriberPlan } | null;
}

/**
 * SubscriberPlanService - assigns plans, queues advance purchases, and performs
 * the expiry → handover/downgrade transitions for ANY owner type (vendor, agency
 * or agent). Credit allowances are granted exactly once, at the moment a plan
 * becomes active, inside the same transaction as the status change.
 *
 * Whenever a plan becomes the owner's active plan, a `plan.activated` domain
 * event is published post-commit carrying the plan's entitlements — the seam the
 * agents module consumes to sync an agent's `capacity.max_active_shipments`
 * without billing importing the agents module.
 *
 * (Formerly `VendorPlanService`; generalized to owner scope.)
 */
export class SubscriberPlanService {
  constructor(
    private readonly planRepoAssignments: SubscriberPlanRepository = new SubscriberPlanRepository(),
    private readonly planRepo: PricingPlanRepository = new PricingPlanRepository(),
    private readonly wallet: CreditWalletService = creditWalletService
  ) {}

  /**
   * The owner's active plan, lazily creating (and granting the allowance for) the
   * role's free tier the first time an owner has none.
   */
  async getActivePlan(ownerType: BillingOwnerType, ownerId: string): Promise<ISubscriberPlan> {
    const existing = await this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'active');
    if (existing) return existing;

    const free = await this.requirePlanByCode(ownerType, freePlanCode(ownerType));
    try {
      const created = await transactionManager.runInTransaction((session) =>
        this.activateNew(ownerType, ownerId, free, { assignedBy: null, paymentRef: null }, true, session)
      );
      void this.emitActivated(ownerType, ownerId, free);
      return created;
    } catch (err) {
      // Lost a race to create the active default — re-read the winner.
      if (this.isDuplicateKey(err)) {
        const active = await this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'active');
        if (active) return active;
      }
      throw err;
    }
  }

  /**
   * The owner's active plan, or `null` — WITHOUT the lazy free-tier creation.
   *
   * `getActivePlan` above creates the free tier and grants its allowance when an owner
   * has none, which is right for the owner's own first read and wrong for anyone
   * observing them: an administrator paging a list of accounts must not mint a plan and
   * a credit grant for each one they look at. Callers that observe use this; callers
   * that act on the owner's behalf use `getActivePlan`.
   */
  async findActivePlanWithoutCreating(
    ownerType: BillingOwnerType,
    ownerId: string
  ): Promise<ISubscriberPlan | null> {
    return this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'active');
  }

  /** Full plan view (active + pending) for the owner-facing read API. */
  async getPlanView(ownerType: BillingOwnerType, ownerId: string): Promise<SubscriberPlanView> {
    const active = await this.getActivePlan(ownerType, ownerId);
    const pending = await this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'pending_activation');
    const activePlan = await this.planRepo.findById(active.plan_id.toString());
    const pendingPlan = pending ? await this.planRepo.findById(pending.plan_id.toString()) : null;
    return {
      active: activePlan ? { plan: activePlan, subscriberPlan: active } : null,
      pending: pending && pendingPlan ? { plan: pendingPlan, subscriberPlan: pending } : null,
    };
  }

  /**
   * Assign a plan to an owner (admin action or applied purchase).
   * - If the current active plan is free/never-expiring or already past expiry:
   *   activate immediately and grant the allowance.
   * - If the current active plan is paid with a future expiry: queue the new plan
   *   as `pending_activation`, starting when the active one expires. Only one
   *   pending plan is allowed at a time.
   */
  async assignPlan(
    ownerType: BillingOwnerType,
    ownerId: string,
    planId: string,
    opts: AssignPlanOptions = {}
  ): Promise<ISubscriberPlan> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
    if (!plan.is_active) throw createAppError(ERROR_CODES.BILLING_PLAN_INACTIVE, 409, 'Plan is not active');
    if (plan.role !== ownerType) {
      throw createAppError(
        ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH,
        409,
        `Plan does not belong to the ${ownerType} role`
      );
    }

    const active = await this.getActivePlan(ownerType, ownerId);
    const now = new Date();
    const activeHasFutureExpiry = active.expires_at != null && active.expires_at > now;

    if (!activeHasFutureExpiry) {
      // Activate immediately, expiring the current (free or lapsed) plan.
      const activated = await transactionManager.runInTransaction(async (session) => {
        await this.planRepoAssignments.setStatus(active._id, { status: 'expired' }, session);
        return this.activateNew(ownerType, ownerId, plan, opts, true, session);
      });
      void this.emitActivated(ownerType, ownerId, plan);
      return activated;
    }

    // Active plan still has time left → queue as pending.
    const pending = await this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'pending_activation');
    if (pending) {
      throw createAppError(
        ERROR_CODES.BILLING_PENDING_PLAN_EXISTS,
        409,
        'A plan is already queued to activate when the current one expires'
      );
    }
    const startsAt = active.expires_at!;
    return this.planRepoAssignments.create({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      plan_id: plan._id,
      plan_code: plan.code,
      status: 'pending_activation',
      started_at: startsAt,
      expires_at: plan.term_days ? new Date(startsAt.getTime() + plan.term_days * 86_400_000) : null,
      ...assignedByFields(opts.assignedBy),
      payment_reference: opts.paymentRef ?? null,
      allowance_granted: false,
    });
  }

  /**
   * Promote an owner's pending plan to active (called by the expiry worker).
   * Returns the newly-activated plan, or null when no pending plan exists.
   */
  async activatePending(
    ownerType: BillingOwnerType,
    ownerId: string,
    expiredActiveId: Types.ObjectId
  ): Promise<ISubscriberPlan | null> {
    const pending = await this.planRepoAssignments.findByOwnerAndStatus(ownerType, ownerId, 'pending_activation');
    if (!pending) return null;
    const plan = await this.planRepo.findById(pending.plan_id.toString());
    if (!plan) return null;

    const updated = await transactionManager.runInTransaction(async (session) => {
      await this.planRepoAssignments.setStatus(expiredActiveId, { status: 'expired' }, session);
      const now = new Date();
      const promoted = await this.planRepoAssignments.setStatus(
        pending._id,
        {
          status: 'active',
          started_at: now,
          expires_at: plan.term_days ? new Date(now.getTime() + plan.term_days * 86_400_000) : null,
        },
        session
      );
      if (!pending.allowance_granted && plan.credit_allowance > 0) {
        await this.grantAllowance(ownerType, ownerId, pending._id, plan, session);
      }
      return promoted!;
    });
    void this.emitActivated(ownerType, ownerId, plan);
    return updated;
  }

  /**
   * Downgrade an expired paid plan to the role's free tier. The free allowance is
   * NOT re-granted (it's a one-time signup grant); the owner keeps any leftover
   * credits in their wallet.
   */
  async downgradeToFree(
    ownerType: BillingOwnerType,
    ownerId: string,
    expiredActiveId: Types.ObjectId
  ): Promise<ISubscriberPlan> {
    const free = await this.requirePlanByCode(ownerType, freePlanCode(ownerType));
    const activated = await transactionManager.runInTransaction(async (session) => {
      await this.planRepoAssignments.setStatus(expiredActiveId, { status: 'expired' }, session);
      return this.activateNew(ownerType, ownerId, free, { assignedBy: null, paymentRef: null }, false, session);
    });
    void this.emitActivated(ownerType, ownerId, free);
    return activated;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Create an `active` SubscriberPlan for `plan` and (optionally) grant its credit
   * allowance — all within the caller's transaction.
   */
  private async activateNew(
    ownerType: BillingOwnerType,
    ownerId: string,
    plan: IPricingPlan,
    opts: AssignPlanOptions,
    grantAllowance: boolean,
    session: ClientSession
  ): Promise<ISubscriberPlan> {
    const now = new Date();
    const willGrant = grantAllowance && plan.credit_allowance > 0;
    const created = await this.planRepoAssignments.create(
      {
        owner_type: ownerType,
        owner_id: new Types.ObjectId(ownerId),
        plan_id: plan._id,
        plan_code: plan.code,
        status: 'active',
        started_at: now,
        expires_at: plan.term_days ? new Date(now.getTime() + plan.term_days * 86_400_000) : null,
        ...assignedByFields(opts.assignedBy),
        payment_reference: opts.paymentRef ?? null,
        allowance_granted: willGrant,
      },
      session
    );
    if (willGrant) {
      await this.grantAllowance(ownerType, ownerId, created._id, plan, session);
    }
    return created;
  }

  /** Credit a plan's allowance once and flag the SubscriberPlan, inside `session`. */
  private async grantAllowance(
    ownerType: BillingOwnerType,
    ownerId: string,
    subscriberPlanId: Types.ObjectId,
    plan: IPricingPlan,
    session: ClientSession
  ): Promise<void> {
    await this.wallet.creditInSession(
      ownerType,
      ownerId,
      plan.credit_allowance,
      'allowance',
      'plan_allowance',
      plan._id.toString(),
      session
    );
    await this.planRepoAssignments.setStatus(subscriberPlanId, { allowance_granted: true }, session);
  }

  /**
   * Publish `plan.activated` post-commit, fire-and-forget. Carries the plan's
   * entitlements so consumers (e.g. agent capacity sync) need no re-read.
   */
  private async emitActivated(
    ownerType: BillingOwnerType,
    ownerId: string,
    plan: IPricingPlan
  ): Promise<void> {
    await eventBus.publish('plan.activated', {
      eventType: 'plan.activated',
      aggregateId: ownerId,
      occurredAt: new Date(),
      payload: {
        ownerType,
        ownerId,
        planCode: plan.code,
        planId: plan._id.toString(),
        maxUnterminatedShipments: plan.max_unterminated_shipments,
        liveTrackingEnabled: plan.live_tracking_enabled,
      },
    });
  }

  private async requirePlanByCode(role: BillingOwnerType, code: string): Promise<IPricingPlan> {
    const plan = await this.planRepo.findByCode(role, code);
    if (!plan) {
      throw createAppError(
        ERROR_CODES.BILLING_PLAN_NOT_FOUND,
        404,
        `Default ${role} plan '${code}' is not configured. Run the plan seed.`
      );
    }
    return plan;
  }

  private isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }
}

export const subscriberPlanService = new SubscriberPlanService();
