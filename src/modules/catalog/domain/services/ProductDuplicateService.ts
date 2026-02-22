import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

/**
 * ProductDuplicateService
 * 
 * Handles product duplication with intelligent slug collision prevention.
 * Uses incremental numbering (-copy, -copy-2, -copy-3, etc.) to guarantee uniqueness.
 */
export class ProductDuplicateService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly slugService: SlugService
    ) { }

    /**
     * Duplicate a product with collision-safe slug generation
     * 
     * @param productId - ID of product to duplicate
     * @param vendorId - Vendor ID (ownership enforcement)
     * @returns Duplicated product in draft status
     */
    async execute(productId: string, vendorId: string): Promise<Product> {
        // 1. Find the original product
        const originalProduct = await this.productRepository.findById(productId, vendorId);

        if (!originalProduct) {
            throw new NotFoundError('Product not found');
        }

        // 2. Generate new title with " (copy)" suffix
        const newTitle = `${originalProduct.title} (copy)`;

        // 3. Generate unique slug with collision prevention
        // Try: original-slug-copy, original-slug-copy-2, original-slug-copy-3, etc.
        const baseSlug = `${originalProduct.slug}-copy`;
        const newSlug = await this.generateUniqueSlug(baseSlug, vendorId);

        // 4. Clone product data
        const clonedData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
            vendorId,
            type: originalProduct.type,
            status: 'draft', // Always draft
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

        // 5. Clone type-specific configs
        if (originalProduct.type === 'digital' && originalProduct.digitalConfig) {
            // For digital products, exclude assetId (must re-upload)
            clonedData.digitalConfig = {
                ...originalProduct.digitalConfig,
                assetId: undefined as any, // Must re-upload digital asset
            };
        }

        if (originalProduct.type === 'service' && originalProduct.serviceConfig) {
            clonedData.serviceConfig = { ...originalProduct.serviceConfig };
        }

        // 6. Create duplicated product
        return this.productRepository.create(clonedData);
    }

    /**
     * Generate unique slug with collision prevention
     * 
     * Strategy: base-slug, base-slug-2, base-slug-3, etc.
     */
    private async generateUniqueSlug(baseSlug: string, vendorId: string): Promise<string> {
        // First attempt: base slug without number
        let candidate = baseSlug;
        let exists = await this.productRepository.existsBySlug(candidate, vendorId);

        if (!exists) {
            return candidate;
        }

        // Increment until we find a unique slug
        let counter = 2;
        while (counter < 1000) { // Safety limit to prevent infinite loop
            candidate = `${baseSlug}-${counter}`;
            exists = await this.productRepository.existsBySlug(candidate, vendorId);

            if (!exists) {
                return candidate;
            }

            counter++;
        }

        // Fallback: use timestamp (highly unlikely to reach here)
        return `${baseSlug}-${Date.now()}`;
    }
}
