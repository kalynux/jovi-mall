import { PipelineStage, Types } from 'mongoose';
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
   * Σ over rows of `monthly_storage_fee_per_sku × catalogue quantity`. Computed in
   * the aggregation rather than by summing a page, because a dashboard header that
   * only totals the visible 20 rows is worse than no total at all.
   */
  totalMonthlyEstimate: number;
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
        billableUnits: {
          $sum: {
            $cond: [
              { $eq: ['$variant.isInfiniteStock', true] },
              0,
              { $max: [0, { $ifNull: ['$variant.stock', 0] }] },
            ],
          },
        },
      },
    });

    const [result] = await AgencyStockLevelModel.aggregate(pipeline).exec();

    return {
      skuCount: result?.skuCount ?? 0,
      unassignedCount: result?.unassignedCount ?? 0,
      suspendedCount: (result?.suspendedProductIds ?? []).length,
      totalMonthlyEstimate: (result?.billableUnits ?? 0) * monthlyRatePerSku,
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
   * How many SKUs sit at each of the given depots — the depot-deletion guard's
   * input. Depots with no rows are ABSENT from the map, so read it as
   * `map.get(id) ?? 0`.
   *
   * Counts ROW EXISTENCE, not quantity, and that is deliberate for Phase 1:
   * every derived quantity is 0, so a `quantity > 0` test would never fire and
   * the guard would be decorative. "Products are configured to be stored here"
   * is the true statement this phase can make, and it is exactly what deleting
   * the depot would orphan. When Phase 2 makes counts real, tighten this to
   * `quantity_on_hand > 0 || quantity_reserved > 0`.
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
