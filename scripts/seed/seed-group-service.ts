/**
 * Seed: ONE group ("capacity") service and a class part-full of people — the fixture
 * KI-1's fix could not be exercised without.
 *
 * ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
 * KI-1 (`api-doc/n8n/MCP-PARITY-PLAN.md` § "Known problems") ends with: *"One-line
 * change, but it needs a test with a group-service booking, which the dev database does
 * not currently have."* That was accurate, and measurably so — on 2026-09-06 this
 * database held **two** `bookingMode: 'capacity'` variants and **zero** bookings of any
 * kind, and both of those variants were ORPHANS whose `products` row no longer existed.
 * So there was nothing to reschedule, and nothing to reschedule it into.
 *
 * A group service is one where several customers share the same window: a class, a tour,
 * a workshop. Three things about it differ from an ordinary booking, and each is a place
 * the single-occupancy path is wrong — the owner-scoped checkout hold (which is what KI-1
 * got wrong), the seat COUNT instead of a free/busy verdict, and the calendar event
 * SHARED by every seat. None of those can be exercised by a fixture with one seat in it,
 * which is why this seeds a class with people already in it rather than an empty product.
 *
 * ── WHAT IT CREATES ──────────────────────────────────────────────────────────
 * Everything under fixed `9c00…` ids, so a re-run replaces rather than duplicates and
 * `--clean` can find all of it:
 *
 *   • ONE service product — "Sunrise Yoga (Group Class)" — `active`, on an existing
 *     vendor, with a single default variant in `bookingMode: 'capacity'`, 4 seats,
 *     60 minutes.
 *   • Availability on ALL SEVEN weekdays, 07:00–09:00 in the vendor's own timezone,
 *     which is exactly two back-to-back slots a day. Two slots a day rather than a long
 *     window on purpose: the interesting move is between two adjacent classes, and a
 *     twelve-hour window buries it in noise.
 *   • FOUR classes across the next two days, seeded to the four states a reschedule can
 *     land in:
 *
 *       A · tomorrow 07:00  1 of 4   the class the mover is sitting in
 *       B · tomorrow 08:00  3 of 4   ONE SEAT FREE — the move that must now succeed
 *       C · day after 07:00 4 of 4   FULL — the move that must be refused, 409
 *       D · day after 08:00 0 of 4   empty — the trivially-free target
 *
 * ⚠ **IT REUSES THE WORLD, IT DOES NOT REBUILD IT.** No vendor and no customer is
 * created here. Both are resolved at runtime — an active vendor, and active users
 * holding the `customer` role — the same rule `seed-customer-account.ts` follows, and
 * for the same reason: a hardcoded id here is broken by any sibling seed re-run with
 * `--clean`, and the breakage then looks like a bug in this script. If the world is not
 * there, this says so plainly instead of failing later inside a write.
 *
 * ⚠ **The seats are filled by CYCLING over whatever customers exist**, so one person may
 * hold two seats in one class if the database has few of them. Nothing enforces one
 * booking per person per slot, and for a capacity fixture the seat COUNT is the subject —
 * but do not read the attendee list as realistic.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * No Redis hold is taken, and none should be. A hold lives fifteen minutes and the
 * reschedule path asserts it; minting one here would go stale long before anyone ran the
 * request, and a fixture that mints credentials is the shape `seed-customer-account.ts`
 * warns about. Take the hold as the customer does, through
 * `POST /api/products/:productId/slots/:slotId/lock` — which is also the only way to
 * prove the fix, since the whole defect was that the reschedule read a DIFFERENT KEY from
 * the one that endpoint writes.
 *
 * No calendar event is written either: these vendors have no Google Calendar connected,
 * and the group path treats that as a normal, survivable state.
 *
 * PREREQUISITES
 *   • MongoDB running (no replica set needed — this writes no transaction)
 *   • at least one `active` vendor and one `active` user holding the `customer` role
 *
 * Run:
 *   npm run seed:group-service            # wipe + reseed
 *   npm run seed:group-service:clean      # wipe only
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';

import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { UserModel } from '../../src/modules/users/user.model';
import { AvailabilityRule } from '../../src/modules/booking/models/availability-rule.model';
import { Booking } from '../../src/modules/booking/models/booking.model';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import { SlotGeneratorService } from '../../src/modules/booking/services/slot-generator.service';
import { zonedWallClockToInstant, zonedDayOf } from '../../src/modules/booking/utils/availability-timezone.util';

dotenv.config();

/** Fixed ids — the cleanup handle, and what makes a re-run a replace. */
const PRODUCT_ID = new Types.ObjectId('9c00000000000000000000a1');
const VARIANT_ID = new Types.ObjectId('9c00000000000000000000a2');
/** Every booking this script writes carries it, so `--clean` needs no id list. */
const SEED_TAG = 'seed:group-service';

const MAX_BOOKINGS = 4;
const DURATION_MINUTES = 60;
const OPEN_AT = '07:00';
const CLOSE_AT = '09:00';
const PRICE = 3000;

const log = (msg = ''): void => console.log(msg);

/** The four classes this fixture seeds, and how many seats each starts with. */
const CLASS_PLAN: { label: string; dayOffset: number; hour: number; seats: number; note: string }[] = [
  { label: 'A', dayOffset: 1, hour: 7, seats: 1, note: 'the class the mover is sitting in' },
  { label: 'B', dayOffset: 1, hour: 8, seats: 3, note: 'ONE SEAT FREE — the move that must succeed' },
  { label: 'C', dayOffset: 2, hour: 7, seats: 4, note: 'FULL — the move that must be refused (409)' },
  { label: 'D', dayOffset: 2, hour: 8, seats: 0, note: 'empty — the trivially-free target' },
];

async function cleanup(): Promise<void> {
  const bookings = await Booking.deleteMany({ 'metadata.seed': SEED_TAG });
  const rules = await AvailabilityRule.deleteMany({ productId: PRODUCT_ID });
  const variants = await ProductVariantModel.deleteMany({ productId: PRODUCT_ID });
  const products = await ProductModel.deleteMany({ _id: PRODUCT_ID });

  log(
    `🧹 Removed ${bookings.deletedCount} booking(s), ${rules.deletedCount} availability rule(s), ` +
      `${variants.deletedCount} variant(s), ${products.deletedCount} product(s).`
  );
}

/**
 * An active vendor to hang the class on.
 *
 * Resolved rather than hardcoded, and `!== 'inactive'` rather than `=== 'active'` — the
 * same form `ProductStatusValidationService` and `requireAuth` use, because
 * `pending_verification` is the registration default and the positive form would skip
 * every vendor who never verified their email.
 */
async function resolveVendor(): Promise<{ id: Types.ObjectId; timezone: string }> {
  const vendor = await VendorModel.findOne({ status: { $ne: 'inactive' }, deletedAt: null })
    .select('_id timezone')
    .sort({ createdAt: 1 })
    .lean();

  if (!vendor) {
    throw new Error(
      'No usable vendor found. This script reuses the world rather than rebuilding it — ' +
        'seed a vendor first (scripts/seed/seed-orders.js or seed:cod-shipments).'
    );
  }

  return { id: vendor._id as Types.ObjectId, timezone: vendor.timezone || 'Africa/Douala' };
}

/** Active users holding the `customer` role — the people who take the seats. */
async function resolveAttendees(needed: number): Promise<Types.ObjectId[]> {
  const users = await UserModel.find({ roles: 'customer', status: 'active', deletedAt: null })
    .select('_id')
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();

  if (users.length === 0) {
    throw new Error(
      'No active customer accounts found. Seed one first (npm run seed:customer), or run ' +
        'this script against a database that has one.'
    );
  }

  // Cycle. Nothing enforces one booking per person per slot, and the seat COUNT is what
  // this fixture is about — but the attendee list is not realistic when users are few.
  return Array.from({ length: needed }, (_, i) => users[i % users.length]._id as Types.ObjectId);
}

async function seed(): Promise<void> {
  const vendor = await resolveVendor();
  log(`🏪 Vendor ${vendor.id.toString()} (timezone ${vendor.timezone})`);

  // ── The product ────────────────────────────────────────────────────────────
  // `mode: 'advanced'` because simple mode is physical-only, and `category` because the
  // schema requires it — a service product created without one fails validation.
  await ProductModel.create({
    _id: PRODUCT_ID,
    vendorId: vendor.id,
    type: 'service',
    status: 'active',
    mode: 'advanced',
    title: 'Sunrise Yoga (Group Class)',
    description:
      `A ${DURATION_MINUTES}-minute morning yoga class for up to ${MAX_BOOKINGS} people. ` +
      'Seeded fixture for group-service booking and rescheduling (KI-1).',
    slug: 'sunrise-yoga-group-class',
    category: 'wellness',
    tags: ['yoga', 'class', 'group', 'seed'],
    seo: {
      title: 'Sunrise Yoga — group class',
      description: 'Book a seat in the morning group yoga class.',
    },
    hasVariants: true,
    defaultVariantId: VARIANT_ID,
  });

  await ProductVariantModel.create({
    _id: VARIANT_ID,
    productId: PRODUCT_ID,
    sku: 'SEED-GROUP-YOGA-01',
    name: 'Class seat',
    status: 'active',
    optionSignature: 'default',
    price: PRICE,
    stock: 0,
    isInfiniteStock: false,
    optionValueIds: [],
    serviceConfig: {
      durationMinutes: DURATION_MINUTES,
      // Zero buffers deliberately: a buffer eats the neighbouring slot, and the whole
      // point of a two-slot day here is that the two slots both exist.
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      bookingMode: 'capacity',
      maxBookings: MAX_BOOKINGS,
    },
  });

  log(`📦 Product ${PRODUCT_ID.toString()} — capacity mode, ${MAX_BOOKINGS} seats, ${DURATION_MINUTES} min`);

  // ── Availability: every weekday, so a slot exists whenever this is run ─────
  await AvailabilityRule.insertMany(
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      productId: PRODUCT_ID,
      vendorId: vendor.id,
      dayOfWeek,
      startTime: OPEN_AT,
      endTime: CLOSE_AT,
      // No timezone: absent means "inherit the vendor's", which is the real steady state
      // and what `migrate:booking-rule-timezones` exists to restore.
      isActive: true,
    }))
  );
  log(`🗓️  Availability ${OPEN_AT}–${CLOSE_AT}, all seven days, in the vendor's timezone`);

  // ── The four classes ──────────────────────────────────────────────────────
  const slotGenerator = new SlotGeneratorService();
  const totalSeats = CLASS_PLAN.reduce((sum, c) => sum + c.seats, 0);
  const attendees = await resolveAttendees(totalSeats);
  let attendeeCursor = 0;

  const printable: { label: string; slotId: string; when: string; seats: string; note: string }[] = [];
  let moverBookingId = '';

  for (const plan of CLASS_PLAN) {
    const day = new Date();
    day.setDate(day.getDate() + plan.dayOffset);

    // Resolve the wall-clock hour in the VENDOR's zone, the same way availability does.
    // `setHours` here would resolve against this machine's clock, which is the exact
    // defect `availability-timezone.util.ts` was extracted to end.
    const zonedDay = zonedDayOf(day, vendor.timezone);
    const start = zonedWallClockToInstant(zonedDay, plan.hour * 60, vendor.timezone);
    const end = zonedWallClockToInstant(zonedDay, (plan.hour + 1) * 60, vendor.timezone);

    // Take the id from the generator rather than formatting it here — the hash suffix is
    // its business, and a hand-built id parses but addresses a slot nothing offers.
    const slotId = slotGenerator.generateSlots([{ start, end }], DURATION_MINUTES)[0].id;

    for (let seat = 0; seat < plan.seats; seat++) {
      const booking = await Booking.create({
        productId: PRODUCT_ID,
        userId: attendees[attendeeCursor++],
        vendorId: vendor.id,
        startAt: start,
        endAt: end,
        status: BookingStatus.CONFIRMED,
        priceSnapshot: PRICE,
        currency: 'XAF',
        requiresPayment: true,
        metadata: { seed: SEED_TAG, class: plan.label },
      });

      if (plan.label === 'A' && seat === 0) moverBookingId = booking._id.toString();
    }

    printable.push({
      label: plan.label,
      slotId,
      when: start.toISOString(),
      seats: `${plan.seats}/${MAX_BOOKINGS}`,
      note: plan.note,
    });
  }

  log(`🎟️  ${totalSeats} seat(s) booked across ${CLASS_PLAN.length} classes\n`);

  // ── What to do with it ────────────────────────────────────────────────────
  log('─'.repeat(78));
  log('  CLASSES');
  log('─'.repeat(78));
  for (const row of printable) {
    log(`  ${row.label} · ${row.seats}  ${row.when}`);
    log(`      ${row.note}`);
    log(`      slotId: ${row.slotId}`);
  }

  log('');
  log('─'.repeat(78));
  log('  REPRODUCING KI-1');
  log('─'.repeat(78));
  log(`  productId : ${PRODUCT_ID.toString()}`);
  log(`  bookingId : ${moverBookingId}   (the seat in class A)`);
  log('');
  log('  Sign in as that booking\'s customer, then — the hold FIRST, because the whole');
  log('  defect was that the reschedule read a different Redis key from the one this');
  log('  endpoint writes:');
  log('');
  log(`    POST  /api/products/${PRODUCT_ID.toString()}/slots/<slotId of B>/lock`);
  log(`    PATCH /api/customer/bookings/${moverBookingId}/reschedule`);
  log('          { "newSlotId": "<slotId of B>" }');
  log('');
  log('  Before the fix this answered 409 BOOKING_SLOT_NOT_LOCKED whatever you did.');
  log('  It should now move into B (3/4 → 4/4). Repeat against C to get the honest');
  log('  refusal — 409 BOOKING_SLOT_FULL — and against D for an empty target.');
  log('');
}

async function main(): Promise<void> {
  const cleanOnly = process.argv.includes('--clean');
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';

  await mongoose.connect(uri);
  log(`🔌 Connected to ${uri}\n`);

  try {
    await cleanup();
    if (cleanOnly) {
      log('\n✨ Clean complete (--clean). Nothing seeded.');
      return;
    }
    log('');
    await seed();
    log('✨ Done.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error('\n❌ Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
