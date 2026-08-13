import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { payoutRequestService } from '../services/payout-request.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { toAdminPayoutRequestDto } from '../dto/admin-payout-request.dto';
import {
  ListPayoutRequestsQuerySchema,
  MarkPaidSchema,
  RejectPayoutSchema,
} from '../validators/payout-request.validator';

/**
 * Admin queue for processing payout requests. Mounted at `/api/admin` →
 * `/admin/payout-requests`, and at `/api/internal/admin/payout-requests` for wi-admin.
 *
 * ── Every response here goes through `toAdminPayoutRequestDto` ────────────────
 * `payout_method_snapshot` holds the beneficiary's plaintext mobile-money number or
 * bank account number. Returning the document — which this controller used to do,
 * via `r.toObject()` on the list and the raw model on the other three — put that on
 * the wire. The DTO masks it to the last four digits and is the only shape these
 * endpoints emit; the full value lives behind wi-admin's own audited disclosure
 * endpoint. Do not add a path here that returns the model.
 */
export class AdminPayoutRequestsController {
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = ListPayoutRequestsQuerySchema.parse(req.query);
    const result = await payoutRequestService.list(
      { status: query.status, ownerType: query.ownerType },
      { page: query.page, limit: query.limit }
    );
    // `sendSuccess`, not `sendPaginated`: this endpoint's meta says `totalPages` where
    // `PaginationMeta` says `pages`, and a live dashboard reads the former. The envelope
    // is the standard one either way — only the page-count key differs, and renaming it
    // is a wire break that does not belong in a security fix.
    sendSuccess(res, result.data, { meta: result.meta });
  });

  static getById = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const payoutRequest = await payoutRequestService.getByIdForAdmin(req.params.id);
    if (!payoutRequest) {
      return next(createAppError(ERROR_CODES.EARNINGS_PAYOUT_REQUEST_NOT_FOUND, 404));
    }
    sendSuccess(res, payoutRequest);
  });

  static markPaid = asyncHandler(async (req: Request, res: Response) => {
    const validated = MarkPaidSchema.parse(req.body);

    const payoutRequest = await payoutRequestService.markPaid(
      req.params.id,
      actorFromRequest(req),
      validated.reference ?? null
    );

    // The owner name is not re-resolved on a write: the operator is looking at the row
    // they just acted on, and a second batch of lookups to relabel it would be a query
    // per resolution for a field the list already gave them.
    sendSuccess(res, toAdminPayoutRequestDto(payoutRequest, null), {
      message: 'Payout marked paid.',
    });
  });

  static reject = asyncHandler(async (req: Request, res: Response) => {
    const validated = RejectPayoutSchema.parse(req.body);

    const payoutRequest = await payoutRequestService.reject(
      req.params.id,
      actorFromRequest(req),
      validated.reason
    );

    sendSuccess(res, toAdminPayoutRequestDto(payoutRequest, null), {
      message: 'Payout request rejected.',
    });
  });
}
