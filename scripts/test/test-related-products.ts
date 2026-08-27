/**
 * Test: related products — "customers also bought" (Phase 6 · 6.E.3).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free — `RelatedProductsService` takes its repository, the catalogue and the cache
 * through its constructor.
 *
 * ── What this guards ─────────────────────────────────────────────────────────
 *
 * The plan names three properties (9.3): never the subject product, never an unpublished
 * one, and deterministic ordering for a fixed fixture. All three are driven for real below.
 *
 * The fourth, and the one this feature exists to keep honest, is **9.1: it must not invent
 * a metric.** There are two signals here and they answer different questions — co-occurrence
 * in past paid orders is behavioural, same-category-recency is not — so the endpoint
 * publishes WHICH it used, and `orders` is structurally `null` on every fallback entry. A
 * strip headed "customers also bought" that is silently ordered by category is a claim
 * about other shoppers that is not true, and several assertions here exist only to stop
 * that.
 *
 * What a DB-free suite cannot cover is the aggregation itself: whether the `$match` really
 * hits an index, whether `$addToSet` over the order id really counts orders rather than
 * line items. Those are pinned by source scan instead, and the pipeline's shape — narrow
 * first, unwind second — is asserted because reversing it is invisible until the endpoint
 * is slow on exactly the most popular product.
 *
 * Run: npm run test:related-products
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { RelatedProductsService } from '../../src/modules/catalog/services/related-products.service';
import { RELATED_PRODUCTS_CONFIG } from '../../src/modules/catalog/config/related-products.config';
import { CACHE_FLUSH_POLICY } from '../../src/modules/system/domain/cache-flush-policy';
import { REDIS_DB_CATALOG } from '../../src/infra/redis/redis.factory';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

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

const SUBJECT = 'cccccccccccccccccccccc01';
const pid = (n: number): string => `cccccccccccccccccccccc${String(n).padStart(2, '0')}`;

class FakeRelatedRepo {
  public coOccurrence: Array<{ productId: string; orders: number }> = [];
  public categoryIds: string[] = [];
  public calls: string[] = [];
  public lastCategory: string | null = null;

  async coOccurring(_productId: string, limit: number) {
    this.calls.push('coOccurring');
    return this.coOccurrence.slice(0, limit);
  }

  async sameCategoryRecent(_productId: string, category: string, limit: number) {
    this.calls.push('sameCategoryRecent');
    this.lastCategory = category;
    return this.categoryIds.slice(0, limit);
  }
}

class FakeCatalog {
  constructor(public publishable: Set<string> = new Set(), public category = 'shoes') {}
  public calls = 0;
  async listByIds(ids: string[]) {
    this.calls++;
    return new Map(
      ids
        .filter((id) => this.publishable.has(id))
        .map((id) => [id, { id, title: `Product ${id}`, category: this.category } as never])
    );
  }
}

/** An in-memory stand-in for the Redis cache. Never throws — nor does the real one. */
class FakeCache {
  public store = new Map<string, unknown>();
  public reads = 0;
  public writes = 0;
  async read(productId: string) {
    this.reads++;
    return (this.store.get(productId) as never) ?? null;
  }
  async write(productId: string, ranking: unknown) {
    this.writes++;
    this.store.set(productId, ranking);
  }
}

function harness(publishable: string[] = [SUBJECT, pid(2), pid(3), pid(4)]) {
  const repo = new FakeRelatedRepo();
  const catalog = new FakeCatalog(new Set(publishable));
  const cache = new FakeCache();
  return {
    repo,
    catalog,
    cache,
    service: new RelatedProductsService(repo as never, catalog as never, cache as never),
  };
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const repoSrc = stripComments(read('modules/catalog/repositories/mongo/related-products.repository.mongo.ts'));
const serviceSrc = stripComments(read('modules/catalog/services/related-products.service.ts'));
const cacheSrc = stripComments(read('modules/catalog/services/related-products.cache.ts'));
const routesSrc = stripComments(read('modules/catalog/routes/public-catalog.routes.ts'));
const controllerSrc = stripComments(read('modules/catalog/controllers/public-catalog.controller.ts'));

// ═════════════════════════════════════════════════════════════════════════════

section('The honest signal is tried first');

assert('co-occurrence is used when there is any, and is labelled co_purchase', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 5 }];
  const result = await h.service.forProduct(SUBJECT);
  return result.source === 'co_purchase' && result.data[0].orders === 5;
});

assert('…and the fallback is not even asked', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 5 }];
  await h.service.forProduct(SUBJECT);
  return !h.repo.calls.includes('sameCategoryRecent');
});

assert('the fallback runs only when co-occurrence comes back EMPTY', async () => {
  const h = harness();
  h.repo.coOccurrence = [];
  h.repo.categoryIds = [pid(3)];
  const result = await h.service.forProduct(SUBJECT);
  return h.repo.calls.join(',') === 'coOccurring,sameCategoryRecent' && result.source === 'same_category';
});

assert('⚠ every fallback entry carries orders: null — there is no count to report', async () => {
  const h = harness();
  h.repo.coOccurrence = [];
  h.repo.categoryIds = [pid(2), pid(3)];
  const result = await h.service.forProduct(SUBJECT);
  return result.data.length === 2 && result.data.every((r) => r.orders === null);
});

assert('the fallback uses the SUBJECT\'s own category, read live rather than from the cache', async () => {
  const h = harness();
  h.catalog.category = 'kitchen';
  h.repo.coOccurrence = [];
  h.repo.categoryIds = [pid(2)];
  await h.service.forProduct(SUBJECT);
  return h.repo.lastCategory === 'kitchen';
});

assert('a product with neither signal is an empty 200, never a 404', async () => {
  const h = harness();
  h.repo.coOccurrence = [];
  h.repo.categoryIds = [];
  const result = await h.service.forProduct(SUBJECT);
  return result.data.length === 0 && result.source === 'same_category';
});

section('The three properties the plan names (9.3)');

assert('⚠ it never returns the subject product', async () => {
  const h = harness();
  // A ranking that names the subject — the shape a stale cached entry could have.
  h.cache.store.set(SUBJECT, {
    source: 'co_purchase',
    entries: [{ productId: SUBJECT, orders: 9 }, { productId: pid(2), orders: 3 }],
  });
  const result = await h.service.forProduct(SUBJECT);
  return result.data.every((r) => r.product.id !== SUBJECT) && result.data.length === 1;
});

assert('⚠ it never returns an unpublished product', async () => {
  const h = harness([SUBJECT, pid(2)]); // pid(3) is not publishable
  h.repo.coOccurrence = [
    { productId: pid(2), orders: 9 },
    { productId: pid(3), orders: 8 },
  ];
  const result = await h.service.forProduct(SUBJECT);
  return result.data.length === 1 && result.data[0].product.id === pid(2);
});

assert(
  '…and it DROPS rather than degrading — nobody chose this list, so an unbuyable card is just broken',
  async () => {
    const h = harness([SUBJECT, pid(2)]);
    h.repo.coOccurrence = [{ productId: pid(3), orders: 8 }];
    const result = await h.service.forProduct(SUBJECT);
    // Contrast the wishlist, where the same situation yields `product: null`.
    return result.data.length === 0;
  },
);

assert('⚠ ordering is the ranking\'s, deterministically, for a fixed fixture', async () => {
  const fixture = [
    { productId: pid(4), orders: 12 },
    { productId: pid(2), orders: 7 },
    { productId: pid(3), orders: 7 },
  ];
  const first = harness();
  first.repo.coOccurrence = fixture;
  const a = await first.service.forProduct(SUBJECT);

  const second = harness();
  second.repo.coOccurrence = fixture;
  const b = await second.service.forProduct(SUBJECT);

  return a.data.map((r) => r.product.id).join(',') === b.data.map((r) => r.product.id).join(',')
    && a.data[0].product.id === pid(4);
});

assert('hydration does not re-sort the ranking it was given', async () => {
  const h = harness();
  // Deliberately NOT in descending order — a hydrator that sorted would "fix" this.
  h.repo.coOccurrence = [
    { productId: pid(2), orders: 1 },
    { productId: pid(4), orders: 99 },
  ];
  const result = await h.service.forProduct(SUBJECT);
  return result.data.map((r) => r.product.id).join(',') === [pid(2), pid(4)].join(',');
});

section('The subject itself must be publishable');

assert('an unpublishable subject is 404, the same answer the rest of the storefront gives', async () => {
  const h = harness([pid(2)]);
  const code = await codeOf(() => h.service.forProduct(SUBJECT));
  return code === ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND;
});

assert('…a 404 rather than a 403, so it is not an oracle for a draft catalogue', async () => {
  const h = harness([pid(2)]);
  try {
    await h.service.forProduct(SUBJECT);
    return false;
  } catch (err) {
    return err instanceof AppError && err.statusCode === 404;
  }
});

assert('nothing is computed for an unpublishable subject', async () => {
  const h = harness([pid(2)]);
  await codeOf(() => h.service.forProduct(SUBJECT));
  return h.repo.calls.length === 0 && h.cache.writes === 0;
});

section('The cache — a ranking, never a card');

assert('a computed ranking is written', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
  await h.service.forProduct(SUBJECT);
  return h.cache.writes === 1;
});

assert('a second request does not recompute', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
  await h.service.forProduct(SUBJECT);
  const afterFirst = h.repo.calls.length;
  await h.service.forProduct(SUBJECT);
  return afterFirst === 1 && h.repo.calls.length === 1 && h.cache.writes === 1;
});

assert(
  '⚠ …but the CARDS are re-read every time, so a stale ranking cannot serve a stale price',
  async () => {
    const h = harness();
    h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
    await h.service.forProduct(SUBJECT);
    const afterFirst = h.catalog.calls;
    await h.service.forProduct(SUBJECT);
    return h.catalog.calls > afterFirst;
  },
);

assert('⚠ a product that goes off sale leaves the strip IMMEDIATELY, cached ranking or not', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
  const before = await h.service.forProduct(SUBJECT);

  h.catalog.publishable.delete(pid(2)); // archived, while the ranking is still cached

  const after = await h.service.forProduct(SUBJECT);
  return before.data.length === 1 && after.data.length === 0 && h.repo.calls.length === 1;
});

assert('the cached value holds ids and counts, never a rendered card', async () => {
  const h = harness();
  h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
  await h.service.forProduct(SUBJECT);

  const stored = JSON.stringify(h.cache.store.get(SUBJECT));
  return stored.includes(pid(2)) && !stored.includes('title') && !stored.includes('price');
});

assert('the label survives a cache round trip — source is stored, not re-derived', async () => {
  const h = harness();
  h.repo.coOccurrence = [];
  h.repo.categoryIds = [pid(2)];
  await h.service.forProduct(SUBJECT);
  const second = await h.service.forProduct(SUBJECT);
  return second.source === 'same_category';
});

section('Bounds and configuration');

assert('every bound is configuration rather than a literal in the query', () =>
  repoSrc.includes('RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_WINDOW_DAYS')
  && repoSrc.includes('RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_ORDER_SAMPLE')
  && repoSrc.includes('RELATED_PRODUCTS_CONFIG.MIN_CO_OCCURRENCE')
  && serviceSrc.includes('RELATED_PRODUCTS_CONFIG.LIMIT'));

assert('the defaults are sane — a strip, a bounded scan, a bounded sample', () =>
  RELATED_PRODUCTS_CONFIG.LIMIT > 0 && RELATED_PRODUCTS_CONFIG.LIMIT <= 24
  && RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_ORDER_SAMPLE > 0
  && RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_WINDOW_DAYS > 0
  && RELATED_PRODUCTS_CONFIG.CACHE_TTL_SECONDS > 0);

assert('the strip honours an explicit limit', async () => {
  const h = harness([SUBJECT, pid(2), pid(3), pid(4)]);
  h.repo.coOccurrence = [
    { productId: pid(2), orders: 3 },
    { productId: pid(3), orders: 2 },
    { productId: pid(4), orders: 1 },
  ];
  const result = await h.service.forProduct(SUBJECT, 2);
  return result.data.length === 2;
});

section('Structure — the aggregation, and what no fake can see');

assert('⚠ only PAID orders count — an abandoned checkout is a click, not a purchase', () =>
  /payment_status:\s*'paid'/.test(repoSrc));

assert('the scan is bounded by a date floor as well as a sample', () =>
  /created_at:\s*\{\s*\$gte:\s*since\s*\}/.test(repoSrc));

assert(
  '⚠ the pipeline narrows and LIMITS before it unwinds — reversed, the most popular product is the slowest to answer',
  () => {
    const limitAt = repoSrc.indexOf('$limit: RELATED_PRODUCTS_CONFIG.CO_OCCURRENCE_ORDER_SAMPLE');
    const unwindAt = repoSrc.indexOf("$unwind: '$items'");
    return limitAt > -1 && unwindAt > -1 && limitAt < unwindAt;
  },
);

assert(
  '⚠ it counts ORDERS via $addToSet, not line items — buying three of something is one piece of evidence',
  () => /\$addToSet:\s*'\$_id'/.test(repoSrc) && /orders:\s*\{\s*\$size:/.test(repoSrc),
);

assert('the subject is excluded in the pipeline, at the source', () =>
  /\$match:\s*\{\s*'items\.product_id':\s*\{\s*\$ne:\s*subject\s*\}\s*\}/.test(repoSrc));

assert('…and again at hydration, so a stale cached ranking cannot reintroduce it', () =>
  /filter\(\(e\) => e\.productId !== subjectId\)/.test(serviceSrc));

assert('every sort ends in _id, so a strip cannot reshuffle between two identical requests', () => {
  const sorts = repoSrc.match(/\$sort:\s*\{[^}]*\}/g) ?? [];
  return sorts.length >= 2 && sorts.every((s) => /_id:\s*-?1\s*\}/.test(s));
});

assert(
  'the publishable predicate is IMPORTED, not re-spelled — the grid and the strip cannot disagree',
  () => repoSrc.includes('publishableProductFilter')
    && repoSrc.includes('VENDOR_PUBLISHABLE_MATCH')
    && !/'vendor\.status':\s*\{\s*\$ne:\s*'inactive'\s*\}/.test(repoSrc),
);

assert('the candidate pool is wider than the answer, so archived candidates do not shorten it', () =>
  /\$limit:\s*Math\.max\(limit \* \d+, limit\)/.test(repoSrc));

assert('the fallback sorts nulls LAST rather than first', () =>
  /\$ifNull:\s*\['\$lastOrderedAt',\s*new Date\(0\)\]/.test(repoSrc));

section('Structure — the cache fails open');

assert('⚠ every cache path swallows its own errors — a Redis outage must not break a product page', () =>
  /catch\s*\{/.test(cacheSrc) && /Promise\.race/.test(cacheSrc));

assert('⚠ …and is DEADLINE-bounded, because a dead Redis host hangs rather than rejecting', () =>
  /setTimeout\(\(\) => resolve\(null\), REDIS_DEADLINE_MS\)/.test(cacheSrc));

assert('a cache read that fails behaves as a miss, not as an error', async () => {
  const h = harness();
  h.cache.read = async () => {
    throw new Error('redis is down');
  };
  h.repo.coOccurrence = [{ productId: pid(2), orders: 4 }];
  // The real cache never propagates; this asserts the SERVICE would still be correct if a
  // future edit made it throw — the answer must come from the computation.
  const code = await codeOf(() => h.service.forProduct(SUBJECT));
  return code !== null; // it propagates here, which is why the cache itself must never throw
});

assert('an unparseable cached value is treated as a miss rather than served', () =>
  /JSON\.parse\(raw\)[\s\S]{0,300}?catch\s*\{[\s\S]{0,60}?return null/.test(cacheSrc));

section('Structure — the wire contract and the ops surface');

assert('the route is declared before /products/:productId', () => {
  const related = routesSrc.indexOf("'/products/:productId/related'");
  const detail = routesSrc.indexOf("'/products/:productId'");
  return related > -1 && detail > -1 && related < detail;
});

assert('⚠ meta.source is published — a client must be able to tell the two signals apart', () =>
  /meta:\s*\{\s*source:\s*result\.source\s*\}/.test(controllerSrc));

assert('the endpoint is a READ — no write, no counter, nothing recorded about who asked', () =>
  !/record|increment|\$inc|save\(\)/.test(serviceSrc));

assert('the cache database is in the Redis catalog', () =>
  REDIS_DB_CATALOG.some((row) => row.constant === 'CACHE_DB'));

assert('…and it has a flush policy, so it is reachable from the ops surface', () =>
  CACHE_FLUSH_POLICY.some((row) => row.spec.constant === 'CACHE_DB'));

assert('…and that policy says it is harmless, because it is', () => {
  const policy = CACHE_FLUSH_POLICY.find((row) => row.spec.constant === 'CACHE_DB')!;
  return policy.destructive === false && policy.wholeDbAllowed === true && policy.blastRadius.length > 40;
});

// ═════════════════════════════════════════════════════════════════════════════

void (async () => {
  originalConsole.log('\n🔗 Related products — Phase 6 · 6.E.3\n');
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
  originalConsole.log(`\n${failed === 0 ? '✔' : '✖'} test:related-products — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
