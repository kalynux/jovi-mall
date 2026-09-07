import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { BulkOperationResponse } from '../../dto/product.dto';
import { ProductStatusValidationService, VENDOR_STATUS_TRANSITIONS } from './ProductStatusValidationService';
import { ProductModel, ProductStatus } from '../../models/product.model';
import { EntitlementService, entitlementService } from '../../../billing/services/entitlement.service';
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
        private readonly statusValidationService: ProductStatusValidationService,
        private readonly entitlements: EntitlementService = entitlementService,
    ) { }

    /**
     * Refuse the whole batch when un-archiving it would take the vendor past their plan.
     *
     * ⚠ **Counted as a BATCH, and that is the entire point.** The single-product gate
     * (`assertCanAddProduct`) is a threshold test — "is there room for one more?" — read
     * against a count that does not move until the write lands. Called once per item in a
     * loop it answers identically for every item, so a vendor with one free slot
     * un-archives fifty products and all fifty checks pass. `assertCanAddProducts` does
     * the arithmetic instead.
     *
     * Only `archived` sources are counted: every other vendor-reachable source status
     * already occupies a slot (`countActiveByVendor` counts drafts), so moving between
     * them changes nothing. Un-archiving is the one bulk edge that takes slots back — and
     * archiving is exactly how a vendor frees a slot when they hit the cap, so leaving
     * this open would make the remedy for the limit into the way around it.
     *
     * All-or-nothing rather than partial: silently applying to the first N of a
     * fifty-item selection and skipping the rest reports a success whose shape the vendor
     * cannot see. The 403's `details` carries `available` so a dashboard can say exactly
     * how many slots are free.
     */
    private async assertRoomForBulk(productIds: string[], vendorId: string, target: string): Promise<void> {
        if (productIds.length === 0) return;
        // `archived` is not a legal source for any other target (VENDOR_STATUS_TRANSITIONS
        // maps it to ['draft'] alone), so nothing else can take a slot back.
        if (!vendorAllowedSourceStatuses(target).includes('archived')) return;

        const validIds = productIds.filter(id => Types.ObjectId.isValid(id));
        if (validIds.length === 0) return;

        const reclaiming = await ProductModel.countDocuments({
            _id: { $in: validIds },
            vendorId,
            status: 'archived',
            deletedAt: null,
        });
        if (reclaiming === 0) return;

        const slots = await this.productRepository.countActiveByVendor(vendorId);
        await this.entitlements.assertCanAddProducts(vendorId, slots, reclaiming);
    }

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

        // Throws 403 before any write when the batch would take the vendor past their plan.
        await this.assertRoomForBulk(eligible, vendorId, status);

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

        // Same batch gate as the fast path. It sits OUTSIDE the per-product loop
        // deliberately: inside, it would be the threshold test again, and every iteration
        // would read the same unchanged count and pass.
        await this.assertRoomForBulk(eligible, vendorId, status);

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
