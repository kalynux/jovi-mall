import { z } from 'zod';

/**
 * Request validators for the customer cart endpoints.
 *
 * The cart is variant-first: adding an item requires both the product and the
 * specific variant (the sellable unit). A cart may hold items from multiple
 * vendors but only ONE product type (physical OR digital) — those business rules
 * are enforced in CartService, not here.
 */
export const AddToCartSchema = z.object({
  productId: z.string().min(1, 'productId is required'),
  variantId: z.string().min(1, 'variantId is required'),
  quantity: z.coerce.number().int().min(1).default(1),
  currency: z.string().min(1).optional(),
});

export type AddToCartInput = z.infer<typeof AddToCartSchema>;
