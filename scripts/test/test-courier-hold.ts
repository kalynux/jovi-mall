/**
 * Test: the courier hold — an agency's (and its rider's) share of a delivery is held only as
 * long as the agency's OWN terms make it answerable after delivery (owner decisions,
 * 2026-10-22; plan: PRODUCTION-READINESS/AGENCY-EARNINGS-RELEASE-PLAN.md).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. The first half asserts the pure rules in `earnings/domain/courier-hold.ts`. The
 * second half is SOURCE SCANS of the wiring no behavioural test without a database can see:
 * that every agency/rider row is written with its terms, that the ORDER's clock never touches
 * those rows, that an administrator's order pause skips a free agency, and that the nightly
 * sweep starts courier clocks BEFORE it releases. Comments are stripped before scanning.
 *
 * Run: npm run test:courier-hold
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  courierHoldDays,
  courierHoldSnapshot,
  courierHoldStartOf,
  courierStartStatuses,
  isFreeCourierRow,
  orderPauseReachesRow,
  shipmentPauseReachesRow,
} from '../../src/modules/earnings/domain/courier-hold';
import { resumedHoldReleaseAt } from '../../src/modules/earnings/domain/earnings-hold';

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
const W = 3; // EARNINGS_HOLD_DAYS, the protection window

// ─── 1. How long: the agency's terms, never past the window ─────────────────────
console.log('\n1. courierHoldDays');

assert('returns paid by the agency → the whole window, whatever the claim deadline', () =>
  courierHoldDays({ returns: { payer: 'agency' }, damage: { claim_deadline_days: 0 } }, W) === 3);
assert('claim deadline 4 → 3 (never past the window)', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: 4 } }, W) === 3);
assert('claim deadline 2 → 2 ("the shorter of the two", not free)', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: 2 } }, W) === 2);
assert('claim deadline 3 → 3', () =>
  courierHoldDays({ returns: { payer: 'customer' }, damage: { claim_deadline_days: 3 } }, W) === 3);
assert('claim deadline 0 and returns not on the agency → FREE (0)', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: 0 } }, W) === 0);
assert('returns on the agency outweigh a short claim deadline (the longer of the two holds)', () =>
  courierHoldDays({ returns: { payer: 'agency' }, damage: { claim_deadline_days: 1 } }, W) === 3);
assert('no terms at all → the whole window (holding is the safe answer)', () =>
  courierHoldDays(null, W) === 3 && courierHoldDays(undefined, W) === 3);
assert('a missing claim deadline reads as the whole window', () =>
  courierHoldDays({ returns: { payer: 'vendor' } }, W) === 3);
assert('a non-number claim deadline reads as the whole window', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: NaN } }, W) === 3);
assert('a negative claim deadline is treated as 0', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: -5 } }, W) === 0);
assert('the ceiling follows EARNINGS_HOLD_DAYS (window 5, claim 4 → 4)', () =>
  courierHoldDays({ returns: { payer: 'vendor' }, damage: { claim_deadline_days: 4 } }, 5) === 4);

assert('the snapshot records the terms it was computed from', () => {
  const s = courierHoldSnapshot('s1', 'a1', { returns: { payer: 'vendor' }, damage: { claim_deadline_days: 2 } }, W);
  return s.shipment_id === 's1' && s.agency_id === 'a1' && s.days === 2 && s.protection_days === 3
    && s.returns_payer === 'vendor' && s.claim_deadline_days === 2;
});
assert('isFreeCourierRow: only a snapshot with days 0', () =>
  isFreeCourierRow({ courier_hold: { days: 0 } }) && !isFreeCourierRow({ courier_hold: { days: 2 } })
  && !isFreeCourierRow({ courier_hold: null }) && !isFreeCourierRow({}));

// ─── 2. From when: the parcel's own delivery; a free agency waits for PROOF ──────
console.log('\n2. courierStartStatuses / courierHoldStartOf');

assert('free: only proof starts the clock — delivered (confirmation / code) or returned', () =>
  courierStartStatuses(false, true).join() === 'delivered,returned'
  && courierStartStatuses(true, true).join() === 'delivered,returned');
assert('held prepaid: the rider\'s tap starts it, like the seller\'s hold', () =>
  courierStartStatuses(false, false).includes('agent_delivered'));
assert('held COD: the code starts it, never the arrival tap', () =>
  !courierStartStatuses(true, false).includes('agent_delivered'));

const tapped = {
  status: 'agent_delivered',
  status_history: [
    { status: 'in_transit', changed_at: at(1) },
    { status: 'agent_delivered', changed_at: at(2) },
  ],
};
assert('free prepaid at the rider\'s tap → not started (waits for the customer)', () =>
  courierHoldStartOf(tapped, false, true, at(9)) === null);
assert('held prepaid at the rider\'s tap → started at the tap', () =>
  courierHoldStartOf(tapped, false, false, at(9))?.getTime() === at(2).getTime());

const confirmed = {
  status: 'delivered',
  status_history: [...tapped.status_history, { status: 'delivered', changed_at: at(4) }],
};
assert('free prepaid once confirmed → started at the confirmation, from history', () =>
  courierHoldStartOf(confirmed, false, true, at(9))?.getTime() === at(4).getTime());
assert('held prepaid once confirmed → still dated from the tap (the run did not break)', () =>
  courierHoldStartOf(confirmed, false, false, at(9))?.getTime() === at(2).getTime());

const retried = {
  status: 'agent_delivered',
  status_history: [
    { status: 'agent_delivered', changed_at: at(2) },
    { status: 'failed', changed_at: at(3) },
    { status: 'in_transit', changed_at: at(4) },
    { status: 'agent_delivered', changed_at: at(5) },
  ],
};
assert('a failed first tap is not the delivery: the second tap dates it', () =>
  courierHoldStartOf(retried, false, false, at(9))?.getTime() === at(5).getTime());
assert('a parcel that failed after the tap → no start (the start is cleared)', () =>
  courierHoldStartOf({ status: 'failed', status_history: retried.status_history.slice(0, 2) }, false, false, at(9)) === null);
assert('no history: a delivered parcel falls back to the customer\'s confirmation', () =>
  courierHoldStartOf({ status: 'delivered', status_history: [], customer_confirmation: { confirmed_at: at(6) } }, false, true, at(9))
    ?.getTime() === at(6).getTime());
assert('no history and no confirmation → now', () =>
  courierHoldStartOf({ status: 'returned' }, true, true, at(9))?.getTime() === at(9).getTime());

// ─── 3. Which pauses reach which rows ───────────────────────────────────────────
console.log('\n3. orderPauseReachesRow / shipmentPauseReachesRow');

const free = { beneficiary_type: 'agency', courier_hold: { days: 0 } };
const heldCourier = { beneficiary_type: 'agency', courier_hold: { days: 2 } };
const vendor = { beneficiary_type: 'vendor', courier_hold: null };
assert('an ADMINISTRATOR\'s order pause skips a free agency', () => !orderPauseReachesRow(free, 'admin'));
assert('…but reaches a held agency', () => orderPauseReachesRow(heldCourier, 'admin'));
assert('…and every non-courier row', () => orderPauseReachesRow(vendor, 'admin'));
assert('every OTHER order pause still reaches a free agency (owner, 2026-10-22)', () =>
  (['customer_problem_reported', 'refund_in_progress', 'seller_cancelled_paid_order', 'card_dispute'] as const)
    .every((r) => orderPauseReachesRow(free, r)));
assert('a delivery pause reaches the agency and the rider, never the vendor or the platform', () =>
  shipmentPauseReachesRow({ beneficiary_type: 'agency' }) && shipmentPauseReachesRow({ beneficiary_type: 'agent' })
  && !shipmentPauseReachesRow({ beneficiary_type: 'vendor' }) && !shipmentPauseReachesRow({ beneficiary_type: 'platform' }));

assert('two overlapping pauses: resuming by the row\'s own mark moves it by the WHOLE span', () => {
  // Delivery paused day 3, order paused day 4, delivery resumed day 5 (row stays held by the
  // order), order resumed day 7: the row was paused day 3 → 7 without a break.
  const row = { completed_at: at(1), hold_release_at: new Date(at(1).getTime() + 3 * DAY) };
  const moved = resumedHoldReleaseAt(row, at(3), at(7));
  return moved!.getTime() === row.hold_release_at.getTime() + 4 * DAY;
});

// ─── 4. Wiring (source scans) ────────────────────────────────────────────────
console.log('\n4. wiring');

const split = code('modules/earnings/services/earnings-split.service.ts');
assert('every agency and agent row the splits write carries its terms (courier_hold)', () => {
  const rows = split.match(/beneficiary_type: '(?:agency|agent)'(?: as const)?,[^}]*\}/g) ?? [];
  return rows.length === 6 && rows.every((r) => /courier_hold: courierHold/.test(r));
});
assert('the vendor\'s delivery leftover stays on the ORDER\'s clock (no snapshot)', () => {
  const rows = split.match(/beneficiary_type: 'vendor',[^}]*\}/g) ?? [];
  return rows.length > 0 && rows.every((r) => !/courier_hold/.test(r));
});

const repo = code('modules/earnings/repositories/earnings-allocation.repository.ts');
assert('a row with a snapshot is ALWAYS written unstarted', () =>
  /completed_at: input\.courier_hold \? null/.test(repo) && /hold_release_at: input\.courier_hold \? null/.test(repo));
assert('the order\'s clock never starts or clears a courier row', () =>
  ['async markCompletedBySource(', 'async markCompletedBySources(', 'async clearHoldBySources(']
    .every((sig) => /ORDER_CLOCK_ONLY/.test(methodBody(repo, sig))));
assert('the courier start is a compare-and-set on "not started"', () =>
  /completed_at: null, courier_hold: \{ \$ne: null \}/.test(methodBody(repo, 'async startCourierHold(')));

const completion = code('modules/earnings/services/earnings-completion.service.ts');
assert('syncOrderHold syncs every parcel\'s courier clock, and never throws for it', () => {
  const body = methodBody(completion, 'async syncOrderHold(');
  return /syncOrderClock/.test(body) && /syncShipmentCourierHold/.test(body) && /catch/.test(body);
});
assert('a free share\'s clock is chosen by its snapshot (days === 0)', () =>
  /courierHoldStartOf\([^)]*hold\.days === 0/.test(methodBody(completion, 'async syncShipmentCourierHold(')));

const pause = code('modules/earnings/services/earnings-pause.service.ts');
assert('an order pause marks rows excepting free couriers only when an administrator raised it', () =>
  /exceptFreeCourier: reason === 'admin'/.test(methodBody(pause, 'async pause(')));
assert('resume skips a row this pause never held, and one another pause still holds', () => {
  const body = methodBody(pause, 'async resume(');
  return /reaches\(target, row, current\.reason\)/.test(body) && /otherPauseHolds\(/.test(body)
    && /row\.paused_at \?\? current\.paused_at/.test(body);
});
assert('closeOnRefund leaves a row a delivery pause still holds', () =>
  /otherPauseHolds\(/.test(methodBody(pause, 'async closeOnRefund(')));
assert('the worker double-check knows both pauses', () => {
  const body = methodBody(pause, 'async pausedAtOfSource(');
  return /orderPauseReachesRow/.test(body) && /kind: 'shipment'/.test(body);
});

const worker = code('modules/earnings/workers/earnings-release.worker.ts');
assert('the nightly sweep starts courier clocks BEFORE it releases', () => {
  const sweep = methodBody(worker, 'async runSweep(');
  const a = sweep.indexOf('startCourierHolds');
  const b = sweep.indexOf('releaseMaturedHolds');
  return a > -1 && b > a;
});
assert('both split recoveries start the courier clock of what they recovered', () =>
  /syncShipmentCourierHold/.test(methodBody(worker, 'private async recoverMissedCodSplits('))
  && /syncShipmentCourierHold/.test(methodBody(worker, 'private async recoverMissedDeliverySplits(')));

const validator = code('modules/earnings/validators/admin-earnings.validator.ts');
assert('an administrator can pause a delivery', () =>
  /PAUSE_TARGET_KINDS = \['order', 'booking', 'shipment'\]/.test(validator));

const controller = code('modules/earnings/controllers/admin-earnings.controller.ts');
assert('a delivery resume skips the refund guard and the ticket release (order/booking only)', () => {
  const body = methodBody(controller, 'static resume =');
  return (body.match(/target\.kind !== 'shipment'/g) ?? []).length === 2;
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
