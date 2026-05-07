import { Types } from 'mongoose';
import { DigitalAssetModel, IDigitalAsset } from '../models/digital-asset.model';
import { FileModel } from '../../catalog/models/file.model';
import { IStorageProvider } from '../../../core/storage/storage-provider.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * DigitalAssetService - Vendor file management
 * 
 * Handles upload, deletion, and retrieval of digital assets for vendors.
 * Ensures proper ownership checks and prevents deletion of assets in use.
 */
export class DigitalAssetService {
  constructor(private readonly storageProvider: IStorageProvider) { }

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
    // Upload to storage provider
    const uploadResult = await this.storageProvider.put(file.buffer, {
      folder: 'digital',
      mimeType: file.mimeType,
      filename: file.originalName,
    });

    // Create File record
    const fileRecord = await FileModel.create({
      key: uploadResult.key,
      provider: this.storageProvider.getProviderType(),
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
      checksum: uploadResult.checksum,
      originalName: file.originalName,
      isOrphan: false, // Will be linked to digital asset
      ownerType: 'vendor',
      ownerId: new Types.ObjectId(vendorId),
    });

    // Create DigitalAsset record
    const digitalAsset = await DigitalAssetModel.create({
      vendorId: new Types.ObjectId(vendorId),
      fileId: fileRecord._id,
      originalName: file.originalName,
      mimeType: uploadResult.mimeType,
      size: uploadResult.size,
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

    // Check if asset is in use by any product
    const { ProductModel } = await import('../../catalog/models/product.model');
    const inUse = await ProductModel.findOne({
      'digitalConfig.assetId': asset._id,
      deletedAt: null,
    });

    if (inUse) {
      throw createAppError(ERROR_CODES.DIGITAL_ASSET_IN_USE, 409, 'Cannot delete asset: It is currently linked to one or more products');
    }

    // Soft delete the asset
    asset.deletedAt = new Date();
    await asset.save();

    // Mark file as orphan (will be cleaned up by garbage collector)
    await FileModel.updateOne(
      { _id: asset.fileId },
      { $set: { isOrphan: true } }
    );
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
