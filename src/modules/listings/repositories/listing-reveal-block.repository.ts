import { Types } from 'mongoose';
import { ListingRevealBlockModel, IListingRevealBlock } from '../models/listing-reveal-block.model';
import { actorStamp, ActorRef } from '../../../core/types/actor-source.types';

/**
 * ListingRevealBlockRepository — the WRITE side of `listing_reveal_blocks` (SERVICE-LISTINGS-PLAN
 * L-29): an administrator, working a provider's report, stops one customer from unlocking one
 * listing's contacts, and may lift it later. The reveal only reads "is there an active one?"
 * (`listing-reveal.repository.ts`).
 *
 * ⛔ **Written ONLY by `ListingReportAdminService`**, reached from wi-admin behind
 * `catalog.listings.reveal-block`. The partial unique index (one row with `lifted_at: null` per
 * pair) is what makes "one active block" true under a race; `place` turns its E11000 into
 * `false`, the caller's `409 LISTING_REVEAL_BLOCK_EXISTS`.
 */
export type ListingRevealBlockRow = IListingRevealBlock & { _id: Types.ObjectId };

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

export class ListingRevealBlockRepository {
  async findActive(customerId: string, listingId: string): Promise<ListingRevealBlockRow | null> {
    return ListingRevealBlockModel.findOne({ customer_id: oid(customerId), listing_id: oid(listingId), lifted_at: null })
      .lean<ListingRevealBlockRow>();
  }

  /** Place a block. `null` when an active one already exists (the index refused the second). */
  async place(input: {
    customerId: string;
    listingId: string;
    vendorId: string;
    reason: string;
    ticketId: string | null;
    actor: ActorRef;
    at: Date;
  }): Promise<ListingRevealBlockRow | null> {
    try {
      const created = await ListingRevealBlockModel.create({
        customer_id: oid(input.customerId),
        listing_id: oid(input.listingId),
        vendor_id: oid(input.vendorId),
        reason: input.reason,
        ticket_id: input.ticketId ? oid(input.ticketId) : null,
        blocked_at: input.at,
        ...actorStamp('blocked_by', input.actor),
        lifted_at: null,
      });
      return created.toObject() as ListingRevealBlockRow;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return null;
      throw err;
    }
  }

  /** Lift the active block. `null` when there is none (`404 LISTING_REVEAL_BLOCK_NOT_FOUND`). */
  async lift(customerId: string, listingId: string, note: string | null, actor: ActorRef, at: Date): Promise<ListingRevealBlockRow | null> {
    return ListingRevealBlockModel.findOneAndUpdate(
      { customer_id: oid(customerId), listing_id: oid(listingId), lifted_at: null },
      { $set: { lifted_at: at, lift_note: note, ...actorStamp('lifted_by', actor) } },
      { new: true },
    ).lean<ListingRevealBlockRow>();
  }
}

export const listingRevealBlockRepository = new ListingRevealBlockRepository();
