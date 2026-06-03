import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../repositories/mongo/file-reference.repository.mongo';
import { DigitalAssetService } from '../../digital-delivery/services/digital-asset.service';
import { VariantDigitalService } from '../domain/services/digital/VariantDigitalService';
import { ProductStatusValidationService } from '../domain/services/ProductStatusValidationService';
import { getStorageProvider } from '../../../core/storage';
import { getDigitalAssetUploadConfig } from '../../../core/uploads/upload-config';
import { getAcceptableClaimedMimeTypes, isAcceptableClaimedMimeType } from '../../../core/uploads/mime-aliases';
import { UpdateVariantDigitalConfigSchema } from '../validators/variant.validator';

const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const fileRepository = new FileRepositoryMongo();
const fileReferenceRepository = new FileReferenceRepositoryMongo();
const storageProvider = getStorageProvider();
const digitalAssetService = new DigitalAssetService(storageProvider, fileRepository, fileReferenceRepository);
const variantDigitalService = new VariantDigitalService();
const productStatusValidationService = new ProductStatusValidationService(productRepository, variantRepository);

// Pre-upload gate, DERIVED from the digital-asset pipeline config so the two
// can never drift. The pipeline (UploadIntakeService) remains authoritative:
// it sniffs the real type and validates it against the same allowlist. This
// up-front check just rejects an obviously-wrong request cheaply, before the
// file is buffered through the pipeline.
const digitalAssetUploadConfig = getDigitalAssetUploadConfig();
const MAX_FILE_SIZE = digitalAssetUploadConfig.maxTotalSizeBytes;
const ACCEPTED_CLAIMED_MIME_TYPES = getAcceptableClaimedMimeTypes(
    Object.keys(digitalAssetUploadConfig.perMimeType),
);

function assertValidUpload(req: Request): Express.Multer.File {
    if (!req.file) {
        throw createAppError(
            ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING_FILE,
            400,
            'No file uploaded. Use multipart/form-data with field name "file"',
        );
    }
    if (req.files && Array.isArray(req.files) && req.files.length > 1) {
        throw createAppError(
            ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS,
            400,
            'Only one digital asset file is allowed per request',
        );
    }
    const file = req.file;
    if (file.size > MAX_FILE_SIZE) {
        throw createAppError(
            ERROR_CODES.CATALOG_FILE_TOO_LARGE,
            400,
            `File size ${file.size} bytes exceeds maximum ${MAX_FILE_SIZE} bytes (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`,
        );
    }
    if (!isAcceptableClaimedMimeType(file.mimetype, ACCEPTED_CLAIMED_MIME_TYPES)) {
        throw createAppError(
            ERROR_CODES.CATALOG_FILE_TYPE_INVALID,
            400,
            `File type ${file.mimetype} not allowed. Accepted formats: ${Object.keys(digitalAssetUploadConfig.perMimeType).join(', ')}`,
        );
    }
    return file;
}

/**
 * VendorDigitalAssetController
 *
 * Manages per-variant digital asset upload/replacement/deletion and download-limit
 * configuration. A digital variant is `status: 'active'` iff it has an assetId; the
 * service layer maintains that invariant.
 */
export class VendorDigitalAssetController {
    /**
     * POST /api/vendor/products/:productId/variants/:variantId/digital/asset
     * Upload a digital asset for a specific variant.
     */
    static uploadAsset = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital') {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Only digital products can have digital assets',
            );
        }

        const file = assertValidUpload(req);

        const asset = await digitalAssetService.uploadAsset(vendorId, {
            buffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
        });

        await variantDigitalService.attachAssetToVariant(productId, variantId, vendorId, asset);

        res.status(201).json({
            success: true,
            data: {
                variantId,
                assetId: asset._id,
                filename: asset.originalName,
                size: asset.size,
                mimeType: asset.mimeType,
            },
            message: 'Digital asset uploaded successfully',
        });
    });

    /**
     * PUT /api/vendor/products/:productId/variants/:variantId/digital/asset
     * Replace the existing digital asset on a variant.
     */
    static replaceAsset = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital') {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Only digital products can have digital assets',
            );
        }

        const file = assertValidUpload(req);

        const newAsset = await digitalAssetService.uploadAsset(vendorId, {
            buffer: file.buffer,
            originalName: file.originalname,
            mimeType: file.mimetype,
        });

        const { oldAssetId } = await variantDigitalService.replaceVariantAsset(
            productId,
            variantId,
            vendorId,
            newAsset,
        );

        try {
            await digitalAssetService.deleteAsset(oldAssetId, vendorId);
        } catch (deleteError) {
            console.error('[VendorDigitalAssetController] Failed to delete old asset:', deleteError);
        }

        res.json({
            success: true,
            data: {
                variantId,
                assetId: newAsset._id,
                filename: newAsset.originalName,
                size: newAsset.size,
                mimeType: newAsset.mimeType,
            },
            message: 'Digital asset replaced successfully',
        });
    });

    /**
     * DELETE /api/vendor/products/:productId/variants/:variantId/digital/asset
     * Remove the digital asset from a variant. The variant is archived as a result
     * (a digital variant cannot be active without an asset).
     */
    static removeAsset = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital') {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Only digital products can have digital assets',
            );
        }

        const { assetId } = await variantDigitalService.clearVariantAsset(productId, variantId, vendorId);

        // Variant is now archived. If this leaves the product without an active
        // variant carrying an asset, the product can no longer be 'active' —
        // demote it to 'draft'.
        await productStatusValidationService.revalidateActiveStatus(productId, vendorId);

        try {
            await digitalAssetService.deleteAsset(assetId, vendorId);
        } catch (deleteError) {
            console.error('[VendorDigitalAssetController] Failed to delete asset:', deleteError);
        }

        res.json({ success: true, message: 'Digital asset removed successfully' });
    });

    /**
     * PATCH /api/vendor/products/:productId/variants/:variantId/digital/config
     * Update download limits (maxDownloads, expiresAfterDays) for a variant.
     * Does not touch the asset itself.
     */
    static updateDigitalConfig = asyncHandler(async (req: Request, res: Response) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const { productId, variantId } = req.params;
        const input = UpdateVariantDigitalConfigSchema.parse(req.body);

        const product = await productRepository.findById(productId, vendorId);
        if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        if (product.type !== 'digital') {
            throw createAppError(
                ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
                400,
                'Only digital products can have variant digital config',
            );
        }

        await variantDigitalService.updateVariantDigitalConfig(productId, variantId, vendorId, input);

        res.json({ success: true, message: 'Variant digital config updated' });
    });
}
