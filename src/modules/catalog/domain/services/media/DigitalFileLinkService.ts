import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IFileReferenceRepository } from '../../../repositories/interfaces/file-reference.repository.interface';
import { IDigitalAssetRepository } from '../../../repositories/interfaces/digital-asset.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';

export interface LinkDigitalFileCommand {
  digitalAssetId: string;
  fileId: string;
  vendorId: string;
}

/**
 * DigitalFileLinkService
 * 
 * Links a file to a digital asset (one-to-one relationship).
 * If digital asset already has a file, the old file is orphaned and new file is linked.
 * 
 * Enforces vendor ownership of the parent product.
 */
export class DigitalFileLinkService {
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly fileReferenceRepository: IFileReferenceRepository,
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly productRepository: IProductRepository
  ) { }

  /**
   * Link file to digital asset
   * @param command - Link command with digital asset, file, and vendor details
   * @throws NotFoundError if file or digital asset not found
   * @throws UnauthorizedError if vendor doesn't own the product
   */
  async execute(command: LinkDigitalFileCommand, options?: RepositoryOptions): Promise<void> {
    // Validate file exists
    const file = await this.fileRepository.findById(command.fileId, options);
    if (!file) {
      throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404);
    }

    // Validate digital asset exists
    const digitalAsset = await this.digitalAssetRepository.findById(command.digitalAssetId, options);
    if (!digitalAsset) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 404);
    }

    // Verify vendor owns the parent product
    const product = await this.productRepository.findById(digitalAsset.productId, command.vendorId, options);
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, 'Vendor does not own this product');
    }

    // If digital asset already has a file, release that file's reference (it's
    // being replaced).
    if (digitalAsset.mediaId) {
      await this.fileReferenceRepository.remove(
        digitalAsset.mediaId,
        'digital_asset',
        command.digitalAssetId,
        'digitalAsset',
        options,
      );
    }

    // Link new file to digital asset
    await this.digitalAssetRepository.update(
      command.digitalAssetId,
      { mediaId: command.fileId },
      options
    );

    // Register the reference for the new file
    await this.fileReferenceRepository.add({
      fileId: command.fileId,
      entityType: 'digital_asset',
      entityId: command.digitalAssetId,
      field: 'digitalAsset',
      ownerType: 'vendor',
      ownerId: command.vendorId,
    }, options);
  }
}
