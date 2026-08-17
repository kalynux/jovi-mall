/**
 * Migration: billing plan/topup/purchase → owner-scoped (owner_type + owner_id)
 *
 * The billing engine was generalized from vendor-only to any owner type
 * (vendor/agency/agent). Three collections were still keyed on `vendor_id`:
 *   - `vendor_plans`   → renamed to `subscriber_plans`, vendor_id → owner_type/owner_id
 *   - `credit_topups`  → vendor_id → owner_type/owner_id
 *   - `plan_purchases` → vendor_id → owner_type/owner_id, vendor_plan_id → subscriber_plan_id
 *
 * Every existing row is a vendor's, so `owner_type` is set to 'vendor' and
 * `owner_id` copied from `vendor_id`. Stale indexes are dropped so Mongoose
 * rebuilds the new `{owner_type, owner_id}` ones at the next server boot.
 *
 * Idempotent: only rows still carrying `vendor_id` are touched; re-running after
 * a completed run is a no-op. Safe to run repeatedly.
 *
 * Run:  npx ts-node scripts/migrate-billing-owner-scope.ts [--dry-run]
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import type { Db } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

async function collectionExists(db: Db, name: string): Promise<boolean> {
  const found = await db.listCollections({ name }).toArray();
  return found.length > 0;
}

/** Count docs still on the old vendor_id shape (the migration's remaining work). */
async function countLegacy(db: Db, name: string): Promise<number> {
  if (!(await collectionExists(db, name))) return 0;
  return db.collection(name).countDocuments({ vendor_id: { $exists: true } });
}

async function renameVendorPlans(db: Db): Promise<void> {
  const hasOld = await collectionExists(db, 'vendor_plans');
  const hasNew = await collectionExists(db, 'subscriber_plans');
  if (!hasOld) {
    console.log('[migrate:billing] vendor_plans not present — nothing to rename');
    return;
  }
  if (hasNew) {
    // A booted server auto-creates an empty subscriber_plans (index build). If it
    // is empty it's safe to drop so the real data can be renamed in; otherwise a
    // human must reconcile two populated collections.
    const newCount = await db.collection('subscriber_plans').countDocuments();
    if (newCount > 0) {
      console.warn(`[migrate:billing] subscriber_plans already has ${newCount} doc(s) — leaving vendor_plans in place; resolve manually`);
      return;
    }
    if (DRY_RUN) {
      console.log('[migrate:billing] [dry-run] would drop empty subscriber_plans, then rename vendor_plans → subscriber_plans');
      return;
    }
    await db.collection('subscriber_plans').drop();
    console.log('[migrate:billing] Dropped empty auto-created subscriber_plans');
  } else if (DRY_RUN) {
    console.log('[migrate:billing] [dry-run] would rename vendor_plans → subscriber_plans');
    return;
  }
  await db.collection('vendor_plans').rename('subscriber_plans');
  console.log('[migrate:billing] Renamed vendor_plans → subscriber_plans');
}

/** vendor_id → owner_type/owner_id (+ optional field renames), then drop stale indexes. */
async function ownerScopeCollection(
  db: Db,
  name: string,
  extraSet: Record<string, string> = {},
  extraUnset: string[] = []
): Promise<void> {
  if (!(await collectionExists(db, name))) {
    console.log(`[migrate:billing] ${name} not present — skipped`);
    return;
  }
  const col = db.collection(name);
  const legacy = await col.countDocuments({ vendor_id: { $exists: true } });
  if (legacy === 0) {
    console.log(`[migrate:billing] ${name}: no legacy vendor_id rows — skipped`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[migrate:billing] [dry-run] ${name}: would drop stale indexes and owner-scope ${legacy} row(s)`);
    return;
  }

  // Drop stale indexes FIRST: the old `{vendor_id, status}` unique indexes would
  // otherwise fire as we unset vendor_id (many rows collide on vendor_id: null).
  // Mongoose rebuilds the {owner_type, owner_id} indexes at the next server boot.
  try {
    await col.dropIndexes();
    console.log(`[migrate:billing] ${name}: dropped stale indexes (rebuilt at next boot)`);
  } catch (err) {
    console.warn(`[migrate:billing] ${name}: dropIndexes skipped (${(err as Error).message})`);
  }

  const res = await col.updateMany({ vendor_id: { $exists: true } }, [
    { $set: { owner_type: 'vendor', owner_id: '$vendor_id', ...extraSet } },
    { $unset: ['vendor_id', ...extraUnset] },
  ]);
  console.log(`[migrate:billing] ${name}: owner-scoped ${res.modifiedCount} row(s)`);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect');
  console.log(`[migrate:billing] Connected to MongoDB${DRY_RUN ? ' (dry-run)' : ''}`);

  console.log(
    `[migrate:billing] Legacy rows — vendor_plans:${await countLegacy(db, 'vendor_plans')} ` +
      `credit_topups:${await countLegacy(db, 'credit_topups')} plan_purchases:${await countLegacy(db, 'plan_purchases')}`
  );

  await renameVendorPlans(db);
  await ownerScopeCollection(db, 'subscriber_plans');
  await ownerScopeCollection(db, 'credit_topups');
  await ownerScopeCollection(db, 'plan_purchases', { subscriber_plan_id: '$vendor_plan_id' }, ['vendor_plan_id']);

  await mongoose.disconnect();
  console.log('[migrate:billing] Done');
}

run().catch((err) => {
  console.error('[migrate:billing] Failed:', err);
  process.exit(1);
});
