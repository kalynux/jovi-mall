import { ClientSession, Types } from 'mongoose';
import { ListingLeadModel, IListingLead } from '../models/listing-lead.model';
import { ListingContactField, ListingLeadChannel } from '../domain/listing.types';

/**
 * ListingLeadRepository — persistence for `listing_leads`, one row per (customer, listing,
 * 30-day window) (SERVICE-LISTINGS-PLAN L-7, § C-2).
 *
 * ⛔ **Written ONLY by the reveal transaction** (`ListingRevealService`). Every write here takes
 * the caller's session; `create` uses the ARRAY form, the only one Mongoose runs inside a
 * transaction (`create(doc, { session })` silently writes outside it — the tracking-outbox
 * lesson). The unique `(customer_id, listing_id, window_start)` index is the backstop.
 *
 * The reads beyond the reveal's own are the two existence questions other features ask:
 * "may this customer review this listing?" (L-27, any window) and "has this customer ever
 * revealed from this provider?" (the consent door).
 */
export type ListingLeadRow = IListingLead & { _id: Types.ObjectId };

const oid = (id: string | Types.ObjectId): Types.ObjectId => (typeof id === 'string' ? new Types.ObjectId(id) : id);

export interface NewLeadInput {
  _id: Types.ObjectId;
  customerId: string;
  listingId: string;
  vendorId: string;
  windowStart: Date;
  windowEnd: Date;
  field: ListingContactField;
  channel: ListingLeadChannel;
}

export class ListingLeadRepository {
  /** The customer's CURRENT lead on a listing (window not yet ended), newest window first. */
  async findCurrent(customerId: string, listingId: string, now: Date, session?: ClientSession): Promise<ListingLeadRow | null> {
    if (!Types.ObjectId.isValid(customerId) || !Types.ObjectId.isValid(listingId)) return null;
    const query = ListingLeadModel.findOne({
      customer_id: oid(customerId),
      listing_id: oid(listingId),
      window_end: { $gt: now },
    }).sort({ window_end: -1 });
    if (session) query.session(session);
    return query.lean<ListingLeadRow>();
  }

  /** Open a lead with its first field. Session writes use the ARRAY form. */
  async create(input: NewLeadInput, session: ClientSession): Promise<ListingLeadRow> {
    const [created] = await ListingLeadModel.create(
      [
        {
          _id: input._id,
          customer_id: oid(input.customerId),
          listing_id: oid(input.listingId),
          vendor_id: oid(input.vendorId),
          window_start: input.windowStart,
          window_end: input.windowEnd,
          engaged_while_live: true,
          fields_revealed: [input.field],
          channel: input.channel,
        },
      ],
      { session },
    );
    return created.toObject() as ListingLeadRow;
  }

  /** Add a field to an existing lead and remember where the customer last revealed from. */
  async addField(leadId: Types.ObjectId, field: ListingContactField, channel: ListingLeadChannel, session: ClientSession): Promise<void> {
    await ListingLeadModel.updateOne(
      { _id: leadId },
      { $addToSet: { fields_revealed: field }, $set: { channel } },
      { session },
    );
  }

  /** L-27: has this customer EVER had a lead on this listing (any window)? */
  async existsForListing(customerId: string, listingId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(customerId) || !Types.ObjectId.isValid(listingId)) return false;
    return (await ListingLeadModel.exists({ customer_id: oid(customerId), listing_id: oid(listingId) })) !== null;
  }

  /** Has this customer ever revealed anything from this provider (any listing, any window)? */
  async existsForVendor(customerId: string, vendorId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(customerId) || !Types.ObjectId.isValid(vendorId)) return false;
    return (await ListingLeadModel.exists({ customer_id: oid(customerId), vendor_id: oid(vendorId) })) !== null;
  }
}

export const listingLeadRepository = new ListingLeadRepository();
