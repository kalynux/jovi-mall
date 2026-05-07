import { Router, Request, Response, NextFunction } from 'express';
import { ProductDigitalService, DigitalConfigDto } from '../../catalog/domain/services/digital/ProductDigitalService';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Vendor Digital Product Configuration Routes
 * 
 * Allows vendors to configure digital products with assets and delivery rules.
 */

const router = Router();
const digitalService = new ProductDigitalService();

/**
 * POST /api/vendor/products/:id/digital-config
 * Set or update digital configuration for a product
 * 
 * Body: { assetId, maxDownloads?, expiresAfterDays? }
 */
router.post('/products/:id/digital-config', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    // TODO: Extract vendorId from auth middleware
    const vendorId = (req as any).user?.vendorId;
    if (!vendorId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
    }

    const { id: productId } = req.params;
    const { assetId, maxDownloads, expiresAfterDays } = req.body;

    if (!assetId) {
      return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'assetId is required'));
    }

    const config: DigitalConfigDto = {
      assetId,
      maxDownloads: maxDownloads || null,
      expiresAfterDays: expiresAfterDays || null,
    };

    await digitalService.createOrUpdateDigitalConfig(productId, vendorId, config);

    return res.status(200).json({
      success: true,
      message: 'Digital configuration updated successfully'
    });
  } catch (error: any) {
    console.error('Error setting digital config:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
  }
}));

/**
 * GET /api/vendor/products/:id/digital-config
 * Get digital configuration for a product
 */
router.get('/products/:id/digital-config', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: productId } = req.params;

    const config = await digitalService.getDigitalConfig(productId);

    return res.status(200).json(config);
  } catch (error: any) {
    console.error('Error fetching digital config:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 404, error.message));
  }
}));

/**
 * DELETE /api/vendor/products/:id/digital-config
 * Deactivate digital configuration
 */
router.delete('/products/:id/digital-config', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  try {
    // TODO: Extract vendorId from auth middleware
    const vendorId = (req as any).user?.vendorId;
    if (!vendorId) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
    }

    const { id: productId } = req.params;

    await digitalService.deactivateDigitalConfig(productId, vendorId);

    return res.status(200).json({
      success: true,
      message: 'Digital configuration deactivated'
    });
  } catch (error: any) {
    console.error('Error deactivating digital config:', error);
    next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
  }
}));

export default router;
