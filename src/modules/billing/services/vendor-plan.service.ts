import { ClientSession, Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { VendorPlanRepository } from '../repositories/vendor-plan.repository';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { CreditWalletService, creditWalletService } from './credit-wallet.service';
import { IVendorPlan } from '../models/vendor-plan.model';
import { IPricingPlan } from '../models/pricing-plan.model';

/** Code of the free, never-expiring default tier every vendor falls back to. */
export const FREE_PLAN_CODE = 'starter';

export interface AssignPlanOptions {
  paymentRef?: string | null;
  adminId?: string | null;
}

export interface VendorPlanView {
  active: { plan: IPricingPlan; vendorPlan: IVendorPlan } | null;
  pending: { plan: IPricingPlan; vendorPlan: IVendorPlan } | null;
}

/**
 * VendorPlanService - assigns plans, queues advance purchases, and performs the
 * expiry → handover/downgrade transitions. Credit allowances are granted exactly
 * once, at the moment a plan becomes active, inside the same transaction as the
 * status change.
 */
export class VendorPlanService {
  constructor(
    private readonly vendorPlanRepo: VendorPlanRepository = new VendorPlanRepository(),
    private readonly planRepo: PricingPlanRepository = new PricingPlanRepository(),
    private readonly wallet: CreditWalletService = creditWalletService
  ) {}

  /**
   * The vendor's active plan, lazily creating (and granting the allowance for)
   * the free Starter the first time a vendor has none.
   */
  async getActivePlan(vendorId: string): Promise<IVendorPlan> {
    const existing = await this.vendorPlanRepo.findByVendorAndStatus(vendorId, 'active');
    if (existing) return existing;

    const free = await this.requirePlanByCode(FREE_PLAN_CODE);
    try {
      return await transactionManager.runInTransaction((session) =>
        this.activateNew(vendorId, free, { adminId: null, paymentRef: null }, true, session)
      );
    } catch (err) {
      // Lost a race to create the active default — re-read the winner.
      if (this.isDuplicateKey(err)) {
        const active = await this.vendorPlanRepo.findByVendorAndStatus(vendorId, 'active');
        if (active) return active;
      }
      throw err;
    }
  }

  /** Full plan view (active + pending) for the vendor-facing read API. */
  async getVendorPlanView(vendorId: string): Promise<VendorPlanView> {
    const active = await this.getActivePlan(vendorId);
    const pending = await this.vendorPlanRepo.findByVendorAndStatus(vendorId, 'pending_activation');
    const activePlan = await this.planRepo.findById(active.plan_id.toString());
    const pendingPlan = pending ? await this.planRepo.findById(pending.plan_id.toString()) : null;
    return {
      active: activePlan ? { plan: activePlan, vendorPlan: active } : null,
      pending: pending && pendingPlan ? { plan: pendingPlan, vendorPlan: pending } : null,
    };
  }

  /**
   * Assign a plan to a vendor (admin action, after a confirmed payment).
   * - If the current active plan is free/never-expiring or already past expiry:
   *   activate immediately and grant the allowance.
   * - If the current active plan is paid with a future expiry: queue the new
   *   plan as `pending_activation`, starting when the active one expires. Only
   *   one pending plan is allowed at a time.
   */
  async assignPlan(vendorId: string, planId: string, opts: AssignPlanOptions = {}): Promise<IVendorPlan> {
    const plan = await this.planRepo.findById(planId);
    if (!plan) throw createAppError(ERROR_CODES.BILLING_PLAN_NOT_FOUND, 404, 'Pricing plan not found');
    if (!plan.is_active) throw createAppError(ERROR_CODES.BILLING_PLAN_INACTIVE, 409, 'Plan is not active');
    if (plan.role !== 'vendor') {
      throw createAppError(ERROR_CODES.BILLING_PLAN_ROLE_MISMATCH, 409, 'Plan does not belong to the vendor role');
    }

    const active = await this.getActivePlan(vendorId);
    const now = new Date();
    const activeHasFutureExpiry = active.expires_at != null && active.expires_at > now;

    if (!activeHasFutureExpiry) {
      // Activate immediately, expiring the current (free or lapsed) plan.
      return transactionManager.runInTransaction(async (session) => {
        await this.vendorPlanRepo.setStatus(active._id, { status: 'expired' }, session);
        return this.activateNew(vendorId, plan, opts, true, session);
      });
    }

    // Active plan still has time left → queue as pending.
    const pending = await this.vendorPlanRepo.findByVendorAndStatus(vendorId, 'pending_activation');
    if (pending) {
      throw createAppError(
        ERROR_CODES.BILLING_PENDING_PLAN_EXISTS,
        409,
        'A plan is already queued to activate when the current one expires'
      );
    }
    const startsAt = active.expires_at!;
    return this.vendorPlanRepo.create({
      vendor_id: new Types.ObjectId(vendorId),
      plan_id: plan._id,
      plan_code: plan.code,
      status: 'pending_activation',
      started_at: startsAt,
      expires_at: plan.term_days ? new Date(startsAt.getTime() + plan.term_days * 86_400_000) : null,
      assigned_by: opts.adminId ? new Types.ObjectId(opts.adminId) : null,
      payment_reference: opts.paymentRef ?? null,
      allowance_granted: false,
    });
  }

  /**
   * Promote a vendor's pending plan to active (called by the expiry worker).
   * Returns the newly-activated plan, or null when no pending plan exists.
   */
  async activatePending(vendorId: string, expiredActiveId: Types.ObjectId): Promise<IVendorPlan | null> {
    const pending = await this.vendorPlanRepo.findByVendorAndStatus(vendorId, 'pending_activation');
    if (!pending) return null;
    const plan = await this.planRepo.findById(pending.plan_id.toString());
    if (!plan) return null;

    return transactionManager.runInTransaction(async (session) => {
      await this.vendorPlanRepo.setStatus(expiredActiveId, { status: 'expired' }, session);
      const now = new Date();
      const updated = await this.vendorPlanRepo.setStatus(
        pending._id,
        {
          status: 'active',
          started_at: now,
          expires_at: plan.term_days ? new Date(now.getTime() + plan.term_days * 86_400_000) : null,
        },
        session
      );
      if (!pending.allowance_granted && plan.credit_allowance > 0) {
        await this.grantAllowance(vendorId, pending._id, plan, session);
      }
      return updated!;
    });
  }

  /**
   * Downgrade an expired paid plan to the free tier. The free allowance is NOT
   * re-granted (it's a one-time signup grant); the vendor keeps any leftover
   * credits in their wallet.
   */
  async downgradeToFree(vendorId: string, expiredActiveId: Types.ObjectId): Promise<IVendorPlan> {
    const free = await this.requirePlanByCode(FREE_PLAN_CODE);
    return transactionManager.runInTransaction(async (session) => {
      await this.vendorPlanRepo.setStatus(expiredActiveId, { status: 'expired' }, session);
      return this.activateNew(vendorId, free, { adminId: null, paymentRef: null }, false, session);
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Create an `active` VendorPlan for `plan` and (optionally) grant its credit
   * allowance — all within the caller's transaction.
   */
  private async activateNew(
    vendorId: string,
    plan: IPricingPlan,
    opts: AssignPlanOptions,
    grantAllowance: boolean,
    session: ClientSession
  ): Promise<IVendorPlan> {
    const now = new Date();
    const willGrant = grantAllowance && plan.credit_allowance > 0;
    const created = await this.vendorPlanRepo.create(
      {
        vendor_id: new Types.ObjectId(vendorId),
        plan_id: plan._id,
        plan_code: plan.code,
        status: 'active',
        started_at: now,
        expires_at: plan.term_days ? new Date(now.getTime() + plan.term_days * 86_400_000) : null,
        assigned_by: opts.adminId ? new Types.ObjectId(opts.adminId) : null,
        payment_reference: opts.paymentRef ?? null,
        allowance_granted: willGrant,
      },
      session
    );
    if (willGrant) {
      await this.grantAllowance(vendorId, created._id, plan, session);
    }
    return created;
  }

  /** Credit a plan's allowance once and flag the VendorPlan, inside `session`. */
  private async grantAllowance(
    vendorId: string,
    vendorPlanId: Types.ObjectId,
    plan: IPricingPlan,
    session: ClientSession
  ): Promise<void> {
    await this.wallet.creditInSession(
      'vendor',
      vendorId,
      plan.credit_allowance,
      'allowance',
      'plan_allowance',
      plan._id.toString(),
      session
    );
    await this.vendorPlanRepo.setStatus(vendorPlanId, { allowance_granted: true }, session);
  }

  private async requirePlanByCode(code: string): Promise<IPricingPlan> {
    const plan = await this.planRepo.findByCode('vendor', code);
    if (!plan) {
      throw createAppError(
        ERROR_CODES.BILLING_PLAN_NOT_FOUND,
        404,
        `Default plan '${code}' is not configured. Run the plan seed.`
      );
    }
    return plan;
  }

  private isDuplicateKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
  }
}

export const vendorPlanService = new VendorPlanService();
