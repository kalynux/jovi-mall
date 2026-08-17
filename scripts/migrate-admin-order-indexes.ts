/**
 * Migration: drop the order indexes that Phase 10's compounds made redundant.
 *
 * `orders` carried two single-field indexes:
 *   { payment_status: 1 }
 *   { fulfillment_status: 1 }
 *
 * wi-admin's platform-wide order list needs both fields as a FILTER combined with a
 * `created_at` SORT, so `order.model.ts` now declares:
 *   { payment_status: 1, created_at: -1 }
 *   { fulfillment_status: 1, created_at: -1 }
 *
 * A compound index serves every query its leading prefix served, so the two single-field
 * indexes are now strictly redundant — Mongo will simply never choose them.
 *
 * ── Why this script has to exist ────────────────────────────────────────────
 *
 * `autoIndex` is on, so Mongoose CREATES the new compounds at boot — but it never DROPS
 * anything. Removing `index: true` from a field definition therefore has no effect on a
 * database that has already run: the old index stays, forever, costing write throughput on
 * one of the platform's busiest collections and nothing else. Same lesson as
 * `migrate-cod-late-deposit-index.ts`.
 *
 * ── How this one differs from that one ──────────────────────────────────────
 *
 * That migration was CORRECTNESS-critical: leaving the stale index in place kept enforcing
 * a uniqueness rule that silently suppressed the behaviour the change existed to add.
 * This one is not. A redundant index costs write throughput, never a wrong answer, so this
 * is safe to defer and safe to skip. Run it with the deploy anyway — nobody comes back for
 * a cleanup that was never urgent.
 *
 * Idempotent: a missing old index is not an error, it is the goal.
 *
 * Run:  npx ts-node scripts/migrate-admin-order-indexes.ts [--dry-run]
 *       (npm run migrate:admin-order-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * The key shapes superseded by the new compounds.
 *
 * Matched by KEY SHAPE, not by name: the name is auto-generated and a hand-built index
 * could carry any name at all.
 */
const REDUNDANT_INDEX_KEYS: Record<string, unknown>[] = [
  { payment_status: 1 },
  { fulfillment_status: 1 },
];

function sameKey(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => kb[i] === k && a[k] === b[k]);
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.ORDER);
  const indexes = await collection.indexes();

  const stale = indexes.filter((idx) =>
    REDUNDANT_INDEX_KEYS.some((key) => sameKey(idx.key as Record<string, unknown>, key))
  );

  console.log(`\nIndexes on ${COLLECTIONS.ORDER}: ${indexes.length}`);
  for (const idx of indexes) {
    const mark = stale.includes(idx) ? '  ← TO DROP (superseded by a compound)' : '';
    console.log(`  ${idx.name}  ${JSON.stringify(idx.key)}${mark}`);
  }

  if (stale.length === 0) {
    console.log('\nNothing to do — the superseded single-field indexes are already gone.');
    await mongoose.disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(
      `\nDRY RUN — would drop ${stale.length} index(es): ${stale.map((i) => i.name).join(', ')}.` +
        '\nRe-run without --dry-run to apply.'
    );
    await mongoose.disconnect();
    return;
  }

  for (const idx of stale) {
    await collection.dropIndex(idx.name!);
    console.log(`  dropped ${idx.name}`);
  }

  console.log(
    '\nDone. The replacement compounds are created automatically at boot by autoIndex.' +
      '\nA failed index build is SILENT under autoIndex, so confirm they exist:' +
      `\n  db.${COLLECTIONS.ORDER}.getIndexes()`
  );
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('\nMigration failed:', error);
  process.exit(1);
});
