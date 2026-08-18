/**
 * audit:stuck-payments — how much money is sitting in a payment that never closed.
 *
 * READ-ONLY. Writes nothing, changes nothing, and is safe against production.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Until Phase 1, both mobile-money webhook routes answered 200 in every branch
 * — including their catch. To a gateway, 200 means "handled, stop retrying", so
 * every confirmation dropped by a restart, a database blip or a bug was
 * acknowledged as delivered and never sent again. Nothing swept
 * `payment_transaction`, so those rows are still sitting at PENDING with the
 * customer's money gone.
 *
 * `PaymentReconciliationWorker` stops that happening again and heals anything
 * inside its 72-hour window. This script measures what happened BEFORE it — the
 * backlog, which is otherwise assumed rather than known.
 *
 * It deliberately does not fix anything. Re-verifying a two-month-old
 * transaction against a gateway is a decision with real consequences (it can
 * fire fulfilment and an earnings split on an order the customer has long since
 * been refunded for by hand), and that decision belongs to a person holding
 * this report.
 *
 * Run: npm run audit:stuck-payments [-- --days=90] [-- --json]
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

import { PaymentTransactionModel } from '../src/modules/payments/models/payment-transaction.model';
import { PlanPurchaseModel } from '../src/modules/billing/models/plan-purchase.model';
import { CreditTopupModel } from '../src/modules/billing/models/credit-topup.model';

interface Bucket {
  label: string;
  count: number;
  value: number;
  currency: string;
  oldest: Date | null;
}

function parseDays(): number {
  const arg = process.argv.find((a) => a.startsWith('--days='));
  const value = arg ? Number(arg.split('=')[1]) : 90;
  return Number.isFinite(value) && value > 0 ? value : 90;
}

const asJson = process.argv.includes('--json');

async function main(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const days = parseDays();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Anything newer than this is the reconciliation worker's job, not a backlog.
  const settlingWindow = new Date(Date.now() - 60 * 60 * 1000);

  const stuck = await PaymentTransactionModel.find({
    status: { $in: ['INITIATED', 'PENDING'] },
    createdAt: { $gte: since, $lt: settlingWindow },
  })
    .select('gateway status amountSnapshot currencySnapshot createdAt orderId cartId bookingId gatewayRef merchantRef')
    .sort({ createdAt: 1 })
    .lean();

  const buckets = new Map<string, Bucket>();
  for (const row of stuck) {
    const key = `${row.gateway}:${row.status}`;
    const bucket = buckets.get(key) ?? {
      label: key,
      count: 0,
      value: 0,
      currency: row.currencySnapshot,
      oldest: null,
    };
    bucket.count += 1;
    bucket.value += row.amountSnapshot ?? 0;
    if (!bucket.oldest || row.createdAt < bucket.oldest) bucket.oldest = row.createdAt;
    buckets.set(key, bucket);
  }

  // A transaction with no `gatewayRef` was never successfully opened at the
  // provider, so nobody was charged — a different problem from one that was
  // opened and never confirmed, and lumping them together overstates the loss.
  const neverOpened = stuck.filter((r) => !r.gatewayRef).length;
  const openedNeverConfirmed = stuck.length - neverOpened;

  const pendingPurchases = await PlanPurchaseModel.countDocuments({
    status: 'pending',
    created_at: { $gte: since, $lt: settlingWindow },
  });
  const pendingTopups = await CreditTopupModel.countDocuments({
    status: 'pending',
    created_at: { $gte: since, $lt: settlingWindow },
  });

  const report = {
    windowDays: days,
    generatedAt: new Date().toISOString(),
    transactions: {
      total: stuck.length,
      neverOpenedAtGateway: neverOpened,
      openedNeverConfirmed,
      buckets: [...buckets.values()],
    },
    billing: { pendingPlanPurchases: pendingPurchases, pendingCreditTopups: pendingTopups },
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n  Stuck payments — last ${days} days (excluding the past hour)\n`);
    console.log(`  Transactions still INITIATED/PENDING : ${stuck.length}`);
    console.log(`    ├─ never opened at the gateway     : ${neverOpened}  (nobody was charged)`);
    console.log(`    └─ opened, never confirmed         : ${openedNeverConfirmed}  ← the money at risk\n`);
    for (const bucket of [...buckets.values()].sort((a, b) => b.value - a.value)) {
      console.log(
        `    ${bucket.label.padEnd(22)} ${String(bucket.count).padStart(5)} rows  ` +
          `${String(bucket.value).padStart(12)} ${bucket.currency}  oldest ${bucket.oldest?.toISOString().slice(0, 10) ?? '—'}`
      );
    }
    console.log(`\n  Pending plan purchases : ${pendingPurchases}`);
    console.log(`  Pending credit top-ups : ${pendingTopups}`);
    console.log(
      '\n  These are counts, not a remedy. Re-verifying an old transaction can fire' +
        '\n  fulfilment and an earnings split on an order that was settled by hand months' +
        '\n  ago, so the decision belongs to whoever is reading this.\n'
    );
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('[audit:stuck-payments] failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
