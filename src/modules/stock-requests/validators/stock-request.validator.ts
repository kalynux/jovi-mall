import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');

/**
 * Raise a request. Symmetric — the same body from either role, because the
 * proposal is the same object whoever makes it; only who may answer differs.
 *
 * `quantity` is the ABSOLUTE target, never a delta (see the model docstring).
 * `isInfiniteStock` is accepted so the ask can be *refused with the right error*
 * rather than dropped by validation: an agency-warehoused SKU may never be
 * unlimited, and a vendor who tries deserves to be told that, not to have the flag
 * silently ignored.
 */
export const CreateStockRequestSchema = z.object({
  productId: objectId,
  variantId: objectId,
  quantity: z.number().int().min(0, 'Quantity must be zero or greater'),
  isInfiniteStock: z.boolean().optional(),
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

export type CreateStockRequestInput = z.infer<typeof CreateStockRequestSchema>;

/** `POST /:id/reject` — an optional explanation for the other side. */
export const RejectStockRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export type RejectStockRequestInput = z.infer<typeof RejectStockRequestSchema>;

/**
 * Inbox query. No status filter is applied by default: both lists return every
 * status, terminal rows included, so a negotiation history is fetchable.
 */
export const StockRequestQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  direction: z.enum(['raised_by_me', 'awaiting_me']).optional(),
}).strict();

export type StockRequestQueryInput = z.infer<typeof StockRequestQuerySchema>;

export const StockRequestIdParamSchema = z.object({
  id: objectId,
});
