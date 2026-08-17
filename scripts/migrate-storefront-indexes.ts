/**
 * Migration: build the public-storefront indexes on `products`.
 *
 * The storefront's primary query is `{ status: 'active', deletedAt: null }` across
 * ALL vendors, sorted by `createdAt` — and until now nothing served it. Every
 * existing index on the collection is either prefixed by `vendorId` (the whole
 * catalog module is vendor-scoped) or is a standalone five-value `status` enum
 * the planner will never choose. So an anonymous browse page was a collection
 * scan, and `sort=relevance` had nothing to rank by.
 *
 * Three indexes, declared in `product.model.ts` and built here:
 *   { status, deletedAt, createdAt: -1 }   the browse grid + the sitemap feed
 *   { status, deletedAt, category }        the category chips (§2.3) and filter
 *   text( title, tags, description )       search + relevance
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 *
 * `autoIndex` is on, so Mongoose builds these at boot on its own — but a failed
 * build fails **silently**: the promise rejects into a listener nobody attached,
 * the process comes up healthy, and every storefront request quietly scans the
 * collection instead. On a large `products` collection a foreground text-index
 * build is also slow enough to matter, and doing it during a rolling deploy is
 * the wrong time to find that out.
 *
 * Running this first makes the build explicit, ordered and observable, and turns
 * a silent degradation into a command that either succeeds or prints why it did
 * not. Run it BEFORE (or with) the deploy that ships the public catalog.
 *
 * Idempotent: `createIndex` on an index that already exists with the same spec
 * is a no-op, so re-running is free. It never drops anything.
 *
 * ⚠️ MongoDB permits exactly ONE text index per collection. If `products` already
 * carries a text index under a different name or a different key set, this script
 * REPORTS it and refuses rather than dropping it — dropping somebody else's search
 * index is a migration decision, not a side effect of this one.
 *
 * Run:  npx ts-node scripts/migrate-storefront-indexes.ts [--dry-run]
 *       (npm run migrate:storefront-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/** The text index's name is pinned in the schema so it can be recognised here. */
const TEXT_INDEX_NAME = 'product_storefront_text';

interface PlannedIndex {
  name: string;
  key: Record<string, IndexDirection | 'text'>;
  options?: Record<string, unknown>;
  why: string;
}

const PLANNED: PlannedIndex[] = [
  {
    name: 'product_storefront_browse',
    key: { status: 1, deletedAt: 1, createdAt: -1 },
    why: 'browse grid, store product lists, sitemap feed',
  },
  {
    name: 'product_storefront_category',
    key: { status: 1, deletedAt: 1, category: 1 },
    why: 'category chips (GET /api/public/categories) and the category filter',
  },
  {
    name: TEXT_INDEX_NAME,
    key: { title: 'text', tags: 'text', description: 'text' },
    options: {
      default_language: 'none',
      weights: { title: 10, tags: 4, description: 1 },
    },
    why: 'public search + sort=relevance',
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => kb.includes(k) && a[k] === b[k]);
}

/** A text index is identified by having any `_fts` key, not by its field list. */
function isTextIndex(idx: { key: Record<string, unknown> }): boolean {
  return Object.prototype.hasOwnProperty.call(idx.key, '_fts');
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.PRODUCT);
  const existing = await collection.indexes();

  console.log(`\nIndexes on ${COLLECTIONS.PRODUCT}: ${existing.length}`);
  for (const idx of existing) {
    console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}`);
  }

  // ── The one-text-index-per-collection guard ────────────────────────────────
  const foreignText = existing.find((idx) => isTextIndex(idx as never) && idx.name !== TEXT_INDEX_NAME);
  if (foreignText) {
    console.error(
      `\n✋ REFUSING: this collection already carries a text index named "${foreignText.name}".` +
        '\n   MongoDB allows only one per collection, and dropping an existing search index is a' +
        '\n   decision this migration will not make for you. Inspect it, then either drop it by hand' +
        `\n   or remove the text index from ProductSchema. Its key: ${JSON.stringify(foreignText.key)}`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const missing = PLANNED.filter(
    (planned) =>
      !existing.some(
        (idx) =>
          idx.name === planned.name ||
          (!isTextIndex(idx as never) && sameKey(idx.key as Record<string, unknown>, planned.key)),
      ),
  );

  if (missing.length === 0) {
    console.log('\nNothing to do — every storefront index is already present.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${missing.length} index(es) to build:`);
  for (const planned of missing) {
    console.log(`  ${planned.name}  ${JSON.stringify(planned.key)}   — ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was built. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of missing) {
    process.stdout.write(`  building ${planned.name} … `);
    await collection.createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log('done');
  }

  console.log(
    '\nDone. Run `npm run verify:storefront` afterwards to confirm they actually built' +
      '\nand that the public aggregations run against them.'
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
