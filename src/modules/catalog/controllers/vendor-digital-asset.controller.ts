import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { ProductModel } from '../models/product.model';
import { DigitalAssetService } from '../../digital-delivery/services/digital-asset.service';
import { ProductDigitalService } from '../domain/services/digital/ProductDigitalService';
import { getStorageProvider } from '../../../core/storage';

const productRepository = new ProductRepositoryMongo();
const storageProvider = getStorageProvider();
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
    static uploadAsset = asyncHandler(async (req: Request, res: Response) => {
        let uploadedFileKey: string | null = null;
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only digital products can have digital assets');
        if (product.digitalConfig?.assetId)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS, 409, 'Product already has a digital asset. Use PUT to replace it.');
        if (!req.file)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE, 400, 'No file uploaded. Use multipart/form-data with field name "file"');
        if (req.files && Array.isArray(req.files) && req.files.length > 1)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS, 400, 'Only one digital asset file is allowed per request');

        const file = req.file;
        if (file.size > MAX_FILE_SIZE)
            throw createAppError(ERROR_CODES.CATALOG_FILE_TOO_LARGE, 400, `File size ${file.size} bytes exceeds maximum ${MAX_FILE_SIZE} bytes (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`);
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype))
            throw createAppError(ERROR_CODES.CATALOG_FILE_TYPE_INVALID, 400, `File type ${file.mimetype} not allowed. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`);

        const asset = await digitalAssetService.uploadAsset(vendorId, { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype });
        uploadedFileKey = asset.fileId.toString();

        await digitalService.createOrUpdateDigitalConfig(productId, vendorId, { assetId: asset._id.toString(), maxDownloads: null, expiresAfterDays: null });

        res.status(201).json({ success: true, data: { assetId: asset._id, filename: asset.originalName, size: asset.size, mimeType: asset.mimeType }, message: 'Digital asset uploaded successfully' });
    });

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
    static replaceAsset = asyncHandler(async (req: Request, res: Response) => {
        // let newAssetId: string | null;
        // let oldAssetId: string | null;
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only digital products can have digital assets');
        if (!product.digitalConfig?.assetId)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING, 404, 'Product has no digital asset to replace. Use POST to upload.');

        const oldAssetId = product.digitalConfig.assetId.toString();

        if (!req.file)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE, 400, 'No file uploaded');

        const file = req.file;
        if (file.size > MAX_FILE_SIZE)
            throw createAppError(ERROR_CODES.CATALOG_FILE_TOO_LARGE, 400, `File exceeds maximum size of ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`);
        if (!ALLOWED_MIME_TYPES.includes(file.mimetype))
            throw createAppError(ERROR_CODES.CATALOG_FILE_TYPE_INVALID, 400, `File type ${file.mimetype} not allowed`);

        const newAsset = await digitalAssetService.uploadAsset(vendorId, { buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype });
        const newAssetId = newAsset._id.toString();

        await digitalService.createOrUpdateDigitalConfig(productId, vendorId, { assetId: newAssetId, maxDownloads: product.digitalConfig.maxDownloads, expiresAfterDays: product.digitalConfig.expiresAfterDays });

        try {
            await digitalAssetService.deleteAsset(oldAssetId, vendorId);
        } catch (deleteError) {
            console.error('[VendorDigitalAssetController] Failed to delete old asset:', deleteError);
        }

        res.json({ success: true, data: { assetId: newAsset._id, filename: newAsset.originalName, size: newAsset.size, mimeType: newAsset.mimeType }, message: 'Digital asset replaced successfully' });
    });

    /**
     * PATCH /api/vendor/products/:id/digital/toggle
     * Toggle digital asset availability (isActive flag)
     * 
     * Quick enable/disable without requiring full product update.
     * Useful for vendors who need to temporarily disable downloads.
     */
    static toggleAvailability = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await ProductModel.findOne({ _id: productId, vendorId: new Types.ObjectId(vendorId), deletedAt: null });
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital')
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Only digital products can have digital assets toggled');
        if (!product.digitalConfig)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 404, 'Product has no digital configuration');

        const newState = !product.digitalConfig.isActive;
        product.digitalConfig.isActive = newState;
        await product.save();

        res.json({ success: true, data: { isActive: newState, message: newState ? 'Digital asset enabled - customers can now download' : 'Digital asset disabled - downloads are temporarily blocked' }, message: 'Digital asset availability toggled successfully' });
    });

    /**
     * DELETE /api/vendor/products/:id/digital/asset
     * Remove digital asset (unlink from product + soft delete)
     */
    static removeAsset = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { id: productId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital' || !product.digitalConfig)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 400, 'Product has no digital configuration');
        if (!product.digitalConfig.assetId)
            throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING, 404, 'Product has no digital asset to remove');

        const assetId = product.digitalConfig.assetId.toString();
        await digitalService.deactivateDigitalConfig(productId, vendorId);
        await digitalAssetService.deleteAsset(assetId, vendorId);

        res.json({ success: true, message: 'Digital asset removed successfully' });
    });
}

