/**
 * Test: `excludeStatus` on `GET /api/vendor/products` (2026-10-18, vendor-dash request).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free.
 *
 *   1. **The query schema.** Comma-separated or repeated values, trimmed, de-duplicated,
 *      empty tokens dropped; an UNKNOWN status throws (→ 400), never silently ignored;
 *      absent means no exclusion.
 *   2. **The repository filter — the point of the request.** `searchListView` runs against a
 *      stubbed model and the suite captures what it sends. The exclusion must reach the
 *      SAME filter object that `countDocuments` and `find` receive, or `meta.total` /
 *      `meta.totalPages` would count rows the vendor never sees.
 *   3. **Source scans.** The controller passes the parameter through and the debug
 *      `console.log` of every vendor's product list stays deleted.
 *
 * Run: npm run test:product-list-exclude-status
 */
import * as fs from 'fs';
import * as path from 'path';
import { ProductQuerySchema } from '../../src/modules/catalog/validators/product.validator';
import { ProductRepositoryMongo } from '../../src/modules/catalog/repositories/mongo/product.repository.mongo';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Runs the real `searchListView` against a stub model; returns the filters it sent. */
async function captureFilters(filters: { status?: string; excludeStatuses?: string[] }) {
  const sent: { count?: any; find?: any } = {};
  const chain: any = {
    select: () => chain, sort: () => chain, skip: () => chain, limit: () => chain, lean: () => chain,
    session: () => chain, exec: async () => [],
  };
  const stub = {
    countDocuments: (q: any) => { sent.count = q; return { session: () => undefined, exec: async () => 0 }; },
    find: (q: any) => { sent.find = q; return chain; },
  };
  const repo = new ProductRepositoryMongo();
  (repo as any).model = stub;
  await repo.searchListView('vendor-1', filters, { page: 1, limit: 20 });
  return sent;
}

async function main() {
  console.log('\n§ 1 — query schema');

  const parse = (q: Record<string, unknown>) => ProductQuerySchema.parse(q).excludeStatus;

  await assert('absent → undefined (no exclusion, behaviour unchanged)', () => parse({}) === undefined);
  await assert('single value → one-element array', () => same(parse({ excludeStatus: 'archived' }), ['archived']));
  await assert('comma-separated → array', () =>
    same(parse({ excludeStatus: 'archived,suspended' }), ['archived', 'suspended']));
  await assert('repeated parameter (Express array) → array', () =>
    same(parse({ excludeStatus: ['archived', 'suspended'] }), ['archived', 'suspended']));
  await assert('spaces trimmed, duplicates collapsed, empty tokens dropped', () =>
    same(parse({ excludeStatus: ' archived , archived,,suspended,' }), ['archived', 'suspended']));
  await assert('empty value → undefined', () => parse({ excludeStatus: '' }) === undefined);
  await assert('all five statuses accepted', () =>
    parse({ excludeStatus: 'draft,active,archived,pending_review,suspended' })!.length === 5);
  await assert('an unknown status is REJECTED (400), not ignored', () =>
    !ProductQuerySchema.safeParse({ excludeStatus: 'archived,deleted' }).success);
  await assert('case matters — "Archived" is unknown', () =>
    !ProductQuerySchema.safeParse({ excludeStatus: 'Archived' }).success);
  await assert('status + excludeStatus of the same value parses (empty result, not an error)', () =>
    ProductQuerySchema.safeParse({ status: 'archived', excludeStatus: 'archived' }).success);

  console.log('\n§ 2 — repository filter (shared by count and page)');

  await assert('no status filters → no status key at all', async () => {
    const s = await captureFilters({});
    return !('status' in s.find) && !('status' in s.count);
  });
  await assert('excludeStatuses alone → { $nin }', async () => {
    const s = await captureFilters({ excludeStatuses: ['archived'] });
    return same(s.find.status, { $nin: ['archived'] });
  });
  await assert('status alone → { $eq }', async () => {
    const s = await captureFilters({ status: 'active' });
    return same(s.find.status, { $eq: 'active' });
  });
  await assert('both → { $eq, $nin } (status = X AND NOT IN)', async () => {
    const s = await captureFilters({ status: 'archived', excludeStatuses: ['archived', 'suspended'] });
    return same(s.find.status, { $eq: 'archived', $nin: ['archived', 'suspended'] });
  });
  await assert('empty excludeStatuses array → no exclusion', async () => {
    const s = await captureFilters({ excludeStatuses: [] });
    return !('status' in s.find);
  });
  await assert('countDocuments gets the SAME filter as find (totals reflect the exclusion)', async () => {
    const s = await captureFilters({ excludeStatuses: ['archived'] });
    return s.count === s.find && same(s.count.status, { $nin: ['archived'] });
  });
  await assert('ownership and soft-delete guards survive', async () => {
    const s = await captureFilters({ excludeStatuses: ['archived'] });
    return s.find.vendorId === 'vendor-1' && s.find.deletedAt === null;
  });

  console.log('\n§ 3 — source scans');

  const controller = read('src/modules/catalog/controllers/vendor-product.controller.ts');
  await assert('controller passes excludeStatus through to the list service', () =>
    /excludeStatuses:\s*query\.excludeStatus/.test(controller));
  await assert('the debug console.log of every product list is gone', () =>
    !/console\.log\(\s*\{\s*query/.test(controller));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
