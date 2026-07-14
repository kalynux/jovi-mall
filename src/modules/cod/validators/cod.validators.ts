import { z } from 'zod';

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
  deviceInfo: z.string().trim().max(300).nullable().optional(),
});

export type CollectCashInput = z.infer<typeof CollectCashSchema>;

export const CodPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
