import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { resolveProductImages, productImageKey } from '../../catalog/read-models/product-image.resolver';
import { IStorageProvider } from '../../../core/storage';
import { AddressDetail, fromHqAddress } from '../../../core/read-models/address-detail.resolver';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { StoreRepository } from '../../store/repositories/store.repository';
import { StockLevelRow } from '../repositories/agency-stock-level.repository';
import { IStorageBasedPricing } from '../../delivery/delivery-agency.model';
import {
  StorageFeeQuote,
  quoteStorageFee,
  resolveStorageSize,
} from '../domain/services/storage-fee.calculator';
import { StockAdjustmentRequestRepository } from '../../stock-requests/repositories/stock-adjustment-request.repository';

/** The depot a stock row sits at, as the screen shows it. Null when unresolved. */
export interface InventoryLocationDto {
  id: string;
  label: string | null;
  city: string | null;
  isPrimary: boolean;
}

export interface InventoryRowDto {
  id: string;
  sku: string | null;
  productTitle: string | null;
  variantTitle: string | null;
  image: FileDetail | null;
  vendor: { id: string; businessName: string | null };
  /**
   * Null when the product names a depot the agency has since deleted. The screen
   * should surface these as "unassigned" — the goods are somewhere, but the
   * platform no longer knows which building. Filter for them with
   * `?locationId=unassigned`.
   */
  location: InventoryLocationDto | null;
  quantityOnHand: number;
  quantityReserved: number;
  /** `on_hand - reserved` — what could still be promised to a customer. */
  quantityAvailable: number;
  /**
   * `derived` — this row exists because a product is CONFIGURED to be stored
   * here; the quantities are not counted and are zero. `counted` — the
   * quantities reflect real movements. Everything is `derived` today.
   */
  source: 'derived' | 'counted';
  lastReconciledAt: Date;

  /**
   * The CATALOGUE quantity for this SKU, and what is pending on it.
   *
   * **Not the same field as `quantityOnHand`.** That one is Phase 2's counted
   * figure and is still 0. This is `ProductVariant.stock` — the number the vendor
   * and the agency now jointly govern (neither writes it alone on a warehoused
   * SKU) and the number the storage fee is quoted against.
   */
  catalogStock: {
    quantity: number | null;
    isInfinite: boolean | null;
    /** The one open adjustment request for this SKU, if any. */
    pendingRequest: {
      id: string;
      requestedQuantity: number;
      requestedByRole: 'vendor' | 'agency';
      /** True when it is this agency's turn to answer. */
      awaitingMyDecision: boolean;
      requestedAt: string;
      note: string | null;
    } | null;
  };

  /**
   * What this SKU should be costing in storage rent, per month.
   *
   * A DISPLAY figure. The platform does not track, invoice or act on storage
   * payment — see `storage-fee.calculator.ts`. `size` is information for
   * sanity-checking the rate, **not** a multiplier: the rate is flat per SKU.
   */
  storageFee: StorageFeeQuote;

  /**
   * Set when this agency has storage-suspended the product. Rows for such products
   * deliberately stay on the roster — the goods are still in the building, and the
   * unsuspend action lives on this screen.
   *
   * Null for an active product AND for one suspended by a delivery-agency cascade:
   * that is not this agency's suspension to lift.
   */
  suspension: {
    note: string | null;
    suspendedAt: Date;
    /** What the product returns to on unsuspend. */
    previousStatus: string;
  } | null;
  /** The product's own status, so a client need not infer it from `suspension`. */
  productStatus: string | null;
}

/** The detail view adds the depot's full address and the product/variant ids. */
export interface InventoryDetailDto extends InventoryRowDto {
  productId: string;
  variantId: string;
  /** The depot's full address, for a map or a "where is this" panel. */
  locationAddress: AddressDetail | null;
  /** Every image, thumbnail first (the list's `image` is `images[0]`). */
  images: FileDetail[];
}

/**
 * Turns stock rows into what the inventory screen renders.
 *
 * Everything here is batch-resolved from existing shared resolvers rather than
 * re-shaped locally — `resolveProductImages` for the pictures, `fromHqAddress`
 * for the depot address, and the magazin/store name lookups for the labels. A
 * page of rows costs a fixed number of queries regardless of its size.
 */
export class InventoryRowResolver {
  constructor(
    private readonly magazins: MagazinRepository = new MagazinRepository(),
    private readonly stores: StoreRepository = new StoreRepository(),
    private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
    private readonly storageProvider?: IStorageProvider,
    private readonly stockRequests: StockAdjustmentRequestRepository = new StockAdjustmentRequestRepository(),
  ) { }

  /**
   * @param pricing the agency's `policies.pricing.storage_based`, loaded ONCE per
   *   request by the caller. Passed in rather than looked up per row: the rate is
   *   the same for every SKU, and a resolver reading the DeliveryAgency would make
   *   a page of rows a page of queries.
   */
  async toRows(
    rows: StockLevelRow[],
    agencyId: string,
    storage: IStorageProvider,
    pricing: IStorageBasedPricing | null,
  ): Promise<InventoryRowDto[]> {
    if (rows.length === 0) return [];
    const ctx = await this.loadContext(rows, agencyId, storage);
    return rows.map(row => this.toRow(row, ctx, agencyId, pricing));
  }

  async toDetail(
    row: StockLevelRow,
    agencyId: string,
    storage: IStorageProvider,
    pricing: IStorageBasedPricing | null,
  ): Promise<InventoryDetailDto> {
    const ctx = await this.loadContext([row], agencyId, storage);
    const base = this.toRow(row, ctx, agencyId, pricing);
    const depot = row.locationId ? ctx.depotsById.get(row.locationId) : null;

    return {
      ...base,
      productId: row.productId,
      variantId: row.variantId,
      // Resolved LIVE from the magazin, never snapshotted — the depot's address
      // is the agency's own record and must follow their corrections.
      locationAddress: depot ? fromHqAddress(depot) : null,
      images: ctx.imageMap.get(productImageKey(row.productId, row.variantId)) ?? [],
    };
  }

  /** One batch load covering every row on the page. */
  private async loadContext(rows: StockLevelRow[], agencyId: string, storage: IStorageProvider) {
    const vendorIds = [...new Set(rows.map(r => r.vendorId))];

    const [depotLists, vendorNames, imageMap, pendingRequests] = await Promise.all([
      this.magazins.findHqAddressListsByAgencyIds([agencyId]),
      this.stores.findNamesByVendorIds(vendorIds),
      resolveProductImages(
        rows.map(r => ({ productId: r.productId, variantId: r.variantId })),
        this.fileRepository,
        storage,
      ),
      // One query for every open request on the page, keyed by variant — the fixed
      // query count per page is a property of this resolver worth keeping.
      this.stockRequests.findPendingByVariants(rows.map(r => r.variantId)),
    ]);

    // Depot order is what makes a depot "primary" — there is no is_primary flag,
    // index 0 is the convention.
    const depots = depotLists.get(agencyId) ?? [];
    const depotsById = new Map(depots.map(d => [d._id.toString(), d]));
    const primaryId = depots[0]?._id?.toString() ?? null;

    return { depotsById, primaryId, vendorNames, imageMap, pendingRequests };
  }

  private toRow(
    row: StockLevelRow,
    ctx: Awaited<ReturnType<InventoryRowResolver['loadContext']>>,
    agencyId: string,
    pricing: IStorageBasedPricing | null,
  ): InventoryRowDto {
    const depot = row.locationId ? ctx.depotsById.get(row.locationId) : null;
    const images = ctx.imageMap.get(productImageKey(row.productId, row.variantId)) ?? [];

    const catalogStock = {
      quantity: row.catalogQuantity,
      isInfinite: row.catalogIsInfinite,
    };

    const pending = ctx.pendingRequests.get(row.variantId);

    // Only the agency's OWN storage suspension is surfaced here. A product
    // suspended by a delivery-agency cascade is not this agency's to lift, and
    // showing an unsuspend affordance for it would render a button that 422s.
    const isAgencySuspension =
      row.suspension?.reason === 'agency_storage_suspended' &&
      row.suspension?.suspendedByAgencyId === agencyId;

    return {
      id: row.id,
      sku: row.sku,
      productTitle: row.productTitle,
      variantTitle: row.variantTitle,
      image: images[0] ?? null,
      vendor: {
        id: row.vendorId,
        businessName: ctx.vendorNames.get(row.vendorId)?.name ?? null,
      },
      // A row whose `location_id` points at a deleted depot resolves to null
      // here too — the id is stored, but there is no building to name.
      location: depot
        ? {
          id: depot._id.toString(),
          label: depot.label ?? null,
          city: depot.city ?? null,
          isPrimary: depot._id.toString() === ctx.primaryId,
        }
        : null,
      quantityOnHand: row.quantityOnHand,
      quantityReserved: row.quantityReserved,
      quantityAvailable: quantityAvailable(row.quantityOnHand, row.quantityReserved),
      source: row.source,
      lastReconciledAt: row.lastReconciledAt,

      catalogStock: {
        ...catalogStock,
        pendingRequest: pending
          ? {
            id: pending._id.toString(),
            requestedQuantity: pending.requested_quantity,
            requestedByRole: pending.requested_by_role,
            // The agency is the viewer of this screen, so it is their turn exactly
            // when the vendor raised it.
            awaitingMyDecision: pending.requested_by_role === 'vendor',
            requestedAt: pending.requested_at.toISOString(),
            note: pending.note ?? null,
          }
          : null,
      },

      storageFee: quoteStorageFee(
        pricing,
        { quantity: catalogStock.quantity ?? 0, isInfinite: catalogStock.isInfinite ?? false },
        resolveStorageSize(row.variantDimensions, row.productDimensions),
      ),

      suspension: isAgencySuspension && row.suspension
        ? {
          note: row.suspension.note,
          suspendedAt: row.suspension.suspendedAt,
          previousStatus: row.suspension.previousStatus,
        }
        : null,
      productStatus: row.productStatus,
    };
  }
}

/**
 * What could still be promised to a customer. Clamped at zero: an oversold
 * variant (Phase 2 allows `allow_oversell`) must not report a negative
 * availability, which no screen or downstream check would read correctly.
 */
export function quantityAvailable(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}

export const inventoryRowResolver = new InventoryRowResolver();
