/**
 * Migration: build the partial unique index on `bookings.bookingNumber`.
 *
 * A booking gained a human-readable handle (`BKG-2026-000123`,
 * `booking/utils/booking-number.generator.ts`). This is an INDEX migration and
 * nothing else — the only kind D-5 admits pre-production, and there is no
 * backfill here by that same decision: legacy bookings keep `bookingNumber: null`
 * and every reader handles it.
 *
 * ── Why an index this collection can live without still needs a script ──────
 *
 * `autoIndex` is **off in production** (`lifecycle.ts`), so nothing builds a
 * declared index there. In development it is on, and a failed build fails
 * *silently* — the promise rejects into a listener nobody attached and the
 * process comes up healthy. Either way the index is simply absent, and here that
 * is a correctness problem rather than a slow one:
 *
 *   ⚠ Uniqueness of the handle is enforced by this index and by nothing else.
 *   `BookingNumberGenerator` draws from an atomic `$inc` counter, which makes a
 *   collision impossible while the counter is the only source — but the counter
 *   is a document like any other. Restore a database without it, or point two
 *   environments at one collection, and the sequence restarts at 1 and re-issues
 *   numbers a customer is already holding. There is no pre-check on this path
 *   (deliberately: the counter is the guarantee, the index is the proof), so
 *   without the index a duplicate is written silently and two bookings answer to
 *   one number.
 *
 * ── PARTIAL, and why it has to be ──────────────────────────────────────────
 *
 * `partialFilterExpression: { bookingNumber: { $type: 'string' } }`. A plain
 * unique index treats every missing value as the same `null`, so it would refuse
 * to build against any database holding more than one legacy booking — which is
 * every existing one. The partial filter indexes only the rows that have a
 * handle, which is exactly the set uniqueness is meant over.
 *
 * Idempotent: `createIndex` on an index that already exists with the same spec is
 * a no-op.
 *
 * Run:  npx ts-node scripts/migrate-booking-number-index.ts [--dry-run]
 *       (npm run migrate:booking-number-index)
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

/**
 * Mirrors the declaration in `booking/models/booking.model.ts`. The two must
 * agree, and `GET /api/internal/admin/system/database` reports it as drift if
 * they stop doing so.
 */
const PLANNED: PlannedIndex[] = [
  {
    collection: COLLECTIONS.BOOKING,
    name: 'booking_number_unique',
    key: { bookingNumber: 1 },
    options: { unique: true, partialFilterExpression: { bookingNumber: { $type: 'string' } } },
    why: "the booking handle's uniqueness is enforced by this and nothing else",
  },
];

/**
 * Duplicate handles already in the collection. A unique build fails outright
 * against them, and the error Mongo returns names one offending value rather
 * than the set — so this reports the whole set first and refuses to try.
 *
 * Expected to be empty: the field is new, so every existing row is null and null
 * rows are not indexed. It runs anyway because "expected to be empty" is exactly
 * the assumption a restored database breaks.
 */
async function findDuplicates(): Promise<Array<{ _id: string; count: number }>> {
  return mongoose.connection
    .collection(COLLECTIONS.BOOKING)
    .aggregate<{ _id: string; count: number }>([
      { $match: { bookingNumber: { $type: 'string' } } },
      { $group: { _id: '$bookingNumber', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ])
    .toArray();
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const duplicates = await findDuplicates();
  if (duplicates.length > 0) {
    console.error(`\n${duplicates.length} duplicate booking number(s) — the unique build WILL fail:`);
    for (const d of duplicates) console.error(`  ${d._id}  ×${d.count}`);
    console.error(
      '\nThis should be impossible: the numbers come from an atomic counter.' +
        '\nIt means the counter document (sequence_counters, _id "booking:<year>") was' +
        '\nlost or reset while the bookings it numbered survived. Fix the DATA before' +
        '\nthe index — re-issuing numbers for the affected bookings, and setting the' +
        '\ncounter above the highest one in use.'
    );
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
    // `createIndex` creates the collection if it does not exist yet, which is
    // correct here — an empty `bookings` still wants its constraint.
    await mongoose.connection
      .collection(planned.collection)
      .createIndex(planned.key as never, { name: planned.name, ...(planned.options ?? {}) });
    console.log(`  built ${planned.collection}.${planned.name}`);
  }

  console.log('\nDone. Run `npm run verify:live-parity` afterwards to confirm it actually built.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
