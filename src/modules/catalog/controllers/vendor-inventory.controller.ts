import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../../core/errors';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess, sendPaginated } from '../../../core/responses';
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
    getAlerts = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        const vendorId = req.auth!.role_entity._id.toString();
        const query = AlertsQuerySchema.parse(req.query);

        const result = await alertService.getAlerts(vendorId, query.page, query.limit);

        sendSuccess(res, result);
    });

    /**
     * PATCH /api/vendor/inventory/bulk-update
     * Bulk stock updates (JSON or CSV)
     */
    bulkUpdate = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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

                if (records.length > 0) {
                    const headers = Object.keys(records[0] as Record<string, any>);
                    if (!headers.includes('variantId') || !headers.includes('quantity')) {
                        throw createAppError(ERROR_CODES.CATALOG_INVALID_CSV, 400, 'CSV must have variantId and quantity columns');
                    }

                    const allowedColumns = ['variantId', 'quantity'];
                    const unknownColumns = headers.filter(h => !allowedColumns.includes(h));
                    if (unknownColumns.length > 0) {
                        throw createAppError(ERROR_CODES.CATALOG_INVALID_CSV, 400, `Unknown columns: ${unknownColumns.join(', ')}. Expected: variantId, quantity`);
                    }
                }

                updates = records.map((record: any) => ({
                    variantId: record.variantId,
                    quantity: parseInt(record.quantity, 10)
                }));

                if (updates.length > 1000) {
                    throw createAppError(ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED, 422, undefined, { max: 1000, received: updates.length });
                }

            } catch (error: any) {
                if (error && error.code && (error.code === ERROR_CODES.CATALOG_BULK_LIMIT_EXCEEDED || error.code === ERROR_CODES.CATALOG_INVALID_CSV)) {
                    throw error;
                }
                throw createAppError(ERROR_CODES.CATALOG_INVALID_CSV, 400, `CSV parsing failed: ${error.message}`);
            }
        } else {
            // Handle JSON
            const body = BulkUpdateRequestSchema.parse(req.body);
            updates = body.updates;
        }

        // Execute bulk update
        const result = await bulkUpdateService.execute(vendorId, updates);

        if (result.success) {
            sendSuccess(res, result);
        } else {
            next(createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Bulk update failed', { errors: (result as any).errors }));
        }
    });

    /**
     * GET /api/vendor/inventory/history
     * Stock change audit log
     */
    getHistory = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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
                    throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Variant does not belong to vendor');
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

        sendPaginated(res, enrichedLogs, {
            total,
            page: query.page,
            limit: query.limit,
            pages: Math.ceil(total / query.limit),
        });
    });

    /**
     * GET /api/vendor/inventory/reservations
     * View active stock reservations
     * 
     * Vendor Scoping: All reservations are vendor-scoped via variant ownership validation.
     */
    getReservations = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
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
                    throw createAppError(ERROR_CODES.AUTH_FORBIDDEN, 403, 'Variant does not belong to vendor');
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

        sendPaginated(res, enrichedReservations, {
            total,
            page: query.page,
            limit: query.limit,
            pages: Math.ceil(total / query.limit),
            totalReserved,
        });
    });
}
