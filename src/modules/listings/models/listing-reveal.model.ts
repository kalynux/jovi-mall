import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { actorStampFields } from '../../../core/types/actor-source.types';
import { LISTING_CONTACT_FIELDS, ListingContactField } from '../domain/listing.types';

/**
 * ListingReveal — one row per contact field revealed: the MONEY record (SERVICE-LISTINGS-PLAN § C-2).
 *
 * ⛔ **`unique (lead_id, field)` is the reveal's idempotency, and the only race guard.** A
 * double tap, a retried chat message and two browser tabs all land on it; the loser of the
 * insert returns the existing reveal and is charged nothing. Built by
 * `npm run migrate:service-listings-indexes` (autoIndex is off in production).
 *
 * `value_fingerprint` is a sha256 of the normalised value — **never the value**. It exists so
 * L-9 ("same number on several listings is charged again") can later become "charge once"
 * with no data migration, and so this money record holds no contact a leak could expose.
 *
 * `charged_into_debt` marks a grace reveal (L-10) paid through `debitAllowingDebt`.
 * `refund` is set once, by an administrator from a report ticket (L-25 / L-31), with its own
 * ledger row (`listing_reveal_refund`).
 */
export interface IListingRevealRefund {
  at: Date;
  by_user_id: Types.ObjectId | null;
  by_source: 'platform' | 'admin';
  by_name: string | null;
  ticket_id: Types.ObjectId | null;
  ledger_ref: string;
  note: string | null;
}

export interface IListingReveal extends Document {
  lead_id: Types.ObjectId;
  listing_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  customer_id: Types.ObjectId;
  field: ListingContactField;
  cost: number;
  charged_into_debt: boolean;
  value_fingerprint: string;
  ledger_ref: string | null;
  refund: IListingRevealRefund | null;
  at: Date;
}

const RefundSchema = new Schema<IListingRevealRefund>(
  {
    at: { type: Date, required: true },
    by_user_id: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('by'),
    ticket_id: { type: Schema.Types.ObjectId, ref: MODELS.TICKET, default: null },
    ledger_ref: { type: String, required: true },
    note: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const ListingRevealSchema = new Schema<IListingReveal>({
  lead_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING_LEAD, required: true },
  listing_id: { type: Schema.Types.ObjectId, ref: MODELS.LISTING, required: true },
  vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
  customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
  field: { type: String, enum: LISTING_CONTACT_FIELDS, required: true },
  cost: { type: Number, required: true, min: 0 },
  charged_into_debt: { type: Boolean, required: true, default: false },
  value_fingerprint: { type: String, required: true },
  ledger_ref: { type: String, default: null },
  refund: { type: RefundSchema, default: null },
  at: { type: Date, required: true, default: Date.now },
});

ListingRevealSchema.index({ lead_id: 1, field: 1 }, { unique: true, name: 'listing_reveal_one_per_field' });
// The L-30 daily cap sums one customer's spend on one listing over a day.
ListingRevealSchema.index({ customer_id: 1, listing_id: 1, at: 1 }, { name: 'listing_reveal_customer_day' });
// The provider's / an administrator's view of a listing's reveals.
ListingRevealSchema.index({ vendor_id: 1, at: -1 }, { name: 'listing_reveal_vendor_recent' });

export const ListingRevealModel = mongoose.model<IListingReveal>(
  MODELS.LISTING_REVEAL,
  ListingRevealSchema,
  COLLECTIONS.LISTING_REVEAL,
);
