/**
 * Migration: let a referral reward come from a provider's payment — swap the one-reward-per-
 * commission index for a partial one, and build the one-reward-per-payment index beside it
 * (LISTING-REVIEWS-SAVES-REFERRALS-PLAN § 3.3, owner RS-3, 2026-11-08).
 *
 * ── Why the old index has to go ─────────────────────────────────────────────
 * `{ commission_allocation_id, relationship_id }` UNIQUE covered every reward. A provider reward
 * has no commission (`commission_allocation_id: null`), and a plain unique index indexes that
 * null — so a referred provider's SECOND plan or credit pack would collide with their first, the
 * evaluation transaction would abort, and the payment would be retried and refused every night:
 *
 *   referral_reward_one_per_commission  { commission_allocation_id, relationship_id }  UNIQUE,
 *                                       partial: commission_allocation_id is an ObjectId
 *   referral_reward_one_per_payment     { source_type, source_id, relationship_id }     UNIQUE,
 *                                       partial: source_type in (plan_purchase, credit_topup)
 *
 * The old index carries Mongoose's default name (`commission_allocation_id_1_relationship_id_1`,
 * built by `migrate:declared-indexes` or by `autoIndex`). This drops whichever NON-partial unique
 * index sits on that key, by inspection.
 *
 * ── Build first, drop second ─────────────────────────────────────────────────
 * Uniqueness never lapses: between the two, both hold and the old one is the stricter. If the
 * server refuses a second index on the same key (code 85/86), the old one is dropped first and the
 * new one built straight after. Every reward that exists has a commission, so the new partial
 * index covers exactly the rows the old one did, and its build cannot fail on duplicates the old
 * one allowed.
 *
 * No data is written. Runs among the data migrations, before `migrate:declared-indexes`, which
 * then finds every key present and builds nothing for them.
 *
 * Idempotent: a second run finds both new indexes and no old one, and writes nothing.
 *
 * Run:  npx ts-node scripts/migrate-referral-billing-rewards.ts [--dry-run]
 *       (npm run migrate:referral-billing-rewards)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const COMMISSION_INDEX = 'referral_reward_one_per_commission';
const PAYMENT_INDEX = 'referral_reward_one_per_payment';

interface LiveIndex {
  name?: string;
  key: Record<string, unknown>;
  partialFilterExpression?: unknown;
}

const isCommissionKey = (key: Record<string, unknown>): boolean => {
  const k = Object.keys(key);
  return k.length === 2 && k[0] === 'commission_allocation_id' && k[1] === 'relationship_id'
    && key.commission_allocation_id === 1 && key.relationship_id === 1;
};

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const rewards = mongoose.connection.collection(COLLECTIONS.REFERRAL_REWARD);
  let existing: LiveIndex[] = [];
  try {
    existing = (await rewards.indexes()) as never;
  } catch {
    console.log(`\n${COLLECTIONS.REFERRAL_REWARD}: does not exist yet — the new indexes will create it`);
  }

  const hasCommission = existing.some((i) => i.name === COMMISSION_INDEX);
  const hasPayment = existing.some((i) => i.name === PAYMENT_INDEX);
  const old = existing.filter((i) => i.name !== COMMISSION_INDEX && isCommissionKey(i.key) && !i.partialFilterExpression);
  const withoutCommission = await rewards.countDocuments({ commission_allocation_id: null }).catch(() => 0);

  console.log(`\nIndex ${COMMISSION_INDEX}: ${hasCommission ? 'present' : 'MISSING — will build'}`);
  console.log(`Index ${PAYMENT_INDEX}: ${hasPayment ? 'present' : 'MISSING — will build'}`);
  console.log(
    old.length
      ? `Old non-partial commission index: ${old.map((i) => i.name).join(', ')} — will drop after the new one is built`
      : 'Old non-partial commission index: absent',
  );
  console.log(`Rewards without a commission already present: ${withoutCommission}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  const commissionSpec = { commission_allocation_id: 1, relationship_id: 1 } as const;
  const commissionOptions = {
    name: COMMISSION_INDEX,
    unique: true,
    partialFilterExpression: { commission_allocation_id: { $type: 'objectId' } },
  };

  if (!hasCommission) {
    process.stdout.write(`\n  building ${COMMISSION_INDEX} … `);
    try {
      await rewards.createIndex(commissionSpec, commissionOptions);
      console.log('done');
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 85 && code !== 86) throw error;
      console.log(`refused (code ${code}: one index per key) — dropping the old one first`);
      for (const o of old) {
        process.stdout.write(`  dropping ${o.name} … `);
        await rewards.dropIndex(o.name as string);
        console.log('done');
      }
      old.length = 0;
      process.stdout.write(`  building ${COMMISSION_INDEX} … `);
      await rewards.createIndex(commissionSpec, commissionOptions);
      console.log('done');
    }
  }
  for (const o of old) {
    process.stdout.write(`  dropping ${o.name} … `);
    await rewards.dropIndex(o.name as string);
    console.log('done');
  }
  if (!hasPayment) {
    process.stdout.write(`  building ${PAYMENT_INDEX} … `);
    await rewards.createIndex(
      { source_type: 1, source_id: 1, relationship_id: 1 },
      { name: PAYMENT_INDEX, unique: true, partialFilterExpression: { source_type: { $in: ['plan_purchase', 'credit_topup'] } } },
    );
    console.log('done');
  }

  console.log('\nDone. A referred provider can now earn their partner a reward on every payment.');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('\nMigration failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
