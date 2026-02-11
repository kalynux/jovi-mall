import { ConflictError, NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
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
    private readonly digitalAssetRepository: IDigitalAssetRepository,
    private readonly productRepository: IProductRepository
  ) {}

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
      throw new NotFoundError('File not found');
    }

    // Validate digital asset exists
    const digitalAsset = await this.digitalAssetRepository.findById(command.digitalAssetId, options);
    if (!digitalAsset) {
      throw new NotFoundError('Digital asset not found');
    }

    // Verify vendor owns the parent product
    const product = await this.productRepository.findById(digitalAsset.productId, command.vendorId, options);
    if (!product) {
      throw new ForbiddenError('Vendor does not own this product');
    }

    // If digital asset already has a file, orphan the old one
    if (digitalAsset.mediaId) {
      const oldFile = await this.fileRepository.findById(digitalAsset.mediaId, options);
      if (oldFile) {
        // Mark old file as orphaned (it's being replaced)
        await this.fileRepository.updateOrphanStatus(oldFile.id, true, options);
      }
    }

    // Link new file to digital asset
    await this.digitalAssetRepository.update(
      command.digitalAssetId,
      { mediaId: command.fileId },
      options
    );

    // Mark new file as not orphaned
    await this.fileRepository.updateOrphanStatus(command.fileId, false, options);
  }
}
