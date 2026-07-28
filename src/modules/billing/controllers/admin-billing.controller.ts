import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { subscriberPlanService } from '../services/subscriber-plan.service';
import { CreatePlanSchema, UpdatePlanSchema, AssignPlanSchema, ListPlansQuerySchema } from '../validators/billing.validators';
import { BILLING_OWNER_TYPES, BillingOwnerType } from '../billing.types';

/**
 * Admin-facing billing endpoints: pricing plan catalog CRUD (any role) and
 * assigning a plan to a vendor / agency / agent (after a payment is confirmed
 * out of band).
 */
export class AdminBillingController {
  static listPlans = asyncHandler(async (req: Request, res: Response) => {
    const { role } = ListPlansQuerySchema.parse(req.query);
    const roles: BillingOwnerType[] = role ? [role] : [...BILLING_OWNER_TYPES];
    const groups = await Promise.all(roles.map((r) => pricingPlanService.listForRole(r, false)));
    res.json({ success: true, data: groups.flat() });
  });

  static createPlan = asyncHandler(async (req: Request, res: Response) => {
    const input = CreatePlanSchema.parse(req.body);
    const plan = await pricingPlanService.create(input);
    res.status(201).json({ success: true, data: plan, message: 'Plan created' });
  });

  static updatePlan = asyncHandler(async (req: Request, res: Response) => {
    const updates = UpdatePlanSchema.parse(req.body);
    const plan = await pricingPlanService.update(req.params.id, updates);
    res.json({ success: true, data: plan, message: 'Plan updated' });
  });

  static deletePlan = asyncHandler(async (req: Request, res: Response) => {
    await pricingPlanService.remove(req.params.id);
    res.json({ success: true, message: 'Plan archived' });
  });

  static assignPlanToVendor = asyncHandler(async (req: Request, res: Response) => {
    await AdminBillingController.assign('vendor', req.params.vendorId, req, res);
  });

  static assignPlanToAgency = asyncHandler(async (req: Request, res: Response) => {
    await AdminBillingController.assign('agency', req.params.agencyId, req, res);
  });

  static assignPlanToAgent = asyncHandler(async (req: Request, res: Response) => {
    await AdminBillingController.assign('agent', req.params.agentId, req, res);
  });

  private static async assign(
    ownerType: BillingOwnerType,
    ownerId: string,
    req: Request,
    res: Response
  ): Promise<void> {
    const adminUserId = req.auth!.user._id.toString();
    const { planId, paymentRef } = AssignPlanSchema.parse(req.body);
    const subscriberPlan = await subscriberPlanService.assignPlan(ownerType, ownerId, planId, {
      paymentRef: paymentRef ?? null,
      adminId: adminUserId,
    });
    res.json({ success: true, data: subscriberPlan, message: 'Plan assigned' });
  }
}
