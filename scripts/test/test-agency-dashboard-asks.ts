/**
 * Test: the agency-dash asks of 2026-10-04 — vendor identity + filters on
 * `GET /api/agency/products`, names on stock requests and storage statements, and the two
 * new inventory summary counts.
 *
 * Offline, like the rest of scripts/test. What needs a database (the search arms, the
 * source filter against real documents, the batched lookups) is in
 * `verify:agency-dashboard-asks`. What is pinned HERE is what that suite cannot see:
 *
 *   1. An unknown query parameter reaches the client as `400 VALIDATION_ERROR` — through
 *      the real controller and the real error handler, not merely "Zod threw".
 *   2. The `source` filter's shape. `vendor_default` must carry `delivery.agency_id: null`,
 *      or a product its vendor overrode to ANOTHER agency appears on this agency's list.
 *   3. Every new DTO field has a defined fallback, so a deleted product or vendor degrades
 *      to nulls rather than to a missing key.
 *
 * Run: npm run test:agency-dashboard-asks
 */
// Keep the error handler's structured log off the assertion output (see test-errors.ts).
process.env.LOG_STDOUT = 'false';

import { Request, Response } from 'express';
// `req.requestId` / `req.auth` are augmentations declared in these two files; the error
// handler imports neither, so ts-node cannot see them without this (test-errors.ts does the same).
import '../../src/api/middlewares/request-id.middleware';
import '../../src/api/middlewares/auth.middleware';
import { ZodError } from 'zod';
import { AgencyProductsQuerySchema } from '../../src/modules/delivery/validators/agency-products.validator';
import { errorHandlerMiddleware } from '../../src/api/middlewares/error-handler.middleware';
import { ProductRepositoryMongo } from '../../src/modules/catalog/repositories/mongo/product.repository.mongo';
import { StockRequestQuerySchema } from '../../src/modules/stock-requests/validators/stock-request.validator';
import { StockRequestMapper } from '../../src/modules/stock-requests/dto/stock-adjustment-request.dto';
import { toStorageInvoiceDto } from '../../src/modules/inventory/dto/storage-invoice.dto';
import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ ${name}`);
    failed++;
  }
}

const AGENCY = '64b000000000000000000001';
const VENDOR_A = '64b0000000000000000000a1';
const VENDOR_B = '64b0000000000000000000b1';

/** Captures the filter the repository would have paginated, without a database. */
class CapturingProductRepo extends ProductRepositoryMongo {
  public captured: any = null;
  public calls = 0;
  protected override async paginate(filter: any, pagination: any): Promise<any> {
    this.calls++;
    this.captured = filter;
    return { data: [], meta: { total: 0, page: pagination.page, limit: pagination.limit, pages: 0 } };
  }
}

const json = (v: unknown) => JSON.stringify(v);

/** Strip comments FIRST — these files explain the rules they obey. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function fakeRes() {
  const res: any = { statusCode: 200, body: null, headersSent: false, locals: {} };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; res.headersSent = true; return res; };
  res.setHeader = () => res;
  res.set = () => res;
  res.getHeader = () => undefined;
  return res;
}

async function main(): Promise<void> {
  console.log('\n🧪 Agency dashboard asks (2026-10-04)\n');

  // ── 1 · GET /api/agency/products query ────────────────────────────────────
  console.log('1 · products query schema');

  assert('defaults: page 1, limit 20, sortBy createdAt, sortDir desc', () => {
    const q = AgencyProductsQuerySchema.parse({});
    return q.page === 1 && q.limit === 20 && q.sortBy === 'createdAt' && q.sortDir === 'desc';
  });
  assert('all seven new params accepted together', () => {
    const q = AgencyProductsQuerySchema.parse({
      search: '  shirt  ', source: 'vendor_default', status: 'active',
      categoryId: VENDOR_A, vendorId: VENDOR_B, sortBy: 'title', sortDir: 'asc',
    });
    return q.search === 'shirt' && q.source === 'vendor_default' && q.sortBy === 'title';
  });
  assert('unknown param rejected (strict)', () => !AgencyProductsQuerySchema.safeParse({ foo: '1' }).success);
  assert('search: whitespace-only rejected after trim', () => !AgencyProductsQuerySchema.safeParse({ search: '   ' }).success);
  assert('search: 101 chars rejected, 100 accepted', () =>
    !AgencyProductsQuerySchema.safeParse({ search: 'x'.repeat(101) }).success
    && AgencyProductsQuerySchema.safeParse({ search: 'x'.repeat(100) }).success);
  assert('source: only the two values', () => !AgencyProductsQuerySchema.safeParse({ source: 'both' }).success);
  assert('categoryId / vendorId must be ObjectIds', () =>
    !AgencyProductsQuerySchema.safeParse({ categoryId: 'abc' }).success
    && !AgencyProductsQuerySchema.safeParse({ vendorId: 'abc' }).success);
  assert('status: the product status enum', () =>
    AgencyProductsQuerySchema.safeParse({ status: 'suspended' }).success
    && !AgencyProductsQuerySchema.safeParse({ status: 'live' }).success);

  // The controller is SCANNED, never imported (memory: ts-node suites must not import
  // controllers — the `req.auth` augmentation is not loaded here). What it parses with is
  // pinned by text; what that parse produces on the wire is driven through the real handler.
  {
    const controller = stripComments(readFileSync(
      join(__dirname, '../../src/modules/delivery/controllers/agency-network.controller.ts'), 'utf-8'));
    const listProducts = controller.slice(controller.indexOf('static listProducts'));
    assert('listProducts parses req.query with AgencyProductsQuerySchema', () =>
      /AgencyProductsQuerySchema\.parse\(req\.query\)/.test(listProducts));

    const parsed = AgencyProductsQuerySchema.safeParse({ page: '1', foo: 'bar' });
    const req: any = {
      requestId: 'req_test', query: { page: '1', foo: 'bar' }, headers: {}, get: () => undefined,
      method: 'GET', originalUrl: '/api/agency/products', path: '/api/agency/products',
    };
    const res = fakeRes();
    assert('an unknown param produces a ZodError', () => !parsed.success && parsed.error instanceof ZodError);
    if (!parsed.success) errorHandlerMiddleware(parsed.error, req as Request, res as Response, () => undefined);
    assert('…which the real error handler answers as 400 VALIDATION_ERROR', () =>
      res.statusCode === 400 && res.body?.error?.code === 'VALIDATION_ERROR');
  }

  // ── 2 · source filter shape ───────────────────────────────────────────────
  console.log('\n2 · source filter shape');
  const page = { page: 1, limit: 20 };

  {
    const repo = new CapturingProductRepo();
    await repo.findByEffectiveDeliveryAgency(AGENCY, [VENDOR_A], page);
    const arms = repo.captured?.$or ?? [];
    assert('no filters: both arms, unchanged legacy shape', () =>
      arms.length === 2 && arms[0]['delivery.agency_id'] === AGENCY && arms[1]['delivery.agency_id'] === null);
  }
  {
    const repo = new CapturingProductRepo();
    await repo.findByEffectiveDeliveryAgency(AGENCY, [VENDOR_A], page, undefined, { source: 'vendor_default' });
    const arms = repo.captured?.$or ?? [];
    assert('vendor_default: ONE arm, and it requires delivery.agency_id null', () =>
      arms.length === 1 && arms[0]['delivery.agency_id'] === null && json(arms[0].vendorId.$in) === json([VENDOR_A]));
  }
  {
    const repo = new CapturingProductRepo();
    await repo.findByEffectiveDeliveryAgency(AGENCY, [VENDOR_A], page, undefined, { source: 'own_override' });
    const arms = repo.captured?.$or ?? [];
    assert('own_override: ONE arm, delivery.agency_id = us', () =>
      arms.length === 1 && arms[0]['delivery.agency_id'] === AGENCY);
  }
  {
    const repo = new CapturingProductRepo();
    const out = await repo.findByEffectiveDeliveryAgency(AGENCY, [], page, undefined, { source: 'vendor_default' });
    assert('vendor_default with no defaulting vendor: empty, no query', () =>
      repo.calls === 0 && out.data.length === 0 && out.meta.total === 0);
  }
  {
    const repo = new CapturingProductRepo();
    await repo.findByEffectiveDeliveryAgency(AGENCY, [VENDOR_A], page, undefined, {
      status: 'active', categoryId: VENDOR_B, vendorId: VENDOR_A,
    });
    const and = repo.captured?.$and ?? [];
    assert('status / categoryId / vendorId are AND-ed beside the source arms', () =>
      and.length === 4 && !!and[0].$or && and[1].status === 'active'
      && String(and[2].categoryIds) === VENDOR_B && String(and[3].vendorId) === VENDOR_A);
  }

  // ── 3 · stock requests ────────────────────────────────────────────────────
  console.log('\n3 · stock requests');

  assert('list query accepts search; unknown param still refused', () =>
    StockRequestQuerySchema.parse({ search: ' RS-0 ' }).search === 'RS-0'
    && !StockRequestQuerySchema.safeParse({ q: 'x' }).success);

  const now = new Date();
  const doc: any = {
    _id: { toString: () => '64b0000000000000000000c1' },
    product_id: { toString: () => '64b0000000000000000000d1' },
    variant_id: { toString: () => '64b0000000000000000000e1' },
    vendor_id: { toString: () => VENDOR_A },
    agency_id: { toString: () => AGENCY },
    requested_by_role: 'vendor', requested_at: now,
    quantity_before: 60, infinite_before: false, requested_quantity: 90, requested_infinite: false,
    status: 'pending', note: null, approval: null, rejection: null, withdrawal: null,
    status_history: [], createdAt: now, updatedAt: now,
  };

  assert('no context → every new field present with a null fallback', () => {
    const dto = StockRequestMapper.toDto(doc, 'agency');
    return dto.product.title === null && dto.product.sku === null && dto.product.image === null
      && dto.vendor.id === VENDOR_A && dto.vendor.businessName === null && dto.vendor.verified === false
      && dto.location === null && dto.stockLevelId === null;
  });
  assert('context is passed through verbatim', () => {
    const dto = StockRequestMapper.toDto(doc, 'agency', null, {
      product: { title: 'Red Shirt', variantTitle: 'M', sku: 'RS-001', image: null },
      vendor: { id: VENDOR_A, businessName: 'Alpha', verified: true },
      location: { id: 'L1', label: 'Main', city: 'Douala', isPrimary: true },
      stockLevelId: 'S1',
    });
    return dto.product.sku === 'RS-001' && dto.vendor.businessName === 'Alpha'
      && dto.location?.isPrimary === true && dto.stockLevelId === 'S1';
  });
  assert('the old id fields are unchanged', () => {
    const dto = StockRequestMapper.toDto(doc, 'agency');
    return dto.productId === '64b0000000000000000000d1' && dto.variantId === '64b0000000000000000000e1';
  });

  // ── 4 · storage statements ────────────────────────────────────────────────
  console.log('\n4 · storage statements');
  const invoice: any = {
    _id: { toString: () => 'inv1' }, agency_id: AGENCY, vendor_id: VENDOR_A,
    period_key: '2026-09', period_start: now, period_end: now, sku_count: 1, unit_count: 3,
    monthly_rate_per_sku: 500, total: 1500, status: 'open', issued_at: now, settled_at: null,
    note: null, lines: [],
  };
  assert('vendor block present when the agency presenter supplies it', () => {
    const dto = toStorageInvoiceDto(invoice, {
      withLines: false,
      vendor: { id: VENDOR_A, businessName: 'Alpha', displayName: null, verified: true },
    });
    return dto.vendor?.businessName === 'Alpha' && dto.vendorId === VENDOR_A;
  });
  assert('vendor block absent on the vendor mount (no presenter)', () =>
    !('vendor' in toStorageInvoiceDto(invoice, { withLines: false })));

  // ── 5 · source scans ──────────────────────────────────────────────────────
  console.log('\n5 · source scans');
  const src = (p: string) => stripComments(readFileSync(join(__dirname, '../../src', p), 'utf-8'));

  assert('every agency storage-invoice response goes through the presenter', () => {
    const c = src('modules/inventory/controllers/storage-invoice.controller.ts');
    const agencyHalf = c.slice(c.indexOf('static listForAgency'), c.indexOf('static listForVendor'));
    return !agencyHalf.includes('toStorageInvoiceDto(') && (agencyHalf.match(/presentForAgency\(/g) ?? []).length === 4;
  });
  assert('stock-request service: every DTO goes through present() or the batched list', () => {
    const s = src('modules/stock-requests/services/stock-request.service.ts');
    // Two sanctioned direct calls: the batched list, and present() itself.
    return (s.match(/StockRequestMapper\.toDto\(/g) ?? []).length === 2;
  });
  assert('summary counts awaiting-decision over the FILTERED variant set', () => {
    const r = src('modules/inventory/repositories/agency-stock-level.repository.ts');
    return r.includes("variantIds: { $addToSet: '$variant_id' }") && r.includes("requested_by_role: 'vendor'");
  });
  assert('search is regex-escaped on every new path (no bare new RegExp)', () =>
    ['modules/delivery/services/agency-network.service.ts',
      'modules/stock-requests/services/stock-request.service.ts',
      'modules/stock-requests/read-models/stock-request-context.resolver.ts',
    ].every(p => !/new RegExp\(/.test(src(p))));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
