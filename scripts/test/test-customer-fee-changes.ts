/**
 * Test: delivery-fee changes AFTER checkout on a CUSTOMER-paid shipment (ADR-A11 § Fee changes
 * after checkout — workstream W-E). DB-free; plain ts-node, hand-rolled asserts.
 *
 * What is pinned, and why each matters for money:
 *
 *   1. The plans — decrease (vendor share first), customer-approved increase (exactly the delta),
 *      vendor-covered increase — agree with W-C's `deliveryFeeShares`, the function every split
 *      divides with. A plan the split disagrees with is money moved twice or not at all.
 *   2. A chain of changes reconciles: every unit the customer paid is either the agency's fee,
 *      the vendor's (never), or owed back.
 *   3. The refund ledger arithmetic (per ORDER) and the refund legs (primary + top-up).
 *   4. Change-agency (D-10): the move itself is money-neutral, the difference flows as a proposal.
 *   5. The combined-price request rules (D-8): eligibility, only LOWER fees, the saving.
 *   6. The authority table for the customer and the vendor's cover; the customer DTO leaks nothing.
 *   7. Source scans for the wiring nothing behavioural can see: the top-up branch runs BEFORE the
 *      order's already-paid early return; the refund lookup is purpose-aware; the refund claim is
 *      written before the gateway is called.
 *   8. W-E2 (owner decision D-12): an administrator settles a MANUAL refund — only a
 *      `manual_required` row, compare-and-set, never paid twice against a wider order refund,
 *      the customer's owed amount clears. (The change of agency being ONE transaction is
 *      `test:change-agency-tx` / `verify:change-agency-tx`.)
 *
 * NOT covered (needs a replica set): the transactions, the partial unique indexes binding.
 *
 * Run: npm run test:customer-fee-changes
 */
import { readFileSync } from 'fs';
import path from 'path';
import { Types } from 'mongoose';
import {
  CHANGE_AGENCY_WINDOW,
  COMBINED_REQUEST_MIN_SHIPMENTS,
  CombinedCandidate,
  checkCombinedRequest,
  checkCombinedResponse,
  checkCustomerProposalEdit,
  combinedSaving,
  customerRefundPosition,
  MANUAL_REFUND_COVERED_METHOD,
  MANUAL_REFUND_PAYMENT_METHODS,
  MANUAL_REFUND_SETTLEMENT_METHODS,
  planManualSettlement,
  customerExcessOf,
  feeDirection,
  outstandingCustomerRefund,
  planCustomerApprovedIncrease,
  planDecrease,
  planRefundLegs,
  planVendorCoveredIncrease,
  planWholeMove,
  primaryLegRemaining,
  resolveApprover,
  vendorBorneOf,
  windowFor,
} from '../../src/modules/delivery-fee-proposals/domain/customer-fee-change.rules';
import {
  DELIVERY_FEE_PROPOSAL_WINDOW,
  resolveAvailableActions,
} from '../../src/modules/delivery-fee-proposals/domain/delivery-fee-proposal.rules';
import { deliveryFeeShares } from '../../src/modules/orders/domain/delivery-payer';
import { toCustomerDeliveryFeeProposalDto, toDeliveryFeeProposalDto } from '../../src/modules/delivery-fee-proposals/dto/delivery-fee-proposal.dto';
import {
  CreateCombinedDeliveryRequestSchema,
  RespondCombinedDeliveryRequestSchema,
  PayDeliveryTopupSchema,
  CustomerApproveDeliveryFeeProposalSchema,
  ListManualDeliveryFeeRefundsQuerySchema,
  SettleDeliveryFeeRefundSchema,
} from '../../src/modules/delivery-fee-proposals/validators/delivery-fee-proposal.validator';
import { toCustomerDeliveryFeeRefund } from '../../src/modules/orders/dto/customer-order.dto';
import { customerFeeLine } from '../../src/modules/delivery-fee-proposals/services/customer-fee-notifier';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { categoryFor, ERROR_CATEGORIES } from '../../src/core/error-category';
import { CUSTOMER_NOTIFICATION_TYPES } from '../../src/modules/notifications/models/customer-notification.model';
import { CUSTOMER_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { PAYMENT_PURPOSES } from '../../src/modules/payments/models/payment-transaction.model';

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
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}`);
  }
}
const section = (t: string) => console.log(`\n${t}`);
const ROOT = path.join(__dirname, '../..');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const src = (rel: string) => stripComments(readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'));
const raw = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** The split's view of a plan's end state must equal the plan's. */
function splitAgrees(plan: ReturnType<typeof planDecrease>, mode: 'online' | 'cod'): boolean {
  const s = deliveryFeeShares(plan.feeAfter, plan.customerFeeAfter);
  return s.vendorBorne === plan.vendorBorneAfter && (mode === 'cod' ? true : s.customerExcess === plan.refundableAfter);
}

function main() {
  // ───────────────────────────────────────────────────────────────────────────
  section('1. Who answers, which window, which direction');
  assert('vendor-paid → the vendor answers either way', () =>
    resolveApprover('vendor', 'increase') === 'vendor' && resolveApprover('vendor', 'decrease') === 'vendor');
  assert('customer-paid increase → the customer answers', () => resolveApprover('customer', 'increase') === 'customer');
  assert('customer-paid decrease → applies directly (approver none)', () => resolveApprover('customer', 'decrease') === 'none');
  assert('a lower fee is a decrease, an equal or higher one an increase', () =>
    feeDirection(1000, 800) === 'decrease' && feeDirection(1000, 1200) === 'increase');
  assert('agency + combined origins use the ADR-A09 window (before pickup)', () =>
    windowFor('agency') === DELIVERY_FEE_PROPOSAL_WINDOW && windowFor('combined_request') === DELIVERY_FEE_PROPOSAL_WINDOW);
  assert('a change-agency difference may sit on a fresh PENDING destination', () =>
    windowFor('change_agency') === CHANGE_AGENCY_WINDOW && CHANGE_AGENCY_WINDOW.includes('pending') && !CHANGE_AGENCY_WINDOW.includes('picked_up'));

  // ───────────────────────────────────────────────────────────────────────────
  section('2. Decrease — applied directly, vendor share first');
  const onlineDec = planDecrease({ mode: 'online', fee: 1000, customerFee: 1000 }, 800);
  assert('online: customer money is NOT lowered — 200 becomes refundable', () =>
    onlineDec.customerFeeAfter === 1000 && onlineDec.refundableAfter === 200 && onlineDec.feeAfter === 800);
  assert('online: the order total is not lowered (refund recorded beside it)', () => onlineDec.orderTotalDelta === 0);
  assert('online: the vendor allocation does not move (vendor bore nothing)', () => onlineDec.vendorAllocationDelta === 0);
  assert('online: the split agrees (excess = refundable, vendorBorne = 0)', () => splitAgrees(onlineDec, 'online'));
  const codDec = planDecrease({ mode: 'cod', fee: 1000, customerFee: 1000 }, 700);
  assert('COD: cash to collect drops by 300, order total and collection with it', () =>
    codDec.customerFeeAfter === 700 && codDec.collectDelta === -300 && codDec.orderTotalDelta === -300 && codDec.refundableAfter === 0);
  assert('COD: the split agrees', () => splitAgrees(codDec, 'cod'));
  const vfOnline = planDecrease({ mode: 'online', fee: 1300, customerFee: 1000 }, 1100);
  assert('vendor-first (online): vendor share 300 → 100, nothing refunded, allocation +200', () =>
    vfOnline.vendorBorneBefore === 300 && vfOnline.vendorBorneAfter === 100 && vfOnline.refundableAfter === 0 && vfOnline.vendorAllocationDelta === 200);
  const vfOnline2 = planDecrease({ mode: 'online', fee: 1300, customerFee: 1000 }, 900);
  assert('vendor-first (online): below the customer’s share → vendor 0, customer refunded 100', () =>
    vfOnline2.vendorBorneAfter === 0 && vfOnline2.refundableAfter === 100 && vfOnline2.vendorAllocationDelta === 300 && splitAgrees(vfOnline2, 'online'));
  const vfCod = planDecrease({ mode: 'cod', fee: 1300, customerFee: 1000 }, 1100);
  assert('vendor-first (COD): customer cash unchanged above their share', () => vfCod.customerFeeAfter === 1000 && vfCod.collectDelta === 0 && vfCod.vendorBorneAfter === 100);
  assert('COD never touches the vendor allocation (the collection split reads the shares)', () => vfCod.vendorAllocationDelta === 0);

  // ───────────────────────────────────────────────────────────────────────────
  section('3. Increase the customer approved — exactly the delta');
  const onlineInc = planCustomerApprovedIncrease({ mode: 'online', fee: 1000, customerFee: 1000 }, 1400);
  assert('online: top-up = 400; customer money and order total grow by it on payment', () =>
    onlineInc.topupDue === 400 && onlineInc.customerFeeAfter === 1400 && onlineInc.orderTotalDelta === 400);
  assert('online: vendor share unchanged (0 → 0), split agrees', () =>
    onlineInc.vendorBorneAfter === 0 && onlineInc.vendorAllocationDelta === 0 && splitAgrees(onlineInc, 'online'));
  const codInc = planCustomerApprovedIncrease({ mode: 'cod', fee: 1000, customerFee: 1000 }, 1250);
  assert('COD: no top-up; the cash to collect grows by 250 at once', () =>
    codInc.topupDue === 0 && codInc.collectDelta === 250 && codInc.customerFeeAfter === 1250);
  const keepVendor = planCustomerApprovedIncrease({ mode: 'online', fee: 1300, customerFee: 1000 }, 1500);
  assert('a vendor-borne share STAYS with the vendor: top-up 200, vendor still 300', () =>
    keepVendor.topupDue === 200 && keepVendor.vendorBorneAfter === 300 && splitAgrees(keepVendor, 'online'));
  const withCredit = planCustomerApprovedIncrease({ mode: 'online', fee: 800, customerFee: 1000 }, 900);
  assert('an outstanding refund is NOT netted: top-up 100, refundable stays 200 (two ledgers)', () =>
    withCredit.topupDue === 100 && withCredit.refundableAfter === 200 && splitAgrees(withCredit, 'online'));

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Vendor-covered increase (change-agency difference declined, D-10)');
  const cover = planVendorCoveredIncrease({ mode: 'online', fee: 1000, customerFee: 1000 }, 1300);
  assert('online: the customer pays nothing more; the vendor bears 300; allocation −300', () =>
    cover.customerFeeAfter === 1000 && cover.topupDue === 0 && cover.vendorBorneAfter === 300 && cover.vendorAllocationDelta === -300 && splitAgrees(cover, 'online'));
  const coverCod = planVendorCoveredIncrease({ mode: 'cod', fee: 1000, customerFee: 1000 }, 1300);
  assert('COD: nothing moves on the collection; the split charges the vendor 300', () =>
    coverCod.collectDelta === 0 && coverCod.vendorAllocationDelta === 0 && deliveryFeeShares(1300, 1000).vendorBorne === 300);

  // ───────────────────────────────────────────────────────────────────────────
  section('5. A chain of changes reconciles (online)');
  {
    // checkout 1000 → decrease to 800 (refund 200) → increase to 900 (top-up 100) → delivered.
    let fee = 1000, paid = 1000, refunded = 0;
    const d = planDecrease({ mode: 'online', fee, customerFee: paid }, 800);
    fee = d.feeAfter; refunded += outstandingCustomerRefund({ refundables: [d.refundableAfter], ledger: [] });
    const i = planCustomerApprovedIncrease({ mode: 'online', fee, customerFee: paid }, 900);
    paid += i.topupDue; fee = i.feeAfter;
    const owedNow = outstandingCustomerRefund({ refundables: [customerExcessOf(fee, paid)], ledger: [{ status: 'completed', amount: refunded }] });
    assert('paid 1100 = agency 900 + refunded 200 + still owed 0', () => paid === 1100 && fee + refunded + owedNow === paid && owedNow === 0);
    assert('the vendor bore nothing at any step', () => vendorBorneOf(fee, paid) === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('6. Editing a customer-approver proposal');
  assert('an edit that keeps it an increase is fine', () => checkCustomerProposalEdit({ currentFee: 1000, newFee: 1200, customerApproved: false }) === null);
  assert('an edit turning it into a decrease is refused (withdraw + propose instead)', () =>
    checkCustomerProposalEdit({ currentFee: 1000, newFee: 900, customerApproved: false })?.code === 'direction_changed');
  assert('nothing may be edited once the customer approved', () =>
    checkCustomerProposalEdit({ currentFee: 1000, newFee: 1300, customerApproved: true })?.code === 'customer_already_approved');

  // ───────────────────────────────────────────────────────────────────────────
  section('7. What is still owed — per ORDER, never per shipment');
  assert('Σ refundable − Σ claiming rows', () =>
    outstandingCustomerRefund({ refundables: [200, 300], ledger: [{ status: 'completed', amount: 200 }] }) === 300);
  assert('processing and manual_required CLAIM; failed does not', () =>
    outstandingCustomerRefund({ refundables: [500], ledger: [{ status: 'processing', amount: 100 }, { status: 'manual_required', amount: 100 }, { status: 'failed', amount: 300 }] }) === 300);
  assert('a refund against a since-deleted shipment still counts (no double pay after a move)', () =>
    // Source (deleted) had refundable 200, refunded; destination carries it gross → 200 + new 100.
    outstandingCustomerRefund({ refundables: [300], ledger: [{ status: 'completed', amount: 200 }] }) === 100);
  assert('never negative; null/undefined refundables are 0', () =>
    outstandingCustomerRefund({ refundables: [null, undefined, 50], ledger: [{ status: 'completed', amount: 80 }] }) === 0);

  // ───────────────────────────────────────────────────────────────────────────
  section('8. Refund legs — an order paid at checkout AND topped up');
  const legs = [
    { id: 'p', purpose: 'primary' as const, remaining: 10000 },
    { id: 't', purpose: 'order_delivery_topup' as const, remaining: 400 },
  ];
  assert('a delivery refund takes the top-up first', () => JSON.stringify(planRefundLegs(legs, 300, 'topup_first')) === '[{"id":"t","amount":300}]');
  assert('a delivery refund above the top-up spills onto the checkout charge', () =>
    JSON.stringify(planRefundLegs(legs, 600, 'topup_first')) === '[{"id":"t","amount":400},{"id":"p","amount":200}]');
  assert('an ordinary refund takes the checkout charge first', () => JSON.stringify(planRefundLegs(legs, 300)) === '[{"id":"p","amount":300}]');
  assert('a FULL refund covers both legs (the ceiling includes top-ups)', () =>
    JSON.stringify(planRefundLegs(legs, 10400)) === '[{"id":"p","amount":10000},{"id":"t","amount":400}]');
  assert('more than both legs hold → null', () => planRefundLegs(legs, 10401) === null);
  assert('a group charge’s share for one order excludes the top-ups it was paid later', () =>
    primaryLegRemaining({ orderTotal: 5400, topupsPaid: 400, refundedFromThisLegForOrder: 1000, paymentRemaining: 99999 }) === 4000);
  assert('…and never exceeds what the charge itself still holds', () =>
    primaryLegRemaining({ orderTotal: 5400, topupsPaid: 400, refundedFromThisLegForOrder: 0, paymentRemaining: 1500 }) === 1500);

  // ───────────────────────────────────────────────────────────────────────────
  section('9. Change of agency (D-10)');
  const toNew = planWholeMove({ mode: 'online', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 1300 });
  assert('whole move to a NEW shipment: fee and customer money carried unchanged (money-neutral)', () =>
    toNew.interimFee === 1000 && toNew.carriedCustomerFee === 1000);
  assert('…the higher new price is a customer-approval increase', () => toNew.difference.kind === 'increase' && (toNew.difference as any).newFee === 1300);
  const cheaper = planWholeMove({ mode: 'cod', source: { fee: 1000, customerFee: 1000, refundable: 0 }, destination: null, newAgencyFee: 700 });
  assert('a cheaper new agency → a decrease (applied directly)', () => cheaper.difference.kind === 'decrease');
  const merge = planWholeMove({
    mode: 'online',
    source: { fee: 1000, customerFee: 1000, refundable: 50 },
    destination: { fee: 1200, customerFee: 1200, refundable: 0 },
    newAgencyFee: 1500,
  });
  assert('merge into an existing shipment: sums carried, combined price lower → decrease', () =>
    merge.interimFee === 2200 && merge.carriedCustomerFee === 2200 && merge.carriedRefundable === 50 && merge.difference.kind === 'decrease');
  assert('same price → nothing to settle', () =>
    planWholeMove({ mode: 'online', source: { fee: 900, customerFee: 900, refundable: 0 }, destination: null, newAgencyFee: 900 }).difference.kind === 'none');

  // ───────────────────────────────────────────────────────────────────────────
  section('10. The combined-price request (D-8)');
  const cand = (over: Partial<CombinedCandidate> = {}): CombinedCandidate => ({
    shipmentId: 's' + Math.random(), agencyId: 'A', cartId: 'C', status: 'assigned', payer: 'customer', pendingProposal: false, countedProposals: 0, ...over,
  });
  assert(`needs at least ${COMBINED_REQUEST_MIN_SHIPMENTS} parcels`, () =>
    checkCombinedRequest({ agencyId: 'A', cartId: 'C', candidates: [cand()], maxProposals: 2 })?.code === 'too_few');
  assert('two eligible parcels pass', () => checkCombinedRequest({ agencyId: 'A', cartId: 'C', candidates: [cand(), cand()], maxProposals: 2 }) === null);
  for (const [label, over, reason] of [
    ['another agency', { agencyId: 'B' }, 'agency'],
    ['another checkout', { cartId: 'X' }, 'cart'],
    ['picked up', { status: 'picked_up' }, 'status'],
    ['vendor-paid', { payer: 'vendor' }, 'payer'],
    ['a pending proposal', { pendingProposal: true }, 'pending'],
    ['cap reached', { countedProposals: 2 }, 'limit'],
  ] as Array<[string, Partial<CombinedCandidate>, string]>) {
    assert(`a parcel with ${label} is ineligible (${reason})`, () => {
      const r = checkCombinedRequest({ agencyId: 'A', cartId: 'C', candidates: [cand(), cand(over)], maxProposals: 2 });
      return r?.code === 'not_eligible' && r.reason === reason;
    });
  }
  const fees = new Map([['s1', 1000], ['s2', 1500]]);
  assert('an answer may only LOWER a fee', () =>
    checkCombinedResponse({ requestShipmentIds: ['s1', 's2'], fees: [{ shipmentId: 's1', proposedFee: 1000 }], currentFees: fees })?.code === 'not_lower');
  assert('an answer cannot name a parcel outside the request, or one twice', () =>
    checkCombinedResponse({ requestShipmentIds: ['s1'], fees: [{ shipmentId: 's9', proposedFee: 1 }], currentFees: fees })?.code === 'unknown_shipment'
    && checkCombinedResponse({ requestShipmentIds: ['s1', 's2'], fees: [{ shipmentId: 's1', proposedFee: 1 }, { shipmentId: 's1', proposedFee: 2 }], currentFees: fees })?.code === 'duplicate_shipment');
  assert('a valid answer passes, and the saving is Σ (current − proposed)', () =>
    checkCombinedResponse({ requestShipmentIds: ['s1', 's2'], fees: [{ shipmentId: 's1', proposedFee: 700 }, { shipmentId: 's2', proposedFee: 1000 }], currentFees: fees }) === null
    && combinedSaving([{ proposedFee: 700, currentFee: 1000 }, { proposedFee: 1000, currentFee: 1500 }]) === 800);

  // ───────────────────────────────────────────────────────────────────────────
  section('11. Authority table + projections');
  const base = { status: 'pending' as const, proposed_by_role: 'agency' as const, proposed_by_agent_id: null };
  assert('customer-approver: the customer approves / rejects; the vendor has NO verb', () =>
    JSON.stringify(resolveAvailableActions({ ...base, approver: 'customer' }, { role: 'customer' })) === '["approve","reject"]'
    && resolveAvailableActions({ ...base, approver: 'customer' }, { role: 'vendor' }).length === 0);
  assert('after the customer approved (online): pay or reject; the agency may only withdraw', () =>
    JSON.stringify(resolveAvailableActions({ ...base, approver: 'customer', customer_approved: true }, { role: 'customer' })) === '["pay","reject"]'
    && JSON.stringify(resolveAvailableActions({ ...base, approver: 'customer', customer_approved: true }, { role: 'agency' })) === '["withdraw"]');
  assert('vendor-approver (ADR-A09): the customer has no verb', () =>
    resolveAvailableActions({ ...base }, { role: 'customer' }).length === 0);
  assert('change-agency difference: vendor may cover; agency has nothing; customer approves/rejects', () =>
    JSON.stringify(resolveAvailableActions({ ...base, proposed_by_role: 'system', approver: 'customer', origin: 'change_agency' }, { role: 'vendor' })) === '["cover"]'
    && resolveAvailableActions({ ...base, proposed_by_role: 'system', approver: 'customer', origin: 'change_agency' }, { role: 'agency' }).length === 0
    && JSON.stringify(resolveAvailableActions({ ...base, proposed_by_role: 'system', approver: 'customer', origin: 'change_agency' }, { role: 'customer' })) === '["approve","reject"]');

  const doc: any = {
    _id: new Types.ObjectId(), shipment_id: new Types.ObjectId(), order_id: new Types.ObjectId(), vendor_id: new Types.ObjectId(),
    agency_id: new Types.ObjectId(), proposed_by_role: 'agent', proposed_by_user_id: new Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'),
    proposed_by_agent_id: new Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'), payment_method: 'online', currency: 'XAF', fee_before: 1000,
    proposed_fee: 1400, reason: 'Bulky', status: 'pending', approver: 'customer', origin: 'agency', direction: 'increase',
    customer_id: new Types.ObjectId(), customer_approval: null, topup: null, version: 2, edits: [], agency_edited: false,
    application: { fee_at_apply: 1000, vendor_allocation_before: 8000, vendor_allocation_after: 8000, snapshot_rewritten: true },
    created_at: new Date(), updated_at: new Date(), responded_at: null,
  };
  const c = toCustomerDeliveryFeeProposalDto(doc);
  const cs = JSON.stringify(c);
  assert('customer DTO: no user/agent ids, no vendor allocation', () =>
    !cs.includes('aaaaaaaaaaaaaaaaaaaaaaaa') && !cs.includes('bbbbbbbbbbbbbbbbbbbbbbbb') && !cs.includes('8000'));
  assert('customer DTO: raisedBy delivery_company, version carried, verbs approve/reject', () =>
    c.raisedBy === 'delivery_company' && c.version === 2 && JSON.stringify(c.availableActions) === '["approve","reject"]');
  assert('dashboard DTO carries approver / origin / direction', () => {
    const d = toDeliveryFeeProposalDto(doc, { role: 'agency' });
    return d.approver === 'customer' && d.origin === 'agency' && d.direction === 'increase' && JSON.stringify(d.availableActions) === '["withdraw","edit"]';
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('12. Validators');
  assert('customer approve needs the seen version', () =>
    CustomerApproveDeliveryFeeProposalSchema.safeParse({ version: 1 }).success && !CustomerApproveDeliveryFeeProposalSchema.safeParse({}).success);
  assert('top-up pay: provider + channel (gateway accepted, ignored)', () =>
    PayDeliveryTopupSchema.safeParse({ provider: 'MTN', channel: { phoneNumber: '+237670000000' } }).success);
  assert('combined create: agencyId required; shipmentIds ≥ 2 when sent; strict', () =>
    CreateCombinedDeliveryRequestSchema.safeParse({ agencyId: 'a'.repeat(24) }).success
    && !CreateCombinedDeliveryRequestSchema.safeParse({ agencyId: 'a'.repeat(24), shipmentIds: ['b'.repeat(24)] }).success
    && !CreateCombinedDeliveryRequestSchema.safeParse({ agencyId: 'a'.repeat(24), customerId: 'x' }).success);
  assert('combined respond: fees XOR decline', () =>
    RespondCombinedDeliveryRequestSchema.safeParse({ fees: [{ shipmentId: 'a'.repeat(24), proposedFee: 500 }] }).success
    && RespondCombinedDeliveryRequestSchema.safeParse({ decline: true, note: 'Too far apart' }).success
    && !RespondCombinedDeliveryRequestSchema.safeParse({}).success
    && !RespondCombinedDeliveryRequestSchema.safeParse({ decline: true, fees: [{ shipmentId: 'a'.repeat(24), proposedFee: 1 }] }).success);

  // ───────────────────────────────────────────────────────────────────────────
  section('13. Error codes and notifications');
  const codes: Array<[string, number]> = [
    ['DELIVERY_FEE_PROPOSAL_DIRECTION_CHANGED', 422], ['DELIVERY_FEE_TOPUP_IN_PROGRESS', 409], ['DELIVERY_FEE_TOPUP_NOT_DUE', 409],
    ['DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID', 422], ['COMBINED_DELIVERY_REQUEST_NOT_FOUND', 404], ['COMBINED_DELIVERY_REQUEST_INELIGIBLE', 422],
    ['COMBINED_DELIVERY_REQUEST_ALREADY_OPEN', 409], ['COMBINED_DELIVERY_REQUEST_NOT_OPEN', 409], ['COMBINED_DELIVERY_RESPONSE_INVALID', 422],
    // W-E2 — settling a manual refund.
    ['DELIVERY_FEE_REFUND_NOT_FOUND', 404], ['DELIVERY_FEE_REFUND_NOT_SETTLEABLE', 409],
    ['DELIVERY_FEE_REFUND_ALREADY_COVERED', 409], ['DELIVERY_FEE_REFUND_NOT_COVERED', 409],
  ];
  const errorsDoc = raw('api-doc/errors/README.md');
  for (const [code, status] of codes) {
    assert(`${code}: registered, message, documented, category from ${status}`, () =>
      (ERROR_CODES as Record<string, string>)[code] === code && !!(DEFAULT_ERROR_MESSAGES as Record<string, string>)[code]
      && errorsDoc.includes('`' + code + '`')
      && categoryFor(code, status) === (status === 404 ? ERROR_CATEGORIES.NOT_FOUND : status === 409 ? ERROR_CATEGORIES.CONFLICT : ERROR_CATEGORIES.BUSINESS_RULE));
  }
  const situations = [
    'order.delivery_fee.approval_needed', 'order.delivery_fee.topup_due', 'order.delivery_fee.lowered', 'order.delivery_fee.updated',
    'order.delivery_fee.refund_pending', 'order.delivery_fee.topup_failed', 'order.combined_delivery.answered',
    'order.delivery_fee.refund_settled',
  ] as const;
  for (const s of situations) {
    assert(`customer situation ${s}: in the enum, in the catalog with a template`, () =>
      CUSTOMER_NOTIFICATION_TYPES.includes(s as any) && !!(CUSTOMER_NOTIFICATION_CATALOG as any)[s]?.whatsapp?.template?.name);
  }
  const handler = src('src/modules/notifications/services/customer-notification-event-handler.service.ts');
  const prefBlock = handler.slice(handler.indexOf('const SITUATION_PREFERENCE'), handler.indexOf('};', handler.indexOf('const SITUATION_PREFERENCE')));
  assert('all eight are MONEY situations — none has a preference key (cannot be muted)', () =>
    situations.every((s) => !prefBlock.includes(`'${s}'`)));
  assert('the optional sentences render in each language and substitute the amount', () =>
    customerFeeLine('online_refund', 'fr', { amount: 'XAF 200' }).includes('XAF 200')
    && customerFeeLine('cod_less', 'en', { amount: 'XAF 300' }) === 'You will pay XAF 300 less in cash at delivery.');

  // ───────────────────────────────────────────────────────────────────────────
  section('14. Source scans — the wiring');
  assert('the payment purpose enum carries order_delivery_topup', () => PAYMENT_PURPOSES.includes('order_delivery_topup'));
  const orch = src('src/modules/payments/services/payment-orchestrator.service.ts');
  const success = orch.slice(orch.indexOf('private async handlePaymentSuccess('), orch.indexOf('private isDeadStatus('));
  assert('⛔ handlePaymentSuccess branches on the top-up BEFORE OrderService.handlePaymentSuccess (the paid early return)', () => {
    const topup = success.indexOf("transaction.purpose === 'order_delivery_topup'");
    const order = success.indexOf('this.orderService.handlePaymentSuccess(');
    return topup > 0 && order > topup && success.slice(topup, order).includes('return;');
  });
  const failure = orch.slice(orch.indexOf('private async handlePaymentFailure('), orch.indexOf('private async handleBookingPaymentSuccess('));
  assert('a failed top-up is NOT announced as an order payment failure', () =>
    failure.indexOf("transaction.purpose === 'order_delivery_topup'") > 0
    && failure.indexOf("transaction.purpose === 'order_delivery_topup'") < failure.indexOf("eventBus.publish('payment.failed'"));
  const legsFn = orch.slice(orch.indexOf('async resolveRefundLegs('), orch.indexOf('async sourceCeiling('));
  assert('⛔ the refund lookup is PURPOSE-AWARE: every succeeded leg, the top-ups included', () =>
    legsFn.includes("'order_delivery_topup'") && legsFn.includes('PaymentTransactionModel.find(') && !legsFn.includes('PaymentTransactionModel.findOne({\n      $or'));
  const refundFn = orch.slice(orch.indexOf('async refundPayment('), orch.indexOf('async resolveRefundLegs('));
  assert('refundPayment spreads over legs and validates every leg’s gateway before any money moves', () =>
    refundFn.includes('planRefundLegs(') && refundFn.indexOf('REFUND_GATEWAY_NOT_SUPPORTED') < refundFn.indexOf('RefundTransactionModel.create('));
  const topupInit = orch.slice(orch.indexOf('async initiateOrderDeliveryTopup('), orch.indexOf('async verifyPayment('));
  assert('the top-up idempotency key and live-attempt guard are scoped by purpose AND proposal', () =>
    topupInit.includes(':delivery_topup:') && topupInit.includes("purpose: 'order_delivery_topup'") && topupInit.includes("'deliveryTopup.proposalId'"));
  assert('the top-up requires the checkout charge to be settled', () => topupInit.includes("order.payment_status !== 'paid'"));
  assert('vendor/admin refund eligibility folds the top-ups in (purpose-aware)', () => {
    const v = src('src/modules/vendor/service/vendor-refund.service.ts');
    return v.includes("t.purpose !== 'order_delivery_topup'") && v.includes('PaymentTransactionModel.find(');
  });
  assert('a chargeback never unwinds the top-up instead of the order charge', () =>
    src('src/modules/payments/services/dispute.service.ts').includes("purpose: { $ne: 'order_delivery_topup' }"));

  const refundSvc = src('src/modules/delivery-fee-proposals/services/delivery-fee-refund.service.ts');
  const refundOutstanding = refundSvc.slice(refundSvc.indexOf('async refundOutstanding('), refundSvc.indexOf('async sweepOutstanding('));
  // REFUND-FLOW-PLAN § 4 (2026-10-05): the delivery refund is a REFUND REQUEST now, not a direct
  // gateway call — the claim still comes first, and the money still never touches earnings.
  assert('⛔ the refund CLAIM (processing row) is written BEFORE the refund request is opened', () =>
    refundOutstanding.indexOf('this.claim(') > 0 && refundOutstanding.indexOf('this.claim(') < refundOutstanding.indexOf('refunds.create('));
  assert('the delivery refund is a system refund, top-up first, capped at what the order can still return', () =>
    refundOutstanding.includes("role: 'system'") && refundOutstanding.includes("prefer: 'topup_first'") && refundOutstanding.includes('refundableCapacity('));
  assert('…sent at once where it can be (approveNow), and it touches NO earnings (earningsImpact: none)', () =>
    refundOutstanding.includes('approveNow: true') && refundOutstanding.includes("earningsImpact: 'none'")
    && !refundOutstanding.includes('orchestrator.refundPayment('));


  const app = src('src/modules/delivery-fee-proposals/services/customer-fee-application.service.ts');
  assert('the money application CAS-guards the pointer, the window and the customer fee', () =>
    app.includes('pending_delivery_fee_proposal_id: input.expectedPointer') && app.includes('status: { $in: [...input.window] }') && app.includes('customer_delivery_fee:'));
  assert('a COD collection is re-priced only while pending', () => app.includes("collection.status !== 'pending'") && app.includes("status: 'pending', expected_amount"));

  const topupSvc = src('src/modules/delivery-fee-proposals/services/delivery-fee-topup.service.ts');
  assert('a top-up is applied once: the appliedAt marker is CAS-stamped inside the same transaction', () =>
    (topupSvc.match(/'deliveryTopup\.appliedAt': null/g) ?? []).length >= 2);
  assert('money arriving for a closed proposal is credited to the customer, never dropped', () => topupSvc.includes('creditToCustomer('));

  assert('lifecycle registers the refund consumer', () => src('src/lifecycle.ts').includes('registerDeliveryFeeRefundConsumer()'));
  assert('the earnings sweep backstops the lossy bus', () =>
    src('src/modules/earnings/workers/earnings-release.worker.ts').includes('await this.recoverCustomerDeliveryRefunds();'));

  const migration = src('scripts/migrate-delivery-fee-proposal-indexes.ts');
  const declared = [
    ...raw('src/modules/delivery-fee-proposals/models/delivery-fee-refund.model.ts').matchAll(/name: '(delivery_fee_refund_[a-z_]+)'/g),
    ...raw('src/modules/delivery-fee-proposals/models/combined-delivery-request.model.ts').matchAll(/name: '(combined_delivery_request_[a-z_]+)'/g),
  ].map((m) => m[1]);
  assert(`the new models declare 6 named indexes (found ${declared.length}), all built by the migration`, () =>
    declared.length === 6 && declared.every((n) => migration.includes(`'${n}'`)));


  // ───────────────────────────────────────────────────────────────────────────
  section('15. W-E2 — an administrator settles a MANUAL refund (D-12)');
  assert('the settlement methods: four that MOVE money, plus covered_by_order_refund', () =>
    JSON.stringify([...MANUAL_REFUND_PAYMENT_METHODS]) === '["mobile_money","cash","bank","other"]'
    && MANUAL_REFUND_COVERED_METHOD === 'covered_by_order_refund'
    && MANUAL_REFUND_SETTLEMENT_METHODS.length === 5);
  for (const status of ['processing', 'completed', 'failed'] as const) {
    assert(`only a manual_required row settles — ${status} is refused (409 NOT_SETTLEABLE)`, () => {
      const v = planManualSettlement({ status, amount: 300, method: 'mobile_money', stillReturnable: 5000 });
      return !v.ok && v.refusal.code === 'not_settleable' && (v.refusal as any).status === status;
    });
  }
  const paid = planManualSettlement({ status: 'manual_required', amount: 300, method: 'mobile_money', stillReturnable: 5000 });
  assert('online, the order still covers it → paid by hand, whole amount, nothing left', () =>
    paid.ok && paid.plan.settledAmount === 300 && paid.plan.remainderOwed === 0 && paid.plan.paidByHand);
  const cod = planManualSettlement({ status: 'manual_required', amount: 300, method: 'cash', stillReturnable: null });
  assert('COD (no charge, no ceiling) → paid by hand', () => cod.ok && cod.plan.paidByHand && cod.plan.settledAmount === 300);
  const twice = planManualSettlement({ status: 'manual_required', amount: 300, method: 'bank', stillReturnable: 0 });
  assert('⛔ a wider refund of the ORDER already returned it → paying is refused (ALREADY_COVERED, never paid twice)', () =>
    !twice.ok && twice.refusal.code === 'already_covered' && (twice.refusal as any).stillReturnable === 0);
  const partlyPaid = planManualSettlement({ status: 'manual_required', amount: 300, method: 'other', stillReturnable: 100 });
  assert('…also when the order can return only PART of it', () => !partlyPaid.ok && partlyPaid.refusal.code === 'already_covered');
  const covered = planManualSettlement({ status: 'manual_required', amount: 300, method: 'covered_by_order_refund', stillReturnable: 0 });
  assert('covered_by_order_refund when fully covered → settled, NOT paid by hand, no remainder', () =>
    covered.ok && !covered.plan.paidByHand && covered.plan.settledAmount === 300 && covered.plan.remainderOwed === 0);
  const split = planManualSettlement({ status: 'manual_required', amount: 300, method: 'covered_by_order_refund', stillReturnable: 100 });
  assert('a PARTIAL cover splits: 200 recorded covered, 100 stays owed as its own manual row', () =>
    split.ok && split.plan.settledAmount === 200 && split.plan.remainderOwed === 100 && !split.plan.paidByHand);
  assert('covered_by_order_refund is refused when the order still covers it, and on COD (NOT_COVERED)', () => {
    const a = planManualSettlement({ status: 'manual_required', amount: 300, method: 'covered_by_order_refund', stillReturnable: 300 });
    const b = planManualSettlement({ status: 'manual_required', amount: 300, method: 'covered_by_order_refund', stillReturnable: null });
    return !a.ok && a.refusal.code === 'not_covered' && !b.ok && b.refusal.code === 'not_covered';
  });

  // The customer's owed amount, before and after.
  const before = customerRefundPosition({ refundables: [300], ledger: [{ status: 'manual_required', amount: 300 }] });
  assert('⛔ a manual row is STILL OWED to the customer (owed 300, awaiting by hand 300) — the ledger claim is the system’s, not theirs', () =>
    before.owed === 300 && before.awaitingManual === 300 && before.returned === 0
    && outstandingCustomerRefund({ refundables: [300], ledger: [{ status: 'manual_required', amount: 300 }] }) === 0);
  const after = customerRefundPosition({ refundables: [300], ledger: [{ status: 'completed', amount: 300 }] });
  assert('settled → owed clears to 0, returned 300', () => after.owed === 0 && after.returned === 300 && after.awaitingManual === 0);
  const afterSplit = customerRefundPosition({ refundables: [300], ledger: [{ status: 'completed', amount: 200 }, { status: 'manual_required', amount: 100 }] });
  assert('after a partial cover: returned 200, owed 100 (the remainder row)', () => afterSplit.owed === 100 && afterSplit.returned === 200 && afterSplit.awaitingManual === 100);
  assert('a processing or failed attempt is still owed to the customer', () =>
    customerRefundPosition({ refundables: [500], ledger: [{ status: 'processing', amount: 200 }, { status: 'failed', amount: 300 }] }).owed === 500);
  assert('the order view: deliveryFeeRefund null when nothing was ever owed; owed clears once settled', () =>
    toCustomerDeliveryFeeRefund([{ _id: 'a', customer_fee_refundable: 0 }], []) === null
    && JSON.stringify(toCustomerDeliveryFeeRefund([{ _id: 'a', customer_fee_refundable: 300 }], [{ status: 'manual_required', amount: 300 }])) === '{"owed":300,"returned":0}'
    && JSON.stringify(toCustomerDeliveryFeeRefund([{ _id: 'a', customer_fee_refundable: 300 }], [{ status: 'completed', amount: 300 }])) === '{"owed":0,"returned":300}');

  assert('settle body: .strict(), method from the closed set — and NO settledBy/actor field (who comes from the headers)', () =>
    SettleDeliveryFeeRefundSchema.safeParse({ method: 'mobile_money', reference: 'MP123', note: 'sent' }).success
    && !SettleDeliveryFeeRefundSchema.safeParse({ method: 'paypal' }).success
    && !SettleDeliveryFeeRefundSchema.safeParse({ method: 'cash', settledBy: '64b000000000000000000001' }).success
    && !SettleDeliveryFeeRefundSchema.safeParse({}).success);
  assert('list query: status defaults to manual_required; settled / all accepted; unknown keys refused', () => {
    const d = ListManualDeliveryFeeRefundsQuerySchema.safeParse({});
    return d.success && d.data.status === 'manual_required' && d.data.page === 1 && d.data.limit === 20
      && ListManualDeliveryFeeRefundsQuerySchema.safeParse({ status: 'settled', orderId: '64b000000000000000000001' }).success
      && !ListManualDeliveryFeeRefundsQuerySchema.safeParse({ status: 'completed' }).success
      && !ListManualDeliveryFeeRefundsQuerySchema.safeParse({ foo: 1 }).success;
  });

  const adminSvc = src('src/modules/delivery-fee-proposals/services/delivery-fee-refund-admin.service.ts');
  const settleFn = adminSvc.slice(adminSvc.indexOf('async settle('), adminSvc.indexOf('private async closeTicketBestEffort('));
  assert('⛔ the settle write is a compare-and-set on status manual_required AND the amount read', () =>
    settleFn.includes("{ _id: row._id, status: 'manual_required', amount: row.amount }") && settleFn.includes("status: 'completed'"));
  assert('the settle runs in runInTransaction (NOT the retrying variant — the admin audit row is inside)', () =>
    settleFn.includes('transactionManager.runInTransaction(') && !settleFn.includes('runInTransactionWithRetry')
    && settleFn.indexOf('auditLogger.log(') > settleFn.indexOf('transactionManager.runInTransaction(')
    && settleFn.indexOf('auditLogger.log(') < settleFn.indexOf('return { settled, remainder };'));
  assert('a partial cover creates its remainder row IN the transaction, array form (session honoured)', () =>
    /DeliveryFeeRefundModel\.create\(\s*\[/.test(settleFn) && settleFn.includes('{ session }'));
  assert('the ticket and the customer are told only AFTER the commit; a cover sends no "refund sent"', () => {
    const commitEnd = settleFn.indexOf('return { settled, remainder };');
    return settleFn.indexOf('this.closeTicketBestEffort(') > commitEnd
      && settleFn.indexOf('customerFeeNotifier.refundSettled(') > commitEnd
      && settleFn.includes('if (plan.paidByHand)');
  });
  assert('the stillReturnable ceiling is the refund service’s (one definition) and COD has none', () =>
    settleFn.includes('this.refunds.refundableCapacity(order)') && settleFn.includes("order.payment_method === 'cash_on_delivery' ? null"));
  assert('a partial cover only NOTES the ticket; a full settle resolves it', () => {
    const t = adminSvc.slice(adminSvc.indexOf('private async closeTicketBestEffort('));
    return t.includes('if (remainderOwed > 0) return;') && t.includes('TicketStatus.RESOLVED') && t.includes('createSystemNote(');
  });
  assert('a ticket already resolved or CLOSED by hand is left where it is (the ticket service allows any transition)', () => {
    const t = adminSvc.slice(adminSvc.indexOf('private async closeTicketBestEffort('));
    return t.includes('current.status === TicketStatus.CLOSED')
      && t.indexOf('current.status === TicketStatus.CLOSED') < t.indexOf('ticketService.updateStatus(');
  });
  assert('the actor is stamped from the caller (actorFromRequest), never from the body', () => {
    const routes = src('src/modules/delivery-fee-proposals/admin-delivery-fee-refund.routes.ts');
    return routes.includes('actorFromRequest(req)') && !/req\.body\.(settledBy|actor)/.test(routes)
      && !routes.includes("headers['x-actor-tier']") && !/x-actor-tier/i.test(routes);
  });
  assert('mounted ONLY on the internal admin router, behind requireAdminCaller', () =>
    src('src/api/routes/internal-admin.routes.ts').includes("router.use('/delivery-fee-refunds', buildAdminDeliveryFeeRefundRouter([requireAdminCaller]));")
    && !src('src/api/index.ts').includes('buildAdminDeliveryFeeRefundRouter'));
  assert('routes: GET /, GET /:refundId, POST /:refundId/settle', () => {
    const r = src('src/modules/delivery-fee-proposals/admin-delivery-fee-refund.routes.ts');
    return r.includes("router.get('/', Controller.list)") && r.includes("router.get('/:refundId', Controller.getById)")
      && r.includes("router.post('/:refundId/settle', Controller.settle)");
  });
  assert('⛔ money paid by hand is subtracted from EVERY order refund ceiling (orchestrator + delivery refund capacity)', () => {
    const orchSrc = src('src/modules/payments/services/payment-orchestrator.service.ts');
    const ceiling = orchSrc.slice(orchSrc.indexOf('async sourceCeiling('), orchSrc.indexOf('private async refundableCeilingFor('));
    const cap = refundSvc.slice(refundSvc.indexOf('async refundableCapacity('), refundSvc.indexOf('private async claim('));
    return ceiling.includes('sumDeliveryRefundsPaidByHand(') && cap.includes('sumDeliveryRefundsPaidByHand(');
  });
  assert('…and only PAYING settlements count (a cover moved no money)', () => {
    const model = src('src/modules/delivery-fee-proposals/models/delivery-fee-refund.model.ts');
    return model.includes("'settlement.method': { $in: [...MANUAL_REFUND_PAYMENT_METHODS] }") && model.includes("status: 'completed'");
  });
  assert('the customer read reports the CUSTOMER position (owed / returned / awaitingManual)', () => {
    const svc = src('src/modules/delivery-fee-proposals/services/delivery-fee-proposal.service.ts');
    return svc.includes('owed: refundState.position.owed') && svc.includes('awaitingManual: refundState.position.awaitingManual');
  });

  // ───────────────────────────────────────────────────────────────────────────
  section('16. W-E2 — the change of agency is ONE transaction (D-12) → its own suite');
  // The boundary, the session threading, the concurrency guard and the post-commit effects are
  // pinned by `npm run test:change-agency-tx` (DB-free) and `npm run verify:change-agency-tx`
  // (replica set: the rollback and the race). Kept apart so two workstreams' suites do not
  // collide in one file.
  assert('the change-of-agency suites are registered', () => {
    const pkg = JSON.parse(raw('package.json'));
    return typeof pkg.scripts['test:change-agency-tx'] === 'string' && typeof pkg.scripts['verify:change-agency-tx'] === 'string';
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
