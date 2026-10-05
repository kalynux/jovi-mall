import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { sendCreated, sendSuccess } from '../../../core/responses';
import { toRefundRequestDto } from '../dto/refund-request.dto';
import { refundRequestService } from '../services/refund-request.service';
import { refundEligibilityService } from '../services/refund-eligibility.service';
import { refundProofService } from '../services/refund-proof.service';
import {
  AdminApproveRefundSchema,
  AdminCreateRefundRequestSchema,
  AdminRefundEligibilityQuerySchema,
  AdminRejectRefundSchema,
  AdminResolveUnknownRefundSchema,
  AdminRetryRefundSchema,
  AdminSettleExternalRefundSchema,
  RefundProofIdParamSchema,
  RefundRequestIdParamSchema,
} from '../validators/admin-refund-request.validator';

/**
 * `/api/internal/admin/refunds/*` — the refund queue's WRITES, called by wi-admin
 * (REFUND-FLOW-PLAN § 7, § 11.7). wi-admin reads `refund_requests` directly; every verb here is a
 * transition with post-commit effects (earnings pause / clawback, a gateway transfer, the
 * customer's notification), which is why it is delegated rather than written there.
 *
 * Authorization (who may approve, the four-eyes threshold, the Support/admin split) is decided in
 * wi-admin before the call — this service re-checks only what it can see itself: the
 * second-approver rule for a TYPED number (the requester's and the approver's `X-Actor-Id`), and
 * that a Support-raised request never approves at creation.
 *
 * Nothing is audited on this side: `X-Actor-Id` is a header the token holder sets. wi-admin audits
 * every write fail-closed, where the human is known (ADR-020 D-5).
 */

function actorOf(req: Request): { id: string; name: string } {
  const actor = adminCallerActor(req);
  if (!actor) {
    throw createAppError(ERROR_CODES.AUTH_ADMIN_CALLER_ACTOR_MISSING, 400, 'X-Actor-Id must be present and a valid administrator id');
  }
  return { id: actor.id, name: actor.name };
}

export class AdminRefundRequestController {
  /** GET /eligibility?sourceKind=&sourceId=[&reasonKind=&itemDefective=&amount=] */
  static eligibility = asyncHandler(async (req: Request, res: Response) => {
    const query = AdminRefundEligibilityQuerySchema.parse(req.query);
    sendSuccess(res, await refundEligibilityService.preview(query));
  });

  /** POST / — open a request (Support: always `awaiting_approval`). */
  static create = asyncHandler(async (req: Request, res: Response) => {
    const body = AdminCreateRefundRequestSchema.parse(req.body);
    const actor = actorOf(req);

    // A typed number's proof must be a REFUND PROOF — a file in the private `refund-proofs`
    // tree, uploaded through `POST /proofs`. Any other id (a public `by-type` image, a KYC scan)
    // is refused rather than attached to a refund as "evidence".
    if (body.destination && body.destinationProofFileId && !(await refundProofService.isRefundProof(body.destinationProofFileId))) {
      throw createAppError(
        ERROR_CODES.REFUND_DESTINATION_PROOF_REQUIRED,
        422,
        'The proof must be a picture uploaded through the refund proof upload',
        { reason: 'proof_not_found' }
      );
    }

    // The vendor's commercial gates (orders only): going past them must be deliberate.
    const overrides = await refundEligibilityService.policyOverridesFor({
      kind: body.sourceKind,
      sourceId: body.sourceId,
      amount: body.amount,
      reasonKind: body.reasonKind,
      itemDefective: body.itemDefective ?? null,
    });
    if (overrides.length > 0 && body.overridePolicy !== true) {
      throw createAppError(
        ERROR_CODES.REFUND_POLICY_OVERRIDE_REQUIRED,
        422,
        'This refund goes beyond the vendor’s return policy. Confirm the override to proceed.',
        { overrides }
      );
    }

    const row = await refundRequestService.create({
      source: { kind: body.sourceKind, id: body.sourceId },
      amount: body.amount,
      reasonKind: body.reasonKind,
      reason: body.reason,
      itemDefective: body.itemDefective ?? null,
      overridePolicy: body.overridePolicy === true,
      destination: body.destination ? { phone: body.destination.phone, name: body.destination.name ?? null } : null,
      destinationProofFileId: body.destinationProofFileId ?? null,
      // `requested_by.id` is the wi-admin administrator id: the approve verb compares it with
      // the approver's for the second-approver rule (R-7).
      requestedBy: { id: actor.id, role: body.requestedByRole, name: actor.name },
      // ⛔ Support may hold, never send — refused here as well as in `mayApproveAtCreation`.
      approveNow: body.requestedByRole === 'admin' && body.approveNow === true,
      ticketId: body.ticketId ?? null,
    });
    sendCreated(res, toRefundRequestDto(row));
  });

  /** POST /:id/approve `{}` */
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const { id } = RefundRequestIdParamSchema.parse(req.params);
    AdminApproveRefundSchema.parse(req.body ?? {});
    const row = await refundRequestService.approve(id, actorOf(req));
    sendSuccess(res, toRefundRequestDto(row));
  });

  /** POST /:id/reject `{ reason }` */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const { id } = RefundRequestIdParamSchema.parse(req.params);
    const { reason } = AdminRejectRefundSchema.parse(req.body);
    const row = await refundRequestService.reject(id, actorOf(req), reason);
    sendSuccess(res, toRefundRequestDto(row));
  });

  /** POST /:id/retry `{}` */
  static retry = asyncHandler(async (req: Request, res: Response) => {
    const { id } = RefundRequestIdParamSchema.parse(req.params);
    AdminRetryRefundSchema.parse(req.body ?? {});
    actorOf(req);
    const row = await refundRequestService.retry(id);
    sendSuccess(res, toRefundRequestDto(row));
  });

  /** POST /:id/settle-external `{ method, reference?, proofFileId }` */
  static settleExternal = asyncHandler(async (req: Request, res: Response) => {
    const { id } = RefundRequestIdParamSchema.parse(req.params);
    const body = AdminSettleExternalRefundSchema.parse(req.body);
    const actor = actorOf(req);
    if (!(await refundProofService.isRefundProof(body.proofFileId))) {
      throw createAppError(
        ERROR_CODES.REFUND_EXTERNAL_PROOF_REQUIRED,
        422,
        'The proof must be a picture uploaded through the refund proof upload',
        { reason: 'proof_not_found' }
      );
    }
    const row = await refundRequestService.settleExternal(
      id,
      { method: body.method, reference: body.reference ?? null, proofFileId: body.proofFileId },
      actor
    );
    sendSuccess(res, toRefundRequestDto(row));
  });

  /** POST /:id/resolve-unknown `{ outcome, note }` */
  static resolveUnknown = asyncHandler(async (req: Request, res: Response) => {
    const { id } = RefundRequestIdParamSchema.parse(req.params);
    const body = AdminResolveUnknownRefundSchema.parse(req.body);
    const row = await refundRequestService.resolveUnknown(id, body, actorOf(req));
    sendSuccess(res, toRefundRequestDto(row));
  });

  /** POST /proofs — multipart field `file`, ONE image (jpeg/png/webp) or PDF → `{ fileId }`. */
  static uploadProof = asyncHandler(async (req: Request, res: Response) => {
    const actor = actorOf(req);
    const file = req.file;
    if (!file) {
      throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Attach one file under the field name "file"');
    }
    const data = await refundProofService.upload(actor.id, {
      buffer: file.buffer,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });
    sendCreated(res, data);
  });

  /** GET /proofs/:fileId — the bytes; 404 for anything outside `refund-proofs/`. */
  static streamProof = asyncHandler(async (req: Request, res: Response) => {
    const { fileId } = RefundProofIdParamSchema.parse(req.params);
    const proof = await refundProofService.stream(fileId);
    res.setHeader('Content-Type', proof.mimeType);
    res.setHeader('Content-Length', String(proof.size));
    // `originalName` is uploader-supplied: quotes and control characters stripped (header injection).
    res.setHeader('Content-Disposition', `inline; filename="${proof.filename.replace(/["\\\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    proof.stream.pipe(res);
  });
}
