/**
 * Live verification: the agency-dash asks of 2026-10-04, against a real MongoDB.
 *
 * The offline half (`test:agency-dashboard-asks`) pins schemas, filter SHAPES and DTO
 * fallbacks. This half proves the queries do what the shapes promise:
 *
 *   1. `GET /api/agency/products` — search by title, SKU, vendor store name, vendor
 *      display name and category name; the `source` filter on a vendor that defaults to
 *      this agency but has overridden ONE product to another agency (which must never
 *      appear); the vendor block with a public logo URL; filtered `meta.total`.
 *   2. Stock requests name their product, SKU, vendor and depot, and `search` narrows.
 *   3. The inventory summary's `uncountedRows` and `awaitingMyDecisionCount`.
 *   4. Agency storage statements carry the vendor.
 *
 * Seeds its own fixtures under fresh ObjectIds and deletes exactly those afterwards — it
 * never drops a collection or a database, so it is safe against a shared instance. Point
 * it anywhere with MONGO_URI; the default is the local dev database.
 *
 * Run: npm run verify:agency-dashboard-asks
 */
process.env.LOG_STDOUT = 'false';

import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import { Request, Response } from 'express';
import '../../src/api/middlewares/request-id.middleware';
import '../../src/api/middlewares/auth.middleware';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { StoreModel } from '../../src/modules/store/models/store.model';
import { FileModel } from '../../src/modules/catalog/models/file.model';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { ProductCategoryModel } from '../../src/modules/categories/models/product-category.model';
import { AgencyMagazinModel } from '../../src/modules/magazin/models/magazin.model';
import { AgencyStockLevelModel } from '../../src/modules/inventory/models/agency-stock-level.model';
import { AgencyStorageInvoiceModel } from '../../src/modules/inventory/models/agency-storage-invoice.model';
import { StockAdjustmentRequestModel } from '../../src/modules/stock-requests/models/stock-adjustment-request.model';
import { agencyNetworkService } from '../../src/modules/delivery/services/agency-network.service';
import { AgencyProductsQuerySchema } from '../../src/modules/delivery/validators/agency-products.validator';
import { stockRequestService } from '../../src/modules/stock-requests/services/stock-request.service';
import { AgencyStockLevelRepository } from '../../src/modules/inventory/repositories/agency-stock-level.repository';
import { StorageInvoiceController } from '../../src/modules/inventory/controllers/storage-invoice.controller';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
  try {
    if (await fn()) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

const id = () => new Types.ObjectId();
const now = new Date();
const base = { createdAt: now, updatedAt: now, deletedAt: null };
const tag = `t${Date.now().toString(36)}`; // makes every searchable string unique to this run

const AGENCY = id();
const OTHER_AGENCY = id();
const DEPOT = id();
const V_ALPHA = id();   // defaults to AGENCY, verified, has a logo
const V_BETA = id();    // no default; overrides one product to AGENCY
const LOGO = id();
const CAT = id();
const P_SHIRT = id();   // V_ALPHA, no override          → vendor_default
const P_MUG = id();     // V_ALPHA, override OTHER_AGENCY → must never appear
const P_KETTLE = id();  // V_BETA,  override AGENCY      → own_override, in CAT
const VAR_SHIRT = id();
const VAR_MUG = id();
const VAR_KETTLE = id();
const ROW_SHIRT = id();
const ROW_KETTLE = id();
const REQ_VENDOR = id();
const REQ_AGENCY = id();
const INVOICE = id();

const seeded: Array<[mongoose.Model<any>, Types.ObjectId[]]> = [];
async function seed(model: mongoose.Model<any>, docs: Array<Record<string, unknown>>): Promise<void> {
  await model.collection.insertMany(docs as any[]);
  seeded.push([model, docs.map(d => d._id as Types.ObjectId)]);
}

async function seedAll(): Promise<void> {
  await seed(FileModel, [{
    _id: LOGO, key: `images/${tag}/logo.png`, provider: 'local', mimeType: 'image/png', size: 10,
    originalName: 'logo.png', ...base,
  }]);
  await seed(VendorModel, [
    { _id: V_ALPHA, display_name: `Jeanne ${tag}`, default_delivery_agency_id: AGENCY,
      kyc_details: { legit_verified: true }, status: 'active', ...base },
    { _id: V_BETA, display_name: null, default_delivery_agency_id: null,
      kyc_details: { legit_verified: false }, status: 'active', ...base },
  ]);
  await seed(StoreModel, [
    { _id: id(), vendor_id: V_ALPHA, name: `Alpha Textiles ${tag}`, logo_file_id: LOGO, ...base },
    { _id: id(), vendor_id: V_BETA, name: `Beta Home ${tag}`, logo_file_id: null, ...base },
  ]);
  await seed(ProductCategoryModel, [{
    _id: CAT, name: `Kitchenware${tag}`, slug: `kitchenware-${tag}`, match_key: `kitchenware${tag}`,
    alias_keys: [], ...base,
  }]);
  await seed(ProductModel, [
    { _id: P_SHIRT, vendorId: V_ALPHA, type: 'physical', status: 'active', title: `Red Shirt ${tag}`,
      slug: `shirt-${tag}`, categoryIds: [], delivery: { agency_id: null }, ...base,
      createdAt: new Date(now.getTime() - 2000) },
    { _id: P_MUG, vendorId: V_ALPHA, type: 'physical', status: 'active', title: `Blue Mug ${tag}`,
      slug: `mug-${tag}`, categoryIds: [CAT], delivery: { agency_id: OTHER_AGENCY }, ...base },
    { _id: P_KETTLE, vendorId: V_BETA, type: 'physical', status: 'draft', title: `Green Kettle ${tag}`,
      slug: `kettle-${tag}`, categoryIds: [CAT], delivery: { agency_id: AGENCY }, ...base,
      createdAt: new Date(now.getTime() - 1000) },
  ]);
  await seed(ProductVariantModel, [
    { _id: VAR_SHIRT, productId: P_SHIRT, sku: `RS-${tag}-001`, name: 'Medium', status: 'active', stock: 60, ...base },
    { _id: VAR_MUG, productId: P_MUG, sku: `BM-${tag}-001`, name: 'Default', status: 'active', stock: 5, ...base },
    { _id: VAR_KETTLE, productId: P_KETTLE, sku: `GK-${tag}-777`, name: 'Default', status: 'active', stock: 3, ...base },
  ]);
  await seed(AgencyMagazinModel, [{
    _id: id(), agency_id: AGENCY, name: `Depot co ${tag}`,
    headquarters_addresses: [{ _id: DEPOT, label: 'Main depot', city: 'Douala' }], ...base,
  }]);
  await seed(AgencyStockLevelModel, [
    { _id: ROW_SHIRT, agency_id: AGENCY, location_id: DEPOT, vendor_id: V_ALPHA, product_id: P_SHIRT,
      variant_id: VAR_SHIRT, quantity_on_hand: 0, quantity_reserved: 0, source: 'derived',
      last_reconciled_at: now, ...base },
    { _id: ROW_KETTLE, agency_id: AGENCY, location_id: DEPOT, vendor_id: V_BETA, product_id: P_KETTLE,
      variant_id: VAR_KETTLE, quantity_on_hand: 4, quantity_reserved: 0, source: 'counted',
      last_reconciled_at: now, ...base },
  ]);
  const request = (over: Record<string, unknown>) => ({
    requested_by_user_id: null, requested_at: now, quantity_before: 60, infinite_before: false,
    requested_quantity: 90, requested_infinite: false, status: 'pending', note: null,
    approval: null, rejection: null, withdrawal: null, status_history: [], ...base, ...over,
  });
  await seed(StockAdjustmentRequestModel, [
    request({ _id: REQ_VENDOR, vendor_id: V_ALPHA, agency_id: AGENCY, product_id: P_SHIRT,
      variant_id: VAR_SHIRT, requested_by_role: 'vendor' }),
    request({ _id: REQ_AGENCY, vendor_id: V_BETA, agency_id: AGENCY, product_id: P_KETTLE,
      variant_id: VAR_KETTLE, requested_by_role: 'agency', quantity_before: 3, requested_quantity: 4 }),
  ]);
  await seed(AgencyStorageInvoiceModel, [{
    _id: INVOICE, agency_id: AGENCY, vendor_id: V_BETA, period_key: '2026-09',
    period_start: new Date('2026-09-01'), period_end: new Date('2026-10-01'), sku_count: 1, unit_count: 4,
    monthly_rate_per_sku: 500, total: 2000, status: 'open', issued_at: now, settled_at: null,
    settled_by_user_id: null, note: null, lines: [], ...base,
  }]);
}

async function cleanup(): Promise<void> {
  for (const [model, ids] of seeded.reverse()) {
    await model.collection.deleteMany({ _id: { $in: ids } });
  }
}

const list = (q: Record<string, unknown>) =>
  agencyNetworkService.listDeliverableProducts(AGENCY.toString(), AgencyProductsQuerySchema.parse(q));
const ids = (r: { data: any[] }) => r.data.map(p => p.id).sort().join(',');
const only = (...products: Types.ObjectId[]) => products.map(p => p.toString()).sort().join(',');

function callController(handler: any, req: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = { status: () => res, json: (body: unknown) => { resolve(body); return res; } };
    handler(req as unknown as Request, res as Response, (err?: unknown) => (err ? reject(err) : resolve(null)));
  });
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`\n🔎 verify:agency-dashboard-asks — ${mongoose.connection.host}/${mongoose.connection.name}\n`);
  try {
    await seedAll();

    console.log('1 · GET /api/agency/products');
    await check('no filter: shirt (vendor default) + kettle (own override), never the mug', async () =>
      ids(await list({})) === only(P_SHIRT, P_KETTLE));
    await check('source=vendor_default: shirt only — the overridden mug stays out', async () =>
      ids(await list({ source: 'vendor_default' })) === only(P_SHIRT));
    await check('source=own_override: kettle only', async () =>
      ids(await list({ source: 'own_override' })) === only(P_KETTLE));
    await check('search by title (substring, case-insensitive)', async () =>
      ids(await list({ search: `RED shirt ${tag}` })) === only(P_SHIRT));
    await check('search by variant SKU (substring)', async () =>
      ids(await list({ search: `${tag}-777` })) === only(P_KETTLE));
    await check('search by vendor store name', async () =>
      ids(await list({ search: `alpha textiles ${tag}` })) === only(P_SHIRT));
    await check('search by vendor display name', async () =>
      ids(await list({ search: `jeanne ${tag}` })) === only(P_SHIRT));
    await check('search by category name — the mug shares it but is still excluded', async () =>
      ids(await list({ search: `kitchenware${tag}` })) === only(P_KETTLE));
    await check('search on the excluded product title finds nothing', async () =>
      (await list({ search: `Blue Mug ${tag}` })).data.length === 0);
    await check('search is literal: regex metacharacters match nothing, throw nothing', async () =>
      (await list({ search: `${tag}.*(` })).data.length === 0);
    await check('status / categoryId / vendorId filters', async () =>
      ids(await list({ status: 'draft' })).includes(P_KETTLE.toString())
      && !ids(await list({ status: 'draft' })).includes(P_SHIRT.toString())
      && ids(await list({ categoryId: CAT.toString() })) === only(P_KETTLE)
      && ids(await list({ vendorId: V_ALPHA.toString() })) === only(P_SHIRT));
    await check('meta.total counts the filtered set; totalPages mirrors pages', async () => {
      const r = await list({ search: tag, limit: 1 });
      return r.meta.total === 2 && r.data.length === 1 && r.meta.pages === 2 && r.meta.totalPages === 2;
    });
    await check('sortBy=title asc: Green Kettle before Red Shirt', async () => {
      const r = await list({ search: tag, sortBy: 'title', sortDir: 'asc' });
      return r.data[0].id === P_KETTLE.toString() && r.data[1].id === P_SHIRT.toString();
    });
    await check('vendor block: store name, display name, verified, PUBLIC logo URL', async () => {
      const shirt = (await list({ vendorId: V_ALPHA.toString() })).data[0];
      const v = shirt.vendor;
      return shirt.vendorId === V_ALPHA.toString() && v.id === V_ALPHA.toString()
        && v.businessName === `Alpha Textiles ${tag}` && v.displayName === `Jeanne ${tag}` && v.verified === true
        && v.logo?.access === 'public' && typeof v.logo?.url === 'string' && v.logo.url !== v.logo.key
        && v.logo.url.endsWith(`images/${tag}/logo.png`);
    });
    await check('vendor without a logo or display name: nulls, verified false', async () => {
      const v = (await list({ source: 'own_override' })).data[0].vendor;
      return v.businessName === `Beta Home ${tag}` && v.displayName === null && v.logo === null && v.verified === false;
    });

    console.log('\n2 · stock requests');
    const actor = { role: 'agency' as const, ownerId: AGENCY.toString(), userId: null };
    const page = { page: 1, limit: 20 };
    await check('list names product, variant, SKU, vendor, depot and the inventory row', async () => {
      const r = await stockRequestService.list(actor, {}, page);
      const dto = r.data.find(d => d.id === REQ_VENDOR.toString())!;
      return dto.product.title === `Red Shirt ${tag}` && dto.product.variantTitle === 'Medium'
        && dto.product.sku === `RS-${tag}-001` && dto.vendor.businessName === `Alpha Textiles ${tag}`
        && dto.vendor.verified === true && dto.location?.label === 'Main depot'
        && dto.location?.city === 'Douala' && dto.location?.isPrimary === true
        && dto.stockLevelId === ROW_SHIRT.toString();
    });
    await check('detail carries the same block', async () => {
      const dto = await stockRequestService.getById(actor, REQ_AGENCY.toString());
      return dto.product.sku === `GK-${tag}-777` && dto.vendor.businessName === `Beta Home ${tag}`
        && dto.stockLevelId === ROW_KETTLE.toString();
    });
    await check('search by SKU', async () => {
      const r = await stockRequestService.list(actor, { search: `${tag}-777` }, page);
      return r.data.length === 1 && r.data[0].id === REQ_AGENCY.toString();
    });
    await check('search by product title', async () => {
      const r = await stockRequestService.list(actor, { search: `red shirt ${tag}` }, page);
      return r.data.length === 1 && r.data[0].id === REQ_VENDOR.toString() && r.meta.total === 1;
    });
    await check('search matching nothing: empty page, not "no filter"', async () =>
      (await stockRequestService.list(actor, { search: `nothing-${tag}` }, page)).data.length === 0);

    console.log('\n3 · inventory summary');
    const repo = new AgencyStockLevelRepository();
    await check('uncountedRows = derivedRows; countedRows unchanged', async () => {
      const s = await repo.summaryForAgency(AGENCY.toString(), {}, 500);
      return s.uncountedRows === 1 && s.derivedRows === 1 && s.countedRows === 1;
    });
    await check('awaitingMyDecisionCount counts the VENDOR-raised request only', async () =>
      (await repo.summaryForAgency(AGENCY.toString(), {}, 500)).awaitingMyDecisionCount === 1);
    await check('…and honours the filters (kettle-only set → 0)', async () =>
      (await repo.summaryForAgency(AGENCY.toString(), { search: `${tag}-777` }, 500)).awaitingMyDecisionCount === 0);
    await check('totalMonthlyEstimate = counted on-hand × rate (4 × 500)', async () =>
      (await repo.summaryForAgency(AGENCY.toString(), {}, 500)).totalMonthlyEstimate === 2000);

    console.log('\n4 · storage statements');
    const req = { query: {}, params: { id: INVOICE.toString() }, auth: { role_entity: { _id: AGENCY } } };
    await check('agency list rows carry the vendor', async () => {
      const body = await callController(StorageInvoiceController.listForAgency, req);
      const row = body.data.find((d: any) => d.id === INVOICE.toString());
      return row?.vendorId === V_BETA.toString() && row.vendor?.businessName === `Beta Home ${tag}`
        && row.vendor.displayName === null && row.vendor.verified === false;
    });
    await check('agency detail carries the vendor', async () => {
      const body = await callController(StorageInvoiceController.getForAgency, req);
      return body.data.vendor?.id === V_BETA.toString() && Array.isArray(body.data.lines);
    });
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
