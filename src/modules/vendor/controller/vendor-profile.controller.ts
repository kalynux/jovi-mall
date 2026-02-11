import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { VendorProfileService } from '../service/vendor-profile.service';
import { UserService } from '../../users/user.service';
import { UpdateProfileSchema, UpdatePasswordSchema } from '../validators/profile.validator';
import { AppError } from '../../../core/errors';

const vendorProfileService = new VendorProfileService();
const userService = new UserService();

/**
 * Vendor Profile Controller
 * 
 * HTTP layer for vendor profile management.
 * 
 * RESPONSIBILITIES:
 * - Extract data from HTTP request
 * - Validate with Zod schemas
 * - Call service layer
 * - Format HTTP response
 * - Handle errors with consistent format
 * 
 * SECURITY:
 * - All routes protected by requireAuth + requireRole(['vendor']) middleware
 * - Vendor can only access their own profile (extracted from req.auth)
 */
export class VendorProfileController {
  /**
   * GET /api/vendor/profile
   * 
   * Get authenticated vendor's profile
   */
  static async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      
      const profile = await vendorProfileService.getProfile(vendorId);
      
      res.json({
        success: true,
        data: profile,
      });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  /**
   * PATCH /api/vendor/profile
   * 
   * Update authenticated vendor's profile
   * 
   * VALIDATION:
   * - Zod validates request shape
   * - Service enforces business policy (email lock, feature flags, etc.)
   */
  static async updateProfile(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      
      // Validate request body shape
      const input = UpdateProfileSchema.parse(req.body);
      
      // Service enforces business policy
      const profile = await vendorProfileService.updateProfile(vendorId, input);
      
      res.json({
        success: true,
        data: profile,
        message: 'Profile updated successfully',
      });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  /**
   * PATCH /api/vendor/profile/password
   * 
   * Change authenticated vendor's password
   * 
   * SECURITY:
   * - Requires old password verification
   * - Password strength enforced by Zod validator
   * - Delegates to UserService (auth boundary)
   */
  static async updatePassword(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.auth!.user._id.toString();
      const vendorId = req.auth!.role_entity._id.toString();
      
      // Validate request body shape
      const input = UpdatePasswordSchema.parse(req.body);
      
      // Delegate to UserService (password management is auth boundary concern)
      await userService.changePassword(
        userId,
        input.oldPassword,
        input.newPassword,
        {
          role: 'vendor',
          roleEntityId: vendorId,
        }
      );
      
      res.json({
        success: true,
        message: 'Password updated successfully. Please use your new password on next login.',
      });
    } catch (error) {
      VendorProfileController.handleError(error, res);
    }
  }

  /**
   * Centralized error handler
   * 
   * Provides consistent error response format.
   * Handles different error types appropriately.
   */
  private static handleError(error: any, res: Response): void {
    // Zod validation errors
    if (error instanceof ZodError) {
      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        },
      });
      return;
    }

    // Application errors (NotFoundError, ForbiddenError, etc.)
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }

    // Unknown errors
    console.error('[VendorProfileController] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.',
      },
    });
  }
}
