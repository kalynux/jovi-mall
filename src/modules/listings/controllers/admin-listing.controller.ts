import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { listingReviewService } from '../domain/services/listing-review.service';
import {
  AdminApproveSchema,
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
}
