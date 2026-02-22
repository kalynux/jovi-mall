import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export type ProductType = 'physical' | 'digital' | 'service';
export type ProductStatus = 'draft' | 'active' | 'archived' | 'pending_review' | 'suspended';
export type BookingMode = 'calendar' | 'manual' | 'capacity';

export interface ServiceConfig {
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  bookingMode: BookingMode;
}

export interface DigitalConfig {
  assetId: Types.ObjectId;        // Reference to DigitalAsset
  maxDownloads: number | null;     // null = unlimited
  expiresAfterDays: number | null; // null = never expires
  isActive: boolean;               // Can be toggled without deleting
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

  // Service-specific configuration
  serviceConfig?: ServiceConfig;

  // Digital-specific configuration
  digitalConfig?: DigitalConfig;
}

const ProductSchema = new Schema<IProduct>({
  vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
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
  defaultVariantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },

  fileIds: [{ type: Schema.Types.ObjectId, ref: 'File' }],

  // Service-specific configuration
  serviceConfig: {
    type: {
      durationMinutes: { type: Number, required: true, min: 1 },
      bufferBeforeMinutes: { type: Number, default: 0, min: 0 },
      bufferAfterMinutes: { type: Number, default: 0, min: 0 },
      bookingMode: {
        type: String,
        enum: ['calendar', 'manual', 'capacity'],
        required: true
      },
    },
    required: false,
  },

  // Digital-specific configuration
  digitalConfig: {
    type: {
      assetId: {
        type: Schema.Types.ObjectId,
        ref: 'DigitalAsset',
        required: true
      },
      maxDownloads: {
        type: Number,
        default: null,
        min: 1
      },
      expiresAfterDays: {
        type: Number,
        default: null,
        min: 1
      },
      isActive: {
        type: Boolean,
        default: true
      },
    },
    required: false,
  },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Validation: Service products must have serviceConfig
// Validation: Service products must have serviceConfig
ProductSchema.pre('save', function (next) {
  // CONFIG VALIDATION ONLY APPLIES TO NON-DRAFT PRODUCTS
  if (this.status === 'draft') {
    next();
    return;
  }

  if (this.type === 'service' && !this.serviceConfig) {
    next(new Error('Service products must have serviceConfig defined before activation'));
    return;
  }
  if (this.type !== 'service' && this.serviceConfig) {
    next(new Error('Only service products can have serviceConfig'));
    return;
  }

  // Validation: Digital products must have digitalConfig
  if (this.type === 'digital' && !this.digitalConfig) {
    next(new Error('Digital products must have digitalConfig defined before activation'));
    return;
  }
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

export const ProductModel = model<IProduct>('Product', ProductSchema);
