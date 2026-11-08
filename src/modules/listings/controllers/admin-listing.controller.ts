import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { listingReviewService } from '../domain/services/listing-review.service';
import { listingReportAdminService } from '../domain/services/listing-report-admin.service';
import {
  AdminApproveSchema,
  AdminBlockCustomerSchema,
  AdminLiftBlockSchema,
  AdminRefundRevealSchema,
  RevealBlockParamsSchema,
  RevealIdParamSchema,
  AdminRejectSchema,
  AdminSuspendSchema,
  AdminUnsuspendSchema,
  ListingIdParamSchema,
} from '../validators/listing.validator';

/**
 * The administrator's listing decisions — `/api/internal/admin/listings/:id/{approve,reject,
 * suspend,unsuspend}` (SERVICE-LISTINGS-PLAN § C-3). wi-admin authorises and audits before it
 * calls; the actor stamp comes from the synthesised `req.auth` (`requireAdminCaller`), so every
 * decision records `*_source: 'admin'` and the administrator's name snapshot.
 */
export class AdminListingController {
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    AdminApproveSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReviewService.approve(id, actorFromRequest(req)) });
  });

  static reject = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    const { reasons } = AdminRejectSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReviewService.reject(id, reasons, actorFromRequest(req)) });
  });

  static suspend = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    const { note } = AdminSuspendSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReviewService.suspend(id, note, actorFromRequest(req)) });
  });

  static unsuspend = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ListingIdParamSchema.parse(req.params);
    AdminUnsuspendSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReviewService.unsuspend(id, actorFromRequest(req)) });
  });

  // ─── Lead reports (L-25, L-29, L-31 — step 7) ─────────────────────────────

  /** POST /api/internal/admin/listing-reveals/:revealId/refund `{ ticketId?, note }` */
  static refundReveal = asyncHandler(async (req: Request, res: Response) => {
    const { revealId } = RevealIdParamSchema.parse(req.params);
    const body = AdminRefundRevealSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReportAdminService.refundReveal(revealId, body, actorFromRequest(req)) });
  });

  /** POST /api/internal/admin/listings/:id/reveal-blocks/:customerId `{ reason, ticketId? }` */
  static blockCustomer = asyncHandler(async (req: Request, res: Response) => {
    const { id, customerId } = RevealBlockParamsSchema.parse(req.params);
    const body = AdminBlockCustomerSchema.parse(req.body ?? {});
    res.status(201).json({ success: true, data: await listingReportAdminService.blockCustomer(id, customerId, body, actorFromRequest(req)) });
  });

  /** DELETE /api/internal/admin/listings/:id/reveal-blocks/:customerId `{ note? }` */
  static liftBlock = asyncHandler(async (req: Request, res: Response) => {
    const { id, customerId } = RevealBlockParamsSchema.parse(req.params);
    const { note } = AdminLiftBlockSchema.parse(req.body ?? {});
    res.json({ success: true, data: await listingReportAdminService.liftBlock(id, customerId, note ?? null, actorFromRequest(req)) });
  });
}
