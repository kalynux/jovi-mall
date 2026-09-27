import { z } from 'zod';
import { clearable } from '../../../core/validation/zod.helpers';

/** Agent submits the customer's delivery code at handoff. */
export const CollectCashSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'The delivery code is a 6-digit number'),
  /** GPS fix captured by the agent app at submission (fraud evidence). */
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullable()
    .optional(),
  /** Free-form device identifier reported by the agent app. */
  deviceInfo: clearable(z.string().trim().max(300)),
});

export type CollectCashInput = z.infer<typeof CollectCashSchema>;

export const CodPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const ObjectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const AgentDepositStatusSchema = z.enum(['declared', 'confirmed', 'rejected']);
export const AgentDepositRecipientSchema = z.enum(['agency', 'platform']);

/**
 * The agent declares a handover they have made.
 *
 * Parsed from a `multipart/form-data` body (the proof image rides beside it in field
 * `file`), so every value arrives as a string — hence `z.coerce` on the amount. `reference`
 * and `note` are both optional on every route; the proof image is the required evidence
 * and is checked by the controller, since it is not a body field.
 */
export const DeclareDepositSchema = z.object({
  agencyId: ObjectId,
  amount: z.coerce.number().int().positive('Amount must be a positive integer (minor units)'),
  recipient: AgentDepositRecipientSchema.default('agency'),
  reference: clearable(z.string().trim().min(1).max(200)),
  note: clearable(z.string().trim().max(500)),
});

/** Rejecting a declaration always needs a reason — it is half of a dispute. */
export const RejectDepositSchema = z.object({
  reason: z.string().trim().min(1, 'Say why this deposit is being rejected').max(500),
});

/** The agent reports a problem — most usefully, an under-recorded handover. */
export const AgentRaiseDiscrepancySchema = z.object({
  agencyId: ObjectId,
  amount: z.number().int().min(0).nullable().optional().default(null),
  depositId: ObjectId.nullable().optional(),
  note: z.string().trim().min(1, 'Describe what happened').max(500),
});
