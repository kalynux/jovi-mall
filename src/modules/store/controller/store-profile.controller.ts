import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { StoreProfileService } from '../service/store-profile.service';
import { UpdateStoreProfileSchema, UpdateStoreStatusSchema } from '../validators/store.validator';

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
 *
 * Service errors (createAppError) and Zod validation errors propagate to the
 * global error handler via asyncHandler — never written inline.
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
  static getStore = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const vendorId = req.auth!.role_entity._id.toString();

    const store = await storeProfileService.getStore(vendorId);

    res.json({
      success: true,
      data: store,
    });
  });

  /**
   * PATCH /api/vendor/store
   *
   * Update authenticated vendor's store profile
   *
   * VALIDATION:
   * - Zod validates request shape
   * - Service enforces business policy (immutability, optimistic locking, etc.)
   */
  static updateStore = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
  });

  /**
   * PATCH /api/vendor/store/status
   *
   * Toggle store vacation mode
   *
   * BUSINESS LOGIC:
   * - isOpen: true = Open for business
   * - isOpen: false = On vacation (store temporarily closed)
   */
  static updateStoreStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
  });
}
