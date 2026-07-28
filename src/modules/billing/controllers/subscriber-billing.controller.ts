import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { subscriberPlanService } from '../services/subscriber-plan.service';
import { creditWalletService } from '../services/credit-wallet.service';
import { creditTopupService } from '../services/credit-topup.service';
import { planPurchaseService } from '../services/plan-purchase.service';
import { entitlementService } from '../services/entitlement.service';
import { CREDIT_TOPUP_PACKS } from '../config/credit.config';
import { BillingSettingsRepository } from '../repositories/billing-settings.repository';
import {
  InitiateTopupSchema,
  InitiatePlanPurchaseSchema,
  ExpiryNoticeSchema,
} from '../validators/billing.validators';
import { BillingOwnerType } from '../billing.types';

/** Optional per-role usage block merged into `getMyPlan` (e.g. agency shipment usage). */
export type UsageResolver = (ownerId: string) => Promise<Record<string, unknown>>;

export interface SubscriberBillingController {
  listPlans: ReturnType<typeof asyncHandler>;
  getMyPlan: ReturnType<typeof asyncHandler>;
  purchasePlan: ReturnType<typeof asyncHandler>;
  verifyPlanPurchase: ReturnType<typeof asyncHandler>;
  getBalance: ReturnType<typeof asyncHandler>;
  listTopupPacks: ReturnType<typeof asyncHandler>;
  initiateTopup: ReturnType<typeof asyncHandler>;
  verifyTopup: ReturnType<typeof asyncHandler>;
  getSettings: ReturnType<typeof asyncHandler>;
  updateSettings: ReturnType<typeof asyncHandler>;
}

/**
 * Factory for the owner-scoped billing HTTP handlers shared by agencies and
 * agents (the vendor controller stays separate — it carries vendor-specific
 * storage/entitlement details). Each handler reads the owner id from
 * `req.auth.role_entity._id`; `ownerType` is fixed per instance.
 */
export function createSubscriberBillingController(
  ownerType: BillingOwnerType,
  usageResolver?: UsageResolver
): SubscriberBillingController {
  const settingsRepo = new BillingSettingsRepository();

  return {
    listPlans: asyncHandler(async (_req: Request, res: Response) => {
      const plans = await pricingPlanService.listForRole(ownerType, true);
      res.json({ success: true, data: plans });
    }),

    getMyPlan: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const [view, entitlements] = await Promise.all([
        subscriberPlanService.getPlanView(ownerType, ownerId),
        entitlementService.getShipmentEntitlements(ownerType, ownerId),
      ]);
      const usage = usageResolver ? await usageResolver(ownerId) : {};
      res.json({ success: true, data: { ...view, entitlements, ...usage } });
    }),

    purchasePlan: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const { gateway, channel } = InitiatePlanPurchaseSchema.parse(req.body);
      const result = await planPurchaseService.initiatePurchase(ownerType, ownerId, req.params.planId, gateway, channel);
      res.status(201).json({ success: true, data: result, message: 'Plan purchase initiated' });
    }),

    verifyPlanPurchase: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const result = await planPurchaseService.verifyAndComplete(ownerType, ownerId, req.params.id);
      res.json({ success: true, data: result });
    }),

    getBalance: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const balance = await creditWalletService.getBalance(ownerType, ownerId);
      res.json({ success: true, data: { balance } });
    }),

    listTopupPacks: asyncHandler(async (_req: Request, res: Response) => {
      res.json({ success: true, data: CREDIT_TOPUP_PACKS });
    }),

    initiateTopup: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const { packCode, gateway, channel } = InitiateTopupSchema.parse(req.body);
      const result = await creditTopupService.initiateTopup(ownerType, ownerId, packCode, gateway, channel);
      res.status(201).json({ success: true, data: result, message: 'Top-up initiated' });
    }),

    verifyTopup: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const topup = await creditTopupService.verifyAndComplete(ownerType, ownerId, req.params.id);
      res.json({ success: true, data: topup });
    }),

    getSettings: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const days = await settingsRepo.getNotifyDaysBeforeExpiry(ownerType, ownerId);
      res.json({ success: true, data: { notifyDaysBeforeExpiry: days } });
    }),

    updateSettings: asyncHandler(async (req: Request, res: Response) => {
      const ownerId = req.auth!.role_entity._id.toString();
      const { notifyDaysBeforeExpiry } = ExpiryNoticeSchema.parse(req.body);
      const updated = await settingsRepo.setNotifyDaysBeforeExpiry(ownerType, ownerId, notifyDaysBeforeExpiry);
      res.json({ success: true, data: { notifyDaysBeforeExpiry: updated }, message: 'Settings updated' });
    }),
  };
}
