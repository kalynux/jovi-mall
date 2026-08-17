/**
 * Migration: backfill AgentDeposit.status / .recipient / .resolved_at
 *
 * `AgentDeposit` grew a two-step lifecycle (declared → confirmed | rejected)
 * and a `recipient` ('agency' | 'platform'). Every row written before that was
 * an agency recording cash it had already physically taken — so all of them are
 * `status: 'confirmed'`, `recipient: 'agency'`.
 *
 * ── Why the schema defaults are not enough ──────────────────────────────────
 *
 * Mongoose applies a default when a document is HYDRATED, not to what is stored.
 * A legacy row has no `status` field in Mongo at all, so it reads back as
 * 'confirmed' (right) but is invisible to any query filtering on
 * `status: 'confirmed'` (wrong) — and it would show up in a `$ne: 'declared'`
 * scan while missing from the positive one. The agency's deposit list, the
 * admin queue and `sumOpenDeclarationsForAgent` all filter on status, so
 * without this backfill an agency's own history quietly loses its past.
 *
 * `resolved_at` is set to `created_at`: a single-step record was resolved the
 * moment it was written, and leaving it null would misreport those deposits as
 * still open in any resolved-at reporting.
 *
 * Idempotent: only touches rows that are actually missing the fields, so a
 * partial run can simply be repeated.
 *
 * Run:  npx ts-node scripts/migrate-agent-deposits.ts [--dry-run]
 *       (npm run migrate:agent-deposits)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const collection = mongoose.connection.collection(COLLECTIONS.AGENT_DEPOSIT);

  // Deliberately keyed on the fields being absent rather than on a status value:
  // that is exactly the population the schema default cannot reach.
  const filter = { $or: [{ status: { $exists: false } }, { recipient: { $exists: false } }] };
  const total = await collection.countDocuments(filter);
  console.log(`\nLegacy deposits needing a backfill: ${total}`);

  if (total === 0) {
    await mongoose.disconnect();
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    const sample = await collection.find(filter).limit(5).toArray();
    console.log('\nSample of what would be written:');
    for (const doc of sample) {
      console.log(
        `  ${doc._id.toString()}  amount=${doc.amount} ${doc.currency}  ` +
          `→ status='confirmed', recipient='agency', resolved_at=${(doc.created_at as Date)?.toISOString() ?? 'null'}`
      );
    }
    await mongoose.disconnect();
    console.log(`\nDRY RUN — ${total} document(s) would be updated. Re-run without --dry-run to apply.`);
    return;
  }

  // Two passes rather than one: `resolved_at` copies a per-document value, which
  // a plain $set cannot express. The status/recipient pass is the one that
  // matters for query correctness, so it goes first and stands alone.
  const statusResult = await collection.updateMany(filter, {
    $set: { status: 'confirmed', recipient: 'agency' },
  });

  const resolvedResult = await collection.updateMany(
    { resolved_at: { $exists: false }, status: 'confirmed' },
    [{ $set: { resolved_at: '$created_at' } }]
  );

  console.log('\n── Summary ─────────────────────────────');
  console.log(`  status/recipient backfilled:  ${statusResult.modifiedCount}`);
  console.log(`  resolved_at backfilled:       ${resolvedResult.modifiedCount}`);

  const remaining = await collection.countDocuments(filter);
  if (remaining > 0) {
    console.error(`\n  ⚠ ${remaining} document(s) still missing fields — re-run.`);
  }

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect();
  process.exit(1);
});
