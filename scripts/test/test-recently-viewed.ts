/**
 * Test: recently viewed products (Phase 6 · 6.E.2).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — the service takes its repository, the catalogue and the customer repository
 * through its constructor, so the ordering, the cap and the eviction are driven for real.
 *
 * ── The three properties the plan names, and why each is easy to get wrong ───
 *
 * **1. Re-viewing moves an entry to the head rather than duplicating it.** This is the ONE
 * line where this collection differs from the wishlist (`$set: { viewed_at }` here,
 * `$setOnInsert` there), and the failure mode is silent: the list still renders, still has
 * the right length, and simply never reorders. The fake repository below therefore
 * reproduces the real one's operators rather than its convenience — a fake that just
 * pushed would pass a "no duplicates" assertion and hide the inversion.
 *
 * **2. The cap evicts the oldest.** Enforced on write, deliberately not by a TTL: Mongo's
 * TTL sweeper runs on its own schedule, so a customer browsing quickly would see a list
 * that is sometimes 20 long and sometimes 200.
 *
 * **3. The list survives a product going unpublished.** Nothing cascades into this
 * collection; the read degrades the entry to `product: null`.
 *
 * Plus **O-2**: `Customer.recent_product_code` is kept and maintained by this write path,
 * which is the decision the plan recorded rather than retiring the field.
 *
 * Run: npm run test:recently-viewed
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { RecentlyViewedService } from '../../src/modules/customers/services/recently-viewed.service';
import { CUSTOMER_CATALOG_CONFIG } from '../../src/modules/customers/config/customer-catalog.config';
import { RecordProductViewSchema } from '../../src/modules/customers/validators/customer-catalog.validator';
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
  viewed_at: Date;
}

/**
 * An in-memory `recently_viewed_items` reproducing the real repository's OPERATORS.
 *
 * ⚠ `touch` overwrites `viewed_at` on a repeat and reports whether it INSERTED, because the
 * service uses that flag to decide whether the cap needs enforcing at all. Both halves are
 * under test: a fake that always reported `inserted: true` would hide the optimisation, and
 * one that always reported `false` would hide a genuine cap failure.
 */
class FakeRecentRepo {
  public rows: Row[] = [];
  public evictions = 0;
  private clock = 0;

  async touch(customerId: string, productId: string, _viewedAt: Date) {
    // A monotonic fake clock rather than `new Date()`: two views inside the same
    // millisecond are exactly the case a real double-render produces, and a wall clock
    // would make the ordering assertions flaky rather than wrong.
    const viewedAt = new Date(++this.clock);
    const existing = this.rows.find(
      (r) => r.customer_id.toString() === customerId && r.product_id.toString() === productId
    );
    if (existing) {
      existing.viewed_at = viewedAt; // $set — this is what moves it to the head
      return { inserted: false };
    }
    this.rows.push({
      customer_id: { toString: () => customerId },
      product_id: { toString: () => productId },
      viewed_at: viewedAt,
    });
    return { inserted: true };
  }

  async evictBeyondCap(customerId: string, cap: number) {
    this.evictions++;
    const mine = this.rows
      .filter((r) => r.customer_id.toString() === customerId)
      .sort((a, b) => b.viewed_at.getTime() - a.viewed_at.getTime());
    const overflow = mine.slice(cap);
    this.rows = this.rows.filter((r) => !overflow.includes(r));
    return overflow.length;
  }

  async listPage(customerId: string, page: number, limit: number) {
    const all = this.rows
      .filter((r) => r.customer_id.toString() === customerId)
      .sort((a, b) => b.viewed_at.getTime() - a.viewed_at.getTime());
    return { rows: all.slice((page - 1) * limit, page * limit), total: all.length };
  }

  async clear(customerId: string) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.customer_id.toString() !== customerId);
    return before - this.rows.length;
  }
}

class FakeCatalog {
  constructor(public publishable: Set<string> = new Set()) {}
  async listByIds(ids: string[]) {
    return new Map(
      ids.filter((id) => this.publishable.has(id)).map((id) => [id, { id, title: `Product ${id}` } as never])
    );
  }
}

/** Captures the O-2 write. `null` is a real value here — clearing must reach the field. */
class FakeCustomerRepo {
  public updates: Array<{ customerId: string; updates: Record<string, unknown> }> = [];
  async updateProfile(customerId: string, updates: Record<string, unknown>) {
    this.updates.push({ customerId, updates });
    return null;
  }
}

const CUSTOMER = 'cust-1';
const OTHER = 'cust-2';
const pid = (n: number): string => `bbbbbbbbbbbbbbbbbbbbbb${String(n).padStart(2, '0')}`;

function harness(cap = 3, count = 10) {
  const repo = new FakeRecentRepo();
  const ids = Array.from({ length: count }, (_, i) => pid(i + 1));
  const catalog = new FakeCatalog(new Set(ids));
  const customers = new FakeCustomerRepo();
  return {
    repo,
    catalog,
    customers,
    ids,
    service: new RecentlyViewedService(repo as never, catalog as never, customers as never, cap),
  };
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const modelSrc = read('modules/customers/models/recently-viewed-item.model.ts');
const repoSrc = stripComments(read('modules/customers/repositories/recently-viewed.repository.ts'));
const serviceSrc = stripComments(read('modules/customers/services/recently-viewed.service.ts'));
const validatorSrc = read('modules/customers/validators/customer-catalog.validator.ts');
const customerModelSrc = read('modules/customers/customer.model.ts');
const profileDtoSrc = read('modules/customers/dto/customer-profile.dto.ts');

// ═════════════════════════════════════════════════════════════════════════════

section('Ordering — re-viewing MOVES an entry, it does not duplicate it');

assert('a repeat view creates no second row', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[0]);
  return h.repo.rows.length === 1;
});

assert('⚠ …and it moves that entry to the HEAD — the opposite of the wishlist rule', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  await h.service.record(CUSTOMER, h.ids[0]); // return to the older one

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  return data[0].productId === h.ids[0] && data[1].productId === h.ids[1];
});

assert('the list is most-recent-first with no repeat views at all', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  await h.service.record(CUSTOMER, h.ids[2]);

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  return data.map((e) => e.productId).join(',') === [h.ids[2], h.ids[1], h.ids[0]].join(',');
});

assert('`at` is the LAST view, not the first — that is what the ordering means', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  await h.service.record(CUSTOMER, h.ids[0]); // return to the first one

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  const revisited = data.find((e) => e.productId === h.ids[0])!;
  const untouched = data.find((e) => e.productId === h.ids[1])!;

  // Compared against each OTHER rather than against a wall clock: the stored `at` is what
  // the ordering reads, and "the revisited entry is now the newer of the two" is the whole
  // claim. If `$setOnInsert` were used instead of `$set`, this inverts.
  return revisited.at.getTime() > untouched.at.getTime() && data[0].productId === h.ids[0];
});

section('The cap — evicting the oldest, on write');

assert('the list never grows past the cap', async () => {
  const h = harness(3);
  for (const id of h.ids.slice(0, 6)) await h.service.record(CUSTOMER, id);
  return h.repo.rows.length === 3;
});

assert('⚠ it is the OLDEST that goes, not the newest', async () => {
  const h = harness(3);
  for (const id of h.ids.slice(0, 4)) await h.service.record(CUSTOMER, id);

  const { data } = await h.service.list(CUSTOMER, 1, 10);
  const kept = data.map((e) => e.productId);
  return kept.length === 3 && !kept.includes(h.ids[0]) && kept.includes(h.ids[3]);
});

assert('a re-view rescues an entry from eviction, because it is no longer the oldest', async () => {
  const h = harness(3);
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  await h.service.record(CUSTOMER, h.ids[2]);
  await h.service.record(CUSTOMER, h.ids[0]); // ids[0] becomes newest; ids[1] is now oldest
  await h.service.record(CUSTOMER, h.ids[3]);

  const kept = (await h.service.list(CUSTOMER, 1, 10)).data.map((e) => e.productId);
  return kept.length === 3 && kept.includes(h.ids[0]) && !kept.includes(h.ids[1]);
});

assert(
  '⚠ a repeat view runs NO eviction query — only an insert can push the list over the cap',
  async () => {
    const h = harness(3);
    await h.service.record(CUSTOMER, h.ids[0]);
    const afterInsert = h.repo.evictions;
    await h.service.record(CUSTOMER, h.ids[0]);
    return afterInsert === 1 && h.repo.evictions === 1;
  },
);

assert('one customer\'s cap does not evict another customer\'s rows', async () => {
  const h = harness(2);
  await h.service.record(OTHER, h.ids[0]);
  await h.service.record(OTHER, h.ids[1]);
  for (const id of h.ids.slice(0, 4)) await h.service.record(CUSTOMER, id);

  return h.repo.rows.filter((r) => r.customer_id.toString() === OTHER).length === 2;
});

assert('the cap is configuration, not a literal in the rule', () =>
  CUSTOMER_CATALOG_CONFIG.RECENTLY_VIEWED_CAP > 0
  && serviceSrc.includes('CUSTOMER_CATALOG_CONFIG.RECENTLY_VIEWED_CAP'));

section('Surviving a product going unpublished');

assert('⚠ an unpublished product degrades to product: null rather than breaking the list', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);

  h.catalog.publishable.delete(h.ids[0]);

  const { data, meta } = await h.service.list(CUSTOMER, 1, 10);
  const degraded = data.find((e) => e.productId === h.ids[0]);
  return meta.total === 2 && data.length === 2 && degraded?.product === null;
});

assert('the row itself survives — nothing cascades into this collection', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  h.catalog.publishable.clear();
  await h.service.list(CUSTOMER, 1, 10);
  return h.repo.rows.length === 1;
});

assert('recording an unpublishable product is refused — 404, and no row', async () => {
  const h = harness();
  h.catalog.publishable.delete(h.ids[0]);
  const code = await codeOf(() => h.service.record(CUSTOMER, h.ids[0]));
  return code === ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND && h.repo.rows.length === 0;
});

section('O-2 — `Customer.recent_product_code` is KEPT and maintained');

assert('the field still exists on the model and is still on the profile DTO', () =>
  /recent_product_code:\s*\{\s*type:\s*String/.test(customerModelSrc)
  && profileDtoSrc.includes('recentProductCode'));

assert('recording a view maintains it', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  const last = h.customers.updates.at(-1);
  return last?.customerId === CUSTOMER && last?.updates.recent_product_code === h.ids[0];
});

assert('it tracks the LATEST view, not the first', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  return h.customers.updates.at(-1)?.updates.recent_product_code === h.ids[1];
});

assert('clearing the list clears it too — a forgotten history must not leave a pointer', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.clear(CUSTOMER);
  return h.customers.updates.at(-1)?.updates.recent_product_code === null;
});

assert(
  '⚠ maintaining it is BEST-EFFORT — a failure there must not turn a recorded view into an error',
  async () => {
    const h = harness();
    h.customers.updateProfile = async () => {
      throw new Error('mongo is down');
    };
    const code = await codeOf(() => h.service.record(CUSTOMER, h.ids[0]));
    return code === null && h.repo.rows.length === 1;
  },
);

section('Clearing');

assert('clear removes this customer\'s rows and reports how many', async () => {
  const h = harness();
  await h.service.record(CUSTOMER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  const { removed } = await h.service.clear(CUSTOMER);
  return removed === 2 && (await h.service.list(CUSTOMER, 1, 10)).meta.total === 0;
});

assert('…and leaves everybody else\'s alone', async () => {
  const h = harness();
  await h.service.record(OTHER, h.ids[0]);
  await h.service.record(CUSTOMER, h.ids[1]);
  await h.service.clear(CUSTOMER);
  return h.repo.rows.length === 1 && h.repo.rows[0].customer_id.toString() === OTHER;
});

section('Ownership and pagination');

assert('one customer never sees another\'s history', async () => {
  const h = harness();
  await h.service.record(OTHER, h.ids[0]);
  const { data, meta } = await h.service.list(CUSTOMER, 1, 10);
  return data.length === 0 && meta.total === 0;
});

assert('the page boundary splits without repeating or losing a row', async () => {
  const h = harness(10);
  for (const id of h.ids.slice(0, 3)) await h.service.record(CUSTOMER, id);

  const first = await h.service.list(CUSTOMER, 1, 2);
  const second = await h.service.list(CUSTOMER, 2, 2);
  const seen = [...first.data, ...second.data].map((e) => e.productId);
  return first.data.length === 2 && second.data.length === 1 && new Set(seen).size === 3;
});

section('Structure — what no fake can see');

assert('⚠ the unique compound index is declared', () =>
  /index\(\s*\{\s*customer_id:\s*1,\s*product_id:\s*1\s*\}\s*,\s*\{\s*unique:\s*true\s*\}\s*\)/.test(modelSrc));

assert('⚠ …and registered as a migration — autoIndex is off in production', () =>
  MIGRATIONS.some((m) => m.name === 'migrate:customer-catalog-indexes'));

assert('the list index is on viewed_at, not created_at — the wrong one never reorders', () =>
  /index\(\s*\{\s*customer_id:\s*1,\s*viewed_at:\s*-1\s*\}\s*\)/.test(modelSrc)
  && !/index\(\s*\{\s*customer_id:\s*1,\s*created_at:\s*-1\s*\}\s*\)/.test(modelSrc));

assert(
  '⚠ the repository $SETs viewed_at rather than $setOnInsert — this is the one line that differs from the wishlist',
  () => /\$set:\s*\{\s*viewed_at/.test(repoSrc) && !/\$setOnInsert:\s*\{\s*viewed_at/.test(repoSrc),
);

assert('the eviction selects by viewed_at and skips the cap, rather than deleting by age', () =>
  /\.sort\(\{\s*viewed_at:\s*-1[\s\S]{0,40}?\.skip\(cap\)/.test(repoSrc)
  && !/created_at:\s*\{\s*\$lt/.test(repoSrc));

assert('the reads and the eviction sort by viewed_at, never created_at', () => {
  const sorts = repoSrc.match(/\.sort\(\{[^}]*\}\)/g) ?? [];
  return sorts.length >= 2 && sorts.every((s) => s.includes('viewed_at'));
});

assert('every repository query is scoped by customer_id, or by ids a scoped query produced', () => {
  const queries = repoSrc.match(/RecentlyViewedItemModel\.\w+\([\s\S]{0,140}/g) ?? [];
  if (queries.length < 4) return false;

  // ⚠ ONE query is legitimately not customer-scoped: the eviction's delete-by-id. It
  // removes exactly the `_id`s the customer-scoped select immediately above it produced,
  // which is why a `$in: overflow` shape is accepted here — and why both halves of that
  // pair are asserted rather than the exception simply being waived.
  const everyScoped = queries.every(
    (q) => q.includes('customer_id') || /\(\s*filter[,)\s]/.test(q) || /_id:\s*\{\s*\$in:\s*overflow/.test(q),
  );
  const localsScoped = (repoSrc.match(/const filter = \{[^}]*\}/g) ?? []).every((d) => d.includes('customer_id'));

  // The exception's own precondition: `overflow` is filled by a customer-scoped find.
  const overflowIsScoped = /const overflow = await RecentlyViewedItemModel\.find\(\s*\{\s*customer_id/.test(repoSrc);

  return everyScoped && localsScoped && overflowIsScoped;
});

assert(
  '⚠ the record schema carries NO timestamp — a client-chosen time is a client-chosen position in a capped list',
  () => !RecordProductViewSchema.safeParse({ productId: pid(1), viewedAt: new Date().toISOString() }).success
    && !/viewedAt|viewed_at/.test(validatorSrc),
);

assert('…and the service takes the time from its own clock', () =>
  /const viewedAt = new Date\(\)/.test(serviceSrc));

assert('the record schema is .strict() and validates the id shape', () =>
  RecordProductViewSchema.safeParse({ productId: pid(1) }).success
  && !RecordProductViewSchema.safeParse({ productId: 'nope' }).success);

// ═════════════════════════════════════════════════════════════════════════════

void (async () => {
  originalConsole.log('\n👁  Recently viewed — Phase 6 · 6.E.2\n');
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
  originalConsole.log(`\n${failed === 0 ? '✔' : '✖'} test:recently-viewed — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
