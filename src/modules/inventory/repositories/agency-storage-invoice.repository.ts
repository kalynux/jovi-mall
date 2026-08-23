import { Types } from 'mongoose';
import {
  AgencyStorageInvoiceModel,
  IAgencyStorageInvoice,
  IStorageInvoiceLine,
  StorageInvoiceStatus,
} from '../models/agency-storage-invoice.model';

export interface StorageInvoiceDraft {
  agencyId: string;
  vendorId: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  monthlyRatePerSku: number;
  lines: IStorageInvoiceLine[];
}

export interface InvoiceQuery {
  status?: StorageInvoiceStatus;
  periodKey?: string;
  /** Agency-side filter: statements for one vendor. Ignored on the vendor's own list. */
  vendorId?: string;
  agencyId?: string;
}

export class AgencyStorageInvoiceRepository {
  /**
   * Issue a statement, or return the one already issued for that month.
   *
   * `$setOnInsert` on **everything** — a re-run must never restate a month. That is what
   * makes the monthly worker safe to trigger by hand, safe across a restart mid-sweep, and
   * safe on two instances: the unique `(agency, vendor, period_key)` index decides the
   * winner and the loser reads back what the winner wrote.
   *
   * Returns `{ invoice, created }` so a caller can report how many statements a run actually
   * produced rather than how many it considered.
   */
  async issueOnce(draft: StorageInvoiceDraft): Promise<{ invoice: IAgencyStorageInvoice; created: boolean }> {
    const filter = {
      agency_id: new Types.ObjectId(draft.agencyId),
      vendor_id: new Types.ObjectId(draft.vendorId),
      period_key: draft.periodKey,
      deletedAt: null,
    };

    const unitCount = draft.lines.reduce((sum, line) => sum + line.quantity, 0);
    const total = draft.lines.reduce((sum, line) => sum + line.line_total, 0);

    const before = await AgencyStorageInvoiceModel.findOne(filter).exec();
    if (before) return { invoice: before, created: false };

    const invoice = await AgencyStorageInvoiceModel.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          period_start: draft.periodStart,
          period_end: draft.periodEnd,
          lines: draft.lines,
          sku_count: draft.lines.length,
          unit_count: unitCount,
          total,
          monthly_rate_per_sku: draft.monthlyRatePerSku,
          status: 'open',
          issued_at: new Date(),
          settled_at: null,
          settled_by_user_id: null,
          note: null,
          deletedAt: null,
          purgeAt: null,
        },
      },
      { new: true, upsert: true },
    ).exec();

    // `created` is decided by the pre-read, not by comparing timestamps: an upsert that lost
    // the race returns the winner's document, and reporting that as created would double-count
    // it in the worker's log.
    return { invoice, created: true };
  }

  async paginate(
    query: InvoiceQuery,
    page: number,
    limit: number,
  ): Promise<{ data: IAgencyStorageInvoice[]; total: number }> {
    const filter: Record<string, unknown> = { deletedAt: null };
    if (query.agencyId) filter.agency_id = new Types.ObjectId(query.agencyId);
    if (query.vendorId) filter.vendor_id = new Types.ObjectId(query.vendorId);
    if (query.status) filter.status = query.status;
    if (query.periodKey) filter.period_key = query.periodKey;

    const [data, total] = await Promise.all([
      AgencyStorageInvoiceModel.find(filter)
        .sort({ period_key: -1, issued_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      AgencyStorageInvoiceModel.countDocuments(filter).exec(),
    ]);
    return { data, total };
  }

  /**
   * One statement, scoped to whoever is asking.
   *
   * Both scopes go in the QUERY, so somebody else's statement is a 404 rather than a 403 —
   * whether a given id exists is not information either party is owed about the other.
   */
  async findScoped(
    id: string,
    scope: { agencyId?: string; vendorId?: string },
  ): Promise<IAgencyStorageInvoice | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const filter: Record<string, unknown> = { _id: new Types.ObjectId(id), deletedAt: null };
    if (scope.agencyId) filter.agency_id = new Types.ObjectId(scope.agencyId);
    if (scope.vendorId) filter.vendor_id = new Types.ObjectId(scope.vendorId);
    return AgencyStorageInvoiceModel.findOne(filter).exec();
  }

  /**
   * Move a statement out of `open`, compare-and-set.
   *
   * The filter carries `status: 'open'`, so a null return means the state moved under the
   * caller — a CONFLICT, never a not-found. Same shape as every other verdict write here.
   */
  async transitionFromOpen(
    id: string,
    agencyId: string,
    to: Exclude<StorageInvoiceStatus, 'open'>,
    actorUserId: string | null,
    note: string | null,
  ): Promise<IAgencyStorageInvoice | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return AgencyStorageInvoiceModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        agency_id: new Types.ObjectId(agencyId),
        status: 'open',
        deletedAt: null,
      },
      {
        $set: {
          status: to,
          settled_at: to === 'settled' ? new Date() : null,
          settled_by_user_id: to === 'settled' && actorUserId ? new Types.ObjectId(actorUserId) : null,
          note,
        },
      },
      { new: true },
    ).exec();
  }
}

export const agencyStorageInvoiceRepository = new AgencyStorageInvoiceRepository();
