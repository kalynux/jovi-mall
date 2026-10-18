/**
 * Test: a vendor's PERMANENT product deletion (2026-10-18, owner decision "option A").
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free.
 *
 * What is worth testing without a database, and why:
 *
 *   1. **The rule.** `evaluateProductDeletion` is the whole decision — archived, and never
 *      ordered, booked, downloaded or reviewed, with nothing in flight. Every reason is
 *      asserted alone and all of them together, because the contract is that a refusal
 *      lists EVERY blocker, not the first.
 *   2. **The body.** `{ confirm: true }`, `.strict()`. It is the only thing between a
 *      client that knows the old archiving `DELETE /:id` and an irreversible delete.
 *   3. **The CENSUS — the most valuable section.** Every model that references a product
 *      must be either handled by the delete service or named here as deliberately kept,
 *      with the reason. A collection added next year that points at products fails this
 *      suite until somebody decides whether deleting a product must touch it — otherwise
 *      it is silently left pointing at nothing.
 *   4. **Source scans** for what is structural: the archiving route still archives, the
 *      refusal is thrown before the first write, the AI index is told AFTER the commit,
 *      the counts are "ever" (no `deletedAt` filter), nothing soft-deletes, the dead
 *      `ProductDeleteService` is gone, and both archive routes now tell the index.
 *
 * Not covered here, and needing a replica set: that the deletes really run in one
 * transaction and roll back together.
 *
 * Run: npm run test:product-delete
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  evaluateProductDeletion,
  ProductDeleteFacts,
  PRODUCT_DELETE_BLOCKER_REASONS,
  productDeleteBlockerMessage,
} from '../../src/modules/catalog/domain/services/product-permanent-delete.rule';
import { PermanentDeleteProductSchema } from '../../src/modules/catalog/validators/product.validator';

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
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Strip comments so a scan reads code, not the tombstones that explain it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const CLEAN: ProductDeleteFacts = {
  status: 'archived',
  orderCount: 0,
  bookingCount: 0,
  digitalEntitlementCount: 0,
  reviewCount: 0,
  activeReservationCount: 0,
  liveNegotiationCount: 0,
  countedAgencyStockRowCount: 0,
  pendingStockRequestCount: 0,
};

const reasons = (facts: ProductDeleteFacts) => evaluateProductDeletion(facts).map((b) => b.reason);

// ─── 1. The rule ───────────────────────────────────────────────────────────────
console.log('\n1. evaluateProductDeletion');

assert('an archived product nothing points at may be deleted', () => evaluateProductDeletion(CLEAN).length === 0);

for (const status of ['active', 'draft', 'suspended', 'pending_review'] as const) {
  assert(`status '${status}' is refused as not_archived`, () => {
    const r = reasons({ ...CLEAN, status });
    return r.length === 1 && r[0] === 'not_archived';
  });
}

const SINGLE: Array<[keyof ProductDeleteFacts, string]> = [
  ['orderCount', 'has_orders'],
  ['bookingCount', 'has_bookings'],
  ['digitalEntitlementCount', 'has_digital_purchases'],
  ['reviewCount', 'has_reviews'],
  ['activeReservationCount', 'checkout_in_progress'],
  ['liveNegotiationCount', 'negotiation_in_progress'],
  ['countedAgencyStockRowCount', 'agency_stock_counted'],
  ['pendingStockRequestCount', 'stock_request_pending'],
];

for (const [field, reason] of SINGLE) {
  assert(`${field} = 3 blocks with '${reason}' and reports the count`, () => {
    const blockers = evaluateProductDeletion({ ...CLEAN, [field]: 3 });
    return blockers.length === 1 && blockers[0].reason === reason && blockers[0].count === 3;
  });
}

assert('ONE past order is enough — the bar is "never sold", not "few sales"', () =>
  reasons({ ...CLEAN, orderCount: 1 }).includes('has_orders'));

assert('every blocker is reported at once, not just the first', () => {
  const all = evaluateProductDeletion({
    status: 'active',
    orderCount: 1,
    bookingCount: 1,
    digitalEntitlementCount: 1,
    reviewCount: 1,
    activeReservationCount: 1,
    liveNegotiationCount: 1,
    countedAgencyStockRowCount: 1,
    pendingStockRequestCount: 1,
  });
  return all.length === PRODUCT_DELETE_BLOCKER_REASONS.length
    && PRODUCT_DELETE_BLOCKER_REASONS.every((r) => all.some((b) => b.reason === r));
});

assert('not_archived carries no count', () =>
  evaluateProductDeletion({ ...CLEAN, status: 'draft' })[0].count === undefined);

assert('every reason has a vendor-facing sentence, not a code identifier', () =>
  PRODUCT_DELETE_BLOCKER_REASONS.every((r) => {
    const m = productDeleteBlockerMessage(r);
    return typeof m === 'string' && m.length > 20 && !m.includes('_') && /[.]$/.test(m);
  }));

assert('each blocker carries the same sentence the message table holds', () =>
  evaluateProductDeletion({ ...CLEAN, status: 'draft', orderCount: 2 })
    .every((b) => b.message === productDeleteBlockerMessage(b.reason)));

// ─── 2. The body ───────────────────────────────────────────────────────────────
console.log('\n2. PermanentDeleteProductSchema');

assert('{ confirm: true } is accepted', () => PermanentDeleteProductSchema.safeParse({ confirm: true }).success);
assert('an empty body is refused', () => !PermanentDeleteProductSchema.safeParse({}).success);
assert('confirm: false is refused', () => !PermanentDeleteProductSchema.safeParse({ confirm: false }).success);
assert('confirm: "true" (a string) is refused', () => !PermanentDeleteProductSchema.safeParse({ confirm: 'true' }).success);
assert('an unknown key is refused (.strict)', () =>
  !PermanentDeleteProductSchema.safeParse({ confirm: true, purgeAt: '2026-11-01' }).success);

// ─── 3. The census ─────────────────────────────────────────────────────────────
console.log('\n3. Every model that references a product is handled or deliberately kept');

const SERVICE_REL = 'src/modules/catalog/domain/services/ProductPermanentDeleteService.ts';
const serviceText = read(SERVICE_REL);

/**
 * Models that point at a product and that deletion deliberately leaves alone. Each
 * needs a reason; "nobody thought about it" is the failure this list exists to prevent.
 */
const KEPT: Record<string, string> = {
  'src/modules/shipments/shipment.model.ts':
    'a shipment exists only for an order, and an ordered product cannot be deleted',
  'src/modules/inventory/models/agency-storage-invoice.model.ts':
    "the agency's issued statements — accounting history, never dereferenced to function",
  'src/modules/inventory/models/agency-stock-movement.model.ts':
    "the agency's stock ledger — kept, and a product with counted stock is refused anyway",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(model|schema)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const referencing = walk(path.join(SRC, 'modules'))
  .filter((f) => /ref:\s*MODELS\.(PRODUCT|PRODUCT_VARIANT)\b/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

const importedByService = new Set(
  [...serviceText.matchAll(/from '([^']+\.model)'/g)].map((m) =>
    path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, SERVICE_REL)), m[1] + '.ts')).split(path.sep).join('/'),
  ),
);

assert('the census finds the models it is meant to (sanity: at least 20)', () => referencing.length >= 20);

for (const file of referencing) {
  assert(`${file} is handled by the delete service or kept with a reason`, () =>
    importedByService.has(file) || file in KEPT);
}

for (const kept of Object.keys(KEPT)) {
  assert(`the KEPT entry ${kept} still exists and still references a product`, () =>
    referencing.includes(kept));
}

// ─── 4. Source scans ───────────────────────────────────────────────────────────
console.log('\n4. Structural guarantees');

const routes = code(read('src/modules/catalog/routes/vendor-products.routes.ts'));
const controller = code(read('src/modules/catalog/controllers/vendor-product.controller.ts'));
const service = code(serviceText);

assert('DELETE /:id still ARCHIVES — the old buttons must not become a permanent delete', () =>
  /router\.delete\('\/:id',\s*requireProductEditable,\s*VendorProductController\.archiveProduct\)/.test(routes));

assert('DELETE /:id/permanent is mounted, behind requireProductEditable', () =>
  /router\.delete\('\/:id\/permanent',\s*requireProductEditable,\s*VendorProductController\.deleteProductPermanently\)/.test(routes));

assert('the handler parses the confirm body before deleting anything', () => {
  const body = controller.slice(controller.indexOf('static deleteProductPermanently'));
  const parse = body.indexOf('PermanentDeleteProductSchema.parse');
  const exec = body.indexOf('productPermanentDeleteService.execute');
  return parse > -1 && exec > parse;
});

assert('the deletion runs inside runInTransactionWithRetry', () =>
  /runInTransactionWithRetry\(\s*\(session\)\s*=>\s*this\.deleteInSession\(/.test(service));

assert('the blocker refusal is thrown before the first write', () => {
  const inSession = service.slice(service.indexOf('private async deleteInSession'));
  const refusal = inSession.indexOf('CATALOG_PRODUCT_DELETE_BLOCKED');
  const firstWrite = Math.min(
    ...['deleteMany(', 'deleteOne(', 'updateMany(', 'removeAllForEntity('].map((w) => {
      const i = inSession.indexOf(w);
      return i === -1 ? Infinity : i;
    }),
  );
  return refusal > -1 && refusal < firstWrite;
});

assert('the AI index is told AFTER the commit, never inside the transaction', () => {
  const exec = service.slice(service.indexOf('async execute('), service.indexOf('private async deleteInSession'));
  const inSession = service.slice(service.indexOf('private async deleteInSession'), service.indexOf('private async gatherFacts'));
  return exec.indexOf('removeFromIndex') > exec.indexOf('runInTransactionWithRetry') && !inSession.includes('removeFromIndex');
});

assert('the AI index is removed by id (removeFromIndex), not by deleteVectorisation, which needs the row', () =>
  service.includes('vectorisationService.removeFromIndex(') && !service.includes('deleteVectorisation('));

assert('the "never sold" counts filter on no deletedAt — a deleted review or old order still counts', () => {
  const facts = service.slice(service.indexOf('private async gatherFacts'), service.indexOf('private async removeFromCarts'));
  return facts.length > 0 && !facts.includes('deletedAt');
});

assert('the product row is HARD deleted — no soft delete, no purgeAt anywhere in the service', () =>
  service.includes('ProductModel.deleteOne(') && !/softDelete|purgeAt/.test(service));

assert('the product row is deleted LAST, after everything that pointed at it', () => {
  const inSession = service.slice(service.indexOf('private async deleteInSession'), service.indexOf('private async gatherFacts'));
  const productDelete = inSession.indexOf('ProductModel.deleteOne(');
  const lastOther = inSession.lastIndexOf('deleteMany(');
  return productDelete > lastOther;
});

assert('files are deleted only once nothing references them', () =>
  /countByFile\(fileId\)\)\s*>\s*0\)\s*continue/.test(service));

assert('the dead ProductDeleteService is gone, and nothing in src/ names it', () => {
  const gone = !fs.existsSync(path.join(SRC, 'modules/catalog/domain/services/ProductDeleteService.ts'));
  const mentions = walkTs(SRC).filter((f) => /\bProductDeleteService\b/.test(code(fs.readFileSync(f, 'utf8'))));
  return gone && mentions.length === 0;
});

assert('single archive tells the AI index the product is archived', () => {
  const body = controller.slice(controller.indexOf('static archiveProduct'), controller.indexOf('static deleteProductPermanently'));
  return /notifyStatusChange\(id,\s*'archived'\)/.test(body);
});

assert('bulk archive tells the AI index — only for the products actually archived', () => {
  const body = controller.slice(controller.indexOf('static bulkArchive'), controller.indexOf('static bulkStatusChange'));
  const helper = controller.slice(controller.indexOf('async function notifyArchived'), controller.indexOf('function publishCapacityFreed'));
  return body.includes('notifyArchived(') && /status:\s*'archived'/.test(helper) && helper.includes("notifyStatusChanges(");
});

assert('the service imports models by FILE, never through a module barrel', () =>
  ![...serviceText.matchAll(/from '([^']+)'/g)].some((m) => /\/index$|modules\/[a-z-]+'?$/.test(m[1])));

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ─── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
