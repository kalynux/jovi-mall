import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { VendorProfileService } from '../service/vendor-profile.service';
import { UserService } from '../../users/user.service';
import {
  UpdateVendorProfileSchema,
  UpdatePasswordSchema,
  VendorOnboardingStep1Schema,
  VendorOnboardingStep2Schema,
  VendorOnboardingStep3Schema,
} from '../validators/vendor-onboarding.validator';
import { AppError } from '../../../core/errors';
import { asyncHandler } from '../../../api/middlewares/async-handler';

const vendorProfileService = new VendorProfileService();
const userService = new UserService();

export class VendorProfileController {
  static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      const profile = await vendorProfileService.getProfile(vendorId);
      res.json({ success: true, data: profile });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  static async updateProfile(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      const input = UpdateVendorProfileSchema.parse(req.body);
      const profile = await vendorProfileService.updateProfile(vendorId, input);
      res.json({ success: true, data: profile, message: 'Profile updated successfully' });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  static async updatePassword(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.auth!.user._id.toString();
      const vendorId = req.auth!.role_entity._id.toString();
      const input = UpdatePasswordSchema.parse(req.body);
      await userService.changePassword(userId, input.oldPassword, input.newPassword, {
        role: 'vendor',
        roleEntityId: vendorId,
      });
      res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  static async getCompletionStatus(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      const status = await vendorProfileService.getCompletionStatus(vendorId);
      res.json({ success: true, data: status });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  static async listDeliveryAgencies(req: Request, res: Response): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));

      // ── Search / filter params ──────────────────────────────────────────────
      const search = (req.query.search as string | undefined)?.trim() || undefined;
      const region = (req.query.region as string | undefined)?.trim() || undefined;
      const hq_city = (req.query.hq_city as string | undefined)?.trim() || undefined;

      // Boolean policy filters — only activate when explicitly set to 'true'
      const storage_based = req.query.storage_based === 'true' ? true : undefined;
      const pickup_based = req.query.pickup_based === 'true' ? true : undefined;

      // Returns payer filter
      const returnsPayerRaw = req.query.returns_payer as string | undefined;
      const returns_payer = (['vendor', 'agency', 'customer'] as const).find(
        (v) => v === returnsPayerRaw,
      );

      // Damage claim minimum days
      const minClaimRaw = parseInt(req.query.min_claim_deadline_days as string);
      const min_claim_deadline_days = !isNaN(minClaimRaw) && minClaimRaw >= 0 ? minClaimRaw : undefined;

      const result = await vendorProfileService.listAvailableAgencies({
        page,
        limit,
        search,
        region,
        hq_city,
        storage_based,
        pickup_based,
        returns_payer,
        min_claim_deadline_days,
      });

      res.json({ success: true, data: result.agencies, meta: result.meta });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  // ─── Onboarding Step Handlers ─────────────────────────────────────────────

  /**
   * PUT /api/vendor/onboarding/basic-setup
   * Step 1 (Required): country, timezone, payout_details
   */
  static completeBasicSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep1Schema.parse(req.body);
    const result = await vendorProfileService.completeStep1(vendorId, input);
    res.json({ success: true, data: result, message: 'Basic setup completed' });
  });

  /**
   * PUT /api/vendor/onboarding/delivery-linking
   * Step 2 (Optional/Skippable): { skip?: boolean, default_delivery_agency_id? }
   */
  static completeDeliveryLinking = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep2Schema.parse(req.body);
    const result = await vendorProfileService.completeStep2(vendorId, input);
    res.json({ success: true, data: result, message: 'Delivery linking completed' });
  });

  /**
   * PUT /api/vendor/onboarding/branding
   * Step 3 (Optional/Skippable): { skip?: boolean, branding?, business_addresses? }
   */
  static completeBrandingSetup = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const input = VendorOnboardingStep3Schema.parse(req.body);
    const result = await vendorProfileService.completeStep3(vendorId, input);
    res.json({ success: true, data: result, message: 'Branding setup completed' });
  });

  // ─── Error Handler ────────────────────────────────────────────────────────

  private static handleError(error: unknown, res: Response): void {
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
        },
      });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    console.error('[VendorProfileController] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
  }
}

