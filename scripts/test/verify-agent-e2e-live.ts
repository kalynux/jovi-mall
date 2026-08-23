/**
 * verify:agent-e2e — one COD delivery, end to end, against REAL Mongo.
 * **NEEDS Mongo as a REPLICA SET** (`rs0` in dev — every step runs a transaction).
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 *
 * The second of the two verification items `AGENT-CONTRACT-REFACTOR.md` has
 * carried since the build finished: *"E2E against live Mongo — the 8-step
 * scenario"*. `verify:agent-contract` is the first, and the two are deliberately
 * different in kind:
 *
 *   - `verify:agent-contract` proves each INVARIANT in isolation, by reaching for
 *     the service that owns it. Fast, precise, and blind to wiring.
 *   - this file proves the CHAIN. It touches one service per step and asserts
 *     what the *next* one sees — which is the only way to catch a hop that was
 *     never wired, an event nobody emits, or a post-commit side effect that
 *     silently no-ops. Every defect the refactor doc records under "Found while
 *     doing step 1" is of that shape.
 *
 * It drives the **real services** — `OrderService`, `ShipmentAssignmentService`,
 * `ShipmentService`, `CashCollectionService`, `AgentDepositService`,
 * `AgentContractService` — exactly as `seed:cod-shipments` does, so every row is
 * what the running API would have produced: a real generated tracking number, a
 * real hashed-and-plaintext delivery code, a real capacity reservation, real cash
 * ledgers, a real earnings split and real tracking-outbox rows.
 *
 * ── The eight steps ───────────────────────────────────────────────────────────
 *
 *   1. The contract forms — agency proposes terms, agent approves, the COD slice
 *      is allocated out of the agent's pool.
 *   2. A customer checks out COD — the order splits into a shipment on the agency.
 *   3. The agency offers it; the agent ACCEPTS — capacity reserved, agent bound,
 *      delivery code issued, the session-opening outbox row written.
 *   4. Picked up, then in transit — one honest verdict per transition.
 *   5. The customer's code is submitted — the shipment is delivered, the cash is
 *      credited to agent AND agency, the contract slice rises, earnings allocate.
 *   6. The agent hands the cash to the agency — declare, then confirm. Only the
 *      confirmation moves money.
 *   7. Capacity comes back, and the shipment's tracking session closes terminal.
 *   8. The contract terminates cleanly — blockers clear, the slice leaves the pool.
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *
 * It builds its OWN world under the `e2eac…` id prefix and the `e2eac-` tag — its
 * own user, vendor, store, product, variant, customer, agency and agent — and
 * deletes every one of them in a `finally`, pass or fail. It reads and writes no
 * pre-existing row, which is why it does not share `seed:cod-shipments`' fixture
 * (that seed reuses a real agency and a real agent, and MODIFIES their contract).
 *
 * ⚠ **Side effects are real, because the code paths are.** Issuing a COD delivery
 * code notifies the customer over WhatsApp and every agent notification fires an
 * FCM push, so with `WHATSAPP_ACCESS_TOKEN` / `FCM_ENABLED` set in `.env` those
 * requests genuinely go out and fail against this fake number and absent device.
 * Harmless and best-effort — but it is what makes the run slow.
 *
 * Run: npm run verify:agent-e2e
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { VendorSettingsModel } from '../../src/modules/vendors/models/vendor-settings.model';
import { VendorSettingsRepository } from '../../src/modules/vendors/repositories/vendor-settings.repository';
import { StoreModel } from '../../src/modules/store/models/store.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { DeliveryAgentModel, AgentAgencyContractModel } from '../../src/modules/agents';
import { agentContractService } from '../../src/modules/agents/domain/services/agent-contract.service';
import { agentCodThresholdService } from '../../src/modules/agents/domain/services/agent-cod-threshold.service';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { CartModel } from '../../src/modules/cart/models/cart.model';
import { OrderModel } from '../../src/modules/orders/order.model';
import { OrderService } from '../../src/modules/orders/order.service';
import { OrderTimelineModel } from '../../src/modules/orders/order-timeline.model';
import { ShipmentModel, IShipment } from '../../src/modules/shipments/shipment.model';
import { ShipmentService } from '../../src/modules/shipments/shipment.service';
import { shipmentAssignmentService } from '../../src/modules/shipment-assignment';
import { ShipmentAssignmentOfferModel } from '../../src/modules/shipment-assignment/models/shipment-assignment-offer.model';
import { ShipmentAssignmentSessionModel } from '../../src/modules/shipment-assignment/models/shipment-assignment-session.model';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { CodCashAccountModel } from '../../src/modules/cod/models/cod-cash-account.model';
import { CodCashLedgerModel } from '../../src/modules/cod/models/cod-cash-ledger.model';
import { AgentDepositModel } from '../../src/modules/cod/models/agent-deposit.model';
import { cashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { agentDepositService } from '../../src/modules/cod/services/agent-deposit.service';
import { codCashAccountService } from '../../src/modules/cod/services/cod-cash-account.service';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { TrackingOutboxModel } from '../../src/modules/tracking-integration/models/tracking-outbox.model';
import { generateSystemPassword } from '../../src/core/auth/system-password';
import { IGeoAddress, GeoAddressInput } from '../../src/core/types/geo-address.types';

const CURRENCY = 'XAF';
const TAG = 'e2eac-';
/** `e2eac…` = "E2E agent contract". Every id this script writes carries it. */
const eid = (suffix: string) => new Types.ObjectId(`e2eac${'0'.repeat(19 - suffix.length)}${suffix}`);

const ID = {
  vendorUser: eid('01'),
  vendor: eid('02'),
  store: eid('03'),
  customerUser: eid('04'),
  customer: eid('05'),
  agencyUser: eid('06'),
  agency: eid('07'),
  agentUser: eid('08'),
  agent: eid('09'),
};

/** The agent's global pool, and the slice this one agency is granted from it. */
const AGENT_POOL = 500_000;
const CONTRACT_SLICE = 200_000;
/** One unit of the one product. Comfortably inside the slice. */
const UNIT_PRICE = 45_000;

let passed = 0;
let failed = 0;
let step = 0;

function assert(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}${detail ? `\n       ${detail}` : ''}`);
    failed++;
  }
}

function heading(title: string): void {
  step += 1;
  console.log(`\n── Step ${step} · ${title} ${'─'.repeat(Math.max(2, 62 - title.length))}\n`);
}

const money = (n: number) => `${n.toLocaleString('en-US')} ${CURRENCY}`;

// A real Douala drop-off, so the geocoded snapshot on the order is a real place
// rather than a plausible-looking pair of numbers.
const DROP_OFF: IGeoAddress = {
  formatted_address: 'Rue Njo-Njo, Bonapriso, Douala, Littoral, Cameroun',
  coordinates: { type: 'Point', coordinates: [9.7043, 4.0301] },
  provider: 'nominatim',
  provider_place_id: null,
  components: {
    street: 'Rue Njo-Njo',
    neighbourhood: 'Bonapriso',
    city: 'Douala',
    region: 'Littoral',
    country: 'Cameroun',
    country_code: 'cm',
    postal_code: null,
  },
  raw_input: 'Bonapriso Douala',
  resolved_at: new Date(),
};

const PICKUP: IGeoAddress = {
  ...DROP_OFF,
  formatted_address: 'Boulevard de la Liberté, Akwa, Douala, Littoral, Cameroun',
  coordinates: { type: 'Point', coordinates: [9.7085, 4.0511] },
  components: { ...DROP_OFF.components, street: 'Boulevard de la Liberté', neighbourhood: 'Akwa' },
  raw_input: 'Akwa Douala',
};

/** The validated-input shape `OrderService` takes, from the persisted one. */
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
const vendorSettingsRepo = new VendorSettingsRepository();

// ─────────────────────────────────────────────────────────────────────────────
// The world. Built here, deleted in the finally — nothing pre-existing is touched.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  const owned = Object.values(ID);
  const orders = await OrderModel.find({ customer_id: ID.customerUser }).select('_id');
  const orderIds = orders.map((o) => o._id);
  const shipments = await ShipmentModel.find({ agency_id: ID.agency }).select('_id');
  const shipmentIds = shipments.map((s) => s._id);
  const products = await ProductModel.find({ vendorId: ID.vendor }).select('_id');
  const productIds = products.map((p) => p._id);
  const collections = await CashCollectionModel.find({ agency_id: ID.agency }).select('_id');
  const collectionIds = collections.map((c) => c._id);

  await Promise.all([
    UserModel.deleteMany({ _id: { $in: owned } }),
    CustomerModel.deleteMany({ _id: { $in: owned } }),
    VendorModel.deleteMany({ _id: { $in: owned } }),
    VendorSettingsModel.deleteMany({ vendor_id: ID.vendor }),
    StoreModel.deleteMany({ _id: { $in: owned } }),
    DeliveryAgencyModel.deleteMany({ _id: { $in: owned } }),
    DeliveryAgentModel.deleteMany({ _id: { $in: owned } }),
    AgentAgencyContractModel.deleteMany({ agent_id: ID.agent }),
    ProductModel.deleteMany({ vendorId: ID.vendor }),
    // By product, never by a SKU-prefix regex — `new RegExp()` is banned repo-wide
    // (every search path here is `$regex`-based, so an unescaped term is injection
    // + ReDoS), and the parent id is the exact answer anyway.
    ProductVariantModel.deleteMany({ productId: { $in: productIds } }),
    CartModel.deleteMany({ userId: ID.customerUser.toString() }),
    OrderModel.deleteMany({ _id: { $in: orderIds } }),
    // Append-only by design — a pre-hook rejects deletes, so a teardown has to
    // go under it via the raw collection. Same reason seed:cod-shipments does.
    OrderTimelineModel.collection.deleteMany({ order_id: { $in: orderIds } }),
    ShipmentModel.deleteMany({ _id: { $in: shipmentIds } }),
    ShipmentAssignmentOfferModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    ShipmentAssignmentSessionModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    CashCollectionModel.deleteMany({ agency_id: ID.agency }),
    AgentDepositModel.deleteMany({ agent_id: ID.agent }),
    CodCashAccountModel.deleteMany({ owner_id: { $in: [ID.agent.toString(), ID.agency.toString()] } }),
    CodCashLedgerModel.deleteMany({ owner_id: { $in: [ID.agent.toString(), ID.agency.toString()] } }),
    EarningsAccountModel.deleteMany({ owner_id: { $in: owned.map(String) } }),
    EarningsAllocationModel.deleteMany({ source_id: { $in: [...orderIds, ...shipmentIds, ...collectionIds] } }),
    EarningsLedgerModel.deleteMany({ owner_id: { $in: owned.map(String) } }),
    TrackingOutboxModel.deleteMany({ agent_id: ID.agent.toString() }),
  ]);
}

async function buildWorld(): Promise<{ variantId: Types.ObjectId; productId: Types.ObjectId; sku: string }> {
  const hash = await bcrypt.hash(generateSystemPassword(), 10);

  // ── The three accounts ────────────────────────────────────────────────────
  await UserModel.create([
    { _id: ID.vendorUser, login_email: `${TAG}vendor@jovitest.cm`, password_hash: hash, roles: ['vendor'], status: 'active' },
    { _id: ID.customerUser, login_email: `${TAG}customer@jovitest.cm`, password_hash: hash, roles: ['customer'], status: 'active' },
    { _id: ID.agencyUser, login_email: `${TAG}agency@jovitest.cm`, password_hash: hash, roles: ['agency'], status: 'active' },
    { _id: ID.agentUser, login_email: `${TAG}agent@jovitest.cm`, password_hash: hash, roles: ['agent'], status: 'active' },
  ]);

  await CustomerModel.create({
    _id: ID.customer,
    user_id: ID.customerUser,
    name: 'Amina E2E',
    email: `${TAG}customer@jovitest.cm`,
    email_verified: true,
    phone: '+237699000911',
    phone_verified: true,
    timezone: 'Africa/Douala',
    status: 'active',
  });

  // ── The agency. COD must be ENABLED or the order cannot be COD at all. ────
  await DeliveryAgencyModel.create({
    _id: ID.agency,
    user_id: ID.agencyUser,
    name: 'E2E Express Logistics',
    email: `${TAG}agency@jovitest.cm`,
    phone: '+237699000912',
    status: 'active',
    policies: {
      pricing: {
        storage_based: {
          enabled: true,
          monthly_storage_fee_per_sku: 500,
          pick_pack_fee_per_order: 300,
          local_delivery_fee: 1000,
          out_of_region_delivery_fee: 2500,
        },
        pickup_based: {
          enabled: true,
          base_rate_first_kg: 1500,
          additional_per_kg: 300,
          out_of_region_surcharge: 500,
        },
        additional_fees: {
          cod_handling_fee: { type: 'percentage', value: 2 },
          failed_delivery_fee: 500,
          rto_fee: 1000,
          peak_season_surcharge: 0,
        },
        notes: null,
      },
      returns: { payer: 'vendor', handling_fee: 500, return_window_days: 7, notes: null },
      damage: { claim_deadline_days: 3, max_refund_per_item: 50_000, inspector: 'admin', investigation_fee: 1000, notes: null },
      cod: { enabled: true, max_order_amount: null },
      documents: [],
    },
  });

  // ── The agent. Every eligibility gate is set deliberately: an agent who
  //    fails one of these is refused at accept, and the failure would read as a
  //    bug in whatever step happened to be running.
  await DeliveryAgentModel.create({
    _id: ID.agent,
    user_id: ID.agentUser,
    name: 'Pierre E2E',
    email: `${TAG}agent@jovitest.cm`,
    phone: '+237699000913',
    status: 'active',
    kyc: { status: 'verified', verified_at: new Date() },
    availability: { state: 'online', changed_at: new Date() },
    tracking: { allowed: true, changed_at: new Date() },
    capacity: { max_active_shipments: 3, active_shipment_count: 0 },
    cod: { trust_score: 100, max_threshold: AGENT_POOL },
    home_base: { location: { type: 'Point', coordinates: [9.7085, 4.0511] }, radius_km: 25 },
  });

  // ── The vendor, its store, and one product with a real geocoded pickup ────
  const vendor = await VendorModel.create({
    _id: ID.vendor,
    user_id: ID.vendorUser,
    business_name: 'E2E Home & Electronics',
    display_name: 'E2E Home',
    business_description: 'verify:agent-e2e fixture vendor.',
    country: 'CM',
    email: `${TAG}vendor@jovitest.cm`,
    phone: '+237699000914',
    email_verified: true,
    phone_verified: true,
    business_addresses: [
      {
        label: 'Boutique Akwa',
        address_line1: 'Boulevard de la Liberté, Akwa',
        address_line2: null,
        city: 'Douala',
        state: 'Littoral',
        location: PICKUP.coordinates,
        geo: PICKUP,
      },
    ],
    kyc_details: { national_id_number: 'CNI-E2E-01', legit_verified: true },
    default_delivery_agency_id: ID.agency,
    status: 'active',
    onboarding_step: 0,
  });

  await StoreModel.create({
    _id: ID.store,
    vendor_id: ID.vendor,
    name: 'E2E Home & Electronics',
    slug: `${TAG}e2e-home`,
    description: 'verify:agent-e2e fixture store.',
  });

  // Auto-redirect ON so a COD order's shipment lands on the agency as
  // `assigned` at checkout — the state an offer can be placed from.
  await vendorSettingsRepo.setAutoRedirectOrdersToAgency(ID.vendor.toString(), true);

  const addresses = vendor.business_addresses as unknown as Array<{ _id: Types.ObjectId }>;

  const product = await ProductModel.create({
    vendorId: ID.vendor,
    type: 'physical',
    status: 'active',
    title: 'E2E Solar Lamp',
    description: 'verify:agent-e2e fixture product.',
    slug: `${TAG}solar-lamp`,
    category: 'Maison & Électronique',
    tags: ['e2e-agent-contract'],
    seo: { title: 'E2E Solar Lamp', description: 'E2E Solar Lamp' },
    hasVariants: false,
    delivery: {
      agency_id: ID.agency,
      free_delivery: false,
      pickup_location: { source: 'vendor_address', vendor_address_id: addresses[0]._id },
    },
  });

  // `sku` is unique across the whole collection — it needs the tag as much as
  // the slug does.
  const sku = `${TAG}SOLAR-LAMP-001`.toUpperCase();
  const variant = await ProductVariantModel.create({
    productId: product._id,
    sku,
    name: 'Default',
    status: 'active',
    optionSignature: 'default',
    price: UNIT_PRICE,
    stock: 500,
  });
  product.defaultVariantId = variant._id;
  await product.save();

  return { variantId: variant._id, productId: product._id, sku };
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall');

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  verify:agent-e2e — one COD delivery, end to end, against real Mongo');
  console.log('═══════════════════════════════════════════════════════════════════════');

  try {
    await cleanup();
    const fixture = await buildWorld();

    // ═══ 1 · The contract forms ═════════════════════════════════════════════
    heading('The contract forms, and allocates its slice of the pool');

    const requested = await agentContractService.requestFromAgency(
      ID.agency.toString(),
      ID.agent.toString(),
      // fee_split ONLY.  is deliberately not negotiable — it is the
      // agency's HR record and has its own endpoint, and proposing it here is a
      // 403 CONTRACT_TERMS_NOT_NEGOTIABLE. Same for the COD threshold below.
      { fee_split: { model: 'percentage', agent_share_percent: 30 } },
      { userId: ID.agencyUser.toString(), role: 'agency' }
    );
    const contractId = requested._id.toString();
    assert('an agency request lands PENDING, never active', requested.status === 'pending');
    assert('…with the agency recorded as the proposer of the terms', requested.terms_proposed_by === 'agency');

    const pendingAllocation = await agentCodThresholdService.getAllocation(ID.agent.toString());
    assert(
      'a PENDING contract allocates nothing — it was never approved',
      pendingAllocation.allocated === 0,
      `allocated ${pendingAllocation.allocated}`
    );

    const { contract: approved } = await agentContractService.requestTransition(
      contractId,
      'approve',
      'agent',
      { userId: ID.agentUser.toString(), role: 'agent' }
    );
    assert('the AGENT approving the standing proposal lands ACTIVE', approved?.status === 'active');

    // ⚠ The COD threshold is NOT part of the negotiated terms — it is a
    // sub-allocation of the agent's pool and must stay transactional, so it has
    // its own route through AgentCodThresholdService. A contract approved at 0
    // is one whose agent may carry no cash for this agency, and every COD
    // assignment on it fails COD_AGENT_EXPOSURE_EXCEEDED.
    const bornAt = await AgentAgencyContractModel.findById(contractId);
    assert(
      "a new contract's COD slice starts at ZERO — it is granted, never inherited",
      bornAt?.cod?.threshold === 0,
      `threshold = ${bornAt?.cod?.threshold}`
    );

    await agentCodThresholdService.setContractThreshold(ID.agent.toString(), contractId, CONTRACT_SLICE);

    const liveAllocation = await agentCodThresholdService.getAllocation(ID.agent.toString());
    assert(
      `granting the slice allocates ${money(CONTRACT_SLICE)} out of the pool`,
      liveAllocation.allocated === CONTRACT_SLICE,
      `allocated ${liveAllocation.allocated}`
    );
    assert(
      `…leaving ${money(AGENT_POOL - CONTRACT_SLICE)} of headroom`,
      liveAllocation.headroom === AGENT_POOL - CONTRACT_SLICE
    );

    // ═══ 2 · Checkout ═══════════════════════════════════════════════════════
    heading('A customer checks out cash-on-delivery');

    await CartModel.findOneAndReplace(
      { userId: ID.customerUser.toString() },
      {
        userId: ID.customerUser.toString(),
        productType: 'physical',
        items: [
          {
            variantId: fixture.variantId,
            sku: fixture.sku,
            variantTitle: 'Default',
            optionsSnapshot: 'default',
            productId: fixture.productId,
            title: 'E2E Solar Lamp',
            vendorId: ID.vendor,
            productType: 'physical',
            quantity: 1,
            price: UNIT_PRICE,
            currency: CURRENCY,
          },
        ],
      },
      { upsert: true, new: true }
    );

    const { orders } = await orderService.createOrdersFromCart(
      ID.customerUser.toString(),
      'cash_on_delivery',
      { address: asInput(DROP_OFF) }
    );
    const orderId = (orders[0]._id as Types.ObjectId).toString();
    assert('the cart becomes exactly one order', orders.length === 1);

    let shipment = await ShipmentModel.findOne({ order_id: orderId });
    if (shipment && shipment.status === 'pending') {
      await orderService.dispatchToAgency(orderId, { type: 'vendor', id: ID.vendorUser.toString() });
      shipment = await ShipmentModel.findOne({ order_id: orderId });
    }
    const shipmentId = (shipment!._id as Types.ObjectId).toString();

    assert('the order produces a shipment on the agency', shipment?.agency_id?.toString() === ID.agency.toString());
    assert('…sitting at `assigned` — the state an offer can be placed from', shipment?.status === 'assigned');
    assert(
      '…with NO agent bound yet — agents bind at accept, not at dispatch',
      shipment?.agent_id === null || shipment?.agent_id === undefined
    );
    assert(
      '…and a generated tracking number, never a written one',
      /^[A-Z0-9]{3}-\d{6}-\d{6}-[0-9A-Z]{5}$/.test(shipment?.tracking_number ?? ''),
      `tracking_number = ${shipment?.tracking_number}`
    );

    const dropOffSnapshot = await OrderModel.findById(orderId).select('delivery_address');
    assert(
      'the geocoded drop-off is SNAPSHOTTED onto the order, not referenced',
      dropOffSnapshot?.delivery_address?.formatted_address === DROP_OFF.formatted_address
    );

    // ⚠ THE SECOND FINDING THIS FILE EARNED, and it is why the assertion is here
    // rather than in a unit test. COD commits stock at ORDER CREATION (there is no
    // payment step to wait for), and the commit was a silent no-op: `StockCommitService`
    // smuggled `{ stock: { $inc: -n } }` through a repository `update()` that puts
    // everything under `$set`, Mongo threw a CastError, and `OrderStockService`
    // swallowed it as "stock commit skipped for order line". `variant.stock` was
    // never decremented on any sale and the overselling protection never ran —
    // with no symptom anywhere except a warn line nobody reads. Fixed by giving
    // the repository an explicit `adjustStock`; this is what stops it coming back.
    const soldVariant = await ProductVariantModel.findById(fixture.variantId);
    assert(
      'the sale DECREMENTED the variant stock — 500 → 499',
      soldVariant?.stock === 499,
      `stock = ${soldVariant?.stock} (500 means the commit silently no-op'd again)`
    );

    // A dispatch with no agent must not have opened a tracking session.
    const outboxAfterDispatch = await TrackingOutboxModel.countDocuments({ agent_id: ID.agent.toString() });
    assert(
      'dispatch emits NO tracking event — there is nobody to track yet',
      outboxAfterDispatch === 0,
      `${outboxAfterDispatch} row(s)`
    );

    // ═══ 3 · Offer and accept ═══════════════════════════════════════════════
    heading('The agency offers it; the agent accepts');

    const offered = await shipmentAssignmentService.offerToAgent(
      ID.agency.toString(),
      shipmentId,
      ID.agent.toString(),
      { role: 'agency', userId: ID.agencyUser.toString() }
    );

    const duringOffer = await DeliveryAgentModel.findById(ID.agent);
    assert(
      'an OFFER reserves no capacity — only acceptance does',
      duringOffer?.capacity?.active_shipment_count === 0
    );

    await shipmentAssignmentService.accept(ID.agent.toString(), offered.offer.id);
    shipment = await ShipmentModel.findById(shipmentId);

    assert('accepting binds the agent to the shipment', shipment?.agent_id?.toString() === ID.agent.toString());

    const afterAccept = await DeliveryAgentModel.findById(ID.agent);
    assert(
      '…and reserves exactly one capacity slot',
      afterAccept?.capacity?.active_shipment_count === 1,
      `count = ${afterAccept?.capacity?.active_shipment_count}`
    );

    const collection = await CashCollectionModel.findOne({ shipment_id: shipmentId }).select('+code_plain');
    assert('…and issues the COD delivery code, at ASSIGNMENT rather than pickup', !!collection?.code_plain);
    assert(
      `…for the order's amount (${money(UNIT_PRICE)} of goods)`,
      (collection?.expected_amount ?? 0) >= UNIT_PRICE,
      `expected_amount = ${collection?.expected_amount}`
    );
    assert('…in `pending` — nothing is collected yet', collection?.status === 'pending');

    const openingRow = await TrackingOutboxModel.findOne({ agent_id: ID.agent.toString() }).sort({ createdAt: -1 });
    assert('acceptance writes the session-OPENING tracking row', !!openingRow);
    assert(
      '…carrying shipmentTrackable = true, which is what opens the session',
      openingRow?.shipment_trackable === true,
      `shipment_trackable = ${openingRow?.shipment_trackable}`
    );

    // ═══ 4 · On the road ════════════════════════════════════════════════════
    heading('Picked up, then in transit');

    await shipmentService.updateStatus(ID.agency.toString(), shipmentId, 'picked_up', ID.agencyUser.toString());
    shipment = await ShipmentModel.findById(shipmentId);
    assert('the agency records the pickup', shipment?.status === 'picked_up');

    await shipmentService.updateStatusByAgent(ID.agent.toString(), shipmentId, 'in_transit', ID.agentUser.toString(), null);
    shipment = await ShipmentModel.findById(shipmentId);
    assert('the AGENT records departure — one map, two doors', shipment?.status === 'in_transit');

    const history = shipment?.status_history ?? [];
    const roles = history.map((h) => h.changed_by_role);
    assert(
      'the history distinguishes who drove each transition',
      roles.includes('agency') && roles.includes('agent'),
      `roles = ${roles.join(', ')}`
    );

    const rowsOnRoad = await TrackingOutboxModel.find({ agent_id: ID.agent.toString() }).sort({ createdAt: 1 });
    assert(
      'each transition emits its own row — a burst is not collapsed into the final state',
      rowsOnRoad.length >= 3,
      `${rowsOnRoad.length} row(s)`
    );
    assert(
      '…and every one of them is still trackable, because none is terminal',
      rowsOnRoad.every((r) => r.shipment_terminal === null)
    );

    // ═══ 5 · The cash ═══════════════════════════════════════════════════════
    heading('The customer hands over the cash, and the code proves it');

    const codeRow = await CashCollectionModel.findOne({ shipment_id: shipmentId }).select('+code_plain');
    const code = codeRow!.code_plain!;
    const expected = codeRow!.expected_amount;

    await cashCollectionService.collect(ID.agent.toString(), ID.agentUser.toString(), shipmentId, { code });

    shipment = await ShipmentModel.findById(shipmentId);
    assert('a valid code DELIVERS the shipment — the only API route to `delivered` for COD', shipment?.status === 'delivered');

    const settledCollection = await CashCollectionModel.findOne({ shipment_id: shipmentId });
    assert('the collection is marked collected', settledCollection?.status === 'collected');

    const agentPot = await codCashAccountService.getBalance('agent', ID.agent.toString());
    assert(`the AGENT now holds ${money(expected)} of the platform's cash`, agentPot.balance === expected, `${agentPot.balance}`);

    const agencyLiability = await codCashAccountService.getBalance('agency', ID.agency.toString());
    assert(
      'the AGENCY owes the platform the same amount — two INDEPENDENT liabilities',
      agencyLiability.balance === expected,
      `${agencyLiability.balance}`
    );

    const contractAfterCollect = await AgentAgencyContractModel.findById(contractId);
    assert(
      "…and the contract's slice records the agent's cash under THIS agency",
      contractAfterCollect?.cod?.outstanding_balance === expected,
      `${contractAfterCollect?.cod?.outstanding_balance}`
    );

    const allocations = await EarningsAllocationModel.find({
      source_type: 'cod_collection',
      source_id: settledCollection!._id,
    });
    assert('the earnings split allocated', allocations.length > 0, `${allocations.length} allocation(s)`);
    const owners = new Set(allocations.map((a) => a.beneficiary_type));
    assert(
      '…to the agent as well as the vendor and the agency — agents are paid on COD',
      owners.has('agent'),
      `owners = ${[...owners].join(', ')}`
    );

    // ═══ 6 · The hand-over ══════════════════════════════════════════════════
    heading('The agent hands the cash to the agency');

    const declared = await agentDepositService.declare({
      agentId: ID.agent.toString(),
      agencyId: ID.agency.toString(),
      amount: expected,
      recipient: 'agency',
      declaredByUserId: ID.agentUser.toString(),
    });
    assert('the agent DECLARES the hand-over', declared.status === 'declared');

    const potAfterDeclare = await codCashAccountService.getBalance('agent', ID.agent.toString());
    assert(
      '…and a declaration moves NO money — which is what stops an agent freeing their own headroom by lying',
      potAfterDeclare.balance === expected,
      `${potAfterDeclare.balance}`
    );

    await agentDepositService.confirm({
      depositId: declared._id.toString(),
      by: 'agency',
      agencyId: ID.agency.toString(),
      confirmedByUserId: ID.agencyUser.toString(),
    });

    const potAfterConfirm = await codCashAccountService.getBalance('agent', ID.agent.toString());
    assert('the agency CONFIRMING is what moves it — the pot is back to zero', potAfterConfirm.balance === 0, `${potAfterConfirm.balance}`);

    const contractAfterDeposit = await AgentAgencyContractModel.findById(contractId);
    assert("…the contract's slice is drawn down", contractAfterDeposit?.cod?.outstanding_balance === 0);
    assert('…and lifetime_settled remembers it', contractAfterDeposit?.cod?.lifetime_settled === expected);

    const agencyStillOwes = await codCashAccountService.getBalance('agency', ID.agency.toString());
    assert(
      'the AGENCY still owes the platform — the two legs are discharged separately, and this is what caps exposure',
      agencyStillOwes.balance === expected,
      `${agencyStillOwes.balance}`
    );

    const ledger = await CodCashLedgerModel.find({ owner_type: 'agent', owner_id: ID.agent.toString() });
    assert(
      'INVARIANT · the agent account balance == Σ its ledger rows',
      ledger.reduce((sum, r) => sum + r.amount, 0) === potAfterConfirm.balance
    );

    // ═══ 7 · What delivery released ═════════════════════════════════════════
    heading('Capacity returns, and the tracking session closes terminal');

    const agentAfterDelivery = await DeliveryAgentModel.findById(ID.agent);
    assert(
      'delivering gave the capacity slot back',
      agentAfterDelivery?.capacity?.active_shipment_count === 0,
      `count = ${agentAfterDelivery?.capacity?.active_shipment_count}`
    );

    const allRows = await TrackingOutboxModel.find({ agent_id: ID.agent.toString() }).sort({ createdAt: 1 });
    const rowSummary = allRows
      .map((r) => `${r.type} trackable=${r.shipment_trackable} terminal=${r.shipment_terminal} agentActive=${r.agent_has_active_shipment}`)
      .join('\n       ');

    // ⚠ THE FINDING THIS STEP EXISTS FOR, and it is not the row you would guess.
    //
    // For a COD delivery the terminal verdict rides **`cod.collection.recorded`**,
    // NOT `shipment.status_changed`. The collect IS the delivery here — it is the
    // only API route to `delivered` for COD — so `CashCollectionService.collect`
    // emits its own event inside the same transaction and carries the verdicts on
    // it. The last `shipment.status_changed` row on this shipment is `in_transit`,
    // and it is still trackable, correctly.
    //
    // A geo-tracker author who closed sessions only on `shipment.status_changed`
    // would therefore leave every COD session open forever, while every prepaid
    // one closed — a bug with no symptom on the jovi-mall side at all. That is
    // exactly the class of defect an E2E exists to catch and an isolated unit
    // test cannot, so it is asserted here rather than merely commented.
    const lastStatusRow = [...allRows].reverse().find((r) => r.type === 'shipment.status_changed');
    assert(
      'the last shipment.status_changed row is `in_transit`, and is STILL trackable',
      lastStatusRow?.shipment_trackable === true && lastStatusRow?.shipment_terminal === null,
      rowSummary
    );

    const terminalRow = allRows.find((r) => r.shipment_terminal !== null);
    assert('exactly one row carries a terminal verdict', allRows.filter((r) => r.shipment_terminal !== null).length === 1, rowSummary);
    assert(
      '…and for COD it is `cod.collection.recorded`, because the collect IS the delivery',
      terminalRow?.type === 'cod.collection.recorded',
      rowSummary
    );
    assert('…stamped `delivered`, which is what closes the session', terminalRow?.shipment_terminal === 'delivered', rowSummary);
    assert('…and no longer trackable', terminalRow?.shipment_trackable === false, rowSummary);
    assert(
      '…and reports the agent has no active shipment left — the aggregate backstop',
      terminalRow?.agent_has_active_shipment === false,
      rowSummary
    );

    // The audit row is a different subject and carries no shipment verdict at all
    // — jovi-mall keeps the business event, geo-tracker keeps the spatial audit.
    const auditRow = allRows.find((r) => r.type === 'agent.action');
    assert('the agent-action audit row carries NO shipment verdict', auditRow?.shipment_trackable === null, rowSummary);

    const pending = await TrackingOutboxModel.countDocuments({ agent_id: ID.agent.toString(), status: 'pending' });
    assert(
      'every row is still PENDING — the integration is inert without GEO_TRACKER_BASE_URL, by design',
      pending > 0,
      `${pending} pending`
    );

    // ═══ 8 · Termination ════════════════════════════════════════════════════
    heading('The contract terminates cleanly');

    const blockers = await agentContractService.evaluateDeactivationBlockers(contractAfterDeposit!);
    assert('with the cash settled there is nothing blocking termination', blockers.clear === true);

    const { request: endRequest } = await agentContractService.requestTransition(
      contractId,
      'deactivate',
      'agency',
      { userId: ID.agencyUser.toString(), role: 'agency' }
    );
    const { contract: ended } = await agentContractService.resolveRequest(
      endRequest._id.toString(),
      'approve',
      { userId: ID.agentUser.toString(), role: 'agent' }
    );
    assert('the counterparty approving ends it', ended?.status === 'deactivated');

    const finalAllocation = await agentCodThresholdService.getAllocation(ID.agent.toString());
    assert(
      'the slice leaves the pool — which is only safe because termination required zero',
      finalAllocation.allocated === 0,
      `allocated ${finalAllocation.allocated}`
    );
    assert(`…returning the whole ${money(AGENT_POOL)} pool`, finalAllocation.headroom === AGENT_POOL);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
