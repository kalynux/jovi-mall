import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { RepositoryOptions } from '../../../repositories/types';

export interface DetachFileCommand {
    fileId: string;
    ownerType: 'product' | 'variant';
    ownerId: string;
    vendorId: string;  // For permission checking
}

/**
 * FileDetachService
 * 
 * Detaches file from product or variant by removing fileId from fileIds array.
 * Atomically decrements usageCount on the file (will fail if usageCount < 1).
 * 
 * NEVER mutates owner fields (those represent original uploader).
 */
export class FileDetachService {
    constructor(
        private readonly fileRepository: IFileRepository,
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
    ) { }

    /**
     * Detach file from product or variant
     * @param command - Detach command with file, owner, and vendor details
     * @throws NotFoundError if file or owner not found
     * @throws ForbiddenError if vendor doesn't own the product
     * @throws Error if usageCount cannot be decremented (already 0)
     */
    async execute(command: DetachFileCommand, options?: RepositoryOptions): Promise<void> {
        // Validate file exists
        const file = await this.fileRepository.findById(command.fileId, options);
        if (!file) {
            throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404);
        }

        // Validate owner exists and remove fileId from file Ids
        if (command.ownerType === 'product') {
            const product = await this.productRepository.findById(command.ownerId, command.vendorId, options);
            if (!product) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found or access denied');
            }

            // Remove fileId from product fileIds
            const updatedFileIds = (product.fileIds || []).filter((id: string) => id !== command.fileId);
            await this.productRepository.update(
                command.ownerId,
                command.vendorId,
                {
                    fileIds: updatedFileIds
                } as any,
                options
            );

        } else if (command.ownerType === 'variant') {
            const variant = await this.variantRepository.findById(command.ownerId, options);
            if (!variant) {
                throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
            }

            // Verify vendor owns the parent product
            const product = await this.productRepository.findById(variant.productId, command.vendorId, options);
            if (!product) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403, "Vendor does not own this variant's product");
            }

            // Remove fileId from variant fileIds
            const updatedFileIds = (variant.fileIds || []).filter((id: string) => id !== command.fileId);
            await this.variantRepository.update(
                command.ownerId,
                {
                    fileIds: updatedFileIds
                } as any,
                options
            );
        }

        // Atomically decrement usageCount (will fail if usageCount < 1)
        await this.fileRepository.decrementUsageCount(command.fileId, options);
    }
}
