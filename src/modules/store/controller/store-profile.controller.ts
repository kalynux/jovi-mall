import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { StoreProfileService } from '../service/store-profile.service';
import { UpdateStoreProfileSchema, UpdateStoreStatusSchema } from '../validators/store.validator';
import { AppError } from '../../../core/errors';

const storeProfileService = new StoreProfileService();

/**
 * Store Profile Controller
 * 
 * HTTP layer for store profile management.
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
 * - Vendor can only access their own store (extracted from req.auth.role_entity._id)
 * - No storeId in routes - identity via token → vendor → store
 */
export class StoreProfileController {
  /**
   * GET /api/vendor/store
   * 
   * Get authenticated vendor's store profile
   */
  static async getStore(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      
      const store = await storeProfileService.getStore(vendorId);
      
      res.json({
        success: true,
        data: store,
      });
    } catch (error) {
      StoreProfileController.handleError(error, res);
    }
  }

  /**
   * PATCH /api/vendor/store
   * 
   * Update authenticated vendor's store profile
   * 
   * VALIDATION:
   * - Zod validates request shape
   * - Service enforces business policy (immutability, optimistic locking, etc.)
   */
  static async updateStore(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      
      // Validate request body shape
      const input = UpdateStoreProfileSchema.parse(req.body);
      
      // Service enforces business policy
      const store = await storeProfileService.updateStore(vendorId, input);
      
      res.json({
        success: true,
        data: store,
        message: 'Store profile updated successfully',
      });
    } catch (error) {
      StoreProfileController.handleError(error, res);
    }
  }

  /**
   * PATCH /api/vendor/store/status
   * 
   * Toggle store vacation mode
   * 
   * BUSINESS LOGIC:
   * - isOpen: true = Open for business
   * - isOpen: false = On vacation (store temporarily closed)
   */
  static async updateStoreStatus(req: Request, res: Response): Promise<void> {
    try {
      const vendorId = req.auth!.role_entity._id.toString();
      
      // Validate request body shape
      const input = UpdateStoreStatusSchema.parse(req.body);
      
      // Service enforces business policy
      const store = await storeProfileService.updateStoreStatus(vendorId, input);
      
      const message = input.isOpen
        ? 'Store opened successfully'
        : 'Store closed (vacation mode enabled)';
      
      res.json({
        success: true,
        data: store,
        message,
      });
    } catch (error) {
      StoreProfileController.handleError(error, res);
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

    // Application errors (NotFoundError, ForbiddenError, ConflictError, etc.)
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
    console.error('[StoreProfileController] Unexpected error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. Please try again later.',
      },
    });
  }
}
