/**
 * Migration: the two LEGACY refund queues → `refund_requests` (REFUND-FLOW-PLAN § 10).
 *
 * Before 2026-10-05 a refund the gateway could not make waited for a person in one of two
 * places, neither of which the new refund queue (wi-admin, `/api/internal/admin/refunds`) reads:
 *
 *   1. `delivery_fee_refunds` rows in `manual_required` — delivery-fee money owed back (a fee
 *      DECREASE, an unspent customer-paid return fee) that no mobile gateway could refund.
 *   2. `bookings` in `paymentStatus: 'refund_pending'` — a paid booking cancelled with no
 *      automatic refund, waiting on a HIGH ticket.
 *
 * Each becomes ONE refund request AWAITING APPROVAL, raised as `system`, through the SAME
 * `RefundRequestService.create` every live path uses (so the money ceiling, the fee, the
 * destination and the pause are decided exactly as they would be today — nothing is
 * re-derived here). Nothing is SENT: these were waiting for a person, and they still are —
 * approving one in the queue sends it to the number that paid, or asks for a typed one.
 *
 *  - Delivery rows are grouped PER ORDER (one open request per source): every `manual_required`
 *    row of the order is linked to the one request (`refund_request_id`), keeps its status (it
 *    still claims the money) and is closed when the request completes. The request carries
 *    `earnings_impact: 'none'` — delivery money was never allocated, so nothing is paused or
 *    clawed back. The legacy settle screen refuses a linked row from then on.
 *  - A booking's request pauses its earnings (`refund_in_progress`, a no-op over an existing
 *    pause) and recovers them when the money arrives. Earnings the OLD path already reversed are
 *    `reversed` rows, which the clawback treats as having nothing left — never recovered twice.
 *
 * Skipped, and reported (re-run after fixing): an order or booking that already has an OPEN
 * refund request; an order still holding a `processing` delivery row; a booking already carrying
 * ANY refund request (a rejected one must not be re-raised); a booking paid in cash, or whose
 * payment cannot be found (`REFUND_PAYMENT_NOT_FOUND`, checked read-only before `create`, dry run
 * included) — its ticket stays the record.
 *
 * Idempotent: linked rows and bookings with a request are not touched again. `--dry-run` lists
 * what would be raised and writes NOTHING. Must run BEFORE `migrate:refund-requests-indexes`
 * (data before index builds); it never creates two open requests on one source itself.
 *
 * Run:  npx ts-node scripts/migrate-legacy-refunds-to-requests.ts [--dry-run]
 *       (npm run migrate:legacy-refunds-to-requests)
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { DeliveryFeeRefundModel } from '../src/modules/delivery-fee-proposals/models/delivery-fee-refund.model';
import { Booking } from '../src/modules/booking/models/booking.model';
import { RefundRequestModel } from '../src/modules/payments/models/refund-request.model';
import { refundRequestService } from '../src/modules/payments/services/refund-request.service';
import { primePaymentSettings } from '../src/modules/payments/services/payment-settings.service';
import { initializeRefundDomain } from '../src/modules/payments/refund.bootstrap';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
const DRY_RUN = process.argv.includes('--dry-run');

const MIGRATION_ACTOR = { id: null, role: 'system' as const, name: 'migration: legacy refund queue' };

function errorCode(error: unknown): string {
  const e = error as { code?: unknown; message?: string } | null;
  return typeof e?.code === 'string' ? e.code : (e?.message ?? String(error));
}

async function migrateDeliveryFeeRows(): Promise<{ raised: number; skipped: number; failed: number }> {
  const rows = await DeliveryFeeRefundModel.find({
    status: 'manual_required',
    refund_request_id: null,
    rejected_refund_request_id: null,
  }).sort({ created_at: 1 });
  const byOrder = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.order_id.toString();
    byOrder.set(key, [...(byOrder.get(key) ?? []), row]);
  }
  console.log(`\n[delivery_fee_refunds] ${rows.length} manual_required row(s) on ${byOrder.size} order(s)`);

  let raised = 0;
  let skipped = 0;
  let failed = 0;
  for (const [orderId, orderRows] of byOrder) {
    const total = orderRows.reduce((s, r) => s + r.amount, 0);
    const label = `order ${orderId} (${orderRows.length} row(s), ${total} ${orderRows[0].currency})`;

    if (await refundRequestService.findOpenForSource('order', orderId)) {
      console.log(`  SKIP ${label}: a refund request is already open on the order`);
      skipped++;
      continue;
    }
    if (await DeliveryFeeRefundModel.exists({ order_id: new Types.ObjectId(orderId), status: 'processing' })) {
      console.log(`  SKIP ${label}: a delivery refund of the order is still processing`);
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      console.log(`  WOULD RAISE ${label}`);
      raised++;
      continue;
    }
    try {
      const request = await refundRequestService.create({
        source: { kind: 'order', id: orderId },
        amount: total,
        reasonKind: orderRows.some((r) => r.cause === 'rto_leftover') ? 'return' : 'goodwill',
        reason: `Delivery-fee money owed back, moved from the manual refund queue (rows ${orderRows.map((r) => r._id.toString()).join(', ')})`,
        requestedBy: MIGRATION_ACTOR,
        approveNow: false,
        prefer: 'topup_first',
        earningsImpact: 'none',
        ticketId: orderRows.find((r) => r.ticket_id)?.ticket_id?.toString() ?? null,
      });
      await DeliveryFeeRefundModel.updateMany(
        { _id: { $in: orderRows.map((r) => r._id) }, status: 'manual_required', refund_request_id: null },
        {
          $set: {
            refund_request_id: request._id,
            note: `Moved to refund request ${request.id} — approve, settle or reject it in the refund queue`,
          },
        }
      );
      console.log(`  RAISED ${label} → refund request ${request.id} (${request.status})`);
      raised++;
    } catch (error) {
      console.error(`  FAILED ${label}: ${errorCode(error)}`);
      failed++;
    }
  }
  return { raised, skipped, failed };
}

async function migrateBookings(): Promise<{ raised: number; skipped: number; failed: number }> {
  const bookings = await Booking.find({ paymentStatus: 'refund_pending' })
    .select('_id bookingNumber priceSnapshot currency paymentMethod cancelledReason')
    .sort({ _id: 1 })
    .lean<Array<{ _id: Types.ObjectId; bookingNumber?: string | null; priceSnapshot?: number; currency?: string; paymentMethod?: string | null; cancelledReason?: string | null }>>();
  console.log(`\n[bookings] ${bookings.length} booking(s) in refund_pending`);

  let raised = 0;
  let skipped = 0;
  let failed = 0;
  for (const b of bookings) {
    const id = b._id.toString();
    const label = `booking ${b.bookingNumber ?? id} (${b.priceSnapshot ?? '?'} ${b.currency ?? ''})`;
    if (await RefundRequestModel.exists({ source_kind: 'booking', source_id: b._id })) {
      console.log(`  SKIP ${label}: it already has a refund request`);
      skipped++;
      continue;
    }
    if (b.paymentMethod === 'cash') {
      console.log(`  SKIP ${label}: paid in cash — the vendor hands it back; its ticket stays the record`);
      skipped++;
      continue;
    }
    // READ-ONLY, the same facts `create` reads, in the dry run too so the rehearsal is honest.
    // A booking whose payment cannot be found can NEVER be raised: it is a SKIP (its ticket stays
    // the record), not a failure — counted as failed it made every run exit 1 and `migrate:up`
    // stop on it forever. (Found on a throwaway replica set, 2026-10-05.)
    try {
      await refundRequestService.describeSource('booking', id);
    } catch (error) {
      if (errorCode(error) === 'REFUND_PAYMENT_NOT_FOUND') {
        console.log(`  SKIP ${label}: no settled payment found — its ticket stays the record`);
        skipped++;
        continue;
      }
      if (DRY_RUN) {
        console.error(`  WOULD FAIL ${label}: ${errorCode(error)}`);
        failed++;
        continue;
      }
    }
    if (DRY_RUN) {
      console.log(`  WOULD RAISE ${label}`);
      raised++;
      continue;
    }
    try {
      const request = await refundRequestService.create({
        source: { kind: 'booking', id },
        reasonKind: 'cancellation',
        reason: `Cancelled after payment, moved from refund_pending${b.cancelledReason ? ` (${b.cancelledReason})` : ''}`,
        requestedBy: MIGRATION_ACTOR,
        approveNow: false,
      });
      console.log(`  RAISED ${label} → refund request ${request.id} (${request.status}, ${request.gross_amount} ${request.currency})`);
      raised++;
    } catch (error) {
      console.error(`  FAILED ${label}: ${errorCode(error)}`);
      failed++;
    }
  }
  return { raised, skipped, failed };
}

async function main(): Promise<void> {
  // autoIndex/autoCreate OFF, as `migrate-declared-indexes.ts` does: this script loads the whole
  // service graph (~50 models), and Mongoose's defaults would create every collection and start
  // every declared index build on connect — in production too (the server's NODE_ENV switch does
  // not apply here), during a `--dry-run`, and racing this script's own transactions
  // ("Unable to write … due to catalog changes"). Index builds are `migrate:refund-requests-indexes`
  // and `migrate:declared-indexes`, which run after this.
  await mongoose.connect(MONGO_URI, { autoIndex: false, autoCreate: false });
  console.log(`Connected${DRY_RUN ? '  (DRY RUN — nothing will be written)' : ''}`);
  // The same wiring the server does before it serves: the ports `create` needs, and the fee rate.
  initializeRefundDomain();
  await primePaymentSettings();

  const delivery = await migrateDeliveryFeeRows();
  const bookings = await migrateBookings();

  console.log(
    `\nDelivery-fee orders: ${delivery.raised} ${DRY_RUN ? 'would be raised' : 'raised'}, ${delivery.skipped} skipped, ${delivery.failed} failed`
  );
  console.log(
    `Bookings:            ${bookings.raised} ${DRY_RUN ? 'would be raised' : 'raised'}, ${bookings.skipped} skipped, ${bookings.failed} failed`
  );
  if (DRY_RUN) console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to apply.');
  await mongoose.disconnect();
  // A failure leaves the rest applied and is reported; the ledger records a failed run so it is
  // re-run. Exit explicitly: this script loads the service graph, and a lazily opened client must
  // not keep a migration step hanging after its work is done.
  process.exit(delivery.failed + bookings.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('migrate:legacy-refunds-to-requests FAILED:', error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
}
