import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { GeoAddressSchema, IGeoAddress } from '../../../core/types/geo-address.types';
import {
  LISTING_SOCIAL_NETWORKS,
  LISTING_VIDEO_HOSTS,
  LISTING_MAX_SOCIALS,
  ListingSocialNetwork,
  ListingVideoHost,
} from '../domain/listing.types';

/**
 * ListingContact — the SENSITIVE half of a listing (L-6), one row per listing.
 *
 * ⛔ **Never read by any indexing, DTO, search or list path.** Its readers are, exhaustively:
 *   - `ListingRevealService` (a customer unlocking one field, for credits);
 *   - the approve path, which copies `pending` → `published` in the same transaction as the
 *     listing's own content;
 *   - the provider's own listing detail (their own data);
 *   - the role-closure eraser (ADR-A10: a closed provider's contacts are erased).
 * wi-admin reads it directly, behind `catalog.listings.contacts.read`, audited per read.
 * `test:service-listings` source-scans every importer of this model against that list.
 *
 * `location` is a GeoAddress with **no 2dsphere index**, deliberately: the pin is sensitive,
 * nothing searches it, and an index would make it the one place a query could reach it.
 */

export interface IListingSocialLinkDoc {
  network: ListingSocialNetwork;
  url: string;
}

export interface IListingVideoDoc {
  url: string;
  host: ListingVideoHost;
  checked_at: Date | null;
}

export interface IListingContactSetDoc {
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  socials: IListingSocialLinkDoc[];
  location: IGeoAddress | null;
  video: IListingVideoDoc | null;
}

export interface IListingContact extends Document {
  listing_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  published: IListingContactSetDoc | null;
  pending: IListingContactSetDoc | null;
  created_at: Date;
  updated_at: Date;
}

const SocialLinkSchema = new Schema<IListingSocialLinkDoc>(
  {
    network: { type: String, enum: LISTING_SOCIAL_NETWORKS, required: true },
    url: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const VideoSchema = new Schema<IListingVideoDoc>(
  {
    url: { type: String, required: true, trim: true, maxlength: 500 },
    host: { type: String, enum: LISTING_VIDEO_HOSTS, required: true },
    checked_at: { type: Date, default: null },
  },
  { _id: false },
);

const ContactSetSchema = new Schema<IListingContactSetDoc>(
  {
    whatsapp: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true, lowercase: true },
    website: { type: String, default: null, trim: true, maxlength: 500 },
    socials: {
      type: [SocialLinkSchema],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= LISTING_MAX_SOCIALS, message: 'At most 5 social links' },
    },
    location: { type: GeoAddressSchema, default: null },
    video: { type: VideoSchema, default: null },
  },
  { _id: false },
);

const ListingContactSchema = new Schema<IListingContact>(
  {
    listing_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    published: { type: ContactSetSchema, default: null },
    pending: { type: ContactSetSchema, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

ListingContactSchema.index({ listing_id: 1 }, { unique: true, name: 'listing_contact_one_per_listing' });
ListingContactSchema.index({ vendor_id: 1 }, { name: 'listing_contact_vendor' });

export const ListingContactModel = mongoose.model<IListingContact>(
  MODELS.LISTING_CONTACT,
  ListingContactSchema,
  COLLECTIONS.LISTING_CONTACT,
);
