import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { payoutRequestService } from '../services/payout-request.service';
import { payoutResolutionService } from '../services/payout-resolution.service';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { actorFromRequest } from '../../../core/types/actor-source.types';
import { toAdminPayoutRequestDto } from '../dto/admin-payout-request.dto';
import {
  ListPayoutRequestsQuerySchema,
  MarkPaidSchema,
  RejectPayoutSchema,
  ResolveUnknownTransferSchema,
  TriagePayoutSchema,
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

  /**
   * Record a reviewer's endorsement. Moves no money and changes no status.
   *
   * ⛔ **This route grants nothing, and jovi-mall must never decide WHO may call it.** The
   * rule that a reviewing tier may endorse but not send lives in wi-admin, which is where
   * the tier actually is. The service token authenticating this call is a full-privilege
   * credential and `X-Actor-Tier` is advisory, so branching on it here would be a check the
   * caller sets for itself. What this side owns is the state machine, and that machine is
   * the same for every caller.
   */
  static triage = asyncHandler(async (req: Request, res: Response) => {
    const validated = TriagePayoutSchema.parse(req.body);

    const payoutRequest = await payoutRequestService.triage(
      req.params.id,
      actorFromRequest(req),
      validated.note ?? null
    );

    sendSuccess(res, toAdminPayoutRequestDto(payoutRequest, null), {
      message: 'Payout request endorsed. Final approval is still required before money moves.',
    });
  });

  /**
   * Send the payout through the payment gateway.
   *
   * Answers with the row in its POST-SUBMIT state, which is normally `processing` and not
   * `paid` — the gateway confirms asynchronously. A client that renders `processing` as
   * success has told somebody their money arrived when it has only been accepted.
   */
  static send = asyncHandler(async (req: Request, res: Response) => {
    const payoutRequest = await payoutRequestService.sendPayout(req.params.id);

    sendSuccess(res, toAdminPayoutRequestDto(payoutRequest, null), {
      message:
        payoutRequest.status === 'paid'
          ? 'Payout sent and confirmed.'
          : payoutRequest.status === 'failed'
            ? 'The gateway refused the transfer. The funds remain held.'
            : 'Payout submitted to the gateway. It is not settled until the gateway confirms it.',
    });
  });

  /**
   * Decide a transfer whose outcome is unknown — `processing`, and nobody can ask the gateway.
   *
   * `paid` settles it exactly as a confirmed transfer does; `failed` parks it in `failed` with
   * the hold kept, ready to retry or reject. Refused unless the payout is `processing` and has
   * been quiet for the reconciliation sweep's MIN_AGE (a callback may still be in flight).
   * Whether the caller may do this — and whether a large `paid` needs a second administrator —
   * is decided in wi-admin, as for every route on this mount.
   */
  static resolveUnknownTransfer = asyncHandler(async (req: Request, res: Response) => {
    const validated = ResolveUnknownTransferSchema.parse(req.body);

    const payoutRequest = await payoutResolutionService.resolveUnknownTransfer(
      req.params.id,
      { outcome: validated.outcome, reason: validated.reason, evidence: validated.evidence ?? null },
      actorFromRequest(req)
    );

    sendSuccess(res, toAdminPayoutRequestDto(payoutRequest, null), {
      message:
        payoutRequest.status === 'paid'
          ? 'Transfer resolved as paid. The payout is settled.'
          : 'Transfer resolved as failed. The funds remain held — retry the transfer or reject the request.',
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
