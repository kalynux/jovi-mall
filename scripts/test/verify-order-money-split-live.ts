/**
 * verify:order-money-split — the administrator's money-split view against a real database.
 *
 * `test:order-money-split` proves the assembly and the structure offline. What it cannot prove
 * is the claim the whole view rests on: **what it PROJECTS before a split is what the split then
 * ALLOCATES.** This drives the real `EarningsSplitService` (transactions and all) between two
 * reads of the view and compares, on the owner's own example — sold 65 000 over a 50 000
 * minimum, 10% plan:
 *
 *   A. prepaid, vendor-paid 2 000 delivery: projection → `splitOrder` → `splitShipmentDelivery`;
 *   B. COD, customer-paid 2 000 delivery, 1% COD handling fee: projection → `splitCodCollection`.
 *
 * Needs a Mongo REPLICA SET (the splits open transactions). It writes its own fixtures under
 * fresh ObjectIds — inserted raw, so no schema default invents a field — and deletes everything
 * it wrote, pass or fail, including the earnings accounts the splits credited. The commission
 * rate is injected (10%) so no plan has to exist.
 *
 * Run: MONGO_URI=mongodb://127.0.0.1:27117/verify_split?replicaSet=rs0 npm run verify:order-money-split
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';

import { EarningsSplitService } from '../../src/modules/earnings/services/earnings-split.service';
import { OrderMoneySplitService } from '../../src/modules/earnings/services/order-money-split.service';
import { OrderMoneySplitDto, MoneySplitSection } from '../../src/modules/earnings/domain/order-money-split';
import { OrderModel } from '../../src/modules/orders/order.model';
import { ShipmentModel } from '../../src/modules/shipments/shipment.model';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

let passed = 0;
let failed = 0;

async function assert(label: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed += 1;
        console.log(`  ✅ ${label}`);
    } catch (error) {
        failed += 1;
        console.log(`  ❌ FAIL: ${label}`);
        console.log(`     ${error instanceof Error ? error.message : String(error)}`);
    }
}

function eq<T>(actual: T, expected: T, what: string): void {
    if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** `role:amount` for every non-customer line, sorted — the comparable fingerprint of a section. */
function fingerprint(section: MoneySplitSection | undefined): string {
    if (!section) return '(missing)';
    return section.lines
        .map((l) => `${l.role}:${l.beneficiary.type}:${l.amount}`)
        .sort()
        .join(' | ');
}

const created = {
    orders: [] as Types.ObjectId[],
    shipments: [] as Types.ObjectId[],
    collections: [] as Types.ObjectId[],
    agencies: [] as Types.ObjectId[],
    vendors: [] as Types.ObjectId[],
};

const stubEntitlements = { getEntitlements: async () => ({ commissionPercent: 10 }) } as any;
const splits = new EarningsSplitService(undefined, undefined, stubEntitlements);
const view = new OrderMoneySplitService(splits);

async function seedAgency(codFeePercent: number): Promise<Types.ObjectId> {
    const _id = new Types.ObjectId();
    created.agencies.push(_id);
    await DeliveryAgencyModel.collection.insertOne({
        _id,
        user_id: new Types.ObjectId(), // unique index — one agency per user
        status: 'active',
        policies: {
            pricing: {
                base_rate: 2000,
                additional_fees: {
                    cod_handling_fee: { type: 'percentage', value: codFeePercent },
                    failed_delivery_fee: 0,
                    rto_fee: 500,
                },
            },
        },
        created_at: new Date(),
        updated_at: new Date(),
    } as any);
    return _id;
}

async function seedOrder(input: {
    cod: boolean;
    customerPaysDelivery: boolean;
    agencyId: Types.ObjectId;
}): Promise<{ orderId: Types.ObjectId; shipmentId: Types.ObjectId; itemId: Types.ObjectId; vendorId: Types.ObjectId; customerId: Types.ObjectId }> {
    const orderId = new Types.ObjectId();
    const shipmentId = new Types.ObjectId();
    const itemId = new Types.ObjectId();
    const vendorId = new Types.ObjectId();
    const customerId = new Types.ObjectId();
    created.orders.push(orderId);
    created.shipments.push(shipmentId);
    created.vendors.push(vendorId);

    const delivery = input.customerPaysDelivery ? 2000 : 0;
    await OrderModel.collection.insertOne({
        _id: orderId,
        order_number: `VERIFY-SPLIT-${orderId.toString().slice(-6)}`,
        order_type: 'physical',
        cart_id: new Types.ObjectId(),
        vendor_id: vendorId,
        customer_id: customerId,
        items: [
            {
                _id: itemId,
                product_id: new Types.ObjectId(),
                variant_id: new Types.ObjectId(),
                sku: 'VERIFY-SKU',
                title: 'Verify phone',
                price: 65000,
                floor_price_snapshot: 50000,
                quantity: 1,
            },
        ],
        currency: 'XAF',
        price_breakdown: { base: 65000, tax: 0, discount: 0, delivery, total: 65000 + delivery },
        total_amount: 65000 + delivery,
        delivery_payer: input.customerPaysDelivery ? 'customer' : 'vendor',
        payment_method: input.cod ? 'cash_on_delivery' : 'mobile_money',
        payment_status: input.cod ? 'pending' : 'AWAITING_PAYMENT',
        fulfillment_status: 'pending',
        completion: { confirmed_at: null, confirmed_by: null, auto: false },
        delivery_address: null,
        created_at: new Date(),
        updated_at: new Date(),
    } as any);

    await ShipmentModel.collection.insertOne({
        _id: shipmentId,
        order_id: orderId,
        agency_id: input.agencyId,
        agent_id: null,
        status: 'pending',
        tracking_number: null,
        status_history: [],
        delivery_failures: [],
        delivery_fee_snapshot: 2000,
        delivery_payer: input.customerPaysDelivery ? 'customer' : 'vendor',
        customer_delivery_fee: delivery,
        items: [{ order_item_id: itemId, quantity: 1 }],
        created_at: new Date(),
        updated_at: new Date(),
    } as any);

    return { orderId, shipmentId, itemId, vendorId, customerId };
}

async function cleanUp(): Promise<void> {
    const sourceIds = [...created.orders, ...created.shipments, ...created.collections];
    const allocations = await EarningsAllocationModel.find({ source_id: { $in: sourceIds } }, { _id: 1 }).lean();
    await EarningsLedgerModel.deleteMany({ allocation_id: { $in: allocations.map((a) => a._id) } });
    await EarningsAllocationModel.deleteMany({ source_id: { $in: sourceIds } });
    // The splits credited the vendor's account (fresh id → ours) and the two platform singletons.
    // The singletons are reset only if THIS run created them: never touch a pre-existing balance.
    await EarningsAccountModel.deleteMany({ owner_type: 'vendor', owner_id: { $in: created.vendors } });
    await EarningsAccountModel.deleteMany({ owner_type: 'agency', owner_id: { $in: created.agencies } });
    if (platformAccountsWereAbsent) {
        await EarningsAccountModel.deleteMany({ owner_type: { $in: ['platform', 'platform_ai'] }, owner_id: null });
    }
    await CashCollectionModel.deleteMany({ _id: { $in: created.collections } });
    await ShipmentModel.deleteMany({ _id: { $in: created.shipments } });
    await OrderModel.deleteMany({ _id: { $in: created.orders } });
    await DeliveryAgencyModel.deleteMany({ _id: { $in: created.agencies } });
}

let platformAccountsWereAbsent = false;

async function main(): Promise<void> {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    platformAccountsWereAbsent =
        (await EarningsAccountModel.countDocuments({ owner_type: { $in: ['platform', 'platform_ai'] } })) === 0;

    // ── A. prepaid, vendor pays a 2 000 delivery ──────────────────────────────────────────
    console.log('\n── A. Prepaid, vendor-paid delivery ──');
    const agencyA = await seedAgency(1);
    const a = await seedOrder({ cod: false, customerPaysDelivery: false, agencyId: agencyA });

    const before = await view.getForOrder(a.orderId.toString());
    const payBefore = before.sections.find((s) => s.moment === 'payment');
    const shipBefore = before.sections.find((s) => s.moment === 'delivery');

    await assert('before payment: both sections are projected', () => {
        eq(payBefore?.state, 'projected', 'payment');
        eq(shipBefore?.state, 'projected', 'delivery');
        eq(before.estimated, true, 'estimated');
    });
    await assert('the owner\'s example: bargain fee 4 500, commission 6 050, vendor 52 450, agency 2 000', () => {
        eq(payBefore?.goods?.bargainFee.amount, 4500, 'bargain fee');
        eq(payBefore?.goods?.commission.amount, 6050, 'commission');
        eq(payBefore?.goods?.commission.base, 60500, 'commission base');
        eq(payBefore?.goods?.deliveryFeeCharged, 2000, 'delivery charged to vendor');
        eq(payBefore?.goods?.vendorNet, 52450, 'vendor net');
        eq(before.totals.agencies, 2000, 'agency');
    });
    await assert('the bargain-fee basis names the item, its minimum and its uplift', () => {
        const line = payBefore?.goods?.bargainFee.lines[0];
        eq(line?.floorPrice, 50000, 'floor');
        eq(line?.uplift, 15000, 'uplift');
        eq(line?.fee, 4500, 'fee');
    });
    await assert('projected: charged 65 000 = distributed 65 000', () => {
        eq(before.reconciliation.charged, 65000, 'charged');
        eq(before.reconciliation.difference, 0, 'difference');
    });
    await assert('no agent yet → agentCut null and the note says so', () => {
        eq(shipBefore?.delivery?.agentCut, null, 'agentCut');
        if (!shipBefore?.notes.includes('agent_not_assigned')) throw new Error('note missing');
    });

    const order = await OrderModel.findById(a.orderId);
    await splits.splitOrder(order!);
    const afterPay = await view.getForOrder(a.orderId.toString());
    const payAfter = afterPay.sections.find((s) => s.moment === 'payment');

    await assert('after payment: the payment section is allocated', () => eq(payAfter?.state, 'allocated', 'state'));
    await assert('⭐ PROJECTED == ALLOCATED for the payment split', () =>
        eq(fingerprint(payAfter), fingerprint(payBefore), 'payment lines'));
    await assert('the allocated basis reads back the same delivery charge and rate', () => {
        eq(payAfter?.goods?.deliveryFeeCharged, 2000, 'delivery charged');
        eq(payAfter?.goods?.commission.percent, 10, 'rate snapshot');
    });
    await assert('allocated lines are held, waiting on the order completing', () => {
        const vendorLine = payAfter?.lines.find((l) => l.role === 'vendor_net');
        eq(vendorLine?.status, 'held', 'status');
        eq(vendorLine?.waitingOn.join(), 'order_not_completed', 'waitingOn');
    });
    await assert('the delivery section is still projected until the run is over', () =>
        eq(afterPay.sections.find((s) => s.moment === 'delivery')?.state, 'projected', 'delivery'));

    await ShipmentModel.collection.updateOne({ _id: a.shipmentId }, { $set: { status: 'agent_delivered' } });
    const shipment = await ShipmentModel.findById(a.shipmentId);
    await splits.splitShipmentDelivery((await OrderModel.findById(a.orderId))!, shipment!, 'delivered');
    const afterDelivery = await view.getForOrder(a.orderId.toString());
    const shipAfter = afterDelivery.sections.find((s) => s.moment === 'delivery');

    await assert('after delivery: allocated', () => eq(shipAfter?.state, 'allocated', 'state'));
    await assert('⭐ PROJECTED == ALLOCATED for the delivery split', () =>
        eq(fingerprint(shipAfter), fingerprint(shipBefore), 'delivery lines'));
    await assert('fully split: difference 0, complete, not estimated', () => {
        eq(afterDelivery.reconciliation.difference, 0, 'difference');
        eq(afterDelivery.reconciliation.complete, true, 'complete');
        eq(afterDelivery.estimated, false, 'estimated');
        eq(afterDelivery.totals.platform.total, 10550, 'platform total');
    });

    // ── B. COD, customer pays a 2 000 delivery, 1% COD handling fee ───────────────────────
    console.log('\n── B. COD, customer-paid delivery ──');
    const agencyB = await seedAgency(1);
    const b = await seedOrder({ cod: true, customerPaysDelivery: true, agencyId: agencyB });

    const codBefore = await view.getForOrder(b.orderId.toString());
    const cashBefore = codBefore.sections.find((s) => s.moment === 'cash_collection');

    await assert('a COD order has no payment section, one cash-collection section', () => {
        eq(codBefore.sections.some((s) => s.moment === 'payment'), false, 'payment section');
        eq(cashBefore?.state, 'projected', 'cash section');
    });
    await assert('customer pays delivery: the vendor bears none of it; the COD fee is 1% of the GOODS (650)', () => {
        eq(cashBefore?.goods?.deliveryFeeCharged, 0, 'vendor-borne');
        eq(cashBefore?.goods?.codHandlingFee, 650, 'cod fee');
        eq(cashBefore?.goods?.vendorNet, 65000 - 4500 - 6050 - 650, 'vendor net');
        eq(cashBefore?.delivery?.customerPaid, 2000, 'customer paid');
    });
    await assert('projected: charged 67 000 = distributed', () => {
        eq(codBefore.reconciliation.charged, 67000, 'charged');
        eq(codBefore.reconciliation.difference, 0, 'difference');
    });

    const collectionId = new Types.ObjectId();
    created.collections.push(collectionId);
    const agentId = new Types.ObjectId();
    await CashCollectionModel.collection.insertOne({
        _id: collectionId,
        order_id: b.orderId,
        shipment_id: b.shipmentId,
        agency_id: agencyB,
        agent_id: agentId,
        customer_id: b.customerId,
        vendor_id: b.vendorId,
        kind: 'order',
        expected_amount: 67000,
        items_amount: 65000,
        delivery_fee_amount: 2000,
        currency: 'XAF',
        status: 'collected',
        code_hash: 'verify',
        created_at: new Date(),
        updated_at: new Date(),
    } as any);
    const collection = await CashCollectionModel.findById(collectionId);
    await splits.splitCodCollection((await OrderModel.findById(b.orderId))!, collection!);
    const codAfter = await view.getForOrder(b.orderId.toString());
    const cashAfter = codAfter.sections.find((s) => s.moment === 'cash_collection');

    await assert('after collection: allocated, sourced from the collection', () => {
        eq(cashAfter?.state, 'allocated', 'state');
        eq(cashAfter?.source.id, collectionId.toString(), 'source');
    });
    await assert('⭐ PROJECTED == ALLOCATED for the COD split (agent has no contract → cut 0)', () =>
        eq(fingerprint(cashAfter), fingerprint(cashBefore), 'cash lines'));
    await assert('the allocated basis reads the COD fee back as the agency row\'s residual (650)', () =>
        eq(cashAfter?.goods?.codHandlingFee, 650, 'cod fee'));
    await assert('COD lines wait on the cash reaching the platform too', () => {
        const vendorLine = cashAfter?.lines.find((l) => l.role === 'vendor_net');
        eq(vendorLine?.waitingOn.join(), 'order_not_completed,cash_not_settled', 'waitingOn');
    });
    await assert('fully split COD order reconciles to 67 000', () => {
        eq(codAfter.reconciliation.distributed, 67000, 'distributed');
        eq(codAfter.reconciliation.difference, 0, 'difference');
    });

    // ── C. an unknown order ──────────────────────────────────────────────────────────────
    console.log('\n── C. Refusals ──');
    await assert('an unknown order is a 404 ORDER_NOT_FOUND', async () => {
        try {
            await view.getForOrder(new Types.ObjectId().toString());
            throw new Error('no error');
        } catch (error) {
            eq((error as { code?: string }).code, 'ORDER_NOT_FOUND', 'code');
        }
    });

    printSummary(before);
}

function printSummary(example: OrderMoneySplitDto): void {
    console.log('\n  Owner\'s example, projected before payment:');
    for (const s of example.sections) {
        console.log(`    [${s.moment}/${s.state}] ${s.lines.map((l) => `${l.role}=${l.amount}`).join(', ')}`);
    }
}

main()
    .catch((error) => {
        failed += 1;
        console.error('  ❌ THROW:', error);
    })
    .finally(async () => {
        try {
            await cleanUp();
        } catch (error) {
            console.error('  ⚠ cleanup failed:', error);
        }
        await mongoose.disconnect();
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exit(failed > 0 ? 1 : 0);
    });
