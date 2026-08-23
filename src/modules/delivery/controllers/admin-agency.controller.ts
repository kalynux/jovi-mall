import { Request, Response } from 'express';
import { AdminAgencyService } from '../services/admin-agency.service';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { vectorisationService } from '../../catalog/domain/services/VectorisationService';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { AdminRejectAgencyKycSchema } from '../validators/admin-agency.validator';

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

    /**
     * POST /api/admin/delivery-agencies/:id/verify
     *
     * `actorFromRequest` rather than the bare `user._id` its two neighbours use: this write
     * STAMPS the actor onto the agency, and under `requireAdminCaller` that id belongs to
     * the wi-admin database and resolves to nothing here. The `_source`/`_name` companions
     * are what make it legible rather than look like a dangling reference.
     */
    static verify = asyncHandler(async (req: Request, res: Response) => {
        const agency = await adminAgencyService.verify(req.params.id, actorFromRequest(req));
        res.json({ success: true, data: agency, message: 'Agency verified and activated.' });
    });

    /**
     * POST /api/admin/delivery-agencies/:id/reject — body `{ reason }`.
     *
     * The other verdict, added beside `verify` in Phase 6 Step 4. `actorFromRequest`
     * for the same reason as its sibling: this write stamps the reviewer, and under
     * `requireAdminCaller` that id resolves in the wi-admin database and nowhere here.
     *
     * It changes no status — see `AdminAgencyService.reject`. The agency stays pending,
     * which is what every existing gate already refuses.
     */
    static reject = asyncHandler(async (req: Request, res: Response) => {
        const input = AdminRejectAgencyKycSchema.parse(req.body);
        const agency = await adminAgencyService.reject(req.params.id, actorFromRequest(req), input.reason);
        res.json({ success: true, data: agency, message: 'Agency verification rejected.' });
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
