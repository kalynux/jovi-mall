import { ClientSession, FilterQuery, Types } from 'mongoose';
import {
  StockAdjustmentRequestModel,
  IStockAdjustmentRequest,
  IStockRequestHistoryEntry,
  StockRequestParty,
  StockRequestStatus,
} from '../models/stock-adjustment-request.model';
import { PaginationOptions, Page } from '../../../core/repositories/base.repository';

export interface StockRequestListFilters {
  status?: StockRequestStatus;
  productId?: string;
  variantId?: string;
  /** `raised_by_me` / `awaiting_me`, resolved against the caller's own role. */
  direction?: 'raised_by_me' | 'awaiting_me';
}

/**
 * A plain repository (not `BaseRepository`) for the same reason
 * `ConnectionRepository` is: the FSM writes need a single flexible
 * transition primitive with a compare-and-set filter, which the generic
 * `update` cannot express.
 *
 * Every read carries `deletedAt: null` explicitly — nothing soft-deletes these
 * rows today, but the filter is cheap and its absence is the kind of thing that
 * quietly resurrects tombstones later.
 */
export class StockAdjustmentRequestRepository {
  async create(
    data: Partial<IStockAdjustmentRequest>,
    session?: ClientSession,
  ): Promise<IStockAdjustmentRequest> {
    const [doc] = await StockAdjustmentRequestModel.create([data], session ? { session } : {});
    return doc;
  }

  async findById(id: string, session?: ClientSession): Promise<IStockAdjustmentRequest | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const query = StockAdjustmentRequestModel.findOne({ _id: id, deletedAt: null });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * The one open request for a variant, if any. Scoped to `pending` because that
   * is what the unique index guarantees is at most one.
   */
  async findPendingByVariant(
    variantId: string,
    session?: ClientSession,
  ): Promise<IStockAdjustmentRequest | null> {
    if (!Types.ObjectId.isValid(variantId)) return null;
    const query = StockAdjustmentRequestModel.findOne({
      variant_id: variantId,
      status: 'pending',
      deletedAt: null,
    });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Open requests for a page of variants, keyed by variant id — the read-model's
   * batched lookup, so annotating an inventory page costs one query regardless of
   * page size.
   */
  async findPendingByVariants(variantIds: string[]): Promise<Map<string, IStockAdjustmentRequest>> {
    const ids = variantIds.filter(id => Types.ObjectId.isValid(id));
    if (ids.length === 0) return new Map();

    const docs = await StockAdjustmentRequestModel.find({
      variant_id: { $in: ids.map(id => new Types.ObjectId(id)) },
      status: 'pending',
      deletedAt: null,
    }).exec();

    return new Map(docs.map(doc => [doc.variant_id.toString(), doc]));
  }

  /**
   * One party's inbox. **Every status by default**, terminal rows included: the
   * list is the only place a party learns the id of a request it raised itself,
   * and a live-only default makes a negotiation history impossible to fetch.
   */
  async listForParty(
    party: StockRequestParty,
    ownerId: string,
    filters: StockRequestListFilters,
    pagination: PaginationOptions,
  ): Promise<Page<IStockAdjustmentRequest>> {
    const { page, limit } = pagination;

    const filter: FilterQuery<IStockAdjustmentRequest> = { deletedAt: null };
    filter[party === 'vendor' ? 'vendor_id' : 'agency_id'] = ownerId as never;
    if (filters.status) filter.status = filters.status;
    if (filters.productId) filter.product_id = filters.productId as never;
    if (filters.variantId) filter.variant_id = filters.variantId as never;

    // `awaiting_me` is "pending AND the other side raised it" — the same predicate
    // the DTO exposes as `awaitingMyDecision`, expressed here so a client can page
    // straight to its action list instead of filtering a page at a time.
    if (filters.direction === 'raised_by_me') {
      filter.requested_by_role = party;
    } else if (filters.direction === 'awaiting_me') {
      filter.requested_by_role = party === 'vendor' ? 'agency' : 'vendor';
      filter.status = 'pending';
    }

    const [total, docs] = await Promise.all([
      StockAdjustmentRequestModel.countDocuments(filter).exec(),
      StockAdjustmentRequestModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Resolve a request with a **compare-and-set** on `status: 'pending'`.
   *
   * A `null` return is a CONFLICT, never a not-found: the row exists, somebody
   * else just resolved it. Callers must map it to `STOCK_REQUEST_NOT_PENDING` and
   * must **not** re-read and retry — the second actor's intent was formed against
   * a state that no longer holds, and re-applying it would resolve a request twice.
   *
   * Deliberately a dumb write: which party may perform which transition lives in
   * `StockRequestService`, mirroring how `ConnectionRepository.applyTransition`
   * keeps the FSM out of the repository.
   */
  async applyTransition(
    id: string,
    update: {
      status: Exclude<StockRequestStatus, 'pending'>;
      set?: Partial<IStockAdjustmentRequest>;
      historyEntry: IStockRequestHistoryEntry;
    },
    session?: ClientSession,
  ): Promise<IStockAdjustmentRequest | null> {
    if (!Types.ObjectId.isValid(id)) return null;

    const query = StockAdjustmentRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending', deletedAt: null },
      {
        $set: { status: update.status, ...(update.set ?? {}) },
        $push: { status_history: update.historyEntry },
      },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  /** How many requests are open across an agency's whole roster — the summary tile. */
  async countPendingForAgency(agencyId: string): Promise<number> {
    if (!Types.ObjectId.isValid(agencyId)) return 0;
    return StockAdjustmentRequestModel.countDocuments({
      agency_id: agencyId,
      status: 'pending',
      deletedAt: null,
    }).exec();
  }
}
