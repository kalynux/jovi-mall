import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { agencyInventoryService } from '../services/agency-inventory.service';
import { agencyStoredProductService } from '../services/agency-stored-product.service';
import { agencyStockCountService } from '../services/agency-stock-count.service';
import { toMovementDto } from '../dto/stock-movement.dto';
import {
  ChangeDepotSchema,
  InventoryQuerySchema,
  MovementQuerySchema,
  StockCountAdjustmentSchema,
  StockLevelIdParamSchema,
  StockReceiptSchema,
  StockReturnToVendorSchema,
  StockTransferSchema,
  StoredProductIdParamSchema,
  SuspendStoredProductSchema,
} from '../validators/inventory.validator';

/** The authenticated agency. Identity flows token → agency; no agencyId in routes. */
const selfId = (req: Request): string => req.auth!.role_entity._id.toString();

/**
 * Who is doing the counting, for the movement ledger.
 *
 * The agency scopes the write; the USER is what the audit needs — `role_entity._id` is the
 * agency and would be the same value on every row.
 */
const countActor = (req: Request) => ({
  agencyId: selfId(req),
  userId: req.auth?.user?.id ? String(req.auth.user.id) : null,
});

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
    // Derived from the counts themselves, never a literal (Step 14): the header would
    // otherwise keep claiming `derived` over a magazine an agency has fully counted.
    res.json({
      success: true,
      data: summary,
      countsAreDerived: summary.countedRows === 0,
    });
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

  /**
   * POST /api/agency/inventory/:id/receipts
   *
   * Goods arrived. **This is the verb that makes a row counted** — before the first
   * receipt the platform claims nothing about how much is on the shelf (D-6).
   */
  static recordReceipt = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const body = StockReceiptSchema.parse(req.body ?? {});
    const result = await agencyStockCountService.recordReceipt(countActor(req), id, body);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Stock received.',
    });
  });

  /** POST /api/agency/inventory/:id/returns — goods went back to the vendor. */
  static recordReturnToVendor = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const body = StockReturnToVendorSchema.parse(req.body ?? {});
    const result = await agencyStockCountService.recordReturnToVendor(countActor(req), id, body);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Return to vendor recorded.',
    });
  });

  /**
   * POST /api/agency/inventory/:id/count
   *
   * A physical count. The body carries what was COUNTED, not a difference — the
   * difference is computed server-side inside the transaction that applies it, so a
   * concurrent sale cannot turn a correction into a second error.
   */
  static recordCount = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const body = StockCountAdjustmentSchema.parse(req.body ?? {});
    const result = await agencyStockCountService.recordCountAdjustment(countActor(req), id, body);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Count recorded.',
    });
  });

  /** POST /api/agency/inventory/:id/transfers — same goods, another of your depots. */
  static transfer = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const body = StockTransferSchema.parse(req.body ?? {});
    const result = await agencyStockCountService.transfer(countActor(req), id, body);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Stock transferred.',
    });
  });

  /** GET /api/agency/inventory/:id/movements — one shelf's history, newest first. */
  static listMovements = asyncHandler(async (req: Request, res: Response) => {
    const { id } = StockLevelIdParamSchema.parse(req.params);
    const { page, limit } = MovementQuerySchema.parse(req.query);
    const { data, total } = await agencyStockCountService.listMovements(selfId(req), id, page, limit);
    res.json({
      success: true,
      data: data.map(toMovementDto),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  });
}
