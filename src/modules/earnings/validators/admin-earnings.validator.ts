import { z } from 'zod';
import { PAYOUT_OWNER_TYPES } from '../models/payout-request.model';

/**
 * Query and param schemas for the admin earnings surface.
 *
 * The owner vocabulary is `PAYOUT_OWNER_TYPES`, not `EarningsOwnerType`, on every
 * shape here — `platform` is excluded deliberately. The singleton commission account
 * has its own endpoint (`/earnings/platform`) because it answers a different question:
 * what the marketplace earned, not what it owes somebody. Letting `platform` through
 * `:ownerType` would give two routes to one account and put "what we keep" into a
 * ranking of "what we owe", where the biggest row would mean the opposite of the rest.
 */

const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const ListEarningsAccountsQuerySchema = z.object({
  ownerType: z.enum(PAYOUT_OWNER_TYPES).optional(),
  ...paginationFields,
});

export type ListEarningsAccountsQuery = z.infer<typeof ListEarningsAccountsQuerySchema>;

export const LedgerQuerySchema = z.object(paginationFields);

export const OwnerParamsSchema = z.object({
  ownerType: z.enum(PAYOUT_OWNER_TYPES),
  ownerId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id'),
});

export type OwnerParams = z.infer<typeof OwnerParamsSchema>;

/** `/pauses/:kind/:id` — the order or booking whose earnings are paused or resumed. */
export const PauseTargetParamsSchema = z.object({
  kind: z.enum(['order', 'booking']),
  id: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id'),
});

/**
 * Pausing by hand. A reason is REQUIRED: it is what the next administrator reads when they
 * decide whether to resume, and a pause nobody can explain is a pause nobody dares lift.
 */
export const PauseEarningsBodySchema = z
  .object({ note: z.string().trim().min(3).max(500) })
  .strict();

export const ResumeEarningsBodySchema = z
  .object({ note: z.string().trim().min(1).max(500).optional() })
  .strict();

export const ListPausesQuerySchema = z.object({
  kind: z.enum(['order', 'booking']).optional(),
  ...paginationFields,
});

export type ListPausesQuery = z.infer<typeof ListPausesQuerySchema>;

/** `GET /clawbacks` — owners who owe money back (REFUND-FLOW-PLAN § 6.4). */
export const ListClawbacksQuerySchema = z.object({
  ownerType: z.enum(PAYOUT_OWNER_TYPES).optional(),
  ...paginationFields,
});

/**
 * `POST /clawbacks/:ownerType/:ownerId/write-off` — forgive (part of) an owner's refund debt
 * (C-6). A whole, positive amount, at most what they owe (checked against the live balance,
 * 409 `EARNINGS_CLAWBACK_WRITE_OFF_EXCEEDS_DEBT`). The reason is required: it is the record.
 * Four-eyes at ≥ 2,000,000 is wi-admin's (`money.earnings.clawback.write_off`).
 */
export const WriteOffClawbackBodySchema = z
  .object({
    amount: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const OrderIdParamsSchema = z.object({
  orderId: z.string().trim().regex(/^[a-f\d]{24}$/i, 'Not a valid id'),
});
