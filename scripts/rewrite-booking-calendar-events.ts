#!/usr/bin/env ts-node

/**
 * One-off: rewrite the Google Calendar events of UPCOMING bookings so vendors see what the
 * current description says — the customer's note, the readable title, the place.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * Until 2026-10-26 only an instantly-confirmed single booking carried the customer's note
 * (`metadata.notes`) in its event. A manually-confirmed booking, a rescheduled one, every
 * capacity class ("1/10 seats filled", nobody named) and every payment-status change (which
 * rewrote the event as "Booking - Product 6f3a…") dropped it. New writes are fixed
 * (`utils/calendar-description.util.ts`); this brings the events ALREADY in vendors' calendars
 * in line, once.
 *
 * ── What it touches ──────────────────────────────────────────────────────────
 * Bookings that are `pending` or `confirmed`, start in the future, are not deleted, and have an
 * event (`externalCalendarEventId`). Past appointments are left alone.
 *  - single-seat booking → rewritten exactly as a payment-status change now writes it
 *    (`BookingCalendarSyncService.syncBookingPaymentStatus`): title, description with the note,
 *    colour, place;
 *  - capacity class → its SHARED event re-rendered once per class, listing every seat with its
 *    booking number and note (`GroupBookingService.rerenderSlotEvent`).
 *
 * It writes to vendors' real Google Calendars, so it previews by default:
 *
 *   npm run calendar:rewrite-booking-events             # preview: what WOULD be rewritten
 *   npm run calendar:rewrite-booking-events -- --apply  # write
 *
 * Idempotent: an event is replaced with the same content on a re-run. Best-effort per booking —
 * a vendor whose Google connection is gone is counted and skipped; the run goes on.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Booking } from '../src/modules/booking/models/booking.model';
import { BookingStatus } from '../src/modules/booking/types/booking.types';
import { BookingCalendarSyncService } from '../src/modules/booking/services/booking-calendar-sync.service';
import { GroupBookingService } from '../src/modules/booking/services/group-booking.service';
import { ProductModel } from '../src/modules/catalog/models';

dotenv.config();

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
  // A one-off must never build indexes as a side effect of connecting.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);

  console.log(`[CalendarRewrite] Connecting…${APPLY ? '' : ' (PREVIEW — nothing is written; pass --apply to write)'}`);
  await mongoose.connect(MONGO_URI);

  const sync = new BookingCalendarSyncService();
  const groups = new GroupBookingService();
  let singles = 0;
  let classes = 0;
  let failed = 0;
  const seenClasses = new Set<string>();
  const capacityOf = new Map<string, number | null>();
  const titleOf = new Map<string, string>();

  try {
    const bookings = await Booking.find({
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      startAt: { $gt: new Date() },
      deletedAt: null,
      externalCalendarEventId: { $exists: true, $nin: [null, ''] },
    }).sort({ startAt: 1 });

    console.log(`[CalendarRewrite] ${bookings.length} upcoming booking(s) with a calendar event.`);

    for (const booking of bookings) {
      const productId = booking.productId.toString();
      try {
        if (!capacityOf.has(productId)) {
          const group = await groups.resolveCapacity(productId).catch(() => null);
          capacityOf.set(productId, group?.maxBookings ?? null);
        }
        const maxBookings = capacityOf.get(productId) ?? null;

        if (maxBookings === null) {
          singles += 1;
          if (APPLY) await sync.syncBookingPaymentStatus(booking);
          continue;
        }

        // One rewrite per class, however many seats it has.
        const classKey = `${productId}:${booking.startAt.getTime()}:${booking.endAt.getTime()}`;
        if (seenClasses.has(classKey)) continue;
        seenClasses.add(classKey);
        classes += 1;
        if (!APPLY) continue;

        if (!titleOf.has(productId)) {
          const product = await ProductModel.findById(productId).select('title').lean();
          titleOf.set(productId, (product as { title?: string } | null)?.title ?? 'Booking');
        }
        await groups.rerenderSlotEvent(booking, maxBookings, titleOf.get(productId)!);
      } catch (error) {
        failed += 1;
        console.error(`[CalendarRewrite] Booking ${booking._id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const verb = APPLY ? 'Rewrote' : 'Would rewrite';
    console.log(`[CalendarRewrite] ${verb} ${singles} single-booking event(s) and ${classes} class event(s).`);
    if (failed) console.log(`[CalendarRewrite] ${failed} failed — re-run to retry them.`);
    console.log('[CalendarRewrite] ⚠ A vendor with no Google connection is logged by the sync and skipped; their bookings have no event to fix.');
  } finally {
    await mongoose.disconnect();
    console.log('[CalendarRewrite] Done. Disconnected.');
  }
}

main().catch((error) => {
  console.error('[CalendarRewrite] Crashed:', error);
  process.exitCode = 1;
});
