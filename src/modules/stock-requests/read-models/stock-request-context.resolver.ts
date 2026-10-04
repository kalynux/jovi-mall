import { Types } from 'mongoose';
import { IStorageProvider } from '../../../core/storage';
// Concrete files, never a module barrel — see the note at the top of stock-request.service.ts.
import { ProductModel } from '../../catalog/models/product.model';
import { ProductVariantModel } from '../../catalog/models/product-variant.model';
import { FileDetail } from '../../catalog/read-models/product-detail.read-model';
import { productImageKey, resolveProductImages } from '../../catalog/read-models/product-image.resolver';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { AgencyStockLevelModel } from '../../inventory/models/agency-stock-level.model';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { resolveVendorSummaries } from '../../vendors/read-models/vendor-summary.resolver';
import { IStockAdjustmentRequest, StockRequestParty } from '../models/stock-adjustment-request.model';
import { StockAdjustmentRequestModel } from '../models/stock-adjustment-request.model';

/**
 * What a request is ABOUT, in words a person can approve against (agency-dash ask,
 * 2026-10-04). Before this a request carried ids alone, so an inbox could say
 * "60 → 90 · the vendor raised this" without naming the product.
 *
 * Resolved LIVE, like the inventory rows: a rename shows on every request, open or closed.
 * A product, variant or depot that no longer exists resolves to nulls, never a throw.
 */
export interface StockRequestContext {
  product: {
    title: string | null;
    variantTitle: string | null;
    sku: string | null;
    /** The variant's first image, falling back to the product's — the inventory row's rule. */
    image: FileDetail | null;
  };
  vendor: { id: string; businessName: string | null; verified: boolean };
  /** The depot the SKU's inventory row sits at. Null when there is no row or no depot. */
  location: { id: string; label: string | null; city: string | null; isPrimary: boolean } | null;
  /**
   * The agency's inventory row for this SKU (`GET /api/agency/inventory/:id`).
   *
   * A SKU transferred between depots has one row per depot; the link goes to the row at a
   * known depot first, then the oldest — the row the roster was originally built around.
   */
  stockLevelId: string | null;
}

/**
 * One fixed set of queries for a page of requests — products, variants, images, vendors,
 * stock rows, depots — regardless of the page's size.
 */
export async function resolveStockRequestContexts(
  docs: IStockAdjustmentRequest[],
  storage: IStorageProvider,
  deps: { files?: FileRepositoryMongo; magazins?: MagazinRepository } = {},
): Promise<Map<string, StockRequestContext>> {
  const result = new Map<string, StockRequestContext>();
  if (docs.length === 0) return result;

  const productIds = [...new Set(docs.map(d => d.product_id.toString()))];
  const variantIds = [...new Set(docs.map(d => d.variant_id.toString()))];
  const agencyIds = [...new Set(docs.map(d => d.agency_id.toString()))];
  const vendorIds = [...new Set(docs.map(d => d.vendor_id.toString()))];

  const [products, variants, images, vendors, stockRows, depotLists] = await Promise.all([
    ProductModel.find({ _id: { $in: productIds.map(oid) } }, { title: 1 }).lean().exec(),
    ProductVariantModel.find({ _id: { $in: variantIds.map(oid) } }, { sku: 1, name: 1 }).lean().exec(),
    resolveProductImages(
      docs.map(d => ({ productId: d.product_id.toString(), variantId: d.variant_id.toString() })),
      deps.files ?? new FileRepositoryMongo(),
      storage,
    ),
    resolveVendorSummaries(vendorIds, storage),
    AgencyStockLevelModel.find(
      { agency_id: { $in: agencyIds.map(oid) }, variant_id: { $in: variantIds.map(oid) }, deletedAt: null },
      { agency_id: 1, variant_id: 1, location_id: 1, createdAt: 1 },
    ).sort({ createdAt: 1 }).lean().exec(),
    (deps.magazins ?? new MagazinRepository()).findHqAddressListsByAgencyIds(agencyIds),
  ]);

  const productsById = new Map(products.map(p => [p._id.toString(), p]));
  const variantsById = new Map(variants.map(v => [v._id.toString(), v]));

  // (agency, variant) → the row to link. Rows arrive oldest-first; a row at a known depot
  // replaces an unassigned one, but never an earlier row that also has a depot.
  const rowByKey = new Map<string, { id: string; locationId: string | null }>();
  for (const row of stockRows) {
    const key = `${row.agency_id.toString()}:${row.variant_id.toString()}`;
    const current = rowByKey.get(key);
    const candidate = { id: row._id.toString(), locationId: row.location_id ? row.location_id.toString() : null };
    if (!current || (current.locationId === null && candidate.locationId !== null)) {
      rowByKey.set(key, candidate);
    }
  }

  for (const doc of docs) {
    const productId = doc.product_id.toString();
    const variantId = doc.variant_id.toString();
    const agencyId = doc.agency_id.toString();
    const vendorId = doc.vendor_id.toString();

    const product = productsById.get(productId);
    const variant = variantsById.get(variantId);
    const vendor = vendors.get(vendorId);
    const row = rowByKey.get(`${agencyId}:${variantId}`) ?? null;

    // Depot order is what makes a depot primary — index 0, as on the inventory rows.
    const depots = depotLists.get(agencyId) ?? [];
    const depot = row?.locationId ? depots.find(d => d._id.toString() === row.locationId) : undefined;

    result.set(doc._id.toString(), {
      product: {
        title: product?.title ?? null,
        variantTitle: variant?.name ?? null,
        sku: variant?.sku ?? null,
        image: images.get(productImageKey(productId, variantId))?.[0] ?? null,
      },
      vendor: {
        id: vendorId,
        businessName: vendor?.businessName || null,
        verified: vendor?.verified ?? false,
      },
      location: depot
        ? {
          id: depot._id.toString(),
          label: depot.label ?? null,
          city: depot.city ?? null,
          isPrimary: depots[0]?._id?.toString() === depot._id.toString(),
        }
        : null,
      stockLevelId: row?.id ?? null,
    });
  }

  return result;
}

/**
 * `search` on a party's inbox: which of ITS requests name a product title or SKU matching
 * the term. Scoped to the party's own requests before any regex runs, so the unanchored
 * match scans a party's history rather than the marketplace's catalogue.
 */
export async function resolveStockRequestSearch(
  party: StockRequestParty,
  ownerId: string,
  regex: RegExp,
): Promise<{ productIds: string[]; variantIds: string[] }> {
  if (!Types.ObjectId.isValid(ownerId)) return { productIds: [], variantIds: [] };
  const scope = { [party === 'vendor' ? 'vendor_id' : 'agency_id']: oid(ownerId), deletedAt: null };

  const [ownProductIds, ownVariantIds] = await Promise.all([
    StockAdjustmentRequestModel.distinct('product_id', scope).exec(),
    StockAdjustmentRequestModel.distinct('variant_id', scope).exec(),
  ]);

  const [products, variantIds] = await Promise.all([
    ownProductIds.length === 0
      ? Promise.resolve([] as Types.ObjectId[])
      : ProductModel.distinct('_id', { _id: { $in: ownProductIds }, title: regex }).exec(),
    ownVariantIds.length === 0
      ? Promise.resolve([] as Types.ObjectId[])
      : ProductVariantModel.distinct('_id', { _id: { $in: ownVariantIds }, sku: regex }).exec(),
  ]);

  return {
    productIds: (products as Types.ObjectId[]).map(id => id.toString()),
    variantIds: (variantIds as Types.ObjectId[]).map(id => id.toString()),
  };
}

function oid(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}
