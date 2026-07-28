import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Magazin Interface
 *
 * One magazin per delivery agency — the agency's business surface, mirroring the
 * vendor's Store. It is the SINGLE source of truth for the agency's public
 * business name, description, logo and support contacts. The agency profile
 * (`DeliveryAgency`) keeps only personal + logistics data (display name, avatar,
 * coverage, HQ addresses, payout, policies, KYC).
 *
 * Unlike the vendor Store, the magazin has no public slug/URL or vacation mode:
 * an agency is not a public shopping storefront.
 */
export interface IAgencyMagazin extends Document {
  agency_id: mongoose.Types.ObjectId; // Owner (UNIQUE - one magazin per agency)
  name: string; // Business/display name (source of truth)
  // Logo is stored as a File reference (not a URL) so it registers a
  // file_references row and is exempt from orphan garbage collection. The public
  // URL is derived at read time. null = unset/cleared.
  logo_file_id?: mongoose.Types.ObjectId | null;
  description?: string | null; // Business description (null = cleared)
  support_email?: string | null; // Support contact email (null = cleared)
  support_phone?: string | null; // Support contact phone (null = cleared)
  support_whatsapp?: string | null; // WhatsApp support number (null = cleared)
  version: number; // Optimistic locking counter
  created_at: Date;
  updated_at: Date;
}

/**
 * Magazin Schema
 *
 * Indexes:
 * - agency_id (UNIQUE) - One magazin per agency, fast agency lookup
 */
const MagazinSchema = new Schema<IAgencyMagazin>(
  {
    agency_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.DELIVERY_AGENCY,
      required: true,
      unique: true, // One magazin per agency
      index: true,
    },
    name: {
      type: String,
      required: true,
      minlength: 2,
      maxlength: 100,
    },
    logo_file_id: {
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

export const AgencyMagazinModel = mongoose.model<IAgencyMagazin>(
  MODELS.AGENCY_MAGAZIN,
  MagazinSchema,
  COLLECTIONS.AGENCY_MAGAZIN,
);
