/**
 * The one-time reminder between a vendor and a customer (BOOKING-PARTY-REMINDER-PLAN, 2026-11-03).
 *
 *   §1  the rule — confirmed and not started, once per recipient, the two sides independent;
 *   §2  the reader's view — what each side's `reminder` block says;
 *   §3  the phrase — decided by the reader's calendar. It used to say "tomorrow" for anything over
 *       18 hours away, which only a reminder sent by hand could expose;
 *   §4  the date in the message — a raw `Date` reaching the renderer printed as a JavaScript date
 *       in UTC, on every reminder the platform had sent;
 *   §5  what enforces "once" — source scans, because the claim's filter is what a refactor erodes.
 *       `verify:party-reminder` proves the same thing against a real database.
 *
 * Offline: no database, no server. Run: npm run test:party-reminder
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import {
    appointmentWhenPhrase,
    partyReminderPath,
    partyReminderRefusal,
    partyReminderView,
} from '../../src/modules/booking/domain/party-reminder';
import { customerAppointmentFields } from '../../src/modules/booking/domain/appointment';
import { formatMomentsInContext, renderTemplate } from '../../src/modules/notifications/catalog/message-renderer';
import { NOTIFICATION_CATALOG, renderWhatsAppTemplateParams, whatsAppTemplateName } from '../../src/modules/notifications/catalog/notification-catalog';
import { SUPPORTED_LANGUAGES } from '../../src/modules/notifications/catalog/notification-i18n';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => boolean): void {
    try {
        if (fn()) {
            passed += 1;
            console.log(`  ✅ ${label}`);
        } else {
            failed += 1;
            console.error(`  ❌ FAIL: ${label}`);
        }
    } catch (error) {
        failed += 1;
        console.error(`  ❌ THROW: ${label} — ${(error as Error).message}`);
    }
}

const SRC = join(__dirname, '../../src/modules');
const code = (relative: string): string =>
    readFileSync(join(SRC, relative), 'utf-8')
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

const NOW = new Date('2026-11-03T10:00:00Z');
const FUTURE = new Date('2026-11-10T10:00:00Z');
const live = { status: BookingStatus.CONFIRMED, startAt: FUTURE };

console.log('\n§1 the rule');
assert('a confirmed appointment that has not started can be reminded, by either side', () =>
    partyReminderRefusal(live, 'customer', NOW) === null && partyReminderRefusal(live, 'vendor', NOW) === null);
for (const status of [BookingStatus.PENDING, BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.NO_SHOW]) {
    assert(`${status} is refused`, () => partyReminderRefusal({ ...live, status }, 'vendor', NOW) === 'not_applicable');
}
assert('an appointment starting NOW is refused', () =>
    partyReminderRefusal({ ...live, startAt: NOW }, 'customer', NOW) === 'not_applicable');
assert('a customer who sent theirs is refused, and the vendor can still send', () => {
    const booking = { ...live, partyReminders: { toVendorAt: NOW, toCustomerAt: null } };
    return partyReminderRefusal(booking, 'customer', NOW) === 'already_sent' && partyReminderRefusal(booking, 'vendor', NOW) === null;
});
assert('a vendor who sent theirs is refused, and the customer can still send', () => {
    const booking = { ...live, partyReminders: { toVendorAt: null, toCustomerAt: NOW } };
    return partyReminderRefusal(booking, 'vendor', NOW) === 'already_sent' && partyReminderRefusal(booking, 'customer', NOW) === null;
});
assert('a sent reminder on a finished appointment says why nothing more can be done', () =>
    partyReminderRefusal({ status: BookingStatus.COMPLETED, startAt: FUTURE, partyReminders: { toVendorAt: NOW } }, 'customer', NOW) === 'not_applicable');
assert('the stamp is keyed by who RECEIVES it', () =>
    partyReminderPath('customer') === 'partyReminders.toVendorAt' && partyReminderPath('vendor') === 'partyReminders.toCustomerAt');

console.log('\n§2 the view');
assert('nothing sent: both may send, and no stamp', () => {
    const view = partyReminderView(live, 'customer', NOW);
    return view.canSend && view.sentAt === null && view.receivedAt === null;
});
assert('the same stamp is `sentAt` for its sender and `receivedAt` for the other side', () => {
    const booking = { ...live, partyReminders: { toVendorAt: NOW, toCustomerAt: null } };
    const customer = partyReminderView(booking, 'customer', NOW);
    const vendor = partyReminderView(booking, 'vendor', NOW);
    return customer.sentAt === NOW && !customer.canSend && vendor.receivedAt === NOW && vendor.canSend && vendor.sentAt === null;
});
assert('⛔ every customer door gets the block, through `customerAppointmentFields`', () => {
    const fields = customerAppointmentFields({
        ...live, paymentStatus: 'paid', requiresPayment: true, endAt: FUTURE, partyReminders: { toVendorAt: NOW },
    }, NOW);
    return fields.reminder.sentAt === NOW && fields.reminder.canSend === false;
});

console.log('\n§3 the phrase');
const hoursLater = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);
const phrase = (date: Date, lang: 'en' | 'fr' | 'pt' | 'es' | 'ar' = 'en', timezone = 'Africa/Douala'): string =>
    appointmentWhenPhrase(date, lang, timezone, NOW);
assert('within three hours: "coming up shortly"', () => phrase(hoursLater(2)) === 'coming up shortly');
assert('later the same day: "later today"', () => phrase(hoursLater(6)) === 'later today');
assert('the next calendar day: "tomorrow"', () => phrase(hoursLater(24)) === 'tomorrow');
assert('⛔ ten days out is NOT "tomorrow"', () => phrase(hoursLater(240)) === 'in 10 days');
assert('14 hours away is "tomorrow" past midnight, not "later today"', () => phrase(hoursLater(14)) === 'tomorrow');
assert('the day is the READER\'s: 23:30 UTC is already tomorrow in Douala', () => {
    const start = new Date('2026-11-03T23:30:00Z');
    return phrase(start, 'en', 'Africa/Douala') === 'tomorrow' && phrase(start, 'en', 'UTC') === 'later today';
});
assert('every language has an "in N days"', () =>
    phrase(hoursLater(120), 'fr') === 'dans 5 jours' && phrase(hoursLater(120), 'pt') === 'daqui a 5 dias'
    && phrase(hoursLater(120), 'es') === 'dentro de 5 días' && phrase(hoursLater(120), 'ar') === 'خلال 5 أيام');
assert('an unusable timezone costs nothing but precision', () => phrase(hoursLater(120), 'en', 'Not/AZone') === 'in 5 days');

console.log('\n§4 the date in the message');
assert('⛔ a Date becomes a time in the reader\'s zone, never `String(date)`', () => {
    const rendered = renderTemplate('at {{startAt}}', formatMomentsInContext({ startAt: new Date('2026-11-04T13:00:00Z') }, 'Africa/Douala'));
    return rendered === 'at 2026-11-04 14:00' && !rendered.includes('GMT');
});
assert('…and it is the reason for the fix: unformatted, the renderer prints a JavaScript date', () =>
    renderTemplate('{{startAt}}', { startAt: new Date('2026-11-04T13:00:00Z') }).includes('GMT'));
assert('an invalid Date renders empty rather than "Invalid Date"', () =>
    formatMomentsInContext({ startAt: new Date('nope') }, 'UTC').startAt === '');
assert('an unusable timezone falls back to UTC rather than throwing', () =>
    formatMomentsInContext({ startAt: new Date('2026-11-04T13:00:00Z') }, 'Not/AZone').startAt === '2026-11-04 13:00');
assert('every other value passes through untouched', () => {
    const out = formatMomentsInContext({ a: 'text', b: 3, c: null }, 'UTC');
    return out.a === 'text' && out.b === 3 && out.c === null;
});
assert('⛔ the customer dispatch formats BEFORE it renders', () => {
    const dispatch = code('notifications/services/customer-notification-event-handler.service.ts').split('private async dispatch(')[1];
    const format = dispatch.indexOf('formatMomentsInContext(params.context');
    const render = dispatch.indexOf('renderCustomerInApp(params.situation, lang, context)');
    return format > 0 && render > format && !dispatch.split('private async deliverPush')[0].includes('lang, params.context');
});

console.log('\n§5 what enforces "once"');
const SERVICE = code('booking/services/party-reminder.service.ts');
const claim = SERVICE.split('private async claim(')[1].split('private async sendOrRelease')[0];
assert('the claim is one atomic write', () => claim.includes('Booking.findOneAndUpdate('));
for (const clause of ['...scope', 'deletedAt: null', 'status: BookingStatus.CONFIRMED', 'startAt: { $gt: now }', '[path]: null']) {
    assert(`the claim's filter holds \`${clause}\``, () => claim.includes(clause));
}
assert('⛔ neither write bumps `updatedAt`, which wi-admin\'s payment_stuck queue reads', () =>
    claim.includes('timestamps: false') && SERVICE.split('private async sendOrRelease(')[1].includes('timestamps: false'));
assert('a failed send releases the claim, only if it is still this claim, and re-raises', () => {
    const release = SERVICE.split('private async sendOrRelease(')[1];
    return release.includes('[path]: stamp') && release.includes('$set: { [path]: null }') && release.includes('throw error');
});
assert('the customer check runs BEFORE the claim, so nobody-to-remind does not spend it', () => {
    const body = SERVICE.split('async remindCustomer(')[1];
    return body.indexOf('if (!customer)') < body.indexOf('this.claim(');
});
assert('both sends use the throwing paths, never the swallowing `notify`', () =>
    SERVICE.includes('sendBookingReminderFromCustomer(') && SERVICE.includes('sendBookingReminderFromVendor(') && !SERVICE.includes('.notify('));
assert('the idempotency keys are stable: one per recipient, per booking, with no request id', () => {
    const customer = code('notifications/services/customer-notification-event-handler.service.ts');
    const vendor = code('notifications/services/vendor-notification-event-handler.service.ts');
    return customer.includes('`customer.booking.reminder.from_vendor:${p.bookingId}`')
        && vendor.includes('`booking.reminder:${p.bookingId}:${p.vendorId}`');
});
assert('the customer direction reaches a muted customer, and only that path sets the flag', () => {
    const customer = code('notifications/services/customer-notification-event-handler.service.ts');
    return customer.includes('deliverDespiteMute: true')
        && customer.includes('if (prefKey && !params.deliverDespiteMute && prefs.preferences[prefKey] === false) return;')
        && customer.split('deliverDespiteMute: true').length === 2;
});
assert('the vendor direction reads no preference as a gate', () => {
    const body = code('notifications/services/vendor-notification-event-handler.service.ts')
        .split('async sendBookingReminderFromCustomer(')[1].split('private async dispatchMove')[0];
    return !body.includes('prefs.preferences');
});
assert('the raw stamps never reach a vendor or customer read', () =>
    code('booking/models/booking.model.ts').includes('delete out.partyReminders'));
assert('both routes are mounted', () => {
    const customer = code('booking/routes/customer-booking.routes.ts');
    const vendor = code('booking/routes/vendor-booking.routes.ts');
    return customer.includes("router.post('/:id/reminder', CustomerBookingController.sendReminder)")
        && vendor.includes("router.post('/:id/reminder', VendorBookingController.sendReminder)");
});
assert('the vendor is scoped by the VENDOR entity and the customer by the USER', () =>
    code('booking/controllers/vendor-booking.controller.ts').includes('remindCustomer(req.params.id, req.auth!.role_entity._id.toString())')
    && code('booking/controllers/customer-booking.controller.ts').includes('remindVendor(req.params.id, req.auth!.user._id.toString())'));

console.log('\n§6 the vendor message');
assert('it exists in every language', () =>
    SUPPORTED_LANGUAGES.every((lang) => !!NOTIFICATION_CATALOG['booking.reminder'].base[lang]?.body));
assert('it names the new template', () => whatsAppTemplateName('booking.reminder') === 'vendor_booking_reminder');
assert('the template\'s four parameters are in the order the approved body expects', () => {
    const params = renderWhatsAppTemplateParams('booking.reminder', 'en', {
        customerName: 'Amina', bookingNumber: 'BKG-1', serviceName: 'Braids', startDate: '2026-11-10 11:00',
    });
    return params.join('|') === 'Amina|BKG-1|Braids|2026-11-10 11:00';
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
