import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export type ProductType = 'physical' | 'digital' | 'service';
export type ProductStatus = 'draft' | 'active' | 'archived' | 'pending_review' | 'suspended';
export type BookingMode = 'calendar' | 'manual' | 'capacity';

/**
 * AUTHORING mode — which editor owns this product. Not to be confused with
 * `BookingMode` above (that one is scheduling, and lives on the service variant).
 *
 * `simple` is a locked shape for vendors who just want to list one thing at one
 * price: physical, exactly ONE variant, ZERO options, and that variant is always
 * `defaultVariantId`. The advanced endpoints refuse to add a second variant or an
 * option to it (CATALOG_PRODUCT_SIMPLE_MODE_LOCKED) so the shape stays true, and
 * `POST /:id/convert-to-advanced` unlocks them — one-way, since a product with
 * many variants cannot collapse back into one.
 *
 * `advanced` is everything the platform did before this field existed, which is
 * why it is the default: documents written before this field have no `mode` key
 * at all, and every read path coerces `?? 'advanced'`. No migration needed.
 */
export type ProductMode = 'simple' | 'advanced';
export type VectorisationStatus = 'not_started' | 'pending' | 'completed' | 'failed' | 'skipped_no_credits';

/**
 * Reason a product was suspended. Scopes which suspended products a given
 * restoration cascade is allowed to touch — other reasons must be left alone.
 *
 * The first three are **system** cascades driven by a broken delivery agency
 * (see ProductDeliveryAgencySuspensionService). `agency_storage_suspended` is the
 * odd one out and deliberately so: it is a **human** act by the agency that
 * warehouses the product — its lever when storage rent goes unpaid — so nothing
 * automatic may ever clear it. The delivery-agency cascade's restore paths are
 * scoped to `DELIVERY_AGENCY_REASONS`, which is what keeps the two apart; do not
 * widen that list.
 *
 * The last two arrive with wi-admin's vendor management and follow the same rule
 * from the other side — each is scoped to the sweep that created it, and **neither
 * belongs to `DELIVERY_AGENCY_REASONS`**, so no delivery-agency restore can lift
 * either one:
 *
 *   `vendor_suspended`   the vendor-level cascade. A system act, reversible by the
 *                        matching vendor restore and by nothing else.
 *   `platform_oversight` one listing taken down by an administrator. A human act, so
 *                        — exactly like `agency_storage_suspended` — nothing automatic
 *                        may clear it, INCLUDING the vendor restore. Only the
 *                        administrator's own restore endpoint lifts it.
 *
 * That last exclusion is the load-bearing one: a vendor suspended and then restored
 * must not silently republish a listing an administrator took down on its merits.
 */
export const PRODUCT_SUSPENSION_REASONS = [
  'default_delivery_agency_removed',
  'product_delivery_agency_removed',
  'agency_connection_paused',
  'agency_storage_suspended',
  'vendor_suspended',
  'platform_oversight',
] as const;

/**
 * Derived from the array above, never hand-maintained beside it — the schema `enum`
 * spreads the same constant. The agent notification stack already paid for the
 * alternative: two copies drifted, and every contract notification threw a
 * ValidationError for a type that was in the union and missing from the enum.
 */
export type ProductSuspensionReason = (typeof PRODUCT_SUSPENSION_REASONS)[number];

/**
 * Snapshot captured when a product is force-suspended, so it can be restored
 * to its exact prior status later (not a hardcoded assumption).
 *
 * `suspendedByAgencyId` + `note` are set only by `agency_storage_suspended`: the
 * agency id is the authorisation check on the way back out (only the agency that
 * suspended may unsuspend), and the note is what the vendor is shown as the
 * reason. Both stay absent on the three system cascades, which have no actor.
 */
export interface ProductSuspension {
  reason: ProductSuspensionReason;
  previousStatus: Exclude<ProductStatus, 'suspended'>;
  suspendedAt: Date;
  suspendedByAgencyId?: Types.ObjectId | null;
  note?: string | null;
}

export interface DigitalConfig {
  // Product-wide download kill switch. Per-variant asset/maxDownloads/expiresAfterDays
  // live on ProductVariant.digitalConfig. When false, no entitlements are granted
  // for any variant of this product, regardless of variant state.
  isActive: boolean;
}

export type PickupLocationSource = 'vendor_address' | 'agency_storage';

/**
 * Where the resolved delivery agency should collect this product from.
 * `vendor_address` points at one of the vendor's own `business_addresses[]`
 * (requires the effective agency's `policies.pricing.pickup_based.enabled`).
 * `agency_storage` means the agency already warehouses this vendor's stock
 * (requires `policies.pricing.storage_based.enabled`); `vendor_address_id` is
 * always null in that case. See PickupLocationValidationService.
 *
 * Exactly one of the two ids is meaningful per source; the other is normalised
 * to null by `mergeDeliveryConfig` rather than trusted from the caller.
 *
 * `agency_address_id` names WHICH of the agency's depots
 * (`magazin.headquarters_addresses[]`) warehouses this product. It is optional:
 * **null means the primary depot** (index 0), which is what every product
 * written before the depot picker existed resolves to, and what the auto-derive
 * path still writes. Resolution lives in exactly one place —
 * `resolveHqAddress` (magazin/domain/hq-address.resolver.ts) — so the fallback
 * cannot drift between the readers that route an agent.
 */
export interface PickupLocation {
  source: PickupLocationSource;
  vendor_address_id: Types.ObjectId | null;
  agency_address_id: Types.ObjectId | null;
}

/**
 * Per-product delivery configuration. Only meaningful for physical products.
 * When `agency_id` is null, the order pipeline falls back to the vendor's
 * `default_delivery_agency_id`. If both are unset, the product cannot be
 * activated (see ProductStatusValidationService). `free_delivery` is
 * independent of agency resolution — it's a vendor-set marketing/order flag.
 * `pickup_location` is required to activate a physical product — without it
 * the delivery agency has no way to know where to collect the item from.
 */
export interface DeliveryConfig {
  agency_id: Types.ObjectId | null;
  free_delivery: boolean;
  pickup_location: PickupLocation | null;
}

export interface IProduct extends IBaseDocument {
  vendorId: Types.ObjectId;
  type: ProductType;
  status: ProductStatus;
  /** Authoring mode — see ProductMode. Absent on documents predating the field. */
  mode: ProductMode;

  title: string;
  description: string;
  slug: string;

  category: string;
  tags: string[];

  seo: {
    title?: string;
    description?: string;
  };

  hasVariants: boolean;
  defaultVariantId?: Types.ObjectId;

  fileIds: Types.ObjectId[];  // References to File model

  /**
   * Timestamp of the most recent paid order containing this product. Maintained
   * on payment success (OrderService.handlePaymentSuccess) and back-fillable.
   * Null = never ordered (the file-cleanup inactivity clock falls back to
   * createdAt). Drives product-media detachment. See file-cleanup module.
   */
  lastOrderedAt?: Date | null;

  // Service configuration + pricing now live on the single service variant
  // (ProductVariant.serviceConfig). See vendor-variant.controller.

  // Digital-specific configuration
  digitalConfig?: DigitalConfig;

  // Physical-specific delivery configuration. Read by OrderService.createOrdersFromCart.
  delivery?: DeliveryConfig;

  // System-driven suspension. Null unless status === 'suspended' via a cascade
  // (e.g. vendor's default delivery agency was deactivated). See
  // ProductDeliveryAgencySuspensionService.
  suspension?: ProductSuspension | null;

  // ─── Vectorisation tracking ───────────────────────────────────────────────
  /** Opt-in flag: vendor must explicitly enable vectorisation. Defaults to false. */
  vectorisationEnabled: boolean;
  /** Current pipeline state. Managed exclusively by VectorisationService. */
  vectorisationStatus: VectorisationStatus;
  /** External ID returned by the vectoriser service once completed. Null until then. */
  vectorisedDataId: string | null;
}

const ProductSchema = new Schema<IProduct>({
  vendorId: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true, index: true },
  type: {
    type: String,
    enum: ['physical', 'digital', 'service'],
    required: true
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'archived', 'pending_review', 'suspended'],
    default: 'draft',
    index: true
  },
  // Deliberately NOT indexed: two values is far too low a cardinality for the
  // planner to ever pick a standalone index, and the only realistic query is a
  // vendor-scoped list, which the existing { vendorId } index already serves.
  mode: {
    type: String,
    enum: ['simple', 'advanced'],
    default: 'advanced'
  },

  title: { type: String, required: true },
  description: { type: String, default: '' },
  slug: { type: String, required: true }, // Composite index with vendorId below

  category: { type: String, required: true, index: true },
  tags: [{ type: String }],

  seo: {
    title: { type: String },
    description: { type: String }
  },

  hasVariants: { type: Boolean, default: false },
  defaultVariantId: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_VARIANT },

  fileIds: [{ type: Schema.Types.ObjectId, ref: MODELS.FILE }],

  // Last paid-order timestamp (file-cleanup inactivity clock). Indexed for the sweep.
  lastOrderedAt: { type: Date, default: null, index: true },

  // ─── Vectorisation tracking ───────────────────────────────────────────────
  vectorisationEnabled: { type: Boolean, default: false, index: true },
  vectorisationStatus: {
    type: String,
    enum: ['not_started', 'pending', 'completed', 'failed', 'skipped_no_credits'],
    default: 'not_started',
    index: true,
  },
  vectorisedDataId: { type: String, default: null },

  // Service configuration + pricing live on the single service variant
  // (ProductVariant.serviceConfig) — not on the product.

  // Digital-specific configuration (product-wide toggle only).
  // Per-variant asset/maxDownloads/expiresAfterDays live on ProductVariant.digitalConfig.
  digitalConfig: {
    type: {
      isActive: {
        type: Boolean,
        default: true
      },
    },
    required: false,
  },

  // Physical-specific delivery config. Optional — falls back to vendor.default_delivery_agency_id at order time.
  delivery: {
    type: {
      agency_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.DELIVERY_AGENCY,
        default: null,
      },
      free_delivery: {
        type: Boolean,
        default: false,
      },
      // Required to activate a physical product — see ProductStatusValidationService.
      pickup_location: {
        type: {
          source: { type: String, enum: ['vendor_address', 'agency_storage'], required: true },
          // Neither id carries a `ref`: both point at a SUBDOCUMENT of another
          // collection (vendor.business_addresses[] / magazin.headquarters_addresses[]),
          // which Mongoose cannot populate. They are resolved by hand on read.
          vendor_address_id: { type: Schema.Types.ObjectId, default: null },
          // Which agency depot. Null = the primary (headquarters_addresses[0]).
          agency_address_id: { type: Schema.Types.ObjectId, default: null },
        },
        required: false,
        default: null,
      },
    },
    required: false,
    default: undefined,
  },

  // Suspension snapshot. Null unless currently suspended — by a delivery-agency
  // cascade (the first three reasons), by the warehousing agency by hand
  // (`agency_storage_suspended`), by the vendor-level cascade (`vendor_suspended`)
  // or by an administrator on this one listing (`platform_oversight`).
  suspension: {
    type: {
      reason: {
        type: String,
        // Spread from the union's own source of truth — see PRODUCT_SUSPENSION_REASONS.
        enum: [...PRODUCT_SUSPENSION_REASONS],
        required: true,
      },
      previousStatus: {
        type: String,
        enum: ['draft', 'active', 'archived', 'pending_review'],
        required: true,
      },
      suspendedAt: { type: Date, required: true },
      // Set only by `agency_storage_suspended`. No `ref`: resolved by hand, and
      // it is an authorisation predicate rather than something to populate.
      suspendedByAgencyId: { type: Schema.Types.ObjectId, default: null },
      note: { type: String, default: null, maxlength: 500, trim: true },
    },
    required: false,
    default: null,
  },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Pre-save validation: enforce type-specific config requirements for non-draft products
ProductSchema.pre('save', function (next) {
  // CONFIG VALIDATION ONLY APPLIES TO NON-DRAFT PRODUCTS
  if (this.status === 'draft') {
    next();
    return;
  }

  // Service activation requirements (a single variant carrying serviceConfig + price)
  // are enforced in ProductStatusValidationService at activation time.

  // Per-variant asset enforcement happens in ProductStatusValidationService at activation time.
  // The product-level digitalConfig now only carries the `isActive` kill switch.
  if (this.type !== 'digital' && this.digitalConfig) {
    next(new Error('Only digital products can have digitalConfig'));
    return;
  }

  next();
});

// Indexes
ProductSchema.index({ vendorId: 1, slug: 1 }, { unique: true });
// Cross-vendor lookup of products by their own delivery-agency override —
// used by the agency deactivate/reactivate cascade (ProductDeliveryAgencySuspensionService).
ProductSchema.index({ 'delivery.agency_id': 1 });
// ProductSchema.index({ fileIds: 1 }); // Optional: for finding products by file
// ProductSchema.index({ deletedAt: 1 });

// ─── Storefront (public catalog) indexes ─────────────────────────────────────
// Every vendor-facing query is prefixed by `vendorId`, so none of the indexes
// above can serve the public catalog: it filters on status + deletedAt across
// ALL vendors. `status` alone is a five-value enum — far too low a cardinality
// for the planner to choose it — so without these the storefront's primary
// query is a collection scan on every page view.
//
// The leading pair is the publishable predicate itself (see PUBLISHABLE_PRODUCT_FILTER
// in public-catalog.filter.ts); the trailing key is what each one sorts or narrows by.
ProductSchema.index({ status: 1, deletedAt: 1, createdAt: -1 });
ProductSchema.index({ status: 1, deletedAt: 1, category: 1 });

/**
 * The one full-text index in this codebase.
 *
 * Every other search here is an unanchored substring `$regex` (see regex.util.ts),
 * which cannot use an index and carries no relevance score — so `sort=relevance`
 * on the public product list would have nothing to sort by, and an anonymous
 * search would scan the collection.
 *
 * Two deliberate choices:
 *   - `default_language: 'none'` disables stemming. The platform ships five
 *     locales over one set of string fields, so any single stemmer would be
 *     wrong for four of them.
 *   - Weights make a title hit outrank a tag hit, which outranks a body hit.
 *
 * ⚠️ MongoDB permits exactly ONE text index per collection. Adding a second
 * field means editing this one, not declaring another.
 *
 * ⚠️ `$text` matches whole words, not substrings: "dres" will not match "dress".
 * That is the trade for an indexed, ranked search — the public list documents it.
 */
ProductSchema.index(
  { title: 'text', tags: 'text', description: 'text' },
  {
    name: 'product_storefront_text',
    default_language: 'none',
    weights: { title: 10, tags: 4, description: 1 },
  },
);

export const ProductModel = model<IProduct>(MODELS.PRODUCT, ProductSchema, COLLECTIONS.PRODUCT);
