import { UnprocessableEntityError } from '../../../../core/errors';
import { Product } from '../../repositories/mappers/product.mapper';

/**
 * ProductStatusValidationService
 * 
 * Validates product status transitions based on business rules.
 * Prevents activation of incomplete products (digital without asset, service without duration).
 */
export class ProductStatusValidationService {
    /**
     * Validate if a product can be activated
     * 
     * @param product - Product to validate
     * @param newStatus - Target status
     * @throws UnprocessableEntityError if validation fails
     */
    validate(product: Product, newStatus: string): void {
        // Only validate when activating
        if (newStatus !== 'active') {
            return; // Allow any other status transition
        }

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

        // Physical products can always be activated (no special requirements)
    }
}
