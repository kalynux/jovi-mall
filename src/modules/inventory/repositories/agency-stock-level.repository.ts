import { ClientSession, PipelineStage, Types } from 'mongoose';
import { AgencyStockLevelModel, IAgencyStockLevel } from '../models/agency-stock-level.model';
import { COLLECTIONS } from '../../../core/database/collections';

/** One derived (agency, depot, vendor, product, variant) tuple the reconciler wants persisted. */
export interface DerivedStockRow {
  agencyId: string;
  locationId: string | null;
  vendorId: string;
  productId: string;
  variantId: string;
}

/** A stock row joined to the catalog fields the screen shows and searches on. */
export interface StockLevelRow {
  id: string;
  agencyId: string;
  locationId: string | null;
  vendorId: string;
  productId: string;
  variantId: string;
  quantityOnHand: number;
  quantityReserved: number;
  source: 'derived' | 'counted';
  lastReconciledAt: Date;
  /** From the variant. Null when the variant has since been deleted. */
  sku: string | null;
  variantTitle: string | null;
  /** From the product. */
  productTitle: string | null;

  /**
   * The CATALOGUE quantity for this SKU (`ProductVariant.stock`) — deliberately
   * distinct from `quantityOnHand`, which is Phase 2's counted figure and is still
   * 0 on every row. This is the number the two parties negotiate and the storage
   * fee is quoted against. Null when the variant has been deleted.
   */
  catalogQuantity: number | null;
  catalogIsInfinite: boolean | null;

  /** Variant dimensions, then the product's shipping-config defaults. */
  variantDimensions: RowDimensions | null;
  productDimensions: RowDimensions | null;

  /**
   * The product's own status and suspension snapshot. Present because the roster
   * keeps rows for products the AGENCY has storage-suspended — that suspension must
   * not delete the row its own unsuspend button lives on.
   */
  productStatus: string | null;
  suspension: {
    reason: string;
    previousStatus: string;
    suspendedAt: Date;
    suspendedByAgencyId: string | null;
    note: string | null;
  } | null;
}

export interface RowDimensions {
  weight: number | null;
  length: number | null;
  width: number | null;
  height: number | null;
}

/** The whole-magazine roll-up behind `GET /api/agency/inventory/summary`. */
export interface StockLevelSummary {
  skuCount: number;
  /** Rows whose depot the agency has deleted — `location: null` on the list. */
  unassignedCount: number;
  /** Distinct products the agency has storage-suspended. */
  suspendedCount: number;
  /**
   * Σ over rows of `monthly_storage_fee_per_sku × COUNTED quantity on hand`. Computed in
   * the aggregation rather than by summing a page, because a dashboard header that only
   * totals the visible 20 rows is worse than no total at all.
   *
   * ⚠ It used to multiply by the CATALOGUE quantity, because no counted one existed
   * (Step 14 / D-6). An agency that has recorded no intake now totals **0** where it
   * previously saw a figure — which is the honest answer, and is why `countedRows` sits
   * beside it: a header must be able to say "nothing counted yet" rather than "nothing owed".
   */
  totalMonthlyEstimate: number;
  /** Rows whose quantities somebody has actually counted. */
  countedRows: number;
  /** Rows that exist because a product is configured here, and were never counted. */
  derivedRows: number;
}

export interface StockLevelFilters {
  /** A depot id, or the literal 'unassigned' for rows whose depot no longer exists. */
  locationId?: string | 'unassigned';
  vendorId?: string;
  /** Free-text over variant SKU and product title. */
  search?: string;
}

export interface StockLevelPage {
  data: StockLevelRow[];
  total: number;
}

/**
 * Reads and writes `agency_stock_levels`.
 *
 * **Deliberately not a `BaseRepository`.** That base requires an `IMapper` and
 * exposes `paginate` over a plain filter, and the list query here has to search
 * across the *variant's* SKU and the *product's* title — fields on two other
 * collections. A `$lookup` aggregation is the only way to express that, so the
 * base class would be carried without being used. `MagazinRepository` and
 * `StoreRepository` are plain classes for the same reason. The one thing that
 * must not be lost is the soft-delete filter, so **every** query below carries
 * `deletedAt: null` explicitly.
 */
export class AgencyStockLevelRepository {
  /** Join the catalog fields the screen needs, then filter/search/paginate over them. */
  async paginateForAgency(
    agencyId: string,
    filters: StockLevelFilters,
    pagination: { page: number; limit: number; sort?: Record<string, 1 | -1> },
  ): Promise<StockLevelPage> {
    const match: Record<string, unknown> = {
      agency_id: new Types.ObjectId(agencyId),
      deletedAt: null,
    };
    if (filters.locationId === 'unassigned') {
      match.location_id = null;
    } else if (filters.locationId) {
      match.location_id = new Types.ObjectId(filters.locationId);
    }
    if (filters.vendorId) match.vendor_id = new Types.ObjectId(filters.vendorId);

    const pipeline: PipelineStage[] = [{ $match: match }, ...CATALOG_JOIN_STAGES];

    // Search runs AFTER the joins because both searchable fields come from them.
    if (filters.search) {
      const rx = new RegExp(escapeRegex(filters.search), 'i');
      pipeline.push({ $match: { $or: [{ 'variant.sku': rx }, { 'product.title': rx }] } });
    }

    const skip = (pagination.page - 1) * pagination.limit;
    // $facet so the filtered count and the page come from ONE pass over the same
    // pipeline — recomputing the joins for a separate countDocuments would risk
    // the two disagreeing under concurrent writes.
    pipeline.push({
      $facet: {
        data: [
          { $sort: pagination.sort ?? { createdAt: -1 } },
          { $skip: skip },
          { $limit: pagination.limit },
        ],
        totalCount: [{ $count: 'value' }],
      },
    });

    const [result] = await AgencyStockLevelModel.aggregate(pipeline).exec();
    const rows = (result?.data ?? []) as Array<Record<string, any>>;

    return {
      data: rows.map(toStockLevelRow),
      total: result?.totalCount?.[0]?.value ?? 0,
    };
  }

  /** One row, scoped to the agency so a stray id can never leak another's inventory. */
  async findByIdForAgency(id: string, agencyId: string): Promise<StockLevelRow | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const page = await this.paginateForAgencyByIds([id], agencyId);
    return page[0] ?? null;
  }

  /** Shared join path, so detail and list can never describe a row differently. */
  private async paginateForAgencyByIds(ids: string[], agencyId: string): Promise<StockLevelRow[]> {
    const rows = await AgencyStockLevelModel.aggregate([
      {
        $match: {
          _id: { $in: ids.map(id => new Types.ObjectId(id)) },
          agency_id: new Types.ObjectId(agencyId),
          deletedAt: null,
        },
      },
      ...CATALOG_JOIN_STAGES,
    ]).exec();
    return (rows as Array<Record<string, any>>).map(toStockLevelRow);
  }

  /**
   * Every row this agency holds for one product — the ownership predicate for all
   * three product-level agency actions (re-point the depot, suspend, unsuspend).
   *
   * Deliberately the authorisation check: it avoids a cross-vendor product query,
   * and an empty result is the honest "you do not warehouse this" answer. It also
   * hands back `vendorId`, which every one of those writes needs to scope its
   * product update.
   */
  async findRowsForAgencyAndProduct(agencyId: string, productId: string): Promise<StockLevelRow[]> {
    if (!Types.ObjectId.isValid(productId) || !Types.ObjectId.isValid(agencyId)) return [];

    const rows = await AgencyStockLevelModel.aggregate([
      {
        $match: {
          agency_id: new Types.ObjectId(agencyId),
          product_id: new Types.ObjectId(productId),
          deletedAt: null,
        },
      },
      ...CATALOG_JOIN_STAGES,
    ]).exec();
    return (rows as Array<Record<string, any>>).map(toStockLevelRow);
  }

  /**
   * Every COUNTED row this agency holds, joined to the catalogue — the storage invoice's
   * input.
   *
   * Unpaginated on purpose: a statement that stopped at a page boundary would bill part of a
   * magazine and look complete. Bounded in practice by how many SKUs an agency has actually
   * taken in, which is the same order as its roster.
   *
   * DERIVED rows are excluded because nobody counted them, so there is no quantity this
   * could honestly charge for — the same rule resolveStorageQuantity applies per row.
   */
  async findCountedRowsForAgency(agencyId: string): Promise<StockLevelRow[]> {
    if (!Types.ObjectId.isValid(agencyId)) return [];

    const rows = await AgencyStockLevelModel.aggregate([
      {
        $match: {
          agency_id: new Types.ObjectId(agencyId),
          deletedAt: null,
          source: 'counted',
          quantity_on_hand: { $gt: 0 },
        },
      },
      ...CATALOG_JOIN_STAGES,
    ]).exec();
    return (rows as Array<Record<string, any>>).map(toStockLevelRow);
  }

  /**
   * The whole-magazine roll-up, over the SAME filters as the list so the header and
   * the rows below it agree.
   *
   * `monthlyRatePerSku` is passed in rather than looked up: the rate lives on the
   * DeliveryAgency's policies, which this repository has no business reading, and
   * the caller has already loaded it to quote per row.
   */
  async summaryForAgency(
    agencyId: string,
    filters: StockLevelFilters,
    monthlyRatePerSku: number,
  ): Promise<StockLevelSummary> {
    const match: Record<string, unknown> = {
      agency_id: new Types.ObjectId(agencyId),
      deletedAt: null,
    };
    if (filters.locationId === 'unassigned') {
      match.location_id = null;
    } else if (filters.locationId) {
      match.location_id = new Types.ObjectId(filters.locationId);
    }
    if (filters.vendorId) match.vendor_id = new Types.ObjectId(filters.vendorId);

    const pipeline: PipelineStage[] = [{ $match: match }, ...CATALOG_JOIN_STAGES];

    if (filters.search) {
      const rx = new RegExp(escapeRegex(filters.search), 'i');
      pipeline.push({ $match: { $or: [{ 'variant.sku': rx }, { 'product.title': rx }] } });
    }

    pipeline.push({
      $group: {
        _id: null,
        skuCount: { $sum: 1 },
        unassignedCount: { $sum: { $cond: [{ $eq: ['$location_id', null] }, 1, 0] } },
        // Products, not rows: a product with three variants is one suspension, and
        // reporting 3 would overstate how much is switched off.
        suspendedProductIds: {
          $addToSet: {
            $cond: [
              { $eq: ['$product.suspension.reason', 'agency_storage_suspended'] },
              '$product_id',
              '$$REMOVE',
            ],
          },
        },
        // An infinite-stock SKU contributes 0, matching `resolveStorageQuantity` —
        // inventing a quantity for it would be a fabricated charge.
        // The COUNTED shelf, not the catalogue quantity — `resolveStorageQuantity` makes the
        // same choice for a single row, and the header must agree with the rows under it.
        // An uncounted row contributes 0; so does a negative one, which means the record is
        // in variance and there is nothing here that can honestly be billed.
        billableUnits: {
          $sum: {
            $cond: [
              { $eq: ['$source', 'counted'] },
              { $max: [0, { $ifNull: ['$quantity_on_hand', 0] }] },
              0,
            ],
          },
        },
        countedRows: { $sum: { $cond: [{ $eq: ['$source', 'counted'] }, 1, 0] } },
        derivedRows: { $sum: { $cond: [{ $eq: ['$source', 'counted'] }, 0, 1] } },
      },
    });

    const [result] = await AgencyStockLevelModel.aggregate(pipeline).exec();

    return {
      skuCount: result?.skuCount ?? 0,
      unassignedCount: result?.unassignedCount ?? 0,
      suspendedCount: (result?.suspendedProductIds ?? []).length,
      totalMonthlyEstimate: (result?.billableUnits ?? 0) * monthlyRatePerSku,
      countedRows: result?.countedRows ?? 0,
      derivedRows: result?.derivedRows ?? 0,
    };
  }

  /**
   * Upsert the derived roster in one round trip, stamping every touched row with
   * the same `reconciledAt`. That shared timestamp is what makes `retireDerivedBefore`
   * below a correct sweep — see there.
   *
   * Only ever writes `source: 'derived'` and never touches the quantity fields,
   * so a Phase-2 row carrying real counts is not reset by a config-driven pass.
   */
  async bulkUpsertDerived(rows: DerivedStockRow[], reconciledAt: Date): Promise<number> {
    if (rows.length === 0) return 0;

    const result = await AgencyStockLevelModel.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: {
            agency_id: new Types.ObjectId(row.agencyId),
            variant_id: new Types.ObjectId(row.variantId),
            location_id: row.locationId ? new Types.ObjectId(row.locationId) : null,
            deletedAt: null,
          },
          update: {
            $set: {
              vendor_id: new Types.ObjectId(row.vendorId),
              product_id: new Types.ObjectId(row.productId),
              last_reconciled_at: reconciledAt,
            },
            // Only on insert: a row that already exists may have been promoted to
            // 'counted' with real quantities, and re-deriving must not undo that.
            $setOnInsert: {
              source: 'derived',
              quantity_on_hand: 0,
              quantity_reserved: 0,
              deletedAt: null,
              purgeAt: null,
            },
          },
          upsert: true,
        },
      })),
    );
    return result.upsertedCount + result.modifiedCount;
  }

  /**
   * Retire every DERIVED row for this agency that the pass just finished did not
   * touch — mark-and-sweep, using the shared `reconciledAt` as the mark.
   *
   * Preferred over computing a set difference in memory: the derived set can be
   * large, and `$nor` over thousands of composite keys is neither indexable nor
   * bounded in size.
   *
   * `source: 'counted'` is excluded on purpose. Once a row carries real counts,
   * a vendor flipping their fulfilment config must not silently delete the record
   * that says goods are physically on the agency's shelf — that needs a human
   * decision (Phase 3's transfer/write-off flow), not a sweep.
   */
  async retireDerivedBefore(agencyId: string, reconciledAt: Date): Promise<number> {
    const result = await AgencyStockLevelModel.updateMany(
      {
        agency_id: new Types.ObjectId(agencyId),
        deletedAt: null,
        source: 'derived',
        last_reconciled_at: { $lt: reconciledAt },
      },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  /** The newest `last_reconciled_at` for an agency; null when it has no rows yet. */
  async findLastReconciledAt(agencyId: string): Promise<Date | null> {
    const row = await AgencyStockLevelModel.findOne({
      agency_id: new Types.ObjectId(agencyId),
      deletedAt: null,
    })
      .sort({ last_reconciled_at: -1 })
      .select('last_reconciled_at')
      .lean()
      .exec();
    return row?.last_reconciled_at ?? null;
  }

  /**
   * What each of these variants has COUNTED on a shelf, keyed by variant id.
   *
   * A variant maps to at most one counted row (one effective agency, one depot), so this
   * is a lookup rather than a sum. Absent from the map means "nobody has counted it",
   * which is deliberately distinguishable from a counted zero — see
   * `resolveStorageQuantity`, where the two produce the same number and must not produce
   * the same sentence on a screen.
   */
  async warehousedByVariant(variantIds: string[]): Promise<Map<string, number>> {
    const valid = variantIds.filter(id => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Map();

    const rows = await AgencyStockLevelModel.find({
      variant_id: { $in: valid.map(id => new Types.ObjectId(id)) },
      source: 'counted',
      deletedAt: null,
    })
      .select('variant_id quantity_on_hand')
      .lean()
      .exec();

    return new Map(rows.map(r => [String(r.variant_id), r.quantity_on_hand ?? 0]));
  }

  /**
   * Force a row's counters to given values. The drift repair, and nothing else.
   *
   * ⚠ The ONLY write to these two fields that does not go through
   * `AgencyStockMovementRepository`, and it exists to restore the invariant that
   * repository maintains rather than to move stock. Do not reach for it to implement a
   * verb — a quantity that changes with no movement row is precisely the state
   * `findDrift` reports as a bug.
   */
  async setCounters(
    agencyId: string,
    stockLevelId: string,
    onHand: number,
    reserved: number,
  ): Promise<void> {
    await AgencyStockLevelModel.updateOne(
      {
        _id: new Types.ObjectId(stockLevelId),
        agency_id: new Types.ObjectId(agencyId),
        deletedAt: null,
      },
      { $set: { quantity_on_hand: onHand, quantity_reserved: reserved } },
    ).exec();
  }

  /**
   * The raw document, scoped to the agency.
   *
   * Distinct from `findByIdForAgency`, which returns the joined READ model. The
   * counted-stock verbs need the row itself — its current counters, its variant and
   * its depot — inside the same transaction that is about to move it.
   */
  async findRawByIdForAgency(
    id: string,
    agencyId: string,
    session?: ClientSession,
  ): Promise<IAgencyStockLevel | null> {
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(agencyId)) return null;
    const query = AgencyStockLevelModel.findOne({
      _id: new Types.ObjectId(id),
      agency_id: new Types.ObjectId(agencyId),
      deletedAt: null,
    });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * The row a transfer is moving stock INTO, created if this agency has never held
   * that SKU at that depot.
   *
   * Stamped `counted` on creation, and that is what keeps it alive: the reconciler
   * retires only `derived` rows, so a destination the catalogue does not name — the
   * ordinary case, since the product still names the depot it was configured with —
   * survives the next sweep instead of vanishing with the goods on it.
   */
  async findOrCreateCountedRow(
    agencyId: string,
    locationId: string | null,
    template: { vendorId: Types.ObjectId; productId: Types.ObjectId; variantId: Types.ObjectId },
    session: ClientSession,
  ): Promise<IAgencyStockLevel> {
    const filter = {
      agency_id: new Types.ObjectId(agencyId),
      variant_id: template.variantId,
      location_id: locationId ? new Types.ObjectId(locationId) : null,
      deletedAt: null,
    };

    const row = await AgencyStockLevelModel.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          vendor_id: template.vendorId,
          product_id: template.productId,
          quantity_on_hand: 0,
          quantity_reserved: 0,
          source: 'counted',
          last_reconciled_at: new Date(),
          deletedAt: null,
          purgeAt: null,
        },
      },
      { new: true, upsert: true, session },
    ).exec();

    return row;
  }

  /**
   * Every live row for an agency, as raw documents — the reconciler drift pass.
   *
   * `derived` rows are included on purpose: a derived row that somehow holds a
   * non-zero counter is precisely the drift worth reporting.
   */
  async findAllRawForAgency(agencyId: string): Promise<IAgencyStockLevel[]> {
    if (!Types.ObjectId.isValid(agencyId)) return [];
    return AgencyStockLevelModel.find({
      agency_id: new Types.ObjectId(agencyId),
      deletedAt: null,
    }).exec();
  }

  /**
   * The counted row holding this variant, if one exists.
   *
   * The order path's entry point. A variant maps to at most one row: a product names
   * ONE effective agency and ONE depot, so there is no ambiguity to resolve here — and
   * `derived` rows are excluded because nobody has counted them, so an order must not
   * drive their counters (D-6).
   */
  async findCountedByVariant(variantId: string): Promise<IAgencyStockLevel | null> {
    if (!Types.ObjectId.isValid(variantId)) return null;
    return AgencyStockLevelModel.findOne({
      variant_id: new Types.ObjectId(variantId),
      source: 'counted',
      deletedAt: null,
    }).exec();
  }
  /**
   * How many SKUs sit at each of the given depots — the depot-deletion guard's
   * input. Depots with no rows are ABSENT from the map, so read it as
   * `map.get(id) ?? 0`.
   *
   * Counts rows that HOLD SOMETHING — `quantity_on_hand > 0 || quantity_reserved > 0`.
   *
   * ⚠ This changed in Step 14 and the change has a visible consequence. It used to count
   * row EXISTENCE, because every quantity was 0 and a quantity test would never have fired;
   * the true statement available then was "products are configured to be stored here".
   * Now that counts are real, a depot holding only `derived` rows — configured, never
   * counted — no longer blocks its own removal. Those rows are not lost: the next reconcile
   * resolves them to `location_id: null` and the screen surfaces them as **unassigned**,
   * which is what that state is for. What must not happen is the opposite — a depot with
   * goods actually on its shelves being deletable — and that is what this now prevents.
   *
   * A NEGATIVE balance counts as holding something too, deliberately: it means the shelf
   * record is in variance, and deleting the building it refers to is the last thing anybody
   * should be able to do before settling it.
   */
  async countByLocations(agencyId: string, locationIds: string[]): Promise<Map<string, number>> {
    const valid = locationIds.filter(id => Types.ObjectId.isValid(id));
    if (valid.length === 0) return new Map();

    const rows = await AgencyStockLevelModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      {
        $match: {
          agency_id: new Types.ObjectId(agencyId),
          deletedAt: null,
          location_id: { $in: valid.map(id => new Types.ObjectId(id)) },
          $or: [
            { quantity_on_hand: { $ne: 0 } },
            { quantity_reserved: { $ne: 0 } },
          ],
        },
      },
      { $group: { _id: '$location_id', count: { $sum: 1 } } },
    ]).exec();

    return new Map(rows.map(r => [r._id.toString(), r.count]));
  }
}

/**
 * The catalog joins every read here shares.
 *
 * All three lookups are `preserveNullAndEmptyArrays`: a product, variant or shipping
 * config deleted out from under a row still renders as a row with nulls rather than
 * vanishing — an agency must not lose sight of goods because a vendor tidied their
 * catalogue.
 *
 * Extracted so the list, the detail, the per-product read and the summary cannot
 * describe the same row differently — the reason the detail path already delegated
 * to a shared helper before the joins grew.
 */
const CATALOG_JOIN_STAGES: PipelineStage[] = [
  { $lookup: { from: COLLECTIONS.PRODUCT_VARIANT, localField: 'variant_id', foreignField: '_id', as: 'variant' } },
  { $unwind: { path: '$variant', preserveNullAndEmptyArrays: true } },
  { $lookup: { from: COLLECTIONS.PRODUCT, localField: 'product_id', foreignField: '_id', as: 'product' } },
  { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
  // The product's default dimensions, for the storage-fee size column when the
  // variant carries none of its own.
  { $lookup: { from: COLLECTIONS.SHIPPING_CONFIG, localField: 'product_id', foreignField: 'productId', as: 'shipping' } },
  { $unwind: { path: '$shipping', preserveNullAndEmptyArrays: true } },
];

/** Escape a user-supplied search term so it cannot inject regex syntax. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pull the four dimension fields off whatever carries them, or null if none do. */
function toDimensions(source: Record<string, any> | null | undefined): RowDimensions | null {
  if (!source) return null;
  const dims = {
    weight: source.weight ?? null,
    length: source.length ?? null,
    width: source.width ?? null,
    height: source.height ?? null,
  };
  const hasAny = Object.values(dims).some(v => v !== null);
  return hasAny ? dims : null;
}

function toStockLevelRow(doc: Record<string, any>): StockLevelRow {
  return {
    id: doc._id.toString(),
    agencyId: doc.agency_id.toString(),
    locationId: doc.location_id ? doc.location_id.toString() : null,
    vendorId: doc.vendor_id.toString(),
    productId: doc.product_id.toString(),
    variantId: doc.variant_id.toString(),
    quantityOnHand: doc.quantity_on_hand ?? 0,
    quantityReserved: doc.quantity_reserved ?? 0,
    source: doc.source ?? 'derived',
    lastReconciledAt: doc.last_reconciled_at,
    // The joins are `preserveNullAndEmptyArrays` — a product or variant deleted
    // out from under a row still renders, rather than dropping the row silently.
    sku: doc.variant?.sku ?? null,
    variantTitle: doc.variant?.name ?? null,
    productTitle: doc.product?.title ?? null,

    catalogQuantity: doc.variant ? (doc.variant.stock ?? 0) : null,
    catalogIsInfinite: doc.variant ? (doc.variant.isInfiniteStock ?? false) : null,

    variantDimensions: toDimensions(doc.variant),
    // ShippingConfig carries the four fields flat, same names as the variant.
    productDimensions: toDimensions(doc.shipping),

    productStatus: doc.product?.status ?? null,
    suspension: doc.product?.suspension
      ? {
        reason: doc.product.suspension.reason,
        previousStatus: doc.product.suspension.previousStatus,
        suspendedAt: doc.product.suspension.suspendedAt,
        suspendedByAgencyId: doc.product.suspension.suspendedByAgencyId
          ? doc.product.suspension.suspendedByAgencyId.toString()
          : null,
        note: doc.product.suspension.note ?? null,
      }
      : null,
  };
}

export type { IAgencyStockLevel };
