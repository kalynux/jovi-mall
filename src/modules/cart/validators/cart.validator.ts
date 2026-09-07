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
  /**
   * A negotiated-price lock, minted by the bargaining agent when a haggle closed.
   *
   * Opaque here on purpose: it is validated by the negotiation module through the
   * `negotiated-price` port, not by a shape rule in this file. All that matters at
   * the edge is that it is a non-empty string somebody presented — a bad one is
   * refused with a `NEGOTIATION_LOCK_*` code the chat can act on, which is more
   * useful than a 400 saying it did not match a regex.
   *
   * ⚠ Presenting one SETS the line to `quantity` rather than incrementing it; the
   * lock is bound to a quantity. See `CartService.addToCart`.
   */
  negotiationLockRef: z.string().trim().min(1).max(200).optional(),
});

export type AddToCartInput = z.infer<typeof AddToCartSchema>;

/** A 24-hex ObjectId, so a malformed id never reaches a query. */
const ObjectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id');

/**
 * `PATCH /items/:variantId` — set an ABSOLUTE quantity.
 *
 * `min(1)`, not `min(0)`: removing a line is `DELETE /items/:variantId`, and letting zero
 * mean "delete" here would put two intentions behind one call. A client that computes its
 * way to zero has a bug, and a 400 surfaces it rather than silently discarding the line.
 *
 * `max(999)` is a sanity bound, not a stock check — stock is enforced at checkout. It
 * exists because nothing else caps this number and `quantity * price` is money.
 */
export const SetCartItemQuantitySchema = z.object({
  quantity: z.coerce.number().int().min(1).max(999),
});

export const CartItemVariantParamSchema = z.object({ variantId: ObjectIdSchema });

/**
 * `POST /merge` — hand an anonymous cart over at sign-in.
 *
 * The array is capped because this body is **client-controlled data from localStorage**,
 * not something the server issued: without a bound, one request could ask the service to
 * resolve an unbounded number of products. 100 lines is far beyond any real cart.
 *
 * Note what is deliberately NOT accepted: a `price`. An anonymous cart carries one for its
 * own display, and trusting it would let a caller name their own price. Every line is
 * re-priced from the catalogue during the merge.
 */
export const MergeCartSchema = z.object({
  items: z
    .array(
      z.object({
        productId: ObjectIdSchema,
        variantId: ObjectIdSchema,
        quantity: z.coerce.number().int().min(1).max(999),
      }),
    )
    .max(100, 'A cart cannot be merged with more than 100 lines'),
  strategy: z.enum(['sum', 'replace', 'keep_server']).default('sum'),
});

export type MergeCartInput = z.infer<typeof MergeCartSchema>;

/**
 * `POST /quote` — price the cart before checking out.
 *
 * `deliveryAddressId` is optional because a shopper can open the cart before choosing one.
 * When supplied it is validated against the same rule checkout applies, so an unusable
 * address surfaces here rather than at the pay button.
 */
export const QuoteCartSchema = z.object({
  deliveryAddressId: ObjectIdSchema.optional(),
});
