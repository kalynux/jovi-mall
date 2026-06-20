import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { vendorPlanService } from '../services/vendor-plan.service';
import { CreatePlanSchema, UpdatePlanSchema, AssignPlanSchema } from '../validators/billing.validators';

/**
 * Admin-facing billing endpoints: pricing plan catalog CRUD and assigning a plan
 * to a vendor (after a payment is confirmed out of band).
 */
export class AdminBillingController {
  static listPlans = asyncHandler(async (_req: Request, res: Response) => {
    const plans = await pricingPlanService.listForRole('vendor', false);
    res.json({ success: true, data: plans });
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
    const adminUserId = req.auth!.user._id.toString();
    const { planId, paymentRef } = AssignPlanSchema.parse(req.body);
    const vendorPlan = await vendorPlanService.assignPlan(req.params.vendorId, planId, {
      paymentRef: paymentRef ?? null,
      adminId: adminUserId,
    });
    res.json({ success: true, data: vendorPlan, message: 'Plan assigned' });
  });
}
