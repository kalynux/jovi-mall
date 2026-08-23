/**
 * Migration: build the indexes for a customer's own product lists (Phase 6 · 6.E.1 / 6.E.2).
 *
 * Two new collections, two indexes each:
 *
 *   wishlist_items         { customer_id, product_id }  UNIQUE   the deduplication
 *                          { customer_id, created_at: -1 }        the list read
 *   recently_viewed_items  { customer_id, product_id }  UNIQUE   the deduplication
 *                          { customer_id, viewed_at: -1 }         the list read + the eviction
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 *
 * **`autoIndex` is OFF in production.** So on the first deploy against a real database
 * nothing builds these at all — and the two UNIQUE ones are not an optimisation. They are
 * the *only* thing enforcing "one row per (customer, product)": both repositories upsert
 * against them precisely so that two concurrent taps cannot produce a duplicate, and
 * without the index the upsert's filter matches nothing on the second call and inserts a
 * second row. The list then shows the same product twice, every total is wrong, and the
 * recently-viewed cap evicts a *different* product than it should.
 *
 * That failure is invisible in development, where `autoIndex` is on and the index is built
 * for you — which is exactly the class of bug the migration ledger exists to prevent.
 *
 * The two sort indexes are ordinary performance: without them, reading one customer's list
 * scans the whole collection and sorts in memory.
 *
 * ⚠ **A unique build can FAIL against dirty data.** If duplicates already exist — they
 * cannot be produced by this code, but a hand-written insert or a restored dump could —
 * `createIndex` refuses and prints the offending pair. That is the correct outcome: the
 * duplicates are a data question, and silently dropping one of them is not this script's
 * decision to make.
 *
 * Idempotent: `createIndex` on an index that already exists with the same spec is a no-op,
 * so re-running is free. It never drops anything.
 *
 * Run:  npx ts-node scripts/migrate-customer-catalog-indexes.ts [--dry-run]
 *       (npm run migrate:customer-catalog-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

interface PlannedIndex {
  collection: string;
  name: string;
  key: Record<string, IndexDirection>;
  options?: Record<string, unknown>;
  why: string;
}

const PLANNED: PlannedIndex[] = [
  {
    collection: COLLECTIONS.WISHLIST_ITEM,
    name: 'wishlist_customer_product_unique',
    key: { customer_id: 1, product_id: 1 },
    options: { unique: true },
    why: 'THE deduplication — the upsert in WishlistRepository.add relies on it',
  },
  {
    collection: COLLECTIONS.WISHLIST_ITEM,
    name: 'wishlist_customer_recent',
    key: { customer_id: 1, created_at: -1 },
    why: 'the list read, newest save first',
  },
  {
    collection: COLLECTIONS.RECENTLY_VIEWED_ITEM,
    name: 'recently_viewed_customer_product_unique',
    key: { customer_id: 1, product_id: 1 },
    options: { unique: true },
    why: 'THE deduplication — re-viewing must move an entry, never add a second',
  },
  {
    collection: COLLECTIONS.RECENTLY_VIEWED_ITEM,
    name: 'recently_viewed_customer_recent',
    key: { customer_id: 1, viewed_at: -1 },
    why: 'the list read AND the cap eviction, which selects the overflow by this order',
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const missing: PlannedIndex[] = [];

  for (const collectionName of [...new Set(PLANNED.map((p) => p.collection))]) {
    const collection = mongoose.connection.collection(collectionName);

    // A collection that does not exist yet reports no indexes rather than throwing on
    // every driver version, so the listing is guarded: "not created yet" is the ordinary
    // state on a first deploy and is not an error.
    let existing: Array<{ name?: string; key: Record<string, unknown> }>;
    try {
      existing = (await collection.indexes()) as never;
    } catch {
      existing = [];
    }

    console.log(`\nIndexes on ${collectionName}: ${existing.length}`);
    for (const idx of existing) {
      console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}`);
    }

    for (const planned of PLANNED.filter((p) => p.collection === collectionName)) {
      const present = existing.some(
        (idx) => idx.name === planned.name || sameKey(idx.key, planned.key)
      );
      if (!present) missing.push(planned);
    }
  }

  if (missing.length === 0) {
    console.log('\nNothing to do — every customer-catalog index is already present.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${missing.length} index(es) to build:`);
  for (const planned of missing) {
    const unique = planned.options?.unique ? '  UNIQUE' : '';
    console.log(`  ${planned.collection}.${planned.name}  ${JSON.stringify(planned.key)}${unique}   — ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was built. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of missing) {
    process.stdout.write(`  building ${planned.collection}.${planned.name} … `);
    try {
      await mongoose.connection
        .collection(planned.collection)
        .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
      console.log('done');
    } catch (err) {
      console.log('FAILED');
      console.error(
        `\n✋ ${planned.collection}.${planned.name} could not be built: ${(err as Error).message}` +
          '\n   If this is a duplicate-key error, the collection already holds two rows for one' +
          '\n   (customer, product) pair. Nothing in this codebase can produce that, so inspect the' +
          '\n   data before removing anything — deciding which duplicate to keep is not this' +
          '\n   migration\'s call.'
      );
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

/**
 * ⚠ Guarded, like every other migration here.
 *
 * `test:system` imports the migration registry, which resolves every script path. Without
 * this guard a DB-free unit test would connect to Mongo and apply the migration — see the
 * note on `scripts/migrate.ts`'s own `main()`.
 */
if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
