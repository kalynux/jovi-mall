/**
 * Booking administration — jovi-mall's half (ADMIN-BOOKINGS-PLAN, 2026-10-27).
 *
 * wi-admin reads bookings directly and delegates every write here. What can break on THIS side,
 * silently:
 *
 *   §1  the status history — every status write goes through `applyStatusChange`, so the history
 *       cannot fall behind the status (a raw `booking.status = …` would);
 *   §2  the transitions — an ADMINISTRATOR alone may take a `no-show` to `completed`; the vendor's
 *       terminal states stay terminal for the vendor;
 *   §3  the administrator paths reuse the ordinary ones (refund, hold, events) rather than
 *       re-implementing them, and the fault decides the fees;
 *   §4  the internal surface — mounted internal-only, answering a THIN acknowledgement, never the
 *       booking document (which carries the address, the link and the metadata);
 *   §5  the customer is told "Wi-Mall support" cancelled, not "the provider".
 *
 * Offline: no database, no server. Run: npm run test:admin-bookings
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    applyStatusChange,
    statusChange,
    STATUS_REASON_MAX,
    BOOKING_STATUS_ACTOR_ROLES,
    type IBookingStatusChange,
} from '../../src/modules/booking/domain/booking-status-history';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import { toCustomerBookingShape } from '../../src/modules/booking/domain/appointment';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean): void {
    try {
        if (fn()) {
            passed += 1;
            console.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            console.log(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        console.log(`  ❌ THROW: ${label} — ${error instanceof Error ? error.message : String(error)}`);
    }
}

function section(title: string): void {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Comments out, so a comment explaining a rule never satisfies a scan for the rule itself. */
const code = (rel: string): string =>
    read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const BOOKING_SERVICE = code('modules/booking/services/booking.service.ts');
const GROUP_SERVICE = code('modules/booking/services/group-booking.service.ts');
const DISPUTE_SERVICE = code('modules/payments/services/dispute.service.ts');
const ADMIN_SERVICE = code('modules/booking/services/admin-booking.service.ts');
const ADMIN_CONTROLLER = code('modules/booking/controllers/admin-booking.controller.ts');
const ADMIN_ROUTES = code('modules/booking/routes/admin-booking.routes.ts');
const INTERNAL_MOUNT = code('api/routes/internal-admin.routes.ts');

/** The body of one method of a class, by name — from its signature to the next method at the same depth. */
function methodBody(source: string, name: string): string {
    const signature = [...source.matchAll(/\n {2}(?:async |private async |private )?(\w+)\(/g)].find((m) => m[1] === name);
    if (!signature) return '';
    const rest = source.slice(signature.index! + 1);
    const next = rest.slice(1).search(/\n {2}(?:async |private async |private |static |get )?[a-zA-Z]+\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

// ─── §1 ──────────────────────────────────────────────────────────────────────
section('§1 the status history');

assert('statusChange records from, to, who and why', () => {
    const row = statusChange(BookingStatus.CONFIRMED, BookingStatus.CANCELLED, { role: 'admin', id: 'a1' }, '  vendor closed  ');
    return row.from === 'confirmed' && row.to === 'cancelled' && row.actorRole === 'admin'
        && row.actorId === 'a1' && row.reason === 'vendor closed' && row.at instanceof Date;
});
assert('an empty reason is stored as null, never ""', () =>
    statusChange(null, BookingStatus.PENDING, { role: 'customer', id: 'u1' }, '   ').reason === null
    && statusChange(null, BookingStatus.PENDING, { role: 'customer', id: 'u1' }).reason === null);
assert('a long reason is CUT, not refused — the change already happened', () =>
    statusChange(null, BookingStatus.PENDING, { role: 'system', id: null }, 'x'.repeat(900)).reason!.length === STATUS_REASON_MAX);
assert('applyStatusChange sets the status AND appends one row, keeping the earlier ones', () => {
    const booking: { status: BookingStatus; statusHistory?: IBookingStatusChange[] } = {
        status: BookingStatus.CONFIRMED,
        statusHistory: [statusChange(null, BookingStatus.CONFIRMED, { role: 'customer', id: 'u1' })],
    };
    applyStatusChange(booking, BookingStatus.NO_SHOW, { role: 'vendor', id: 'v1' });
    return booking.status === BookingStatus.NO_SHOW
        && booking.statusHistory!.length === 2
        && booking.statusHistory![1].from === 'confirmed'
        && booking.statusHistory![1].to === 'no-show';
});
assert('…and starts a history on a booking that has none (written before 2026-10-27)', () => {
    const booking: { status: BookingStatus; statusHistory?: IBookingStatusChange[] | null } = { status: BookingStatus.CONFIRMED, statusHistory: null };
    applyStatusChange(booking, BookingStatus.COMPLETED, { role: 'admin', id: 'a1' });
    return booking.statusHistory!.length === 1 && booking.statusHistory![0].from === 'confirmed';
});
assert('the four actor roles are customer, vendor, admin and system', () =>
    JSON.stringify([...BOOKING_STATUS_ACTOR_ROLES]) === JSON.stringify(['customer', 'vendor', 'admin', 'system']));
assert('the model declares statusHistory, defaulting to an empty list', () => {
    const model = code('modules/booking/models/booking.model.ts');
    return /statusHistory:\s*\{\s*type:\s*\[/.test(model) && /default:\s*\[\],/.test(model);
});
assert('⛔ no raw `booking.status = …` assignment is left in BookingService', () =>
    !/\bbooking\.status\s*=(?!=)/.test(BOOKING_SERVICE));
assert('⛔ …nor in the dispute service\'s booking path', () =>
    !/\bbooking\.status\s*=(?!=)/.test(DISPUTE_SERVICE) && DISPUTE_SERVICE.includes('applyStatusChange(booking, BookingStatus.CANCELLED'));
assert('both creation paths write the first history row', () =>
    /statusHistory:\s*\[\s*statusChange\(null,/.test(BOOKING_SERVICE) && /statusHistory:\s*\[statusChange\(null, BookingStatus\.CONFIRMED/.test(GROUP_SERVICE));
assert('the customer cancel, the vendor cancel and the status menu each record their actor', () =>
    methodBody(BOOKING_SERVICE, 'cancelBooking').includes("applyStatusChange(booking, BookingStatus.CANCELLED, { role: 'customer', id: userId }")
    && /role: 'system', id: null \} : \{ role: 'vendor', id: vendorId \}/.test(methodBody(BOOKING_SERVICE, 'cancelVendorBooking'))
    && methodBody(BOOKING_SERVICE, 'updateBookingStatus').includes('applyStatusChange(booking, newStatus, actor, reason)'));

// ─── §2 ──────────────────────────────────────────────────────────────────────
section('§2 the transitions');

const STATUS_METHOD = methodBody(BOOKING_SERVICE, 'updateBookingStatus');
assert('updateBookingStatus takes an actor, defaulting to the vendor', () =>
    /actor: BookingStatusActor = \{ role: 'vendor', id: vendorId \}/.test(STATUS_METHOD));
assert('⛔ only an ADMINISTRATOR may take no-show → completed', () =>
    /'no-show': actor\.role === 'admin' \? \['completed'\] : \[\]/.test(STATUS_METHOD));
assert('completed and cancelled stay terminal for everyone', () =>
    /completed: \[\],/.test(STATUS_METHOD) && /cancelled: \[\],/.test(STATUS_METHOD));
assert('a completion still starts the earnings hold on the same path', () =>
    STATUS_METHOD.includes("earningsCompletionService.onSourceCompleted('booking'"));

// ─── §3 ──────────────────────────────────────────────────────────────────────
section('§3 the administrator paths reuse the ordinary ones');

const CANCEL_ADMIN = methodBody(BOOKING_SERVICE, 'cancelAsAdmin');
const COMPLETE_ADMIN = methodBody(BOOKING_SERVICE, 'completeAsAdmin');
assert('cancelAsAdmin refunds through refundIfPaid — the ordinary cancellation refund', () =>
    CANCEL_ADMIN.includes("this.refundIfPaid(booking, adminId, 'admin', reason,"));
assert('⛔ the fault decides the fees: vendor → the vendor bears them (customer 100% back)', () =>
    CANCEL_ADMIN.includes("fault === 'vendor' ? 'vendor' : 'customer'"));
assert('cancelAsAdmin does NOT apply the vendor\'s cancellation policy', () =>
    !CANCEL_ADMIN.includes('assertCancellationAllowed'));
assert('cancelAsAdmin refuses a COMPLETED booking (its refund is the refund queue\'s)', () =>
    /booking\.status === BookingStatus\.COMPLETED\)[\s\S]{0,80}BOOKING_TERMINAL_STATE/.test(CANCEL_ADMIN));
assert('…and accepts a no-show (a paid no-show waits for exactly this decision)', () =>
    !/BookingStatus\.NO_SHOW/.test(CANCEL_ADMIN));
assert('cancelAsAdmin detaches the calendar and tells both sides it was the platform', () =>
    CANCEL_ADMIN.includes('this.detachFromCalendarOnCancel(booking)')
    && CANCEL_ADMIN.includes("this.emitBookingCancelledEvent(booking, 'admin')"));
assert('completeAsAdmin goes through updateBookingStatus as an admin actor (the hold starts there)', () =>
    /this\.updateBookingStatus\([\s\S]{0,160}\{ role: 'admin', id: adminId \}/.test(COMPLETE_ADMIN));
assert('⛔ completeAsAdmin refuses an unpaid booking — it releases held money, never asks for some', () =>
    /requiresPayment && booking\.paymentStatus !== 'paid'[\s\S]{0,80}BOOKING_ADMIN_COMPLETE_UNPAID/.test(COMPLETE_ADMIN));
assert('completeAsAdmin refuses an appointment that has not started', () =>
    COMPLETE_ADMIN.includes('BOOKING_NOT_STARTED'));
assert('the payment re-check goes through verifyPayment — the reconciliation sweep\'s own call', () =>
    ADMIN_SERVICE.includes('this.orchestrator.verifyPayment('));
assert('⛔ the re-check never replays a success by hand — a SUCCEEDED attempt is a mismatch for an engineer', () =>
    /latest\.status === 'SUCCEEDED'\)[\s\S]{0,60}BOOKING_PAYMENT_STATE_MISMATCH/.test(ADMIN_SERVICE));
assert('the stuck-payment release is a pending → failed compare-and-set', () =>
    /findOneAndUpdate\(\s*\{ _id: booking\._id, paymentStatus: 'pending' \},\s*\{ \$set: \{ paymentStatus: 'failed' \} \}/.test(ADMIN_SERVICE));
assert('recording cash runs the vendor\'s own markAsPaidByCash', () =>
    ADMIN_SERVICE.includes('this.bookings.markAsPaidByCash(bookingId, booking.vendorId.toString())'));
assert('a resent reminder uses a FRESH idempotency key (the first one would swallow it)', () =>
    ADMIN_SERVICE.includes('customer.booking.reminder.resend:${booking._id}:${requestId}'));
assert('⛔ the access verdict leaves the link and the instructions out', () =>
    /const \{ instructions: _i, meetingUrl: _m, \.\.\.verdict \} = view;/.test(ADMIN_SERVICE));

// ─── §4 ──────────────────────────────────────────────────────────────────────
section('§4 the internal surface');

assert('mounted at /bookings behind requireAdminCaller, internal only', () =>
    /router\.use\('\/bookings',\s*buildAdminBookingRouter\(\[requireAdminCaller\]\)\)/.test(INTERNAL_MOUNT));
for (const [method, path] of [
    ['get', '/services/:productId/availability'],
    ['post', '/services/:productId/sessions/cancel'],
    ['get', '/:bookingId/access-state'],
    ['post', '/:bookingId/cancel'],
    ['post', '/:bookingId/complete'],
    ['post', '/:bookingId/payment/recheck'],
    ['post', '/:bookingId/payment/cash'],
    ['post', '/:bookingId/proposal/withdraw'],
    ['post', '/:bookingId/reminder'],
] as const) {
    assert(`${method.toUpperCase()} ${path} is served`, () => ADMIN_ROUTES.includes(`router.${method}('${path}'`));
}
assert('the literal /services/… routes are declared above /:bookingId/…', () =>
    ADMIN_ROUTES.indexOf("'/services/") < ADMIN_ROUTES.indexOf("'/:bookingId/"));
assert('⛔ every write answers ack(booking), never the document', () =>
    !/sendSuccess\(res, booking\b/.test(ADMIN_CONTROLLER) && (ADMIN_CONTROLLER.match(/sendSuccess\(res, ack\(booking\)/g) ?? []).length === 4);
assert('the request bodies are strict (an unknown field is a 400, not ignored)', () =>
    (ADMIN_CONTROLLER.match(/\.strict\(\)/g) ?? []).length >= 4);
assert('the cancel body requires a fault of vendor | customer', () =>
    /FaultSchema = z\.enum\(\['vendor', 'customer'\]\)/.test(ADMIN_CONTROLLER)
    && /CancelSchema = z\.object\(\{ reason: ReasonSchema, fault: FaultSchema \}\)/.test(ADMIN_CONTROLLER));

// ─── §5 ──────────────────────────────────────────────────────────────────────
section('§5 the customer is told who cancelled');

const HANDLER = code('modules/notifications/services/customer-notification-event-handler.service.ts');
assert('booking.cancelled accepts cancelledByRole: admin', () =>
    /cancelledByRole\?: 'customer' \| 'vendor' \| 'system' \| 'admin'/.test(HANDLER));
assert('an admin cancellation reads "Wi-Mall support", never "the provider"', () =>
    /role === 'admin'\)[\s\S]{0,80}en: 'Wi-Mall support'/.test(HANDLER));

// ─── §6 ──────────────────────────────────────────────────────────────────────
section('§6 the history never reaches a customer or a vendor');

assert('⛔ the customer guard strips statusHistory', () => {
    const shaped = toCustomerBookingShape(
        { id: 'b1', status: 'cancelled', statusHistory: [{ actorRole: 'admin', actorId: 'a1', reason: 'internal note' }] },
        { status: 'cancelled', paymentStatus: 'paid', requiresPayment: true, startAt: new Date(), endAt: new Date(), access: null, location: null, rescheduleProposal: null },
    );
    return !('statusHistory' in shaped) && shaped.id === 'b1';
});
assert('⛔ a serialised booking document (the vendor endpoints) drops statusHistory', () => {
    const model = code('modules/booking/models/booking.model.ts');
    return /BookingSchema\.set\('toJSON'/.test(model) && /delete out\.statusHistory/.test(model);
});

console.log(`\n━━━ admin bookings: ${passed}/${passed + failed} passed${failed ? `, ${failed} FAILED` : ''} ━━━`);
process.exit(failed > 0 ? 1 : 0);
