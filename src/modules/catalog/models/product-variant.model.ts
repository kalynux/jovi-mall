import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

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
}

const ProductVariantSchema = new Schema<IProductVariant>({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
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

  optionValueIds: [{ type: Schema.Types.ObjectId, ref: 'ProductOptionValue' }],
  fileIds: [{ type: Schema.Types.ObjectId, ref: 'File' }],

  deliveryAgencyId: {
    type: Schema.Types.ObjectId,
    ref: 'DeliveryAgency',
    required: false,
    index: true,
  },

  digitalConfig: {
    type: {
      assetId: { type: Schema.Types.ObjectId, ref: 'DigitalAsset', required: false },
      maxDownloads: { type: Number, default: null, min: 1 },
      expiresAfterDays: { type: Number, default: null, min: 1 },
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

export const ProductVariantModel = model<IProductVariant>('ProductVariant', ProductVariantSchema);
