/**
 * Test: refund fees, agency liability and damage claims (owner decisions F-1…F-9, 2026-10-22).
 * Plan: PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. The first half asserts the pure rules — the owner's own worked numbers are the test
 * cases. The second half is SOURCE SCANS of the wiring a database-free test cannot see.
 * `verify:refund-fees-live` proves the money moves.
 *
 * Run: npm run test:refund-fees
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { computeRefundFees, customerRefundLines, disputeVendorCharge, payinFeeApplies, payoutFeeApplies } from '../../src/modules/payments/domain/refund-fees';
import { attributeRefund, maxAttributable } from '../../src/modules/payments/domain/refund-attribution';
import {
  agencyWindowDays,
  courierGiveback,
  damageClaimCap,
  insideAgencyWindow,
  problemRaisedAt,
  takeFromCouriers,
} from '../../src/modules/earnings/domain/courier-liability';
import {
  ADJUSTMENT_REASON_CODES,
  explainDamageClaim,
  explainDeliveryFault,
  explainVendorBeyond,
} from '../../src/modules/earnings/domain/adjustment-explanations';

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
function code(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}
const flat = (s: string) => s.replace(/\s+/g, ' ');

const DAY = 24 * 60 * 60 * 1000;
const at = (d: number): Date => new Date(Date.UTC(2026, 9, d, 12));
const fees = (gross: number, paymentChannel: 'card' | 'mobile_money' | 'cod' | 'billing', paidBy: 'customer' | 'vendor' = 'customer') =>
  computeRefundFees({ gross, paymentChannel, payinRatePercent: 2, payoutRatePercent: 2, paidBy });

// ─── 1. The fees (F-1…F-5) ──────────────────────────────────────────────────────
console.log('\n1. computeRefundFees');

assert('mobile money 10,000 → payment fee 200, transfer fee 196, the customer receives 9,604', () => {
  const f = fees(10_000, 'mobile_money');
  return f.payinAmount === 200 && f.payoutAmount === 196 && f.customerFee === 396 && f.net === 9_604 && f.vendorCharge === 0;
});
assert('the owner\'s payout example: 2,500 owed → 50 fee → 2,450 sent', () => {
  const f = computeRefundFees({ gross: 2_500, paymentChannel: 'cod', payinRatePercent: 2, payoutRatePercent: 2, paidBy: 'customer' });
  return f.payoutAmount === 50 && f.net === 2_450;
});
assert('card → payment fee only (refunded on the card, no transfer): 9,800', () => {
  const f = fees(10_000, 'card');
  return f.payinAmount === 200 && f.payoutAmount === 0 && f.net === 9_800;
});
assert('cash on delivery → transfer fee only (no aggregator when paid): 9,800', () => {
  const f = fees(10_000, 'cod');
  return f.payinAmount === 0 && f.payoutAmount === 200 && f.net === 9_800;
});
assert('billing → both fees, like mobile money', () => payinFeeApplies('billing') && payoutFeeApplies('billing'));
assert('the seller pays (F-5): the customer receives 100%, the seller is charged both fees on the WHOLE amount', () => {
  const f = fees(12_000, 'mobile_money', 'vendor');
  return f.net === 12_000 && f.customerFee === 0 && f.payinAmount === 240 && f.payoutAmount === 240 && f.vendorCharge === 480;
});
assert('the seller pays on a card: only the payment fee is charged to them', () => {
  const f = fees(10_000, 'card', 'vendor');
  return f.net === 10_000 && f.vendorCharge === 200;
});
assert('net = gross − customerFee, always', () =>
  [1, 99, 5_000, 123_457].every((g) =>
    (['card', 'mobile_money', 'cod', 'billing'] as const).every((c) => {
      const f = fees(g, c);
      return f.net === g - f.customerFee && f.customerFee === f.payinAmount + f.payoutAmount;
    })));
assert('a rate of 0 means no fee of that kind', () => {
  const f = computeRefundFees({ gross: 10_000, paymentChannel: 'mobile_money', payinRatePercent: 0, payoutRatePercent: 2, paidBy: 'customer' });
  return f.payinAmount === 0 && f.payoutAmount === 200 && f.net === 9_800;
});
assert('rounding is half-up in whole units (75 at 2% → 2; 25 at 2% → 1)', () =>
  fees(75, 'card').payinAmount === 2 && fees(25, 'card').payinAmount === 1);
assert('a lost dispute charges the vendor the 2% pay-in (F-9)', () => disputeVendorCharge(10_000, 2) === 200);

console.log('\n1b. what the customer reads');
assert('mobile money: Refund · payment fee · transfer fee · You receive', () => {
  const f = fees(10_000, 'mobile_money');
  const lines = customerRefundLines(f, 10_000);
  return lines.map((l) => l.code).join() === 'refund_amount,payment_fee,transfer_fee,you_receive'
    && lines[1].amount === -200 && lines[2].amount === -196 && lines[3].amount === 9_604
    // Refund + (negative) fees = what the customer receives — the lines add up on screen.
    && lines.slice(0, -1).reduce((s, l) => s + l.amount, 0) === lines[lines.length - 1].amount;
});
assert('seller pays: one line saying so, and the customer receives everything', () => {
  const lines = customerRefundLines(fees(12_000, 'mobile_money', 'vendor'), 12_000);
  return lines.some((l) => l.code === 'fees_paid_by_seller') && lines[lines.length - 1].amount === 12_000
    && !lines.some((l) => l.code === 'payment_fee' || l.code === 'transfer_fee');
});
assert('card: no transfer line', () => !customerRefundLines(fees(10_000, 'card'), 10_000).some((l) => l.code === 'transfer_fee'));

// ─── 2. Attribution with a delivery at fault ────────────────────────────────────
console.log('\n2. attribution');
const base = {
  reasonKind: 'return' as const,
  returnShippingPayer: 'customer' as const,
  itemDefective: null,
  goodsAmount: 10_000,
  deliveryAmountPaid: 2_000,
  delivered: true,
};
assert('a return under "customer pays return shipping": the delivery is not refundable', () => maxAttributable(base) === 10_000);
assert('…unless the delivery was at fault inside the window: the courier-funded part is', () =>
  maxAttributable({ ...base, faultDeliveryAmount: 2_000 }) === 12_000);
assert('the at-fault part never exceeds what the customer paid for delivery', () =>
  maxAttributable({ ...base, faultDeliveryAmount: 5_000 }) === 12_000);
assert('goods first, then delivery, as before', () => {
  const a = attributeRefund({ ...base, faultDeliveryAmount: 2_000 }, 11_000);
  return !!a && a.goods === 10_000 && a.delivery === 1_000;
});
assert('a vendor-paid return setting already refunds delivery: the fault adds nothing', () =>
  maxAttributable({ ...base, returnShippingPayer: 'vendor', faultDeliveryAmount: 2_000 }) === 12_000);

// ─── 3. The agency's window (F-6) ────────────────────────────────────────────────
console.log('\n3. agency window');
assert('window = the damage-claim deadline', () => agencyWindowDays({ claim_deadline_days: 2, returns_payer: 'vendor' }, 3) === 2);
assert('returns paid by the agency: at least the protection window', () =>
  agencyWindowDays({ claim_deadline_days: 1, returns_payer: 'agency' }, 3) === 3);
assert('a long deadline is kept (a damage claim on day 6 of a 7-day deadline is inside)', () =>
  agencyWindowDays({ claim_deadline_days: 7, returns_payer: 'vendor' }, 3) === 7);
assert('a free agency (deadline 0, returns not on it) never answers', () =>
  agencyWindowDays({ claim_deadline_days: 0, returns_payer: 'customer' }, 3) === 0
  && !insideAgencyWindow(at(1), at(1), 0));
assert('missing terms answer for nothing', () => agencyWindowDays(null, 3) === 0 && agencyWindowDays({}, 3) === 0);
assert('day 1 of a 2-day window is inside; day 3 is not', () =>
  insideAgencyWindow(at(1), new Date(at(1).getTime() + DAY), 2) && !insideAgencyWindow(at(1), new Date(at(1).getTime() + 3 * DAY), 2));
assert('a problem raised before delivery is not the courier\'s', () => !insideAgencyWindow(at(5), at(4), 3));
assert('not delivered → never inside', () => !insideAgencyWindow(null, at(1), 3));
assert('the problem\'s moment is the earliest known', () =>
  problemRaisedAt([at(5), null, at(3)], at(9)).getTime() === at(3).getTime() && problemRaisedAt([], at(9)).getTime() === at(9).getTime());

// ─── 4. What a courier gives back ─────────────────────────────────────────────────
console.log('\n4. courierGiveback / takeFromCouriers');
assert('prepaid: the agency and the rider give their whole share', () => {
  const lines = courierGiveback(
    [
      { id: 'a', beneficiary_type: 'agency', amount: 1_500, remaining: 1_500 },
      { id: 'r', beneficiary_type: 'agent', amount: 500, remaining: 500 },
    ],
    2_000
  );
  return lines[0].give === 1_500 && lines[1].give === 500;
});
assert('COD: the agency keeps its handling fee (C-3) — only fee − rider cut is given', () => {
  // fee 2,000, rider 500 → agency's fee part 1,500; its row also holds a 300 COD handling fee.
  const lines = courierGiveback(
    [
      { id: 'a', beneficiary_type: 'agency', amount: 1_800, remaining: 1_800 },
      { id: 'r', beneficiary_type: 'agent', amount: 500, remaining: 500 },
    ],
    2_000
  );
  return lines[0].give === 1_500 && lines[1].give === 500;
});
assert('money already clawed counts against the cap', () =>
  courierGiveback([{ id: 'a', beneficiary_type: 'agency', amount: 1_800, remaining: 1_000 }], 1_500)[0].give === 700);
assert('a need is spread in proportion and never above a line', () => {
  const t = takeFromCouriers([{ id: 'a', give: 1_500 }, { id: 'r', give: 500 }], 1_000);
  const a = t.lines.find((l) => l.id === 'a')!.give;
  const r = t.lines.find((l) => l.id === 'r')!.give;
  return a + r === 1_000 && a === 750 && r === 250 && t.short === 0;
});
assert('what nobody can cover is reported short', () => takeFromCouriers([{ id: 'a', give: 300 }], 1_000).short === 700);

// ─── 5. Damage claims (F-8) ──────────────────────────────────────────────────────
console.log('\n5. damage claims');
assert('cap = max refund per item × items', () => damageClaimCap(5_000, 2) === 10_000);
assert('an agency with no per-item limit allows nothing', () => damageClaimCap(0, 3) === 0 && damageClaimCap(null, 3) === 0);

// ─── 6. Explanations ───────────────────────────────────────────────────────────
console.log('\n6. explanations');
const fault = explainDeliveryFault({
  orderNumber: 'ORD-1', trackingNumber: 'TRK-9', amount: 1_500, currency: 'XAF',
  raisedAt: at(2), deliveredAt: at(1), windowDays: 2, claimDeadlineDays: 2, returnsPaidByAgency: false, role: 'agency',
});
assert('delivery fault: names the order, parcel, date, window and amount', () =>
  fault.reason_code === 'refund_delivery_fault' && /ORD-1/.test(fault.explanation) && /TRK-9/.test(fault.explanation)
  && /2-day/.test(fault.explanation) && /1,500 XAF/.test(fault.explanation) && fault.reason_params.windowDays === 2);
assert('the rider reads "your agency\'s" window', () =>
  /your agency's 2-day window/.test(explainDeliveryFault({
    orderNumber: null, trackingNumber: null, amount: 500, currency: 'XAF', raisedAt: at(2), deliveredAt: at(1),
    windowDays: 2, claimDeadlineDays: 2, returnsPaidByAgency: false, role: 'agent',
  }).explanation));
assert('seller fees are named on the vendor\'s charge', () => {
  const e = explainVendorBeyond({ orderNumber: 'ORD-2', currency: 'XAF', delivery: 0, goods: 0, fees: 480, feesReason: 'seller_cancelled' });
  return e.reason_code === 'refund_beyond_share' && /480 XAF/.test(e.explanation) && /cancelled by you/.test(e.explanation);
});
assert('a lost dispute\'s pay-in fee has its own code', () =>
  explainVendorBeyond({ orderNumber: null, currency: 'XAF', delivery: 0, goods: 0, fees: 200, feesReason: 'dispute_lost' }).reason_code === 'dispute_payin_fee');
assert('a damage claim quotes the per-item limit and the investigation fee', () => {
  const e = explainDamageClaim({
    orderNumber: 'ORD-3', trackingNumber: 'TRK-3', itemCount: 1, maxPerItem: 5_000, amount: 5_000, investigationFee: 1_000,
    currency: 'XAF', raisedAt: at(2), windowDays: 2,
  });
  return e.reason_code === 'damage_claim' && /5,000 XAF per item/.test(e.explanation) && /1,000 XAF/.test(e.explanation);
});
assert('every code produced is in the closed vocabulary', () =>
  ['refund_share', 'refund_beyond_share', 'refund_delivery_fault', 'dispute_share', 'dispute_payin_fee', 'damage_claim']
    .every((c) => (ADJUSTMENT_REASON_CODES as readonly string[]).includes(c)));

// ─── 7. Wiring (source scans) ────────────────────────────────────────────────────
console.log('\n7. wiring');
const refundService = flat(code('modules/payments/services/refund-request.service.ts'));
assert('create prices fees with computeRefundFees from BOTH settings', () =>
  /computeRefundFees\(\{ gross, paymentChannel: facts\.paymentChannel, payinRatePercent: settings\.payin_fee_percent, payoutRatePercent: settings\.refund_fee_percent, paidBy: input\.feesPaidBy \?\? 'customer', \}\)/.test(refundService));
assert('fee_amount is what the customer loses; net is fees.net', () =>
  /fee_amount: fees\.customerFee, net_amount: fees\.net,/.test(refundService));
assert('only an administrator or Support may name a delivery at fault, and only on an order', () =>
  /input\.source\.kind === 'order' && input\.earningsImpact !== 'none' && \(input\.requestedBy\.role === 'admin' \|\| input\.requestedBy\.role === 'support'\)/.test(refundService));
assert('completion hands the seller\'s fees and the at-fault parcels to the earnings recovery', () =>
  /vendorCharge: row\.fees\?\.vendor_charge \?\? 0, deliveryFault: \(row\.delivery_fault \?\? \[\]\)/.test(refundService));
assert('the refund events carry the two fees apart', () => /paymentFee: row\.fees\.paid_by === 'customer'/.test(refundService));

const owed = flat(code('modules/earnings/services/refund-owed.service.ts'));
assert('a seller cancelling a paid order makes the seller pay the fees (F-5)', () => /feesPaidBy: 'vendor'/.test(owed));

const dispute = flat(code('modules/payments/services/dispute.service.ts'));
assert('a CHARGEBACK charges the vendor the pay-in fee; a Stripe-side refund does not', () =>
  /if \(reason !== 'chargeback'\) return \{ vendorCharge: 0, dispute: false \}/.test(dispute) && /disputeVendorCharge\(/.test(dispute));

const claw = flat(code('modules/earnings/services/earnings-clawback.service.ts'));
assert('only parcels INSIDE their window give back', () => /\(input\.deliveryFault \?\? \[\]\)\.filter\(\(f\) => f\.insideWindow\)/.test(claw));
assert('agency/agent rows stay out of the normal scope (CLAWABLE_BENEFICIARIES unchanged)', () =>
  /CLAWABLE_BENEFICIARIES: readonly EarningsOwnerType\[\] = \['vendor', 'platform', 'platform_ai'\]/.test(claw));
assert('the courier-funded delivery is taken off the vendor\'s delivery part', () =>
  /const vendorDelivery = attribution\.delivery - courierFunded;/.test(claw));
assert('a free delivery\'s courier cost (C-8) is relieved by the faulted couriers', () =>
  /parcel\.vendorBorne <= 0/.test(claw) && /beyondGoods -= t\.give/.test(claw));
assert('every adjustment row carries an explanation and the refund request id', () =>
  /refund_request_id: refundRequestId, \.\.\.\(planned\.explain\?\.\(row, line\) \?\? explainRefundShare\(/.test(claw)
  && /fee_amount: planned\.vendorBeyond\.fees,/.test(claw) && /\.\.\.explainVendorBeyond\(/.test(claw));

const vendorRefund = code('modules/vendor/service/vendor-refund.service.ts');
assert('the vendor refund path never names a delivery at fault', () => !/deliveryFaultShipmentIds/.test(vendorRefund));

const liability = flat(code('modules/earnings/services/courier-liability.service.ts'));
assert('only the order\'s OWN customer\'s problem reports open the window', () =>
  /created_by_role: ActorRole\.CUSTOMER, created_by_user_id: customer\.user_id,/.test(liability));

const claimModel = code('modules/earnings/models/agency-claim.model.ts');
assert('one damage claim per parcel (unique index)', () => /\{ shipment_id: 1 \}, \{ unique: true/.test(claimModel));
const claimService = flat(code('modules/earnings/services/agency-claim.service.ts'));
assert('a claim refuses: outside the window, above the cap, a second claim', () =>
  /AGENCY_CLAIM_OUTSIDE_WINDOW/.test(claimService) && /AGENCY_CLAIM_EXCEEDS_CAP/.test(claimService) && /AGENCY_CLAIM_EXISTS/.test(claimService));
assert('a claim charges the AGENCY only (never its rider)', () => /r\.beneficiary_type === 'agency' && r\.status !== 'reversed'/.test(claimService));
assert('the vendor is credited the claim; the platform the investigation fee', () =>
  /this\.credit\('vendor', facts\.vendorId, claimId, claimed,/.test(claimService)
  && /this\.credit\('platform', null, claimId, facts\.investigationFee,/.test(claimService));
assert('charge and credits are one transaction', () => /runInTransactionWithRetry\(async \(session\) =>/.test(claimService));

const internal = code('../src/api/routes/internal-admin.routes.ts'.replace('../src/', ''));
assert('the damage-claim routes are mounted behind requireAdminCaller', () =>
  /router\.use\('\/agency-claims', buildAdminAgencyClaimRouter\(\[requireAdminCaller\]\)\)/.test(internal));
for (const [role, file] of [['agency', 'agency-earnings'], ['agent', 'agent-earnings'], ['vendor', 'vendor-earnings']] as const) {
  assert(`${role}s can read why money was taken (GET /earnings/adjustments)`, () =>
    /router\.get\('\/earnings\/adjustments', EarningsExplanationsController\.listMyAdjustments\)/.test(code(`modules/earnings/routes/${file}.routes.ts`)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
