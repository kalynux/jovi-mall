import { Types } from 'mongoose';
import { DigitalAssetModel, IDigitalAsset } from '../models/digital-asset.model';
import { IStorageProvider } from '../../../core/storage/storage-provider.interface';
import { IFileRepository } from '../../catalog/repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../catalog/repositories/interfaces/file-reference.repository.interface';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { getDigitalAssetUploadConfig } from '../../../core/uploads/upload-config';
import { NoopObserver } from '../../../core/uploads/observers/noop-observer';
import { MockScanner } from '../../../core/uploads/scanners/mock-scanner';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * DigitalAssetService - Vendor file management
 *
 * Handles upload, deletion, and retrieval of digital assets for vendors.
 * Ensures proper ownership checks and prevents deletion of assets in use.
 *
 * Uploads go through {@link UploadIntakeService} (magic-byte sniffing, virus
 * scan, fingerprinting) — the storage provider is never written to directly.
 */
export class DigitalAssetService {
  private readonly uploadIntakeService: UploadIntakeService;

  constructor(
    storageProvider: IStorageProvider,
    private readonly fileRepository: IFileRepository,
    private readonly fileReferenceRepository: IFileReferenceRepository,
  ) {
    this.uploadIntakeService = new UploadIntakeService(
      getDigitalAssetUploadConfig(),
      storageProvider,
      fileRepository,
      new NoopObserver(),
      new MockScanner(),
    );
  }

  /**
   * Upload a digital asset for a vendor
   * @param vendorId - Vendor uploading the file
   * @param file - File buffer and metadata
   * @returns Created digital asset
   */
  async uploadAsset(
    vendorId: string,
    file: { buffer: Buffer; originalName: string; mimeType: string }
  ): Promise<IDigitalAsset> {
    // Route through the security pipeline. This creates the File record
    // (owned by the vendor, no references yet) after sniffing + scanning.
    const [fileRecord] = await this.uploadIntakeService.execute({
      folder: 'digital',
      context: { userId: vendorId, vendorId, role: 'vendor' },
      files: [{
        buffer: file.buffer,
        originalName: file.originalName,
        mimeType: file.mimeType,
      }],
    });

    if (!fileRecord) {
      throw createAppError(ERROR_CODES.STORAGE_UPLOAD_FAILED, 500, 'Digital asset upload produced no file');
    }

    // Create DigitalAsset record
    const digitalAsset = await DigitalAssetModel.create({
      vendorId: new Types.ObjectId(vendorId),
      fileId: new Types.ObjectId(fileRecord.id),
      originalName: file.originalName,
      mimeType: fileRecord.mimeType,
      size: fileRecord.size,
    });

    // The DigitalAsset is the single reference to this File — register it so the
    // orphan garbage collector won't reclaim the file while the asset is live.
    await this.fileReferenceRepository.add({
      fileId: fileRecord.id,
      entityType: 'digital_asset',
      entityId: digitalAsset._id.toString(),
      field: 'digitalAsset',
      ownerType: 'vendor',
      ownerId: vendorId,
    });

    return digitalAsset;
  }

  /**
   * Delete a digital asset (with in-use protection)
   * @param assetId - ID of the asset to delete
   * @param vendorId - Vendor requesting deletion (ownership check)
   */
  async deleteAsset(assetId: string, vendorId: string): Promise<void> {
    if (!Types.ObjectId.isValid(assetId)) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_NOT_FOUND, 400, 'Invalid asset ID');
    }

    // Load asset
    const asset = await DigitalAssetModel.findById(assetId);
    if (!asset) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_NOT_FOUND, 404, 'Digital asset not found');
    }

    // Verify ownership
    if (asset.vendorId.toString() !== vendorId) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_ACCESS_DENIED, 403, 'Unauthorized: You do not own this asset');
    }

    // Check if asset is in use by any variant. Assets live per-variant now.
    const { ProductVariantModel } = await import('../../catalog/models/product-variant.model');
    const inUse = await ProductVariantModel.findOne({
      'digitalConfig.assetId': asset._id,
      deletedAt: null,
    });

    if (inUse) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_IN_USE, 409, 'Cannot delete asset: It is currently linked to one or more product variants');
    }

    // Soft delete the asset
    asset.deletedAt = new Date();
    await asset.save();

    // Release the File reference. Once the file has no live references the orphan
    // garbage collector will reclaim it. Idempotent — safe if already removed.
    await this.fileReferenceRepository.removeAllForEntity('digital_asset', asset._id.toString());
  }

  /**
   * Get asset details with ownership check
   * @param assetId - ID of the asset
   * @param vendorId - Vendor requesting the asset
   * @returns Digital asset
   */
  async getAsset(assetId: string, vendorId: string): Promise<IDigitalAsset> {
    if (!Types.ObjectId.isValid(assetId)) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_NOT_FOUND, 400, 'Invalid asset ID');
    }

    const asset = await DigitalAssetModel.findOne({
      _id: assetId,
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null,
    });

    if (!asset) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_NOT_FOUND, 404, 'Digital asset not found');
    }

    return asset;
  }

  /**
   * List all assets for a vendor
   * @param vendorId - Vendor ID
   * @returns Array of digital assets
   */
  async listVendorAssets(vendorId: string): Promise<IDigitalAsset[]> {
    return await DigitalAssetModel.find({
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null,
    }).sort({ createdAt: -1 });
  }

  /**
   * Get asset by ID (internal use, no ownership check)
   * @param assetId - Asset ID
   * @returns Digital asset or null
   */
  async getAssetById(assetId: string): Promise<IDigitalAsset | null> {
    if (!Types.ObjectId.isValid(assetId)) {
      return null;
    }

    return await DigitalAssetModel.findOne({
      _id: assetId,
      deletedAt: null,
    });
  }
}
