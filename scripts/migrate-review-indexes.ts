/**
 * Migration: build the indexes on `reviews` and `review_aggregates`.
 *
 * Both collections are new (Phase 6 Step 10), so there is no data to move — this is
 * an INDEX migration and nothing else, which is the only kind Phase 6 D-5 admits
 * pre-production. It creates and never drops.
 *
 * ── Why an empty collection still needs this script ─────────────────────────
 * `autoIndex` is **off in production** (`lifecycle.ts`), so nothing builds a declared
 * index there. In development it is on, and a failed build fails *silently* — the
 * promise rejects into a listener nobody attached and the process comes up healthy.
 * Either way the index is simply absent, and for one of these that is not a
 * performance problem but a correctness one:
 *
 *   ⚠ `review_one_per_author_per_subject` is the ONLY thing that makes "one review
 *   per author per subject" true. `ReviewService.submit` pre-checks, and a pre-check
 *   is a race: two submissions in the same millisecond both read "none" and both
 *   insert. Without this index the service's `E11000` branch is unreachable and the
 *   duplicate is simply kept — inflating a product's rating and, for a delivery
 *   review, an agent's trust score.
 *
 *   `review_aggregate_identity` is the same argument one layer down: every aggregate
 *   write is an upsert on that triple, and without uniqueness a concurrent recompute
 *   can insert a second row for the same target. Readers take the first one they
 *   find, so the storefront and the trust collector could then disagree about the
 *   same agent, permanently and silently.
 *
 * ── UNIQUENESS AND PRE-EXISTING DATA ────────────────────────────────────────
 * Both unique builds fail outright against a collection that already holds
 * duplicates. Against empty collections that cannot happen, which is why this runs
 * safely today — but it is registered LAST in `scripts/migrate.ts` beside the other
 * index builds for the ordinary reason: if either collection ever does hold data, the
 * data migrations must reach their final shape first.
 *
 * Idempotent: `createIndex` on an index that already exists with the same spec is a
 * no-op, so re-running is free.
 *
 * Run:  npx ts-node scripts/migrate-review-indexes.ts [--dry-run]
 *       (npm run migrate:review-indexes)
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
 * Mirrors the declarations in `reviews/models/*.model.ts`. The two must agree, and
 * `GET /api/internal/admin/system/database` reports it as drift if they stop doing so.
 */
const PLANNED: PlannedIndex[] = [
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_one_per_author_per_subject',
    key: { subject_type: 1, subject_id: 1, author_user_id: 1 },
    options: { unique: true },
    why: 'THE one-review-per-author rule. Without it the service pre-check is a race and duplicates persist',
  },
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_by_subject',
    key: { subject_type: 1, subject_id: 1, status: 1, createdAt: -1 },
    why: "the storefront's published review list for one product",
  },
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_moderation_queue',
    key: { status: 1, createdAt: 1 },
    why: 'the moderation queue — ASCENDING, because a queue is worked oldest-first',
  },
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_by_author',
    key: { author_user_id: 1, createdAt: -1 },
    why: '"my reviews", for all three author roles',
  },
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_by_agent_target',
    key: { target_agent_id: 1, author_role: 1, status: 1 },
    why: "the agent aggregate recompute — the trust composite's three rating factors",
  },
  {
    collection: COLLECTIONS.REVIEW,
    name: 'review_by_agency_target',
    key: { target_agency_id: 1, author_role: 1, status: 1 },
    why: "the agency aggregate recompute — the directory's service rating",
  },
  {
    collection: COLLECTIONS.REVIEW_AGGREGATE,
    name: 'review_aggregate_identity',
    key: { target_type: 1, target_id: 1, author_role: 1 },
    options: { unique: true },
    why: 'the identity of an aggregate row, and what every upsert filters on',
  },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  // Key ORDER is part of a compound index's identity — a prefix rule depends on it —
  // so this compares positionally rather than as a set.
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const missing: PlannedIndex[] = [];

  for (const collectionName of [COLLECTIONS.REVIEW, COLLECTIONS.REVIEW_AGGREGATE]) {
    const collection = mongoose.connection.collection(collectionName);
    // `indexes()` throws on a collection that does not exist yet, which is the normal
    // state on a first run. An absent collection has no indexes, so treat it as such
    // and let `createIndex` create both together.
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
    console.log('\nNothing to do — every review index is already present.');
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

  console.log('\nDone. `npm run test:reviews` covers the rules these indexes enforce.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
