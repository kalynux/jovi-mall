/**
 * Migration: give every availability rule the timezone its hours were always meant
 * to mean.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * `AvailabilityRule.timezone` was `required: true, default: 'UTC'` and **never
 * read by anything**. Availability built each day's window with
 * `date.setHours(startHour)` — the *server's* local clock. So a vendor in Douala
 * whose rule said "Monday 09:00" got 9am wherever the server happened to be, and
 * moving the server silently moved every vendor's working day.
 *
 * The service now resolves wall-clock times in the rule's timezone, falling back
 * to `Vendor.timezone` (required, defaults `Africa/Douala`) when the rule has
 * none. This script brings existing rows onto that model.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *
 * Rules carrying the meaningless `'UTC'` default are **cleared to unset**, so they
 * inherit their vendor's timezone — the intended steady state, and the reason the
 * field is now optional rather than defaulted.
 *
 * A rule whose timezone is anything else was deliberately chosen and is left
 * alone (it becomes a genuine per-rule override).
 *
 * ── Read the shift report before running without --dry-run ──────────────────
 *
 * The report names every rule whose effective hours MOVE, and by how much. The
 * shift is the gap between the server's current zone (what the hours resolved to
 * before) and the vendor's zone (what they resolve to now):
 *
 *   - Server already runs the vendor's zone  → 0 rules shift, behaviour identical.
 *   - Server runs UTC, vendor in Douala      → hours move +1h. That is the FIX:
 *     the vendor's "09:00" now means 9am in Douala, as they always intended.
 *
 * Idempotent: a second run finds no `'UTC'` rows left and reports 0 updated.
 *
 * Run:  npx ts-node scripts/migrate-booking-rule-timezones.ts [--dry-run]
 *       (npm run migrate:booking-rule-timezones)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { COLLECTIONS } from '../src/core/database/collections';
import { BOOKING_CONFIG } from '../src/modules/booking/config/booking.config';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

/** Minutes east of UTC for `timezone` at `at`. */
function utcOffsetMinutes(timezone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);

    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second')
    );
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected to ${MONGO_URI}${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);

  const rules = mongoose.connection.collection(COLLECTIONS.AVAILABILITY_RULE);
  const vendors = mongoose.connection.collection(COLLECTIONS.VENDOR);

  const docs = await rules
    .find({}, { projection: { vendorId: 1, timezone: 1, dayOfWeek: 1, startTime: 1, endTime: 1 } })
    .toArray();

  console.log(`\nAvailability rules found: ${docs.length}`);
  if (docs.length === 0) {
    await mongoose.disconnect();
    console.log('Nothing to do.');
    return;
  }

  // Resolve each vendor's timezone once.
  const vendorIds = [...new Set(docs.map((d) => String(d.vendorId)))];
  const vendorDocs = await vendors
    .find(
      { _id: { $in: vendorIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { projection: { timezone: 1 } }
    )
    .toArray();

  const vendorTimezone = new Map<string, string>();
  for (const vendor of vendorDocs) {
    vendorTimezone.set(String(vendor._id), (vendor.timezone as string) || BOOKING_CONFIG.defaultTimezone);
  }

  const now = new Date();
  const serverTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const serverOffset = utcOffsetMinutes(serverTimezone, now) ?? 0;

  console.log(`Server timezone: ${serverTimezone} (UTC${serverOffset >= 0 ? '+' : ''}${serverOffset / 60}h)`);
  console.log(`Fallback when a vendor has none: ${BOOKING_CONFIG.defaultTimezone}\n`);

  const toClear: mongoose.Types.ObjectId[] = [];
  const shifts: string[] = [];
  const kept: string[] = [];
  const orphaned: string[] = [];

  for (const doc of docs) {
    const ruleTz = doc.timezone as string | undefined | null;
    const vendorId = String(doc.vendorId);

    // Anything other than the meaningless 'UTC' default was chosen on purpose, and
    // needs nothing from the vendor. Checked FIRST so such a rule is never reported
    // as unresolvable merely because its vendor row is missing.
    if (ruleTz && ruleTz !== 'UTC') {
      kept.push(`  rule ${doc._id} keeps its explicit '${ruleTz}'`);
      continue;
    }

    const effectiveTz = vendorTimezone.get(vendorId);
    if (!effectiveTz) {
      orphaned.push(`  rule ${doc._id} → vendor ${vendorId} not found`);
      continue;
    }

    if (ruleTz === 'UTC') toClear.push(doc._id as mongoose.Types.ObjectId);

    const vendorOffset = utcOffsetMinutes(effectiveTz, now);
    if (vendorOffset === null) {
      orphaned.push(`  rule ${doc._id} → vendor timezone '${effectiveTz}' is not a valid IANA zone`);
      continue;
    }

    const shiftMinutes = vendorOffset - serverOffset;
    if (shiftMinutes !== 0) {
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][doc.dayOfWeek as number] ?? '?';
      shifts.push(
        `  rule ${doc._id}  ${day} ${doc.startTime}-${doc.endTime}  ` +
          `→ ${effectiveTz}  (moves ${shiftMinutes > 0 ? '+' : ''}${shiftMinutes} min)`
      );
    }
  }

  console.log(`Rules to clear to "inherit vendor timezone": ${toClear.length}`);
  if (kept.length) {
    console.log(`\nRules with an explicit timezone (left untouched): ${kept.length}`);
    kept.slice(0, 20).forEach((line) => console.log(line));
    if (kept.length > 20) console.log(`  … and ${kept.length - 20} more`);
  }

  console.log(`\n── EFFECTIVE HOURS THAT MOVE: ${shifts.length} ──`);
  if (shifts.length === 0) {
    console.log('  None. The server already runs each vendor\'s timezone; behaviour is identical.');
  } else {
    shifts.slice(0, 50).forEach((line) => console.log(line));
    if (shifts.length > 50) console.log(`  … and ${shifts.length - 50} more`);
    console.log(
      '\n  These vendors\' wall-clock hours now resolve in THEIR zone rather than the\n' +
        '  server\'s. This is the intended correction — verify a couple against what the\n' +
        '  vendor expects before running without --dry-run.'
    );
  }

  if (orphaned.length) {
    console.log(`\n⚠ Unresolvable rules: ${orphaned.length}`);
    orphaned.forEach((line) => console.log(line));
    console.log('  These keep their stored value and fall back at read time.');
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes written.');
    await mongoose.disconnect();
    return;
  }

  if (toClear.length > 0) {
    const result = await rules.updateMany(
      { _id: { $in: toClear } },
      { $unset: { timezone: '' } }
    );
    console.log(`\nCleared timezone on ${result.modifiedCount} rule(s).`);
  } else {
    console.log('\nNothing to write.');
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(async (error) => {
  console.error('Migration failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
