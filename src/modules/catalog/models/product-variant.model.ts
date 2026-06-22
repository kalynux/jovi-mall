import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export interface IProductVariant extends IBaseDocument {
  productId: Types.ObjectId;
  sku: string;
  name?: string; // Variant name (e.g., "PDF", "EPUB", "Basic Service") - required for digital/service

  // Variant status for archiving (never hard delete)
  status: 'active' | 'archived';

  // Deterministic signature for reconciliation (e.g., "size:s|color:red")
  optionSignature: string;

  price: number;
  compareAtPrice?: number;

  stock: number;
  isInfiniteStock: boolean;

  // Inventory management enhancements
  low_stock_threshold: number | null; // Vendor-controlled, null = no alerts
  allow_oversell: boolean; // Controls if stock can go negative

  weight?: number;
  length?: number;
  width?: number;
  height?: number;

  optionValueIds: Types.ObjectId[];
  fileIds: Types.ObjectId[];

  /**
   * Timestamp of the most recent paid order containing this variant. Maintained
   * on payment success and back-fillable. Null = never ordered. Mirrors
   * Product.lastOrderedAt for per-variant activity (file-cleanup module).
   */
  lastOrderedAt?: Date | null;

  // Delivery agency for variant fulfillment (physical products only)
  // undefined = use vendor's default_delivery_agency_id
  deliveryAgencyId?: Types.ObjectId;

  // Digital-specific config — only set on variants of digital products.
  // A digital variant is `status: 'active'` iff `digitalConfig.assetId` is set
  // (enforced by VariantDigitalService and vendor-variant.controller).
  digitalConfig?: {
    assetId?: Types.ObjectId;        // ref DigitalAsset; absent until file upload
    maxDownloads: number | null;     // null = unlimited
    expiresAfterDays: number | null; // null = never expires
  };

  // Service-specific config — only set on the single variant of a service product.
  // `price` is the base price per `durationMinutes` (e.g. 5000 for a 60-min unit);
  // the booking price is prorated by the actual elapsed duration. Enforced by
  // vendor-variant.controller (exactly one default service variant).
  serviceConfig?: {
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    bookingMode: 'calendar' | 'manual' | 'capacity';
    // Seats per slot for capacity mode. Required when bookingMode === 'capacity'.
    maxBookings?: number;
    // Optional peak-hours surcharge. Applies only to the portion of a booking that
    // overlaps [startTime, endTime] on the selected daysOfWeek.
    peakHours?: {
      daysOfWeek: number[];                 // 0-6 (Sun-Sat); empty = every day
      startTime: string;                    // 'HH:mm'
      endTime: string;                      // 'HH:mm'
      priceType: 'fixed' | 'percentage';
      value: number;                        // % of the peak-portion price, or a flat amount
    };
  };
}

const ProductVariantSchema = new Schema<IProductVariant>({
  productId: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true, index: true },
  sku: { type: String, required: true }, // Index defined below
  name: { type: String }, // Optional at schema level, validated at service level for digital/service products

  status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  optionSignature: { type: String, required: true, index: true },

  price: { type: Number, required: true },
  compareAtPrice: { type: Number },

  stock: { type: Number, required: true, default: 0 },
  isInfiniteStock: { type: Boolean, default: false },

  // Inventory management enhancements
  low_stock_threshold: { type: Number, default: null }, // null = no alert threshold
  allow_oversell: { type: Boolean, default: false }, // Default: prevent negative stock

  weight: { type: Number },
  length: { type: Number },
  width: { type: Number },
  height: { type: Number },

  optionValueIds: [{ type: Schema.Types.ObjectId, ref: MODELS.PRODUCT_OPTION_VALUE }],
  fileIds: [{ type: Schema.Types.ObjectId, ref: MODELS.FILE }],

  // Last paid-order timestamp (file-cleanup inactivity clock).
  lastOrderedAt: { type: Date, default: null, index: true },

  deliveryAgencyId: {
    type: Schema.Types.ObjectId,
    ref: MODELS.DELIVERY_AGENCY,
    required: false,
    index: true,
  },

  digitalConfig: {
    type: {
      assetId: { type: Schema.Types.ObjectId, ref: MODELS.DIGITAL_ASSET, required: false },
      maxDownloads: { type: Number, default: null, min: 1 },
      expiresAfterDays: { type: Number, default: null, min: 1 },
    },
    required: false,
    default: undefined,
  },

  serviceConfig: {
    type: {
      durationMinutes: { type: Number, required: true, min: 1 },
      bufferBeforeMinutes: { type: Number, default: 0, min: 0 },
      bufferAfterMinutes: { type: Number, default: 0, min: 0 },
      bookingMode: {
        type: String,
        enum: ['calendar', 'manual', 'capacity'],
        required: true,
      },
      maxBookings: { type: Number, required: false, min: 1 },
      peakHours: {
        type: {
          daysOfWeek: { type: [Number], default: [] },
          startTime: { type: String, required: true },
          endTime: { type: String, required: true },
          priceType: { type: String, enum: ['fixed', 'percentage'], required: true },
          value: { type: Number, required: true, min: 0 },
        },
        required: false,
        default: undefined,
      },
    },
    required: false,
    default: undefined,
  },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
// SKU should be unique globally
ProductVariantSchema.index({ sku: 1 }, { unique: true });
// For fast reconciliation lookups
ProductVariantSchema.index({ productId: 1, optionSignature: 1 }, { unique: true });
ProductVariantSchema.index({ productId: 1, status: 1 });

export const ProductVariantModel = model<IProductVariant>(MODELS.PRODUCT_VARIANT, ProductVariantSchema, COLLECTIONS.PRODUCT_VARIANT);
