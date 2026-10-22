import { ClientSession, Types } from 'mongoose';
import {
  ListingContactModel,
  IListingContactSetDoc,
  IListingSocialLinkDoc,
  IListingVideoDoc,
} from '../models/listing-contact.model';
import { ListingContactField } from '../domain/listing.types';

/**
 * ListingContactRepository — the ONLY door to `listing_contacts` (SERVICE-LISTINGS-PLAN L-6,
 * § C-2), the sensitive half of a listing.
 *
 * ⛔ **No other file may import `ListingContactModel`.** `test:service-listings` scans `src/`
 * for the model and allows exactly its own file and this one; `test:service-listings-catalog`
 * pins that every listings file reaches contacts through here. The reason is the whole
 * privacy design: a contact can only leak through a path that can read one, so the paths that
 * can are kept few, named and narrow.
 *
 * The method set is deliberately minimal — one per documented reader (§ C-2):
 *
 *   getForOwner        the provider's OWN listing detail (their own data, scoped by vendor)
 *   upsertPending      the provider's working copy — written by save and by opening a revision
 *   publishPending     the approve path: pending → published, in the approve transaction
 *   readPublishedField the wave-2 reveal: ONE field of the approved set, never the set
 *   eraseForVendor     the role-closure eraser (ADR-A10 manifest, § C-8a)
 *
 * There is deliberately no list, no search and no "by vendor" read: nothing that renders more
 * than one listing ever needs a contact.
 *
 * The contact-set TYPES are re-exported from here so no other file needs the model's path.
 */
export type ListingContactSetDoc = IListingContactSetDoc;
export type ListingSocialLinkDoc = IListingSocialLinkDoc;
export type ListingVideoDoc = IListingVideoDoc;

export interface OwnerContactRow {
  published: ListingContactSetDoc | null;
  pending: ListingContactSetDoc | null;
}

const opts = (session?: ClientSession) => (session ? { session } : {});

export class ListingContactRepository {
  /**
   * The provider's own contacts for one of their listings. Scoped by BOTH ids, so a vendor id
   * that does not own the listing reads nothing.
   */
  async getForOwner(listingId: string, vendorId: string, session?: ClientSession): Promise<OwnerContactRow | null> {
    if (!Types.ObjectId.isValid(listingId) || !Types.ObjectId.isValid(vendorId)) return null;
    const query = ListingContactModel.findOne(
      { listing_id: new Types.ObjectId(listingId), vendor_id: new Types.ObjectId(vendorId) },
      { published: 1, pending: 1 },
    );
    if (session) query.session(session);
    const row = await query.lean<OwnerContactRow>();
    return row ? { published: row.published ?? null, pending: row.pending ?? null } : null;
  }

  /**
   * Replace the working copy (`null` clears it). Creates the row on the first save, so a
   * listing always has exactly one contact row (unique on `listing_id`).
   */
  async upsertPending(
    listingId: string,
    vendorId: string,
    pending: ListingContactSetDoc | null,
    session?: ClientSession,
  ): Promise<void> {
    await ListingContactModel.updateOne(
      { listing_id: new Types.ObjectId(listingId) },
      {
        $set: { pending },
        $setOnInsert: { vendor_id: new Types.ObjectId(vendorId), published: null },
      },
      { upsert: true, ...opts(session) },
    );
  }

  /**
   * Approve: `pending` becomes `published` and the working copy is cleared. Returns the set
   * that is now published — the caller derives `available_fields` (NAMES) from it and nothing
   * else. Must run inside the approve transaction (§ C-2: one transaction for both halves).
   *
   * A row with no `pending` publishes nothing and returns the current published set, so an
   * approval never wipes contacts it did not see.
   */
  async publishPending(listingId: string, session: ClientSession): Promise<ListingContactSetDoc | null> {
    const row = await ListingContactModel.findOne({ listing_id: new Types.ObjectId(listingId) }, { published: 1, pending: 1 })
      .session(session)
      .lean<OwnerContactRow>();
    if (!row) return null;
    if (!row.pending) return row.published ?? null;
    await ListingContactModel.updateOne(
      { listing_id: new Types.ObjectId(listingId) },
      { $set: { published: row.pending, pending: null } },
      { session },
    );
    return row.pending;
  }

  /**
   * ONE field of the APPROVED contact set — the wave-2 reveal's read. Never the whole set and
   * never `pending` (an unreviewed number must not be sold).
   */
  async readPublishedField(listingId: string, field: ListingContactField, session?: ClientSession): Promise<unknown | null> {
    if (!Types.ObjectId.isValid(listingId)) return null;
    const query = ListingContactModel.findOne(
      { listing_id: new Types.ObjectId(listingId) },
      { [`published.${field}`]: 1 },
    );
    if (session) query.session(session);
    const row = await query.lean<{ published?: Record<string, unknown> | null }>();
    const value = row?.published?.[field];
    if (value === undefined || value === null) return null;
    if (Array.isArray(value) && value.length === 0) return null;
    return value;
  }

  /**
   * Role closure (§ C-8a): erase every contact set of a closed provider — both copies set to
   * `null`. The row itself stays (one per listing, unique on `listing_id`) and holds nothing;
   * reveals keep only fingerprints, so nothing downstream needs the values. Returns how many
   * rows were erased.
   */
  async eraseForVendor(vendorId: string, session?: ClientSession): Promise<number> {
    const res = await ListingContactModel.updateMany(
      { vendor_id: new Types.ObjectId(vendorId) },
      { $set: { published: null, pending: null } },
      opts(session),
    );
    return res.modifiedCount ?? 0;
  }
}

export const listingContactRepository = new ListingContactRepository();
