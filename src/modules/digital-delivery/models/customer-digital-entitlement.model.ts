import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

/**
 * CustomerDigitalEntitlement - Customer's right to download
 * 
 * Created after successful payment. This is the SOURCE OF TRUTH for all download access.
 * 
 * CRITICAL GUARANTEES:
 * - Unique index on (orderId, orderItemId) prevents double-granting from webhook retries
 * - downloadsUsed is incremented via conditional atomic update with guard
 * - Mathematically impossible to exceed maxDownloads
 */
export interface ICustomerDigitalEntitlement extends IBaseDocument {
  orderId: Types.ObjectId;         // Source order
  orderItemId: Types.ObjectId;     // Specific line item
  productId: Types.ObjectId;       // What product was purchased
  variantId: Types.ObjectId;       // Specific variant (format/tier) purchased
  assetId: Types.ObjectId;         // What file to deliver (snapshot from variant at grant time)
  customerId: Types.ObjectId;      // Who can download
  vendorId: Types.ObjectId;        // File owner

  downloadsUsed: number;           // Atomic counter (incremented with guard)
  maxDownloads: number | null;     // Copy from variant config at grant time (null = unlimited)
  expiresAt: Date | null;          // Computed from variant config (null = never expires)
  revokedAt: Date | null;          // Admin/vendor revocation
}

const CustomerDigitalEntitlementSchema = new Schema<ICustomerDigitalEntitlement>({
  orderId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Order', 
    required: true,
  },
  orderItemId: { 
    type: Schema.Types.ObjectId, 
    required: true 
  },
  productId: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  variantId: {
    type: Schema.Types.ObjectId,
    ref: 'ProductVariant',
    required: true,
    index: true,
  },
  assetId: {
    type: Schema.Types.ObjectId,
    ref: 'DigitalAsset',
    required: true
  },
  customerId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Customer', 
    required: true,
    index: true
  },
  vendorId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Vendor', 
    required: true 
  },
  
  downloadsUsed: { type: Number, default: 0, min: 0 },
  maxDownloads: { type: Number, default: null, min: 1 },
  expiresAt: { type: Date, default: null, index: true },
  revokedAt: { type: Date, default: null },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// CRITICAL: Unique index prevents double-granting from webhook retries
CustomerDigitalEntitlementSchema.index(
  { orderId: 1, orderItemId: 1 }, 
  { unique: true }
);

// Customer's library
CustomerDigitalEntitlementSchema.index({ customerId: 1, productId: 1 });

// Variant-grouped library views (different formats of the same product)
CustomerDigitalEntitlementSchema.index({ customerId: 1, variantId: 1 });

// Trace back to purchase
CustomerDigitalEntitlementSchema.index({ orderId: 1 });

// Cleanup jobs (expired entitlements)
// CustomerDigitalEntitlementSchema.index({ expiresAt: 1 });

// Soft delete queries
// CustomerDigitalEntitlementSchema.index({ deletedAt: 1 });

export const CustomerDigitalEntitlementModel = 
  (mongoose.models.CustomerDigitalEntitlement as mongoose.Model<ICustomerDigitalEntitlement>) || 
  model<ICustomerDigitalEntitlement>('CustomerDigitalEntitlement', CustomerDigitalEntitlementSchema);
