import { z } from 'zod';
import { PAYOUT_OWNER_TYPES } from '../models/payout-request.model';

export const ListPayoutRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'paid', 'rejected']).optional(),
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
