import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { PlanPurchaseRepository } from '../repositories/plan-purchase.repository';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { SubscriberPlanRepository } from '../repositories/subscriber-plan.repository';
import { SubscriberPlanService, subscriberPlanService } from './subscriber-plan.service';
import { IPlanPurchase, PlanPurchaseGateway } from '../models/plan-purchase.model';
import { ISubscriberPlan } from '../models/subscriber-plan.model';
import { BillingOwnerType } from '../billing.types';
import { PaymentGateway, PaymentChannelInfo } from '../../payments/gateways/gateway.interface';
import { NotchPayGateway } from '../../payments/gateways/notchpay.gateway';
import { MyCoolPayGateway } from '../../payments/gateways/mycoolpay.gateway';
import { StripeGateway } from '../../payments/gateways/stripe.gateway';

/**
 * PlanPurchaseService - owner SELF-SERVE plan purchase (vendor/agency/agent).
 *
 * The owner buys a paid plan; once the gateway confirms the payment, the plan is
 * assigned/activated on their account automatically (no admin step) by delegating
 * to SubscriberPlanService.assignPlan — which applies the two-plan rule (activate
 * now if free/lapsed, else queue as pending). The owner is stored on the purchase
 * row, so completion (verify poll or webhook) needs no owner argument.
 */
export class PlanPurchaseService {
  private readonly gateways: Map<PlanPurchaseGateway, PaymentGateway>;

  constructor(
    private readonly repo: PlanPurchaseRepository = new PlanPurchaseRepository(),
    private readonly planRepo: PricingPlanRepository = new PricingPlanRepository(),
    private readonly subscriberPlanRepo: SubscriberPlanRepository = new SubscriberPlanRepository(),
    private readonly plans: SubscriberPlanService = subscriberPlanService
  ) {
    this.gateways = new Map<PlanPurchaseGateway, PaymentGateway>([
      ['NOTCHPAY', new NotchPayGateway()],
      ['MYCOOLPAY', new MyCoolPayGateway()],
      ['STRIPE', new StripeGateway()],
    ]);
  }

  /** Start a plan purchase: validate, create a pending record, open a gateway charge. */
  async initiatePurchase(
    ownerType: BillingOwnerType,
    ownerId: string,
    planId: string,
    gateway: PlanPurchaseGateway,
    channel: PaymentChannelInfo
  ): Promise<{ purchase: IPlanPurchase; instructions: unknown }> {
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
    if (plan.price <= 0) {
      throw createAppError(
        ERROR_CODES.BILLING_PLAN_NOT_PURCHASABLE,
        409,
        'This plan is free and cannot be purchased — it is the default tier'
      );
    }

    const adapter = this.gateways.get(gateway);
    if (!adapter) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, `Unsupported gateway '${gateway}'`);
    }

    // Don't take money we can't apply: only one pending plan may be queued at a time.
    const existingPending = await this.subscriberPlanRepo.findByOwnerAndStatus(
      ownerType,
      ownerId,
      'pending_activation'
    );
    if (existingPending) {
      throw createAppError(
        ERROR_CODES.BILLING_PENDING_PLAN_EXISTS,
        409,
        'A plan is already queued to activate when your current one expires'
      );
    }

    const purchase = await this.repo.create({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      plan_id: plan._id,
      plan_code: plan.code,
      price: plan.price,
      currency: plan.currency,
      status: 'pending',
      gateway,
    });

    const result = await adapter.initiatePayment({
      orderId: purchase._id.toString(), // adapters use this only as a reference label
      userId: ownerId,
      amount: plan.price,
      currency: plan.currency,
      channel,
      metadata: {
        purpose: 'plan_purchase',
        planId: plan._id.toString(),
        purchaseId: purchase._id.toString(),
        ownerType,
      },
    });

    if (!result.success) {
      await this.repo.setStatus(purchase._id, 'failed');
      throw createAppError(
        ERROR_CODES.PAYMENT_INITIATION_FAILED,
        502,
        result.error || 'Failed to start the plan purchase payment'
      );
    }

    const updated = await this.repo.setStatus(purchase._id, 'pending', { gateway_ref: result.gatewayRef });
    // Already confirmed at initiation (rare for mobile money) → apply immediately.
    if (result.status === 'SUCCEEDED') {
      const { purchase: applied } = await this.completePurchase(purchase._id.toString());
      return { purchase: applied, instructions: result.instructions ?? null };
    }
    return { purchase: updated ?? purchase, instructions: result.instructions ?? null };
  }

  /** Poll the gateway and apply/fail the purchase accordingly. */
  async verifyAndComplete(
    ownerType: BillingOwnerType,
    ownerId: string,
    purchaseId: string
  ): Promise<{ purchase: IPlanPurchase; subscriberPlan: ISubscriberPlan | null }> {
    const purchase = await this.repo.findById(purchaseId);
    if (!purchase || purchase.owner_type !== ownerType || purchase.owner_id.toString() !== ownerId) {
      throw createAppError(ERROR_CODES.BILLING_PLAN_PURCHASE_NOT_FOUND, 404, 'Plan purchase not found');
    }
    if (purchase.status === 'paid') return { purchase, subscriberPlan: null }; // idempotent
    if (!purchase.gateway || !purchase.gateway_ref) {
      throw createAppError(ERROR_CODES.BILLING_PURCHASE_INVALID_STATE, 409, 'Purchase has no gateway reference yet');
    }

    const adapter = this.gateways.get(purchase.gateway)!;
    const verification = await adapter.verifyPayment({ gatewayRef: purchase.gateway_ref });

    if (verification.status === 'SUCCEEDED') {
      return this.completePurchase(purchaseId);
    }
    if (verification.status === 'FAILED' || verification.status === 'CANCELLED') {
      const failed = (await this.repo.setStatus(purchase._id, 'failed')) ?? purchase;
      return { purchase: failed, subscriberPlan: null };
    }
    return { purchase, subscriberPlan: null }; // still pending
  }

  /**
   * Idempotently mark a purchase paid and assign/activate the plan.
   *
   * Uses an atomic `pending → paid` claim so concurrent verifies (or a webhook +
   * a poll) can't apply the plan twice. On assignment failure the claim is
   * reverted to `pending` so it can be retried.
   */
  async completePurchase(
    purchaseId: string
  ): Promise<{ purchase: IPlanPurchase; subscriberPlan: ISubscriberPlan | null }> {
    const purchase = await this.repo.findById(purchaseId);
    if (!purchase) {
      throw createAppError(ERROR_CODES.BILLING_PLAN_PURCHASE_NOT_FOUND, 404, 'Plan purchase not found');
    }

    const claimed = await this.repo.claimIfPending(purchase._id, 'paid');
    if (!claimed) {
      // Already paid/failed or claimed concurrently — return current state (idempotent).
      const current = (await this.repo.findById(purchaseId)) ?? purchase;
      return { purchase: current, subscriberPlan: null };
    }

    try {
      const subscriberPlan = await this.plans.assignPlan(
        claimed.owner_type,
        claimed.owner_id.toString(),
        claimed.plan_id.toString(),
        // Nobody assigned this one — the owner bought it and the gateway confirmed it.
        { paymentRef: claimed.gateway_ref, assignedBy: null }
      );
      const finalDoc =
        (await this.repo.setStatus(claimed._id, 'paid', { subscriber_plan_id: subscriberPlan._id })) ?? claimed;
      return { purchase: finalDoc, subscriberPlan };
    } catch (err) {
      // Couldn't apply the plan — revert so the owner/admin can retry.
      await this.repo.setStatus(claimed._id, 'pending');
      throw err;
    }
  }

  /**
   * Reverse a paid plan purchase located by its gateway PaymentIntent reference
   * (charge-back / refund). Marks the purchase `reversed` and unwinds the plan:
   * if the resulting SubscriberPlan is still `active` it is downgraded to the free
   * tier; if it was only queued (`pending_activation`) it is cancelled. Idempotent
   * — a non-paid purchase is a no-op. An admin can re-assign the paid plan later
   * via the admin billing endpoint if the dispute resolves in the owner's favour.
   *
   * Returns the affected purchase, or null if none matches the reference.
   */
  async reverseByGatewayRef(gatewayRef: string): Promise<IPlanPurchase | null> {
    const purchase = await this.repo.findByGatewayRef(gatewayRef);
    if (!purchase) return null;
    if (purchase.status !== 'paid') return purchase; // idempotent: only a paid purchase reverses

    // Unwind the granted plan, if any.
    if (purchase.subscriber_plan_id) {
      const subscriberPlan = await this.subscriberPlanRepo.findById(purchase.subscriber_plan_id);
      if (subscriberPlan && subscriberPlan.status === 'active') {
        await this.plans.downgradeToFree(purchase.owner_type, purchase.owner_id.toString(), subscriberPlan._id);
      } else if (subscriberPlan && subscriberPlan.status === 'pending_activation') {
        await this.subscriberPlanRepo.setStatus(subscriberPlan._id, { status: 'cancelled' });
      }
    }

    const reversed = (await this.repo.setStatus(purchase._id, 'reversed')) ?? purchase;
    console.log(`[PlanPurchase] Reversed purchase ${purchase._id} (${gatewayRef}); ${purchase.owner_type} downgraded to free`);
    return reversed;
  }
}

export const planPurchaseService = new PlanPurchaseService();
