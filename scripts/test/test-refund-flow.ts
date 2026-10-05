/**
 * test:refund-flow — the refund request's pure rules and wiring, offline (REFUND-FLOW-PLAN R1–R3).
 *
 *   1. Fee maths (D-3)            — half up, whole XAF, integer arithmetic; card → 0
 *   2. Attribution (C-1, D-5)     — the whole table, and goods-first partials
 *   3. Destination (R-7, D-6)     — payer, normalisation, typed + proof, COD/billing, card
 *   4. Transfer plan (§ 3.2)      — one number → one transfer; two → two; nets sum exactly
 *   5. Status machine (§ 3.1)     — every edge; ⛔ `sending → rejected` refused
 *   6. Approval rules (R-2, R-7)  — the second approver; who may approve at creation
 *   7. Proof rules (R-7, R-7b)    — typed destination and external settlement, incl. the service
 *   8. Merchant reference `rf`    — the second money-OUT kind
 *   9. ⛔ `rf` direction          — all five mobile adapters read an `rf` callback as a PAYOUT
 *  10. Gateway refunds (R-1)      — Stripe implements one; NotchPay's is GONE; no mobile adapter has one
 *  11. Ports (§ 11.2)             — a missing port THROWS, never skips
 *  12. Payment settings (§ 11.6)  — `refund_fee_percent`: default 2, bounds, the PUT schema
 *  13. Source scans               — the structural invariants nothing behavioural can see
 *  14. Review fixes (2026-10-05)  — settle-external remainder, billing reversal, the completion
 *                                   marker + sweep, pause compensation, COD re-check, ceiling
 *                                   re-checks, the manual-resume guard, the DTO
 *
 * DB-free and network-free. Run: npm run test:refund-flow
 */

process.env.LOG_STDOUT = 'false';

// TYPE-ONLY: the dev-tools route reaches the admin-caller middleware, which uses `req.auth` /
// `req.requestId` declared by `declare global` blocks in these modules (see test:admin-payment-settings).
import type {} from '../../src/api/middlewares/auth.middleware';
import type {} from '../../src/api/middlewares/request-id.middleware';
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { computeRefundFee, refundFeeFor, rateToBasisPoints } from '../../src/modules/payments/domain/refund-fee';
import {
  attributeRefund,
  deliveryRefundable,
  maxAttributable,
  AttributionInput,
} from '../../src/modules/payments/domain/refund-attribution';
import {
  normalizeRefundPhone,
  resolveRefundDestination,
  maskRefundPhone,
} from '../../src/modules/payments/domain/refund-destination';
import {
  largestRemainderSplit,
  planPaymentLegShares,
  planSettleRemainder,
  planTransfers,
} from '../../src/modules/payments/domain/refund-transfer-plan';
import {
  aggregateLegStatus,
  canClaim,
  canReject,
  canSettleExternally,
  canTransition,
  externalSettlementMissingProof,
  mayApproveAtCreation,
  OPEN_REFUND_STATUSES,
  REFUND_REQUEST_STATUSES,
  secondApproverRequired,
  typedDestinationMissingProof,
} from '../../src/modules/payments/domain/refund-status';
import {
  __resetRefundPortsForTests,
  collectionFullyCovered,
  getCodCoveragePort,
  getRefundEarningsPort,
  registerRefundPorts,
} from '../../src/modules/payments/domain/refund-ports';
import {
  isMoneyOutKind,
  isMoneyOutRef,
  merchantRefKind,
  mintMerchantRef,
} from '../../src/modules/payments/domain/merchant-reference';
import { CinetPayGateway, toCinetpayMerchantId, fromCinetpayMerchantId } from '../../src/modules/payments/gateways/cinetpay.gateway';
import { fapshiEventFrom, FapshiGateway } from '../../src/modules/payments/gateways/fapshi.gateway';
import { CampayGateway } from '../../src/modules/payments/gateways/campay.gateway';
import { MyCoolPayGateway } from '../../src/modules/payments/gateways/mycoolpay.gateway';
import { NotchPayGateway } from '../../src/modules/payments/gateways/notchpay.gateway';
import {
  PAYMENT_GATEWAYS,
  gatewayImplementsRefund,
  gatewaySupportsRefund,
} from '../../src/modules/payments/gateways/registry';
import {
  DEFAULT_PAYMENT_SETTINGS,
  isValidRefundFeePercent,
  REFUND_FEE_PERCENT_DEFAULT,
} from '../../src/modules/payments/domain/payment-routing';
import { SetPaymentSettingsSchema } from '../../src/modules/dev-tools/payment-settings.routes';
import { refundRequestService } from '../../src/modules/payments/services/refund-request.service';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    originalConsole.log(`  ✅ ${name}`);
    passed++;
  } else {
    originalConsole.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError: ${(e as Error).message}`;
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : `non-AppError: ${(e as Error).message}`;
  }
}

const src = (p: string) => readFileSync(join(__dirname, '..', '..', 'src', p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main(): Promise<void> {
  // ── 1 ──────────────────────────────────────────────────────────────────────
  section('1. Fee maths (D-3): round half up, whole XAF; card → 0');

  assert('5000 at 2% → fee 100, the customer receives 4900 (the owner\'s example)', () => {
    const f = computeRefundFee(5000, 2, 'mobile_money');
    return f.feeAmount === 100 && f.netAmount === 4900 && f.feeRate === 2;
  });
  assert('a card refund carries NO fee, whatever the rate', () => {
    const f = computeRefundFee(5000, 2, 'card');
    return f.feeAmount === 0 && f.netAmount === 5000 && f.feeRate === 0;
  });
  assert('half rounds UP: 25 at 2% (0.5) → 1', () => refundFeeFor(25, 2) === 1);
  assert('below half rounds down: 24 at 2% (0.48) → 0', () => refundFeeFor(24, 2) === 0);
  assert('fractional rate: 1234 at 2.5% (30.85) → 31', () => refundFeeFor(1234, 2.5) === 31);
  assert('a rate of 0 → no fee', () => refundFeeFor(5000, 0) === 0 && computeRefundFee(5000, 0, 'cod').netAmount === 5000);
  assert('COD, billing and mobile money all carry the fee (D-1)', () =>
    (['cod', 'billing', 'mobile_money'] as const).every((c) => computeRefundFee(10_000, 2, c).feeAmount === 200));
  assert('fee + net === gross for many amounts and rates', () => {
    for (let amount = 1; amount < 3000; amount += 37) {
      for (const rate of [0.5, 1, 2, 2.5, 7, 20]) {
        const f = computeRefundFee(amount, rate, 'mobile_money');
        if (f.feeAmount + f.netAmount !== amount || f.feeAmount < 0) return false;
      }
    }
    return true;
  });
  assert('the rate is held in basis points (2.5 → 250), so the product is an exact integer', () =>
    rateToBasisPoints(2.5) === 250 && rateToBasisPoints(2) === 200);

  // ── 2 ──────────────────────────────────────────────────────────────────────
  section('2. Attribution (C-1, D-5): who gets delivery money back');

  const base: AttributionInput = {
    reasonKind: 'return',
    returnShippingPayer: 'customer',
    itemDefective: null,
    goodsAmount: 5000,
    deliveryAmountPaid: 1000,
    delivered: true,
  };
  const table: Array<[string, Partial<AttributionInput>, boolean]> = [
    ['cancellation before delivery → delivery refunded (D-5)', { reasonKind: 'cancellation', delivered: false }, true],
    ['cancellation, whatever the setting', { reasonKind: 'cancellation', returnShippingPayer: 'customer' }, true],
    ['return, vendor pays return shipping → refunded', { returnShippingPayer: 'vendor' }, true],
    ['return, customer pays → NOT refunded', { returnShippingPayer: 'customer' }, false],
    ['return, reimbursed-if-defect, defective ticked → refunded', { returnShippingPayer: 'customer_reimbursed_if_defect', itemDefective: true }, true],
    ['return, reimbursed-if-defect, not ticked → NOT refunded', { returnShippingPayer: 'customer_reimbursed_if_defect', itemDefective: false }, false],
    ['return, reimbursed-if-defect, unanswered → NOT refunded', { returnShippingPayer: 'customer_reimbursed_if_defect', itemDefective: null }, false],
    ['return, no setting at all → read as customer → NOT refunded', { returnShippingPayer: null }, false],
    ['goodwill on a DELIVERED order follows the setting', { reasonKind: 'goodwill', returnShippingPayer: 'customer' }, false],
    ['goodwill BEFORE delivery → refunded', { reasonKind: 'goodwill', delivered: false }, true],
    ['dispute settlement, delivered, vendor pays → refunded', { reasonKind: 'dispute_settlement', returnShippingPayer: 'vendor' }, true],
  ];
  for (const [name, patch, expected] of table) {
    assert(name, () => deliveryRefundable({ ...base, ...patch }) === expected);
  }
  assert('max = goods + delivery when refundable, goods alone otherwise', () =>
    maxAttributable({ ...base, returnShippingPayer: 'vendor' }) === 6000 && maxAttributable(base) === 5000);
  assert('a full refund attributes { goods, delivery } summing to the amount', () => {
    const a = attributeRefund({ ...base, returnShippingPayer: 'vendor' });
    return a !== null && a.goods === 5000 && a.delivery === 1000;
  });
  assert('a partial is GOODS FIRST: 3000 → { 3000, 0 }; 5500 → { 5000, 500 }', () => {
    const v = { ...base, returnShippingPayer: 'vendor' as const };
    const a = attributeRefund(v, 3000);
    const b = attributeRefund(v, 5500);
    return a?.goods === 3000 && a.delivery === 0 && b?.goods === 5000 && b.delivery === 500;
  });
  assert('an amount above the rule is refused (null), never silently trimmed', () => attributeRefund(base, 5001) === null);

  // ── 3 ──────────────────────────────────────────────────────────────────────
  section('3. Destination (R-7, D-6)');

  assert('E.164 stays as stored', () => normalizeRefundPhone('+237677123456') === '+237677123456');
  assert('bare international digits (bot numbers) are normalised to E.164', () => normalizeRefundPhone('237677123456') === '+237677123456');
  assert('a 9-digit Cameroon mobile is normalised to +237', () => normalizeRefundPhone('677 12 34 56') === '+237677123456');
  assert('00-prefixed international is normalised', () => normalizeRefundPhone('00237677123456') === '+237677123456');
  assert('garbage reads as no number', () => normalizeRefundPhone('call me') === null && normalizeRefundPhone('') === null);
  assert('mobile money → the number that paid, source payer', () => {
    const v = resolveRefundDestination({ paymentChannel: 'mobile_money', payerLegs: [{ phone: '237677123456', name: 'Aunt Marie' }] });
    return v.kind === 'resolved' && v.destination.phone === '+237677123456' && v.destination.source === 'payer' && v.destination.name === 'Aunt Marie';
  });
  assert('a leg with NO stored number → no destination (needs a typed one)', () => {
    const v = resolveRefundDestination({ paymentChannel: 'mobile_money', payerLegs: [{ phone: '+237677123456', name: null }, { phone: null, name: null }] });
    return v.kind === 'refused' && v.reason === 'no_destination';
  });
  assert('COD and billing have no paying number → no destination', () =>
    (['cod', 'billing'] as const).every((c) => {
      const v = resolveRefundDestination({ paymentChannel: c, payerLegs: [] });
      return v.kind === 'refused' && v.reason === 'no_destination';
    }));
  assert('a card refund goes back to the card (no destination)', () =>
    resolveRefundDestination({ paymentChannel: 'card', payerLegs: [] }).kind === 'card');
  assert('a TYPED number without proof is refused (proof_required)', () => {
    const v = resolveRefundDestination({ paymentChannel: 'cod', payerLegs: [], typed: { phone: '+237699000111' } });
    return v.kind === 'refused' && v.reason === 'proof_required';
  });
  assert('a TYPED number that cannot be read is refused, never guessed', () => {
    const v = resolveRefundDestination({ paymentChannel: 'cod', payerLegs: [], typed: { phone: '12' }, proofFileId: 'x' });
    return v.kind === 'refused' && v.reason === 'typed_phone_invalid';
  });
  assert('a typed number WITH proof resolves, source typed — and wins over the payer', () => {
    const v = resolveRefundDestination({
      paymentChannel: 'mobile_money',
      payerLegs: [{ phone: '+237677123456', name: 'Payer' }],
      typed: { phone: '699000111', name: 'Customer' },
      proofFileId: '65f000000000000000000001',
    });
    return v.kind === 'resolved' && v.destination.source === 'typed' && v.destination.phone === '+237699000111';
  });
  assert('masking keeps only the last three digits', () => maskRefundPhone('+237677123456')?.endsWith('456') === true
    && !maskRefundPhone('+237677123456')!.includes('677'));

  // ── 4 ──────────────────────────────────────────────────────────────────────
  section('4. Transfer plan (§ 3.2): one transfer per paying number');

  assert('largest remainder sums exactly and is deterministic', () => {
    const s = largestRemainderSplit(100, [1, 1, 1]);
    return s.reduce((a, b) => a + b, 0) === 100 && s[0] === 34 && s[1] === 33 && s[2] === 33;
  });
  const legs = [
    { id: 'p', purpose: 'primary' as const, remaining: 5000, payerPhone: '+237677000001' },
    { id: 't', purpose: 'order_delivery_topup' as const, remaining: 1000, payerPhone: '237677000001' },
  ];
  assert('the payment-leg plan reuses planRefundLegs (primary first)', () => {
    const p = planPaymentLegShares(legs, 5500);
    return p !== null && p[0].paymentTransactionId === 'p' && p[0].amount === 5000 && p[1].amount === 500;
  });
  assert('both legs paid from the SAME number (two spellings) → ONE transfer for the total', () => {
    const shares = planPaymentLegShares(legs, 6000)!;
    const t = planTransfers(shares, 120, null)!;
    return t.length === 1 && t[0].phone === '+237677000001' && t[0].gross === 6000 && t[0].amount === 5880;
  });
  assert('DIFFERENT numbers → one transfer per number, nets summing exactly to the net', () => {
    const shares = planPaymentLegShares([legs[0], { ...legs[1], payerPhone: '+237699000002' }], 6000)!;
    const t = planTransfers(shares, 121, null)!;
    return t.length === 2 && t.reduce((s, x) => s + x.amount, 0) === 6000 - 121 && t.reduce((s, x) => s + x.gross, 0) === 6000;
  });
  assert('a typed number → ONE transfer whatever the legs', () => {
    const shares = planPaymentLegShares([legs[0], { ...legs[1], payerPhone: '+237699000002' }], 6000)!;
    const t = planTransfers(shares, 120, '+237655000003')!;
    return t.length === 1 && t[0].phone === '+237655000003' && t[0].amount === 5880;
  });
  assert('a share with no readable number and no destination → null (refused upstream)', () =>
    planTransfers([{ paymentTransactionId: 'x', purpose: 'primary', amount: 10, payerPhone: null }], 0, null) === null);

  // ── 5 ──────────────────────────────────────────────────────────────────────
  section('5. Status machine (§ 3.1)');

  assert('⛔ sending → rejected is REFUSED', () => !canTransition('sending', 'rejected') && !canReject('sending'));
  assert('reject only from awaiting_approval or failed', () =>
    REFUND_REQUEST_STATUSES.filter((s) => canReject(s)).join() === 'awaiting_approval,failed');
  assert('settle externally never from sending (nor from a terminal status)', () =>
    !canSettleExternally('sending') && !canSettleExternally('completed') && !canSettleExternally('rejected')
    && ['awaiting_approval', 'approved', 'waiting_for_cash', 'failed'].every((s) => canSettleExternally(s as any)));
  assert('claim only from approved or failed (retry reuses the reference)', () =>
    REFUND_REQUEST_STATUSES.filter((s) => canClaim(s)).join() === 'approved,failed');
  assert('the COD loop: approved → waiting_for_cash → approved', () =>
    canTransition('approved', 'waiting_for_cash') && canTransition('waiting_for_cash', 'approved'));
  assert('sending → completed | failed; failed → sending (retry)', () =>
    canTransition('sending', 'completed') && canTransition('sending', 'failed') && canTransition('failed', 'sending'));
  assert('completed and rejected are terminal', () =>
    REFUND_REQUEST_STATUSES.every((s) => !canTransition('completed', s) && !canTransition('rejected', s)));
  assert('the open set is exactly the partial-unique-index set', () =>
    OPEN_REFUND_STATUSES.join() === 'awaiting_approval,approved,waiting_for_cash,sending,failed');
  assert('leg aggregate: any sending → sending; all succeeded → completed; else failed', () =>
    aggregateLegStatus(['succeeded', 'sending']) === 'sending'
    && aggregateLegStatus(['succeeded', 'succeeded']) === 'completed'
    && aggregateLegStatus(['succeeded', 'failed']) === 'failed'
    && aggregateLegStatus(['succeeded', 'pending']) === 'failed'
    && aggregateLegStatus([]) === 'failed');

  // ── 6 ──────────────────────────────────────────────────────────────────────
  section('6. Approval rules (R-2, R-7)');

  assert('a TYPED number approved by the one who typed it → second approver required', () =>
    secondApproverRequired({ destinationSource: 'typed', requestedById: 'a1', approverId: 'a1' }));
  assert('a typed number approved by someone else → fine', () =>
    !secondApproverRequired({ destinationSource: 'typed', requestedById: 'a1', approverId: 'a2' }));
  assert('an approver with no id never counts as the second one', () =>
    secondApproverRequired({ destinationSource: 'typed', requestedById: 'a1', approverId: null }));
  assert('the payer\'s own number needs no second approver', () =>
    !secondApproverRequired({ destinationSource: 'payer', requestedById: 'a1', approverId: 'a1' }));
  const at = (o: Partial<Parameters<typeof mayApproveAtCreation>[0]>) =>
    mayApproveAtCreation({ requestedByRole: 'system', approveNow: true, destinationSource: 'payer', overridePolicy: false, paymentChannel: 'mobile_money', ...o });
  assert('system, payer, within policy, mobile money → automatic', () => at({}));
  assert('Support never approves (may hold, never send)', () => !at({ requestedByRole: 'support' }));
  assert('any COD refund needs approval', () => !at({ paymentChannel: 'cod' }));
  assert('a policy override needs approval', () => !at({ overridePolicy: true, requestedByRole: 'vendor' }));
  assert('a typed number is never approved at creation, even by an admin', () =>
    !at({ requestedByRole: 'admin', destinationSource: 'typed' }));
  assert('an admin with approveNow IS the approver (COD included)', () => at({ requestedByRole: 'admin', paymentChannel: 'cod' }));
  assert('without approveNow nothing is automatic', () => !at({ approveNow: false }));

  // ── 7 ──────────────────────────────────────────────────────────────────────
  section('7. Proof rules (R-7, R-7b)');

  assert('typed destination without proof → missing', () => typedDestinationMissingProof('typed', null));
  assert('payer destination needs no proof', () => !typedDestinationMissingProof('payer', null));
  assert('external settlement without proof → missing', () => externalSettlementMissingProof(null) && !externalSettlementMissingProof('f1'));
  await assertAsync('settleExternal refuses a missing proof with REFUND_EXTERNAL_PROOF_REQUIRED before touching the DB', async () =>
    (await asyncCodeOf(() => refundRequestService.settleExternal('65f000000000000000000001', { method: 'cash', proofFileId: null }, { id: 'a', name: 'A' })))
      === ERROR_CODES.REFUND_EXTERNAL_PROOF_REQUIRED);

  // ── 8 ──────────────────────────────────────────────────────────────────────
  section('8. Merchant reference `rf` — the second money-OUT kind');

  const rf = mintMerchantRef('rf');
  assert('mint("rf") → jm_rf_<32 hex>, read back as rf', () => /^jm_rf_[0-9a-f]{32}$/.test(rf) && merchantRefKind(rf) === 'rf');
  assert('po and rf are money out; pt / pp / ct are not', () =>
    isMoneyOutKind('po') && isMoneyOutKind('rf') && !isMoneyOutKind('pt') && !isMoneyOutKind('pp') && !isMoneyOutKind('ct')
    && isMoneyOutRef(rf) && isMoneyOutRef(mintMerchantRef('po')) && !isMoneyOutRef(mintMerchantRef('pt')) && !isMoneyOutRef(null));
  assert('CinetPay\'s compact merchant id round-trips an rf reference (30-char cap)', () => {
    const id = toCinetpayMerchantId(rf);
    return id !== null && id.length <= 30 && id.startsWith('jmrf') && fromCinetpayMerchantId(id) === rf;
  });

  // ── 9 ──────────────────────────────────────────────────────────────────────
  section('9. ⛔ An `rf` callback is a PAYOUT on all five mobile adapters');

  assert('CinetPay: direction from OUR reference — rf → payout (it used to be `=== po` only)', () => {
    const e = new CinetPayGateway().parseWebhookEvent({ transaction_id: 'cp-1', merchant_transaction_id: toCinetpayMerchantId(rf) });
    return e?.direction === 'payout' && e.merchantRef === rf;
  });
  assert('Fapshi: with no transType, an rf reference → payout', () => {
    const e = fapshiEventFrom({ transId: 'fp-1', status: 'SUCCESSFUL', externalId: rf }, null);
    return e?.direction === 'payout' && e.merchantRef === rf;
  });
  assert('Fapshi (adapter entry point) agrees', () =>
    new FapshiGateway().parseWebhookEvent({ transId: 'fp-2', status: 'FAILED', externalId: rf })?.direction === 'payout');
  assert('Campay: a withdraw carrying an rf reference → payout, merchantRef kept', () => {
    const e = new CampayGateway().parseWebhookEvent({ reference: 'cm-1', status: 'SUCCESSFUL', endpoint: 'withdraw', external_reference: rf });
    return e?.direction === 'payout' && e.merchantRef === rf && e.status === 'SUCCEEDED';
  });
  assert('My-CoolPay: a PAYOUT transaction carrying an rf reference → payout', () => {
    const e = new MyCoolPayGateway().parseWebhookEvent({ transaction_ref: 'mc-1', transaction_type: 'PAYOUT', transaction_status: 'SUCCESS', app_transaction_ref: rf });
    return e?.direction === 'payout' && e.merchantRef === rf;
  });
  assert('NotchPay: a transfer.* event carrying an rf reference → payout, OUR ref read from `reference`', () => {
    const e = new NotchPayGateway().parseWebhookEvent({ type: 'transfer.complete', data: { id: 'trf_1', reference: rf, status: 'complete' } });
    return e?.direction === 'payout' && e.merchantRef === rf && e.gatewayRef === 'trf_1';
  });
  assert('and a collection reference still reads as a collection (CinetPay, Fapshi)', () => {
    const pt = mintMerchantRef('pt');
    return new CinetPayGateway().parseWebhookEvent({ transaction_id: 'cp-2', merchant_transaction_id: toCinetpayMerchantId(pt) })?.direction === 'collection'
      && fapshiEventFrom({ transId: 'fp-3', status: 'SUCCESSFUL', externalId: pt }, null)?.direction === 'collection';
  });

  // ── 10 ─────────────────────────────────────────────────────────────────────
  section('10. Gateway refunds (R-1): Stripe only');

  assert('Stripe implements refundPayment and supports it', () => gatewayImplementsRefund('STRIPE') && gatewaySupportsRefund('STRIPE'));
  assert('NotchPay refundPayment and refundAvailable are ABSENT', () => {
    const g = PAYMENT_GATEWAYS.get('NOTCHPAY') as any;
    return typeof g.refundPayment === 'undefined' && typeof g.refundAvailable === 'undefined' && !gatewaySupportsRefund('NOTCHPAY');
  });
  assert('no mobile adapter refunds through its API — every one is a payout', () =>
    (['NOTCHPAY', 'MYCOOLPAY', 'CAMPAY', 'CINETPAY', 'FAPSHI'] as const).every((n) => !gatewayImplementsRefund(n)));
  assert('the set of refundable gateways is exactly [STRIPE]', () =>
    [...PAYMENT_GATEWAYS.keys()].filter((n) => gatewaySupportsRefund(n)).join() === 'STRIPE');

  // ── 11 ─────────────────────────────────────────────────────────────────────
  section('11. Ports (§ 11.2): a missing port THROWS');

  __resetRefundPortsForTests();
  assert('getRefundEarningsPort without registration → REFUND_PORT_NOT_REGISTERED', () =>
    codeOf(() => getRefundEarningsPort()) === ERROR_CODES.REFUND_PORT_NOT_REGISTERED);
  assert('getCodCoveragePort without registration → REFUND_PORT_NOT_REGISTERED', () =>
    codeOf(() => getCodCoveragePort()) === ERROR_CODES.REFUND_PORT_NOT_REGISTERED);
  const earningsStub = { onRequestOpened: async () => {}, onRequestClosedWithoutRefund: async () => {}, onRefundCompleted: async () => {} };
  registerRefundPorts({ earnings: earningsStub });
  assert('registration is partial: earnings registered, COD still throws', () =>
    getRefundEarningsPort() === earningsStub && codeOf(() => getCodCoveragePort()) === ERROR_CODES.REFUND_PORT_NOT_REGISTERED);
  __resetRefundPortsForTests();
  await assertAsync('create() for an order fails on the missing port — never silently skips', async () => {
    // A bad id is refused first; a well-formed one would need a DB, so assert the ordering in source instead.
    const s = stripComments(src('modules/payments/services/refund-request.service.ts'));
    const portAt = s.indexOf('getRefundEarningsPort()');
    const createAt = s.indexOf('this.repo.create(');
    return portAt > 0 && createAt > portAt;
  });
  assert('COD coverage means the cash REACHED the platform: settled ≥ expected AND settledAt', () =>
    collectionFullyCovered({ collectionId: 'c', shipmentId: 's', kind: 'order', expected: 100, settled: 100, settledAt: new Date(), status: 'collected' })
    && !collectionFullyCovered({ collectionId: 'c', shipmentId: 's', kind: 'order', expected: 100, settled: 60, settledAt: null, status: 'collected' })
    && !collectionFullyCovered({ collectionId: 'c', shipmentId: 's', kind: 'order', expected: 100, settled: 100, settledAt: null, status: 'collected' }));

  // ── 12 ─────────────────────────────────────────────────────────────────────
  section('12. Payment settings (§ 11.6): refund_fee_percent');

  assert('the default is 2', () => DEFAULT_PAYMENT_SETTINGS.refund_fee_percent === 2 && REFUND_FEE_PERCENT_DEFAULT === 2);
  assert('bounds 0..20, finite numbers only', () =>
    isValidRefundFeePercent(0) && isValidRefundFeePercent(20) && isValidRefundFeePercent(2.5)
    && !isValidRefundFeePercent(-1) && !isValidRefundFeePercent(20.1) && !isValidRefundFeePercent(NaN) && !isValidRefundFeePercent('2'));
  assert('PUT accepts refundFeePercent and refuses 21', () =>
    SetPaymentSettingsSchema.safeParse({ refundFeePercent: 3, expectedVersion: 1, reason: 'x' }).success
    && !SetPaymentSettingsSchema.safeParse({ refundFeePercent: 21, expectedVersion: 1, reason: 'x' }).success);

  // ── 13 ─────────────────────────────────────────────────────────────────────
  section('13. Source scans — structural invariants');

  const model = src('modules/payments/models/refund-request.model.ts');
  assert('refund_requests declares the partial unique index refund_one_open_per_source over the OPEN statuses', () =>
    /name:\s*'refund_one_open_per_source'/.test(model) && /unique:\s*true/.test(model) && /OPEN_REFUND_STATUSES/.test(model));
  const repo = stripComments(src('modules/payments/repositories/refund-request.repository.ts'));
  assert('the claim reuses the reference and the gateway ($ifNull) and narrows on approved|failed', () =>
    /transfer_reference:\s*\{\s*\$ifNull:\s*\['\$transfer_reference'/.test(repo)
    && /transfer_gateway:\s*\{\s*\$ifNull:\s*\['\$transfer_gateway'/.test(repo)
    && /CLAIMABLE_STATUSES/.test(repo));
  assert('creates use the ARRAY form (the only one Mongoose runs inside a session)', () =>
    /RefundRequestModel\.create\(\[doc\]/.test(repo)
    && /RefundTransactionModel\.create\(\[doc\]/.test(src('modules/payments/services/refund-ledger.ts')));
  const orch = stripComments(src('modules/payments/services/payment-orchestrator.service.ts'));
  assert('the orchestrator no longer reverses earnings (§ 6.3: completion owns recovery)', () =>
    !/earningsRefundService/.test(orch));
  // Decision 9 reversed by the entry-points workstream (2026-10-05, § 6.2): the BALANCE payment
  // is a leg too — still purpose-filtered, so nothing but the booking's own two charges is read.
  assert('booking legs are PURPOSE-filtered: the primary charge AND the balance payment', () =>
    /bookingId:\s*new Types\.ObjectId\(source\.bookingId\),\s*status:\s*'SUCCEEDED',\s*purpose:\s*\{\s*\$in:\s*\['primary', 'booking_balance', null\]\s*\}/.test(orch));
  const proc = stripComments(src('modules/payments/services/webhook-processor.service.ts'));
  assert('the processor routes rf by PREFIX to the refund branch, before the payout branch', () => {
    const rfAt = proc.indexOf("if (kind === 'rf') return this.settleRefund(");
    return rfAt > 0 && rfAt < proc.indexOf('return this.settlePayout(event, gateway)');
  });
  assert('the refund settle requires the callback gateway to be the stored transfer_gateway', () =>
    /refund\.transfer_gateway !== routeGateway/.test(proc));
  assert('CinetPay and Fapshi no longer test `=== \'po\'` for direction', () =>
    !/merchantRefKind\(merchantRef\) === 'po'/.test(stripComments(src('modules/payments/gateways/cinetpay.gateway.ts')))
    && !/merchantRefKind\(merchantRef\) === 'po'/.test(stripComments(src('modules/payments/gateways/fapshi.gateway.ts'))));
  assert('the reconciliation sweep includes refund legs, through applyTransferOutcome', () => {
    const w = stripComments(src('modules/earnings/workers/payout-reconciliation.worker.ts'));
    return /refundRequestRepository\.findStuckSending/.test(w) && /refundRequestService\.applyTransferOutcome/.test(w);
  });
  assert('NOTCHPAY_REFUNDS_ENABLED is read nowhere', () =>
    !/NOTCHPAY_REFUNDS_ENABLED/.test(src('modules/payments/config/payments.config.ts'))
    && !/NOTCHPAY_REFUNDS_ENABLED/.test(src('config/env.ts')));
  const svc = stripComments(src('modules/payments/services/refund-request.service.ts'));
  assert('a pre-claim refusal (payouts off, short float) is checked BEFORE the claim', () => {
    const payoutAt = svc.indexOf('private async sendPayout');
    const body = svc.slice(payoutAt);
    return body.indexOf('REFUND_PAYOUT_UNAVAILABLE') < body.indexOf('this.repo.beginTransfer(')
      && body.indexOf('REFUND_INSUFFICIENT_GATEWAY_BALANCE') < body.indexOf('this.repo.beginTransfer(');
  });

  // ── 14. Review fixes (2026-10-05) ─────────────────────────────────────────────
  originalConsole.log('\n14. Review fixes');
  const methodOf = (code: string, sig: string): string => {
    const at = code.indexOf(sig);
    if (at < 0) return '';
    const rest = code.slice(at + sig.length);
    const next = rest.search(/\n {2}(?:async |private |static |public )?[a-zA-Z_]+\s*\(/);
    return next < 0 ? rest : rest.slice(0, next);
  };

  // Finding 4 — settle-external after a partly-sent multi-transfer refund pays only the remainder.
  const twoNumbers = {
    grossAmount: 10_000, netAmount: 9_800, feeAmount: 200, destinationSource: 'payer' as const,
    paymentLegs: [
      { amount: 7_000, payerPhone: '+237677000001', refunded: false },
      { amount: 3_000, payerPhone: '+237677000002', refunded: false },
    ],
    transferLegs: [
      { phone: '+237677000001', gross: 7_000, amount: 6_860, status: 'succeeded' },
      { phone: '+237677000002', gross: 3_000, amount: 2_940, status: 'failed' },
    ],
  };
  assert('finding 4: one of two transfers succeeded → only the other is paid by hand', () => {
    const p = planSettleRemainder(twoNumbers);
    return p.legs[0].channel === 'payout' && p.legs[1].channel === 'external'
      && p.paidGross === 7_000 && p.paidNet === 6_860 && p.remainderGross === 3_000 && p.remainderNet === 2_940;
  });
  assert('finding 4: the parts\' fees and nets add up EXACTLY to the request', () => {
    const p = planSettleRemainder(twoNumbers);
    const fees = p.legs.reduce((s, l) => s + l.fee, 0);
    return fees === 200 && p.paidNet + p.remainderNet === 9_800 && p.legs[0].fee === 140 && p.legs[1].fee === 60;
  });
  assert('finding 4: nothing sent → the whole request is external', () => {
    const p = planSettleRemainder({ ...twoNumbers, transferLegs: twoNumbers.transferLegs.map((t) => ({ ...t, status: 'failed' })) });
    return p.legs.every((l) => l.channel === 'external') && p.remainderGross === 10_000 && p.remainderNet === 9_800;
  });
  assert('finding 4: a card leg Stripe refunded stays card_refund; the rest is the remainder', () => {
    const p = planSettleRemainder({
      grossAmount: 5_000, netAmount: 5_000, feeAmount: 0, destinationSource: null,
      paymentLegs: [{ amount: 4_000, payerPhone: null, refunded: true }, { amount: 1_000, payerPhone: null, refunded: false }],
      transferLegs: [],
    });
    return p.legs[0].channel === 'card_refund' && p.legs[1].channel === 'external' && p.remainderGross === 1_000 && p.remainderNet === 1_000;
  });
  assert('finding 4: settleExternal records only the remainder and refuses when nothing is left', () => {
    const body = methodOf(svc, 'async settleExternal(');
    return /settleRemainderOf\(row\)/.test(body) && /remainderGross <= 0/.test(body)
      && /gross_amount:\s*split\.remainderGross/.test(body) && /net_amount:\s*split\.remainderNet/.test(body);
  });
  assert('finding 4: completion writes each payment leg with the channel its money left through', () => {
    const body = methodOf(svc, 'async complete(');
    return /opts\.channel === 'external' \? settleRemainderOf\(fresh\)/.test(body)
      && /channel:\s*byHand \? byHand\.legs\[i\]\.channel : opts\.channel/.test(body);
  });
  assert('finding 4: payment.refunded names the hand-paid remainder (and the total beside it)', () => {
    const body = methodOf(svc, 'async complete(');
    return /amount:\s*handPaid \? handPaid\.net : completed\.net_amount/.test(body) && /totalNetAmount:\s*completed\.net_amount/.test(body);
  });
  assert('reject keeps its "part already paid" guard', () =>
    /transfer_legs\.some\(\(l\) => l\.status === 'succeeded'\) \|\| row\.payment_legs\.some\(\(l\) => l\.refunded\)/.test(methodOf(svc, 'async reject(')));

  // Finding 2 — billing refunds reverse what was bought.
  assert('finding 2: a partial billing refund is refused (billing_full_refund_only)', () => {
    const body = methodOf(svc, 'async create(');
    return /facts\.paymentChannel === 'billing' && gross !== facts\.remaining/.test(body) && /'billing_full_refund_only'/.test(body);
  });
  assert('finding 2: completion reverses the plan / the credits, then stamps billing_reversed_at', () => {
    const body = methodOf(svc, 'async settleAftermath(');
    const rev = methodOf(svc, 'private async reverseBillingBenefit(');
    return /reverseBillingBenefit\(row\)/.test(body) && /'billing_reversed_at'/.test(body)
      && /planPurchaseService\.reverseById\(/.test(rev) && /creditTopupService\.reverseTopup\(row\.source_id\.toString\(\), 'refund'\)/.test(rev);
  });
  assert('finding 2: plan reversal by id unwinds BEFORE the status flips (retry-safe)', () => {
    const plan = stripComments(src('modules/billing/services/plan-purchase.service.ts'));
    const body = methodOf(plan, 'private async reverseLoaded(');
    return /async reverseById\(/.test(plan) && body.indexOf('downgradeToFree') > -1
      && body.indexOf('downgradeToFree') < body.indexOf("setStatus(purchase._id, 'reversed')");
  });

  // Finding 6 — the post-completion step is marked on the request and swept nightly.
  assert('finding 6: complete() runs settleAftermath after commit (no inline fire-and-forget port call)', () => {
    const body = methodOf(svc, 'async complete(');
    return /this\.settleAftermath\(completed\)/.test(body) && !/onRefundCompleted\(/.test(body);
  });
  assert('finding 6: the earnings marker is stamped only AFTER the port succeeded', () => {
    const body = methodOf(svc, 'async settleAftermath(');
    return body.indexOf('onRefundCompleted(') > -1 && body.indexOf('onRefundCompleted(') < body.indexOf("'earnings_settled_at'");
  });
  assert('finding 6: the nightly RefundCashRecheckWorker also runs settleUnsettledCompleted', () =>
    /refundRequestService\.settleUnsettledCompleted\(/.test(src('modules/payments/workers/refund-cash-recheck.worker.ts')));
  assert('finding 6: the sweep finds completed rows by their null marker, not by adjustments', () => {
    const repo = stripComments(src('modules/payments/repositories/refund-request.repository.ts'));
    const body = methodOf(repo, 'async findUnsettledCompleted(');
    return /earnings_settled_at:\s*null/.test(body) && /billing_reversed_at:\s*null/.test(body) && !/earnings_adjustments|EarningsAdjustment/.test(body);
  });

  // Finding 7 — no pause before the duplicate check; a failed create lifts only its own pause.
  assert('finding 7: create refuses REFUND_ALREADY_OPEN BEFORE pausing', () => {
    const body = methodOf(svc, 'async create(');
    const check = body.indexOf('this.repo.findOpenBySource(input.source.kind, input.source.id)');
    return check > -1 && check < body.indexOf('onRequestOpened(');
  });
  assert('finding 7: the compensation resumes only a pause THIS call raised, and only with no winner', () => {
    const body = methodOf(svc, 'async create(');
    return /raisedPause = earnings && target \? \(await earnings\.onRequestOpened\(target, id\.toString\(\)\)\) === true : false/.test(body)
      && /if \(earnings && target && raisedPause\)/.test(body) && /if \(!winner\)/.test(body);
  });
  assert('finding 7: the adapter reports whether it raised the pause', () =>
    /return outcome\.changed === true;/.test(src('modules/earnings/services/refund-earnings.adapter.ts')));

  // Finding 9 — the COD wait re-checks coverage once after writing waiting_for_cash.
  assert('finding 9: after waiting_for_cash, coverage is re-checked and a covered refund released at once', () => {
    const body = methodOf(svc, 'async claimAndSend(');
    const wait = body.indexOf("'waiting_for_cash', { transfer_failure_reason: null }");
    return wait > -1 && body.indexOf('this.codCovered(waiting)', wait) > wait
      && /transition\(id, \['waiting_for_cash'\], 'approved', \{\}\)/.test(body);
  });

  // Finding 5 — never send more than remains.
  assert('finding 5: the claim re-checks the refundable ceiling BEFORE any money moves', () => {
    const body = methodOf(svc, 'async claimAndSend(');
    const at = body.indexOf('this.assertStillRefundable(row)');
    return at > -1 && at < body.indexOf('this.sendCard(row)') && at < body.indexOf('this.sendPayout(row)');
  });
  assert('finding 5: a by-hand completion is refused above the ceiling; an arrived transfer is recorded (loudly)', () => {
    const body = methodOf(svc, 'async complete(');
    return /if \(opts\.channel === 'external'\) \{\s*await this\.assertStillRefundable\(row\);/.test(body)
      && /assertStillRefundable\(row\)\.catch\(/.test(body);
  });
  assert('finding 5: exceeding moves an approved request to failed with reason exceeds_refundable', () => {
    const body = methodOf(svc, 'private async assertStillRefundable(');
    return /'exceeds_refundable'/.test(body) && /transition\(row\.id, \['approved'\], 'failed'/.test(body) && /row\.status !== 'sending'/.test(body);
  });
  assert('finding 5: the delivery-fee by-hand settle is refused while ANY order refund is open', () => {
    const adm = stripComments(src('modules/delivery-fee-proposals/services/delivery-fee-refund-admin.service.ts'));
    const body = methodOf(adm, 'async settle(');
    const guard = body.indexOf("findOpenForSource('order', row.order_id.toString())");
    return guard > -1 && guard < body.indexOf('runInTransaction(');
  });

  // Item 11 — a manual resume cannot lift a pause a refund still needs.
  assert('item 11: admin resume refuses 409 EARNINGS_PAUSE_HELD_BY_REFUND before resuming', () => {
    const ctl = stripComments(src('modules/earnings/controllers/admin-earnings.controller.ts'));
    const body = ctl.slice(ctl.indexOf('static resume ='), ctl.indexOf('static listClawbacks ='));
    const guard = body.indexOf('findHoldingEarningsPause(target.kind, target.id)');
    return guard > -1 && guard < body.indexOf('earningsPauseService.resume(') && /EARNINGS_PAUSE_HELD_BY_REFUND, 409/.test(body);
  });
  assert('item 11: open OR completed-but-unrecovered requests hold the pause', () => {
    const body = methodOf(svc, 'async findHoldingEarningsPause(');
    return /findOpenBySource\(kind, sourceId\)/.test(body) && /status: 'completed'/.test(body) && /earnings_settled_at: null/.test(body);
  });

  // Item 12 — the DTO projects earnings_impact.
  assert('item 12: toRefundRequestDto projects earningsImpact / earningsSettledAt / billingReversedAt and the hand-paid split', () => {
    const dto = src('modules/payments/dto/refund-request.dto.ts');
    return /earningsImpact:\s*row\.earnings_impact/.test(dto) && /earningsSettledAt:\s*row\.earnings_settled_at/.test(dto)
      && /billingReversedAt:\s*row\.billing_reversed_at/.test(dto) && /grossAmount:\s*row\.external_settlement\.gross_amount \?\? row\.gross_amount/.test(dto);
  });

  originalConsole.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  originalConsole.error(err);
  process.exit(1);
});
