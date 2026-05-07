import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { Product } from '../../repositories/mappers/product.mapper';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';

/**
 * ProductStatusValidationService: Validates product status transitions based on business rules.
 */
export class ProductStatusValidationService {
    constructor(private readonly variantRepository: IVariantRepository) { }

    async validate(product: Product, newStatus: string): Promise<void> {
        if (newStatus !== 'active') return;

        const variants = await this.variantRepository.findByProduct(product.id);

        if (variants.length === 0) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_VARIANTS, 422, undefined, { type: product.type });
        }

        for (const variant of variants) {
            if (variant.status !== 'active') continue;
            if (variant.price <= 0) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_VARIANT_ZERO_PRICE, 422, undefined, {
                    variant: variant.name || variant.sku,
                });
            }
        }

        if (!product.defaultVariantId) {
            throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NO_DEFAULT_VARIANT, 422, undefined, { type: product.type });
        }

        if (product.type === 'digital') {
            if (!product.digitalConfig?.assetId) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_DIGITAL_NO_ASSET, 422);
            }
        }

        if (product.type === 'service') {
            if (!product.serviceConfig?.durationMinutes) {
                throw createAppError(ERROR_CODES.CATALOG_PRODUCT_SERVICE_NO_DURATION, 422);
            }
        }
    }
}
