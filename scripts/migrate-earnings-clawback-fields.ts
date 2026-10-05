/**
 * Migration: the refund-clawback fields (REFUND-FLOW-PLAN § 6, § 10).
 *
 *   earnings_accounts.clawback_balance   → 0 where missing (what an owner owes back)
 *   earnings_allocations.clawed_amount   → 0 where missing (how much of a share refunds took)
 *
 * Both are read with a `?? 0` fallback everywhere, so the platform is correct before this
 * runs; what it fixes is the database's own consistency — the release worker's and the
 * clawback's compare-and-set filters match a missing field as `null`, and wi-admin reads these
 * collections directly and would otherwise see `undefined`.
 *
 * ⚠ It does NOT set `clawed_amount = amount` on rows already `reversed` by the pre-clawback
 * refund path. Those rows are read as "nothing left" by status, and vendor analytics counts
 * them as legacy reversals precisely BECAUSE their `clawed_amount` is 0 (a row the clawback
 * reversed has `clawed_amount === amount` and is counted from `earnings_adjustments` instead).
 * Backfilling them would make those reversals vanish from the analytics.
 *
 * The `earnings_adjustments` collection and its unique `(refund_key, allocation_id, kind)`
 * index are built by `migrate:declared-indexes`, which runs after this.
 *
 * Idempotent: only documents missing the field are touched; a second run changes nothing.
 * `--dry-run` prints the counts and writes NOTHING.
 *
 * Run:  npx ts-node scripts/migrate-earnings-clawback-fields.ts [--dry-run]
 *       (npm run migrate:earnings-clawback-fields)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const STEPS: Array<{ collection: string; field: string }> = [
  { collection: COLLECTIONS.EARNINGS_ACCOUNT, field: 'clawback_balance' },
  { collection: COLLECTIONS.EARNINGS_ALLOCATION, field: 'clawed_amount' },
];

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  for (const step of STEPS) {
    const collection = mongoose.connection.collection(step.collection);
    const filter = { [step.field]: { $exists: false } };
    const missing = await collection.countDocuments(filter);
    console.log(`\n${step.collection}.${step.field}: ${missing} document(s) missing the field`);
    if (DRY_RUN || missing === 0) continue;
    // Raw driver, deliberately: a migration should not go through the schema it is migrating to.
    const res = await collection.updateMany(filter, { $set: { [step.field]: 0 } });
    console.log(`  set to 0 on ${res.modifiedCount}`);
  }

  if (DRY_RUN) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('migrate:earnings-clawback-fields FAILED:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
