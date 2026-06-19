import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export type ProductType = 'physical' | 'digital' | 'service';
export type ProductStatus = 'draft' | 'active' | 'archived' | 'pending_review' | 'suspended';
export type BookingMode = 'calendar' | 'manual' | 'capacity';
export type VectorisationStatus = 'not_started' | 'pending' | 'completed' | 'failed';

export interface DigitalConfig {
  // Product-wide download kill switch. Per-variant asset/maxDownloads/expiresAfterDays
  // live on ProductVariant.digitalConfig. When false, no entitlements are granted
  // for any variant of this product, regardless of variant state.
  isActive: boolean;
}

/**
 * Per-product delivery configuration. Only meaningful for physical products.
 * When `agency_id` is null, the order pipeline falls back to the vendor's
 * `default_delivery_agency_id`. If both are unset, the product cannot be
 * activated (see ProductStatusValidationService).
 */
export interface DeliveryConfig {
  agency_id: Types.ObjectId | null;
}

export interface IProduct extends IBaseDocument {
  vendorId: Types.ObjectId;
  type: ProductType;
  status: ProductStatus;

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

  // Service configuration + pricing now live on the single service variant
  // (ProductVariant.serviceConfig). See vendor-variant.controller.

  // Digital-specific configuration
  digitalConfig?: DigitalConfig;

  // Physical-specific delivery configuration. Read by OrderService.createOrderFromCart.
  delivery?: DeliveryConfig;

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

  // ─── Vectorisation tracking ───────────────────────────────────────────────
  vectorisationEnabled: { type: Boolean, default: false, index: true },
  vectorisationStatus: {
    type: String,
    enum: ['not_started', 'pending', 'completed', 'failed'],
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
    },
    required: false,
    default: undefined,
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
// ProductSchema.index({ fileIds: 1 }); // Optional: for finding products by file
// ProductSchema.index({ deletedAt: 1 });

export const ProductModel = model<IProduct>(MODELS.PRODUCT, ProductSchema, COLLECTIONS.PRODUCT);
