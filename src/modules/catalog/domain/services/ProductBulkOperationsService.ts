import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { BulkOperationResponse } from '../../dto/product.dto';
import { ProductStatusValidationService } from './ProductStatusValidationService';

/**
 * ProductBulkOperationsService
 * 
 * Handles bulk operations on products (archive, status change).
 * Validates vendor ownership and enforces business rules.
 */
export class ProductBulkOperationsService {
    constructor(
        private readonly productRepository: IProductRepository,
        private readonly statusValidationService: ProductStatusValidationService
    ) { }

    /**
     * Bulk archive products
     * 
     * @param productIds - Array of product IDs to archive
     * @param vendorId - Vendor ID (ownership enforcement)
     * @returns Result with success/failure counts
     */
    async bulkArchive(
        productIds: string[],
        vendorId: string
    ): Promise<BulkOperationResponse> {
        const modifiedCount = await this.productRepository.bulkArchive(
            productIds,
            vendorId
        );

        return {
            success: modifiedCount,
            failed: productIds.length - modifiedCount,
            total: productIds.length,
        };
    }

    /**
     * Bulk status change
     * 
     * @param productIds - Array of product IDs
     * @param vendorId - Vendor ID (ownership enforcement)
     * @param status - New status to set
     * @returns Result with success/failure counts
     */
    async bulkStatusChange(
        productIds: string[],
        vendorId: string,
        status: string
    ): Promise<BulkOperationResponse> {
        // If activating, we need to validate each product individually
        // For now, we'll use the repository method which doesn't validate
        // In production, you might want to fetch and validate each product
        // before bulk updating, but for performance we'll allow the update
        // and rely on frontend validation

        const modifiedCount = await this.productRepository.bulkUpdateStatus(
            productIds,
            vendorId,
            status
        );

        return {
            success: modifiedCount,
            failed: productIds.length - modifiedCount,
            total: productIds.length,
        };
    }

    /**
     * Bulk status change with validation (slower but safer)
     * 
     * This validates each product before updating.
     * Use this when activating products to ensure they meet requirements.
     */
    async bulkStatusChangeWithValidation(
        productIds: string[],
        vendorId: string,
        status: string
    ): Promise<BulkOperationResponse> {
        const errors: Array<{ productId: string; reason: string }> = [];
        let successCount = 0;

        // Validate and update each product individually
        for (const productId of productIds) {
            try {
                const product = await this.productRepository.findById(productId, vendorId);

                if (!product) {
                    errors.push({
                        productId,
                        reason: 'Product not found',
                    });
                    continue;
                }

                // Validate status transition
                this.statusValidationService.validate(product, status);

                // Update status
                await this.productRepository.update(productId, vendorId, { status: status as any });
                successCount++;
            } catch (error: any) {
                errors.push({
                    productId,
                    reason: error.message || 'Unknown error',
                });
            }
        }

        return {
            success: successCount,
            failed: errors.length,
            total: productIds.length,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
}
