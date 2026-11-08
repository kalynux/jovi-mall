import { buildAccentInsensitiveSearchRegex } from '../../../core/utils/regex.util';
import { ClientSession, Types, PipelineStage, UpdateQuery } from 'mongoose';
import { ListingModel, IListing } from '../models/listing.model';
import { ListingStatus } from '../domain/listing.types';
import { occupyingSlotFilter } from '../domain/listing-rules';
import {
  publishableListingFilter,
  LISTING_VENDOR_PUBLISHABLE_MATCH,
  LISTING_VENDOR_LOOKUP_PROJECTION,
} from '../domain/public-listing.filter';
import { COLLECTIONS } from '../../../core/database/collections';
import { escapeRegex } from '../../../core/utils/regex.util';

/**
 * ListingRepository — persistence for `listings`, the PUBLIC half of a listing.
 *
 * Nothing here can return a contact: the collection holds none (the model's header). Every
 * public read goes through `publicPipeline`, which applies the ONE visibility predicate
 * (`domain/public-listing.filter.ts`); every provider read is scoped by `vendor_id` at the
 * query; every state change is a compare-and-set (`casUpdate`) whose filter names the state
 * the caller read, so two writers never both "win" (409 `LISTING_STATUS_CONFLICT` on a miss).
 */

/** A lean listing row. */
export type ListingRow = IListing & { _id: Types.ObjectId };

export interface PublicListingQuery {
  q?: string;
  categoryId?: string;
  country?: string;
  city?: string;
  area?: string;
  page: number;
  limit: number;
}

const oid = (id: string | Types.ObjectId): Types.ObjectId => (typeof id === 'string' ? new Types.ObjectId(id) : id);
const opts = (session?: ClientSession) => (session ? { session } : {});

/** Case-insensitive EXACT match on a typed place name — escaped, anchored, never a substring. */
function exactInsensitive(value: string): { $regex: string; $options: string } {
  return { $regex: `^${escapeRegex(value.trim())}$`, $options: 'i' };
}

export class ListingRepository {
  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Session writes use the ARRAY form — the only one Mongoose runs inside a transaction. */
  async create(doc: Partial<IListing>, session?: ClientSession): Promise<ListingRow> {
    const [created] = await ListingModel.create([doc], opts(session));
    return created.toObject() as ListingRow;
  }

  /**
   * Compare-and-set: apply `update` only if the row still matches `filter` (which must name the
   * state the caller decided on). Returns the row AFTER the update, or `null` on a miss.
   */
  async casUpdate(
    filter: Record<string, unknown>,
    update: UpdateQuery<IListing>,
    session?: ClientSession,
  ): Promise<ListingRow | null> {
    return ListingModel.findOneAndUpdate(filter, update, { new: true, ...opts(session) }).lean<ListingRow>();
  }

  /** Unconditional field write (bookkeeping only — vectorisation columns, never a status). */
  async setFields(id: string, $set: Record<string, unknown>, session?: ClientSession): Promise<void> {
    await ListingModel.updateOne({ _id: oid(id) }, { $set }, opts(session));
  }

  /**
   * The vectoriser callback's claim: write `$set` only if the row still carries THIS job's
   * ticket. Returns the row as it was BEFORE (so `billed` and the live status are read off the
   * claimed attempt), or `null` when the report is late, duplicated or superseded.
   */
  async claimVectorisationJob(id: string, jobId: string, $set: Record<string, unknown>): Promise<ListingRow | null> {
    return ListingModel.findOneAndUpdate(
      { _id: oid(id), 'vectorisation_job.jobId': jobId },
      { $set },
      { new: false },
    ).lean<ListingRow>();
  }

  // ── Provider reads ─────────────────────────────────────────────────────────

  async findOwned(id: string, vendorId: string, session?: ClientSession): Promise<ListingRow | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(vendorId)) return null;
    const query = ListingModel.findOne({ _id: oid(id), vendor_id: oid(vendorId) });
    if (session) query.session(session);
    return query.lean<ListingRow>();
  }

  async findById(id: string, session?: ClientSession): Promise<ListingRow | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const query = ListingModel.findById(oid(id));
    if (session) query.session(session);
    return query.lean<ListingRow>();
  }

  async listOwned(
    vendorId: string,
    status: ListingStatus | undefined,
    page: number,
    limit: number,
    q?: string,
  ): Promise<{ data: ListingRow[]; total: number }> {
    const filter: Record<string, unknown> = { vendor_id: oid(vendorId) };
    if (status) filter.status = status;
    // The provider's own search (2026-11-08): title and company name, on the working copy and
    // the live one — a draft has only `pending`, a live listing mid-revision has both, and the
    // provider must find it by either name. Scoped by `vendor_id` above, like every read here.
    if (q) {
      const match = buildAccentInsensitiveSearchRegex(q);
      filter.$or = ['pending.title', 'pending.company_name', 'published.title', 'published.company_name']
        .map((path) => ({ [path]: match }));
    }
    const [data, total] = await Promise.all([
      ListingModel.find(filter).sort({ created_at: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean<ListingRow[]>(),
      ListingModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  /** Listings occupying a plan slot (§ C-8a), optionally not counting one of them. */
  async countOccupyingSlots(vendorId: string, excludeId?: string): Promise<number> {
    const filter: Record<string, unknown> = { vendor_id: oid(vendorId), ...occupyingSlotFilter() };
    if (excludeId) filter._id = { $ne: oid(excludeId) };
    return ListingModel.countDocuments(filter);
  }

  async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
    const filter: Record<string, unknown> = { slug };
    if (exceptId) filter._id = { $ne: oid(exceptId) };
    return (await ListingModel.exists(filter)) !== null;
  }

  // ── Funding (L-10) ─────────────────────────────────────────────────────────

  /** One vendor's listings in a given status (ids + the suspension block). */
  async findForFunding(
    vendorId: string,
    filter: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<Array<Pick<ListingRow, '_id' | 'status' | 'suspension' | 'vectorised_data_id'>>> {
    const query = ListingModel.find({ vendor_id: oid(vendorId), ...filter }, { status: 1, suspension: 1, vectorised_data_id: 1 });
    if (session) query.session(session);
    return query.lean();
  }

  /** Vendors whose funding state may need a recompute: anything live or credit-suspended. */
  async vendorIdsForFundingSweep(): Promise<string[]> {
    const ids = await ListingModel.distinct('vendor_id', {
      $or: [{ status: 'live' }, { status: 'suspended', 'suspension.reason': 'insufficient_credits' }],
    });
    return ids.map((id: Types.ObjectId) => id.toString());
  }

  /**
   * Role closure (§ C-8a): archive every non-archived listing of a vendor, inside the closure
   * transaction. Returns the ids moved and their index ids, so the caller can drop them from
   * the AI index after the commit.
   */
  async archiveAllForVendor(
    vendorId: string,
    session?: ClientSession,
  ): Promise<Array<{ id: string; vectorisedDataId: string | null }>> {
    const query = ListingModel.find({ vendor_id: oid(vendorId), status: { $ne: 'archived' } }, { vectorised_data_id: 1 });
    if (session) query.session(session);
    const rows = await query.lean<Array<{ _id: Types.ObjectId; vectorised_data_id: string | null }>>();
    if (rows.length === 0) return [];
    const now = new Date();
    await ListingModel.updateMany(
      { _id: { $in: rows.map((r) => r._id) }, status: { $ne: 'archived' } },
      { $set: { status: 'archived', archived_at: now, suspension: null, pending: null, review: null } },
      opts(session),
    );
    return rows.map((r) => ({ id: r._id.toString(), vectorisedDataId: r.vectorised_data_id ?? null }));
  }

  // ── Public reads — always through the ONE predicate ────────────────────────

  private publicPipeline(match: Record<string, unknown>): PipelineStage[] {
    return [
      { $match: { ...match, ...publishableListingFilter() } },
      {
        $lookup: {
          from: COLLECTIONS.VENDOR,
          localField: 'vendor_id',
          foreignField: '_id',
          pipeline: [{ $project: { ...LISTING_VENDOR_LOOKUP_PROJECTION } }],
          as: 'vendor',
        },
      },
      { $unwind: '$vendor' },
      { $match: { ...LISTING_VENDOR_PUBLISHABLE_MATCH } },
    ];
  }

  async searchPublishable(query: PublicListingQuery): Promise<{ data: ListingRow[]; total: number }> {
    const match: Record<string, unknown> = {};
    // `$text` must sit in the FIRST `$match` of the pipeline, which `publicPipeline` builds.
    if (query.q) match.$text = { $search: query.q };
    if (query.categoryId) match['published.category_ids'] = oid(query.categoryId);
    if (query.country) match['published.country'] = query.country.toUpperCase();
    if (query.city) match['published.city'] = exactInsensitive(query.city);
    if (query.area) match['published.area'] = exactInsensitive(query.area);

    const sort: Record<string, 1 | -1 | { $meta: 'textScore' }> = query.q
      ? { score: { $meta: 'textScore' }, published_at: -1, _id: -1 }
      : { published_at: -1, _id: -1 };

    const [result] = await ListingModel.aggregate<{ data: ListingRow[]; total: Array<{ n: number }> }>([
      ...this.publicPipeline(match),
      ...(query.q ? [{ $addFields: { score: { $meta: 'textScore' } } } as PipelineStage] : []),
      {
        $facet: {
          data: [
            { $sort: sort } as PipelineStage.FacetPipelineStage,
            { $skip: (query.page - 1) * query.limit },
            { $limit: query.limit },
            { $project: { vendor: 0, score: 0 } },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);
    return { data: result?.data ?? [], total: result?.total?.[0]?.n ?? 0 };
  }

  async findPublishableByIds(ids: string[]): Promise<ListingRow[]> {
    const valid = ids.filter((id) => Types.ObjectId.isValid(id)).map(oid);
    if (valid.length === 0) return [];
    return ListingModel.aggregate<ListingRow>([
      ...this.publicPipeline({ _id: { $in: valid } }),
      { $project: { vendor: 0 } },
    ]);
  }

  async findPublishableBySlug(slug: string): Promise<ListingRow | null> {
    const [row] = await ListingModel.aggregate<ListingRow>([
      ...this.publicPipeline({ slug }),
      { $project: { vendor: 0 } },
      { $limit: 1 },
    ]);
    return row ?? null;
  }

  /** The spreadsheet/payload pull: publishable listings only (the index holds nothing else). */
  async findIndexable(ids: string[]): Promise<ListingRow[]> {
    return this.findPublishableByIds(ids);
  }
}

export const listingRepository = new ListingRepository();
