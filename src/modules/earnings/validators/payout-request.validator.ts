import { z } from 'zod';
import { PAYOUT_OWNER_TYPES, PAYOUT_REQUEST_STATUSES } from '../models/payout-request.model';

export const ListPayoutRequestsQuerySchema = z.object({
  /**
   * Derived from the model, for the same reason `ownerType` below is: this list grew by
   * two when gateway transfers landed (`processing`, `failed`), and a hand-typed copy would
   * have made a payout stuck mid-transfer the one thing an administrator could not filter
   * for — precisely the row they most need to find.
   */
  status: z.enum(PAYOUT_REQUEST_STATUSES).optional(),
  /**
   * `agent` belongs here and was missing.
   *
   * `PayoutRequest.owner_type` has accepted `'vendor' | 'agency' | 'agent'` since the
   * agent earnings surface shipped, and agents do open payout requests. This filter
   * stopped at the first two, so `?ownerType=agent` was a 400 and the only way to see
   * an agent's payout was to page the unfiltered queue until it appeared. Derived from
   * the model's own list rather than retyped, so the two cannot drift again.
   */
  ownerType: z.enum(PAYOUT_OWNER_TYPES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListPayoutRequestsQuery = z.infer<typeof ListPayoutRequestsQuerySchema>;

export const MarkPaidSchema = z.object({
  reference: z.string().trim().min(1).max(200).optional(),
});

export type MarkPaidDto = z.infer<typeof MarkPaidSchema>;

export const RejectPayoutSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(500),
});

export type RejectPayoutDto = z.infer<typeof RejectPayoutSchema>;

/**
 * An administrator decides a transfer nobody can ask about (`processing`, outcome unknown).
 *
 * `.strict()`: the outcome is the whole decision, and a misspelt key must be a 400 rather than
 * a stripped field. `reason` is required — it lands on the ticket and, for `failed`, as the
 * payout's `transfer_failure_reason`. `evidence` is what the decision rests on (a statement
 * line, a provider support reply) and travels with it.
 */
export const ResolveUnknownTransferSchema = z.object({
  outcome: z.enum(['paid', 'failed']),
  reason: z.string().trim().min(10, 'Say why — at least 10 characters').max(500),
  evidence: z.string().trim().min(1).max(500).optional(),
}).strict();

export type ResolveUnknownTransferDto = z.infer<typeof ResolveUnknownTransferSchema>;

/**
 * A tier-3 endorsement.
 *
 * ⚠ There is no `reject` verdict here. A triage rejection is an ordinary
 * `POST .../reject` with `RejectPayoutSchema` — terminal, releasing the hold, recorded as a
 * status. Offering "reject" as a verdict on this route would have produced a second way to
 * close a payout that wrote a different set of fields.
 */
export const TriagePayoutSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
});

export type TriagePayoutDto = z.infer<typeof TriagePayoutSchema>;
