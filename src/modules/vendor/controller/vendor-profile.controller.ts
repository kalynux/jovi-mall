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

  static async completeOnboardingStep(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      const step = Number(req.body.step);

      let result: Awaited<ReturnType<typeof vendorProfileService.completeStep1>>;

      switch (step) {
        case 1:
          result = await vendorProfileService.completeStep1(
            vendorId,
            VendorOnboardingStep1Schema.parse(req.body)
          );
          break;
        case 2:
          result = await vendorProfileService.completeStep2(
            vendorId,
            VendorOnboardingStep2Schema.parse(req.body)
          );
          break;
        case 3:
          result = await vendorProfileService.completeStep3(
            vendorId,
            VendorOnboardingStep3Schema.parse(req.body)
          );
          break;
        default:
          res.status(400).json({
            success: false,
            error: { code: 'INVALID_STEP', message: `Unknown onboarding step: ${step}` },
          });
          return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

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
