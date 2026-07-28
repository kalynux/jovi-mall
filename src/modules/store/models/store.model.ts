import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

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
  // Logo/banner are stored as File references (not URLs) so they register a
  // file_references row and are exempt from orphan garbage collection. The public
  // URL is derived at read time. null = cleared by vendor.
  logo_file_id?: mongoose.Types.ObjectId | null; // Store logo
  banner_file_id?: mongoose.Types.ObjectId | null; // Store banner/hero image
  description?: string | null; // Store description (null = cleared)
  // NO address/city/country here: physical locations are the vendor's
  // business_addresses (geocoded, country-anchored) and the country lives on
  // the vendor profile — the store API serves it read-only from there.
  support_email?: string | null; // Support contact email (null = cleared)
  support_phone?: string | null; // Support contact phone (null = cleared)
  support_whatsapp?: string | null; // Support WhatsApp number (null = cleared)
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
 */
const StoreSchema = new Schema<IStore>(
  {
    vendor_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.VENDOR,
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
    logo_file_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.FILE,
      default: null,
    },
    banner_file_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.FILE,
      default: null,
    },
    description: {
      type: String,
      maxlength: 1000,
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

export const StoreModel = mongoose.model<IStore>(MODELS.STORE, StoreSchema, COLLECTIONS.STORE);
