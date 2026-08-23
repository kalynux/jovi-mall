/**
 * Test: saved products — the customer wishlist (Phase 6 · 6.E.1).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — `WishlistService` takes its repository and the catalogue through its
 * constructor, so the behavioural half runs against an in-memory store that reproduces the
 * real repository's OPERATORS (an upsert against a unique key, `$setOnInsert` on the
 * timestamp) rather than its convenience.
 *
 * ── What this guards, and what it structurally cannot ────────────────────────
 *
 * The feature's central claim — "the unique index IS the deduplication, not application
 * code" — is a claim about a database constraint, and no DB-free test can prove it. What
 * this suite does instead is prove the two halves that surround it: that the repository
 * *upserts* rather than checking-then-inserting (a source scan), and that the index is
 * declared **and registered as a migration** (`autoIndex` is off in production, so an
 * unregistered unique index is enforced by nothing at all).
 *
 * Everything else — idempotency, the degrade-on-unpublished rule, the not-found-not-
 * forbidden rule, pagination — is driven for real.
 *
 * Run: npm run test:wishlist
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { WishlistService } from '../../src/modules/customers/services/wishlist.service';
import { hydrateCustomerCatalogEntries } from '../../src/modules/customers/dto/customer-catalog.dto';
import {
  AddWishlistItemSchema,
  CustomerCatalogListQuerySchema,
  ProductIdParamSchema,
  SavedAmongSchema,
} from '../../src/modules/customers/validators/customer-catalog.validator';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { MIGRATIONS } from '../migrate';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };

let passed = 0;
let failed = 0;
const pending: Array<{ name: string; fn: () => boolean | Promise<boolean> }> = [];

function assert(name: string, fn: () => boolean | Promise<boolean>): void {
  pending.push({ name, fn });
}

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 70 - title.length))}`);
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.code : `NOT_APP_ERROR:${(err as Error).message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The fakes
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  customer_id: { toString(): string };
  product_id: { toString(): string };
  created_at: Date;
}

/**
 * An in-memory `wishlist_items`.
 *
 * ⚠ `add` reproduces the real repository's UPSERT semantics — it looks for an existing
 * `(customer, product)` row and leaves its `created_at` alone. That is what makes the
 * idempotency and the "re-saving does not reorder" assertions mean something: a fake that
 * simply pushed would pass the first and silently invert the second.
 */
class FakeWishlistRepo {
  public rows: Row[] = [];
  public calls: string[] = [];

  async add(customerId: string, productId: string) {
    this.calls.push('add');
    const existing = this.rows.find(
      (r) => r.customer_id.toString() === customerId && r.product_id.toString() === productId
    );
    if (existing) return existing; // $setOnInsert: the timestamp does NOT move
    const row: Row = {
      customer_id: { toString: () => customerId },
      product_id: { toString: () => productId },
      created_at: new Date(Date.now() + this.rows.length), // deterministic, strictly increasing
    };
    this.rows.push(row);
    return row;
  }

  async remove(customerId: string, productId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (r) => !(r.customer_id.toString() === customerId && r.product_id.toString() === productId)
    );
    return this.rows.length < before;
  }

  async listPage(customerId: string, page: number, limit: number) {
    const all = this.rows
      .filter((r) => r.customer_id.toString() === customerId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return { rows: all.slice((page - 1) * limit, page * limit), total: all.length };
  }

  async savedIdsAmong(customerId: string, productIds: string[]) {
    return new Set(
      this.rows
        .filter((r) => r.customer_id.toString() === customerId)
        .map((r) => r.product_id.toString())
        .filter((id) => productIds.includes(id))
    );
  }
}

/** A catalogue holding only the ids given to it. Anything else is unpublishable. */
class FakeCatalog {
  constructor(public publishable: Set<string> = new Set()) {}
  async listByIds(ids: string[]) {
    return new Map(
      ids
        .filter((id) => this.publishable.has(id))
        .map((id) => [id, { id, title: `Product ${id}`, inStock: true } as never])
    );
  }
}

const CUSTOMER = 'cust-1';
const OTHER = 'cust-2';
const P1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const P2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const P3 = 'aaaaaaaaaaaaaaaaaaaaaaa3';

function harness(publishable: string[] = [P1, P2, P3]) {
  const repo = new FakeWishlistRepo();
  const catalog = new FakeCatalog(new Set(publishable));
  return { repo, catalog, service: new WishlistService(repo as never, catalog as never) };
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const modelSrc = read('modules/customers/models/wishlist-item.model.ts');
const repoSrc = stripComments(read('modules/customers/repositories/wishlist.repository.ts'));
const routesSrc = stripComments(read('modules/customers/routes.ts'));
const controllerSrc = stripComments(read('modules/customers/controllers/customer-catalog.controller.ts'));
const dtoSrc = read('modules/customers/dto/customer-catalog.dto.ts');

// ═════════════════════════════════════════════════════════════════════════════

section('Adding is idempotent');

assert('a duplicate add does not create a second row', async () => {
  const h = harness();
  await h.service.add(CUSTOMER, P1);
  await h.service.add(CUSTOMER, P1);
  return h.repo.rows.length === 1;
});

assert('…and it succeeds rather than raising a conflict', async () => {
  const h = harness();
  await h.service.add(CUSTOMER, P1);
  const code = await codeOf(() => h.service.add(CUSTOMER, P1));
  return code === null;
});

assert('⚠ re-saving does NOT move the entry to the head — a wishlist is ordered by decision', async () => {
  const h = harness();
  await h.service.add(CUSTOMER, P1);
  await h.service.add(CUSTOMER, P2);
  await h.service.add(CUSTOMER, P1); // re-save the older one

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  // P2 was saved last, so it stays first. This is the OPPOSITE of recently-viewed.
  return data[0].productId === P2 && data[1].productId === P1;
});

assert('the add returns the hydrated card, so a client need not re-fetch', async () => {
  const h = harness();
  const entry = await h.service.add(CUSTOMER, P1);
  return entry.productId === P1 && entry.product !== null;
});

section('What may enter the list');

assert('a product that is not publishable cannot be saved — 404, not a silent row', async () => {
  const h = harness([P1]);
  const code = await codeOf(() => h.service.add(CUSTOMER, P2));
  return code === ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND && h.repo.rows.length === 0;
});

assert('…and it is a 404 rather than a 403, so the endpoint is not a draft-catalogue oracle', async () => {
  const h = harness([P1]);
  try {
    await h.service.add(CUSTOMER, P2);
    return false;
  } catch (err) {
    return err instanceof AppError && err.statusCode === 404;
  }
});

section('What may STAY in the list — the degrade rule');

assert('⚠ an unpublished product degrades to product: null rather than 500ing the list', async () => {
  const h = harness([P1, P2]);
  await h.service.add(CUSTOMER, P1);
  await h.service.add(CUSTOMER, P2);

  h.catalog.publishable.delete(P1); // the vendor archives it

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  const degraded = data.find((e) => e.productId === P1);
  return data.length === 2 && degraded?.product === null;
});

assert('…and the row is NOT dropped — the count still matches what is rendered', async () => {
  const h = harness([P1, P2]);
  await h.service.add(CUSTOMER, P1);
  await h.service.add(CUSTOMER, P2);
  h.catalog.publishable.delete(P1);

  const { data, meta } = await h.service.list(CUSTOMER, 1, 10);
  return meta.total === 2 && data.length === 2;
});

assert('a degraded entry keeps its productId, so the remove button still works', async () => {
  const h = harness([P1]);
  await h.service.add(CUSTOMER, P1);
  h.catalog.publishable.clear();

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  return data[0].productId === P1 && data[0].product === null;
});

section('Ownership — not found, never forbidden');

assert("removing another customer's save is NOT FOUND", async () => {
  const h = harness();
  await h.service.add(OTHER, P1);
  const code = await codeOf(() => h.service.remove(CUSTOMER, P1));
  return code === ERROR_CODES.WISHLIST_ITEM_NOT_FOUND;
});

assert('…and it is a 404, which cannot confirm the row exists', async () => {
  const h = harness();
  await h.service.add(OTHER, P1);
  try {
    await h.service.remove(CUSTOMER, P1);
    return false;
  } catch (err) {
    return err instanceof AppError && err.statusCode === 404;
  }
});

assert("…and the other customer's row survives the attempt", async () => {
  const h = harness();
  await h.service.add(OTHER, P1);
  await codeOf(() => h.service.remove(CUSTOMER, P1));
  return h.repo.rows.length === 1;
});

assert('one customer never sees another customer\'s list', async () => {
  const h = harness();
  await h.service.add(OTHER, P1);
  await h.service.add(OTHER, P2);
  const { data, meta } = await h.service.list(CUSTOMER, 1, 10);
  return data.length === 0 && meta.total === 0;
});

assert('removing a save that was never made is not found, rather than a silent success', async () => {
  const h = harness();
  const code = await codeOf(() => h.service.remove(CUSTOMER, P1));
  return code === ERROR_CODES.WISHLIST_ITEM_NOT_FOUND;
});

section('Pagination');

assert('a page carries the platform meta block', async () => {
  const h = harness();
  await h.service.add(CUSTOMER, P1);
  const { meta } = await h.service.list(CUSTOMER, 1, 20);
  return meta.total === 1 && meta.page === 1 && meta.limit === 20 && meta.pages === 1;
});

assert('the page boundary splits without repeating or losing a row', async () => {
  const h = harness([P1, P2, P3]);
  await h.service.add(CUSTOMER, P1);
  await h.service.add(CUSTOMER, P2);
  await h.service.add(CUSTOMER, P3);

  const first = await h.service.list(CUSTOMER, 1, 2);
  const second = await h.service.list(CUSTOMER, 2, 2);
  const seen = [...first.data, ...second.data].map((e) => e.productId);

  return first.data.length === 2
    && second.data.length === 1
    && new Set(seen).size === 3
    && first.meta.pages === 2;
});

assert('an empty list is a successful empty page, never a 404', async () => {
  const h = harness();
  const { data, meta } = await h.service.list(CUSTOMER, 1, 20);
  return data.length === 0 && meta.total === 0 && meta.pages === 1;
});

section('saved-among — one call per grid, not one per card');

assert('it reports only what this customer saved', async () => {
  const h = harness();
  await h.service.add(CUSTOMER, P1);
  await h.service.add(OTHER, P2);
  const saved = await h.service.savedAmong(CUSTOMER, [P1, P2, P3]);
  return saved.length === 1 && saved[0] === P1;
});

assert('it is bounded — a caller cannot ask about an unbounded set', () =>
  !SavedAmongSchema.safeParse({ productIds: new Array(101).fill(P1) }).success
  && SavedAmongSchema.safeParse({ productIds: [P1] }).success);

section('Validation');

assert('a malformed product id is refused before it becomes an ObjectId', () =>
  !AddWishlistItemSchema.safeParse({ productId: 'not-an-id' }).success
  && !ProductIdParamSchema.safeParse({ productId: '123' }).success
  && AddWishlistItemSchema.safeParse({ productId: P1 }).success);

assert('the add schema is .strict() — an unknown key is a 400, not a stripped field', () =>
  !AddWishlistItemSchema.safeParse({ productId: P1, note: 'for later' }).success);

assert('limit is capped at 100, matching the platform pagination contract', () => {
  const over = CustomerCatalogListQuerySchema.safeParse({ limit: '500' });
  const ok = CustomerCatalogListQuerySchema.safeParse({ limit: '100' });
  return !over.success && ok.success;
});

assert('page and limit default rather than being required', () => {
  const parsed = CustomerCatalogListQuerySchema.parse({});
  return parsed.page === 1 && parsed.limit === 20;
});

section('Structure — what no fake can see');

assert('⚠ the unique compound index is declared on the model', () =>
  /index\(\s*\{\s*customer_id:\s*1,\s*product_id:\s*1\s*\}\s*,\s*\{\s*unique:\s*true\s*\}\s*\)/.test(modelSrc));

assert(
  '⚠ …AND it is registered as a migration — autoIndex is off in production, so an unregistered unique index is enforced by NOTHING',
  () => MIGRATIONS.some((m) => m.name === 'migrate:customer-catalog-indexes'),
);

assert('the list read has its own index, so one customer\'s page is not a collection scan', () =>
  /index\(\s*\{\s*customer_id:\s*1,\s*created_at:\s*-1\s*\}\s*\)/.test(modelSrc));

assert(
  '⚠ the repository UPSERTS rather than checking-then-inserting — the race a check would lose is the whole reason the index exists',
  () => /findOneAndUpdate\([\s\S]{0,400}?upsert:\s*true/.test(repoSrc) && !/findOne\(\{[^)]*\}\)[\s\S]{0,80}if\s*\(/.test(repoSrc),
);

assert('…and it uses $setOnInsert, so a re-save cannot rewrite the original timestamp', () =>
  /\$setOnInsert:\s*\{\s*created_at/.test(repoSrc));

assert('every repository query is scoped by customer_id — ownership is the query, not a check', () => {
  const queries = repoSrc.match(/WishlistItemModel\.\w+\([\s\S]{0,140}/g) ?? [];
  if (queries.length < 4) return false;

  // Two of the five pass a `filter` local rather than an inline predicate, so the scan
  // accepts that name — and then proves the local is itself customer-scoped. Accepting it
  // without that second half would let a future `const filter = {}` walk straight through.
  const everyQueryScoped = queries.every((q) => q.includes('customer_id') || /\(\s*filter[,)\s]/.test(q));
  const localsScoped = (repoSrc.match(/const filter = \{[^}]*\}/g) ?? [])
    .every((decl) => decl.includes('customer_id'));

  return everyQueryScoped && localsScoped && /const filter = \{/.test(repoSrc);
});

assert('the controller resolves the owner from req.auth, never from a body or a path segment', () =>
  /req\.auth!\.role_entity\._id\.toString\(\)/.test(controllerSrc)
  && !/customerId.*req\.(body|params|query)/.test(controllerSrc));

assert('the literal /wishlist/saved-among is declared BEFORE /wishlist/:productId', () => {
  const literal = routesSrc.indexOf("'/wishlist/saved-among'");
  const param = routesSrc.indexOf("'/wishlist/:productId'");
  return literal > -1 && param > -1 && literal < param;
});

assert(
  'the card comes from the PUBLIC product DTO — no second product shape for signed-in callers',
  () => dtoSrc.includes("from '../../catalog/dto/public-product.dto'")
    && dtoSrc.includes('PublicProductListItemDto'),
);

assert('the hydrator preserves the caller\'s order rather than re-sorting', () =>
  !/\.sort\(/.test(hydrateCustomerCatalogEntries.toString()));

assert('hydrating nothing costs no query at all', async () => {
  let called = false;
  const spy = { listByIds: async () => { called = true; return new Map(); } };
  const out = await hydrateCustomerCatalogEntries([], spy as never);
  return out.length === 0 && called === false;
});

// ═════════════════════════════════════════════════════════════════════════════

void (async () => {
  originalConsole.log('\n💾 Wishlist — Phase 6 · 6.E.1\n');
  for (const { name, fn } of pending) {
    let ok: boolean;
    try {
      ok = await fn();
    } catch (err) {
      originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
      failed++;
      continue;
    }
    if (ok) {
      originalConsole.log(`  ✅ ${name}`);
      passed++;
    } else {
      originalConsole.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  }
  originalConsole.log(`\n${failed === 0 ? '✔' : '✖'} test:wishlist — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
