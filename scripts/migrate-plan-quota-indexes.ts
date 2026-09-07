/**
 * Migration: build the indexes the plan-quota sweep walks.
 *
 * Plan limits used to bind only at creation time, so a downgrade changed nothing. The
 * plan-quota module (`src/modules/plan-quota/`) recomputes what fits inside the owner's
 * current plan — OLDEST FIRST — and suspends products / blocks files past the allowance.
 *
 * ── Why these three, and why `createdAt` is not just a sort ──────────────────
 * The order is the RULE, not a presentation choice: the allowance is filled from the
 * oldest end, and everything after the cut-off is held back. So the sweep walks these
 * indexes in order, and without them each pass is a collection scan of the owner's whole
 * catalog and media library — on `files` that is tens of thousands of documents for a
 * 100 GB plan, on a sweep that visits every owner whose plan has drifted.
 *
 *   products  { vendorId, deletedAt, createdAt }        the catalog-slot ordering
 *   files     { ownerType, ownerId, deletedAt, createdAt }  the storage ordering
 *   plan_quota_states  { owner_type, owner_id } UNIQUE  one row per owner
 *
 * The third is correctness rather than speed. That row records which plan an owner's
 * current suspensions were computed for, and it is what the drift sweep compares against;
 * two rows would let two passes each believe they had enforced the current plan while
 * disagreeing about which one it is.
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 * `autoIndex` is OFF in production (`lifecycle.ts`), so nothing builds these on boot
 * there — an unbuilt index is silently ABSENT, and the only symptom is a nightly sweep
 * that gets slower as the catalog grows. In development `autoIndex` builds them, which is
 * exactly why the gap goes unnoticed until deployment.
 *
 * Idempotent: `createIndex` with the same spec is a no-op, so re-running is free. It
 * never drops anything. No data is read or written — this migration touches no document,
 * which is what keeps it inside the pre-production "index migrations only" rule (D-5):
 * `Product.suspension` and `File.quotaBlockedAt` both default to null, so every existing
 * row is already correct and the first sweep establishes the rest.
 *
 * Run:  npx ts-node scripts/migrate-plan-quota-indexes.ts [--dry-run]
 *       (npm run migrate:plan-quota-indexes)
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
    collection: COLLECTIONS.PRODUCT,
    name: 'product_quota_slot_order',
    key: { vendorId: 1, deletedAt: 1, createdAt: 1 },
    why: 'the catalog-slot ordering the sweep suspends and restores along',
  },
  {
    collection: COLLECTIONS.FILE,
    name: 'file_quota_owner_order',
    key: { ownerType: 1, ownerId: 1, deletedAt: 1, createdAt: 1 },
    why: 'the storage ordering the allowance is filled in',
  },
  {
    collection: COLLECTIONS.PLAN_QUOTA_STATE,
    name: 'plan_quota_state_owner',
    key: { owner_type: 1, owner_id: 1 },
    options: { unique: true },
    why: 'one enforcement stamp per owner — two would let two sweeps disagree',
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  // Key ORDER is the index's identity for a compound index, so compare positionally.
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const missing: PlannedIndex[] = [];

  for (const planned of PLANNED) {
    const collection = mongoose.connection.collection(planned.collection);
    // A collection that does not exist yet THROWS rather than reporting no indexes, which
    // is the normal state for `plan_quota_states` on a database that has never run the
    // sweep — so an empty list is the right reading of that failure, not an error.
    let existing: Array<{ name?: string; key: Record<string, unknown> }>;
    try {
      existing = (await collection.indexes()) as never;
    } catch {
      existing = [];
    }

    console.log(`\nIndexes on ${planned.collection}: ${existing.length}`);
    for (const idx of existing) console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}`);

    const present = existing.some(
      (idx) => idx.name === planned.name || sameKey(idx.key as Record<string, unknown>, planned.key),
    );
    if (!present) missing.push(planned);
  }

  if (missing.length === 0) {
    console.log('\nNothing to do — every plan-quota index is already present.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${missing.length} index(es) to build:`);
  for (const planned of missing) {
    console.log(`  ${planned.collection}.${planned.name}  ${JSON.stringify(planned.key)}   — ${planned.why}`);
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

  console.log('\nDone. Run `npm run verify:plan-quota` to confirm the sweep works against them.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
