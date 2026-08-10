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

/** Wire sort field → the persisted field it maps to. */
export const INVENTORY_SORT_FIELDS: Record<InventoryQueryInput['sortBy'], string> = {
  createdAt: 'createdAt',
  quantityOnHand: 'quantity_on_hand',
  lastReconciledAt: 'last_reconciled_at',
};
