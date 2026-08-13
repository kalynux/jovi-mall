import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { subscriberPlanService } from '../services/subscriber-plan.service';
import {
  CreatePlanSchema,
  UpdatePlanSchema,
  AssignPlanSchema,
  ListPlansQuerySchema,
  EntitlementParamsSchema,
} from '../validators/billing.validators';
import { entitlementService } from '../services/entitlement.service';
import { BILLING_OWNER_TYPES, BillingOwnerType } from '../billing.types';
import { sendSuccess, sendCreated, sendMessage } from '../../../core/responses';
import { actorFromRequest } from '../../../core/types/actor-source.types';

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
    sendSuccess(res, groups.flat());
  });

  static createPlan = asyncHandler(async (req: Request, res: Response) => {
    const input = CreatePlanSchema.parse(req.body);
    const plan = await pricingPlanService.create(input);
    sendCreated(res, plan, { message: 'Plan created' });
  });

  static updatePlan = asyncHandler(async (req: Request, res: Response) => {
    const updates = UpdatePlanSchema.parse(req.body);
    const plan = await pricingPlanService.update(req.params.id, updates);
    sendSuccess(res, plan, { message: 'Plan updated' });
  });

  static deletePlan = asyncHandler(async (req: Request, res: Response) => {
    await pricingPlanService.remove(req.params.id);
    sendMessage(res, 'Plan archived');
  });

  /**
   * GET /entitlements/:ownerType/:ownerId — the limits this owner's plan grants.
   *
   * A delegated VERDICT, not a record: these are the numbers the platform itself
   * branches on (`assertCanAddProduct`, the shipment cap, the commission every split
   * multiplies by), and a copy of the resolution in wi-admin would be a second
   * definition of what an owner may do. It is read-only — see
   * `EntitlementService.getAdminEntitlements`, which deliberately does not lazily
   * create a plan the way the owner-facing path does.
   */
  static getEntitlements = asyncHandler(async (req: Request, res: Response) => {
    const { ownerType, ownerId } = EntitlementParamsSchema.parse(req.params);
    const entitlements = await entitlementService.getAdminEntitlements(ownerType, ownerId);
    sendSuccess(res, { ownerType, ownerId, ...entitlements });
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
    const { planId, paymentRef } = AssignPlanSchema.parse(req.body);
    // `actorFromRequest` rather than the bare id: the caller may be a wi-admin
    // administrator over `/api/internal/admin`, whose id resolves in no collection
    // here. It stamps the source and a name snapshot beside the id.
    const subscriberPlan = await subscriberPlanService.assignPlan(ownerType, ownerId, planId, {
      paymentRef: paymentRef ?? null,
      assignedBy: actorFromRequest(req),
    });
    sendSuccess(res, subscriberPlan, { message: 'Plan assigned' });
  }
}
