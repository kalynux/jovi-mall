/**
 * Test: the earnings hold — when money starts maturing, how a pause stops the clock, and the
 * wiring that pauses money a seller should not receive (owner decisions, 2026-10-05).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. The first half asserts the pure rules in `earnings/domain/earnings-hold.ts`. The
 * second half is SOURCE SCANS, because what matters most here is wiring no behavioural test
 * without a database can see: that the release query skips paused rows, that the release
 * CLAIM does too, that a seller cancelling a paid order raises a refund ticket, and that the
 * splits inherit the delivery date rather than the completion date. Comments are stripped
 * before scanning, so a tombstone explaining old behaviour cannot satisfy or fail a scan.
 *
 * Run: npm run test:earnings-hold
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  COURIER_FINISHED_STATUSES,
  EARNINGS_PAUSE_REASONS,
  SELF_RESUMING_PAUSE_REASONS,
  deliveredAtOf,
  holdReleaseFrom,
  isCourierFinished,
  resumedHoldReleaseAt,
} from '../../src/modules/earnings/domain/earnings-hold';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const SRC = join(__dirname, '..', '..', 'src');
/** Source with block and line comments removed. */
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}
/** The body of a method, from its signature to the next method at the same indent (rough but enough). */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:async |private |protected |static |public )?[a-zA-Z_]+\s*(?:=|\()/);
  return next < 0 ? rest : rest.slice(0, next);
}

const DAY = 24 * 60 * 60 * 1000;
const at = (d: number, h = 0): Date => new Date(Date.UTC(2026, 9, d, h));

// ─── 1. A pause stops the clock; it never resets or shortens it ──────────────
console.log('\n1. resumedHoldReleaseAt');

assert('a hold that has not started is left alone (it starts normally later)', () =>
  resumedHoldReleaseAt({ completed_at: null, hold_release_at: null }, at(1), at(5)) === null);

assert('hold started BEFORE the pause → moved by the whole pause', () => {
  // started day 1, due day 4, paused day 2 → resumed day 6: 4 days lost → due day 8
  const r = resumedHoldReleaseAt({ completed_at: at(1), hold_release_at: at(4) }, at(2), at(6));
  return r?.getTime() === at(8).getTime();
});

assert('hold started DURING the pause → the full hold runs from the resume', () => {
  // paused day 1, delivered day 3 (due day 6), resumed day 5: 2 days lost → due day 8
  // = resume (day 5) + the 3-day hold. The paused time before delivery cost nothing.
  const r = resumedHoldReleaseAt({ completed_at: at(3), hold_release_at: at(6) }, at(1), at(5));
  return r?.getTime() === at(8).getTime();
});

assert('a zero-length pause moves nothing', () => {
  const r = resumedHoldReleaseAt({ completed_at: at(1), hold_release_at: at(4) }, at(2), at(2));
  return r?.getTime() === at(4).getTime();
});

assert('never earlier than before, even if the resume time is before the pause (clock skew)', () => {
  const r = resumedHoldReleaseAt({ completed_at: at(1), hold_release_at: at(4) }, at(3), at(2));
  return r!.getTime() >= at(4).getTime();
});

assert('a hold already due when paused stays due later by the paused time, never released early', () => {
  const r = resumedHoldReleaseAt({ completed_at: at(1), hold_release_at: at(4) }, at(5), at(7));
  return r?.getTime() === at(6).getTime();
});

// ─── 2. When the hold starts ─────────────────────────────────────────────────
console.log('\n2. The hold starts at delivery');

assert('holdReleaseFrom adds whole days', () =>
  holdReleaseFrom(at(1), 3).getTime() === at(1).getTime() + 3 * DAY);

assert('prepaid: the courier marking a parcel delivered finishes it', () =>
  isCourierFinished(['agent_delivered'], false));

assert('COD: agent_delivered is only "arrived, waiting for the code" — NOT finished', () =>
  !isCourierFinished(['agent_delivered'], true) && isCourierFinished(['delivered'], true));

assert('a returned parcel is finished either way', () =>
  isCourierFinished(['returned'], false) && isCourierFinished(['returned'], true));

assert('one parcel still on the road keeps the whole order unfinished', () =>
  !isCourierFinished(['agent_delivered', 'in_transit'], false));

assert('a failed parcel (it may be retried) keeps the order unfinished', () =>
  !isCourierFinished(['agent_delivered', 'failed'], false));

assert('no shipments is "not dispatched yet", never "nothing to deliver"', () =>
  !isCourierFinished([], false) && !isCourierFinished([], true));

assert('the two finished-sets differ only by agent_delivered', () =>
  COURIER_FINISHED_STATUSES.prepaid.includes('agent_delivered') &&
  !COURIER_FINISHED_STATUSES.cod.includes('agent_delivered'));

assert('deliveredAtOf prefers delivered_at, falls back to completion, else null', () =>
  deliveredAtOf({ delivered_at: at(2), completion: { confirmed_at: at(9) } })?.getTime() === at(2).getTime() &&
  deliveredAtOf({ delivered_at: null, completion: { confirmed_at: at(9) } })?.getTime() === at(9).getTime() &&
  deliveredAtOf({ delivered_at: null, completion: { confirmed_at: null } }) === null);

assert('EARNINGS_HOLD_DAYS defaults to 3 (owner, 2026-10-05)', () =>
  /HOLD_DAYS:\s*intEnv\('EARNINGS_HOLD_DAYS',\s*3\)/.test(code('modules/earnings/config/earnings.config.ts')));

// ─── 3. Pause reasons ────────────────────────────────────────────────────────
console.log('\n3. Pause reasons');

assert('the four reasons, closed', () =>
  JSON.stringify([...EARNINGS_PAUSE_REASONS].sort()) ===
  JSON.stringify(['admin', 'booking_cancelled_unrefunded', 'card_dispute', 'seller_cancelled_paid_order']));

assert('only a card dispute may lift itself; everything else waits for an administrator', () =>
  SELF_RESUMING_PAUSE_REASONS.length === 1 && SELF_RESUMING_PAUSE_REASONS[0] === 'card_dispute');

// ─── 4. Paused money is never released (source scans) ───────────────────────
console.log('\n4. Release honours the pause');

const repo = code('modules/earnings/repositories/earnings-allocation.repository.ts');
assert('findMaturedHeld excludes paused rows IN THE QUERY (a skipped batch would clog the sweep)', () =>
  /paused_at:\s*null/.test(methodBody(repo, 'async findMaturedHeld(')));
assert('the release CLAIM also requires paused_at: null (a pause mid-sweep must win)', () =>
  /paused_at:\s*null/.test(methodBody(repo, 'async markReleased(')));

const worker = code('modules/earnings/workers/earnings-release.worker.ts');
const releaseStage = methodBody(worker, 'private async releaseMaturedHolds(');
assert('the worker re-checks the SOURCE before releasing (rows created after the pause)', () => {
  const check = releaseStage.indexOf('pausedAtOfSource');
  const claim = releaseStage.indexOf('markReleased');
  return check > -1 && claim > -1 && check < claim;
});

// ─── 5. What pauses on its own ───────────────────────────────────────────────
console.log('\n5. Automatic pauses');

const vendorOrder = code('modules/orders/vendor-order.service.ts');
assert('a seller cancelling a PAID order raises a refund-owed (pause + ticket)', () =>
  /order\.payment_status === 'paid'[\s\S]{0,200}raiseRefundOwed\(/.test(vendorOrder) &&
  /reason:\s*'seller_cancelled_paid_order'/.test(vendorOrder));

const booking = code('modules/booking/services/booking.service.ts');
const statusMenu = methodBody(booking, 'async updateBookingStatus(');
assert('a paid booking cancelled from the STATUS MENU raises a refund-owed', () =>
  /paymentStatus === 'paid'[\s\S]{0,200}raiseRefundOwed\(/.test(statusMenu) &&
  /'booking_cancelled_unrefunded'/.test(statusMenu));

const refundOwed = code('modules/earnings/services/refund-owed.service.ts');
assert('the refund ticket is HIGH priority AND high importance', () =>
  /priority:\s*TicketPriority\.HIGH/.test(refundOwed) && /importance:\s*TicketImportance\.HIGH/.test(refundOwed));
assert('refund-owed pauses BEFORE opening the ticket, and never throws', () => {
  const pause = refundOwed.indexOf('earningsPauseService.pause(');
  const ticket = refundOwed.indexOf('createSystemTicket(');
  return pause > -1 && ticket > pause && (refundOwed.match(/catch \(error\)/g) ?? []).length >= 2;
});

const dispute = code('modules/payments/services/dispute.service.ts');
assert('a card dispute pauses the order and the booking', () =>
  /pauseEarnings\(\{ kind: 'order'/.test(methodBody(dispute, 'private async freezeOrder(')) &&
  /pauseEarnings\(\{ kind: 'booking'/.test(methodBody(dispute, 'private async freezeBooking(')));
assert('winning resumes ONLY a pause the dispute raised (never an administrator\'s)', () =>
  /resumeEarnings\([\s\S]{0,80}\['card_dispute'\]\)/.test(methodBody(dispute, 'private async resolveOrderWon(')) &&
  /resumeEarnings\([\s\S]{0,80}\['card_dispute'\]\)/.test(methodBody(dispute, 'private async resolveBookingWon(')));

const tickets = code('modules/tickets/services/ticket.service.ts');
assert('system/admin tickets skip the customer-facing required-info rule', () =>
  /if \(input\.createdByRole !== ActorRole\.ADMIN\)\s*\{\s*await this\.enforceSupportRequiredInfo/.test(tickets));

// ─── 6. The hold starts at delivery, everywhere ──────────────────────────────
console.log('\n6. Delivery starts the hold');

const split = code('modules/earnings/services/earnings-split.service.ts');
assert('no split inherits the COMPLETION date any more', () =>
  !/order\.completion\?\.confirmed_at \?\? null/.test(split));
assert('the four split paths inherit deliveredAtOf(order)', () =>
  (split.match(/deliveredAtOf\(order\)/g) ?? []).length === 4);

const shipment = code('modules/shipments/shipment.service.ts');
assert('a shipment transition syncs the hold AFTER the delivery split', () =>
  /split\s*\.then\(\(\) => earningsCompletionService\.syncOrderHold\(/.test(shipment));
assert('`failed` is among the statuses that re-sync (it can un-deliver an order)', () =>
  /\['agent_delivered', 'delivered', 'returned', 'failed'\]\.includes\(newStatus\)/.test(shipment));

const cash = code('modules/cod/services/cash-collection.service.ts');
assert('a COD collection syncs the hold after its split', () => {
  const body = methodBody(cash, 'protected async splitEarnings(');
  return body.indexOf('splitCodCollection') > -1 && body.indexOf('syncOrderHold') > body.indexOf('splitCodCollection');
});

const orderService = code('modules/orders/order.service.ts');
assert('a DIGITAL order starts its hold at payment', () =>
  /order\.order_type !== 'physical'[\s\S]{0,120}syncOrderHold\(/.test(orderService));

const completion = code('modules/earnings/services/earnings-completion.service.ts');
assert('sourcesOfOrder covers all three source types an order spans', () => {
  const body = methodBody(completion, 'async sourcesOfOrder(');
  return /'order'/.test(body) && /'cod_collection'/.test(body) && /'shipment'/.test(body);
});

const refund = code('modules/vendor/service/vendor-refund.service.ts');
assert('the return window runs from DELIVERY, not from order creation', () =>
  /deliveredAtOf\(order\)/.test(refund) && !/order\.created_at\)\.getTime\(\) \+ returnPolicy/.test(refund));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
