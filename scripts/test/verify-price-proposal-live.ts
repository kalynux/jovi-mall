/**
 * verify:price-proposal — a vendor's proposed price against REAL Mongo (BOOKING-PRICE-PROPOSAL-PLAN).
 *
 * NEEDS A REPLICA SET: earnings are split and refunds completed in transactions. Its subject is what
 * the DB-free `test:price-proposal` structurally cannot see: that the compare-and-sets admit one
 * winner, that a difference is really charged, credited once and split into HELD earnings, that a
 * lower price really opens and completes a partial refund on a booking that stays `paid`, and that
 * the messages read properly.
 *
 * The gateways are stubbed in-process and the payment settings served from a stub store, so no money
 * moves. It builds its own world from fresh ObjectIds and deletes it, pass or fail. The fixtures have
 * no connected channel, no verified email and no device, so nothing leaves this machine. Point it at
 * a scratch database with the plans seeded, because earnings cannot be split without them:
 *
 *   MONGO_URI="mongodb://127.0.0.1:27117/jovi_price_verify?replicaSet=rs0" npm run seed:plans
 *   MONGO_URI="mongodb://127.0.0.1:27117/jovi_price_verify?replicaSet=rs0" npm run verify:price-proposal
 */
process.env.LOG_STDOUT = 'false';

import dotenv from 'dotenv';
dotenv.config();
// Every gateway below is a stub, but a route is only offered while its keys are present, and CI has
// none. Read at import, so set before the payment modules load. Nothing can reach NotchPay with these.
process.env.NOTCHPAY_PUBLIC_KEY ||= 'verify-stub';
process.env.NOTCHPAY_PRIVATE_KEY ||= 'verify-stub';
process.env.NOTCHPAY_WEBHOOK_SECRET ||= 'verify-stub';
import mongoose, { Types } from 'mongoose';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import { Booking, IBooking } from '../../src/modules/booking/models/booking.model';
import { BookingService } from '../../src/modules/booking/services/booking.service';
import { amountPaidOf, outstandingTopup, unpaidSweepFilter } from '../../src/modules/booking/domain/price-proposal';
import { toBotBookingDto } from '../../src/modules/bot-surface/dto/bot-projections';
import { inAppSurfaceStore } from '../../src/modules/bot-surface/services/inapp-surface.store';
import { answerPriceFromList, readCustomerBookings } from '../../src/modules/bot-surface/miniapp/surfaces/booking.core';
import { computeAppointmentAccess, toCustomerBookingShape } from '../../src/modules/booking/domain/appointment';
import { CompletionPricingService } from '../../src/modules/catalog/domain/services/booking/CompletionPricingService';
import { CustomerNotificationModel } from '../../src/modules/notifications/models/customer-notification.model';
import { VendorNotificationModel } from '../../src/modules/notifications/models/vendor-notification.model';
import { CustomerNotificationPreferenceModel } from '../../src/modules/notifications/models/customer-notification-preference.model';
import { VendorNotificationPreferenceModel } from '../../src/modules/notifications/models/vendor-notification-preference.model';
import { getCustomerNotificationHandler, initializeCustomerNotificationEventConsumers } from '../../src/modules/notifications/customer-notification-event-consumer';
import { CalendarClientFactory } from '../../src/modules/integrations/calendar/calendar-client.factory';
import { initializeVendorNotificationEventConsumers } from '../../src/modules/notifications/vendor-notification-event-consumer';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { PricingPlanModel } from '../../src/modules/billing/models/pricing-plan.model';
import { PaymentTransactionModel } from '../../src/modules/payments/models/payment-transaction.model';
import { RefundRequestModel } from '../../src/modules/payments/models/refund-request.model';
import { RefundTransactionModel } from '../../src/modules/payments/models/refund-transaction.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { PAYMENT_GATEWAYS } from '../../src/modules/payments/gateways/registry';
import {
    __resetPaymentSettingsCacheForTests,
    __setPaymentSettingsStoreForTests,
} from '../../src/modules/payments/services/payment-settings.service';
import { DEFAULT_PAYMENT_SETTINGS } from '../../src/modules/payments/domain/payment-routing';
import { initializeRefundDomain } from '../../src/modules/payments/refund.bootstrap';
import { refundRequestService } from '../../src/modules/payments/services/refund-request.service';
import { PaymentOrchestratorService } from '../../src/modules/payments/services/payment-orchestrator.service';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';
/**
 * Earnings ledgers and accounts cannot be told apart from anyone else's by a cleanup, and later CI
 * suites count those rows, so in CI this runs in a sibling database (the partial-payment suite's rule).
 */
const DB_NAME = process.env.CI && !/verify/i.test(MONGO_URI) ? 'verify_price_proposal_ci' : undefined;

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
    try { await fn(); console.error(`      expected ${code}, nothing was refused`); return false; } catch (err) {
        const got = (err as { code?: string }).code;
        if (got !== code) console.error(`      expected ${code}, got ${got}: ${(err as Error).message}`);
        return got === code;
    }
}

// ── Stubs: no money moves ────────────────────────────────────────────────────

const charged: number[] = [];
for (const gateway of (PAYMENT_GATEWAYS as unknown as Map<string, any>).values()) {
    gateway.initiatePayment = async (p: { amount: number }) => {
        charged.push(p.amount);
        return { success: true, gatewayRef: `chg_${charged.length}`, status: 'PENDING', rawResponse: {}, instructions: null };
    };
    gateway.payoutAvailable = () => true;
    gateway.payoutBalance = async () => null;
    gateway.createPayout = async () => ({ success: true, gatewayRef: `trf_${Date.now()}`, status: 'PENDING' });
}
__setPaymentSettingsStoreForTests({
    ready: () => true,
    read: async () => null,
    create: async () => { throw new Error('read-only stub'); },
    compareAndSet: async () => null,
});
__resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);
initializeRefundDomain();

// ── The world ────────────────────────────────────────────────────────────────

const oid = () => new Types.ObjectId();
const userId = oid();
const customerId = oid();
const vendorId = oid();
const vendorUserId = oid();
const productId = oid();
const bookingIds: Types.ObjectId[] = [];
const PHONE = '+237670000001';

const service = new BookingService();
const orchestrator = new PaymentOrchestratorService();
const col = (name: string) => mongoose.connection.db!.collection(name);
const V = () => vendorId.toString();
const U = () => userId.toString();

async function aBooking(overrides: Record<string, unknown> = {}): Promise<string> {
    const _id = oid();
    bookingIds.push(_id);
    const startAt = new Date(Date.now() + 5 * 86_400_000);
    await col(Booking.collection.name).insertOne({
        _id,
        bookingNumber: `BKG-PRICE-${_id.toString().slice(-6)}`,
        productId,
        userId,
        vendorId,
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        status: BookingStatus.PENDING,
        paymentStatus: 'unpaid',
        priceSnapshot: 5000,
        originalPrice: 5000,
        bookingMode: 'manual',
        currency: 'XAF',
        requiresPayment: true,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    });
    return _id.toString();
}
const load = async (id: string) => (await Booking.findById(id)) as IBooking;
const successOf = (tx: unknown) => (orchestrator as any).handleBookingPaymentSuccess(tx);

/** A first payment that really went through: a succeeded row, credited by the real handler. */
async function payFirst(id: string, amount: number): Promise<void> {
    const tx = await PaymentTransactionModel.create({
        bookingId: new Types.ObjectId(id),
        userId,
        gateway: 'NOTCHPAY',
        provider: 'MTN',
        method: 'MOBILE',
        status: 'SUCCEEDED',
        purpose: 'primary',
        gatewayRef: `np_${oid().toHexString()}`,
        amountSnapshot: amount,
        currencySnapshot: 'XAF',
        idempotencyKey: `verify-price-${oid().toHexString()}`,
        merchantRef: `pt_${oid().toHexString()}`,
        payer: { phone: PHONE, name: 'Amina' },
        rawGatewayPayloads: [],
    } as never);
    await successOf(tx);
}

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000, ...(DB_NAME ? { dbName: DB_NAME } : {}) });
    // Collections cannot be created inside a transaction on a fresh database.
    for (const model of Object.values(mongoose.models)) {
        await model.createCollection().catch(() => undefined);
        await model.init().catch(() => undefined);
    }
    // Every money path resolves a pricing plan, and CI seeds them into the database this one left.
    if (DB_NAME) {
        const seeded = mongoose.connection.useDb(new URL(MONGO_URI).pathname.slice(1));
        const plans = await seeded.collection(PricingPlanModel.collection.name).find().toArray();
        for (const plan of plans) await PricingPlanModel.collection.replaceOne({ _id: plan._id }, plan, { upsert: true });
    }
    // The real subscriptions: the notifications below are what the customer and vendor would get.
    initializeCustomerNotificationEventConsumers();
    initializeVendorNotificationEventConsumers();

    await col(CustomerModel.collection.name).insertOne({ _id: customerId, user_id: userId, name: 'Amina', timezone: 'Africa/Douala', preferences: { language: 'en' } });
    await col(VendorModel.collection.name).insertOne({ _id: vendorId, user_id: vendorUserId, display_name: 'Salon Amina', timezone: 'Africa/Douala', preferences: { language: 'en' }, deletedAt: null });
    await col(ProductModel.collection.name).insertOne({ _id: productId, title: 'Box braids' });

    console.log('\nthe owner\'s example: 7,000, 6,000, 5,500 — never below 5,000');
    const haggle = await aBooking();
    await assert('below the floor is refused', () => refusedWith('BOOKING_PRICE_BELOW_FLOOR', () => service.proposePrice(haggle, V(), 4000)));
    await assert('the floor itself is refused: confirming gets that', () => refusedWith('BOOKING_PRICE_BELOW_FLOOR', () => service.proposePrice(haggle, V(), 5000)));
    await service.proposePrice(haggle, V(), 7000);
    await assert('one proposal at a time', () => refusedWith('BOOKING_PRICE_NOT_PROPOSABLE', () => service.proposePrice(haggle, V(), 8000)));
    await assert('⛔ the vendor cannot confirm over their own proposal', () =>
        refusedWith('BOOKING_PRICE_PROPOSAL_OPEN', () => service.updateBookingStatus(haggle, V(), BookingStatus.CONFIRMED)));
    await assert('another shop gets a 404', () => refusedWith('BOOKING_NOT_FOUND', () => service.proposePrice(haggle, oid().toString(), 9000)));
    await assert('another customer gets a 404', () => refusedWith('BOOKING_NOT_FOUND', () => service.answerPriceProposal(haggle, oid().toString(), 'accept')));
    await service.answerPriceProposal(haggle, U(), 'decline');
    await assert('declining changes nothing: still waiting, still 5,000', async () => {
        const b = await load(haggle);
        return b.status === BookingStatus.PENDING && b.priceSnapshot === 5000 && b.priceProposal?.status === 'declined';
    });
    await service.proposePrice(haggle, V(), 6000);
    await service.answerPriceProposal(haggle, U(), 'decline');
    await service.proposePrice(haggle, V(), 5500);
    await assert('a third proposal is fine, and still names 5,000 as the floor', async () => {
        const b = await load(haggle);
        return b.priceProposal?.amount === 5500 && b.originalPrice === 5000;
    });
    await service.withdrawPriceProposal(haggle, V());
    await assert('withdrawing twice finds nothing', () => refusedWith('BOOKING_PRICE_PROPOSAL_NOT_FOUND', () => service.withdrawPriceProposal(haggle, V())));
    const confirmed = await service.updateBookingStatus(haggle, V(), BookingStatus.CONFIRMED);
    await assert('with no proposal open the vendor may confirm at the original price (P-5)', () =>
        confirmed.status === BookingStatus.CONFIRMED && confirmed.priceSnapshot === 5000);
    await assert('⛔ after approval the price cannot be proposed on its own', () =>
        refusedWith('BOOKING_PRICE_NOT_PROPOSABLE', () => service.proposePrice(haggle, V(), 9000)));

    console.log('\nwho cannot be proposed on');
    const calendar = await aBooking({ bookingMode: 'calendar' });
    await assert('a calendar service', () => refusedWith('BOOKING_PRICE_NOT_PROPOSABLE', () => service.proposePrice(calendar, V(), 7000)));
    const legacy = await aBooking({ bookingMode: undefined, originalPrice: undefined });
    await assert('a legacy booking whose service cannot be read is not assumed manual', () =>
        refusedWith('BOOKING_PRICE_NOT_PROPOSABLE', () => service.proposePrice(legacy, V(), 7000)));
    const free = await aBooking({ requiresPayment: false, priceSnapshot: 0, originalPrice: 0, paymentStatus: 'paid' });
    await assert('⛔ a free service stays free (P-7)', () => refusedWith('BOOKING_PRICE_NOT_PROPOSABLE', () => service.proposePrice(free, V(), 7000)));

    console.log('\nunpaid, accepted');
    const unpaid = await aBooking();
    await service.proposePrice(unpaid, V(), 7000);
    const [askedOf] = await CustomerNotificationModel.find({ aggregateId: unpaid, type: 'booking.price_proposed' }).lean();
    await assert('the customer is asked, with both prices and a readable time', () => {
        const message = String(askedOf?.message);
        console.log(`      "${message}"`);
        return message.includes('7,000') && message.includes('5,000') && message.includes('Salon Amina') && !message.includes('GMT') && !message.includes('{{');
    });
    const results = await Promise.allSettled([
        service.answerPriceProposal(unpaid, U(), 'accept'),
        service.answerPriceProposal(unpaid, U(), 'accept'),
    ]);
    await assert('⛔ two taps: one wins', () => results.filter((r) => r.status === 'fulfilled').length === 1);
    const accepted = await load(unpaid);
    await assert('⛔ accepting confirms at the new price, with the floor kept (P-1)', () =>
        accepted.status === BookingStatus.CONFIRMED && accepted.priceSnapshot === 7000 && accepted.originalPrice === 5000);
    await assert('the customer is the one recorded as having confirmed it', () =>
        accepted.statusHistory?.at(-1)?.actorRole === 'customer');
    await assert('⛔ the payment clock starts now, and nothing is owed as a difference', () =>
        !!accepted.paymentDueFrom && !accepted.priceTopup);
    await assert('the agreed change is on the record', () =>
        accepted.priceHistory?.length === 1 && accepted.priceHistory[0].from === 5000 && accepted.priceHistory[0].to === 7000);
    await assert('the vendor is told', async () => {
        const [note] = await VendorNotificationModel.find({ aggregateId: unpaid, type: 'booking.price_accepted' }).lean();
        console.log(`      "${note?.message}"`);
        return String(note?.message).includes('7,000') && String(note?.message).includes('Amina');
    });
    await assert('the customer is asked to pay the whole 7,000', async () => {
        const [note] = await CustomerNotificationModel.find({ aggregateId: unpaid, type: 'booking.price_topup_due' }).lean();
        console.log(`      "${note?.message}"`);
        return String(note?.message).includes('7,000') && !String(note?.message).includes('GMT');
    });
    await assert('the raw fields are not in the serialised booking, and the customer\'s block is', () => {
        const plain = accepted.toJSON() as Record<string, unknown>;
        const shaped = toCustomerBookingShape(plain, accepted as never);
        return !('priceHistory' in plain) && !('originalPrice' in plain)
            && shaped.pricing.originalPrice === 5000 && shaped.pricing.currentPrice === 7000 && shaped.pricing.amountPaid === 0;
    });

    console.log('\npaid 5,000 first, then accepted 7,000');
    const paidFirst = await aBooking();
    await payFirst(paidFirst, 5000);
    await service.proposePrice(paidFirst, V(), 7000);
    const liveAttempt = await PaymentTransactionModel.create({
        bookingId: new Types.ObjectId(paidFirst), userId, gateway: 'NOTCHPAY', method: 'MOBILE', status: 'PENDING', purpose: 'primary',
        gatewayRef: 'x', amountSnapshot: 1, currencySnapshot: 'XAF', idempotencyKey: `verify-live-${oid().toHexString()}`,
        merchantRef: `pt_${oid().toHexString()}`, rawGatewayPayloads: [],
    } as never);
    await assert('⛔ a price does not move under a charge in flight', () =>
        refusedWith('PAYMENT_BOOKING_IN_PROGRESS', () => service.answerPriceProposal(paidFirst, U(), 'accept')));
    await PaymentTransactionModel.deleteOne({ _id: (liveAttempt as unknown as { _id: unknown })._id });
    await service.answerPriceProposal(paidFirst, U(), 'accept');
    const owing = await load(paidFirst);
    await assert('⛔ 2,000 is owed, and the booking stays paid', () =>
        owing.paymentStatus === 'paid' && owing.priceTopup?.status === 'due' && owing.priceTopup.amount === 2000 && amountPaidOf(owing) === 5000);
    await assert('⛔ the meeting link is locked until it is paid', () =>
        computeAppointmentAccess({
            ...owing.toObject(),
            startAt: new Date(Date.now() + 60_000),
            endAt: new Date(Date.now() + 3_600_000),
            access: { instructions: null, meetingUrl: 'https://meet.example/x', revealMinutesBefore: 30 },
        } as never)?.reason === 'not_paid');
    const { transactionId } = await orchestrator.initiateBookingBalancePayment(paidFirst, { provider: 'MTN' } as never, { phoneNumber: PHONE } as never);
    const firstAttempt = await PaymentTransactionModel.findById(transactionId);
    await assert('⛔ exactly 2,000 is charged, marked as this difference', () =>
        firstAttempt?.amountSnapshot === 2000 && firstAttempt.purpose === 'booking_balance' && firstAttempt.bookingTopupSeq === 1);
    await assert('…and pressing Pay again answers with the same attempt', async () => {
        const again = await orchestrator.initiateBookingBalancePayment(paidFirst, { provider: 'MTN' } as never, { phoneNumber: PHONE } as never);
        return again.transactionId === transactionId;
    });
    await PaymentTransactionModel.updateOne({ _id: transactionId }, { $set: { status: 'SUCCEEDED' } });
    const settledAttempt = await PaymentTransactionModel.findById(transactionId);
    await successOf(settledAttempt);
    await successOf(settledAttempt);
    const square = await load(paidFirst);
    await assert('the difference is credited', () =>
        square.priceTopup?.status === 'paid' && amountPaidOf(square) === 7000 && square.topupTransactionIds?.length === 1);
    const earningsOf = (sourceId: string) => EarningsAllocationModel.find({ source_type: 'booking', source_id: sourceId }).lean();
    await assert('⛔ the first payment was split on what it carried: 5,000', async () => {
        const rows = await earningsOf(paidFirst);
        return rows.length > 0 && rows.every((row) => row.gross_snapshot === 5000);
    });
    await assert('⛔ the difference is split once, under its own payment, and stays HELD', async () => {
        const rows = await earningsOf(String(transactionId));
        return rows.length > 0 && rows.length <= 2 && rows.every((row) => row.gross_snapshot === 2000 && row.hold_release_at === null);
    });

    console.log('\nrescheduled at a lower price: 6,000 after paying 7,000 (P-3)');
    const newStart = new Date(square.startAt.getTime() + 86_400_000);
    await col(Booking.collection.name).updateOne({ _id: square._id }, {
        $set: {
            rescheduleProposal: {
                status: 'open', proposedBy: 'vendor', slotId: 'unused', startAt: newStart, endAt: new Date(newStart.getTime() + 3_600_000),
                previousStartAt: square.startAt, previousEndAt: square.endAt, proposedAt: new Date(), expiresAt: square.startAt,
                answeredAt: null, price: 6000, previousPrice: 7000,
            },
        },
    });
    await service.answerRescheduleProposal(paidFirst, { role: 'customer', id: U() }, 'accept');
    const lowered = await load(paidFirst);
    await assert('the time and the price moved together', () =>
        lowered.startAt.getTime() === newStart.getTime() && lowered.priceSnapshot === 6000 && lowered.originalPrice === 5000 && lowered.priceHistory?.length === 2);
    await assert('⛔ the booking stays paid: the appointment is on', () => lowered.paymentStatus === 'paid');
    const refund = await RefundRequestModel.findOne({ source_kind: 'booking', source_id: lowered._id });
    await assert('⛔ 1,000 goes back, with the fees on the vendor', () =>
        refund?.gross_amount === 1000 && refund?.fees?.paid_by === 'vendor' && refund?.net_amount === 1000);
    await assert('the transfer is on its way, to the number that paid', () => refund?.status === 'sending');
    if (refund?.transfer_reference) {
        await refundRequestService.applyTransferOutcome(refund.transfer_reference, { settled: true, gatewayRef: 'trf_done', reason: null });
    }
    await assert('⛔ when it arrives the booking is still paid, not refunded', async () => (await load(paidFirst)).paymentStatus === 'paid');
    await assert('the ledger records 1,000', async () => {
        const row = await RefundTransactionModel.findOne({ bookingId: lowered._id, status: 'completed' }).lean();
        return row?.refundAmount === 1000;
    });

    console.log('\ncompletion (P-4)');
    const resolver = { resolvePrice: async (_p: unknown, w: { start: Date; end: Date }) => ({ amount: Math.round((w.end.getTime() - w.start.getTime()) / 60_000) * 100, breakdown: {} }) };
    const completion = new CompletionPricingService({ findByIdUnscoped: async () => ({}) } as never, resolver as never, service);
    await assert('⛔ a typed price is refused', () =>
        refusedWith('BOOKING_PRICE_LOCKED', () => completion.completeBooking(paidFirst, V(), { fixedPrice: 100 } as never)));
    const done = await completion.completeBooking(paidFirst, V(), {} as never);
    await assert('⛔ no extra time: the agreed 6,000, although the catalog says otherwise', () =>
        done.finalPrice === 6000 && done.additionalAmountDue === 0 && done.creditDue === 0);
    await assert('⛔ the paid difference starts its hold with the rest', async () => {
        const rows = await earningsOf(String(transactionId));
        return rows.length > 0 && rows.every((row) => row.hold_release_at !== null);
    });
    const overran = await aBooking();
    await payFirst(overran, 5000);
    await service.proposePrice(overran, V(), 7000);
    await service.answerPriceProposal(overran, U(), 'accept');
    const overrun = await completion.completeBooking(overran, V(), { additionalMinutes: 30 } as never);
    await assert('⛔ 30 extra minutes add their own cost, and the unpaid 2,000 joins the balance', () =>
        overrun.finalPrice === 10000 && overrun.additionalAmountDue === 5000);
    await assert('…so the difference is not owed twice', async () => (await load(overran)).priceTopup?.status === 'superseded');

    console.log('\nthe difference not paid in time (P-2)');
    const overdue = await aBooking();
    await payFirst(overdue, 5000);
    await service.proposePrice(overdue, V(), 7000);
    await service.answerPriceProposal(overdue, U(), 'accept');
    const swept = async (id: string) => {
        const cutoff = new Date(Date.now() - 86_400_000);
        return !!(await Booking.exists({ $and: [{ _id: id }, unpaidSweepFilter(new Date(), cutoff)] }));
    };
    await assert('inside the 24 hours it is left alone', async () => !(await swept(overdue)));
    await col(Booking.collection.name).updateOne({ _id: new Types.ObjectId(overdue) }, { $set: { 'priceTopup.dueAt': new Date(Date.now() - 1000) } });
    await assert('past them the sweep picks it up', () => swept(overdue));
    await service.cancelVendorBooking(overdue, V(), 'Automatically cancelled — payment was not completed in time', 'system');
    await assert('⛔ cancelled, and what was paid goes back', async () => {
        const b = await load(overdue);
        const opened = await RefundRequestModel.findOne({ source_kind: 'booking', source_id: b._id });
        return b.status === BookingStatus.CANCELLED && opened?.gross_amount === 5000;
    });
    await assert('a cancelled booking owes nothing more', async () => {
        const b = await load(overdue);
        return toCustomerBookingShape(b.toJSON() as Record<string, unknown>, b as never).pricing.topup === null;
    });
    await assert('⛔ …and neither /balance\'s figure nor the chat\'s says otherwise, though the record stays', async () => {
        const b = await load(overdue);
        return b.priceTopup?.status === 'due' && outstandingTopup(b) === 0 && toBotBookingDto(b as never).outstandingBalance === 0;
    });

    console.log('\nanswering from the mini-app list (owner, 2026-11-03)');
    const session = { owner: U(), language: 'en', customerId: customerId.toString(), channel: 'telegram', externalId: 'x' };
    const realRead = inAppSurfaceStore.read;
    (inAppSurfaceStore as any).read = async () => session;
    try {
        const onList = await aBooking();
        await payFirst(onList, 5000);
        await service.proposePrice(onList, V(), 7000);
        const drawn = await readCustomerBookings({ userId: U(), language: 'en' });
        const row = drawn.bookings.find((b) => b.bookingId === onList);
        await assert('the row asks the question with both prices, and says it is waiting on the customer', () => {
            console.log(`      "${row?.priceQuestion?.text}"`);
            return !!row?.priceQuestion?.text.includes('XAF 7,000') && !!row.priceQuestion.text.includes('XAF 5,000')
                && row.status === BookingStatus.PENDING && !!row.statusLabel?.includes('New price');
        });
        await assert('another customer\'s booking is a 404', () => {
            (inAppSurfaceStore as any).read = async () => ({ ...session, owner: oid().toString() });
            return refusedWith('BOOKING_NOT_FOUND', () => answerPriceFromList('h', { bookingId: onList, answer: 'accept' }))
                .finally(() => { (inAppSurfaceStore as any).read = async () => session; });
        });
        await assert('an answer that is neither is refused', () =>
            refusedWith('VALIDATION_ERROR', () => answerPriceFromList('h', { bookingId: onList, answer: 'maybe' })));
        await answerPriceFromList('h', { bookingId: onList, answer: 'decline' });
        await assert('declining from the row changes nothing and ends the question', async () => {
            const b = await load(onList);
            return b.priceSnapshot === 5000 && b.status === BookingStatus.PENDING && b.priceProposal?.status === 'declined';
        });
        await service.proposePrice(onList, V(), 6500);
        const answered = await answerPriceFromList('h', { bookingId: onList, answer: 'accept' });
        await assert('⛔ accepting from the row confirms at that price, and leaves the difference to pay on the same row', async () => {
            const b = await load(onList);
            const again = await readCustomerBookings({ userId: U(), language: 'en' });
            const redrawn = again.bookings.find((r) => r.bookingId === onList);
            return b.status === BookingStatus.CONFIRMED && b.priceSnapshot === 6500 && b.priceTopup?.amount === 1500
                && redrawn?.payable === 'balance' && redrawn.priceQuestion === null && answered.message.length > 0;
        });
        await assert('a second tap finds nothing open', () =>
            refusedWith('BOOKING_PRICE_PROPOSAL_NOT_FOUND', () => answerPriceFromList('h', { bookingId: onList, answer: 'accept' })));
    } finally {
        (inAppSurfaceStore as any).read = realRead;
    }

    console.log('\nthe unpaid clock');
    const slow = await aBooking({ createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await assert('a booking still waiting on the vendor is never swept', async () => !(await swept(slow)));
    await service.updateBookingStatus(slow, V(), BookingStatus.CONFIRMED);
    await assert('⛔ accepted three days after it was made, it is NOT cancelled on the next sweep', async () => !(await swept(slow)));
    const instant = await aBooking({ status: BookingStatus.CONFIRMED, createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await assert('one confirmed at creation and unpaid for days still is', () => swept(instant));

    console.log('\nthe vendor\'s calendar follows the agreed price');
    const calendarCalls: Array<{ kind: string; title?: string; description?: string }> = [];
    const realForVendor = CalendarClientFactory.forVendor;
    (CalendarClientFactory as any).forVendor = async () => ({
        createEvent: async (e: { title: string; description: string }) => {
            calendarCalls.push({ kind: 'create', title: e.title, description: e.description });
            return { externalId: `evt_${calendarCalls.length}` };
        },
        updateEvent: async (_id: string, e: { title: string; description: string }) => {
            calendarCalls.push({ kind: 'update', title: e.title, description: e.description });
            return {};
        },
    });
    try {
        const onCalendar = await aBooking();
        await payFirst(onCalendar, 5000);
        await service.proposePrice(onCalendar, V(), 7000);
        await service.answerPriceProposal(onCalendar, U(), 'accept');
        const created = calendarCalls.find((c) => c.kind === 'create');
        await assert('⛔ the event written on approval carries the agreed price, and a paid booking is not called unpaid', () =>
            !!created?.description?.includes('Price: 7000 ') && !!created?.title?.startsWith('[PAID]'));

        const moving = await load(onCalendar);
        const movedTo = new Date(moving.startAt.getTime() + 86_400_000);
        await col(Booking.collection.name).updateOne({ _id: moving._id }, {
            $set: {
                'priceTopup.status': 'superseded',
                rescheduleProposal: {
                    status: 'open', proposedBy: 'vendor', slotId: 'unused', startAt: movedTo, endAt: new Date(movedTo.getTime() + 3_600_000),
                    previousStartAt: moving.startAt, previousEndAt: moving.endAt, proposedAt: new Date(), expiresAt: moving.startAt,
                    answeredAt: null, price: 8000, previousPrice: 7000,
                },
            },
        });
        calendarCalls.length = 0;
        await service.answerRescheduleProposal(onCalendar, { role: 'customer', id: U() }, 'accept');
        const updated = calendarCalls.find((c) => c.kind === 'update');
        await assert('⛔ the event rewritten on a priced reschedule carries the NEW price', () =>
            !!updated?.description?.includes('Price: 8000 ') && !!updated?.title?.startsWith('[PAID]'));
    } finally {
        (CalendarClientFactory as any).forVendor = realForVendor;
    }

    console.log('\nevery payment gets its own receipt');
    const receipts = await aBooking({ status: BookingStatus.CONFIRMED, paymentStatus: 'paid' });
    const handler = getCustomerNotificationHandler();
    const receiptFor = (paymentId: string) => handler.handleBookingPaymentReceived({
        eventType: 'payment.received.partial',
        aggregateId: receipts,
        occurredAt: new Date(),
        payload: { aggregateType: 'booking', bookingId: receipts, userId: U(), purpose: 'booking_balance', paymentId, amount: 1000, currency: 'XAF' },
    } as never);
    await receiptFor('payment-one');
    await receiptFor('payment-two');
    await receiptFor('payment-two');
    await assert('⛔ two payments, two receipts, and a repeat of the second is not a third', async () =>
        (await CustomerNotificationModel.countDocuments({ aggregateId: receipts, type: 'booking.balance.received' })) === 2);

    console.log('\nthe customer asks to move, and the vendor answers with a price (P-6)');
    const asks = await aBooking({ status: BookingStatus.CONFIRMED, paymentDueFrom: new Date() });
    const asked = await load(asks);
    const askedStart = new Date(asked.startAt.getTime() + 86_400_000);
    await col(Booking.collection.name).updateOne({ _id: asked._id }, {
        $set: {
            rescheduleProposal: {
                status: 'open', proposedBy: 'customer', slotId: 'unused', startAt: askedStart, endAt: new Date(askedStart.getTime() + 3_600_000),
                previousStartAt: asked.startAt, previousEndAt: asked.endAt, proposedAt: new Date(), expiresAt: asked.startAt,
                answeredAt: null, price: null, previousPrice: null,
            },
        },
    });
    await assert('below the floor is refused', () =>
        refusedWith('BOOKING_PRICE_BELOW_FLOOR', () => service.answerRescheduleProposal(asks, { role: 'vendor', id: V() }, 'accept', { price: 4000 })));
    const flipped = await service.answerRescheduleProposal(asks, { role: 'vendor', id: V() }, 'accept', { price: 8000 });
    await assert('⛔ nothing moved: it is now the vendor\'s proposal, for the customer to answer', () =>
        flipped.startAt.getTime() === asked.startAt.getTime() && flipped.priceSnapshot === 5000
        && flipped.rescheduleProposal?.proposedBy === 'vendor' && flipped.rescheduleProposal?.price === 8000 && flipped.rescheduleProposal?.status === 'open');
    await assert('the customer is asked about both', async () => {
        const [note] = await CustomerNotificationModel.find({ aggregateId: asks, type: 'booking.reschedule_price_proposed' }).lean();
        console.log(`      "${note?.message}"`);
        return String(note?.message).includes('8,000') && !String(note?.message).includes('GMT');
    });
    await service.answerRescheduleProposal(asks, { role: 'customer', id: U() }, 'decline');
    await assert('⛔ refused: the time and the price stay', async () => {
        const b = await load(asks);
        return b.priceSnapshot === 5000 && b.startAt.getTime() === asked.startAt.getTime() && b.rescheduleProposal?.status === 'declined';
    });

    console.log('\ncash');
    const cash = await aBooking();
    await service.proposePrice(cash, V(), 7000);
    await service.answerPriceProposal(cash, U(), 'accept');
    await service.markAsPaidByCash(cash, V());
    await assert('cash marked after the agreement covers the agreed price', async () => amountPaidOf(await load(cash)) === 7000);
    const cash2 = await aBooking({ status: BookingStatus.PENDING });
    await service.markAsPaidByCash(cash2, V());
    await service.proposePrice(cash2, V(), 7000);
    await service.answerPriceProposal(cash2, U(), 'accept');
    await assert('a part-payment short of the difference is refused', () =>
        refusedWith('VALIDATION_ERROR', () => service.settleBalanceByCash(cash2, V(), 500)));
    await service.settleBalanceByCash(cash2, V());
    await assert('the difference collected at the counter is recorded', async () => {
        const b = await load(cash2);
        return b.priceTopup?.status === 'paid' && b.priceTopup.method === 'cash' && amountPaidOf(b) === 7000;
    });
}

async function cleanup(): Promise<void> {
    if (mongoose.connection.readyState !== 1) return;
    if (DB_NAME) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
        return;
    }
    const txs = await PaymentTransactionModel.find({ bookingId: { $in: bookingIds } }).select('_id').lean();
    const sources = [...bookingIds, ...txs.map((t) => t._id as Types.ObjectId)];
    await Promise.allSettled([
        col(Booking.collection.name).deleteMany({ _id: { $in: bookingIds } }),
        PaymentTransactionModel.deleteMany({ bookingId: { $in: bookingIds } }),
        RefundRequestModel.deleteMany({ source_id: { $in: bookingIds } }),
        RefundTransactionModel.deleteMany({ bookingId: { $in: bookingIds } }),
        EarningsAllocationModel.deleteMany({ source_id: { $in: sources } }),
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
