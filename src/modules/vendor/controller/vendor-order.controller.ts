import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { VendorOrderService } from '../../orders/vendor-order.service';
import { VendorRefundService } from '../service/vendor-refund.service';
import {
    ListOrdersQuerySchema,
    UpdateFulfillmentStatusSchema,
    UpdateDeliveryAgencySchema,
    RevokeEntitlementSchema,
    RestoreEntitlementSchema,
    CreateNoteSchema,
    TimelineQuerySchema,
    RefundRequestSchema
} from '../validators/vendor-order.validator';
import { AppError } from '../../../core/errors';

const vendorOrderService = new VendorOrderService();
const vendorRefundService = new VendorRefundService();

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
            if (query.orderType) filters.orderType = query.orderType;  // NEW: Order type filter
            if (query.customerId) filters.customerId = query.customerId;  // NEW: Scope to one customer
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
     * GET /api/vendor/orders/:id/notes/:noteId
     *
     * Get a single vendor-internal note by ID.
     * Used to fetch the full note content from a timeline noteId reference.
     */
    static async getNote(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const noteId = req.params.noteId;

            const note = await vendorOrderService.getNoteById(noteId, vendorId);

            res.json({
                success: true,
                data: note
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
     * PATCH /api/vendor/orders/:id/delivery-agency
     * 
     * Update delivery agency for physical order
     * 
     * NEW: Phase 1 - Delivery agency assignment
     * 
     * BUSINESS RULES:
     * - Only for physical orders
     * - Not allowed for delivered/cancelled orders
     * - Timeline entry created
     */
    static async updateDeliveryAgency(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            // Validate request body
            const { deliveryAgencyId } = UpdateDeliveryAgencySchema.parse(req.body);

            const order = await vendorOrderService.updateDeliveryAgency(
                orderId,
                vendorId,
                deliveryAgencyId
            );

            res.json({
                success: true,
                data: order,
                message: 'Delivery agency updated successfully'
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/orders/:id/entitlements
     * 
     * Get digital entitlements for order
     * 
     * NEW: Phase 2 - View entitlements
     */
    static async getOrderEntitlements(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            const entitlements = await vendorOrderService.getOrderEntitlements(
                orderId,
                vendorId
            );

            res.json({
                success: true,
                data: entitlements,
                meta: {
                    count: entitlements.length,
                    activeCount: entitlements.filter(e => e.isActive).length,
                    revokedCount: entitlements.filter(e => e.isRevoked).length,
                    expiredCount: entitlements.filter(e => e.isExpired).length
                }
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/entitlements/:id/revoke
     * 
     * Revoke digital entitlement
     * 
     * NEW: Phase 2 - Revoke customer access
     */
    static async revokeEntitlement(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const entitlementId = req.params.id;

            // Validate request body
            const { reason } = RevokeEntitlementSchema.parse(req.body);

            const result = await vendorOrderService.revokeEntitlement(
                entitlementId,
                vendorId,
                reason
            );

            res.json({
                success: true,
                data: result,
                message: 'Entitlement revoked successfully'
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/entitlements/:id/restore
     * 
     * Restore revoked digital entitlement
     * 
     * NEW: Phase 2 - Restore customer access
     */
    static async restoreEntitlement(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const entitlementId = req.params.id;

            // Validate request body
            const { reason } = RestoreEntitlementSchema.parse(req.body);

            const result = await vendorOrderService.restoreEntitlement(
                entitlementId,
                vendorId,
                reason
            );

            res.json({
                success: true,
                data: result,
                message: 'Entitlement restored successfully'
            });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * GET /api/vendor/orders/:id/refund-eligibility
     *
     * Returns whether the order can be refunded under the vendor's return policy
     * and order state, plus the policy-allowed maximum. Frontend uses this to
     * show/hide the refund action and prefill the amount.
     */
    static async getRefundEligibility(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const orderId = req.params.id;

            const eligibility = await vendorRefundService.getEligibility(vendorId, orderId);

            res.json({ success: true, data: eligibility });
        } catch (error) {
            VendorOrderController.handleError(error, res);
        }
    }

    /**
     * POST /api/vendor/orders/:id/refund
     *
     * Action a refund on a paid, refundable order. Amount defaults to the
     * policy-computed maximum and may be overridden downward within that max.
     */
    static async refundOrder(req: Request, res: Response): Promise<void> {
        try {
            const vendorId = req.auth!.role_entity._id.toString();
            const initiatedBy = req.auth!.user._id.toString();
            const orderId = req.params.id;

            const input = RefundRequestSchema.parse(req.body);

            const result = await vendorRefundService.refund(vendorId, orderId, input, initiatedBy);

            res.json({
                success: true,
                data: result,
                message: result.fullyRefunded
                    ? 'Order fully refunded'
                    : 'Partial refund processed'
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
