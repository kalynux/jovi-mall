import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * How a row's quantities came to be.
 *
 * `derived` — the row exists because a product is *configured* to be stored at
 * this depot (`delivery.pickup_location.source === 'agency_storage'`). Its
 * quantities are **not counted** and are zero. This is every row today.
 *
 * `counted` — the quantities reflect real movements (Phase 2: reserve at
 * checkout, settle on delivery/return). Nothing writes this yet.
 *
 * The distinction is on the wire, not just internal: an agency reading a stock
 * screen must be able to tell a roster from a count, and the whole point of
 * shipping Phase 1 separately is that it can honestly say "configured here"
 * without claiming to know how many are on the shelf.
 */
export type StockLevelSource = 'derived' | 'counted';

export interface IAgencyStockLevel extends IBaseDocument {
  agency_id: Types.ObjectId;
  /**
   * Which depot — `magazin.headquarters_addresses[]._id`.
   *
   * **Null means the depot could not be resolved**, not "the primary". A product
   * naming a depot the agency has since deleted lands here, and the inventory
   * screen surfaces it as unassigned so somebody can move it.
   *
   * This is deliberately NOT what `resolveHqAddress` does. That resolver falls
   * back to the primary on a dangling id, which is right when the job is to send
   * an agent *somewhere* — and wrong here, where it would silently attribute one
   * building's stock to another. A product with no depot named at all is a
   * different case: it genuinely is at the primary, and the reconciler resolves
   * it to the primary's id before the row is written.
   */
  location_id: Types.ObjectId | null;
  vendor_id: Types.ObjectId;
  product_id: Types.ObjectId;
  variant_id: Types.ObjectId;

  /** Physically on the shelf. Only Phase 2 writes this; `derived` rows hold 0. */
  quantity_on_hand: number;
  /** Spoken for by an unfulfilled order. Only Phase 2 writes this. */
  quantity_reserved: number;

  source: StockLevelSource;
  /** When the derivation pass last confirmed this row against the catalog. */
  last_reconciled_at: Date;
}

/**
 * What a delivery agency stores, per depot, per SKU.
 *
 * The platform had no such record: `agency_storage` on a product is a *routing*
 * flag ("collect from the agency, not the vendor's shop") carrying no quantity,
 * and `ProductVariant.stock` is one global scalar with no location dimension.
 * This collection is the missing join — and the same record that unblocks
 * `monthly_storage_fee_per_sku`, which is configured at onboarding and has never
 * been charged because nothing knew which SKUs an agency held.
 *
 * ## Why two quantity fields when Phase 1 populates neither
 *
 * Phase 2 wires the (currently dead) `StockReservationService` family as
 * written: stock is decremented at *reservation* time, restored on release, and
 * commit is a bookkeeping flip. That model needs on-hand and reserved as
 * separate counters — it is exactly the split `InventoryAvailabilityCalculator`
 * already computes as `stock - activeReservations`. Adding the second field
 * later means migrating every row; adding it now costs a default of 0.
 *
 * ## Soft-deleted, not hard-deleted
 *
 * The reconciler retires rows a vendor has stopped storing here rather than
 * removing them, so a depot's history survives someone flipping fulfilment mode
 * and back. `BaseRepository` filters `deletedAt: null` on every read.
 */
const AgencyStockLevelSchema = new Schema<IAgencyStockLevel>({
  agency_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.DELIVERY_AGENCY,
    required: true,
  },
  // No `ref`: this points at a SUBDOCUMENT of magazin.headquarters_addresses[],
  // which Mongoose cannot populate — same as the product's agency_address_id.
  location_id: {
    type: Schema.Types.ObjectId,
    default: null,
  },
  vendor_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.VENDOR,
    required: true,
  },
  product_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.PRODUCT,
    required: true,
  },
  variant_id: {
    type: Schema.Types.ObjectId,
    ref: MODELS.PRODUCT_VARIANT,
    required: true,
  },
  quantity_on_hand: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  quantity_reserved: {
    type: Number,
    required: true,
    default: 0,
    min: 0,
  },
  source: {
    type: String,
    enum: ['derived', 'counted'],
    required: true,
    default: 'derived',
  },
  last_reconciled_at: {
    type: Date,
    required: true,
    default: Date.now,
  },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// The natural key: one row per SKU per depot per agency. Partial on
// `deletedAt: null` so retiring a row frees the key — a vendor who stops storing
// a SKU here and later resumes must not collide with their own tombstone.
// `location_id` participates as null for unresolved depots, which Mongo indexes
// as a distinct value, so those rows are still deduped correctly.
AgencyStockLevelSchema.index(
  { agency_id: 1, variant_id: 1, location_id: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);

// The list screen's two filters.
AgencyStockLevelSchema.index({ agency_id: 1, location_id: 1 });
AgencyStockLevelSchema.index({ agency_id: 1, vendor_id: 1 });

// Phase 2's lookup: "this variant just shipped — which depots hold it?"
AgencyStockLevelSchema.index({ variant_id: 1 });

export const AgencyStockLevelModel = model<IAgencyStockLevel>(
  MODELS.AGENCY_STOCK_LEVEL,
  AgencyStockLevelSchema,
  COLLECTIONS.AGENCY_STOCK_LEVEL,
);
