import { z } from 'zod';
import { REFUND_SOURCE_KINDS, RefundSourceKind } from '../models/refund-request.model';
import { REFUND_REASON_KINDS, RefundReasonKind } from '../domain/refund-attribution';

/**
 * Bodies of `/api/internal/admin/refunds/*` (REFUND-FLOW-PLAN § 11.7). Every object is
 * `.strict()`: an unknown key is a 400, never a silently stripped field — on a surface that moves
 * money, a misspelt `aproveNow` must not quietly mean "no".
 *
 * Optional keys are OMITTED by wi-admin, not sent as null, so none of them accepts null.
 */

const objectId = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');
const sourceKind = z.enum(REFUND_SOURCE_KINDS as unknown as [RefundSourceKind, ...RefundSourceKind[]]);
const reasonKind = z.enum(REFUND_REASON_KINDS as unknown as [RefundReasonKind, ...RefundReasonKind[]]);

export const AdminCreateRefundRequestSchema = z
  .object({
    sourceKind,
    sourceId: objectId,
    /** GROSS, whole currency units. Absent = the most the attribution and the money allow. */
    amount: z.number().int().positive().optional(),
    reasonKind,
    /** Required for administrators and Support (§ 3.1). */
    reason: z.string().trim().min(1, 'A reason is required').max(1000),
    itemDefective: z.boolean().optional(),
    /** Confirms going past the vendor's return policy (`overrides[]` on the eligibility read). */
    overridePolicy: z.boolean().optional(),
    /** A TYPED number (R-7). Requires `destinationProofFileId` and a second approver. */
    destination: z
      .object({
        phone: z.string().trim().min(4).max(32),
        name: z.string().trim().max(120).optional(),
      })
      .strict()
      .optional(),
    /** A file id from `POST /proofs` (the `refund-proofs` tree). */
    destinationProofFileId: objectId.optional(),
    requestedByRole: z.enum(['admin', 'support']),
    /** Honoured only for `admin` AND an untyped destination (`mayApproveAtCreation`). */
    approveNow: z.boolean().optional(),
    /** The support ticket the request was raised from, when there is one. */
    ticketId: objectId.optional(),
  })
  .strict();

export const AdminApproveRefundSchema = z.object({}).strict();
export const AdminRetryRefundSchema = z.object({}).strict();

export const AdminRejectRefundSchema = z
  .object({ reason: z.string().trim().min(1, 'A reason is required').max(1000) })
  .strict();

export const AdminSettleExternalRefundSchema = z
  .object({
    method: z.enum(['mobile_money', 'cash', 'bank', 'other']),
    reference: z.string().trim().max(200).optional(),
    /** REQUIRED (R-7b): a file id from `POST /proofs`. */
    proofFileId: objectId,
  })
  .strict();

export const AdminResolveUnknownRefundSchema = z
  .object({
    outcome: z.enum(['arrived', 'failed']),
    note: z.string().trim().min(1, 'A note is required').max(1000),
  })
  .strict();

/** Query strings are strings: `itemDefective=true`, `amount=5000`. */
export const AdminRefundEligibilityQuerySchema = z
  .object({
    sourceKind,
    sourceId: objectId,
    reasonKind: reasonKind.optional(),
    itemDefective: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    amount: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const RefundRequestIdParamSchema = z.object({ id: z.string().trim().min(1) }).strict();
export const RefundProofIdParamSchema = z.object({ fileId: objectId }).strict();

export type AdminCreateRefundRequestBody = z.infer<typeof AdminCreateRefundRequestSchema>;
