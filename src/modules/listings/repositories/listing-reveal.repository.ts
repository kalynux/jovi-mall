import { ClientSession, Types } from 'mongoose';
import { ListingRevealModel, IListingReveal } from '../models/listing-reveal.model';
import { ListingRevealBlockModel } from '../models/listing-reveal-block.model';
import { CreditTransactionModel } from '../../billing/models/credit-transaction.model';
import { VendorModel } from '../../vendors/vendor.model';
import { ListingContactField, ListingSettings } from '../domain/listing.types';

/**
 * ListingRevealRepository — `listing_reveals` (the MONEY record) plus the read-only facts the
 * reveal transaction needs from three other collections (SERVICE-LISTINGS-PLAN § The reveal).
 *
 * ⛔ **Writes `listing_reveals` only, and only inside the caller's session** (`create([doc],
 * { session })`, the ARRAY form). The unique `(lead_id, field)` index is the reveal's
 * idempotency: an E11000 from `insert` means a concurrent identical reveal won, and the caller
 * answers with that one, charging nothing.
 *
 * ⛔ **`listing_reveal_blocks` is READ here, never written.** Blocks are placed and lifted by an
 * administrator from a report ticket (L-29, the messaging/report builder's path); the reveal
 * only asks "is there an active one?".
 *
 * ⛔ **Nothing here reads a contact value.** That is `listing-contact.repository.ts`'s alone
 * (`readPublishedField`); a reveal row carries a fingerprint, never the value.
 */
export type ListingRevealRow = IListingReveal & { _id: Types.ObjectId };

const oid = (id: string | Types.ObjectId): Types.ObjectId => (typeof id === 'string' ? new Types.ObjectId(id) : id);

export interface NewRevealInput {
  _id: Types.ObjectId;
  leadId: Types.ObjectId;
  listingId: string;
  vendorId: string;
  customerId: string;
  field: ListingContactField;
  cost: number;
  chargedIntoDebt: boolean;
  valueFingerprint: string;
  ledgerRef: string | null;
  at: Date;
}

/** The provider facts a reveal reads — never the provider's name, email or phone. */
export interface RevealVendorFacts {
  userId: string | null;
  active: boolean;
  isProvider: boolean;
  settings: Partial<ListingSettings> | null;
}

export class ListingRevealRepository {
  /** Insert one reveal inside the reveal transaction. Throws E11000 on a concurrent duplicate. */
  async insert(input: NewRevealInput, session: ClientSession): Promise<ListingRevealRow> {
    const [created] = await ListingRevealModel.create(
      [
        {
          _id: input._id,
          lead_id: input.leadId,
          listing_id: oid(input.listingId),
          vendor_id: oid(input.vendorId),
          customer_id: oid(input.customerId),
          field: input.field,
          cost: input.cost,
          charged_into_debt: input.chargedIntoDebt,
          value_fingerprint: input.valueFingerprint,
          ledger_ref: input.ledgerRef,
          refund: null,
          at: input.at,
        },
      ],
      { session },
    );
    return created.toObject() as ListingRevealRow;
  }

  /** The reveal of one field on one lead — the idempotency key's row. */
  async findByLeadAndField(leadId: Types.ObjectId, field: ListingContactField, session?: ClientSession): Promise<ListingRevealRow | null> {
    const query = ListingRevealModel.findOne({ lead_id: leadId, field });
    if (session) query.session(session);
    return query.lean<ListingRevealRow>();
  }

  /**
   * L-30: the credits this customer has cost this provider on this listing within `[start, end)`,
   * counting NON-refunded reveals only (a refunded reveal cost the provider nothing).
   */
  async spentBetween(customerId: string, listingId: string, start: Date, end: Date, session?: ClientSession): Promise<number> {
    const pipeline = ListingRevealModel.aggregate<{ total: number }>([
      {
        $match: {
          customer_id: oid(customerId),
          listing_id: oid(listingId),
          at: { $gte: start, $lt: end },
          refund: null,
        },
      },
      { $group: { _id: null, total: { $sum: '$cost' } } },
    ]);
    if (session) pipeline.session(session);
    const [row] = await pipeline;
    return row?.total ?? 0;
  }

  /** L-29: is there an ACTIVE (not lifted) block for this customer on this listing? Read-only. */
  async hasActiveBlock(customerId: string, listingId: string, session?: ClientSession): Promise<boolean> {
    const query = ListingRevealBlockModel.exists({
      customer_id: oid(customerId),
      listing_id: oid(listingId),
      lifted_at: null,
    });
    if (session) query.session(session);
    return (await query) !== null;
  }

  /**
   * The id of the ledger row the reveal's debit wrote (`reason_code: 'listing_reveal'`,
   * `ref: revealId`), read back inside the same transaction so the reveal row can name it.
   */
  async ledgerRefFor(
    vendorId: string,
    revealId: Types.ObjectId,
    session: ClientSession,
    reasonCode: 'listing_reveal' | 'listing_reveal_refund' = 'listing_reveal',
  ): Promise<string | null> {
    const row = await CreditTransactionModel.findOne(
      { owner_type: 'vendor', owner_id: oid(vendorId), reason_code: reasonCode, ref: revealId.toString() },
      { _id: 1 },
    )
      .session(session)
      .lean<{ _id: Types.ObjectId }>();
    return row ? row._id.toString() : null;
  }

  // ─── Beyond the reveal: the lead list, the report and the refund (steps 6, 7) ──

  /** Every reveal of the given leads, oldest first — the lead list's `fields[]`. */
  async findByLeadIds(leadIds: Types.ObjectId[]): Promise<ListingRevealRow[]> {
    if (leadIds.length === 0) return [];
    return ListingRevealModel.find({ lead_id: { $in: leadIds } }).sort({ at: 1, _id: 1 }).lean<ListingRevealRow[]>();
  }

  async findById(revealId: string, session?: ClientSession): Promise<ListingRevealRow | null> {
    if (!Types.ObjectId.isValid(revealId)) return null;
    const query = ListingRevealModel.findById(revealId);
    if (session) query.session(session);
    return query.lean<ListingRevealRow>();
  }

  /**
   * Stamp the refund — a compare-and-set on `refund: null`, so of two administrators refunding
   * the same reveal one wins and the other's transaction aborts with nothing moved. Returns
   * false when the reveal was already refunded.
   */
  async markRefunded(
    revealId: Types.ObjectId,
    refund: Record<string, unknown>,
    session: ClientSession,
  ): Promise<boolean> {
    const res = await ListingRevealModel.updateOne({ _id: revealId, refund: null }, { $set: { refund } }, { session });
    return res.modifiedCount === 1;
  }

  /** Owner, status, kind and listing settings of a provider — the reveal's vendor facts. */
  async vendorFacts(vendorId: string, session?: ClientSession): Promise<RevealVendorFacts | null> {
    if (!Types.ObjectId.isValid(vendorId)) return null;
    const query = VendorModel.findById(vendorId, { user_id: 1, status: 1, kind: 1, listing_settings: 1 });
    if (session) query.session(session);
    const row = await query.lean<{
      user_id?: Types.ObjectId | null;
      status?: string;
      kind?: string;
      listing_settings?: Partial<ListingSettings> | null;
    }>();
    if (!row) return null;
    return {
      userId: row.user_id ? row.user_id.toString() : null,
      // `!== 'inactive'`, never `=== 'active'` — the storefront predicate's rule
      // (`pending_verification` is the registration default).
      active: row.status !== 'inactive',
      isProvider: row.kind === 'provider',
      settings: row.listing_settings ?? null,
    };
  }
}

export const listingRevealRepository = new ListingRevealRepository();
