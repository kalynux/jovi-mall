import { Request, Response } from 'express';
import { ZodError } from 'zod';
import {
    AppError,
    ValidationError,
    BulkLimitExceededError,
    TransactionLimitExceededError,
    InvalidCSVFormatError
} from '../../../core/errors';
import {
    BulkUpdateRequestSchema,
    InventoryHistoryQuerySchema,
    ReservationsQuerySchema,
    AlertsQuerySchema
} from '../validators/inventory.validator';
import { InventoryAlertService } from '../domain/services/inventory/InventoryAlertService';
import { BulkStockUpdateService } from '../domain/services/inventory/BulkStockUpdateService';
import { StockAuditLogRepositoryMongo } from '../repositories/mongo/stock-audit-log.repository.mongo';
import { StockReservationRepositoryMongo } from '../repositories/mongo/stock-reservation.repository.mongo';
import { ProductRepositoryMongo } from '../repositories/mongo/product.repository.mongo';
import { VariantRepositoryMongo } from '../repositories/mongo/variant.repository.mongo';
import { InventoryAvailabilityCalculator } from '../domain/services/inventory/InventoryAvailabilityCalculator';
import { TransactionManager } from '../../../core/database/transaction.manager';
import * as csv from 'csv-parse/sync';

// Repository instances
const auditLogRepository = new StockAuditLogRepositoryMongo();
const reservationRepository = new StockReservationRepositoryMongo();
const productRepository = new ProductRepositoryMongo();
const variantRepository = new VariantRepositoryMongo();
const availabilityCalculator = new InventoryAvailabilityCalculator();
const transactionManager = new TransactionManager();

// Service instances
const alertService = new InventoryAlertService(
    productRepository,
    variantRepository,
    reservationRepository,
    availabilityCalculator
);

const bulkUpdateService = new BulkStockUpdateService(
    productRepository,
    variantRepository,
    auditLogRepository,
    reservationRepository,
    availabilityCalculator,
    transactionManager
);

/**
 * VendorInventoryController
 * 
 * Vendor-scoped inventory management endpoints.
 * All operations are vendor-controlled and vendor-isolated.
 */
export class VendorInventoryController {
    /**
     * GET /api/vendor/inventory/alerts
     * Get low-stock alerts for vendor
     */
    async getAlerts(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const query = AlertsQuerySchema.parse(req.query);

            const result = await alertService.getAlerts(vendorId, query.page, query.limit);

            res.json(result);
        } catch (error) {
            this.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/inventory/bulk-update
     * Bulk stock updates (JSON or CSV)
     */
    async bulkUpdate(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            let updates;

            // Handle CSV upload
            if (req.headers['content-type']?.includes('text/csv') || req.file) {
                const csvContent = req.file ? req.file.buffer.toString('utf-8') : req.body;

                // Parse CSV
                try {
                    const records = csv.parse(csvContent, {
                        columns: true,
                        skip_empty_lines: true,
                        trim: true,
                        encoding: 'utf8'
                    });

                    // Validate headers
                    if (records.length > 0) {
                        const headers = Object.keys(records[0] as Record<string, any>);
                        if (!headers.includes('variantId') || !headers.includes('quantity')) {
                            throw new InvalidCSVFormatError();
                        }

                        // Check for unknown columns
                        const allowedColumns = ['variantId', 'quantity'];
                        const unknownColumns = headers.filter(h => !allowedColumns.includes(h));
                        if (unknownColumns.length > 0) {
                            throw new InvalidCSVFormatError(
                                `Unknown columns: ${unknownColumns.join(', ')}. Expected: variantId, quantity`
                            );
                        }
                    }

                    // Convert to updates array
                    updates = records.map((record: any) => ({
                        variantId: record.variantId,
                        quantity: parseInt(record.quantity, 10)
                    }));

                    // Validate row limit before parsing
                    if (updates.length > 1000) {
                        throw new BulkLimitExceededError(1000);
                    }

                } catch (error: any) {
                    if (error instanceof BulkLimitExceededError || error instanceof InvalidCSVFormatError) {
                        throw error;
                    }
                    throw new InvalidCSVFormatError(`CSV parsing failed: ${error.message}`);
                }
            } else {
                // Handle JSON
                const body = BulkUpdateRequestSchema.parse(req.body);
                updates = body.updates;
            }

            // Execute bulk update
            const result = await bulkUpdateService.execute(vendorId, updates);

            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }
        } catch (error) {
            this.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/inventory/history
     * Stock change audit log
     */
    async getHistory(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const query = InventoryHistoryQuerySchema.parse(req.query);

            const filters: any = {};
            if (query.startDate) filters.startDate = new Date(query.startDate);
            if (query.endDate) filters.endDate = new Date(query.endDate);

            const pagination = {
                page: query.page,
                limit: query.limit
            };

            let logs;
            let total;

            if (query.variantId) {
                // Query by variant
                logs = await auditLogRepository.findByVariant(query.variantId, filters, pagination);
                total = await auditLogRepository.countByVariant(query.variantId, filters);

                // Verify variant belongs to vendor
                const variant = await variantRepository.findById(query.variantId);
                if (variant) {
                    const product = await productRepository.findById(variant.productId, vendorId);
                    if (!product) {
                        res.status(403).json({ error: 'Forbidden', message: 'Variant does not belong to vendor' });
                        return;
                    }
                }
            } else {
                // Query by vendor
                logs = await auditLogRepository.findByVendor(vendorId, filters, pagination);
                total = await auditLogRepository.countByVendor(vendorId, filters);
            }

            // Enrich logs with SKU information
            const enrichedLogs = await Promise.all(
                logs.map(async (log) => {
                    const variant = await variantRepository.findById(log.variantId);
                    return {
                        id: log.id,
                        variantId: log.variantId,
                        sku: variant?.sku || 'N/A',
                        previousQuantity: log.previousQuantity,
                        newQuantity: log.newQuantity,
                        delta: log.delta,
                        operation: log.operation,
                        timestamp: log.timestamp,
                        metadata: log.metadata
                    };
                })
            );

            res.json({
                logs: enrichedLogs,
                pagination: {
                    page: query.page,
                    limit: query.limit,
                    total,
                    totalPages: Math.ceil(total / query.limit)
                }
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/inventory/reservations
     * View active stock reservations
     * 
     * Vendor Scoping: All reservations are vendor-scoped via variant ownership validation.
     */
    async getReservations(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const query = ReservationsQuerySchema.parse(req.query);

            const filters: any = {
                status: query.status
            };

            if (query.variantId) {
                filters.variantId = query.variantId;

                // Verify variant belongs to vendor
                const variant = await variantRepository.findById(query.variantId);
                if (variant) {
                    const product = await productRepository.findById(variant.productId, vendorId);
                    if (!product) {
                        res.status(403).json({ error: 'Forbidden', message: 'Variant does not belong to vendor' });
                        return;
                    }
                }
            }

            const pagination = {
                page: query.page,
                limit: query.limit
            };

            // Get reservations for vendor (vendor-scoped via variant ownership)
            const reservations = await reservationRepository.findByVendor(vendorId, filters, pagination);
            const total = await reservationRepository.countByVendor(vendorId, filters);

            // Enrich reservations with variant/product info
            const enrichedReservations = await Promise.all(
                reservations.map(async (reservation) => {
                    const variant = await variantRepository.findById(reservation.variantId);
                    const product = variant ? await productRepository.findById(variant.productId, vendorId) : null;

                    return {
                        reservationId: reservation.reservationId,
                        variantId: reservation.variantId,
                        sku: variant?.sku || 'N/A',
                        productTitle: product?.title || 'N/A',
                        quantity: reservation.quantity,
                        type: reservation.type,
                        status: reservation.status,
                        expiresAt: reservation.expiresAt,
                        createdAt: reservation.createdAt
                    };
                })
            );

            // Calculate total reserved quantity
            const totalReserved = reservations.reduce((sum, r) => sum + r.quantity, 0);

            res.json({
                reservations: enrichedReservations,
                totalReserved,
                pagination: {
                    page: query.page,
                    limit: query.limit,
                    total,
                    totalPages: Math.ceil(total / query.limit)
                }
            });
        } catch (error) {
            this.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     */
    private handleError(error: any, res: Response): void {
        console.error('VendorInventoryController error:', error);

        if (error instanceof ZodError) {
            res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details: error.errors
            });
            return;
        }

        if (error instanceof BulkLimitExceededError) {
            res.status(400).json({
                error: error.code,
                message: error.message
            });
            return;
        }

        if (error instanceof TransactionLimitExceededError) {
            res.status(413).json({
                error: 'TRANSACTION_LIMIT_EXCEEDED',
                message: error.message
            });
            return;
        }

        if (error instanceof InvalidCSVFormatError) {
            res.status(400).json({
                error: error.code,
                message: error.message
            });
            return;
        }

        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                error: error.code,
                message: error.message
            });
            return;
        }

        res.status(500).json({
            error: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred'
        });
    }
}
