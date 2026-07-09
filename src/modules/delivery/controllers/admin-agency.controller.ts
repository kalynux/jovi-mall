import { Request, Response } from 'express';
import { AdminAgencyService } from '../services/admin-agency.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { vectorisationService } from '../../catalog/domain/services/VectorisationService';

const adminAgencyService = new AdminAgencyService();

/**
 * Admin Delivery Agency Controller
 *
 * All handlers use asyncHandler — errors flow to the global error handler.
 */
export class AdminAgencyController {
    /** GET /api/admin/delivery-agencies */
    static list = asyncHandler(async (req: Request, res: Response) => {
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const statusRaw = req.query.status as string | undefined;
        const status = (['active', 'pending_verification', 'inactive'] as const).find(s => s === statusRaw);

        const result = await adminAgencyService.list({ status, page, limit });
        res.json({ success: true, data: result.agencies, meta: result.meta });
    });

    /** GET /api/admin/delivery-agencies/:id */
    static getById = asyncHandler(async (req: Request, res: Response) => {
        const agency = await adminAgencyService.getById(req.params.id);
        res.json({ success: true, data: agency });
    });

    /** PATCH /api/admin/delivery-agencies/:id/deactivate */
    static deactivate = asyncHandler(async (req: Request, res: Response) => {
        const actorUserId = req.auth!.user._id.toString();
        const { agency, affectedProductIds, heldOrderItemCount } = await adminAgencyService.deactivate(req.params.id, actorUserId);

        res.json({
            success: true,
            data: agency,
            meta: { suspendedProductCount: affectedProductIds.length, heldOrderItemCount },
            message: `Agency deactivated. ${affectedProductIds.length} product(s) suspended, ${heldOrderItemCount} order item(s) put on hold.`,
        });

        for (const productId of affectedProductIds) {
            void vectorisationService.notifyStatusChange(productId, 'suspended');
        }
    });

    /** PATCH /api/admin/delivery-agencies/:id/reactivate */
    static reactivate = asyncHandler(async (req: Request, res: Response) => {
        const actorUserId = req.auth!.user._id.toString();
        const { agency, restoredProducts, unheldOrderItemCount } = await adminAgencyService.reactivate(req.params.id, actorUserId);

        res.json({
            success: true,
            data: agency,
            meta: { restoredProductCount: restoredProducts.length, unheldOrderItemCount },
            message: `Agency reactivated. ${restoredProducts.length} product(s) restored, ${unheldOrderItemCount} order item(s) resumed.`,
        });

        for (const product of restoredProducts) {
            void vectorisationService.notifyStatusChange(product.productId, product.status);
        }
    });
}
