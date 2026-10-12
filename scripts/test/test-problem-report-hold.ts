/**
 * test:problem-report-hold — a customer's problem report keeps the purchase's earnings paused
 * (owner decision, 2026-10-10). Offline: the pure rules, and source scans of the wiring.
 * `verify:problem-report-hold` proves the behaviour against a database.
 *
 *   1. which requests count as a problem report (`isProblemReport`);
 *   2. who may free the money a request holds (`mayReleaseHold`) — never the seller;
 *   3. the pause reason and what lifts it;
 *   4. the wiring: creation pauses, only an ended request releases, an administrator's
 *      resume releases every request, a refund closed without paying reconciles;
 *   5. the protection window the customer's order view shows.
 *
 * Run: npm run test:problem-report-hold
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  isProblemReport,
  mayReleaseHold,
  PROBLEM_REPORT_ENTITY_TYPES,
  PROBLEM_REPORT_TICKET_TYPES,
} from '../../src/modules/tickets/domain/problem-report.rule';
import { ActorRole, EntityType, TicketType } from '../../src/modules/tickets/types/ticket.types';
import {
  adminLiftedProblemPause,
  EARNINGS_PAUSE_REASONS,
  protectionWindowOf,
  toCustomerProtection,
  REFUND_CLOSABLE_PAUSE_REASONS,
  SELF_RESUMING_PAUSE_REASONS,
} from '../../src/modules/earnings/domain/earnings-hold';
import { BOT_TICKET_TYPE_OF } from '../../src/modules/bot-surface/domain/bot-ticket-copy';

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

const report = (over: Partial<{ type: string; createdByRole: string; entityType: string }> = {}) => ({
  type: TicketType.ORDER_ISSUE as string,
  createdByRole: ActorRole.CUSTOMER as string,
  entityType: EntityType.ORDER as string,
  ...over,
});

// ─── 1. What counts as a problem report ──────────────────────────────────────
console.log('\n1. What counts as a problem report');

assert('a customer\'s ORDER_ISSUE about an order is one', () => isProblemReport(report()));

assert('about a shipment or a booking too', () =>
  isProblemReport(report({ entityType: EntityType.SHIPMENT })) &&
  isProblemReport(report({ entityType: EntityType.BOOKING, type: TicketType.BOOKING_ISSUE })));

assert('never about a product, a user or nothing: there is no paid purchase behind it', () =>
  [EntityType.PRODUCT, EntityType.USER, EntityType.OTHER, EntityType.VENDOR].every(
    (entityType) => !isProblemReport(report({ entityType }))
  ));

assert('only a CUSTOMER\'s request: a seller, agency, agent or the platform itself never holds money this way', () =>
  [ActorRole.VENDOR, ActorRole.AGENCY, ActorRole.AGENT, ActorRole.ADMIN].every(
    (createdByRole) => !isProblemReport(report({ createdByRole }))
  ));

assert('a question is not a problem: invoice, address change, reschedule, policy, account', () =>
  [
    TicketType.INVOICE_REQUEST,
    TicketType.ADDRESS_CHANGE,
    TicketType.BOOKING_RESCHEDULE,
    TicketType.POLICY_QUESTION,
    TicketType.ACCOUNT_ACCESS,
    TicketType.PROFILE_UPDATE,
  ].every((type) => !isProblemReport(report({ type }))));

assert('the catch-all types DO count: a defect filed under "other" is still protected', () =>
  isProblemReport(report({ type: TicketType.GENERAL_SUPPORT })) && isProblemReport(report({ type: TicketType.OTHER })));

assert('every subject the bot\'s support form offers about an order holds money, except "account"', () =>
  (Object.entries(BOT_TICKET_TYPE_OF) as Array<[string, string]>).every(
    ([key, type]) => PROBLEM_REPORT_TICKET_TYPES.includes(type as TicketType) === (key !== 'account')
  ));

assert('the two lists hold only real enum values, with no duplicate', () =>
  PROBLEM_REPORT_TICKET_TYPES.every((t) => Object.values(TicketType).includes(t)) &&
  new Set(PROBLEM_REPORT_TICKET_TYPES).size === PROBLEM_REPORT_TICKET_TYPES.length &&
  JSON.stringify([...PROBLEM_REPORT_ENTITY_TYPES].sort()) === JSON.stringify(['BOOKING', 'ORDER', 'SHIPMENT']));

// ─── 2. Who may free the money ───────────────────────────────────────────────
console.log('\n2. Who may free the money a request holds');

assert('an administrator may', () => mayReleaseHold({ userId: 'admin-1', role: ActorRole.ADMIN }, 'cust-1'));
assert('the customer who opened it may', () => mayReleaseHold({ userId: 'cust-1', role: ActorRole.CUSTOMER }, 'cust-1'));
assert('the SELLER may not, nor the agency, the agent or another customer', () =>
  !mayReleaseHold({ userId: 'vendor-1', role: ActorRole.VENDOR }, 'cust-1') &&
  !mayReleaseHold({ userId: 'agency-1', role: ActorRole.AGENCY }, 'cust-1') &&
  !mayReleaseHold({ userId: 'agent-1', role: ActorRole.AGENT }, 'cust-1') &&
  !mayReleaseHold({ userId: 'cust-2', role: ActorRole.CUSTOMER }, 'cust-1'));

// ─── 3. The pause reason ─────────────────────────────────────────────────────
console.log('\n3. The pause reason');

assert('customer_problem_reported is a pause reason', () =>
  (EARNINGS_PAUSE_REASONS as readonly string[]).includes('customer_problem_reported'));

assert('it lifts by itself (when the request ends), and a completed refund closes it', () =>
  SELF_RESUMING_PAUSE_REASONS.includes('customer_problem_reported') &&
  REFUND_CLOSABLE_PAUSE_REASONS.includes('customer_problem_reported'));

const pause = (over: Record<string, unknown>) =>
  ({ active: false, reason: 'customer_problem_reported', resumed_by_source: 'admin', ...over }) as any;

assert('an administrator lifting a problem pause stops later requests pausing again', () =>
  adminLiftedProblemPause(pause({})));

assert('…but not while it is active, not when the system lifted it, not for another reason, not when never paused', () =>
  !adminLiftedProblemPause(pause({ active: true })) &&
  !adminLiftedProblemPause(pause({ resumed_by_source: 'platform' })) &&
  !adminLiftedProblemPause(pause({ reason: 'admin' })) &&
  !adminLiftedProblemPause(null) &&
  !adminLiftedProblemPause(undefined));

// ─── 4. The wiring ───────────────────────────────────────────────────────────
console.log('\n4. The wiring');

const hold = code('modules/tickets/services/ticket-earnings-hold.service.ts');
const ticketSvc = code('modules/tickets/services/ticket.service.ts');

assert('creation asks the hold service, and a failure never fails the ticket', () =>
  /try\s*\{[\s\S]{0,200}ticketEarningsHoldService\.onTicketCreated\(/.test(ticketSvc));

assert('the hold checks OWNERSHIP before anything is flagged (creation itself only checks the order exists)', () => {
  const body = hold.slice(hold.indexOf('async onTicketCreated('), hold.indexOf('async onTicketEnded('));
  return body.indexOf('ownsTarget(') > 0 && body.indexOf('ownsTarget(') < body.indexOf('setHoldsEarnings(');
});

assert('…and that the money is not already released, and that no administrator already decided', () => {
  const body = hold.slice(hold.indexOf('async onTicketCreated('), hold.indexOf('async onTicketEnded('));
  return body.includes('moneyNotReleased(') && body.includes('adminLiftedProblemPause(');
});

assert('an ended ticket releases only through mayReleaseHold', () => {
  const body = hold.slice(hold.indexOf('async onTicketEnded('), hold.indexOf('async releaseAll('));
  return body.indexOf('mayReleaseHold(') > 0 && body.indexOf('mayReleaseHold(') < body.indexOf('setHoldsEarnings(');
});

assert('both ways of ending a ticket reach it: a terminal status, and close', () =>
  /isTerminalStatus\(newStatus\)\)\s*\{\s*await this\.releaseEarningsHold\(/.test(ticketSvc) &&
  /'Ticket closed'\);\s*await this\.releaseEarningsHold\(/.test(ticketSvc));

assert('the resume is limited to this reason, and waits for a refund that still holds the money', () => {
  const body = hold.slice(hold.indexOf('async reconcile('));
  return /refundHolds\(target\)\) return;[\s\S]{0,300}\[REASON\]/.test(body);
});

assert('counting the requests behind a pause never reads the ticket STATUS (a seller can set it)', () => {
  const repo = code('modules/tickets/repositories/ticket.repository.ts');
  const body = repo.slice(repo.indexOf('async countHoldingEarnings('), repo.indexOf('async releaseHoldingEarnings('));
  return body.includes('holds_earnings: true') && !body.includes('status');
});

assert('an administrator\'s manual resume releases every request about the purchase', () =>
  /earningsPauseService\.resume\([\s\S]{0,400}ticketEarningsHoldService\.releaseAll\(target\)/.test(
    code('modules/earnings/controllers/admin-earnings.controller.ts')
  ));

assert('a refund closed without paying hands over to an open problem report', () =>
  /\['refund_in_progress'\][\s\S]{0,200}this\.problemReports\.reconcile\(target\)/.test(
    code('modules/earnings/services/refund-earnings.adapter.ts')
  ));

// ─── 5. The protection window on the customer's order ────────────────────────
console.log('\n5. The protection window');

const DAY = 86_400_000;
const at = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * DAY);

assert('not delivered: it has not opened', () => {
  const w = protectionWindowOf({ delivered_at: null }, 3, at(5));
  return w.status === 'not_started' && w.startsAt === null && w.endsAt === null && w.days === 3 && !w.onHold;
});

assert('delivered: open for holdDays from DELIVERY, then ended', () => {
  const open = protectionWindowOf({ delivered_at: at(1) }, 3, at(3));
  const over = protectionWindowOf({ delivered_at: at(1) }, 3, at(4));
  return open.status === 'active' && open.endsAt?.getTime() === at(4).getTime() && over.status === 'ended';
});

assert('the number of days is the configured one, never a literal', () =>
  protectionWindowOf({ delivered_at: at(1) }, 5, at(5)).endsAt?.getTime() === at(6).getTime());

assert('a reported problem keeps it open with no end date', () => {
  const w = protectionWindowOf(
    { delivered_at: at(1), earnings_pause: { active: true, reason: 'customer_problem_reported', paused_at: at(2) } },
    3,
    at(30)
  );
  return w.status === 'active' && w.endsAt === null && w.onHold && w.problemReported;
});

assert('another pause holds the money too, but is not the customer\'s report', () => {
  const w = protectionWindowOf(
    { delivered_at: at(1), earnings_pause: { active: true, reason: 'card_dispute', paused_at: at(2) } },
    3,
    at(3)
  );
  return w.onHold && !w.problemReported && w.status === 'active';
});

assert('after a resume the end moves later by the paused time (the hold continues, it does not restart)', () => {
  const w = protectionWindowOf(
    { delivered_at: at(1), earnings_pause: { active: false, reason: 'customer_problem_reported', paused_at: at(2), resumed_at: at(7) } },
    3,
    at(8)
  );
  return w.endsAt?.getTime() === at(9).getTime() && w.status === 'active' && !w.onHold;
});

assert('a pause that began BEFORE delivery only counts from delivery', () => {
  const w = protectionWindowOf(
    { delivered_at: at(4), earnings_pause: { active: false, reason: 'admin', paused_at: at(1), resumed_at: at(6) } },
    3,
    at(6)
  );
  return w.endsAt?.getTime() === at(9).getTime();
});

assert('the customer order view projects it from the configured hold days', () => {
  const dto = code('modules/orders/dto/customer-order.dto.ts');
  return (
    dto.includes('toCustomerProtection(order, EARNINGS_CONFIG.HOLD_DAYS, new Date())') &&
    /\n\s+protection,\r?\n/.test(dto)
  );
});

assert('the customer BOOKING view projects the same block, from the completion date', () => {
  const ctl = code('modules/booking/controllers/customer-booking.controller.ts');
  return (
    ctl.includes('toCustomerProtection(') &&
    ctl.includes('raw.completedAt ?? raw.settlement?.settledAt ?? null') &&
    ctl.includes('EARNINGS_CONFIG.HOLD_DAYS')
  );
});

assert('⛔ …and the internal pause record (who paused, their note) never reaches the customer', () => {
  const ctl = code('modules/booking/controllers/customer-booking.controller.ts');
  return /const \{ earningsPause: _internal, \.\.\.visible \} = plain;/.test(ctl) && ctl.includes('return { ...visible,');
});

assert('a booking is dated ONCE at completion, and its hold starts from that same date', () => {
  const svc = code('modules/booking/services/booking.service.ts');
  return (
    svc.includes('if (completedAt) booking.completedAt = completedAt;') &&
    svc.includes("onSourceCompleted('booking', booking._id.toString(), completedAt ?? new Date())")
  );
});

assert('toCustomerProtection is protectionWindowOf with ISO dates, nothing else', () => {
  const w = toCustomerProtection({ delivered_at: at(1) }, 3, at(2));
  return (
    w.startsAt === at(1).toISOString() && w.endsAt === at(4).toISOString() && w.status === 'active' &&
    w.days === 3 && w.onHold === false && w.problemReported === false
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
