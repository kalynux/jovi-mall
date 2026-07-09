import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
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
 *
 * Errors raised in services (createAppError) and Zod validation errors propagate
 * to the global error handler via asyncHandler — never written inline.
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
    static listOrders = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * GET /api/vendor/orders/:id
     *
     * Get order details
     */
    static getOrderDetails = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const orderId = req.params.id;

        const order = await vendorOrderService.getOrderDetails(orderId, vendorId);

        res.json({
            success: true,
            data: order
        });
    });

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
    static updateFulfillmentStatus = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * POST /api/vendor/orders/:id/dispatch
     *
     * Explicitly dispatch a reviewed, paid order to its delivery agency —
     * advances `pending` shipments to `assigned`, making them visible on the
     * agency's own dashboard. The manual counterpart to the vendor's
     * `auto_redirect_orders_to_agency` setting.
     */
    static dispatchToAgency = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const orderId = req.params.id;

        const result = await vendorOrderService.dispatchToAgency(orderId, vendorId);

        res.json({
            success: true,
            data: result,
            message: result.dispatchedShipments > 0
                ? `Order dispatched to ${result.dispatchedShipments} shipment(s)' delivery agency`
                : 'Nothing to dispatch — order already dispatched or has no pending shipments'
        });
    });

    /**
     * GET /api/vendor/orders/:id/timeline
     *
     * Get order timeline (audit trail)
     */
    static getTimeline = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * POST /api/vendor/orders/:id/notes
     *
     * Add vendor-internal note
     */
    static addNote = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * GET /api/vendor/orders/:id/notes/:noteId
     *
     * Get a single vendor-internal note by ID.
     * Used to fetch the full note content from a timeline noteId reference.
     */
    static getNote = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const noteId = req.params.noteId;

        const note = await vendorOrderService.getNoteById(noteId, vendorId);

        res.json({
            success: true,
            data: note
        });
    });

    /**
     * GET /api/vendor/orders/:id/notes
     *
     * Get vendor-internal notes for order
     */
    static getNotes = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const orderId = req.params.id;

        const notes = await vendorOrderService.getNotes(orderId, vendorId);

        res.json({
            success: true,
            data: notes
        });
    });

    /**
     * PATCH /api/vendor/orders/:id/delivery-agency
     *
     * Reassign the delivery agency for a single item of a physical order.
     *
     * BUSINESS RULES:
     * - Only for physical orders
     * - Item-scoped: other items keep their own agency (an order may be split
     *   across several agencies)
     * - Item must still be pending/assigned (not already dispatched)
     * - Not allowed for delivered/cancelled orders
     * - Timeline entry created
     */
    static updateDeliveryAgency = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const orderId = req.params.id;

        // Validate request body
        const { itemId, deliveryAgencyId } = UpdateDeliveryAgencySchema.parse(req.body);

        const order = await vendorOrderService.updateDeliveryAgency(
            orderId,
            vendorId,
            itemId,
            deliveryAgencyId
        );

        res.json({
            success: true,
            data: order,
            message: 'Delivery agency updated successfully'
        });
    });

    /**
     * GET /api/vendor/orders/:id/entitlements
     *
     * Get digital entitlements for order
     *
     * NEW: Phase 2 - View entitlements
     */
    static getOrderEntitlements = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * POST /api/vendor/entitlements/:id/revoke
     *
     * Revoke digital entitlement
     *
     * NEW: Phase 2 - Revoke customer access
     */
    static revokeEntitlement = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * POST /api/vendor/entitlements/:id/restore
     *
     * Restore revoked digital entitlement
     *
     * NEW: Phase 2 - Restore customer access
     */
    static restoreEntitlement = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });

    /**
     * GET /api/vendor/orders/:id/refund-eligibility
     *
     * Returns whether the order can be refunded under the vendor's return policy
     * and order state, plus the policy-allowed maximum. Frontend uses this to
     * show/hide the refund action and prefill the amount.
     */
    static getRefundEligibility = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const vendorId = req.auth!.role_entity._id.toString();
        const orderId = req.params.id;

        const eligibility = await vendorRefundService.getEligibility(vendorId, orderId);

        res.json({ success: true, data: eligibility });
    });

    /**
     * POST /api/vendor/orders/:id/refund
     *
     * Action a refund on a paid, refundable order. Amount defaults to the
     * policy-computed maximum and may be overridden downward within that max.
     */
    static refundOrder = asyncHandler(async (req: Request, res: Response): Promise<void> => {
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
    });
}
