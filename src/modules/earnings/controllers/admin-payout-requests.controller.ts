import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { payoutRequestService } from '../services/payout-request.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import {
  ListPayoutRequestsQuerySchema,
  MarkPaidSchema,
  RejectPayoutSchema,
} from '../validators/payout-request.validator';

/**
 * Admin queue for processing payout requests. Mounted at `/api/admin` →
 * `/admin/payout-requests`.
 */
export class AdminPayoutRequestsController {
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = ListPayoutRequestsQuerySchema.parse(req.query);
    const result = await payoutRequestService.list(
      { status: query.status, ownerType: query.ownerType },
      { page: query.page, limit: query.limit }
    );
    res.status(200).json({ success: true, data: result.data, meta: result.meta });
  });

  static getById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const payoutRequest = await payoutRequestService.getById(req.params.id);
    if (!payoutRequest) {
      return next(createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND, 404));
    }
    res.status(200).json({ success: true, data: payoutRequest });
  });

  static markPaid = asyncHandler(async (req: Request, res: Response) => {
    const validated = MarkPaidSchema.parse(req.body);
    const adminUserId = req.auth!.user.id;

    const payoutRequest = await payoutRequestService.markPaid(
      req.params.id,
      adminUserId,
      validated.reference ?? null
    );

    res.status(200).json({ success: true, data: payoutRequest });
  });

  static reject = asyncHandler(async (req: Request, res: Response) => {
    const validated = RejectPayoutSchema.parse(req.body);
    const adminUserId = req.auth!.user.id;

    const payoutRequest = await payoutRequestService.reject(req.params.id, adminUserId, validated.reason);

    res.status(200).json({ success: true, data: payoutRequest });
  });
}
