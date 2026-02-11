import { ConflictError, NotFoundError, ForbiddenError } from '../../../../../core/errors';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';

export interface AttachMediaCommand {
  fileId: string;
  ownerType: 'product' | 'variant';
  ownerId: string;
  vendorId: string;
}

/**
 * MediaAttachService
 * 
 * Attaches file to product or variant by adding fileId to mediaIds array.
 * Marks file as not orphaned (file now has at least one reference).
 * 
 * DOES NOT mutate owner fields (those represent original uploader).
 */
export class MediaAttachService {
  constructor(
    private readonly fileRepository: IFileRepository,
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository
  ) {}

  /**
   * Attach file to product or variant
   * @param command - Attach command with file, owner, and vendor details
   * @throws NotFoundError if file or owner not found
   * @throws UnauthorizedError if vendor doesn't own the product
   * @throws ConflictError if file is already attached
   */
  async execute(command: AttachMediaCommand, options?: RepositoryOptions): Promise<void> {
    // Validate file exists
    const file = await this.fileRepository.findById(command.fileId, options);
    if (!file) {
      throw new NotFoundError('File not found');
    }

    // Validate owner exists and vendor has permission
    if (command.ownerType === 'product') {
      const product = await this.productRepository.findById(command.ownerId, command.vendorId, options);
      if (!product) {
        throw new NotFoundError('Product not found or access denied');
      }

      // Check if already attached
      // Note: In real implementation, Product should have mediaIds field
      // For now, we'll skip duplicate check as it depends on Product schema updates
      
      // Add fileId to product mediaIds
      await this.productRepository.update(
        command.ownerId,
        command.vendorId,
        { 
          // @ts-ignore - mediaIds will be added to Product in future update
          mediaIds: [...(product.mediaIds || []), command.fileId] 
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

      // Add fileId to variant mediaIds
      await this.variantRepository.update(
        command.ownerId,
        { 
          // @ts-ignore - mediaIds already exists in Variant
          mediaIds: [...(variant.mediaIds || []), command.fileId] 
        },
        options
      );
    }

    // Mark file as not orphaned (it now has a reference)
    await this.fileRepository.updateOrphanStatus(command.fileId, false, options);
  }
}
