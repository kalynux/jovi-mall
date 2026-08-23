import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');

/**
 * Query for `GET /api/agency/inventory`.
 *
 * `locationId` takes the literal `unassigned` alongside a depot id — those are
 * the rows whose depot the agency deleted, and they are exactly the ones an
 * agency needs to find and re-home, so they get a first-class filter rather than
 * being reachable only by paging through everything.
 */
export const InventoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  locationId: z.union([objectId, z.literal('unassigned')]).optional(),
  vendorId: objectId.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'quantityOnHand', 'lastReconciledAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
}).strict();

export type InventoryQueryInput = z.infer<typeof InventoryQuerySchema>;

export const StockLevelIdParamSchema = z.object({
  id: objectId,
});

/**
 * The three agency write actions are keyed on the PRODUCT, not the stock row.
 *
 * The depot is named once on `product.delivery.pickup_location` and suspension is a
 * product status, so both act on every row of the product at once. Keying them on a
 * row id would invite the reading that one variant could sit in a different building
 * from its siblings — something the model cannot express.
 */
export const StoredProductIdParamSchema = z.object({
  productId: objectId,
});

/**
 * `null` is a first-class value: it means "track my primary depot", which is a real
 * steady state (`agency_address_id: null` resolves to `headquarters_addresses[0]` and
 * keeps following it if the agency reorders), not a missing choice.
 */
export const ChangeDepotSchema = z.object({
  locationId: objectId.nullable(),
}).strict();

export type ChangeDepotInput = z.infer<typeof ChangeDepotSchema>;

export const SuspendStoredProductSchema = z.object({
  note: z.string().trim().min(1).max(500).optional(),
}).strict();

export type SuspendStoredProductInput = z.infer<typeof SuspendStoredProductSchema>;

/**
 * The counted-stock verbs (Step 14, D-6).
 *
 * These ARE keyed on the stock row, unlike the three product-level actions above, and
 * the reason is the mirror image of theirs: a receipt is a physical event at one shelf.
 * Two variants of one product can genuinely arrive on different days.
 */

/**
 * A positive magnitude. `count_adjustment` is the exception and has its own schema —
 * see below for why the caller sends what they counted rather than a difference.
 */
const movementQuantity = z.coerce.number().int().min(1).max(1_000_000);

export const StockReceiptSchema = z.object({
  quantity: movementQuantity,
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export type StockReceiptInput = z.infer<typeof StockReceiptSchema>;

export const StockReturnToVendorSchema = StockReceiptSchema;
export type StockReturnToVendorInput = StockReceiptInput;

/**
 * `countedQuantity` is what somebody saw on the shelf — an absolute, and 0 is a legitimate
 * answer, so this is the one movement schema whose floor is 0 rather than 1.
 *
 * **The reason is required**, and that is not paperwork: this verb is the only one that can
 * move a counter without a physical event behind it, so the difference between "we
 * miscounted last week" and "a box is missing" exists nowhere else.
 */
export const StockCountAdjustmentSchema = z.object({
  countedQuantity: z.coerce.number().int().min(0).max(1_000_000),
  reason: z.string().trim().min(1).max(500),
}).strict();

export type StockCountAdjustmentInput = z.infer<typeof StockCountAdjustmentSchema>;

/** `null` means the primary depot, exactly as it does on `ChangeDepotSchema`. */
export const StockTransferSchema = z.object({
  toLocationId: objectId.nullable(),
  quantity: movementQuantity,
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export type StockTransferInput = z.infer<typeof StockTransferSchema>;

export const MovementQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export type MovementQueryInput = z.infer<typeof MovementQuerySchema>;
/** Wire sort field → the persisted field it maps to. */
export const INVENTORY_SORT_FIELDS: Record<InventoryQueryInput['sortBy'], string> = {
  createdAt: 'createdAt',
  quantityOnHand: 'quantity_on_hand',
  lastReconciledAt: 'last_reconciled_at',
};
