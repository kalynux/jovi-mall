/**
 * verify:party-reminder — the one-time reminder against REAL Mongo (BOOKING-PARTY-REMINDER-PLAN).
 *
 * Its subject is what the DB-free `test:party-reminder` structurally cannot see: that the claim
 * really admits exactly one of several simultaneous sends, that a nested `$set` on a booking with no
 * `partyReminders` works, that `updatedAt` really does not move, and that the message that lands in
 * the inbox reads properly.
 *
 * It builds its own world from fresh ObjectIds and deletes it, pass or fail. The fixtures have no
 * connected channel, no verified email and no device, so nothing leaves this machine. A standalone
 * mongod is enough: nothing here opens a transaction.
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/jovi_reminder_verify" npm run verify:party-reminder
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import { Booking } from '../../src/modules/booking/models/booking.model';
import { partyReminderService } from '../../src/modules/booking/services/party-reminder.service';
import { partyReminderView } from '../../src/modules/booking/domain/party-reminder';
import { toCustomerBookingShape } from '../../src/modules/booking/domain/appointment';
import { getVendorNotificationHandler } from '../../src/modules/notifications/vendor-notification-event-consumer';
import { CustomerNotificationModel } from '../../src/modules/notifications/models/customer-notification.model';
import { VendorNotificationModel } from '../../src/modules/notifications/models/vendor-notification.model';
import { CustomerNotificationPreferenceModel } from '../../src/modules/notifications/models/customer-notification-preference.model';
import { VendorNotificationPreferenceModel } from '../../src/modules/notifications/models/vendor-notification-preference.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { ProductModel } from '../../src/modules/catalog/models/product.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;
async function assert(name: string, fn: () => Promise<boolean> | boolean): Promise<void> {
    try {
        if (await fn()) { console.log(`  ✅ ${name}`); passed++; } else { console.error(`  ❌ FAIL: ${name}`); failed++; }
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
    }
}
async function refusedWith(code: string, fn: () => Promise<unknown>): Promise<boolean> {
    try { await fn(); return false; } catch (err) {
        const got = (err as { code?: string }).code;
        if (got !== code) console.error(`      expected ${code}, got ${got}: ${(err as Error).message}`);
        return got === code;
    }
}

const oid = () => new Types.ObjectId();
const userId = oid();
const customerId = oid();
const vendorId = oid();
const vendorUserId = oid();
const productId = oid();
const bookingIds: Types.ObjectId[] = [];
const OLD = new Date('2026-01-01T00:00:00Z');

const col = (name: string) => mongoose.connection.db!.collection(name);

async function aBooking(overrides: Record<string, unknown> = {}): Promise<string> {
    const _id = oid();
    bookingIds.push(_id);
    const startAt = new Date(Date.now() + 5 * 86_400_000);
    await col(Booking.collection.name).insertOne({
        _id,
        bookingNumber: `BKG-VERIFY-${_id.toString().slice(-6)}`,
        productId,
        userId,
        vendorId,
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        status: BookingStatus.CONFIRMED,
        paymentStatus: 'paid',
        priceSnapshot: 5000,
        currency: 'XAF',
        requiresPayment: true,
        deletedAt: null,
        createdAt: OLD,
        updatedAt: OLD,
        ...overrides,
    });
    return _id.toString();
}
const raw = (id: string) => col(Booking.collection.name).findOne({ _id: new Types.ObjectId(id) });
const customerRows = (id: string) => CustomerNotificationModel.find({ aggregateId: id, type: 'booking.reminder' }).lean();
const vendorRows = (id: string) => VendorNotificationModel.find({ aggregateId: id, type: 'booking.reminder' }).lean();

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });

    await col(CustomerModel.collection.name).insertOne({ _id: customerId, user_id: userId, name: 'Amina', timezone: 'Africa/Douala', preferences: { language: 'en' } });
    await col(VendorModel.collection.name).insertOne({ _id: vendorId, user_id: vendorUserId, display_name: 'Salon Amina', timezone: 'Africa/Douala', preferences: { language: 'en' }, deletedAt: null });
    await col(ProductModel.collection.name).insertOne({ _id: productId, title: 'Box braids' });

    console.log('\nthe vendor reminds the customer');
    const first = await aBooking();
    const sent = await partyReminderService.remindCustomer(first, vendorId.toString());
    const afterVendor = await raw(first);
    await assert('the stamp lands on a booking that had no partyReminders', () => afterVendor?.partyReminders?.toCustomerAt instanceof Date);
    await assert('⛔ updatedAt did not move', () => afterVendor?.updatedAt?.getTime() === OLD.getTime());
    await assert('the answer says it cannot be sent again', () => partyReminderView(sent, 'vendor').canSend === false && partyReminderView(sent, 'vendor').sentAt !== null);
    const [customerNote] = await customerRows(first);
    await assert('the customer has it in their inbox', () => !!customerNote);
    await assert('⛔ the message names the time in their zone, not a JavaScript date', () => {
        const message = String(customerNote?.message);
        console.log(`      "${message}"`);
        return /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(message) && !message.includes('GMT');
    });
    await assert('…with the shop and the service named, and "in 5 days" rather than "tomorrow"', () => {
        const message = String(customerNote?.message);
        return message.includes('Salon Amina') && message.includes('Box braids') && message.includes('in 5 days');
    });
    await assert('a second send is refused', () => refusedWith('BOOKING_REMINDER_ALREADY_SENT', () => partyReminderService.remindCustomer(first, vendorId.toString())));
    await assert('…and no second message went out', async () => (await customerRows(first)).length === 1);

    console.log('\nthe customer reminds the vendor, independently');
    await partyReminderService.remindVendor(first, userId.toString());
    const afterBoth = await raw(first);
    await assert('the customer still had theirs', () => afterBoth?.partyReminders?.toVendorAt instanceof Date);
    const [vendorNote] = await vendorRows(first);
    await assert('the vendor has it in their inbox', () => !!vendorNote);
    await assert('⛔ it names the customer, the booking, the service and a readable time', () => {
        const message = String(vendorNote?.message);
        console.log(`      "${message}"`);
        return message.includes('Amina') && message.includes('BKG-VERIFY') && message.includes('Box braids')
            && /\d/.test(message) && !message.includes('GMT') && !message.includes('{{');
    });
    await assert('a second send is refused', () => refusedWith('BOOKING_REMINDER_ALREADY_SENT', () => partyReminderService.remindVendor(first, userId.toString())));

    console.log('\ntwo tabs, five taps');
    const raced = await aBooking();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => partyReminderService.remindCustomer(raced, vendorId.toString())));
    await assert('⛔ exactly one wins', () => results.filter((r) => r.status === 'fulfilled').length === 1);
    await assert('the rest are told it was already sent', () =>
        results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'BOOKING_REMINDER_ALREADY_SENT'));
    await assert('⛔ exactly one message went out', async () => (await customerRows(raced)).length === 1);

    console.log('\nwho may, and when');
    for (const status of [BookingStatus.PENDING, BookingStatus.CANCELLED, BookingStatus.COMPLETED]) {
        const id = await aBooking({ status });
        await assert(`${status} is refused, and nothing is spent`, async () =>
            await refusedWith('BOOKING_REMINDER_NOT_APPLICABLE', () => partyReminderService.remindVendor(id, userId.toString()))
            && !(await raw(id))?.partyReminders);
    }
    const started = await aBooking({ startAt: new Date(Date.now() - 60_000) });
    await assert('an appointment already started is refused', () => refusedWith('BOOKING_REMINDER_NOT_APPLICABLE', () => partyReminderService.remindCustomer(started, vendorId.toString())));
    const someoneElses = await aBooking();
    await assert('another customer gets a 404', () => refusedWith('BOOKING_NOT_FOUND', () => partyReminderService.remindVendor(someoneElses, oid().toString())));
    await assert('another shop gets a 404', () => refusedWith('BOOKING_NOT_FOUND', () => partyReminderService.remindCustomer(someoneElses, oid().toString())));
    await assert('a malformed id is a 404, not a 500', () => refusedWith('BOOKING_NOT_FOUND', () => partyReminderService.remindVendor('not-an-id', userId.toString())));
    const deleted = await aBooking({ deletedAt: new Date() });
    await assert('a deleted booking is a 404', () => refusedWith('BOOKING_NOT_FOUND', () => partyReminderService.remindVendor(deleted, userId.toString())));
    const noProfile = await aBooking({ userId: oid() });
    await assert('nobody to remind is refused, and does not spend it', async () =>
        await refusedWith('BOOKING_REMINDER_NOT_APPLICABLE', () => partyReminderService.remindCustomer(noProfile, vendorId.toString()))
        && !(await raw(noProfile))?.partyReminders);

    console.log('\na customer who muted reminders');
    await CustomerNotificationPreferenceModel.findOneAndUpdate(
        { customerId },
        { $set: { 'preferences.bookingReminders': false } },
        { upsert: true, setDefaultsOnInsert: true },
    );
    const muted = await aBooking();
    await partyReminderService.remindCustomer(muted, vendorId.toString());
    await assert('⛔ still receives the vendor\'s reminder (D-5)', async () => (await customerRows(muted)).length === 1);

    console.log('\na reminder nobody received is not spent');
    const flaky = await aBooking();
    const handler = getVendorNotificationHandler();
    const original = handler.sendBookingReminderFromCustomer;
    handler.sendBookingReminderFromCustomer = async () => { throw new Error('inbox down'); };
    let surfaced = false;
    try {
        await partyReminderService.remindVendor(flaky, userId.toString());
    } catch (error) {
        surfaced = (error as Error).message === 'inbox down';
    } finally {
        handler.sendBookingReminderFromCustomer = original;
    }
    await assert('the failure reaches the caller', () => surfaced);
    await assert('⛔ the claim was released', async () => (await raw(flaky))?.partyReminders?.toVendorAt === null);
    await assert('⛔ the release did not move updatedAt either', async () => (await raw(flaky))?.updatedAt?.getTime() === OLD.getTime());
    await assert('so a retry goes through', async () => {
        await partyReminderService.remindVendor(flaky, userId.toString());
        return (await vendorRows(flaky)).length === 1;
    });

    console.log('\nwhat each reader receives');
    const document = await Booking.findById(first);
    await assert('⛔ the serialised booking carries no raw stamps', () => !('partyReminders' in (document!.toJSON() as Record<string, unknown>)));
    await assert('the customer\'s shape says theirs is sent and the vendor\'s arrived', () => {
        const shaped = toCustomerBookingShape(document!.toJSON() as Record<string, unknown>, document! as never);
        return shaped.reminder.canSend === false && shaped.reminder.sentAt !== null && shaped.reminder.receivedAt !== null;
    });
}

async function cleanup(): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    await Promise.allSettled([
        col(Booking.collection.name).deleteMany({ _id: { $in: bookingIds } }),
        CustomerNotificationModel.deleteMany({ customerId }),
        VendorNotificationModel.deleteMany({ vendorId }),
        CustomerNotificationPreferenceModel.deleteMany({ customerId }),
        VendorNotificationPreferenceModel.deleteMany({ vendorId }),
        col(CustomerModel.collection.name).deleteOne({ _id: customerId }),
        col(VendorModel.collection.name).deleteOne({ _id: vendorId }),
        col(ProductModel.collection.name).deleteOne({ _id: productId }),
    ]);
    await mongoose.disconnect();
}

main()
    .catch((error) => { failed++; console.error('❌ CRASH', error); })
    .finally(async () => {
        await cleanup();
        console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
        process.exit(failed === 0 ? 0 : 1);
    });
