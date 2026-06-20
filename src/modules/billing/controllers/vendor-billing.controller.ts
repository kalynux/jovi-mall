import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { pricingPlanService } from '../services/pricing-plan.service';
import { vendorPlanService } from '../services/vendor-plan.service';
import { creditWalletService } from '../services/credit-wallet.service';
import { creditTopupService } from '../services/credit-topup.service';
import { planPurchaseService } from '../services/plan-purchase.service';
import { CREDIT_TOPUP_PACKS } from '../config/credit.config';
import {
  InitiateTopupSchema,
  InitiatePlanPurchaseSchema,
  PaginationQuerySchema,
  ExpiryNoticeSchema,
} from '../validators/billing.validators';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';

const vendorSettingsRepository = new VendorSettingsRepository();

/**
 * Vendor-facing billing endpoints: view available plans & current plan, read the
 * credit balance/ledger, and buy credit top-up packs.
 */
export class VendorBillingController {
  static listPlans = asyncHandler(async (_req: Request, res: Response) => {
    const plans = await pricingPlanService.listForRole('vendor', true);
    res.json({ success: true, data: plans });
  });

  static getMyPlan = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const view = await vendorPlanService.getVendorPlanView(vendorId);
    res.json({ success: true, data: view });
  });

  static purchasePlan = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { gateway, channel } = InitiatePlanPurchaseSchema.parse(req.body);
    const result = await planPurchaseService.initiatePurchase(vendorId, req.params.planId, gateway, channel);
    res.status(201).json({ success: true, data: result, message: 'Plan purchase initiated' });
  });

  static verifyPlanPurchase = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const result = await planPurchaseService.verifyAndComplete(vendorId, req.params.id);
    res.json({ success: true, data: result });
  });

  static listPlanPurchases = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { page, limit } = PaginationQuerySchema.parse(req.query);
    const { data, total } = await planPurchaseService.listPurchases(vendorId, page, limit);
    res.json({
      success: true,
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  });

  static getBalance = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const balance = await creditWalletService.getBalance('vendor', vendorId);
    res.json({ success: true, data: { balance } });
  });

  static getLedger = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { page, limit } = PaginationQuerySchema.parse(req.query);
    const { data, total } = await creditWalletService.getLedger('vendor', vendorId, page, limit);
    res.json({
      success: true,
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  });

  static listTopupPacks = asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: CREDIT_TOPUP_PACKS });
  });

  static initiateTopup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { packCode, gateway, channel } = InitiateTopupSchema.parse(req.body);
    const result = await creditTopupService.initiateTopup(vendorId, packCode, gateway, channel);
    res.status(201).json({ success: true, data: result, message: 'Top-up initiated' });
  });

  static verifyTopup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const topup = await creditTopupService.verifyAndComplete(vendorId, req.params.id);
    res.json({ success: true, data: topup });
  });

  static listTopups = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { page, limit } = PaginationQuerySchema.parse(req.query);
    const { data, total } = await creditTopupService.listTopups(vendorId, page, limit);
    res.json({
      success: true,
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  });

  static getSettings = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const days = await vendorSettingsRepository.getNotifyDaysBeforeExpiry(vendorId);
    res.json({ success: true, data: { notifyDaysBeforeExpiry: days } });
  });

  static updateSettings = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { notifyDaysBeforeExpiry } = ExpiryNoticeSchema.parse(req.body);
    const updated = await vendorSettingsRepository.setNotifyDaysBeforeExpiry(vendorId, notifyDaysBeforeExpiry);
    res.json({ success: true, data: { notifyDaysBeforeExpiry: updated }, message: 'Settings updated' });
  });
}
