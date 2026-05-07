import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

/**
 * ProductDuplicateService: Duplicate a product with collision-safe slug generation
 */
export class ProductDuplicateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly slugService: SlugService
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
            hasVariants: originalProduct.hasVariants,
            deletedAt: null,
            fileIds: originalProduct.fileIds,
        };

        if (originalProduct.type === 'digital' && originalProduct.digitalConfig) {
            clonedData.digitalConfig = {
                ...originalProduct.digitalConfig,
                assetId: undefined as any,
            };
        }

        if (originalProduct.type === 'service' && originalProduct.serviceConfig) {
            clonedData.serviceConfig = { ...originalProduct.serviceConfig };
        }

        return this.productRepository.create(clonedData);
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
