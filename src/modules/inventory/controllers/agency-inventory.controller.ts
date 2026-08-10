import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agencyInventoryService } from '../services/agency-inventory.service';
import { agencyStoredProductService } from '../services/agency-stored-product.service';
import {
  ChangeDepotSchema,
  InventoryQuerySchema,
  StockLevelIdParamSchema,
  StoredProductIdParamSchema,
  SuspendStoredProductSchema,
} from '../validators/inventory.validator';

/** The authenticated agency. Identity flows token → agency; no agencyId in routes. */
const selfId = (req: Request): string => req.auth!.role_entity._id.toString();

export class AgencyInventoryController {
  /** GET /api/agency/inventory */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = InventoryQuerySchema.parse(req.query);
    const result = await agencyInventoryService.list(selfId(req), query);
    res.json({
      success: true,
      data: result.data,
      meta: result.meta,
      countsAreDerived: result.countsAreDerived,
    });
  });

  /**
   * GET /api/agency/inventory/summary
   *
   * Takes the same filters as the list, and totals the WHOLE filtered set — a header
   * that only added up the visible page would be worse than no total.
   */
  static summary = asyncHandler(async (req: Request, res: Response) => {
    const query = InventoryQuerySchema.parse(req.query);
    const summary = await agencyInventoryService.summary(selfId(req), query);
    res.json({ success: true, data: summary, countsAreDerived: true });
  });

  /** GET /api/agency/inventory/:id */
  static getById = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const detail = await agencyInventoryService.getById(selfId(req), id);
    res.json({ success: true, data: detail });
  });

  /**
   * PATCH /api/agency/inventory/products/:productId/depot
   *
   * Applies immediately — the depot is the agency's own record. `locationId: null`
   * means "my primary depot".
   */
  static changeDepot = asyncHandler(async (req: Request, res: Response) => {
    const { productId } = StoredProductIdParamSchema.parse(req.params);
    const { locationId } = ChangeDepotSchema.parse(req.body);
    const result = await agencyStoredProductService.changeDepot(selfId(req), productId, locationId);
    res.json({
      success: true,
      data: result,
      message: 'Pickup depot updated. The vendor has been notified.',
    });
  });

  /** POST /api/agency/inventory/products/:productId/suspend */
  static suspend = asyncHandler(async (req: Request, res: Response) => {
    const { productId } = StoredProductIdParamSchema.parse(req.params);
    const { note } = SuspendStoredProductSchema.parse(req.body ?? {});
    const result = await agencyStoredProductService.suspend(selfId(req), productId, note ?? null);
    res.json({
      success: true,
      data: result,
      message: 'Product suspended. It is no longer available to customers.',
    });
  });

  /** POST /api/agency/inventory/products/:productId/unsuspend */
  static unsuspend = asyncHandler(async (req: Request, res: Response) => {
    const { productId } = StoredProductIdParamSchema.parse(req.params);
    const result = await agencyStoredProductService.unsuspend(selfId(req), productId);
    res.json({
      success: true,
      data: result,
      message: 'Product restored.',
    });
  });
}
