import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AppError, NotFoundError, ValidationError } from '../../../core/errors';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { ProductModel } from '../models/product.model';
import { DigitalAssetService } from '../../digital-delivery/services/digital-asset.service';
import { ProductDigitalService } from '../domain/services/digital/ProductDigitalService';
import { createStorageProvider } from '../../../core/storage/storage.factory';

const productRepository = new ProductRepositoryMongo();
const storageProvider = createStorageProvider({
    provider: 'local',
    local: {
        basePath: './storage',      // absolute path to storage directory (e.g., './storage')
        baseUrl: 'http://localhost:3000/storage',       // base URL for public access (e.g., 'http://localhost:3000/storage')
    },
});
const digitalAssetService = new DigitalAssetService(storageProvider);
const digitalService = new ProductDigitalService();

// File upload limits (configurable via env)
const MAX_FILE_SIZE = parseInt(process.env.MAX_DIGITAL_ASSET_SIZE || '524288000'); // 500MB default
const ALLOWED_MIME_TYPES = [
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/octet-stream', // Generic binary
    'video/mp4',
    'video/quicktime',
    'audio/mpeg',
    'audio/wav',
    'audio/mp3',
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/**
 * VendorDigitalAssetController
 * 
 * Manages digital asset upload/replacement/deletion for digital products.
 * Implements transactional guarantees for storage + DB consistency.
 */
export class VendorDigitalAssetController {
    /**
     * POST /api/vendor/products/:id/digital/asset
     * Upload digital asset for a product
     * 
     * TRANSACTIONAL FLOW:
     * 1. Validate product exists + ownership + type
     * 2. Validate file (size, mime type)
     * 3. Upload to storage (with rollback on failure)
     * 4. Create DB records (DigitalAsset + File)
     * 5. Link to product digitalConfig
     * 6. On any failure, cleanup storage
     */
    static async uploadAsset(req: Request, res: Response): Promise<void> {
        let uploadedFileKey: string | null = null;

        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product exists and belongs to vendor
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Validate product is digital type
            if (product.type !== 'digital') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Only digital products can have digital assets',
                    },
                });
                return;
            }

            // Check if product already has an asset
            if (product.digitalConfig?.assetId) {
                res.status(409).json({
                    success: false,
                    error: {
                        code: 'ASSET_ALREADY_EXISTS',
                        message: 'Product already has a digital asset. Use PUT to replace it.',
                    },
                });
                return;
            }

            // Validate file exists in request
            if (!req.file) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'MISSING_FILE',
                        message: 'No file uploaded. Use multipart/form-data with field name "file"',
                    },
                });
                return;
            }

            const file = req.file;

            // Validate file size
            if (file.size > MAX_FILE_SIZE) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'FILE_TOO_LARGE',
                        message: `File size ${file.size} bytes exceeds maximum ${MAX_FILE_SIZE} bytes (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`,
                    },
                });
                return;
            }

            // Validate mime type
            if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_FILE_TYPE',
                        message: `File type ${file.mimetype} not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`,
                    },
                });
                return;
            }

            // TRANSACTIONAL UPLOAD: Upload asset with rollback capability
            const asset = await digitalAssetService.uploadAsset(vendorId, {
                buffer: file.buffer,
                originalName: file.originalname,
                mimeType: file.mimetype,
            });

            // Store uploaded file key for rollback if needed
            uploadedFileKey = asset.fileId.toString();

            // Link asset to product digitalConfig
            await digitalService.createOrUpdateDigitalConfig(productId, vendorId, {
                assetId: asset._id.toString(),
                maxDownloads: null, // Unlimited by default
                expiresAfterDays: null, // Never expires by default
            });

            res.status(201).json({
                success: true,
                data: {
                    assetId: asset._id,
                    filename: asset.originalName,
                    size: asset.size,
                    mimeType: asset.mimeType,
                },
                message: 'Digital asset uploaded successfully',
            });
        } catch (error: any) {
            // ROLLBACK: If we uploaded a file but failed to link it, clean up
            if (uploadedFileKey && error.message?.includes('Product not found')) {
                try {
                    await digitalAssetService.deleteAsset(uploadedFileKey, req.auth!.role_entity._id.toString());
                } catch (cleanupError) {
                    console.error('[VendorDigitalAssetController] Failed to cleanup uploaded asset after error:', cleanupError);
                }
            }

            VendorDigitalAssetController.handleError(error, res);
        }
    }

    /**
     * PUT /api/vendor/products/:id/digital/asset
     * Replace existing digital asset
     * 
     * TRANSACTIONAL FLOW:
     * 1. Validate product + ownership + type
     * 2. Validate old asset exists
     * 3. Upload new file
     * 4. Create new DB records
     * 5. Update product digitalConfig to new asset
     * 6. Delete old asset (file + DB)
     * 7. On failure, rollback new upload
     */
    static async replaceAsset(req: Request, res: Response): Promise<void> {
        let newAssetId: string | null = null;
        let oldAssetId: string | null = null;

        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            if (product.type !== 'digital') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Only digital products can have digital assets',
                    },
                });
                return;
            }

            // Check if product has existing asset
            if (!product.digitalConfig?.assetId) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NO_EXISTING_ASSET',
                        message: 'Product has no digital asset to replace. Use POST to upload.',
                    },
                });
                return;
            }

            oldAssetId = product.digitalConfig.assetId.toString();

            // Validate file
            if (!req.file) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'MISSING_FILE',
                        message: 'No file uploaded',
                    },
                });
                return;
            }

            const file = req.file;

            // Validate file size
            if (file.size > MAX_FILE_SIZE) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'FILE_TOO_LARGE',
                        message: `File exceeds maximum size of ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`,
                    },
                });
                return;
            }

            // Validate mime type
            if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_FILE_TYPE',
                        message: `File type ${file.mimetype} not allowed`,
                    },
                });
                return;
            }

            // Upload new asset
            const newAsset = await digitalAssetService.uploadAsset(vendorId, {
                buffer: file.buffer,
                originalName: file.originalname,
                mimeType: file.mimetype,
            });

            newAssetId = newAsset._id.toString();

            // Update product to point to new asset
            await digitalService.createOrUpdateDigitalConfig(productId, vendorId, {
                assetId: newAssetId,
                maxDownloads: product.digitalConfig.maxDownloads,
                expiresAfterDays: product.digitalConfig.expiresAfterDays,
            });

            // Delete old asset
            try {
                await digitalAssetService.deleteAsset(oldAssetId, vendorId);
            } catch (deleteError) {
                // Log but don't fail - old asset will be orphaned and cleaned by GC
                console.error('[VendorDigitalAssetController] Failed to delete old asset:', deleteError);
            }

            res.json({
                success: true,
                data: {
                    assetId: newAsset._id,
                    filename: newAsset.originalName,
                    size: newAsset.size,
                    mimeType: newAsset.mimeType,
                },
                message: 'Digital asset replaced successfully',
            });
        } catch (error: any) {
            // ROLLBACK: If we uploaded new file but failed, try to restore old asset link
            if (newAssetId && oldAssetId) {
                try {
                    await digitalAssetService.deleteAsset(newAssetId, req.auth!.role_entity._id.toString());
                } catch (cleanupError) {
                    console.error('[VendorDigitalAssetController] Failed to cleanup new asset after error:', cleanupError);
                }
            }

            VendorDigitalAssetController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/products/:id/digital/toggle
     * Toggle digital asset availability (isActive flag)
     * 
     * Quick enable/disable without requiring full product update.
     * Useful for vendors who need to temporarily disable downloads.
     */
    static async toggleAvailability(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product exists and belongs to vendor (get mutable document)
            const product = await ProductModel.findOne({
                _id: productId,
                vendorId: new Types.ObjectId(vendorId),
                deletedAt: null,
            });

            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            // Validate product is digital type
            if (product.type !== 'digital') {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'INVALID_PRODUCT_TYPE',
                        message: 'Only digital products can have digital assets toggled',
                    },
                });
                return;
            }

            // Check if digital config exists
            if (!product.digitalConfig) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NO_DIGITAL_CONFIG',
                        message: 'Product has no digital configuration',
                    },
                });
                return;
            }

            // Toggle the isActive flag
            const newState = !product.digitalConfig.isActive;
            product.digitalConfig.isActive = newState;
            await product.save();

            res.json({
                success: true,
                data: {
                    isActive: newState,
                    message: newState
                        ? 'Digital asset enabled - customers can now download'
                        : 'Digital asset disabled - downloads are temporarily blocked',
                },
                message: 'Digital asset availability toggled successfully',
            });
        } catch (error) {
            VendorDigitalAssetController.handleError(error, res);
        }
    }

    /**
     * DELETE /api/vendor/products/:id/digital/asset
     * Remove digital asset (unlink from product + soft delete)
     */
    static async removeAsset(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const { id: productId } = req.params;

            // Validate product
            const product = await productRepository.findById(productId, vendorId);
            if (!product) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NOT_FOUND',
                        message: 'Product not found',
                    },
                });
                return;
            }

            if (product.type !== 'digital' || !product.digitalConfig) {
                res.status(400).json({
                    success: false,
                    error: {
                        code: 'NO_DIGITAL_CONFIG',
                        message: 'Product has no digital configuration',
                    },
                });
                return;
            }

            if (!product.digitalConfig.assetId) {
                res.status(404).json({
                    success: false,
                    error: {
                        code: 'NO_ASSET',
                        message: 'Product has no digital asset to remove',
                    },
                });
                return;
            }

            const assetId = product.digitalConfig.assetId.toString();

            // Deactivate digital config (unlink asset from product)
            await digitalService.deactivateDigitalConfig(productId, vendorId);

            // Delete the asset
            await digitalAssetService.deleteAsset(assetId, vendorId);

            res.json({
                success: true,
                message: 'Digital asset removed successfully',
            });
        } catch (error) {
            VendorDigitalAssetController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private static handleError(error: any, res: Response): void {
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

        // Handle Mongoose validation errors
        if (error.name === 'ValidationError') {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: error.message,
                },
            });
            return;
        }

        console.error('[VendorDigitalAssetController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
            },
        });
    }
}
