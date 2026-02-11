import { NotFoundError, ForbiddenError, ValidationError, BulkLimitExceededError, TransactionLimitExceededError } from '../../../../../core/errors';
import { TransactionManager } from '../../../../../core/database/transaction.manager';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';
import { IStockAuditLogRepository } from '../../../repositories/interfaces/stock-audit-log.repository.interface';
import { IStockReservationRepository } from '../../../repositories/interfaces/stock-reservation.repository.interface';
import { InventoryAvailabilityCalculator } from './InventoryAvailabilityCalculator';
import { Variant } from '../../../repositories/mappers/variant.mapper';
import { v4 as uuidv4 } from 'uuid';

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
 * Atomic bulk stock adjustments with vendor ownership validation.
 * All-or-nothing transaction semantics.
 */
export class BulkStockUpdateService {
    private readonly MAX_ROWS = 1000;

    constructor(
        private readonly productRepository: IProductRepository,
        private readonly variantRepository: IVariantRepository,
        private readonly auditLogRepository: IStockAuditLogRepository,
        private readonly reservationRepository: IStockReservationRepository,
        private readonly availabilityCalculator: InventoryAvailabilityCalculator,
        private readonly transactionManager: TransactionManager
    ) { }

    async execute(
        vendorId: string,
        updates: BulkUpdateItem[]
    ): Promise<BulkUpdateResult | BulkUpdateError> {
        // 1. Validate row limit
        if (updates.length > this.MAX_ROWS) {
            throw new BulkLimitExceededError(this.MAX_ROWS);
        }

        if (updates.length === 0) {
            throw new ValidationError('Bulk update must contain at least one item');
        }

        const batchId = uuidv4();

        try {
            return await this.transactionManager.runInTransaction(async (session) => {
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
                        throw new Error(`Failed to update variant ${variant.id}`);
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
                    variants: results
                } as BulkUpdateResult;
            });
        } catch (error: any) {
            // Check for MongoDB transaction size limit
            if (error.message?.includes('Transaction') || error.code === 16 || error.code === 280) {
                throw new TransactionLimitExceededError();
            }
            throw error;
        }
    }
}
