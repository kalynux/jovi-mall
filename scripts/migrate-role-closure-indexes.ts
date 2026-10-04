/**
 * Migration: build the `role_closure_requests` indexes (modules/role-closure, ADR-A10).
 *
 * An INDEX migration and nothing else — the collection is new.
 *
 * ── Why it cannot be left to autoIndex ──────────────────────────────────────
 * `autoIndex` is OFF in production (`lifecycle.ts`). One of the two is CORRECTNESS:
 *
 *   ⚠ `role_closure_one_pending_per_role` — PARTIAL unique on `(user_id, role)` where
 *   `status: 'pending'`. The service pre-checks, and a pre-check is a race: two
 *   administrators asking at the same instant would both see none, and the user would then
 *   hold two live requests for one irreversible act.
 *
 * Mirrors the declarations in `role-closure-request.model.ts` BY NAME, so the
 * declared-vs-live diff reads "no drift".
 *
 * Idempotent: `createIndex` on an existing index with the same spec is a no-op.
 *
 * Run:  npx ts-node scripts/migrate-role-closure-indexes.ts [--dry-run]
 *       (npm run migrate:role-closure-indexes)
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
    collection: COLLECTIONS.ROLE_CLOSURE_REQUEST,
    name: 'role_closure_one_pending_per_role',
    key: { user_id: 1, role: 1 },
    options: { unique: true, partialFilterExpression: { status: 'pending' } },
    why: 'one pending closure request per (user, role) — the guarantee behind the pre-check',
  },
  {
    collection: COLLECTIONS.ROLE_CLOSURE_REQUEST,
    name: 'user_id_1_created_at_-1',
    key: { user_id: 1, created_at: -1 },
    why: "an account's closure history (admin list, the user's pending lookup)",
  },
];

/** Two pending rows for one (user, role) — the unique build fails outright against them. */
async function findDuplicatePending(): Promise<Array<{ _id: unknown; count: number }>> {
  return mongoose.connection
    .collection(COLLECTIONS.ROLE_CLOSURE_REQUEST)
    .aggregate<{ _id: unknown; count: number }>([
      { $match: { status: 'pending' } },
      { $group: { _id: { user: '$user_id', role: '$role' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const duplicates = await findDuplicatePending();
  if (duplicates.length > 0) {
    console.error(`\n${duplicates.length} (user, role) pair(s) with more than one PENDING request — the unique build WILL fail:`);
    for (const d of duplicates) console.error(`  ${JSON.stringify(d._id)}  ×${d.count}`);
    console.error('\nCancel all but one per (user, role), then re-run.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nPlanned indexes: ${PLANNED.length}`);
  for (const planned of PLANNED) {
    console.log(`  ${planned.collection}.${planned.name}  ${JSON.stringify(planned.key)}`);
    console.log(`    ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — re-run without --dry-run to build them.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of PLANNED) {
    await mongoose.connection
      .collection(planned.collection)
      .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log(`  built ${planned.collection}.${planned.name}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
