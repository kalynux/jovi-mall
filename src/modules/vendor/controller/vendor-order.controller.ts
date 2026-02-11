import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { VendorOrderService } from '../../orders/vendor-order.service';
import {
    ListOrdersQuerySchema,
    UpdateFulfillmentStatusSchema,
    CreateNoteSchema,
    TimelineQuerySchema
} from '../validators/vendor-order.validator';
import { AppError } from '../../../core/errors';

const vendorOrderService = new VendorOrderService();

/**
 * Vendor Order Controller
 * 
 * HTTP layer for vendor order management.
 * 
 * RESPONSIBILITIES:
 * - Extract data from HTTP request
 * - Validate with Zod schemas
 * - Call service layer
 * - Format HTTP response
 * - Handle errors with consistent format
 * 
 * SECURITY:
 * - All routes protected by requireAuth + requireRole(['vendor']) middleware
 * - Vendor can only access their own orders (extracted from req.auth)
 */
export class VendorOrderController {
    /**
     * GET /api/vendor/orders
     * 
     * List orders with filters and pagination
     */
    static async listOrders(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();

            // Validate query parameters
            const query = ListOrdersQuerySchema.parse(req.query);

            // Build filters
            const filters: any = {};
            if (query.status) filters.status = query.status;
            if (query.paymentStatus) filters.paymentStatus = query.paymentStatus;
            if (query.dateFrom) filters.dateFrom = new Date(query.dateFrom);
            if (query.dateTo) filters.dateTo = new Date(query.dateTo);
            if (query.q) filters.q = query.q;

            // Build pagination
            const pagination = {
                page: query.page,
                limit: query.limit,
                sort: { [query.sortBy]: query.sortOrder === 'asc' ? 1 as const : -1 as const }
            };

            const result = await vendorOrderService.listOrders(vendorId, filters, pagination);

            res.json({
                success: true,
                data: result.data,
                meta: result.meta
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/orders/:id
     * 
     * Get order details
     */
    static async getOrderDetails(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            const order = await vendorOrderService.getOrderDetails(orderId, vendorId);

            res.json({
                success: true,
                data: order
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * PATCH /api/vendor/orders/:id/status
     * 
     * Update fulfillment status
     * 
     * BUSINESS RULES:
     * - Enforces state machine transitions
     * - Prevents updates to terminal states
     * - Validates payment status before advancing fulfillment
     */
    static async updateFulfillmentStatus(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            // Validate request body
            const { status } = UpdateFulfillmentStatusSchema.parse(req.body);

            const order = await vendorOrderService.updateFulfillmentStatus(orderId, vendorId, status);

            res.json({
                success: true,
                data: order,
                message: `Order status updated to '${status}'`
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/orders/:id/timeline
     * 
     * Get order timeline (audit trail)
     */
    static async getTimeline(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            // Validate query parameters
            const query = TimelineQuerySchema.parse(req.query);

            const pagination = {
                page: query.page,
                limit: query.limit,
                sort: { created_at: -1 as const }  // Newest first
            };

            const result = await vendorOrderService.getTimeline(orderId, vendorId, pagination);

            res.json({
                success: true,
                data: result.data,
                meta: result.meta
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/orders/:id/notes
     * 
     * Add vendor-internal note
     */
    static async addNote(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const userId = req.auth!.user._id.toString();  // Note author
            const orderId = req.params.id;

            // Validate request body
            const { message } = CreateNoteSchema.parse(req.body);

            const note = await vendorOrderService.addNote(orderId, vendorId, userId, message);

            res.json({
                success: true,
                data: note,
                message: 'Note added successfully'
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/orders/:id/notes
     * 
     * Get vendor-internal notes for order
     */
    static async getNotes(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            const notes = await vendorOrderService.getNotes(orderId, vendorId);

            res.json({
                success: true,
                data: notes
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * Centralized error handler
     * 
     * Provides consistent error response format.
     * Handles different error types appropriately.
     */
    private static handleError(error: any, res: Response): void {
        // Zod validation errors
        if (error instanceof ZodError) {
            res.status(400).json({
                success: false,
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Request validation failed',
                    details: error.errors.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message
                    }))
                }
            });
            return;
        }

        // Application errors (NotFoundError, ForbiddenError, etc.)
        if (error instanceof AppError) {
            res.status(error.statusCode).json({
                success: false,
                error: {
                    code: error.code,
                    message: error.message
                }
            });
            return;
        }

        // Unknown errors
        console.error('[VendorOrderController] Unexpected error:', error);
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred. Please try again later.'
            }
        });
    }
}
