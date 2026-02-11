import mongoose, { Schema, Document } from 'mongoose';

/**
 * Store Interface
 * 
 * One store per vendor - the public commercial surface of their business.
 * This is NOT a simple profile, it's a public storefront.
 */
export interface IStore extends Document {
  vendor_id: mongoose.Types.ObjectId; // Owner (UNIQUE - one store per vendor)
  name: string; // Store display name
  slug: string; // UNIQUE, URL-safe, lowercase (IMMUTABLE in vendor API)
  logo_url?: string; // Store logo
  banner_url?: string; // Store banner/hero image
  description?: string; // Store description
  address?: string; // Physical address
  city?: string; // City
  country: string; // Country (IMMUTABLE - tax/shipping compliance)
  support_email?: string; // Support contact email
  support_phone?: string; // Support contact phone
  support_whatsapp?: string; // Support WhatsApp number
  is_open: boolean; // Vendor-controlled vacation mode (true = open for business)
  version: number; // Optimistic locking counter
  created_at: Date;
  updated_at: Date;
}

/**
 * Store Schema
 * 
 * Indexes:
 * - vendor_id (UNIQUE) - One store per vendor, fast vendor lookup
 * - slug (UNIQUE) - URL routing, SEO
 * 
 * Immutability:
 * - country: { immutable: true } - Mongoose-level safety net
 */
const StoreSchema = new Schema<IStore>(
  {
    vendor_id: {
      type: Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      unique: true, // One store per vendor
      index: true,
    },
    name: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 100,
    },
    slug: {
      type: String,
      required: true,
      unique: true, // Global uniqueness for URL routing
      lowercase: true,
      index: true,
      match: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, // URL-safe validation
    },
    logo_url: {
      type: String,
    },
    banner_url: {
      type: String,
    },
    description: {
      type: String,
      maxlength: 1000,
    },
    address: {
      type: String,
      maxlength: 200,
    },
    city: {
      type: String,
      maxlength: 100,
    },
    country: {
      type: String,
      required: true,
      immutable: true, // Mongoose-level enforcement
    },
    support_email: {
      type: String,
      lowercase: true,
    },
    support_phone: {
      type: String,
    },
    support_whatsapp: {
      type: String,
    },
    is_open: {
      type: Boolean,
      default: true, // Open for business by default
    },
    version: {
      type: Number,
      default: 0, // Optimistic locking
    },
  },
  {
    timestamps: {
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
  }
);

// Compound index for future: when we support multiple stores per vendor
// StoreSchema.index({ vendor_id: 1, slug: 1 });

export const StoreModel = mongoose.model<IStore>('Store', StoreSchema);
