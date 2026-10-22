import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { actorStampFields } from '../../../core/types/actor-source.types';

/**
 * ListingRevealBlock — an administrator stopping ONE customer revealing on ONE listing (L-29).
 *
 * Placed from a provider's report ticket (L-31) after checking the real phone numbers the
 * provider cannot see. The refusal it causes is the neutral `LISTING_UNREACHABLE`: the
 * customer is never told they were blocked, so a drainer learns nothing from it.
 *
 * Lifting stamps `lifted_at` rather than deleting, so the row is the history. The partial
 * unique index allows exactly one ACTIVE block per (customer, listing) and any number of
 * lifted ones.
 */
export interface IListingRevealBlock extends Document {
  customer_id: Types.ObjectId;
  listing_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  reason: string;
  ticket_id: Types.ObjectId | null;
  blocked_at: Date;
  blocked_by_user_id: Types.ObjectId | null;
  blocked_by_source: 'platform' | 'admin';
  blocked_by_name: string | null;
  lifted_at: Date | null;
  lifted_by_user_id: Types.ObjectId | null;
  lifted_by_source: 'platform' | 'admin';
  lifted_by_name: string | null;
  lift_note: string | null;
}

const ListingRevealBlockSchema = new Schema<IListingRevealBlock>({
  customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
  listing_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING, required: true },
  vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  ticket_id: { type: Schema.Types.ObjectId, ref: MODELS.TICKET, default: null },
  blocked_at: { type: Date, required: true, default: Date.now },
  blocked_by_user_id: { type: Schema.Types.ObjectId, default: null },
  ...actorStampFields('blocked_by'),
  lifted_at: { type: Date, default: null },
  lifted_by_user_id: { type: Schema.Types.ObjectId, default: null },
  ...actorStampFields('lifted_by'),
  lift_note: { type: String, default: null, trim: true, maxlength: 500 },
});

ListingRevealBlockSchema.index(
  { customer_id: 1, listing_id: 1 },
  { unique: true, partialFilterExpression: { lifted_at: null }, name: 'listing_reveal_block_one_active' },
);
ListingRevealBlockSchema.index({ listing_id: 1, blocked_at: -1 }, { name: 'listing_reveal_block_listing' });

export const ListingRevealBlockModel = mongoose.model<IListingRevealBlock>(
  MODELS.LISTING_REVEAL_BLOCK,
  ListingRevealBlockSchema,
  COLLECTIONS.LISTING_REVEAL_BLOCK,
);
