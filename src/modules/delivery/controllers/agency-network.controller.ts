import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agencyNetworkService } from '../services/agency-network.service';

const PaginationQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Agency Network Controller
 *
 * Read-only views of the vendors/products connected to this agency
 * (requirements #7, #8). The agency cannot change either relationship — both
 * are configured on the vendor side.
 */
export class AgencyNetworkController {
    /** GET /api/agency/vendors */
    static listVendors = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const { page, limit } = PaginationQuerySchema.parse(req.query);

        const result = await agencyNetworkService.listVendorsUsingAsDefault(agencyId, { page, limit });

        res.json({ success: true, data: result.data, meta: result.meta });
    });

    /** GET /api/agency/products */
    static listProducts = asyncHandler(async (req: Request, res: Response) => {
        const agencyId = req.auth!.role_entity._id.toString();
        const { page, limit } = PaginationQuerySchema.parse(req.query);

        const result = await agencyNetworkService.listDeliverableProducts(agencyId, { page, limit });

        res.json({ success: true, data: result.data, meta: result.meta });
    });
}
