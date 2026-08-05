import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../../core/types/geo-address.types';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

// ─── Headquarters Address Sub-Schema ─────────────────────────────────────────
// The agency's physical locations, which double as pickup points for certain
// products — the agency counterpart of the vendor's `business_addresses`. Each
// entry carries a geocoded `geo` (a selected `/api/geo/search` result), validated
// against the agency's registered country on write. `location` is the legacy bare
// GeoPoint kept populated (derived from `geo.coordinates`) so the auto-assignment
// distance factor keeps reading it.
//
// `region` and `city` are DERIVED from `geo.components` on write (same rule as
// `location`) — the map result is the single source of truth for where a place
// is, so the agency never types them. They are nullable at the schema level for
// two reasons: rows written before labels/derivation existed, and geocodes that
// legitimately resolve no city (Nominatim does this for rural/landmark results).
// `label` is the agency's own name for the location ("Main depot", "Bonabéri
// branch"); required on every new/edited entry by the Zod validator, nullable
// here because pre-existing rows have none.

const SupportContactSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
  },
  { _id: false }
);

const HeadquartersAddressSchema = new Schema(
  {
    /** The agency's own name for this location. Null only on legacy documents. */
    label: { type: String, default: null, trim: true },
    /** Derived from `geo.components.region` on write. Null when the geocode has none. */
    region: { type: String, default: null, trim: true },
    /** Derived from `geo.components.city` on write. Null when the geocode has none. */
    city: { type: String, default: null, trim: true },
    address_description: { type: String, required: true, trim: true },
    support_contact: { type: SupportContactSchema, required: true },
    /** Map coordinates. Derived from `geo.coordinates` on write; null only on legacy documents. */
    location: { type: GeoPointSchema, default: null },
    /** Canonical geospatial address (from `/api/geo/search`); null on legacy/plain-text entries. */
    geo: { type: GeoAddressSchema, default: null },
  },
  { _id: true }
);

export interface IAgencySupportContact {
  phone: string;
  email: string | null;
}

export interface IAgencyHeadquartersAddress {
  _id: mongoose.Types.ObjectId;
  /** Agency-chosen name for this location; null on legacy entries. */
  label: string | null;
  /** Derived from `geo`; null on legacy entries or when the geocode has no region. */
  region: string | null;
  /** Derived from `geo`; null on legacy entries or when the geocode has no city. */
  city: string | null;
  address_description: string;
  support_contact: IAgencySupportContact;
  /** Map coordinates. Derived from `geo`; null only on legacy documents. */
  location: IGeoPoint | null;
  /** Canonical geospatial address; null on legacy/plain-text entries. */
  geo: IGeoAddress | null;
}

/**
 * Magazin Interface
 *
 * One magazin per delivery agency — the agency's business surface, mirroring the
 * vendor's Store. It is the SINGLE source of truth for the agency's public
 * business identity **and its logistics footprint**: name, description, logo,
 * support contacts, the regions it serves (`coverage_areas`) and its physical
 * headquarters/pickup locations (`headquarters_addresses`). The agency profile
 * (`DeliveryAgency`) keeps only personal + account data (display name, avatar,
 * payout, policies, KYC) plus the set-once `country` that anchors coverage/HQ.
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
  /**
   * Regions the agency serves — region keys of the agency's country (see
   * `locations.json`). Min 1 when onboarding is complete.
   */
  coverage_areas: string[];
  /**
   * Physical locations, which double as product pickup points. Min 1 entry when
   * onboarding is complete; index 0 is the PRIMARY headquarters.
   */
  headquarters_addresses: IAgencyHeadquartersAddress[];
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
      trim: true,
      lowercase: true,
    },
    // Stored in E.164 (see core/validation/phone) — trimmed here so a write that
    // bypasses the Zod schema still cannot store a padded variant.
    support_phone: {
      type: String,
      trim: true,
    },
    support_whatsapp: {
      type: String,
      trim: true,
    },
    coverage_areas: {
      type: [String],
      default: [],
    },
    headquarters_addresses: {
      type: [HeadquartersAddressSchema],
      default: [],
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

// Geospatial indexes on HQ locations — supports proximity queries and the
// auto-assignment distance factor (pickup point ← agency HQ). Sparse: legacy
// documents may have no coordinates yet.
MagazinSchema.index({ 'headquarters_addresses.location': '2dsphere' }, { sparse: true });
MagazinSchema.index({ 'headquarters_addresses.geo.coordinates': '2dsphere' }, { sparse: true });

export const AgencyMagazinModel = mongoose.model<IAgencyMagazin>(
  MODELS.AGENCY_MAGAZIN,
  MagazinSchema,
  COLLECTIONS.AGENCY_MAGAZIN,
);
