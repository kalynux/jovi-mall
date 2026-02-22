import { UnprocessableEntityError } from '../../../../core/errors';
import { Product } from '../../repositories/mappers/product.mapper';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';

/**
 * ProductStatusValidationService
 * 
 * Validates product status transitions based on business rules.
 * Ensures all products have required variants before publishing.
 */
export class ProductStatusValidationService {
    constructor(private readonly variantRepository: IVariantRepository) { }

    /**
     * Validate if a product can be activated
     * 
     * @param product - Product to validate
     * @param newStatus - Target status
     * @throws UnprocessableEntityError if validation fails
     */
    async validate(product: Product, newStatus: string): Promise<void> {
        // Only validate when activating
        if (newStatus !== 'active') {
            return; // Allow any other status transition
        }

        // UNIVERSAL VALIDATION: All product types require at least one variant
        // Price lives on variant, so without variant, product is not sellable
        const variants = await this.variantRepository.findByProduct(product.id);

        if (variants.length === 0) {
            throw new UnprocessableEntityError(
                `Cannot activate ${product.type} product without at least one variant. Price and stock are managed at the variant level.`
            );
        }

        // Validate every active variant has price > 0
        for (const variant of variants) {
            if (variant.status !== 'active') continue;

            if (variant.price <= 0) {
                throw new UnprocessableEntityError(
                    `Variant "${variant.name || variant.sku}" must have a price greater than 0 before publishing`
                );
            }
        }

        // Validate default variant exists
        if (!product.defaultVariantId) {
            throw new UnprocessableEntityError(
                `${product.type} product must have a default variant set before publishing`
            );
        }

        // TYPE-SPECIFIC VALIDATION

        // Digital product validation
        if (product.type === 'digital') {
            if (!product.digitalConfig?.assetId) {
                throw new UnprocessableEntityError(
                    'Cannot activate digital product without uploading a digital asset'
                );
            }
        }

        // Service product validation
        if (product.type === 'service') {
            if (!product.serviceConfig?.durationMinutes) {
                throw new UnprocessableEntityError(
                    'Cannot activate service product without setting duration'
                );
            }
        }

        // Physical products have no additional requirements beyond variants
    }
}
