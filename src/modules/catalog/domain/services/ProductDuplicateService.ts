import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';

/**
 * ProductDuplicateService: Duplicate a product with collision-safe slug generation
 */
export class ProductDuplicateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly slugService: SlugService,
        private readonly fileReferenceService: FileReferenceService
    ) { }

    async execute(productId: string, vendorId: string): Promise<Product> {
        const originalProduct = await this.productRepository.findById(productId, vendorId);

        if (!originalProduct) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
        }

        const newTitle = `${originalProduct.title} (copy)`;
        const baseSlug = `${originalProduct.slug}-copy`;
        const newSlug = await this.generateUniqueSlug(baseSlug, vendorId);

        const clonedData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
            vendorId,
            type: originalProduct.type,
            status: 'draft',
            title: newTitle,
            description: originalProduct.description || '',
            slug: newSlug,
            category: originalProduct.category,
            tags: [...(originalProduct.tags ?? [])],
            seo: { ...originalProduct.seo },
            hasVariants: false,
            defaultVariantId: undefined,
            deletedAt: null,
            fileIds: [...(originalProduct.fileIds ?? [])],
            // Duplicated products start with vectorisation reset — vendor must re-enable
            vectorisationEnabled: false,
            vectorisationStatus: 'not_started',
            vectorisedDataId: null,
        };

        if (originalProduct.type === 'digital' && originalProduct.digitalConfig) {
            // Duplicates start disabled. Per-variant assets/limits are not copied — vendor
            // must re-upload assets per variant on the clone via the variant upload endpoints.
            clonedData.digitalConfig = {
                isActive: false,
            };
        }

        // Service config + price live on the variant, which (like digital assets) is not
        // copied — the vendor recreates the service variant on the clone.

        const duplicate = await this.productRepository.create(clonedData);

        // The clone references the same media as the original — register a
        // reference row per file so the clone counts as a distinct user of each.
        if (clonedData.fileIds.length > 0) {
            await this.fileReferenceService.reconcile({
                previousFileIds: [],
                nextFileIds: clonedData.fileIds,
                vendorId,
                entityType: 'product',
                entityId: duplicate.id,
            });
        }

        return duplicate;
    }

    private async generateUniqueSlug(baseSlug: string, vendorId: string): Promise<string> {
        let candidate = baseSlug;
        let exists = await this.productRepository.existsBySlug(candidate, vendorId);

        if (!exists) return candidate;

        let counter = 2;
        while (counter < 1000) {
            candidate = `${baseSlug}-${counter}`;
            exists = await this.productRepository.existsBySlug(candidate, vendorId);
            if (!exists) return candidate;
            counter++;
        }

        return `${baseSlug}-${Date.now()}`;
    }
}
