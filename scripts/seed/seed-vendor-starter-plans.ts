/**
 * Seed: activate the free Starter plan for specific vendors.
 *
 * For each vendor id below, this ensures they have an `active` Starter VendorPlan
 * and that the one-time 1,000-credit allowance has been credited to their wallet
 * (wallet + ledger entry). Idempotent — if a vendor already has an active plan it
 * is left untouched (no duplicate plan, no double-grant).
 *
 * NOTE: this script performs DIRECT writes (no multi-document transaction) so it
 * runs against a standalone mongod. The billing *runtime* services use
 * transactions and therefore require a replica set — see the README note.
 *
 * Prerequisite: the `starter` pricing plan must exist; this script upserts it if
 * missing (same defaults as `npm run seed:plans`).
 *
 * Run:
 *   npx ts-node scripts/seed/seed-vendor-starter-plans.ts
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';

import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { SubscriberPlanModel } from '../../src/modules/billing/models/subscriber-plan.model';
import { CreditWalletModel } from '../../src/modules/billing/models/credit-wallet.model';
import { CreditTransactionModel } from '../../src/modules/billing/models/credit-transaction.model';
import { freePlanCode } from '../../src/modules/billing/billing.types';

const FREE_PLAN_CODE = freePlanCode('vendor');

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

const VENDOR_IDS = [
  'b00000000000000000000001',
  '6a2e8a1e30eab2daff911986',
];

async function ensureStarterPlan() {
  await PricingPlanModel.updateOne(
    { role: 'vendor', code: FREE_PLAN_CODE, deletedAt: null },
    {
      $set: {
        role: 'vendor',
        code: FREE_PLAN_CODE,
        name: 'Starter',
        price: 0,
        currency: 'XAF',
        term_days: null,
        credit_allowance: 1000,
        max_active_products: 15,
        max_storage_bytes: 1024 * 1024 * 1024,
        commission_percent: 7,
        is_active: true,
        sort_order: 1,
        deletedAt: null,
      },
    },
    { upsert: true }
  );
  const plan = await PricingPlanModel.findOne({ role: 'vendor', code: FREE_PLAN_CODE, deletedAt: null });
  console.log(`[seed:vendor-starter] Ensured '${FREE_PLAN_CODE}' plan exists (${plan!._id})`);
  return plan!;
}

async function seedVendor(vendorId: string, planId: Types.ObjectId, allowance: number) {
  const vid = new Types.ObjectId(vendorId);

  const existing = await SubscriberPlanModel.findOne({ owner_type: 'vendor', owner_id: vid, status: 'active' });
  if (existing) {
    const wallet = await CreditWalletModel.findOne({ owner_type: 'vendor', owner_id: vid });
    console.log(
      `[seed:vendor-starter] vendor ${vendorId} already has active plan '${existing.plan_code}' ` +
        `(balance=${wallet?.balance ?? 0}) — skipped`
    );
    return;
  }

  // 1. Create the active Starter plan (never-expiring; allowance considered granted).
  await SubscriberPlanModel.create({
    owner_type: 'vendor',
    owner_id: vid,
    plan_id: planId,
    plan_code: FREE_PLAN_CODE,
    status: 'active',
    started_at: new Date(),
    expires_at: null,
    assigned_by: null,
    payment_reference: null,
    allowance_granted: true,
  });

  // 2. Ensure the wallet exists and credit the allowance.
  const wallet = await CreditWalletModel.findOneAndUpdate(
    { owner_type: 'vendor', owner_id: vid },
    { $setOnInsert: { owner_type: 'vendor', owner_id: vid, balance: 0, version: 0, currency_unit: 'credit' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const updated = await CreditWalletModel.findByIdAndUpdate(
    wallet!._id,
    { $inc: { balance: allowance, version: 1 } },
    { new: true }
  );

  // 3. Write the matching ledger entry.
  await CreditTransactionModel.create({
    wallet_id: wallet!._id,
    owner_type: 'vendor',
    owner_id: vid,
    type: 'allowance',
    amount: allowance,
    balance_after: updated!.balance,
    reason_code: 'plan_allowance',
    ref: planId.toString(),
  });

  console.log(
    `[seed:vendor-starter] vendor ${vendorId} -> active 'starter', granted ${allowance} credits ` +
      `(balance=${updated!.balance})`
  );
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('[seed:vendor-starter] Connected to MongoDB');

  const starter = await ensureStarterPlan();

  for (const vendorId of VENDOR_IDS) {
    await seedVendor(vendorId, starter._id, starter.credit_allowance);
  }

  await mongoose.disconnect();
  console.log('[seed:vendor-starter] Done');
}

run().catch((err) => {
  console.error('[seed:vendor-starter] Failed:', err);
  process.exit(1);
});
