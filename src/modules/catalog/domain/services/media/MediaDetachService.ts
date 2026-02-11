import { NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';
import { ProductModel } from '../../../models/product.model';
import { ProductVariantModel } from '../../../models/product-variant.model';
import { DigitalAssetModel } from '../../../models/digital-asset.model';

export interface DetachMediaCommand {
  fileId: string;
  ownerType: 'product' | 'variant';
  ownerId: string;
  vendorId: string;
}

/**
 * MediaDetachService
 * 
 * Detaches file from product or variant by removing fileId from mediaIds array.
 * Uses reference-counting to determine orphan status: only marks as orphan if
 * file is NOT referenced by ANY product/variant/digitalAsset.
 * 
 * NEVER mutates owner fields (those represent original uploader).
 */
export class MediaDetachService {
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
  ) {}

  /**
   * Detach file from product or variant
   * @param command - Detach command with file, owner, and vendor details
   * @throws NotFoundError if file or owner not found
   * @throws UnauthorizedError if vendor doesn't own the product
   */
  async execute(command: DetachMediaCommand, options?: RepositoryOptions): Promise<void> {
    // Validate file exists
    const file = await this.fileRepository.findById(command.fileId, options);
    if (!file) {
      throw new NotFoundError('File not found');
    }

    // Validate owner exists and remove fileId from mediaIds
    if (command.ownerType === 'product') {
      const product = await this.productRepository.findById(command.ownerId, command.vendorId, options);
      if (!product) {
        throw new NotFoundError('Product not found or access denied');
      }

      // Remove fileId from product mediaIds
      const updatedMediaIds = ((product as any).mediaIds || []).filter((id: string) => id !== command.fileId);
      await this.productRepository.update(
        command.ownerId,
        command.vendorId,
        { 
          // @ts-ignore
          mediaIds: updatedMediaIds 
        },
        options
      );

    } else if (command.ownerType === 'variant') {
      const variant = await this.variantRepository.findById(command.ownerId, options);
      if (!variant) {
        throw new NotFoundError('Variant not found');
      }

      // Verify vendor owns the parent product
      const product = await this.productRepository.findById(variant.productId, command.vendorId, options);
      if (!product) {
        throw new ForbiddenError('Vendor does not own this variant\'s product');
      }

      // Remove fileId from variant mediaIds
      const updatedMediaIds = ((variant as any).mediaIds || []).filter((id: string) => id !== command.fileId);
      await this.variantRepository.update(
        command.ownerId,
        { 
          // @ts-ignore
          mediaIds: updatedMediaIds 
        },
        options
      );
    }

    // Check if file is still referenced anywhere (reference-counted orphan detection)
    const isStillReferenced = await this.isFileReferenced(command.fileId);

    // Only mark as orphan if NOT referenced anywhere
    if (!isStillReferenced) {
      await this.fileRepository.updateOrphanStatus(command.fileId, true, options);
    }
  }

  /**
   * Check if file is still referenced by any product, variant, or digital asset
   * @param fileId - File ID to check
   * @returns true if file is still referenced, false otherwise
   */
  private async isFileReferenced(fileId: string): Promise<boolean> {
    // Check products
    const productCount = await ProductModel.countDocuments({
      mediaIds: fileId,
      deletedAt: null,
    });
    if (productCount > 0) return true;

    // Check variants
    const variantCount = await ProductVariantModel.countDocuments({
      mediaIds: fileId,
      deletedAt: null,
    });
    if (variantCount > 0) return true;

    // Check digital assets (mediaId field)
    const digitalAssetCount = await DigitalAssetModel.countDocuments({
      mediaId: fileId,
      deletedAt: null,
    });
    if (digitalAssetCount > 0) return true;

    return false;
  }
}
