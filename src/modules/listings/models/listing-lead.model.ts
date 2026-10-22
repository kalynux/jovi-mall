import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import {
  LISTING_CONTACT_FIELDS,
  LISTING_LEAD_CHANNELS,
  ListingContactField,
  ListingLeadChannel,
} from '../domain/listing.types';

/**
 * ListingLead — one row per (customer, listing, 30-day window) (L-7, SERVICE-LISTINGS-PLAN § C-2).
 *
 * Opened by a customer's FIRST reveal on a listing, and only while it is live: a suspended
 * listing never opens a lead. The window runs `LISTING_LEAD_WINDOW_DAYS` from that first
 * reveal; a reveal after `window_end` opens a new lead and starts again at the first-field
 * price. The provider sees leads masked (L-13), never the full number.
 *
 * `engaged_while_live` is what the L-10 grace test reads: a customer may keep being served by
 * a listing suspended for credits only through a lead that was engaged while it was live.
 *
 * Written ONLY by the reveal transaction. The unique index is what makes a double tap open
 * one lead rather than two.
 */
export interface IListingLead extends Document {
  customer_id: Types.ObjectId;
  listing_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  window_start: Date;
  window_end: Date;
  engaged_while_live: boolean;
  fields_revealed: ListingContactField[];
  channel: ListingLeadChannel;
  created_at: Date;
  updated_at: Date;
}

const ListingLeadSchema = new Schema<IListingLead>(
  {
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    listing_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    window_start: { type: Date, required: true },
    window_end: { type: Date, required: true },
    engaged_while_live: { type: Boolean, required: true, default: true },
    fields_revealed: { type: [{ type: String, enum: LISTING_CONTACT_FIELDS }], default: [] },
    channel: { type: String, enum: LISTING_LEAD_CHANNELS, required: true, default: 'web' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

ListingLeadSchema.index(
  { customer_id: 1, listing_id: 1, window_start: 1 },
  { unique: true, name: 'listing_lead_one_per_window' },
);
// "The customer's current lead on this listing": newest window first.
ListingLeadSchema.index({ customer_id: 1, listing_id: 1, window_end: -1 }, { name: 'listing_lead_current' });
// The provider's lead list, newest first.
ListingLeadSchema.index({ vendor_id: 1, created_at: -1 }, { name: 'listing_lead_vendor_recent' });

export const ListingLeadModel = mongoose.model<IListingLead>(MODELS.LISTING_LEAD, ListingLeadSchema, COLLECTIONS.LISTING_LEAD);
