/**
 * Migration: build the indexes on `agency_stock_movements` and `agency_storage_invoices`.
 *
 * Both collections are new (Phase 6 Step 14), so there is no data to move — this is an
 * INDEX migration and nothing else, which is the only kind Phase 6 D-5 admits pre-production.
 * It creates and never drops.
 *
 * ── Why an empty collection still needs this script ─────────────────────────
 * `autoIndex` is **off in production** (`lifecycle.ts`), so nothing builds a declared index
 * there. In development it is on, and a failed build fails *silently* — the promise rejects
 * into a listener nobody attached and the process comes up healthy. Either way the index is
 * simply absent, and for two of these that is a correctness problem rather than a slow one:
 *
 *   ⚠ `stock_movement_idempotency` is the ONLY thing that stops an order-path projection
 *   being applied twice. `AgencyStockMovementRepository.apply` pre-reads the key, and a
 *   pre-read is a race: a retried payment webhook arriving twice in the same instant reads
 *   "unspent" on both and sells the same units off the shelf twice. Every system movement
 *   carries a key derived from the reservation id, so without this index the depot count
 *   drifts downward on exactly the paths that are retried by design.
 *
 *   ⚠ `storage_invoice_identity` is what makes the monthly generator idempotent. Its upsert
 *   filters on `(agency, vendor, period_key)`; without uniqueness, two instances running the
 *   sweep at 02:00 — or one restarting mid-run — issue two statements for the same month,
 *   and the agency then has two numbers to tell the same vendor.
 *
 * ── UNIQUENESS AND PRE-EXISTING DATA ────────────────────────────────────────
 * Both unique builds fail outright against a collection that already holds duplicates.
 * Against empty collections that cannot happen, which is why this runs safely today — and it
 * is registered LAST in `scripts/migrate.ts` beside the other index builds for the ordinary
 * reason: if either collection ever does hold data, the data migrations reach their final
 * shape first.
 *
 * Idempotent: `createIndex` on an index that already exists with the same spec is a no-op.
 *
 * Run:  npx ts-node scripts/migrate-inventory-indexes.ts [--dry-run]
 *       (npm run migrate:inventory-indexes)
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

/**
 * Mirrors the declarations in `inventory/models/agency-stock-movement.model.ts` and
 * `inventory/models/agency-storage-invoice.model.ts`. The two must agree, and
 * `GET /api/internal/admin/system/database` reports it as drift if they stop doing so.
 */
const PLANNED: PlannedIndex[] = [
  {
    collection: COLLECTIONS.AGENCY_STOCK_MOVEMENT,
    name: 'stock_movement_idempotency',
    key: { idempotency_key: 1 },
    // PARTIAL rather than sparse: Mongo indexes null as a value, so a plain unique index
    // would let the first agency movement (which carries null) block every later one.
    options: { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } },
    why: 'THE no-double-projection rule. Without it a retried webhook sells the same shelf twice',
  },
  {
    collection: COLLECTIONS.AGENCY_STOCK_MOVEMENT,
    name: 'stock_movement_by_row',
    key: { stock_level_id: 1, createdAt: -1 },
    why: "one shelf's ledger, newest first — the movements screen and the drift sum",
  },
  {
    collection: COLLECTIONS.AGENCY_STOCK_MOVEMENT,
    name: 'stock_movement_by_agency',
    key: { agency_id: 1, createdAt: -1 },
    why: "an agency's whole movement history",
  },
  {
    collection: COLLECTIONS.AGENCY_STOCK_MOVEMENT,
    name: 'stock_movement_by_variant',
    key: { variant_id: 1, createdAt: -1 },
    why: 'the order path\'s lookup: "this variant just sold — which shelf moved?"',
  },
  {
    collection: COLLECTIONS.AGENCY_STORAGE_INVOICE,
    name: 'storage_invoice_identity',
    key: { agency_id: 1, vendor_id: 1, period_key: 1 },
    options: { unique: true, partialFilterExpression: { deletedAt: null } },
    why: 'one statement per (agency, vendor, month) — what makes the monthly run idempotent',
  },
  {
    collection: COLLECTIONS.AGENCY_STORAGE_INVOICE,
    name: 'storage_invoice_agency_list',
    key: { agency_id: 1, status: 1, period_key: -1 },
    why: "the agency's statement list",
  },
  {
    collection: COLLECTIONS.AGENCY_STORAGE_INVOICE,
    name: 'storage_invoice_vendor_list',
    key: { vendor_id: 1, status: 1, period_key: -1 },
    why: "the vendor's view of the same statements",
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  // Key ORDER is part of a compound index's identity — a prefix rule depends on it — so this
  // compares positionally rather than as a set.
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const missing: PlannedIndex[] = [];

  for (const collectionName of [COLLECTIONS.AGENCY_STOCK_MOVEMENT, COLLECTIONS.AGENCY_STORAGE_INVOICE]) {
    const collection = mongoose.connection.collection(collectionName);
    // `indexes()` throws on a collection that does not exist yet, which is the normal state on
    // a first run. An absent collection has no indexes, so treat it as such and let
    // `createIndex` create the collection with the first build.
    let existing: Array<{ name?: string; key: Record<string, unknown> }> = [];
    try {
      existing = (await collection.indexes()) as never;
    } catch {
      console.log(`\n${collectionName}: does not exist yet — it will be created by the first index build`);
    }

    if (existing.length > 0) {
      console.log(`\nIndexes on ${collectionName}: ${existing.length}`);
      for (const idx of existing) console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}`);
    }

    for (const planned of PLANNED.filter((p) => p.collection === collectionName)) {
      const present = existing.some(
        (idx) => idx.name === planned.name || sameKey(idx.key as Record<string, unknown>, planned.key),
      );
      if (!present) missing.push(planned);
    }
  }

  if (missing.length === 0) {
    console.log('\nNothing to do — every inventory index is already present.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${missing.length} index(es) to build:`);
  for (const planned of missing) {
    const unique = planned.options?.unique ? '  UNIQUE' : '';
    console.log(`  ${planned.collection}.${planned.name}${unique}  ${JSON.stringify(planned.key)}   — ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was built. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of missing) {
    process.stdout.write(`  building ${planned.collection}.${planned.name} … `);
    await mongoose.connection
      .collection(planned.collection)
      .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log('done');
  }

  console.log('\nDone. `npm run test:agency-inventory` covers the rules these indexes enforce.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
