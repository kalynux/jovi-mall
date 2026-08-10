import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { stockRequestService } from '../services/stock-request.service';
import { StockRequestActor } from '../services/stock-request.service';
import { StockRequestParty } from '../models/stock-adjustment-request.model';
import {
  CreateStockRequestSchema,
  RejectStockRequestSchema,
  StockRequestIdParamSchema,
  StockRequestQuerySchema,
} from '../validators/stock-request.validator';

/**
 * Both roles' handlers, from one factory.
 *
 * The two routers are an endpoint-for-endpoint mirror and the service is symmetric,
 * so the only thing that differs is which party the caller is — and that comes from
 * the token, never the path. Writing this twice would be two places for the
 * authority table to be read differently.
 */
const actorOf = (role: StockRequestParty) => (req: Request): StockRequestActor => ({
  role,
  ownerId: req.auth!.role_entity._id.toString(),
  userId: req.auth!.user._id.toString(),
});

export function buildStockRequestController(role: StockRequestParty) {
  const actor = actorOf(role);

  return {
    /** POST / — raise a request. */
    create: asyncHandler(async (req: Request, res: Response) => {
      const input = CreateStockRequestSchema.parse(req.body);
      const request = await stockRequestService.raise(actor(req), input);
      res.status(201).json({ success: true, data: request });
    }),

    /** GET / — this party's inbox. Every status by default. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = StockRequestQuerySchema.parse(req.query);
      const page = await stockRequestService.list(
        actor(req),
        {
          status: query.status,
          productId: query.productId,
          variantId: query.variantId,
          direction: query.direction,
        },
        { page: query.page, limit: query.limit },
      );
      res.json({
        success: true,
        data: page.data,
        // `pages` at the repository layer, `totalPages` on the wire — the existing
        // convention across the connection and contract lists.
        meta: {
          total: page.meta.total,
          page: page.meta.page,
          limit: page.meta.limit,
          totalPages: page.meta.pages,
        },
      });
    }),

    /** GET /:id */
    getById: asyncHandler(async (req: Request, res: Response) => {
      const { id } = StockRequestIdParamSchema.parse(req.params);
      const request = await stockRequestService.getById(actor(req), id);
      res.json({ success: true, data: request });
    }),

    /** POST /:id/approve — counterparty only. Applies the change. */
    approve: asyncHandler(async (req: Request, res: Response) => {
      const { id } = StockRequestIdParamSchema.parse(req.params);
      const request = await stockRequestService.approve(actor(req), id);
      res.json({ success: true, data: request });
    }),

    /** POST /:id/reject — counterparty only. */
    reject: asyncHandler(async (req: Request, res: Response) => {
      const { id } = StockRequestIdParamSchema.parse(req.params);
      const { reason } = RejectStockRequestSchema.parse(req.body ?? {});
      const request = await stockRequestService.reject(actor(req), id, reason ?? null);
      res.json({ success: true, data: request });
    }),

    /** POST /:id/withdraw — author only. */
    withdraw: asyncHandler(async (req: Request, res: Response) => {
      const { id } = StockRequestIdParamSchema.parse(req.params);
      const request = await stockRequestService.withdraw(actor(req), id);
      res.json({ success: true, data: request });
    }),
  };
}
