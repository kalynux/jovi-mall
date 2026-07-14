import { z } from 'zod';

export const ListPayoutRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'paid', 'rejected']).optional(),
  ownerType: z.enum(['vendor', 'agency']).optional(),
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
