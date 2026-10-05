/**
 * Migration: build the `refund_requests` indexes (REFUND-FLOW-PLAN § 3.1, § 10, § 11.1).
 *
 * An INDEX migration and nothing else — the collection is new (2026-10-05). Its rows are written
 * by `RefundRequestService` and, for the legacy queues, by `migrate:legacy-refunds-to-requests`,
 * which runs BEFORE this one (data first: a unique build fails against data not yet in shape).
 *
 * ── Why it cannot be left to autoIndex ──────────────────────────────────────
 * `autoIndex` is OFF in production (`lifecycle.ts`). One of these is CORRECTNESS:
 *
 *   ⚠ `refund_one_open_per_source` — PARTIAL unique on `(source_kind, source_id)` where the
 *   status is open (`awaiting_approval | approved | waiting_for_cash | sending | failed`). It is
 *   the ONLY thing stopping two refunds racing on one order: a vendor's refund and a delivery-fee
 *   refund opened in the same instant would both pass any pre-check and BOTH send money. Without
 *   it the customer can be paid twice for one order.
 *
 * The others are lookups the callback router, the reconciliation sweep, the COD release and the
 * refund queue read on every request — absent, each is a collection scan.
 *
 * Mirrors the declarations in `refund-request.model.ts` BY NAME (the named two by their names,
 * the rest by Mongoose's default `<field>_<dir>` names), so the declared-vs-live diff that
 * `migrate:declared-indexes` runs afterwards reads "no drift" and builds nothing twice.
 *
 * Idempotent: `createIndex` on an existing index with the same spec is a no-op. Refuses to build
 * the unique index while two OPEN requests share a source (it would fail outright), and lists them.
 *
 * Run:  npx ts-node scripts/migrate-refund-requests-indexes.ts [--dry-run]
 *       (npm run migrate:refund-requests-indexes)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { IndexDirection } from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { OPEN_REFUND_STATUSES } from '../src/modules/payments/domain/refund-status';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

interface PlannedIndex {
  name: string;
  key: Record<string, IndexDirection>;
  options?: Record<string, unknown>;
  why: string;
}

export const PLANNED: PlannedIndex[] = [
  {
    name: 'refund_one_open_per_source',
    key: { source_kind: 1, source_id: 1 },
    options: { unique: true, partialFilterExpression: { status: { $in: [...OPEN_REFUND_STATUSES] } } },
    why: 'ONE open refund per order/booking/purchase — the race guard two concurrent refunds collide on',
  },
  {
    name: 'refund_transfer_leg_reference',
    key: { 'transfer_legs.reference': 1 },
    why: 'a transfer callback / the reconciliation sweep finds its request by our jm_rf_ reference',
  },
  {
    name: 'status_1_created_at_-1',
    key: { status: 1, created_at: -1 },
    why: 'the refund queue: by status, newest first',
  },
  {
    name: 'status_1_updated_at_1',
    key: { status: 1, updated_at: 1 },
    why: 'the reconciliation sweep: `sending` requests older than the minimum age',
  },
  {
    name: 'cod_collection_ids_1_status_1',
    key: { cod_collection_ids: 1, status: 1 },
    why: 'the COD release: waiting_for_cash requests that needed a just-covered collection',
  },
  {
    name: 'source_id_1_created_at_-1',
    key: { source_id: 1, created_at: -1 },
    why: "one order's / booking's refund history",
  },
];

/** Two OPEN requests on one source — the unique build fails outright against them. */
async function findDuplicateOpen(): Promise<Array<{ _id: unknown; count: number }>> {
  return mongoose.connection
    .collection(COLLECTIONS.REFUND_REQUEST)
    .aggregate<{ _id: unknown; count: number }>([
      { $match: { status: { $in: [...OPEN_REFUND_STATUSES] } } },
      { $group: { _id: { kind: '$source_kind', id: '$source_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const duplicates = await findDuplicateOpen();
  if (duplicates.length > 0) {
    console.error(`\n${duplicates.length} source(s) with more than one OPEN refund request — the unique build WILL fail:`);
    for (const d of duplicates) console.error(`  ${JSON.stringify(d._id)}  ×${d.count}`);
    console.error('\nReject or settle all but one per source, then re-run.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nPlanned indexes on ${COLLECTIONS.REFUND_REQUEST}: ${PLANNED.length}`);
  for (const planned of PLANNED) {
    console.log(`  ${planned.name}  ${JSON.stringify(planned.key)}`);
    console.log(`    ${planned.why}`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — re-run without --dry-run to build them.');
    await mongoose.disconnect();
    return;
  }

  for (const planned of PLANNED) {
    await mongoose.connection
      .collection(COLLECTIONS.REFUND_REQUEST)
      .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log(`  built ${planned.name}`);
  }

  console.log('\nDone.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('migrate:refund-requests-indexes FAILED:', err);
    process.exit(1);
  });
}
