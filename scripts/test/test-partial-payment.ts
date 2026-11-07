/**
 * Test: partial payment — part online now, the rest in cash at the door (owner, 2026-11-01,
 * `PRODUCTION-READINESS/PARTIAL-PAYMENT-PLAN.md`).
 *
 * Plain ts-node, hand-rolled asserts, DB-free:
 *
 *   1. The limits: the vendor's minimum, the customer's 90%, cash left on every parcel (D-1, D-9).
 *   2. One amount across a checkout's orders (D-8), and an order's part across its parcels.
 *   3. The cash at the door: the collection's amounts, and its exposure twin.
 *   4. The COD handling fee on the cash carried (D-7), through the real split arithmetic.
 *   5. A returned parcel, per fault (D-2, D-10, D-12), down to the customer's exact refund.
 *   6. What each role reads.
 *   7. Source scans: the ⛔ of the design, which a wrong edit would break with no visible symptom.
 *
 * `verify:partial-payment` proves the chain against real Mongo.
 *
 * Run: npm run test:partial-payment
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  allocatePrepaymentAcrossOrders,
  allocatePrepaymentAcrossParcels,
  amountPaidOnlineOf,
  cashDueAtDeliveryOf,
  codHandlingFeeBaseOf,
  groupPrepaymentLimitsOf,
  isPartialOrder,
  maximumPrepaymentOf,
  minimumPrepaymentOf,
  parcelReturnPlanOf,
  PARTIAL_PAYMENT_CUSTOMER_MAX_PERCENT,
  PARTIAL_PAYMENT_VENDOR_MAX_PERCENT,
  PARTIAL_PAYMENT_VENDOR_MIN_PERCENT,
  prepaymentIsDue,
  prepaymentLimitsOf,
  proposedFaultOf,
  shareByWeight,
  vendorPartialPaymentTermsOf,
} from '../../src/modules/orders/domain/partial-payment';
import { cashToCollectOf } from '../../src/modules/orders/domain/delivery-payer';
import { expectedCodAmount } from '../../src/modules/cod/domain/cod-limits';
import { computeRefundFees, customerRefundLines } from '../../src/modules/payments/domain/refund-fees';
import { EarningsSplitService } from '../../src/modules/earnings/services/earnings-split.service';
import { partialReasonOf } from '../../src/modules/orders/services/cart-quote.service';
import { toVendorPartialPaymentDto } from '../../src/modules/vendor/dto/vendor-order.dto';
import { explainPartialReturnCharge } from '../../src/modules/earnings/domain/adjustment-explanations';
import { NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/notification-catalog';
import { CUSTOMER_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { botPaymentStateLabel, onlinePartDueOf } from '../../src/modules/bot-surface/domain/bot-order-status-copy';
import { createAppError, DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

const originalConsole = { log: console.log.bind(console), error: console.error.bind(console) };
let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).stack ?? (err as Error).message}`);
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
const section = (t: string) => originalConsole.log(`\n${t}`);

const ROOT = join(__dirname, '../..');
const read = (rel: string) => readFileSync(join(ROOT, 'src', rel), 'utf8').replace(/\r\n/g, '\n');
const readRoot = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function spanOf(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`span start not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`span end not found: ${end}`);
  return src.slice(a, b);
}
const sum = (values: Iterable<number>) => [...values].reduce((s, v) => s + v, 0);

async function main(): Promise<void> {
  section('1. The limits (D-1, D-9)');
  await assert('the vendor range is 10–90% and the customer maximum is 90%', () =>
    PARTIAL_PAYMENT_VENDOR_MIN_PERCENT === 10 && PARTIAL_PAYMENT_VENDOR_MAX_PERCENT === 90 && PARTIAL_PAYMENT_CUSTOMER_MAX_PERCENT === 90);
  await assert('off by default, and never on without a percentage', () =>
    !vendorPartialPaymentTermsOf(null).enabled
    && !vendorPartialPaymentTermsOf({ enabled: true, min_percent: null }).enabled
    && vendorPartialPaymentTermsOf({ enabled: true, min_percent: 30 }).enabled);
  await assert('the owner\'s example: 30% of 20,000 is 6,000', () => minimumPrepaymentOf(20_000, 30) === 6_000);
  await assert('the minimum rounds UP: never below what the vendor asked', () => minimumPrepaymentOf(101, 30) === 31);
  await assert('the maximum is 90% of the total', () => maximumPrepaymentOf(20_000, 1) === 18_000);
  await assert('a vendor at 90% always leaves a valid amount, even on an odd total', () => {
    const limits = prepaymentLimitsOf(101, 90, 1);
    return limits !== null && limits.minimumAmount === limits.maximumAmount && limits.minimumAmount === 91;
  });
  await assert('at least 1 of cash stays on EVERY parcel', () => maximumPrepaymentOf(5, 3) === 2);
  await assert('an order too small to leave cash on each parcel has no limits at all', () =>
    prepaymentLimitsOf(2, 90, 2) === null && prepaymentLimitsOf(0, 30, 1) === null);

  section('2. One amount, shared (D-8)');
  const orders = [
    { orderId: 'a', total: 100, minimumAmount: 10, maximumAmount: 90 },
    { orderId: 'b', total: 100, minimumAmount: 90, maximumAmount: 90 },
  ];
  await assert('the checkout\'s limits are the sum of its orders\'', () => {
    const limits = groupPrepaymentLimitsOf(orders);
    return limits.minimumAmount === 100 && limits.maximumAmount === 180;
  });
  await assert('at the minimum, each order takes exactly its minimum', () => {
    const shares = allocatePrepaymentAcrossOrders(100, orders);
    return shares[0].amount === 10 && shares[1].amount === 90;
  });
  await assert('a full order never takes past its maximum: the extra moves on', () => {
    const shares = allocatePrepaymentAcrossOrders(150, orders);
    return shares[1].amount === 90 && shares[0].amount === 60;
  });
  await assert('the extra follows what is left to pay on each order', () => {
    const shares = allocatePrepaymentAcrossOrders(600, [
      { orderId: 'x', total: 1_000, minimumAmount: 100, maximumAmount: 900 },
      { orderId: 'y', total: 2_000, minimumAmount: 200, maximumAmount: 1_800 },
    ]);
    return shares[0].amount === 200 && shares[1].amount === 400;
  });
  await assert('every franc is placed, whatever the rounding', () => {
    for (let amount = 3_000; amount < 3_050; amount++) {
      const shares = allocatePrepaymentAcrossOrders(amount, [
        { orderId: 'p', total: 3_333, minimumAmount: 1_000, maximumAmount: 3_000 },
        { orderId: 'q', total: 1_777, minimumAmount: 900, maximumAmount: 1_600 },
        { orderId: 'r', total: 999, minimumAmount: 100, maximumAmount: 899 },
      ]);
      if (sum(shares.map((s) => s.amount)) !== amount) return false;
    }
    return true;
  });
  await assert('the sharing is deterministic: a retry divides identically', () => {
    const rows = [{ id: 'b', weight: 1, cap: 10 }, { id: 'a', weight: 1, cap: 10 }];
    return JSON.stringify([...shareByWeight(3, rows).shares]) === JSON.stringify([...shareByWeight(3, rows).shares])
      && shareByWeight(3, rows).shares.get('a') === 2;
  });
  await assert('across parcels, by value, each keeping cash', () => {
    const { byParcel, surplus } = allocatePrepaymentAcrossParcels(6_000, [
      { parcelId: 'p1', value: 15_000 },
      { parcelId: 'p2', value: 5_000 },
    ]);
    return byParcel.get('p1') === 4_500 && byParcel.get('p2') === 1_500 && surplus === 0;
  });
  await assert('money that no longer fits on the parcels is reported, never lost', () => {
    const { byParcel, surplus } = allocatePrepaymentAcrossParcels(100, [{ parcelId: 'p', value: 60 }]);
    return byParcel.get('p') === 59 && surplus === 41;
  });

  section('3. The cash at the door');
  await assert('the agent collects what is left; the parts stay at their full value', () => {
    const cash = cashToCollectOf('order', 18_000, 2_000, 6_000);
    return cash.expectedAmount === 14_000 && cash.itemsAmount === 18_000 && cash.deliveryFeeAmount === 2_000 && cash.prepaidAmount === 6_000;
  });
  await assert('no prepayment: exactly as before', () => {
    const cash = cashToCollectOf('order', 18_000, 2_000);
    return cash.expectedAmount === 20_000 && cash.prepaidAmount === 0;
  });
  await assert('a fee-only collection never carries a prepaid part', () => cashToCollectOf('delivery_fee', 0, 2_000, 500).expectedAmount === 2_000);
  await assert('the exposure twin agrees with the collection', () => {
    const items = [{ _id: 'i', price: 9_000 }];
    return expectedCodAmount(items, [{ order_item_id: 'i', quantity: 2 }], 2_000, 6_000)
      === cashToCollectOf('order', 18_000, 2_000, 6_000).expectedAmount;
  });

  section('4. The COD handling fee, on the cash carried (D-7)');
  await assert('the owner\'s example: 14,000, not 20,000', () => codHandlingFeeBaseOf(20_000, 14_000) === 14_000);
  await assert('never on the delivery fee: capped at the goods', () => codHandlingFeeBaseOf(18_000, 19_500) === 18_000);

  const splitOf = (prepaidAmount: number, deliveryFeeAmount = 0) => {
    const service = new EarningsSplitService(
      {} as any,
      {} as any,
      { getEntitlements: async () => ({ commissionPercent: 10 }) } as any,
      {} as any,
      {} as any,
      {} as any,
      { computeShipmentDeliveryFee: () => 2_000 } as any,
    );
    const order: any = { _id: 'o', vendor_id: 'v', items: [{ _id: 'i', price: 20_000 }], delivery_address: null };
    return service.computeCodCollectionSplit(order, {
      shipment: { items: [{ order_item_id: 'i', quantity: 1 }] } as any,
      policies: { pricing: { additional_fees: { cod_handling_fee: { type: 'percentage', value: 2 } } } } as any,
      agentId: null,
      agencyId: 'ag',
      itemsAmount: 20_000,
      deliveryFeeAmount,
      prepaidAmount,
    });
  };
  await assert('the fee is 2% of 14,000 on the partial parcel', async () => (await splitOf(6_000)).codFee === 280);
  await assert('and 2% of 20,000 on a plain COD one, unchanged', async () => (await splitOf(0)).codFee === 400);
  await assert('commission stays on the WHOLE sale: the prepayment is not a discount', async () =>
    (await splitOf(6_000)).commission === (await splitOf(0)).commission && (await splitOf(6_000)).gross === 20_000);
  await assert('the vendor pays less, by exactly the fee saved (D-7)', async () =>
    (await splitOf(6_000)).vendorNet - (await splitOf(0)).vendorNet === 120);

  section('5. A returned parcel (D-2, D-10, D-12)');
  await assert('refused, not paid, absent, unreachable propose the customer\'s fault', () =>
    ['customer_refused', 'payment_refused', 'customer_absent', 'customer_unreachable'].every((r) => proposedFaultOf(r) === 'customer'));
  await assert('anything else, or nothing, is an administrator\'s to judge', () =>
    [null, undefined, 'other', 'package_damaged', 'address_not_found', 'rescheduled_by_customer'].every((r) => proposedFaultOf(r) === null));

  const customerPlan = parcelReturnPlanOf({ prepaid: 6_000, returnFee: 1_000, fault: 'customer' });
  await assert('customer at fault: the return fee is kept and the rest refunded', () =>
    customerPlan.keptFromCustomer === 1_000 && customerPlan.refundGross === 5_000 && customerPlan.feesPaidBy === 'customer' && customerPlan.agencyFeePaid === 1_000);
  await assert('…and the plan\'s worked example: 5,000 → 4,802 to the customer', () => {
    const fees = computeRefundFees({ gross: customerPlan.refundGross, paymentChannel: 'mobile_money', payinRatePercent: 2, payoutRatePercent: 2, paidBy: 'customer' });
    return fees.payinAmount === 100 && fees.payoutAmount === 98 && fees.net === 4_802;
  });
  await assert('the return fee never takes more than was prepaid', () => {
    const plan = parcelReturnPlanOf({ prepaid: 500, returnFee: 1_000, fault: 'customer' });
    return plan.refundGross === 0 && plan.agencyFeePaid === 500;
  });
  await assert('vendor at fault: everything back, the vendor pays the trip and both fees', () => {
    const plan = parcelReturnPlanOf({ prepaid: 6_000, returnFee: 1_000, fault: 'vendor' });
    const fees = computeRefundFees({ gross: plan.refundGross, paymentChannel: 'mobile_money', payinRatePercent: 2, payoutRatePercent: 2, paidBy: plan.feesPaidBy });
    return plan.refundGross === 6_000 && plan.agencyFeePaid === 1_000 && plan.vendorChargedReturnFee === 1_000
      && fees.net === 6_000 && fees.vendorCharge === 240 && fees.agencyCharge === 0;
  });
  await assert('agency at fault: everything back, the agency pays both fees and earns nothing', () => {
    const plan = parcelReturnPlanOf({ prepaid: 6_000, returnFee: 1_000, fault: 'agency' });
    const fees = computeRefundFees({ gross: plan.refundGross, paymentChannel: 'mobile_money', payinRatePercent: 2, payoutRatePercent: 2, paidBy: plan.feesPaidBy });
    return plan.refundGross === 6_000 && plan.agencyFeePaid === 0 && plan.vendorChargedReturnFee === 0
      && fees.net === 6_000 && fees.agencyCharge === 240 && fees.vendorCharge === 0;
  });
  await assert('the customer is told who pays when it is not them', () => {
    const fees = computeRefundFees({ gross: 6_000, paymentChannel: 'mobile_money', payinRatePercent: 2, payoutRatePercent: 2, paidBy: 'agency' });
    return customerRefundLines(fees, 6_000).some((l) => l.code === 'fees_paid_by_delivery_company');
  });
  await assert('the charged party is told why, with every part named', () => {
    const e = explainPartialReturnCharge({ orderNumber: 'ORD-1', currency: 'XAF', returnFee: 1_000, fees: 240 });
    return e.reason_code === 'partial_return_fault' && e.explanation.includes('1,000') && e.explanation.includes('240');
  });

  section('6. What each role reads');
  const unpaid: any = { prepayment: { amount: null, paid_at: null }, total_amount: 20_000 };
  const paid: any = { prepayment: { amount: 6_000, paid_at: new Date() }, total_amount: 20_000 };
  await assert('due until paid; never due on a plain order', () =>
    prepaymentIsDue(unpaid) && !prepaymentIsDue(paid) && !prepaymentIsDue({ prepayment: null }) && !prepaymentIsDue(null));
  await assert('partial is the block\'s presence', () => isPartialOrder(unpaid) && !isPartialOrder({}));
  await assert('an amount counts only once it is paid', () => amountPaidOnlineOf(unpaid) === 0 && amountPaidOnlineOf(paid) === 6_000);
  await assert('the vendor sees the split, and null on any other order', () => {
    const dto = toVendorPartialPaymentDto(paid)!;
    return dto.amountPaidOnline === 6_000 && dto.balanceDue === 14_000 && toVendorPartialPaymentDto({ total_amount: 1 }) === null;
  });
  await assert('checkout refusals map to the quote\'s reasons', () =>
    partialReasonOf(createAppError(ERROR_CODES.PARTIAL_PAYMENT_NOT_AVAILABLE, 422, undefined, { reason: 'vendor_not_accepted' })) === 'vendor_not_accepted'
    && partialReasonOf(createAppError(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 422)) === 'agency_not_supported'
    && partialReasonOf(createAppError(ERROR_CODES.COD_CUSTOMER_RESTRICTED, 422)) === 'customer_restricted');
  await assert('every new error code has its own message', () =>
    (['PARTIAL_PAYMENT_NOT_AVAILABLE', 'PARTIAL_PAYMENT_AMOUNT_REQUIRED', 'PARTIAL_PAYMENT_AMOUNT_OUT_OF_RANGE', 'PARTIAL_PAYMENT_NOT_APPLICABLE',
      'REFUND_PARTIAL_RETURN_FAULT_REQUIRED', 'REFUND_PARTIAL_RETURN_NOT_APPLICABLE'] as const)
      .every((code) => typeof DEFAULT_ERROR_MESSAGES[ERROR_CODES[code]] === 'string'));
  await assert('the vendor\'s message names all three amounts, in all 5 languages', () =>
    (['en', 'fr', 'pt', 'es', 'ar'] as const).every((lang) => {
      const body = NOTIFICATION_CATALOG['order.created.partial'].base[lang].body;
      return body.includes('{{paidFormatted}}') && body.includes('{{amountFormatted}}') && body.includes('{{balanceFormatted}}');
    }));
  await assert('the customer\'s says what is still owed, in all 5 languages', () =>
    (['en', 'fr', 'pt', 'es', 'ar'] as const).every((lang) =>
      CUSTOMER_NOTIFICATION_CATALOG['order.prepayment.received'].base[lang].body.includes('{{balanceFormatted}}')));

  section('7. Source scans: the ⛔ of the design');
  const orchestrator = stripComments(read('modules/payments/services/payment-orchestrator.service.ts'));
  const orderService = stripComments(read('modules/orders/order.service.ts'));
  const success = spanOf(orchestrator, 'private async handlePaymentSuccess(', 'emitCartGroupPaymentEvents(transaction)');

  await assert('⛔ the prepayment branch comes BEFORE the order\'s own success handling', () => {
    const branch = success.indexOf("purpose === 'order_prepayment'");
    const plain = success.indexOf('this.orderService.handlePaymentSuccess(');
    return branch > 0 && plain > branch && success.slice(branch, plain).includes('return;');
  });
  await assert('⛔ the prepayment path never writes `paid` and never splits', () => {
    const body = spanOf(orderService, 'async handlePrepaymentSuccess(', 'private async markProductsOrdered');
    return !body.includes("payment_status = 'paid'") && !body.includes('splitOrder');
  });
  const partialService = read('modules/orders/services/partial-payment.service.ts');
  await assert('⛔ a replayed webhook moves nothing: the claim filters on an unpaid part', () =>
    partialService.includes("'prepayment.paid_at': null"));
  await assert('⛔ an unpaid partial order cannot dispatch', () =>
    spanOf(orderService, 'const codAwaitingCash', 'if (order.payment_status').includes('!prepaymentIsDue(order)'));
  await assert('⛔ checkout does not commit stock or dispatch for a partial order', () => {
    const body = spanOf(orderService, 'async createOrdersFromCart(', 'private async resolveDeliveryAddress');
    return body.includes("paymentMethod === 'cash_on_delivery' && !partialPayment")
      && body.includes("order.order_type === 'physical' && !partialPayment");
  });
  await assert('⛔ the unpaid sweep finds partial orders that were never paid', () =>
    read('modules/orders/workers/unpaid-order-cancel.worker.ts').includes("'prepayment.paid_at': null"));
  await assert('⛔ a paid online part stops a returned order reading `failed`', () =>
    spanOf(read('modules/cod/services/cash-collection.service.ts'), 'async recomputeCodPaymentStatusInSession', '// ─── Read views').includes('amountPaidOnlineOf(order) <= 0'));
  await assert('⛔ a won dispute restores a partial order to partially_paid, not paid', () =>
    read('modules/payments/services/dispute.service.ts').includes("amountPaidOnlineOf(order) > 0 ? 'partially_paid' : 'paid'"));
  await assert('⛔ refund legs can see this purpose, and read this order\'s own share', () =>
    orchestrator.includes("purpose: { $in: ['primary', 'order_delivery_topup', 'order_prepayment', null] }")
    && orchestrator.includes('prepaymentAllocations?.find('));
  const refunds = stripComments(read('modules/payments/services/refund-request.service.ts'));
  await assert('⛔ no approval until somebody said whose fault it is', () =>
    spanOf(refunds, 'async approve(', 'secondApproverRequired(').includes('REFUND_PARTIAL_RETURN_FAULT_REQUIRED')
    && spanOf(refunds, 'async settleExternal(', 'settleRemainderOf(row)').includes('REFUND_PARTIAL_RETURN_FAULT_REQUIRED'));
  const partialReturn = stripComments(read('modules/payments/services/partial-return.service.ts'));
  await assert('⛔ nothing here approves or sends: every refund waits for a person (D-11)', () =>
    !partialReturn.includes('approveNow: true') && partialReturn.includes('approveNow: false') && !partialReturn.includes('.approve('));
  await assert('⛔ the charges run when the refund COMPLETES, on the settled path', () =>
    spanOf(refunds, 'async settleAftermath(', 'async settleUnsettledCompleted(').includes('onPartialReturnCompleted')
    && read('modules/payments/repositories/refund-request.repository.ts').includes('partial_return: { $ne: null }, earnings_settled_at: null'));
  await assert('⛔ a parcel whose refund is open cannot be sent out again', () =>
    spanOf(read('modules/cod/services/cash-collection.service.ts'), 'async reopenForRedeliveryInSession(', 'async notifyCodeIssued(').includes('shipment.prepaid_return'));
  await assert('⛔ the return-fee rows need no cash settlement: this money is already here', () =>
    spanOf(read('modules/earnings/services/earnings-split.service.ts'), 'async splitPartialReturn(', 'async computeShipmentDeliverySplit(').includes('requires_cash_settlement: false'));
  await assert('⛔ the vendor is not told at checkout, and is told on payment', () =>
    spanOf(read('modules/notifications/services/vendor-notification-event-handler.service.ts'), 'async handleOrderCreated(', 'async handleOrderPrepaymentReceived(').includes('partialPayment === true')
    && read('modules/notifications/vendor-notification-event-consumer.ts').includes("'order.prepayment.received'"));
  await assert('both new templates are registered and have approval copy', () => {
    const registry = read('modules/whatsapp/handlers/template/template-registry.ts');
    const copy = readRoot('api-doc/notifications/whatsapp-templates.md');
    return ['vendor_order_created_partial', 'customer_order_prepayment_received'].every((name) => registry.includes(`'${name}'`) && copy.includes(`\`${name}\``));
  });
  await assert('the bot catalog carries the amount, on both tools', () => {
    const catalog = JSON.parse(readRoot('api-doc/n8n/tools/catalog.json'));
    const tools = catalog.tools ?? catalog;
    return ['checkout_place', 'checkout_retry_payment'].every((name) => {
      const tool = tools.find((t: { name: string }) => t.name === name);
      return tool?.parameters?.properties?.partialAmount?.type === 'integer' && tool?.request?.body?.includes('partialAmount');
    });
  });
  await assert('a tap retry keeps the failed attempt\'s amount, or it would be refused', () =>
    read('modules/bot-surface/controllers/bot-checkout.controller.ts').includes('amount: partialAmount ?? transaction.amountSnapshot'));
  await assert('an unpaid partial order never reads "pay on delivery"; once the online part is paid it does', () => {
    const due = botPaymentStateLabel('awaiting_payment', 'en', { cashOnDelivery: true, onlinePartDue: true });
    const paid = botPaymentStateLabel('awaiting_payment', 'en', { cashOnDelivery: true, onlinePartDue: false });
    return due === botPaymentStateLabel('awaiting_payment', 'en') && paid !== due
      && onlinePartDueOf({ partialPayment: { paidAt: null } })
      && !onlinePartDueOf({ partialPayment: { paidAt: new Date() } })
      && !onlinePartDueOf({ partialPayment: null });
  });
  await assert('every bot order label asks about the online part: card, row and mini-app', () => {
    const chat = stripComments(read('modules/bot-surface/controllers/bot-order.controller.ts'));
    const miniapp = stripComments(read('modules/bot-surface/miniapp/surfaces/order-listing.controller.ts'));
    return (chat.match(/onlinePartDue: onlinePartDueOf\(order\)/g) ?? []).length === 2
      && chat.includes('partialPayment: dto.partialPayment')
      && miniapp.includes('onlinePartDue: group.orders.some(onlinePartDueOf)');
  });
  await assert('the order LIST carries it: both bot lists read that summary, not the full order', () => {
    const repo = stripComments(read('modules/orders/order.repository.ts'));
    return repo.includes("prepayment: '$prepayment'")
      && repo.includes('partialPayment: o.prepayment ? { paidAt: o.prepayment.paid_at ?? null } : null');
  });
  await assert('the cash due at delivery is the whole checkout minus what was paid online', () =>
    cashDueAtDeliveryOf([{ total_amount: 20_000 }, { total_amount: 5_000 }], 7_500) === 17_500);
  await assert('a returned parcel\'s settlement is stamped only AFTER the money step, and the sweep finds it', () => {
    const svc = stripComments(read('modules/payments/services/refund-request.service.ts'));
    const body = spanOf(svc, 'private async settlePartialReturnAftermath(', 'async settleUnsettledCompleted(');
    const repo = stripComments(read('modules/payments/repositories/refund-request.repository.ts'));
    return body.indexOf('onPartialReturnCompleted(') > -1
      && body.indexOf('onPartialReturnCompleted(') < body.indexOf("'earnings_settled_at'")
      && /partial_return:\s*\{\s*\$ne:\s*null\s*\},\s*earnings_settled_at:\s*null/.test(repo);
  });

  originalConsole.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  originalConsole.error(error);
  process.exit(1);
});
