import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { BulkOperationResponse } from '../../dto/product.dto';
import { ProductStatusValidationService, VENDOR_STATUS_TRANSITIONS } from './ProductStatusValidationService';
import { ProductModel, ProductStatus } from '../../models/product.model';
import { Types } from 'mongoose';

/**
 * Statuses a vendor-triggered bulk change to `target` may start from — the bulk
 * mirror of assertVendorTransition (same map, plus the same-status no-op).
 * Products in any other status are silently skipped by the updateMany filter and
 * surface in the response as failures by count.
 */
function vendorAllowedSourceStatuses(target: string): ProductStatus[] {
    return (Object.keys(VENDOR_STATUS_TRANSITIONS) as ProductStatus[])
        .filter(from => from === target || VENDOR_STATUS_TRANSITIONS[from].includes(target as ProductStatus));
}

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
     * Partition product ids into (eligible, pending) sets.
     * Products with vectorisationStatus === 'pending' cannot be mutated in bulk —
     * they would race the in-flight vectoriser snapshot.
     */
    private async partitionByVectorisationLock(
        productIds: string[],
    ): Promise<{ eligible: string[]; pending: string[] }> {
        const validIds = productIds.filter(id => Types.ObjectId.isValid(id));
        if (validIds.length === 0) return { eligible: [], pending: [] };

        const pendingDocs = await ProductModel.find(
            { _id: { $in: validIds }, vectorisationStatus: 'pending', deletedAt: null },
            { _id: 1 },
        ).lean();

        const pendingSet = new Set(pendingDocs.map(d => d._id.toString()));
        const eligible: string[] = [];
        const pending: string[] = [];

        for (const id of productIds) {
            if (pendingSet.has(id)) pending.push(id);
            else eligible.push(id);
        }

        return { eligible, pending };
    }

    /**
     * Bulk archive products
     *
     * @param productIds - Array of product IDs to archive
     * @param vendorId - Vendor ID (ownership enforcement)
     * @returns Result with success/failure counts. Pending products are reported as failures.
     */
    async bulkArchive(
        productIds: string[],
        vendorId: string
    ): Promise<BulkOperationResponse> {
        const { eligible, pending } = await this.partitionByVectorisationLock(productIds);

        const modifiedCount = eligible.length > 0
            ? await this.productRepository.bulkArchive(eligible, vendorId)
            : 0;

        const errors = pending.map(productId => ({
            productId,
            reason: 'Vectorisation is in progress for this product. Try again once it completes.',
        }));

        return {
            success: modifiedCount,
            failed: productIds.length - modifiedCount,
            total: productIds.length,
            errors: errors.length > 0 ? errors : undefined,
        };
    }

    /**
     * Bulk status change
     *
     * @param productIds - Array of product IDs
     * @param vendorId - Vendor ID (ownership enforcement)
     * @param status - New status to set
     * @returns Result with success/failure counts. Pending products are reported as failures.
     */
    async bulkStatusChange(
        productIds: string[],
        vendorId: string,
        status: string
    ): Promise<BulkOperationResponse> {
        const { eligible, pending } = await this.partitionByVectorisationLock(productIds);

        const modifiedCount = eligible.length > 0
            ? await this.productRepository.bulkUpdateStatus(eligible, vendorId, status, vendorAllowedSourceStatuses(status))
            : 0;

        const errors = pending.map(productId => ({
            productId,
            reason: 'Vectorisation is in progress for this product. Try again once it completes.',
        }));

        return {
            success: modifiedCount,
            failed: productIds.length - modifiedCount,
            total: productIds.length,
            errors: errors.length > 0 ? errors : undefined,
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

        const { eligible, pending } = await this.partitionByVectorisationLock(productIds);
        for (const productId of pending) {
            errors.push({
                productId,
                reason: 'Vectorisation is in progress for this product. Try again once it completes.',
            });
        }

        // Validate and update each product individually
        for (const productId of eligible) {
            try {
                const product = await this.productRepository.findById(productId, vendorId);

                if (!product) {
                    errors.push({
                        productId,
                        reason: 'Product not found',
                    });
                    continue;
                }

                // Transition gate first (suspended/pending_review are locked to
                // vendors; activation only from draft), then target requirements.
                this.statusValidationService.assertVendorTransition(product, status as ProductStatus);
                await this.statusValidationService.validate(product, status);

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
