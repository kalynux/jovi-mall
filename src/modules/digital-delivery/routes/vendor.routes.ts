import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { DigitalAssetService } from '../services/digital-asset.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Vendor Digital Asset Routes
 * 
 * /api/vendor/digital/assets/upload - Upload digital asset
 * /api/vendor/digital/assets - List vendor's assets
 * /api/vendor/digital/assets/:id - Delete asset
 */

// Configure multer for file upload (in-memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
});

export function createVendorDigitalRoutes(
  assetService: DigitalAssetService
): Router {
  const router = Router();

  /**
   * POST /api/vendor/digital/assets/upload
   * Upload a digital asset
   * 
   * Auth: Vendor required
   * Body: multipart/form-data with 'file' field
   * Response: { assetId, originalName, size, mimeType }
   */
  router.post(
    '/assets/upload',
    upload.single('file'),
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      try {
        // TODO: Extract vendorId from auth middleware
        const vendorId = (req as any).user?.vendorId;
        if (!vendorId) {
          return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
        }

        const file = req.file;
        if (!file) {
          return next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'No file uploaded'));
        }

        // Validate file type (digital products typically PDF, ZIP, etc.)
        const allowedMimeTypes = [
          'application/pdf',
          'application/zip',
          'application/x-zip-compressed',
          'application/epub+zip',
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
          'audio/mpeg',
          'audio/wav',
          'video/mp4',
          'image/jpeg',
          'image/png',
        ];

        if (!allowedMimeTypes.includes(file.mimetype)) {
          return next(createAppError(
            ERROR_CODES.CATALOG_FILE_TYPE_INVALID,
            400,
            `File type ${file.mimetype} not supported for digital products`
          ));
        }

        const asset = await assetService.uploadAsset(vendorId, {
          buffer: file.buffer,
          originalName: file.originalname,
          mimeType: file.mimetype,
        });

        return res.status(201).json({
          assetId: asset.id,
          originalName: asset.originalName,
          size: asset.size,
          mimeType: asset.mimeType,
        });
      } catch (error: any) {
        console.error('Error uploading digital asset:', error);
        next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to upload asset'));
      }
    })
  );

  /**
   * GET /api/vendor/digital/assets
   * List all digital assets for the vendor
   * 
   * Auth: Vendor required
   * Response: Array of assets
   */
  router.get('/assets', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: Extract vendorId from auth middleware
      const vendorId = (req as any).user?.vendorId;
      if (!vendorId) {
        return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
      }

      const assets = await assetService.listVendorAssets(vendorId);

      return res.status(200).json(
        assets.map((asset) => ({
          id: asset.id,
          originalName: asset.originalName,
          mimeType: asset.mimeType,
          size: asset.size,
          createdAt: asset.createdAt,
        }))
      );
    } catch (error: any) {
      console.error('Error listing assets:', error);
      next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Failed to list assets'));
    }
  }));

  /**
   * DELETE /api/vendor/digital/assets/:id
   * Delete a digital asset
   * 
   * Auth: Vendor required
   * Response: 204 No Content
   */
  router.delete('/assets/:id', asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      // TODO: Extract vendorId from auth middleware
      const vendorId = (req as any).user?.vendorId;
      if (!vendorId) {
        return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401, 'Unauthorized'));
      }

      const { id } = req.params;

      await assetService.deleteAsset(id, vendorId);

      return res.status(204).send();
    } catch (error: any) {
      console.error('Error deleting asset:', error);
      next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
    }
  }));

  return router;
}
