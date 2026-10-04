/**
 * Migration: build the `delivery_fee_proposals` indexes (modules/delivery-fee-proposals).
 *
 * An INDEX migration and nothing else — the collection is new, so there is no data to
 * backfill and the builds are instant on an empty collection.
 *
 * ── Why it cannot be left to autoIndex ──────────────────────────────────────
 * `autoIndex` is OFF in production (`lifecycle.ts`). One of these four is CORRECTNESS:
 *
 *   ⚠ `delivery_fee_proposal_one_pending_per_shipment` — PARTIAL unique on `shipment_id`
 *   where `status: 'pending'`. The service serialises proposals through a compare-and-set
 *   on the shipment's `pending_delivery_fee_proposal_id`, and this index is the second,
 *   independent guarantee: without it a bug in that pointer would let two pending fee
 *   changes stand on one shipment, and the vendor could approve both.
 *
 * The other three serve the shipment history, the vendor inbox and the order view.
 *
 * ADR-A11 (W-E) added two more collections of the same feature, with two more CORRECTNESS
 * indexes: `delivery_fee_refund_one_processing_per_order` (no delivery-fee refund paid twice) and
 * `combined_delivery_request_one_open_per_cart_agency`.
 *
 * Mirrors the declarations in `delivery-fee-proposal.model.ts` BY NAME, so the
 * declared-vs-live diff (`GET /api/internal/admin/system/database`) reads "no drift" and
 * `migrate:declared-indexes` (which runs after this) finds nothing missing here.
 *
 * Idempotent: `createIndex` on an existing index with the same spec is a no-op.
 *
 * Run:  npx ts-node scripts/migrate-delivery-fee-proposal-indexes.ts [--dry-run]
 *       (npm run migrate:delivery-fee-proposal-indexes)
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
    collection: COLLECTIONS.DELIVERY_FEE_PROPOSAL,
    name: 'delivery_fee_proposal_one_pending_per_shipment',
    key: { shipment_id: 1 },
    options: { unique: true, partialFilterExpression: { status: 'pending' } },
    why: 'one pending fee change per shipment — the guarantee behind the pointer CAS',
  },
  {
    collection: COLLECTIONS.DELIVERY_FEE_PROPOSAL,
    name: 'delivery_fee_proposal_by_shipment',
    key: { shipment_id: 1, created_at: -1 },
    why: "a shipment's proposal history and the two-proposal cap count",
  },
  {
    collection: COLLECTIONS.DELIVERY_FEE_PROPOSAL,
    name: 'delivery_fee_proposal_vendor_inbox',
    key: { vendor_id: 1, status: 1, created_at: -1 },
    why: "the vendor's pending-proposal inbox",
  },
  {
    collection: COLLECTIONS.DELIVERY_FEE_PROPOSAL,
    name: 'delivery_fee_proposal_by_order',
    key: { order_id: 1, created_at: -1 },
    why: 'the proposals on one order (vendor order detail)',
  },
  // ── ADR-A11 (W-E, 2026-10-04): customer-paid fee changes. Same feature family, same ledger
  // entry — this migration had not been deployed when they were added.
  {
    collection: COLLECTIONS.DELIVERY_FEE_REFUND,
    name: 'delivery_fee_refund_one_processing_per_order',
    key: { order_id: 1 },
    options: { unique: true, partialFilterExpression: { status: 'processing' } },
    why: 'ONE delivery-fee refund in flight per order — two triggers can never refund the same money twice',
  },
  {
    collection: COLLECTIONS.DELIVERY_FEE_REFUND,
    name: 'delivery_fee_refund_by_order',
    key: { order_id: 1, created_at: -1 },
    why: "an order's delivery-fee refund ledger (the outstanding amount, the customer's read)",
  },
  {
    collection: COLLECTIONS.COMBINED_DELIVERY_REQUEST,
    name: 'combined_delivery_request_one_open_per_cart_agency',
    key: { cart_id: 1, agency_id: 1 },
    options: { unique: true, partialFilterExpression: { status: 'open' } },
    why: 'one open combined-price request per (checkout, agency)',
  },
  {
    collection: COLLECTIONS.COMBINED_DELIVERY_REQUEST,
    name: 'combined_delivery_request_agency_inbox',
    key: { agency_id: 1, status: 1, created_at: -1 },
    why: "the agency's combined-request inbox",
  },
  {
    collection: COLLECTIONS.COMBINED_DELIVERY_REQUEST,
    name: 'combined_delivery_request_by_customer_cart',
    key: { customer_id: 1, cart_id: 1, created_at: -1 },
    why: "a customer's requests on one checkout",
  },
];

/** Two pending rows for one shipment — the unique build fails outright against them. */
async function findDuplicatePending(): Promise<Array<{ _id: unknown; count: number }>> {
  return mongoose.connection
    .collection(COLLECTIONS.DELIVERY_FEE_PROPOSAL)
    .aggregate<{ _id: unknown; count: number }>([
      { $match: { status: 'pending' } },
      { $group: { _id: '$shipment_id', count: { $sum: 1 } } },
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
    console.error(`\n${duplicates.length} shipment(s) with more than one PENDING proposal — the unique build WILL fail:`);
    for (const d of duplicates) console.error(`  shipment ${String(d._id)}  ×${d.count}`);
    console.error('\nWithdraw all but one per shipment, then re-run.');
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
