import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IStockAuditLogRepository } from '../../../repositories/interfaces/stock-audit-log.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { InventoryAvailabilityCalculator } from './InventoryAvailabilityCalculator';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { v4 as uuidv4 } from 'uuid';
// Concrete file, not the stock-requests barrel — that module imports catalog
// repositories, and a barrel import here risks a require cycle.
import { StockChangeGate, stockChangeGate } from '../../../../stock-requests/services/stock-change-gate';

export interface BulkUpdateItem {
    variantId: string;
    quantity: number; // Absolute quantity to set
}

export interface BulkUpdateResult {
    success: true;
    batchId: string;
    updated: number;
    variants: Array<{
        variantId: string;
        sku: string;
        previousStock: number;
        newStock: number;
    }>;
    /**
     * Rows whose product is warehoused by an agency: **nothing was written for
     * these.** Each became a request the agency must approve. Sibling to `variants`
     * rather than folded into it, so a client cannot mistake a queued row for an
     * applied one.
     */
    requested: Array<{
        variantId: string;
        sku: string;
        requestId: string;
        requestedQuantity: number;
    }>;
    /**
     * Rows that could neither be applied nor queued — almost always because a
     * request is already open on that SKU. Reported rather than thrown: the
     * direct rows have already committed, so failing the whole call here would
     * report a rollback that did not happen.
     */
    notRequested: Array<{
        variantId: string;
        sku: string;
        error: string;
        message: string;
    }>;
}

export interface BulkUpdateError {
    success: false;
    errors: Array<{
        row: number;
        variantId: string;
        error: string;
        message: string;
    }>;
}

/**
 * BulkStockUpdateService
 *
 * Bulk stock adjustments with vendor ownership validation.
 *
 * **All-or-nothing applies to the rows this service actually writes.** Rows whose
 * product is warehoused by an agency are not the vendor's to write: those are
 * partitioned out before the transaction opens and become stock-adjustment requests
 * after it commits, reported separately as `requested`. That split is deliberate —
 * pulling them into the transaction would mean a rejected request could roll back
 * unrelated, legitimately-applied rows, and leaving them writable would make the
 * agency's countersignature bypassable by uploading a CSV.
 */
export class BulkStockUpdateService {
    private readonly MAX_ROWS = 1000;

    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly auditLogRepository: IStockAuditLogRepository,
        private readonly reservationRepository: IStockReservationRepository,
        private readonly availabilityCalculator: InventoryAvailabilityCalculator,
        private readonly transactionManager: TransactionManager,
        private readonly stockGate: StockChangeGate = stockChangeGate,
    ) { }

    async execute(
        vendorId: string,
        updates: BulkUpdateItem[],
        actorUserId?: string | null,
    ): Promise<BulkUpdateResult | BulkUpdateError> {
        // 1. Validate row limit
        if (updates.length > this.MAX_ROWS) {
            throw createAppError(ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED, 422, undefined, { max: this.MAX_ROWS, received: updates.length });
        }

        if (updates.length === 0) {
            throw createAppError(ERROR_CODES.CATALOG_BULK_EMPTY, 400, 'Bulk update must contain at least one item');
        }

        const batchId = uuidv4();

        // Which products need the agency's countersignature. Memoised per product,
        // because a CSV of 1000 rows is typically a handful of products and
        // `requiresApproval` costs a product read plus a vendor read.
        const approvalByProduct = new Map<string, boolean>();
        const requiresApproval = async (productId: string): Promise<boolean> => {
            const cached = approvalByProduct.get(productId);
            if (cached !== undefined) return cached;
            const { required } = await this.stockGate.requiresApproval(productId, vendorId);
            approvalByProduct.set(productId, required);
            return required;
        };

        // Partitioned out in the validation phase and raised after commit.
        const gatedRows: Array<{ variant: Variant; newQuantity: number }> = [];

        try {
            const applied = await this.transactionManager.runInTransaction(async (session) => {
                // 2. Validation phase - collect all errors
                const validationErrors: Array<{ row: number; variantId: string; error: string; message: string }> = [];
                const validatedVariants: Array<{ row: number; variant: Variant; newQuantity: number }> = [];

                for (let i = 0; i < updates.length; i++) {
                    const item = updates[i];
                    const row = i + 1;

                    try {
                        // Validate quantity is integer
                        if (!Number.isInteger(item.quantity)) {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'INVALID_QUANTITY',
                                message: 'Quantity must be an integer'
                            });
                            continue;
                        }

                        // Load variant
                        const variant = await this.variantRepository.findById(item.variantId, { session });

                        if (!variant) {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'INVALID_VARIANT',
                                message: 'Variant not found'
                            });
                            continue;
                        }

                        if (variant.status !== 'active') {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'VARIANT_ARCHIVED',
                                message: 'Cannot update stock for archived variant'
                            });
                            continue;
                        }

                        // Verify vendor ownership via product
                        const product = await this.productRepository.findById(variant.productId, vendorId, { session });

                        if (!product) {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'FORBIDDEN',
                                message: 'Variant does not belong to vendor'
                            });
                            continue;
                        }

                        if (product.type !== 'physical') {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'INVALID_PRODUCT_TYPE',
                                message: 'Stock management only available for physical products'
                            });
                            continue;
                        }

                        // Validate oversell rules
                        if (!variant.allowOversell && item.quantity < 0) {
                            validationErrors.push({
                                row,
                                variantId: item.variantId,
                                error: 'OVERSALE_NOT_ALLOWED',
                                message: 'Stock cannot be negative. Enable oversell if intentional.'
                            });
                            continue;
                        }

                        // Agency-warehoused: not ours to write. Partitioned out here,
                        // BEFORE the update phase, so the transaction only ever covers
                        // rows this vendor may actually change.
                        if (await requiresApproval(variant.productId)) {
                            gatedRows.push({ variant, newQuantity: item.quantity });
                            continue;
                        }

                        validatedVariants.push({ row, variant, newQuantity: item.quantity });
                    } catch (error: any) {
                        validationErrors.push({
                            row,
                            variantId: item.variantId,
                            error: 'VALIDATION_ERROR',
                            message: error.message || 'Validation failed'
                        });
                    }
                }

                // 3. If any validation errors, abort
                if (validationErrors.length > 0) {
                    return {
                        success: false,
                        errors: validationErrors
                    } as BulkUpdateError;
                }

                // 4. Update phase - atomic updates
                const results: Array<{
                    variantId: string;
                    sku: string;
                    previousStock: number;
                    newStock: number;
                }> = [];

                for (const { variant, newQuantity } of validatedVariants) {
                    const previousQuantity = variant.stock;
                    const delta = newQuantity - previousQuantity;

                    // Update stock
                    const updated = await this.variantRepository.update(
                        variant.id,
                        { stock: newQuantity },
                        { session }
                    );

                    if (!updated) {
                        throw createAppError(ERROR_CODES.CATALOG_BULK_UPDATE_FAILED, 500, undefined, { variantId: variant.id });
                    }

                    // Create audit log
                    await this.auditLogRepository.create({
                        variantId: variant.id,
                        productId: variant.productId,
                        vendorId,
                        previousQuantity,
                        newQuantity,
                        delta,
                        operation: 'bulk',
                        actorType: 'vendor',
                        actorId: vendorId,
                        metadata: { batchId },
                        timestamp: new Date(),
                        deletedAt: null,
                        purgeAt: null
                    }, { session });

                    results.push({
                        variantId: variant.id,
                        sku: variant.sku,
                        previousStock: previousQuantity,
                        newStock: newQuantity
                    });
                }

                return {
                    success: true,
                    batchId,
                    updated: results.length,
                    variants: results,
                    // Filled in after commit — see below.
                    requested: [],
                    notRequested: [],
                } as BulkUpdateResult;
            });

            // A validation failure aborted everything, gated rows included — raising
            // requests for a batch the vendor is about to fix and resubmit would leave
            // stale proposals behind.
            if (!applied.success) return applied;

            // 5. Post-commit: turn the gated rows into requests.
            //
            // After the commit, not inside it: a request is a proposal, not a stock
            // write, and one SKU already having an open request must not roll back
            // rows that legitimately applied.
            for (const { variant, newQuantity } of gatedRows) {
                try {
                    const request = await this.stockGate.intercept({
                        productId: variant.productId,
                        variantId: variant.id,
                        vendorId,
                        userId: actorUserId ?? null,
                        quantity: newQuantity,
                        note: `Bulk update ${batchId}`,
                    });
                    if (request) {
                        applied.requested.push({
                            variantId: variant.id,
                            sku: variant.sku,
                            requestId: request.id,
                            requestedQuantity: request.requestedQuantity,
                        });
                    }
                } catch (error: any) {
                    applied.notRequested.push({
                        variantId: variant.id,
                        sku: variant.sku,
                        error: error?.code ?? 'STOCK_REQUEST_FAILED',
                        message: error?.message ?? 'Could not raise a stock adjustment request for this SKU.',
                    });
                }
            }

            return applied;
        } catch (error: any) {
            // Check for MongoDB transaction size limit
            if (error.message?.includes('Transaction') || error.code === 16 || error.code === 280) {
                throw createAppError(ERROR_CODES.CATALOG_BULK_TRANSACTION_LIMIT, 413, 'Bulk operation exceeded database transaction size limit. Reduce batch size.');
            }
            throw error;
        }
    }
}
