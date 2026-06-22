import { Request, Response } from 'express';
import { z } from 'zod';
import { VendorProfileService } from '../service/vendor-profile.service';
import { UserService } from '../../users/user.service';
import {
  UpdateVendorProfileSchema,
  UpdatePasswordSchema,
  VendorOnboardingStep1Schema,
  VendorOnboardingStep2Schema,
  VendorOnboardingStep3Schema,
  VendorOnboardingStep4Schema,
} from '../validators/vendor-onboarding.validator';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { VendorSettingsRepository } from '../../vendors/repositories/vendor-settings.repository';

const SetDefaultDeliveryAgencySchema = z.object({
  agencyId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId'),
});

const SetAutoRedirectOrdersSchema = z.object({
  enabled: z.boolean(),
});

const vendorProfileService = new VendorProfileService();
const userService = new UserService();
const vendorSettingsRepository = new VendorSettingsRepository();

export class VendorProfileController {
  // ─── Profile ──────────────────────────────────────────────────────────────

  static getProfile = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const profile = await vendorProfileService.getProfile(vendorId);
    res.json({ success: true, data: profile });
  });

  static updateProfile = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = UpdateVendorProfileSchema.parse(req.body);
    const profile = await vendorProfileService.updateProfile(vendorId, input);
    res.json({ success: true, data: profile, message: 'Profile updated successfully' });
  });

  static updatePassword = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const vendorId = req.auth!.role_entity._id.toString();
    const input = UpdatePasswordSchema.parse(req.body);
    await userService.changePassword(userId, input.oldPassword, input.newPassword, {
      role: 'vendor',
      roleEntityId: vendorId,
    });
    res.json({ success: true, message: 'Password updated successfully.' });
  });

  static getCompletionStatus = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const status = await vendorProfileService.getCompletionStatus(vendorId);
    res.json({ success: true, data: status });
  });

  static getOnboardingStatus = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const status = await vendorProfileService.getOnboardingStatus(vendorId);
    res.json({ success: true, data: status });
  });

  static listDeliveryAgencies = asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

    const search = (req.query.search as string | undefined)?.trim() || undefined;
    const region = (req.query.region as string | undefined)?.trim() || undefined;
    const hq_city = (req.query.hq_city as string | undefined)?.trim() || undefined;
    const storage_based = req.query.storage_based === 'true' ? true : undefined;
    const pickup_based = req.query.pickup_based === 'true' ? true : undefined;

    const returnsPayerRaw = req.query.returns_payer as string | undefined;
    const returns_payer = (['vendor', 'agency', 'customer'] as const).find(
      (v) => v === returnsPayerRaw,
    );

    const minClaimRaw = parseInt(req.query.min_claim_deadline_days as string);
    const min_claim_deadline_days = !isNaN(minClaimRaw) && minClaimRaw >= 0 ? minClaimRaw : undefined;

    const result = await vendorProfileService.listAvailableAgencies({
      page, limit, search, region, hq_city,
      storage_based, pickup_based, returns_payer, min_claim_deadline_days,
    });

    res.json({ success: true, data: result.agencies, meta: result.meta });
  });

  // ─── Onboarding Step Handlers ─────────────────────────────────────────────

  static completeBasicSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep1Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep1(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Basic setup completed' });
  });

  static completeDeliveryLinking = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep2Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep2(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Delivery linking completed' });
  });

  static completeBrandingSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep3Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep3(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Branding setup completed' });
  });

  static completePolicySetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep4Schema.parse(req.body);
    const expectedVersion = typeof req.body.version === 'number' ? req.body.version : undefined;
    const result = await vendorProfileService.completeStep4(vendorId, input, expectedVersion);
    res.json({ success: true, data: result, message: 'Policy setup completed' });
  });

  // ─── Default Delivery Agency ────────────────────────────────────────────

  static getDefaultDeliveryAgency = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const data = await vendorProfileService.getDefaultDeliveryAgency(vendorId);
    res.json({ success: true, data });
  });

  static setDefaultDeliveryAgency = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = SetDefaultDeliveryAgencySchema.parse(req.body);
    const data = await vendorProfileService.setDefaultDeliveryAgency(vendorId, input.agencyId);
    res.json({ success: true, data, message: 'Default delivery agency updated successfully' });
  });

  static clearDefaultDeliveryAgency = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    await vendorProfileService.clearDefaultDeliveryAgency(vendorId);
    res.json({ success: true, message: 'Default delivery agency cleared' });
  });

  // ─── Auto-redirect Orders To Agency ─────────────────────────────────────

  static getAutoRedirectOrders = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const enabled = await vendorSettingsRepository.getAutoRedirectOrdersToAgency(vendorId);
    res.json({ success: true, data: { autoRedirectOrdersToAgency: enabled } });
  });

  static setAutoRedirectOrders = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { enabled } = SetAutoRedirectOrdersSchema.parse(req.body);
    const updated = await vendorSettingsRepository.setAutoRedirectOrdersToAgency(vendorId, enabled);
    res.json({
      success: true,
      data: { autoRedirectOrdersToAgency: updated },
      message: 'Auto-redirect orders setting updated',
    });
  });
}

