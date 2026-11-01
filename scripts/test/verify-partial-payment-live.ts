/**
 * verify:partial-payment — part online, the rest in cash, end to end against REAL Mongo.
 * **NEEDS Mongo as a REPLICA SET** (every step runs a transaction).
 *
 * `test:partial-payment` proves the rules and pins the ⛔ by source scan. This proves the CHAIN: a
 * real checkout, the real success handler, the real delivery-code collection, the real settlement
 * and the real refund, so a hop that was never wired fails here.
 *
 * The scenario, on one checkout of 40,000 with two parcels on two agencies (vendor minimum 30%):
 *
 *   1. Off by default; on, the quote names the limits; checkout reserves but neither commits nor
 *      dispatches, and the vendor is not told.
 *   2. The charge refuses a missing or out-of-range amount before anything is written.
 *   3. The online part arrives: shared across the parcels, never `paid`, no earnings, and a replayed
 *      webhook moves nothing.
 *   4. Parcel A: the agent collects only the balance and owes only that. Every share waits for that
 *      cash, then unlocks when it reaches the platform (D-3, D-4), with the fee on the cash (D-7).
 *   5. Parcel B comes back refused: not `failed`, a refund waits for a person (D-10, D-11), and it
 *      cannot go out again.
 *   6. Each fault gives the agreed money (D-2, D-12), including money owed when there is no balance.
 *   7. A parcel losing value after the payment: the prepaid part is shared again, and none is lost.
 *   8. An online part paid after the order was cancelled gets a refund, not a dispatch.
 *
 * ⚠ Refuses to run against anything but a local Mongo: it writes real money rows.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/verify_partial?replicaSet=rs0 npm run verify:partial-payment
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { VendorSettingsRepository } from '../../src/modules/vendors/repositories/vendor-settings.repository';
import { StoreModel } from '../../src/modules/store/models/store.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../src/modules/agents';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { CartModel } from '../../src/modules/cart/models/cart.model';
import { OrderModel } from '../../src/modules/orders/order.model';
import { OrderService } from '../../src/modules/orders/order.service';
import { OrderRepository } from '../../src/modules/orders/order.repository';
import { onlinePartDueOf } from '../../src/modules/bot-surface/domain/bot-order-status-copy';
import { cartQuoteService } from '../../src/modules/orders/services/cart-quote.service';
import { partialPaymentService } from '../../src/modules/orders/services/partial-payment.service';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { ShipmentService } from '../../src/modules/shipments/shipment.service';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { CodCashAccountModel } from '../../src/modules/cod/models/cod-cash-account.model';
import { cashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { codSettlementService } from '../../src/modules/cod/services/cod-settlement.service';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsAdjustmentModel } from '../../src/modules/earnings/models/earnings-adjustment.model';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { PaymentTransactionModel } from '../../src/modules/payments/models/payment-transaction.model';
import { PaymentOrchestratorService } from '../../src/modules/payments/services/payment-orchestrator.service';
import { refundRequestService } from '../../src/modules/payments/services/refund-request.service';
import { partialReturnService } from '../../src/modules/payments/services/partial-return.service';
import { RefundRequestModel } from '../../src/modules/payments/models/refund-request.model';
import { initializeRefundDomain } from '../../src/modules/payments/refund.bootstrap';
import { transactionManager } from '../../src/core/database/transaction.manager';
import { generateSystemPassword } from '../../src/core/auth/system-password';
import { eventBus } from '../../src/core/events/event-bus';
import { IGeoAddress, GeoAddressInput } from '../../src/core/types/geo-address.types';

const MONGO_URI = process.env.MONGO_URI ?? '';
const CURRENCY = 'XAF';
const TAG = 'e2epp-';
const PRICE_A = 30_000;
const PRICE_B = 10_000;
const RTO_FEE = 1_000;
const ACTOR = { id: 'a'.repeat(24), name: 'Verify Admin' };

let passed = 0;
let failed = 0;
let step = 0;

function assert(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ''}`);
    failed++;
  }
}
function heading(title: string): void {
  step += 1;
  console.log(`\n── Step ${step} · ${title}\n`);
}
async function refusedWith(code: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error) {
    return (error as { code?: string }).code === code;
  }
}

const DROP_OFF: IGeoAddress = {
  formatted_address: 'Rue Njo-Njo, Bonapriso, Douala, Littoral, Cameroun',
  coordinates: { type: 'Point', coordinates: [9.7043, 4.0301] },
  provider: 'nominatim',
  provider_place_id: null,
  components: { street: 'Rue Njo-Njo', neighbourhood: 'Bonapriso', city: 'Douala', region: 'Littoral', country: 'Cameroun', country_code: 'cm', postal_code: null },
  raw_input: 'Bonapriso Douala',
  resolved_at: new Date(),
};
const asInput = (geo: IGeoAddress): GeoAddressInput => ({
  formatted_address: geo.formatted_address,
  coordinates: geo.coordinates,
  provider: geo.provider,
  provider_place_id: geo.provider_place_id,
  components: geo.components,
  raw_input: geo.raw_input,
});

const orderService = new OrderService();
const shipmentService = new ShipmentService();
const orchestrator = new PaymentOrchestratorService();
const settings = new VendorSettingsRepository();

interface World {
  vendorId: string;
  customerId: string;
  customerUserId: string;
  agencies: [string, string];
  agents: [{ id: string; userId: string }, { id: string; userId: string }];
  lines: Array<{ variantId: Types.ObjectId; productId: Types.ObjectId; sku: string; title: string; price: number }>;
}

/** One vendor selling one product through each of two agencies, so one order makes two parcels. */
async function buildWorld(name: string): Promise<World> {
  // Unique per run: the suite targets a throwaway database and leaves its rows for inspection.
  const suffix = `${name}${Date.now().toString(36)}`;
  const hash = await bcrypt.hash(generateSystemPassword(), 4);
  const email = (who: string) => `${TAG}${suffix}-${who}@jovitest.cm`;
  const id = () => new Types.ObjectId();
  const [vendorUser, customerUser, agencyUserA, agencyUserB, agentUserA, agentUserB] = [id(), id(), id(), id(), id(), id()];
  await UserModel.create([
    { _id: vendorUser, login_email: email('vendor'), password_hash: hash, roles: ['vendor'], status: 'active' },
    { _id: customerUser, login_email: email('customer'), password_hash: hash, roles: ['customer'], status: 'active' },
    { _id: agencyUserA, login_email: email('agency-a'), password_hash: hash, roles: ['agency'], status: 'active' },
    { _id: agencyUserB, login_email: email('agency-b'), password_hash: hash, roles: ['agency'], status: 'active' },
    { _id: agentUserA, login_email: email('agent-a'), password_hash: hash, roles: ['agent'], status: 'active' },
    { _id: agentUserB, login_email: email('agent-b'), password_hash: hash, roles: ['agent'], status: 'active' },
  ]);
  const customer = await CustomerModel.create({
    user_id: customerUser, name: 'Amina Partial', email: email('customer'), email_verified: true,
    phone: '+237699000921', phone_verified: true, timezone: 'Africa/Douala', status: 'active',
  });

  const agencyDoc = (userId: Types.ObjectId, who: string) => ({
    user_id: userId, name: `Partial ${who}`, email: email(`agency-${who}`), phone: '+237699000922', status: 'active',
    legit_verified: true,
    kyc_details: { legit_verified: true, status: 'verified', verified_at: new Date() },
    policies: {
      pricing: {
        storage_based: { enabled: true, monthly_storage_fee_per_sku: 500, pick_pack_fee_per_order: 300, local_delivery_fee: 1000, out_of_region_delivery_fee: 2500 },
        pickup_based: { enabled: true, base_rate_first_kg: 1500, additional_per_kg: 300, out_of_region_surcharge: 500 },
        additional_fees: { cod_handling_fee: { type: 'percentage', value: 2 }, failed_delivery_fee: 500, rto_fee: RTO_FEE, peak_season_surcharge: 0 },
        notes: null,
      },
      returns: { payer: 'vendor', handling_fee: 500, return_window_days: 7, notes: null },
      damage: { claim_deadline_days: 3, max_refund_per_item: 50_000, inspector: 'admin', investigation_fee: 1000, notes: null },
      cod: { enabled: true, max_order_amount: null },
      documents: [],
    },
  });
  const agencyA = await DeliveryAgencyModel.create(agencyDoc(agencyUserA, 'a'));
  const agencyB = await DeliveryAgencyModel.create(agencyDoc(agencyUserB, 'b'));

  const agentDoc = (userId: Types.ObjectId, who: string) => ({
    user_id: userId, name: `Agent ${who}`, email: email(`agent-${who}`), phone: '+237699000923', status: 'active',
    kyc: { status: 'verified', verified_at: new Date() },
    availability: { state: 'online', changed_at: new Date() },
    tracking: { allowed: true, changed_at: new Date() },
    capacity: { max_active_shipments: 3, active_shipment_count: 0 },
    cod: { trust_score: 100, max_threshold: 500_000 },
    home_base: { location: { type: 'Point', coordinates: [9.7085, 4.0511] }, radius_km: 25 },
  });
  const agentA = await DeliveryAgentModel.create(agentDoc(agentUserA, 'a'));
  const agentB = await DeliveryAgentModel.create(agentDoc(agentUserB, 'b'));

  const vendor = await VendorModel.create({
    user_id: vendorUser, business_name: `Partial ${suffix}`, display_name: `Partial ${suffix}`, business_description: 'verify:partial-payment fixture.',
    country: 'CM', email: email('vendor'), phone: '+237699000924', email_verified: true, phone_verified: true,
    business_addresses: [{ label: 'Boutique', address_line1: 'Boulevard de la Liberté, Akwa', address_line2: null, city: 'Douala', state: 'Littoral', location: DROP_OFF.coordinates, geo: DROP_OFF }],
    kyc_details: { national_id_number: `CNI-${suffix}`, legit_verified: true },
    default_delivery_agency_id: agencyA._id, status: 'active', onboarding_step: 0,
  });
  await StoreModel.create({ vendor_id: vendor._id, name: `Partial ${suffix}`, slug: `${TAG}${suffix}`, description: 'fixture' });
  const addressId = (vendor.business_addresses as unknown as Array<{ _id: Types.ObjectId }>)[0]._id;

  const makeLine = async (who: string, agencyId: Types.ObjectId, price: number) => {
    const product = await ProductModel.create({
      vendorId: vendor._id, type: 'physical', status: 'active', title: `Lamp ${who}`, description: 'fixture', slug: `${TAG}${suffix}-${who}`,
      categoryIds: [], tags: [], seo: { title: 'Lamp', description: 'Lamp' }, hasVariants: false,
      delivery: { agency_id: agencyId, pickup_location: { source: 'vendor_address', vendor_address_id: addressId } },
    });
    const sku = `${TAG}${suffix}-${who}`.toUpperCase();
    const variant = await ProductVariantModel.create({ productId: product._id, sku, name: 'Default', status: 'active', optionSignature: 'default', price, stock: 100 });
    product.defaultVariantId = variant._id;
    await product.save();
    return { variantId: variant._id, productId: product._id, sku, title: `Lamp ${who}`, price };
  };

  return {
    vendorId: vendor._id.toString(),
    customerId: customer._id.toString(),
    customerUserId: customerUser.toString(),
    agencies: [agencyA._id.toString(), agencyB._id.toString()],
    agents: [{ id: agentA._id.toString(), userId: agentUserA.toString() }, { id: agentB._id.toString(), userId: agentUserB.toString() }],
    lines: [await makeLine('a', agencyA._id, PRICE_A), await makeLine('b', agencyB._id, PRICE_B)],
  };
}

async function fillCart(world: World): Promise<void> {
  await CartModel.findOneAndReplace(
    { userId: world.customerId },
    {
      userId: world.customerId,
      productType: 'physical',
      items: world.lines.map((line) => ({
        variantId: line.variantId, sku: line.sku, variantTitle: 'Default', optionsSnapshot: 'default', productId: line.productId,
        title: line.title, vendorId: new Types.ObjectId(world.vendorId), productType: 'physical', quantity: 1, price: line.price, currency: CURRENCY,
      })),
    },
    { upsert: true, new: true }
  );
}

/** A partial checkout, its online part charged and "settled by the gateway". */
async function paidCheckout(world: World, amount: number) {
  await fillCart(world);
  const { cartId, orders } = await orderService.createOrdersFromCart(world.customerId, 'cash_on_delivery', { address: asInput(DROP_OFF) }, { partialPayment: true });
  const tx = await payOnline(world, cartId, orders[0]._id as Types.ObjectId, amount);
  return { cartId, orderId: (orders[0]._id as Types.ObjectId).toString(), tx };
}

/** The row `initiatePaymentForCart` writes, then the success path every gateway result reaches. */
async function payOnline(world: World, cartId: string, orderId: Types.ObjectId, amount: number) {
  const tx = await PaymentTransactionModel.create({
    cartId: new Types.ObjectId(cartId), orderIds: [orderId], userId: new Types.ObjectId(world.customerId),
    gateway: 'NOTCHPAY', provider: 'MTN', method: 'MOBILE', status: 'SUCCEEDED', gatewayRef: `${TAG}${new Types.ObjectId()}`,
    amountSnapshot: amount, currencySnapshot: CURRENCY, idempotencyKey: `${TAG}${new Types.ObjectId()}`, purpose: 'order_prepayment',
    prepaymentAllocations: [{ orderId, amount }], payer: { name: 'Amina', phone: '+237677000000', email: null }, rawGatewayPayloads: [],
  });
  await (orchestrator as any).handlePaymentSuccess(tx);
  return tx;
}

/** Put a parcel with its agent, the way an accepted offer leaves it, and issue its delivery code. */
async function outForDelivery(orderId: string, agencyId: string, agent: { id: string }) {
  const order = await OrderModel.findById(orderId);
  await ShipmentModel.updateOne({ order_id: orderId, agency_id: agencyId }, { $set: { agent_id: agent.id, status: 'in_transit' } });
  const shipment = await ShipmentModel.findOne({ order_id: orderId, agency_id: agencyId });
  await transactionManager.runInTransaction((session) => cashCollectionService.ensureForShipmentInSession(order!, shipment!, session));
  return shipment!;
}

/** Fail then return a parcel through the agent's real status path, with the agent's reason. */
async function comesBack(world: World, agencyIndex: 0 | 1, orderId: string, reason: any) {
  const agent = world.agents[agencyIndex];
  const parcel = await outForDelivery(orderId, world.agencies[agencyIndex], agent);
  await shipmentService.updateStatusByAgent(agent.id, parcel._id.toString(), 'failed', agent.userId, { reason, note: 'verify' });
  await shipmentService.updateStatusByAgent(agent.id, parcel._id.toString(), 'returned', agent.userId, null);
  return parcel._id.toString();
}

/** The return path opens the refund post-commit, without waiting for it, so this waits instead. */
async function openRefundOf(orderId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = await RefundRequestModel.findOne({ source_id: orderId, status: 'awaiting_approval' });
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
const settle = (id: string) =>
  refundRequestService.settleExternal(id, { method: 'mobile_money', reference: 'verify', proofFileId: new Types.ObjectId().toString() }, ACTOR);

async function main(): Promise<void> {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(MONGO_URI)) {
    console.error('Refusing to run: MONGO_URI must point at a local replica set. This suite writes real money rows.');
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI);
  initializeRefundDomain();
  // Collections cannot be created inside a transaction on a fresh database, and an index still
  // building refuses the transaction's lock.
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection().catch(() => undefined);
    await model.init().catch(() => undefined);
  }

  // ═══ 1 ═══════════════════════════════════════════════════════════════════════
  heading('Off by default; on, checkout reserves and waits');
  const world = await buildWorld('main');
  const vendorMessages: string[] = [];
  eventBus.subscribe('order.prepayment.received', async (event) => { vendorMessages.push(event.eventType); });

  await fillCart(world);
  const off = await cartQuoteService.quoteForCustomer(world.customerId);
  assert('a vendor who never opted in: not offered, and the reason is theirs', !off.partialPayment.available && off.partialPayment.reason === 'vendor_not_accepted', off.partialPayment);
  assert('…and checkout refuses it too', await refusedWith('PARTIAL_PAYMENT_NOT_AVAILABLE', () =>
    orderService.createOrdersFromCart(world.customerId, 'cash_on_delivery', { address: asInput(DROP_OFF) }, { partialPayment: true })));

  await settings.setPartialPayment(world.vendorId, { enabled: true, min_percent: 30 });
  await settings.setCodTerms(world.vendorId, { cod_enabled: false, max_cash_per_agency: null });
  await fillCart(world);
  const on = await cartQuoteService.quoteForCustomer(world.customerId);
  assert('D-5: offered although this vendor turned plain COD off', on.partialPayment.available && !on.cashOnDelivery.available, on.partialPayment);
  const total = on.partialPayment.total;
  assert('the limits are 30% and 90% of the total', on.partialPayment.minimumAmount === Math.ceil(total * 0.3) && on.partialPayment.maximumAmount === Math.ceil(total * 0.9), on.partialPayment);

  const stockBefore = (await ProductVariantModel.findById(world.lines[0].variantId))!.stock;
  const { cartId, orders } = await orderService.createOrdersFromCart(world.customerId, 'cash_on_delivery', { address: asInput(DROP_OFF) }, { partialPayment: true });
  const orderId = (orders[0]._id as Types.ObjectId).toString();
  assert('one order, cash on delivery with an unpaid online part', orders.length === 1 && orders[0].payment_method === 'cash_on_delivery' && orders[0].prepayment?.paid_at === null);
  assert('stock is held, not sold', (await ProductVariantModel.findById(world.lines[0].variantId))!.stock === stockBefore);
  assert('two parcels, nothing prepaid on them yet', (await ShipmentModel.find({ order_id: orderId })).every((s) => (s.prepaid_amount ?? 0) === 0) && (await ShipmentModel.countDocuments({ order_id: orderId })) === 2);
  assert('⛔ it cannot be dispatched before the online part is paid', await refusedWith('ORDER_PAYMENT_REQUIRED', () =>
    orderService.dispatchToAgency(orderId, { type: 'vendor', id: world.vendorId })));
  const listedRow = async () => (await new OrderRepository().findGroupsByCustomer(world.customerId, { page: 1, limit: 50 }))
    .data.flatMap((group) => group.orders).find((row) => row.id === orderId);
  assert('the order list says the online part is still owed', onlinePartDueOf((await listedRow()) ?? {}));

  // ═══ 2 ═══════════════════════════════════════════════════════════════════════
  heading('The charge refuses a bad amount before anything is written');
  const selection = { provider: 'MTN' as const };
  const channel = { phoneNumber: '+237677000000' };
  const rowsBefore = await PaymentTransactionModel.countDocuments({ cartId });
  assert('no amount', await refusedWith('PARTIAL_PAYMENT_AMOUNT_REQUIRED', () => orchestrator.initiatePaymentForCart(cartId, selection, channel)));
  assert('below the minimum', await refusedWith('PARTIAL_PAYMENT_AMOUNT_OUT_OF_RANGE', () =>
    orchestrator.initiatePaymentForCart(cartId, selection, channel, { amount: on.partialPayment.minimumAmount - 1 })));
  assert('above the maximum', await refusedWith('PARTIAL_PAYMENT_AMOUNT_OUT_OF_RANGE', () =>
    orchestrator.initiatePaymentForCart(cartId, selection, channel, { amount: on.partialPayment.maximumAmount + 1 })));
  assert('…and no payment row was written', (await PaymentTransactionModel.countDocuments({ cartId })) === rowsBefore);

  // ═══ 3 ═══════════════════════════════════════════════════════════════════════
  heading('The online part arrives');
  const paidNow = on.partialPayment.minimumAmount;
  const tx = await payOnline(world, cartId, orders[0]._id as Types.ObjectId, paidNow);
  const paidOrder = await OrderModel.findById(orderId);
  assert('⛔ partially_paid, NOT paid', paidOrder?.payment_status === 'partially_paid', paidOrder?.payment_status);
  assert('the order list now says it is paid', !!(await listedRow())?.partialPayment?.paidAt);
  assert('the amount and the payment are recorded', paidOrder?.prepayment?.amount === paidNow && String(paidOrder?.prepayment?.transaction_id) === tx._id.toString());
  const parcels = await ShipmentModel.find({ order_id: orderId });
  assert('the whole amount is on the parcels', parcels.reduce((s, p) => s + (p.prepaid_amount ?? 0), 0) === paidNow, parcels.map((p) => p.prepaid_amount));
  assert('stock is now sold', (await ProductVariantModel.findById(world.lines[0].variantId))!.stock === stockBefore - 1);
  assert('⛔ no earnings exist yet', (await EarningsAllocationModel.countDocuments({ source_id: orderId })) === 0);
  assert('the vendor is told once', vendorMessages.length === 1);
  assert('paying again is the good news of "already paid", on both doors', await refusedWith('PAYMENT_ORDER_ALREADY_PAID', () =>
    orchestrator.initiatePaymentForCart(cartId, selection, channel, { amount: paidNow }))
    && await refusedWith('PAYMENT_ORDER_ALREADY_PAID', () => orchestrator.initiatePayment(orderId, selection, channel, { amount: paidNow })));

  await (orchestrator as any).handlePaymentSuccess(tx);
  assert('a replayed webhook moves nothing', vendorMessages.length === 1 && (await ProductVariantModel.findById(world.lines[0].variantId))!.stock === stockBefore - 1);
  assert('now it can be dispatched', (await orderService.dispatchToAgency(orderId, { type: 'vendor', id: world.vendorId })) > 0
    || (await ShipmentModel.countDocuments({ order_id: orderId, status: 'assigned' })) > 0);

  // ═══ 4 ═══════════════════════════════════════════════════════════════════════
  heading('Parcel A: the agent collects the balance; shares wait for the cash');
  const [agencyA, agencyB] = world.agencies;
  const parcelA = await outForDelivery(orderId, agencyA, world.agents[0]);
  const collectionA = await CashCollectionModel.findOne({ shipment_id: parcelA._id }).select('+code_plain');
  const prepaidA = parcelA.prepaid_amount ?? 0;
  const feeA = parcelA.customer_delivery_fee ?? 0;
  assert('the collection is the parcel minus what was prepaid', collectionA?.expected_amount === PRICE_A + feeA - prepaidA, { expected: collectionA?.expected_amount, prepaidA, feeA });
  assert('the sale keeps its full value on it', collectionA?.items_amount === PRICE_A && collectionA?.prepaid_amount === prepaidA);

  await cashCollectionService.collect(world.agents[0].id, world.agents[0].userId, parcelA._id.toString(), { code: collectionA!.code_plain! });
  const agentAccount = await CodCashAccountModel.findOne({ owner_type: 'agent', owner_id: world.agents[0].id });
  assert('the agent owes only the cash they took', agentAccount?.balance === collectionA?.expected_amount, agentAccount?.balance);
  assert('with one parcel still out, the order stays partially_paid', (await OrderModel.findById(orderId))?.payment_status === 'partially_paid');

  const rows = await EarningsAllocationModel.find({ source_type: 'cod_collection', source_id: collectionA!._id });
  const by = (type: string) => rows.filter((r) => r.beneficiary_type === type).reduce((s, r) => s + r.amount, 0);
  const expectedCodFee = Math.floor((Math.min(PRICE_A, PRICE_A + feeA - prepaidA) * 2) / 100);
  const deliveryFee = (await ShipmentModel.findById(parcelA._id))!.delivery_fee_snapshot ?? 0;
  assert('D-7: the agency\'s share carries the fee on the CASH', by('agency') + by('agent') === deliveryFee + expectedCodFee, { agency: by('agency'), agent: by('agent'), deliveryFee, expectedCodFee });
  assert('⛔ D-4: every share is pending, and locked until the cash arrives', rows.length > 0 && rows.every((r) => r.status === 'held' && r.requires_cash_settlement && !r.cash_settled_at));

  const paidOnGoods = by('vendor') + by('platform') + by('platform_ai');
  assert('the vendor and platform shares divide the whole sale', paidOnGoods === PRICE_A - (deliveryFee - Math.min(deliveryFee, feeA)) - expectedCodFee, { paidOnGoods, deliveryFee, feeA, expectedCodFee });

  await transactionManager.runInTransaction((session) => codSettlementService.applyFifoInSession(agencyA, collectionA!.expected_amount - 1, session));
  assert('one franc short: nothing unlocks', (await EarningsAllocationModel.countDocuments({ source_id: collectionA!._id, cash_settled_at: { $ne: null } })) === 0);
  await transactionManager.runInTransaction((session) => codSettlementService.applyFifoInSession(agencyA, 1, session));
  assert('D-3: all the cash in: this parcel\'s shares unlock, with parcel B still out',
    (await EarningsAllocationModel.countDocuments({ source_id: collectionA!._id, cash_settled_at: { $ne: null } })) === rows.length);

  // ═══ 5 ═══════════════════════════════════════════════════════════════════════
  heading('Parcel B comes back refused');
  const parcelB = await comesBack(world, 1, orderId, 'customer_refused');
  await partialReturnService.openForReturnedParcels(orderId);
  const shippedB = await ShipmentModel.findById(parcelB);
  const prepaidB = shippedB!.prepaid_amount ?? 0;
  assert('⛔ the order is not failed: the platform holds the customer\'s money', (await OrderModel.findById(orderId))?.payment_status === 'partially_paid');
  const proposed = await openRefundOf(orderId);
  assert('D-11: a refund waits for a person', proposed?.status === 'awaiting_approval' && proposed?.approved_by === null);
  assert('D-10: the agent\'s reason proposes the customer\'s fault', proposed?.partial_return?.fault === 'customer' && proposed?.partial_return?.agent_reason === 'customer_refused');
  assert('D-2: the return fee is kept and the rest refunded', proposed?.gross_amount === prepaidB - RTO_FEE, { gross: proposed?.gross_amount, prepaidB });
  assert('…minus the two normal fees, which the customer pays', proposed?.fees?.paid_by === 'customer' && proposed?.net_amount === proposed!.gross_amount - proposed!.fee_amount && proposed!.fee_amount > 0);
  assert('⛔ a parcel whose refund is open cannot go out again', await refusedWith('SHIPMENT_REASSIGNMENT_CONFLICT', () =>
    transactionManager.runInTransaction(async (session) => cashCollectionService.reopenForRedeliveryInSession((await OrderModel.findById(orderId))!, shippedB!, session))));

  await settle(proposed!.id);
  const afterB = await EarningsAllocationModel.find({ source_type: 'shipment', source_id: parcelB });
  assert('on completion the agency is paid its return fee, from money already here',
    afterB.reduce((s, r) => s + r.amount, 0) === RTO_FEE && afterB.every((r) => !r.requires_cash_settlement), afterB.map((r) => [r.beneficiary_type, r.amount]));
  assert('…exactly once, whatever re-runs it', await (async () => {
    await refundRequestService.settleAftermath((await RefundRequestModel.findById(proposed!.id))!);
    return (await EarningsAllocationModel.countDocuments({ source_type: 'shipment', source_id: parcelB })) === afterB.length;
  })());

  // ═══ 6 ═══════════════════════════════════════════════════════════════════════
  heading('Each fault gives the agreed money (D-12)');
  const vendorFault = await buildWorld('vendorfault');
  await settings.setPartialPayment(vendorFault.vendorId, { enabled: true, min_percent: 30 });
  await settings.setAutoRedirectOrdersToAgency(vendorFault.vendorId, true);
  const vf = await paidCheckout(vendorFault, 15_000);
  const vfParcel = await comesBack(vendorFault, 1, vf.orderId, 'package_damaged');
  await partialReturnService.openForReturnedParcels(vf.orderId);
  const noFault = await openRefundOf(vf.orderId);
  assert('D-10: a reason naming nobody proposes nobody', noFault?.partial_return?.fault === null);
  assert('⛔ D-11: it cannot be approved until somebody says', await refusedWith('REFUND_PARTIAL_RETURN_FAULT_REQUIRED', () => refundRequestService.approve(noFault!.id, ACTOR)));
  assert('⛔ …nor paid by hand, which is another road to the same money', await refusedWith('REFUND_PARTIAL_RETURN_FAULT_REQUIRED', () => settle(noFault!.id)));

  const vfRefund = await partialReturnService.setFault(noFault!.id, 'vendor', ACTOR);
  const vfPrepaid = (await ShipmentModel.findById(vfParcel))!.prepaid_amount ?? 0;
  assert('saying replaces the request: the first is rejected, a new one waits', vfRefund.id !== noFault!.id
    && (await RefundRequestModel.findById(noFault!.id))?.status === 'rejected' && vfRefund.status === 'awaiting_approval');
  assert('vendor at fault: the customer gets everything back', vfRefund.gross_amount === vfPrepaid && vfRefund.net_amount === vfPrepaid && vfRefund.fees?.paid_by === 'vendor');
  await settle(vfRefund.id);
  const vfAccount = await EarningsAccountModel.findOne({ owner_type: 'vendor', owner_id: vendorFault.vendorId });
  assert('…the vendor owes the agency\'s return fee and both refund fees', vfAccount?.clawback_balance === RTO_FEE + vfRefund.fees!.vendor_charge, vfAccount?.clawback_balance);
  assert('…the agency is paid for its trip', (await EarningsAllocationModel.find({ source_type: 'shipment', source_id: vfParcel })).reduce((s, r) => s + r.amount, 0) === RTO_FEE);
  assert('…and the charge says why', (await EarningsAdjustmentModel.findOne({ refund_key: vfRefund.id }))?.reason_code === 'partial_return_fault');

  const agencyFault = await buildWorld('agencyfault');
  await settings.setPartialPayment(agencyFault.vendorId, { enabled: true, min_percent: 30 });
  await settings.setAutoRedirectOrdersToAgency(agencyFault.vendorId, true);
  const af = await paidCheckout(agencyFault, 15_000);
  const afParcel = await comesBack(agencyFault, 1, af.orderId, 'customer_absent');
  await partialReturnService.openForReturnedParcels(af.orderId);
  const afProposed = await openRefundOf(af.orderId);
  assert('D-10: an absent customer proposes the customer\'s fault', afProposed?.partial_return?.fault === 'customer');
  const afRefund = await partialReturnService.setFault(afProposed!.id, 'agency', ACTOR);
  assert('an administrator can overrule the agent: the customer gets everything back', afRefund.net_amount === (await ShipmentModel.findById(afParcel))!.prepaid_amount && afRefund.fees?.paid_by === 'agency');
  await settle(afRefund.id);
  const afAccount = await EarningsAccountModel.findOne({ owner_type: 'agency', owner_id: agencyFault.agencies[1] });
  assert('…the agency owes both refund fees', afAccount?.clawback_balance === afRefund.fees!.agency_charge && afRefund.fees!.agency_charge! > 0, afAccount?.clawback_balance);
  assert('…and earns nothing for the trip', (await EarningsAllocationModel.countDocuments({ source_type: 'shipment', source_id: afParcel })) === 0);

  // ═══ 7 ═══════════════════════════════════════════════════════════════════════
  heading('A parcel loses value after the payment');
  const shrink = await buildWorld('shrink');
  await settings.setPartialPayment(shrink.vendorId, { enabled: true, min_percent: 30 });
  const sh = await paidCheckout(shrink, 15_000);
  const shParcel = await outForDelivery(sh.orderId, shrink.agencies[1], shrink.agents[1]);
  const shOther = await ShipmentModel.findOne({ order_id: sh.orderId, agency_id: shrink.agencies[0] });
  const shOrder = await OrderModel.findById(sh.orderId);
  // Half the items leave parcel B, the way a move to another agency leaves it.
  const shrunkPrice = Math.floor(PRICE_B / 2);
  shOrder!.items.find((i) => i._id.equals(shParcel.items[0].order_item_id))!.price = shrunkPrice;
  await shOrder!.save();
  await transactionManager.runInTransaction((session) => partialPaymentService.reshareInSession(sh.orderId, session));
  const [reB, reA, reCollection] = await Promise.all([
    ShipmentModel.findById(shParcel._id),
    ShipmentModel.findById(shOther!._id),
    CashCollectionModel.findOne({ shipment_id: shParcel._id }),
  ]);
  assert('the prepaid amount is shared again, and none of it is lost', (reA!.prepaid_amount ?? 0) + (reB!.prepaid_amount ?? 0) === 15_000, [reA!.prepaid_amount, reB!.prepaid_amount]);
  assert('the waiting collection follows its parcel', reCollection?.prepaid_amount === reB!.prepaid_amount
    && reCollection?.expected_amount === shrunkPrice + (reB!.customer_delivery_fee ?? 0) - (reB!.prepaid_amount ?? 0));

  // ═══ 8 ═══════════════════════════════════════════════════════════════════════
  heading('Paid after the order was cancelled');
  const late = await buildWorld('late');
  await settings.setPartialPayment(late.vendorId, { enabled: true, min_percent: 30 });
  await fillCart(late);
  const lateCheckout = await orderService.createOrdersFromCart(late.customerId, 'cash_on_delivery', { address: asInput(DROP_OFF) }, { partialPayment: true });
  const lateOrder = lateCheckout.orders[0];
  await orderService.cancelOrder(lateOrder, { actorType: 'system', actorId: null, reason: 'unpaid' });
  await payOnline(late, lateCheckout.cartId, lateOrder._id as Types.ObjectId, 15_000);
  const lateRefund = await RefundRequestModel.findOne({ source_id: lateOrder._id, status: 'awaiting_approval' });
  assert('a refund of what arrived waits for a person', lateRefund?.gross_amount === 15_000);
  assert('nothing was dispatched', (await ShipmentModel.countDocuments({ order_id: lateOrder._id, status: { $ne: 'pending' } })) === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
