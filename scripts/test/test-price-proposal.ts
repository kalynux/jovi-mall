/**
 * A vendor's proposal of a price on a manual appointment (BOOKING-PRICE-PROPOSAL-PLAN, 2026-11-03).
 *
 *   §1  the floor — what the customer booked at, and never below it;
 *   §2  who may propose, and when;
 *   §3  the money — what moving the agreed price means for what was paid;
 *   §4  the unpaid sweep — its clock starts at confirmation, and it reaches an unpaid difference;
 *   §5  completion — a manual price cannot be typed, only extra time added (P-4);
 *   §6  what must stay wired — source scans, because each of these is one line a refactor loses.
 *       `verify:price-proposal` runs the same lifecycle against a real database.
 *
 * Offline: no database, no server. Run: npm run test:price-proposal
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { BookingStatus } from '../../src/modules/booking/types/booking.types';
import {
    amountPaidOf,
    effectivePriceProposalStatus,
    hasLivePriceProposal,
    IPriceProposal,
    IPriceTopup,
    manualFinalPrice,
    outstandingTopup,
    PriceFacts,
    priceBelowFloor,
    priceChangeEffect,
    priceFloorOf,
    priceProposalRefusal,
    pricingView,
    unpaidSweepFilter,
    vendorPricingView,
} from '../../src/modules/booking/domain/price-proposal';
import { computeAppointmentAccess, customerAppointmentFields } from '../../src/modules/booking/domain/appointment';
import { vendorPriceProposalWaivesPolicy } from '../../src/modules/booking/domain/reschedule-proposal';
import { bookingPayable, payPurposeOrRefuse } from '../../src/modules/bot-surface/miniapp/surfaces/booking-rows';

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
const START = new Date('2026-11-10T10:00:00Z');
const waiting: PriceFacts = {
    status: BookingStatus.PENDING,
    startAt: START,
    priceSnapshot: 5000,
    originalPrice: 5000,
    requiresPayment: true,
    paymentStatus: 'unpaid',
};
const openProposal: IPriceProposal = {
    status: 'open', amount: 7000, previousAmount: 5000, proposedAt: NOW, expiresAt: START, answeredAt: null,
};
const dueTopup: IPriceTopup = {
    status: 'due', amount: 2000, dueAt: new Date('2026-11-04T10:00:00Z'), seq: 1, paidAt: null, method: null,
};

console.log('\n§1 the floor');
assert('the owner\'s example: 7,000, then 6,000, then 5,500 are all allowed on a 5,000 booking', () =>
    [7000, 6000, 5500].every((price) => !priceBelowFloor(waiting, price, 'approval')));
assert('⛔ and nothing below 5,000 ever is', () =>
    priceBelowFloor(waiting, 4999, 'approval') && priceBelowFloor(waiting, 4999, 'reschedule'));
assert('the floor itself is not a proposal before approval: confirming gets the vendor that', () =>
    priceBelowFloor(waiting, 5000, 'approval'));
assert('on a reschedule an agreed 7,000 may come back down to the 5,000 booked', () =>
    !priceBelowFloor({ originalPrice: 5000, priceSnapshot: 7000 }, 5000, 'reschedule'));
assert('⛔ the floor stays the ORIGINAL price however the agreed price moves', () =>
    priceFloorOf({ originalPrice: 5000, priceSnapshot: 7000 }) === 5000);
assert('a booking whose price never moved has its price as its floor', () =>
    priceFloorOf({ originalPrice: undefined, priceSnapshot: 5000 }) === 5000);

console.log('\n§2 who may propose, and when');
assert('a waiting manual booking may be proposed on', () => priceProposalRefusal(waiting, 'manual', NOW) === null);
for (const mode of ['calendar', 'capacity', null, undefined]) {
    assert(`mode ${mode} is refused`, () => priceProposalRefusal(waiting, mode, NOW) === 'not_manual');
}
assert('⛔ free stays free (P-7)', () =>
    priceProposalRefusal({ ...waiting, requiresPayment: false }, 'manual', NOW) === 'free'
    && priceProposalRefusal({ ...waiting, priceSnapshot: 0 }, 'manual', NOW) === 'free');
assert('⛔ after approval the price cannot be proposed on its own', () =>
    priceProposalRefusal({ ...waiting, status: BookingStatus.CONFIRMED }, 'manual', NOW) === 'not_pending');
assert('an appointment already started is refused', () =>
    priceProposalRefusal({ ...waiting, startAt: NOW }, 'manual', NOW) === 'started');
assert('one proposal at a time', () =>
    priceProposalRefusal({ ...waiting, priceProposal: openProposal }, 'manual', NOW) === 'proposal_open');
assert('after a decline the vendor may propose again', () =>
    priceProposalRefusal({ ...waiting, priceProposal: { ...openProposal, status: 'declined' } }, 'manual', NOW) === null);
for (const paymentStatus of ['pending', 'refund_pending', 'disputed', 'refunded']) {
    assert(`not while the payment is ${paymentStatus}`, () =>
        priceProposalRefusal({ ...waiting, paymentStatus }, 'manual', NOW) === 'payment_state');
}
assert('an unanswered proposal lapses at the appointment\'s start', () =>
    effectivePriceProposalStatus(openProposal, new Date(START.getTime() - 1)) === 'open'
    && effectivePriceProposalStatus(openProposal, START) === 'lapsed');
assert('a proposal only lives on a booking still waiting', () =>
    hasLivePriceProposal({ ...waiting, priceProposal: openProposal }, NOW)
    && !hasLivePriceProposal({ ...waiting, status: BookingStatus.CANCELLED, priceProposal: openProposal }, NOW));
assert('the vendor\'s read says whether a proposal may be made', () =>
    vendorPricingView(waiting, 'manual', NOW).canPropose === true
    && vendorPricingView({ ...waiting, priceProposal: openProposal }, 'manual', NOW).canPropose === false);
assert('a customer who was asked for more may leave free of the policy while it waits (P-5)', () =>
    vendorPriceProposalWaivesPolicy({ status: 'pending', priceProposal: { status: 'declined' } })
    && !vendorPriceProposalWaivesPolicy({ status: 'pending', priceProposal: null })
    && !vendorPriceProposalWaivesPolicy({ status: 'confirmed', priceProposal: { status: 'accepted' } }));

console.log('\n§3 the money');
const paid = { paymentStatus: 'paid', priceSnapshot: 5000, priceTopup: null };
assert('unpaid: nothing to reconcile, the first charge simply uses the new price', () =>
    priceChangeEffect({ paymentStatus: 'unpaid', priceSnapshot: 5000 }, 7000).kind === 'none');
assert('paid 5,000 and agreed 7,000: 2,000 to pay', () => {
    const effect = priceChangeEffect(paid, 7000);
    return effect.kind === 'topup' && effect.amount === 2000;
});
assert('paid 7,000 and agreed 6,000: 1,000 back (P-3)', () => {
    const effect = priceChangeEffect({ paymentStatus: 'paid', priceSnapshot: 7000 }, 6000);
    return effect.kind === 'refund' && effect.amount === 1000;
});
assert('⛔ a difference still owed is not money paid: paid 5,000 of 7,000, agreed 8,000 owes 3,000', () => {
    const effect = priceChangeEffect({ paymentStatus: 'paid', priceSnapshot: 7000, priceTopup: dueTopup }, 8000);
    return effect.kind === 'topup' && effect.amount === 3000;
});
assert('⛔ paid 5,000 of 7,000, agreed 6,000 owes 1,000 rather than refunding anything', () => {
    const effect = priceChangeEffect({ paymentStatus: 'paid', priceSnapshot: 7000, priceTopup: dueTopup }, 6000);
    return effect.kind === 'topup' && effect.amount === 1000;
});
assert('paid 5,000 of 7,000, back to 5,000: square', () =>
    priceChangeEffect({ paymentStatus: 'paid', priceSnapshot: 7000, priceTopup: dueTopup }, 5000).kind === 'none');
assert('what was paid is the agreed price minus what is still owed', () =>
    amountPaidOf({ paymentStatus: 'paid', priceSnapshot: 7000, priceTopup: dueTopup }) === 5000
    && amountPaidOf({ paymentStatus: 'paid', priceSnapshot: 7000, priceTopup: { ...dueTopup, status: 'paid' } }) === 7000
    && amountPaidOf({ paymentStatus: 'unpaid', priceSnapshot: 7000 }) === 0);
assert('only a difference still `due` is owed', () =>
    outstandingTopup({ priceTopup: dueTopup }) === 2000
    && outstandingTopup({ priceTopup: { ...dueTopup, status: 'superseded' } }) === 0
    && outstandingTopup({}) === 0);
assert('the customer\'s read says all of it', () => {
    const view = pricingView({ ...waiting, status: BookingStatus.CONFIRMED, priceSnapshot: 7000, paymentStatus: 'paid', priceTopup: dueTopup }, NOW);
    return view.originalPrice === 5000 && view.currentPrice === 7000 && view.amountPaid === 5000 && view.topup?.amount === 2000;
});
assert('a cancelled booking owes nothing, whatever was due', () =>
    pricingView({ ...waiting, status: BookingStatus.CANCELLED, paymentStatus: 'paid', priceTopup: dueTopup }, NOW).topup === null);
assert('every customer door gets the block, through `customerAppointmentFields`', () => {
    const fields = customerAppointmentFields({
        ...waiting, endAt: START, priceProposal: openProposal,
    }, NOW);
    return fields.pricing.proposal?.amount === 7000 && fields.pricing.originalPrice === 5000;
});
assert('⛔ …and from a document, whose fields live behind getters and do not survive a spread', () => {
    class DocumentLike {
        readonly stored = { ...waiting, endAt: START, originalPrice: 5000, priceSnapshot: 7000, priceProposal: openProposal };
        get status() { return this.stored.status; }
        get startAt() { return this.stored.startAt; }
        get endAt() { return this.stored.endAt; }
        get priceSnapshot() { return this.stored.priceSnapshot; }
        get originalPrice() { return this.stored.originalPrice; }
        get requiresPayment() { return this.stored.requiresPayment; }
        get paymentStatus() { return this.stored.paymentStatus; }
        get priceProposal() { return this.stored.priceProposal; }
    }
    const fields = customerAppointmentFields(new DocumentLike() as never, NOW);
    return fields.pricing.originalPrice === 5000 && fields.pricing.currentPrice === 7000 && fields.pricing.proposal?.amount === 7000;
});
assert('⛔ the meeting link stays locked while a difference is owed', () => {
    const facts = {
        status: BookingStatus.CONFIRMED, paymentStatus: 'paid', requiresPayment: true,
        startAt: new Date(NOW.getTime() + 60_000), endAt: START,
        access: { instructions: null, meetingUrl: 'https://meet.example/x', revealMinutesBefore: 30 },
    };
    return computeAppointmentAccess({ ...facts, priceTopup: dueTopup }, NOW)?.reason === 'not_paid'
        && computeAppointmentAccess({ ...facts, priceTopup: { ...dueTopup, status: 'paid' } }, NOW)?.state === 'open';
});
const payable = {
    status: BookingStatus.CONFIRMED, paymentStatus: 'paid', requiresPayment: true, settlement: undefined, startAt: START,
} as Parameters<typeof bookingPayable>[0];
assert('a difference is payable as a balance on a confirmed appointment', () =>
    bookingPayable({ ...payable, priceTopup: dueTopup }) === 'balance'
    && payPurposeOrRefuse({ ...payable, priceTopup: dueTopup }) === 'balance'
    && bookingPayable(payable) === null);
assert('a cancelled booking is not payable, whatever was due', () =>
    bookingPayable({ ...payable, status: BookingStatus.CANCELLED, priceTopup: dueTopup }) === null);

console.log('\n§4 the unpaid sweep');
const cutoff = new Date(NOW.getTime() - 86_400_000);
const filter = unpaidSweepFilter(NOW, cutoff) as { status: string; deletedAt: null; $or: Array<Record<string, any>> };
assert('confirmed and live only: a booking waiting on the vendor is never swept', () =>
    filter.status === BookingStatus.CONFIRMED && filter.deletedAt === null);
assert('⛔ an unpaid booking\'s clock starts at confirmation, not creation', () => {
    const clock = filter.$or[0].$or as Array<Record<string, any>>;
    return clock[0].paymentDueFrom.$lte === cutoff && clock[1].paymentDueFrom === null && clock[1].createdAt.$lte === cutoff;
});
assert('…and a payment in flight is still left to resolve', () =>
    JSON.stringify(filter.$or[0].paymentStatus) === JSON.stringify({ $in: ['unpaid', 'failed'] }));
assert('⛔ an unpaid difference past its deadline is swept too (P-2)', () =>
    filter.$or[1]['priceTopup.status'] === 'due' && filter.$or[1]['priceTopup.dueAt'].$lte === NOW);

console.log('\n§5 completion');
assert('no extra time: the agreed price, not the catalog\'s', () => manualFinalPrice(7000, 5000, 5000) === 7000);
assert('⛔ extra time adds only what it costs', () => manualFinalPrice(7000, 7500, 5000) === 9500);
assert('⛔ finishing early never goes below the agreed price', () => manualFinalPrice(7000, 2500, 5000) === 7000);

console.log('\n§6 what must stay wired');
const SERVICE = code('booking/services/booking.service.ts');
const ORCHESTRATOR = code('payments/services/payment-orchestrator.service.ts');
const answer = SERVICE.split('async answerPriceProposal(')[1].split('async modeOf(')[0];
assert('⛔ the accept is one compare-and-set on the proposal, the price and the payment state', () =>
    answer.includes('Booking.findOneAndUpdate(')
    && answer.includes('priceSnapshot: booking.priceSnapshot, paymentStatus: booking.paymentStatus')
    && answer.includes("'priceProposal.status': 'open'"));
assert('⛔ accepting confirms through the one status path, so the calendar and events follow', () =>
    answer.includes('this.updateBookingStatus(') && answer.includes('BookingStatus.CONFIRMED'));
assert('⛔ a price never moves under a charge in flight, on either kind of accept', () =>
    answer.includes('this.assertNoChargeInFlight(booking)')
    && SERVICE.split('async answerRescheduleProposal(')[1].split('async proposePrice(')[0].includes('this.assertNoChargeInFlight(booking)'));
assert('the vendor cannot confirm over their own open proposal', () =>
    SERVICE.includes('newStatus === BookingStatus.CONFIRMED && hasLivePriceProposal(booking)')
    && SERVICE.includes('BOOKING_PRICE_PROPOSAL_OPEN'));
assert('⛔ confirmation starts the payment clock', () =>
    SERVICE.includes('if (newStatus === BookingStatus.CONFIRMED) booking.paymentDueFrom = new Date();'));
assert('⛔ only a shop can bring a price to a move', () =>
    SERVICE.includes("if (actor?.role !== 'vendor') {") && SERVICE.includes("reason: 'not_vendor'"));
assert('a vendor answering with a different price asks the customer rather than moving anything', () => {
    const body = SERVICE.split('async answerRescheduleProposal(')[1].split('let effect: PriceChangeEffect')[0];
    return body.includes("proposedBy: 'vendor'") && body.includes('this.emitRescheduleProposedEvent(booking)') && !body.includes('this.applyMove(');
});
assert('⛔ completing a paid-up appointment matures its paid differences too', () =>
    SERVICE.includes("for (const topupId of booking.topupTransactionIds ?? [])"));
assert('an administrator cannot complete over an unpaid difference', () =>
    SERVICE.split('async completeAsAdmin(')[1].split('async withdrawProposalAsAdmin(')[0].includes('outstandingTopup(booking) > 0'));

const COMPLETION = code('catalog/domain/services/booking/CompletionPricingService.ts');
assert('⛔ a typed price is refused on a manual service (P-4)', () =>
    COMPLETION.includes("isManual && input.fixedPrice !== undefined") && COMPLETION.includes('BOOKING_PRICE_LOCKED'));
assert('⛔ what was paid comes from the one rule, not from the agreed price', () =>
    COMPLETION.includes('const amountPaid = amountPaidOf(booking);'));
assert('a difference still owed becomes part of the balance, and is not owed twice', () =>
    COMPLETION.includes("booking.set({ 'priceTopup.status': 'superseded' })"));

assert('⛔ the difference is keyed by its sequence: a second one of the same amount is not "already paid"', () =>
    ORCHESTRATOR.includes('`${bookingId}:topup:${topup.seq}`'));
assert('⛔ the success handler tells a difference from a settlement balance', () =>
    ORCHESTRATOR.includes('this.handleBookingTopupSuccess(booking, transaction)')
    && ORCHESTRATOR.includes('...(topup ? { bookingTopupSeq: topup.seq } : {})'));
assert('⛔ crediting a difference is idempotent on the transaction', () =>
    /topupTransactionIds: \{ \$ne: transaction\._id \}/.test(ORCHESTRATOR));
assert('⛔ the first payment splits what it actually carried', () =>
    ORCHESTRATOR.includes('earningsSplitService.splitBooking(booking, transaction.amountSnapshot)'));
assert('⛔ a difference is refundable: it is a `booking_balance`, which the refund legs already read', () =>
    ORCHESTRATOR.includes("purpose: { $in: ['primary', 'booking_balance', null] }"));

const SPLIT = code('earnings/services/earnings-split.service.ts').split('async splitBookingTopup(')[1].split('async splitBookingBalance(')[0];
assert('⛔ a difference stays held until completion, unlike a balance', () =>
    SPLIT.includes("if (booking.status === 'completed')") && SPLIT.includes('source_id: transactionId'));

assert('⛔ every lookup from an earnings row back to its booking knows about differences', () => {
    const pause = code('earnings/services/earnings-pause.service.ts');
    return pause.includes('{ topupTransactionIds: allocation.source_id }')
        && pause.includes('topupTransactionIds ?? [])')
        && code('referrals/services/referral-reward.service.ts').includes('{ topupTransactionIds: row.source_id }');
});

const REFUND = code('booking/services/booking-refund.service.ts').split('async refundPriceDifference(')[1].split('private async flagRefundPending')[0];
assert('⛔ a lower price refunds the difference with the fees on the vendor (P-3)', () =>
    REFUND.includes('amount,') && REFUND.includes("feesPaidBy: 'vendor'") && REFUND.includes('approveNow: true'));
assert('⛔ …and leaves the booking `paid`, since the appointment is on', () => !REFUND.includes('flagRefundPending'));
assert('cash cannot be refunded by the engine: a person is told', () =>
    REFUND.includes("booking.paymentMethod !== 'cash'") && REFUND.includes('createSystemTicket'));

assert('both routes are mounted, and both customer answers', () => {
    const vendor = code('booking/routes/vendor-booking.routes.ts');
    const customer = code('booking/routes/customer-booking.routes.ts');
    return vendor.includes("router.post('/:id/price-proposal', VendorBookingController.proposePrice)")
        && vendor.includes("router.delete('/:id/price-proposal', VendorBookingController.withdrawPrice)")
        && customer.includes("router.post('/:id/price-proposal/accept', CustomerBookingController.acceptPrice)")
        && customer.includes("router.post('/:id/price-proposal/decline', CustomerBookingController.declinePrice)");
});
assert('⛔ the customer has no route that can name a price', () => {
    const controller = code('booking/controllers/customer-booking.controller.ts');
    return !controller.includes('proposePrice') && !/rescheduleBooking\([\s\S]{0,200}\{ price/.test(controller);
});
assert('the chat answers with its own buttons', () => {
    const bot = code('bot-surface/controllers/bot-booking.controller.ts');
    return bot.includes("'yes:bkprice':") && bot.includes("'no:bkprice':");
});
assert('the raw fields never reach a vendor or customer read', () => {
    const model = code('booking/models/booking.model.ts');
    return ['priceProposal', 'priceTopup', 'topupTransactionIds', 'priceHistory', 'originalPrice', 'paymentDueFrom']
        .every((field) => model.includes(`delete out.${field}`));
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
