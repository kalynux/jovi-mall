import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { TicketReferenceService, ReferencePagination } from '../services/ticket-reference.service';

const referenceService = new TicketReferenceService();

/**
 * Parse cheap pagination from the query string. Capped at 50 to keep the
 * reference lookups lightweight.
 */
function parsePagination(req: Request): ReferencePagination {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const rawLimit = parseInt(String(req.query.limit ?? '20'), 10) || 20;
    const limit = Math.min(50, Math.max(1, rawLimit));
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
    return { page, limit, q };
}

/**
 * TicketReferenceController
 *
 * Read-only lookups for the ticket-creation form. Scoping is derived from the
 * authenticated role; the same handlers are mounted under every role's ticket
 * namespace.
 */
export class TicketReferenceController {
    /** GET /api/<role>/tickets/reference/orders */
    static listOrders = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const role = req.auth!.role;
        const roleEntityId = req.auth!.role_entity._id.toString();

        const result = await referenceService.listOrders(role, roleEntityId, parsePagination(req));

        res.json({ success: true, ...result });
    });

    /** GET /api/<role>/tickets/reference/products */
    static listProducts = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const role = req.auth!.role;
        const roleEntityId = req.auth!.role_entity._id.toString();

        const result = await referenceService.listProducts(role, roleEntityId, parsePagination(req));

        res.json({ success: true, ...result });
    });
}
