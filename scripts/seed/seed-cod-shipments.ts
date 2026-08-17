/**
 * Seed: COD shipments for agency b00000000000000000000005 / agent b00000000000000000000006
 *
 * Builds seven cash-on-delivery shipments — every one owned by the EXISTING
 * agency `b00000000000000000000005` ("Express Delivery Cameroon" / Magazin
 * "Express Mall") and run by the EXISTING agent `b00000000000000000000006`
 * ("Pierre Ekang") — spread across the COD lifecycle so each stage of the
 * agency dashboard and the agent app has something real to render:
 *
 *   #1  assigned   · offer PENDING          — the agent's inbox: accept or reject
 *   #2  assigned   · offer ACCEPTED         — bound to the agent, delivery code issued
 *   #3  picked_up                           — parcel collected from the vendor
 *   #4  in_transit                          — en route, code collectable
 *   #5  agent_delivered                     — at the door, awaiting the customer's code
 *   #6  delivered  · cash COLLECTED         — real code submission, earnings split
 *   #7  failed     · customer absent        — non-terminal, retryable
 *
 * Every shipment carries a REAL pickup and a REAL drop-off: the pickup is a
 * geocoded vendor business address snapshotted onto the order item at checkout
 * (`pickup_location.source: 'vendor_address'`), the drop-off is a geocoded
 * `GeoAddress` passed inline at checkout and snapshotted onto
 * `order.delivery_address`. All are real Douala places with real coordinates,
 * inside the agent's 25 km home-base radius (Douala — Akwa), so routing and
 * proximity queries behave sensibly.
 *
 * Like `seed-cod.ts` and `seed-agent-app.ts` — and unlike the raw-insert
 * `seed-orders.js` — this drives the REAL services (OrderService,
 * ShipmentAssignmentService, ShipmentService, CashCollectionService), so every
 * row is what the running API would have produced: real generated tracking
 * numbers, real hashed + plaintext delivery codes, real capacity reservations,
 * real cash ledgers and earnings splits.
 *
 * ── What it creates vs. what it reuses ──────────────────────────────────────
 * CREATES, all under fixed `c0d5…` ids and `codship-` tagged emails/slugs: one
 * vendor (+ store, settings, two geocoded pickup addresses), six products, four
 * customers, and the seven orders/shipments above. Cleanup runs first and only
 * removes documents reachable from those ids, so the pre-existing shipments on
 * this agency (from `seed-orders.js`) are left untouched.
 *
 * REUSES, never re-keyed: the agency, its user, the agent and their user.
 *
 * ── The one pre-existing document it MODIFIES ───────────────────────────────
 * The agent↔agency contract's `cod.threshold` is raised from 0 to 200,000 XAF.
 * Without it every COD assignment fails `COD_AGENT_EXPOSURE_EXCEEDED`: the
 * threshold IS the exposure limit (`ShipmentAssignmentService.assertContractPolicy`
 * → `CodExposureService.assertCanTakeCodShipment`), and 0 means "this agent may
 * carry no cash for us". 200,000 is exactly the agent's remaining headroom —
 * their global pool is 500,000 and their other active contract already
 * allocates 300,000, so the sub-allocation invariant still holds. `--clean`
 * does NOT put it back to 0.
 *
 * ── Side effects are real, because the code paths are ───────────────────────
 * Issuing a COD delivery code notifies the customer over WhatsApp exactly as
 * the live app does, and every agent notification fires a real FCM push, so
 * with `WHATSAPP_ACCESS_TOKEN` / `FCM_ENABLED` set in `.env` those requests
 * really do go to Meta and Firebase and fail against these (fake) numbers and
 * absent devices. Harmless and best-effort — every code is printed in the
 * summary regardless — but it IS what makes the script slow: expect a couple of
 * minutes with both configured against a few seconds without.
 *
 * PREREQUISITES
 *   • MongoDB running as a replica set (the app's transactions require it)
 *   • `npm run seed:plans` (the agent free plan drives capacity)
 *
 * Run:
 *   npx ts-node scripts/seed/seed-cod-shipments.ts          # wipe + reseed
 *   npx ts-node scripts/seed/seed-cod-shipments.ts --clean  # wipe only
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { VendorSettingsModel } from '../../src/modules/vendors/models/vendor-settings.model';
import { VendorSettingsRepository } from '../../src/modules/vendors/repositories/vendor-settings.repository';
import { StoreModel } from '../../src/modules/store/models/store.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import {
  DeliveryAgentModel,
  AgentAgencyContractModel,
  LIVE_MEMBERSHIP_STATUSES,
  agentCapacityService,
} from '../../src/modules/agents';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { CartModel } from '../../src/modules/cart/models/cart.model';
import { OrderModel, IOrder } from '../../src/modules/orders/order.model';
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
import { cashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { codCashAccountService } from '../../src/modules/cod/services/cod-cash-account.service';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { TrackingOutboxModel } from '../../src/modules/tracking-integration/models/tracking-outbox.model';
import { initializeAgentNotificationEventConsumers } from '../../src/modules/notifications/agent-notification-event-consumer';
import { IGeoAddress, GeoAddressInput } from '../../src/core/types/geo-address.types';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
const CURRENCY = 'XAF';

/** The password every account this script creates logs in with. */
const SEED_PASSWORD = 'CodShip123!';
/** Email/slug tag on everything created here — the cleanup handle. */
const TAG = 'codship-';

/**
 * The agent's slice of their own COD pool for THIS agency. Their global
 * `cod.max_threshold` is 500,000 and their other active contract allocates
 * 300,000, so 200,000 is the whole of the remaining headroom.
 */
const CONTRACT_COD_THRESHOLD = 200_000;

const log = (msg = '') => console.log(msg);
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 72 - title.length))}`);
const money = (n: number) => `${n.toLocaleString('en-US')} ${CURRENCY}`;

// ─────────────────────────────────────────────────────────────────────────────
// ID registry. `c0d5…` = "COD shipments"; the four exceptions are the agency
// and agent (and their users), which already exist and are reused as-is.
// ─────────────────────────────────────────────────────────────────────────────
const sid = (suffix: string) => new Types.ObjectId(`c0d5${'0'.repeat(20 - suffix.length)}${suffix}`);

const ID = {
  // ── Reused, never re-keyed ────────────────────────────────────────────────
  agency: new Types.ObjectId('b00000000000000000000005'),
  agencyUser: new Types.ObjectId('a00000000000000000000005'),
  agent: new Types.ObjectId('b00000000000000000000006'),
  agentUser: new Types.ObjectId('a00000000000000000000006'),

  // ── Created here ──────────────────────────────────────────────────────────
  vendorUser: sid('a1'),
  vendor: sid('b1'),
  store: sid('c1'),

  customer1User: sid('a2'),
  customer1: sid('b2'),
  customer2User: sid('a3'),
  customer2: sid('b3'),
  customer3User: sid('a4'),
  customer3: sid('b4'),
  customer4User: sid('a5'),
  customer4: sid('b5'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Addresses — real Douala places, real coordinates. GeoJSON order is [lng, lat].
// Everything sits inside the agent's home base (Douala — Akwa, 25 km radius).
// ─────────────────────────────────────────────────────────────────────────────
const geoAddress = (opts: {
  formatted: string;
  lng: number;
  lat: number;
  city: string;
  region: string;
  street?: string;
  neighbourhood?: string;
}): IGeoAddress =>
  ({
    formatted_address: opts.formatted,
    coordinates: { type: 'Point', coordinates: [opts.lng, opts.lat] },
    provider: 'nominatim',
    provider_place_id: null,
    components: {
      street: opts.street ?? null,
      neighbourhood: opts.neighbourhood ?? null,
      city: opts.city,
      region: opts.region,
      postal_code: null,
      country: 'Cameroun',
      country_code: 'CM',
    },
    raw_input: opts.formatted,
    resolved_at: new Date(),
  }) as unknown as IGeoAddress;

/** The same value object in the shape a checkout accepts (no `resolved_at`). */
const asInput = (geo: IGeoAddress): GeoAddressInput => {
  const { resolved_at: _resolvedAt, ...rest } = geo as IGeoAddress & { resolved_at: Date };
  return rest as unknown as GeoAddressInput;
};

// ── Pickup points: the vendor's two geocoded business addresses ──────────────
const PICKUP_AKWA = geoAddress({
  formatted: 'Boulevard de la Liberté, Akwa, Douala, Littoral, Cameroun',
  lng: 9.7085,
  lat: 4.0511,
  city: 'Douala',
  region: 'Littoral',
  street: 'Boulevard de la Liberté',
  neighbourhood: 'Akwa',
});
const PICKUP_BONABERI = geoAddress({
  formatted: 'Rue Bonassama, Bonabéri, Douala, Littoral, Cameroun',
  lng: 9.6738,
  lat: 4.0742,
  city: 'Douala',
  region: 'Littoral',
  street: 'Rue Bonassama',
  neighbourhood: 'Bonabéri',
});

// ── Drop-off points: one per shipment, passed inline at checkout ─────────────
const DROP_NDOKOTTI = geoAddress({
  formatted: 'Carrefour Ndokotti, Douala, Littoral, Cameroun',
  lng: 9.7368,
  lat: 4.0611,
  city: 'Douala',
  region: 'Littoral',
  neighbourhood: 'Ndokotti',
});
const DROP_BONAMOUSSADI = geoAddress({
  formatted: 'Rue des Écoles, Bonamoussadi, Douala, Littoral, Cameroun',
  lng: 9.742,
  lat: 4.0919,
  city: 'Douala',
  region: 'Littoral',
  street: 'Rue des Écoles',
  neighbourhood: 'Bonamoussadi',
});
const DROP_MAKEPE = geoAddress({
  formatted: 'Makepe Missoké, Douala, Littoral, Cameroun',
  lng: 9.7539,
  lat: 4.0813,
  city: 'Douala',
  region: 'Littoral',
  neighbourhood: 'Makepe',
});
const DROP_BONAPRISO = geoAddress({
  formatted: 'Rue Gallieni, Bonapriso, Douala, Littoral, Cameroun',
  lng: 9.6981,
  lat: 4.0355,
  city: 'Douala',
  region: 'Littoral',
  street: 'Rue Gallieni',
  neighbourhood: 'Bonapriso',
});
const DROP_DEIDO = geoAddress({
  formatted: 'Carrefour Trois Morts, Deido, Douala, Littoral, Cameroun',
  lng: 9.7089,
  lat: 4.0669,
  city: 'Douala',
  region: 'Littoral',
  neighbourhood: 'Deido',
});
const DROP_LOGBESSOU = geoAddress({
  formatted: 'Logbessou Plateau, Douala, Littoral, Cameroun',
  lng: 9.783,
  lat: 4.0975,
  city: 'Douala',
  region: 'Littoral',
  neighbourhood: 'Logbessou',
});
const DROP_PK14 = geoAddress({
  formatted: 'PK14, Route de Yaoundé, Douala, Littoral, Cameroun',
  lng: 9.81,
  lat: 4.12,
  city: 'Douala',
  region: 'Littoral',
  street: 'Route de Yaoundé',
  neighbourhood: 'PK14',
});

// ─────────────────────────────────────────────────────────────────────────────
// Services
// ─────────────────────────────────────────────────────────────────────────────
const orderService = new OrderService();
const shipmentService = new ShipmentService();
const vendorSettingsRepo = new VendorSettingsRepository();

/**
 * Undo the money a previous run's COD collection MOVED, before the rows that
 * record it are deleted.
 *
 * Deleting a CashCollection does not un-credit the cash it booked: `collect()`
 * raises the agent's CodCashAccount, the agency's, and the contract's
 * `cod.outstanding_balance`, and the earnings split parks four allocations in
 * the beneficiaries' `pending_balance`. Skip this and every re-run of the seed
 * permanently inflates the agent's held cash — which is not just untidy, it
 * eats their COD exposure headroom until the seed can no longer assign anything.
 *
 * Both ledgers are the source of truth for the reversal: each row names the
 * account it moved and by how much, so the undo is exact rather than inferred.
 */
async function reverseSeededMoney(
  orderIds: Types.ObjectId[],
  shipmentIds: Types.ObjectId[]
): Promise<void> {
  if (orderIds.length === 0) return;

  // ── COD cash liabilities (agent + agency accounts, and the contract) ──────
  const collections = await CashCollectionModel.find({ order_id: { $in: orderIds } })
    .select('_id agent_id agency_id expected_amount status')
    .lean();
  const collectionIds = collections.map((c) => c._id);

  const cashEntries = await CodCashLedgerModel.find({
    ref_type: 'cash_collection',
    ref_id: { $in: collectionIds },
  })
    .select('_id account_id amount')
    .lean();

  for (const entry of cashEntries) {
    await CodCashAccountModel.updateOne({ _id: entry.account_id }, { $inc: { balance: -entry.amount } });
  }
  await CodCashLedgerModel.deleteMany({ _id: { $in: cashEntries.map((e) => e._id) } });

  for (const col of collections.filter((c) => c.status === 'collected')) {
    await AgentAgencyContractModel.updateOne(
      { agent_id: col.agent_id, agency_id: col.agency_id, status: { $in: LIVE_MEMBERSHIP_STATUSES } },
      { $inc: { 'cod.outstanding_balance': -col.expected_amount } }
    );
  }

  // ── Earnings allocations (held in each beneficiary's pending_balance) ─────
  // Keyed on source_type/source_id — an allocation carries NO order_id, so a
  // delete filtered on one silently matches nothing.
  const allocations = await EarningsAllocationModel.find({
    source_id: { $in: [...orderIds, ...shipmentIds, ...collectionIds] },
  })
    .select('_id beneficiary_type beneficiary_id amount status')
    .lean();

  for (const alloc of allocations) {
    const field = alloc.status === 'released' ? 'available_balance' : 'pending_balance';
    await EarningsAccountModel.updateOne(
      { owner_type: alloc.beneficiary_type, owner_id: alloc.beneficiary_id ?? null },
      { $inc: { [field]: -alloc.amount } }
    );
  }
  const allocationIds = allocations.map((a) => a._id);
  await EarningsLedgerModel.deleteMany({ allocation_id: { $in: allocationIds } });
  await EarningsAllocationModel.deleteMany({ _id: { $in: allocationIds } });

  if (cashEntries.length || allocations.length) {
    log(`   💸 reversed ${cashEntries.length} cash movement(s) and ${allocations.length} earnings allocation(s)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — always first. Scoped to this script's own fixed ids and everything
// reachable from them, so a re-run never duplicates and never eats other data.
// The agency's pre-existing shipments (seed-orders.js) are NOT reachable from
// our vendor, so they survive untouched.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  section('Cleanup');

  const customerIds = [ID.customer1, ID.customer2, ID.customer3, ID.customer4];
  const userIds = [ID.vendorUser, ID.customer1User, ID.customer2User, ID.customer3User, ID.customer4User];

  const orders = await OrderModel.find({ vendor_id: ID.vendor }).select('_id').lean();
  const orderIds = orders.map((o) => o._id);
  const shipments = await ShipmentModel.find({ order_id: { $in: orderIds } }).select('_id').lean();
  const shipmentIds = shipments.map((s) => s._id);
  const products = await ProductModel.find({ vendorId: ID.vendor }).select('_id').lean();
  const productIds = products.map((p) => p._id);

  // Money first, while the rows that explain it still exist (see below).
  await reverseSeededMoney(orderIds, shipmentIds);

  await Promise.all([
    ShipmentAssignmentOfferModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    ShipmentAssignmentSessionModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    CashCollectionModel.deleteMany({ order_id: { $in: orderIds } }),
    // The timeline model is append-only by design (a pre-hook rejects deletes),
    // so a seed teardown has to go under it via the raw collection.
    OrderTimelineModel.collection.deleteMany({ order_id: { $in: orderIds } }),
    TrackingOutboxModel.deleteMany({ 'payload.shipmentId': { $in: shipmentIds.map(String) } }),
    ShipmentModel.deleteMany({ _id: { $in: shipmentIds } }),
    ProductVariantModel.deleteMany({ productId: { $in: productIds } }),
    CartModel.deleteMany({ userId: { $in: customerIds.map(String) } }),
  ]);

  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: orderIds } }),
    ProductModel.deleteMany({ _id: { $in: productIds } }),
    CustomerModel.deleteMany({ _id: { $in: customerIds } }),
    StoreModel.deleteMany({ vendor_id: ID.vendor }),
    VendorSettingsModel.deleteMany({ vendor_id: ID.vendor }),
    VendorModel.deleteMany({ _id: ID.vendor }),
    UserModel.deleteMany({ _id: { $in: userIds } }),
  ]);

  log(`   🧹 removed ${orderIds.length} order(s), ${shipmentIds.length} shipment(s), ${productIds.length} product(s) and their supporting cast`);

  // Deleting active shipments out from under the counter leaves the agent's
  // capacity reserved for work that no longer exists. Reconcile from the
  // shipments themselves — the same backstop the nightly sweep uses.
  const { before, after, drifted } = await agentCapacityService.reconcile(ID.agent.toString());
  if (drifted) log(`   🔄 agent capacity counter corrected ${before} → ${after}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Preconditions — the agency, the agent and their contract must already exist.
// This script deliberately does not create them: they are the fixture the
// caller asked for, and re-keying them would break everything pointing at them.
// ─────────────────────────────────────────────────────────────────────────────
async function assertWorldExists(): Promise<void> {
  section('Preconditions');

  const agency = await DeliveryAgencyModel.findById(ID.agency).lean();
  if (!agency) {
    throw new Error(`Agency ${ID.agency} not found — seed the base fixture first (mongosh … seed-orders.js).`);
  }
  if (agency.status !== 'active') throw new Error(`Agency ${ID.agency} is '${agency.status}', not 'active'.`);
  if (!agency.policies?.cod?.enabled) {
    throw new Error(`Agency ${ID.agency} has COD disabled (policies.cod.enabled) — it cannot carry a COD order.`);
  }
  log(`   ✅ agency  ${ID.agency}  COD enabled, cap ${money(agency.policies.cod.max_order_amount ?? 0)}`);

  const agent = await DeliveryAgentModel.findById(ID.agent).lean();
  if (!agent) throw new Error(`Agent ${ID.agent} not found — seed the base fixture first.`);
  if (agent.status !== 'active') throw new Error(`Agent ${ID.agent} is '${agent.status}', not 'active'.`);
  if (agent.kyc?.status !== 'verified') {
    throw new Error(`Agent ${ID.agent} KYC is '${agent.kyc?.status}' — eligibility passes only on 'verified'.`);
  }
  log(`   ✅ agent   ${ID.agent}  ${agent.name} · ${agent.availability?.state} · tracking ${agent.tracking?.allowed ? 'allowed' : 'BLOCKED'}`);

  // The exposure limit for a COD assignment IS this number. At 0 every accept
  // throws COD_AGENT_EXPOSURE_EXCEEDED, so the seed cannot proceed without it.
  const contract = await AgentAgencyContractModel.findOne({
    agent_id: ID.agent,
    agency_id: ID.agency,
    status: 'active',
  });
  if (!contract) {
    throw new Error(`No ACTIVE contract between agent ${ID.agent} and agency ${ID.agency} — approve one first.`);
  }

  const previous = contract.cod?.threshold ?? 0;
  if (previous < CONTRACT_COD_THRESHOLD) {
    await AgentAgencyContractModel.updateOne(
      { _id: contract._id },
      { $set: { 'cod.threshold': CONTRACT_COD_THRESHOLD } }
    );
    log(`   🔧 contract ${contract._id} — cod.threshold ${money(previous)} → ${money(CONTRACT_COD_THRESHOLD)}`);
    log('      (the COD exposure limit; 0 blocks every COD assignment)');
  } else {
    log(`   ✅ contract ${contract._id} — cod.threshold already ${money(previous)}`);
  }

  const exposure = await codCashAccountService.getBalance('agent', ID.agent.toString());
  log(`   ℹ️  agent cash currently held: ${money(exposure.balance)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor, store, catalog, customers
// ─────────────────────────────────────────────────────────────────────────────
async function seedVendor(passwordHash: string) {
  section('Vendor, store & catalog');

  await UserModel.create({
    _id: ID.vendorUser,
    login_email: `${TAG}vendor@jovitest.cm`,
    password_hash: passwordHash,
    roles: ['vendor'],
    status: 'active',
  });

  const vendor = await VendorModel.create({
    _id: ID.vendor,
    user_id: ID.vendorUser,
    business_name: 'Sawa Home & Electronics',
    display_name: 'Sawa Home',
    business_description: 'COD shipment seed vendor — Douala.',
    country: 'CM',
    email: `${TAG}vendor@jovitest.cm`,
    phone: '+237699000501',
    email_verified: true,
    phone_verified: true,
    business_addresses: [
      {
        label: 'Boutique Akwa',
        address_line1: 'Boulevard de la Liberté, face pharmacie Akwa',
        address_line2: null,
        city: 'Douala',
        state: 'Littoral',
        location: PICKUP_AKWA.coordinates,
        geo: PICKUP_AKWA,
      },
      {
        label: 'Entrepôt Bonabéri',
        address_line1: 'Rue Bonassama, zone industrielle',
        address_line2: null,
        city: 'Douala',
        state: 'Littoral',
        location: PICKUP_BONABERI.coordinates,
        geo: PICKUP_BONABERI,
      },
    ],
    kyc_details: { national_id_number: 'CNI-CODSHIP-01', legit_verified: true },
    // Every product below also pins the agency explicitly; this is the fallback.
    default_delivery_agency_id: ID.agency,
    status: 'active',
    onboarding_step: 0,
  });

  await StoreModel.create({
    _id: ID.store,
    vendor_id: ID.vendor,
    name: 'Sawa Home & Electronics',
    slug: `${TAG}sawa-home`,
    description: 'COD shipment seed store.',
  });

  // Auto-redirect ON: a COD order's shipments land on the agency as `assigned`
  // at checkout, which is the state an offer can be placed from.
  await vendorSettingsRepo.setAutoRedirectOrdersToAgency(ID.vendor.toString(), true);

  const addresses = vendor.business_addresses as unknown as Array<{ _id: Types.ObjectId; label: string }>;
  const pickupAkwaId = addresses[0]._id;
  const pickupBonaberiId = addresses[1]._id;

  log(`   ✅ Sawa Home & Electronics  vendorId=${ID.vendor}  login=${TAG}vendor@jovitest.cm`);
  log(`      pickup A: ${PICKUP_AKWA.formatted_address}`);
  log(`      pickup B: ${PICKUP_BONABERI.formatted_address}`);
  return { pickupAkwaId, pickupBonaberiId };
}

interface ProductFixture {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  sku: string;
  title: string;
  price: number;
  vendorId: Types.ObjectId;
  productType: 'physical';
  pickupLabel: string;
}

async function createProduct(opts: {
  title: string;
  slug: string;
  price: number;
  pickupAddressId: Types.ObjectId;
  pickupLabel: string;
}): Promise<ProductFixture> {
  const product = await ProductModel.create({
    vendorId: ID.vendor,
    type: 'physical',
    status: 'active',
    title: opts.title,
    description: `${opts.title} — COD shipment seed product.`,
    slug: `${TAG}${opts.slug}`,
    category: 'Maison & Électronique',
    tags: ['cod-shipment-seed'],
    seo: { title: opts.title, description: opts.title },
    hasVariants: false,
    delivery: {
      agency_id: ID.agency,
      free_delivery: false,
      // A real, geocoded vendor address — this is what gets snapshotted onto
      // the order item and becomes the agent's pickup leg.
      pickup_location: { source: 'vendor_address', vendor_address_id: opts.pickupAddressId },
    },
  });

  // `sku` carries a UNIQUE index across the whole collection, so it needs the
  // seed tag as much as the slug does — `LAMPE-SOLAIRE-001` alone collides with
  // the identically-named product in seed-agent-app.ts.
  const sku = `${TAG}${opts.slug}-001`.toUpperCase();
  const variant = await ProductVariantModel.create({
    productId: product._id,
    sku,
    name: 'Default',
    status: 'active',
    optionSignature: 'default',
    price: opts.price,
    stock: 500,
  });

  product.defaultVariantId = variant._id;
  await product.save();

  log(`   ✅ ${opts.title.padEnd(28)} ${money(opts.price).padStart(14)}   pickup: ${opts.pickupLabel}`);
  return {
    productId: product._id,
    variantId: variant._id,
    sku,
    title: opts.title,
    price: opts.price,
    vendorId: ID.vendor,
    productType: 'physical',
    pickupLabel: opts.pickupLabel,
  };
}

async function seedCustomers(passwordHash: string) {
  section('Customers');

  const specs = [
    { userId: ID.customer1User, customerId: ID.customer1, phone: '+237655000501', name: 'Amina Njoya', geo: DROP_NDOKOTTI, line1: 'Carrefour Ndokotti, immeuble Sokoa' },
    { userId: ID.customer2User, customerId: ID.customer2, phone: '+237655000502', name: 'Jean Talla', geo: DROP_BONAMOUSSADI, line1: 'Rue des Écoles, Bonamoussadi' },
    { userId: ID.customer3User, customerId: ID.customer3, phone: '+237655000503', name: 'Solange Eyenga', geo: DROP_MAKEPE, line1: 'Makepe Missoké, derrière le marché' },
    { userId: ID.customer4User, customerId: ID.customer4, phone: '+237655000504', name: 'Éric Mbappé', geo: DROP_BONAPRISO, line1: 'Rue Gallieni, Bonapriso' },
  ];

  for (const s of specs) {
    const email = `${TAG}${s.name.split(' ')[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}@jovitest.cm`;
    await UserModel.create({
      _id: s.userId,
      login_email: email,
      password_hash: passwordHash,
      roles: ['customer'],
      status: 'active',
    });
    await CustomerModel.create({
      _id: s.customerId,
      user_id: s.userId,
      email,
      email_verified: true,
      phone: s.phone,
      phone_verified: true,
      name: s.name,
      saved_addresses: [
        {
          label: 'Domicile',
          address_line1: s.line1,
          city: 'Douala',
          state: 'Littoral',
          country: 'CM',
          is_default: true,
          location: s.geo.coordinates,
          geo: s.geo,
        },
      ],
      status: 'active',
    });
    log(`   ✅ ${s.name.padEnd(18)} ${s.phone}  → ${s.geo.formatted_address}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario helpers — every one drives the real API path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Place a COD order for one customer and return its (single) shipment.
 *
 * `dropOff` is passed inline rather than read off the customer's saved address,
 * so each shipment gets its own real destination without four customers needing
 * seven address books.
 */
async function checkout(
  customerId: Types.ObjectId,
  product: ProductFixture,
  qty: number,
  dropOff: IGeoAddress
): Promise<{ order: IOrder; shipment: IShipment }> {
  await CartModel.findOneAndReplace(
    { userId: customerId.toString() },
    {
      userId: customerId.toString(),
      productType: 'physical',
      items: [
        {
          variantId: product.variantId,
          sku: product.sku,
          variantTitle: 'Default',
          optionsSnapshot: 'default',
          productId: product.productId,
          title: product.title,
          vendorId: product.vendorId,
          productType: product.productType,
          quantity: qty,
          price: product.price,
          currency: CURRENCY,
        },
      ],
    },
    { upsert: true, new: true }
  );

  const { orders } = await orderService.createOrdersFromCart(
    customerId.toString(),
    'cash_on_delivery',
    { address: asInput(dropOff) }
  );
  const order = orders[0];

  // Auto-redirect normally dispatches at checkout; fall back to an explicit
  // dispatch so the shipment is `assigned` (offerable) whatever the settings did.
  let shipment = await ShipmentModel.findOne({ order_id: order._id });
  if (shipment && shipment.status === 'pending') {
    await orderService.dispatchToAgency((order._id as Types.ObjectId).toString(), {
      type: 'vendor',
      id: ID.vendorUser.toString(),
    });
    shipment = await ShipmentModel.findOne({ order_id: order._id });
  }

  const fresh = await OrderModel.findById(order._id);
  return { order: fresh!, shipment: shipment! };
}

/** Offer a shipment to the agent, as the agency. */
async function offer(shipment: IShipment) {
  return shipmentAssignmentService.offerToAgent(
    ID.agency.toString(),
    (shipment._id as Types.ObjectId).toString(),
    ID.agent.toString(),
    { role: 'agency', userId: ID.agencyUser.toString() }
  );
}

/** Push a pending offer's deadline out so it survives until you test it. */
async function keepAlive(offerId: string, days = 7) {
  await ShipmentAssignmentOfferModel.updateOne(
    { _id: offerId },
    { $set: { expires_at: new Date(Date.now() + days * 86_400_000) } }
  );
}

/** Offer + accept in one step — the agent is bound and the COD code issues. */
async function offerAndAccept(shipment: IShipment): Promise<IShipment> {
  const result = await offer(shipment);
  await shipmentAssignmentService.accept(ID.agent.toString(), result.offer.id);
  return (await ShipmentModel.findById(shipment._id))!;
}

/** Agency-driven status transition. */
async function advance(
  shipment: IShipment,
  status: 'picked_up' | 'in_transit' | 'agent_delivered' | 'failed' | 'returned'
): Promise<IShipment> {
  await shipmentService.updateStatus(
    ID.agency.toString(),
    (shipment._id as Types.ObjectId).toString(),
    status,
    ID.agencyUser.toString()
  );
  return (await ShipmentModel.findById(shipment._id))!;
}

/** The plaintext delivery code the customer holds (never exposed by the API). */
async function deliveryCode(shipment: IShipment): Promise<{ code: string; amount: number } | null> {
  const collection = await CashCollectionModel.findOne({ shipment_id: shipment._id }).select('+code_plain');
  if (!collection?.code_plain) return null;
  return { code: collection.code_plain, amount: collection.expected_amount };
}

interface Row {
  n: number;
  label: string;
  shipment: IShipment;
  order: IOrder;
  pickup: string;
  dropOff: string;
  code: string | null;
  amount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const cleanOnly = process.argv.includes('--clean');

  await mongoose.connect(MONGO_URI);
  log(`✅ Connected to MongoDB (${MONGO_URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);

  // server.ts registers these at boot; without them the flows below would emit
  // offer/COD events nobody listens to and the agent's notification list would
  // come out empty.
  initializeAgentNotificationEventConsumers();

  await cleanup();
  if (cleanOnly) {
    log('\n✨ Clean complete (--clean). Nothing seeded.');
    await mongoose.disconnect();
    process.exit(0); // see the note at the end of main()
  }

  await assertWorldExists();

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const { pickupAkwaId, pickupBonaberiId } = await seedVendor(passwordHash);

  const P = {
    blender: await createProduct({ title: 'Blender Moulinex 1.5L', slug: 'blender-moulinex', price: 9_500, pickupAddressId: pickupAkwaId, pickupLabel: 'Akwa' }),
    fer: await createProduct({ title: 'Fer à repasser vapeur', slug: 'fer-vapeur', price: 14_000, pickupAddressId: pickupAkwaId, pickupLabel: 'Akwa' }),
    ventilateur: await createProduct({ title: 'Ventilateur sur pied', slug: 'ventilateur-pied', price: 22_500, pickupAddressId: pickupBonaberiId, pickupLabel: 'Bonabéri' }),
    microondes: await createProduct({ title: 'Four micro-ondes 20L', slug: 'micro-ondes-20l', price: 18_000, pickupAddressId: pickupAkwaId, pickupLabel: 'Akwa' }),
    bouilloire: await createProduct({ title: 'Bouilloire électrique', slug: 'bouilloire-elec', price: 12_000, pickupAddressId: pickupBonaberiId, pickupLabel: 'Bonabéri' }),
    lampe: await createProduct({ title: 'Lampe solaire rechargeable', slug: 'lampe-solaire', price: 7_500, pickupAddressId: pickupAkwaId, pickupLabel: 'Akwa' }),
    tv: await createProduct({ title: 'Téléviseur LED 32"', slug: 'tv-led-32', price: 26_000, pickupAddressId: pickupBonaberiId, pickupLabel: 'Bonabéri' }),
  };

  await seedCustomers(passwordHash);

  const rows: Row[] = [];
  const notes: string[] = [];

  // ── #1 — a pending offer sitting in the agent's inbox ─────────────────────
  section(`#1 — ASSIGNED · offer PENDING (${money(P.blender.price)})`);
  const s1 = await checkout(ID.customer1, P.blender, 1, DROP_NDOKOTTI);
  const o1 = await offer(s1.shipment);
  await keepAlive(o1.offer.id);
  log(`   📨 offer ${o1.offer.id} → pending for 7 days (not the usual 120s)`);
  log('      no agent bound yet, so no delivery code has been issued');
  notes.push(`Accept or reject the pending offer:  POST /api/agent/offers/${o1.offer.id}/{accept,reject}`);
  rows.push({ n: 1, label: 'offer pending', shipment: (await ShipmentModel.findById(s1.shipment._id))!, order: s1.order, pickup: P.blender.pickupLabel, dropOff: DROP_NDOKOTTI.formatted_address, code: null, amount: P.blender.price });

  // ── #2 — accepted, waiting to be picked up ────────────────────────────────
  section(`#2 — ASSIGNED · accepted, awaiting pickup (${money(P.fer.price)})`);
  const s2 = await checkout(ID.customer2, P.fer, 1, DROP_BONAMOUSSADI);
  const s2ship = await offerAndAccept(s2.shipment);
  const c2 = await deliveryCode(s2ship);
  log('   ✅ accepted — agent bound, capacity reserved, delivery code issued to the customer');
  rows.push({ n: 2, label: 'assigned (accepted)', shipment: s2ship, order: s2.order, pickup: P.fer.pickupLabel, dropOff: DROP_BONAMOUSSADI.formatted_address, code: c2?.code ?? null, amount: c2?.amount ?? P.fer.price });

  // ── #3 — collected from the vendor ────────────────────────────────────────
  section(`#3 — PICKED_UP (${money(P.ventilateur.price)})`);
  const s3 = await checkout(ID.customer3, P.ventilateur, 1, DROP_MAKEPE);
  let s3ship = await offerAndAccept(s3.shipment);
  s3ship = await advance(s3ship, 'picked_up');
  const c3 = await deliveryCode(s3ship);
  log('   📦 parcel in the agent\'s hands, cash still outstanding');
  rows.push({ n: 3, label: 'picked_up', shipment: s3ship, order: s3.order, pickup: P.ventilateur.pickupLabel, dropOff: DROP_MAKEPE.formatted_address, code: c3?.code ?? null, amount: c3?.amount ?? 0 });

  // ── #4 — en route, code collectable ───────────────────────────────────────
  section(`#4 — IN_TRANSIT · cash to collect (${money(P.microondes.price)})`);
  const s4 = await checkout(ID.customer4, P.microondes, 1, DROP_BONAPRISO);
  let s4ship = await offerAndAccept(s4.shipment);
  s4ship = await advance(s4ship, 'picked_up');
  s4ship = await advance(s4ship, 'in_transit');
  const c4 = await deliveryCode(s4ship);
  log('   🚚 out for delivery — submit the code below to collect and deliver');
  notes.push(`Collect the cash as the agent:  POST /api/agent/shipments/${s4ship._id}/cod/collect  { "code": "${c4?.code}" }`);
  rows.push({ n: 4, label: 'in_transit', shipment: s4ship, order: s4.order, pickup: P.microondes.pickupLabel, dropOff: DROP_BONAPRISO.formatted_address, code: c4?.code ?? null, amount: c4?.amount ?? 0 });

  // ── #5 — at the door, awaiting the customer's code ────────────────────────
  section(`#5 — AGENT_DELIVERED · awaiting the code (${money(P.bouilloire.price)})`);
  const s5 = await checkout(ID.customer1, P.bouilloire, 1, DROP_DEIDO);
  let s5ship = await offerAndAccept(s5.shipment);
  s5ship = await advance(s5ship, 'picked_up');
  s5ship = await advance(s5ship, 'in_transit');
  s5ship = await advance(s5ship, 'agent_delivered');
  const c5 = await deliveryCode(s5ship);
  log('   🚪 agent reports arrival — for COD this is NOT delivered until the cash is recorded');
  rows.push({ n: 5, label: 'agent_delivered', shipment: s5ship, order: s5.order, pickup: P.bouilloire.pickupLabel, dropOff: DROP_DEIDO.formatted_address, code: c5?.code ?? null, amount: c5?.amount ?? 0 });

  // ── #6 — the full happy path: cash collected, order delivered ─────────────
  section(`#6 — DELIVERED · cash COLLECTED (${money(P.lampe.price)})`);
  const s6 = await checkout(ID.customer2, P.lampe, 1, DROP_LOGBESSOU);
  let s6ship = await offerAndAccept(s6.shipment);
  s6ship = await advance(s6ship, 'picked_up');
  s6ship = await advance(s6ship, 'in_transit');
  const c6 = await deliveryCode(s6ship);
  await cashCollectionService.collect(
    ID.agent.toString(),
    ID.agentUser.toString(),
    (s6ship._id as Types.ObjectId).toString(),
    {
      code: c6!.code,
      location: { lat: DROP_LOGBESSOU.coordinates.coordinates[1], lng: DROP_LOGBESSOU.coordinates.coordinates[0] },
      deviceInfo: 'SeedScript/1.0 (Android)',
    }
  );
  s6ship = (await ShipmentModel.findById(s6ship._id))!;
  log(`   💰 collected ${money(c6!.amount)} — shipment delivered, cash on the agent's account, earnings split`);
  rows.push({ n: 6, label: 'delivered (collected)', shipment: s6ship, order: (await OrderModel.findById(s6.order._id))!, pickup: P.lampe.pickupLabel, dropOff: DROP_LOGBESSOU.formatted_address, code: c6!.code, amount: c6!.amount });

  // ── #7 — the unhappy path: a failed attempt, still retryable ──────────────
  section(`#7 — FAILED · customer absent (${money(P.tv.price)})`);
  const s7 = await checkout(ID.customer3, P.tv, 1, DROP_PK14);
  let s7ship = await offerAndAccept(s7.shipment);
  s7ship = await advance(s7ship, 'picked_up');
  s7ship = await advance(s7ship, 'in_transit');
  s7ship = await advance(s7ship, 'failed');
  const c7 = await deliveryCode(s7ship);
  log('   ⚠️  failed — NOT terminal: it can go back to in_transit for a retry, or to returned');
  rows.push({ n: 7, label: 'failed', shipment: s7ship, order: s7.order, pickup: P.tv.pickupLabel, dropOff: DROP_PK14.formatted_address, code: c7?.code ?? null, amount: c7?.amount ?? 0 });

  // ── Summary ───────────────────────────────────────────────────────────────
  section('Shipments');
  log('');
  log('  #  status                  tracking number            amount        pickup     → drop-off');
  log('  ─  ──────────────────────  ─────────────────────────  ───────────   ──────────────────────────────────────');
  for (const r of rows) {
    log(
      `  ${r.n}  ${r.label.padEnd(22)}  ${(r.shipment.tracking_number ?? '—').padEnd(25)}  ${money(r.amount).padStart(11)}   ${r.pickup.padEnd(10)} → ${r.dropOff}`
    );
  }

  section('Delivery codes (the customer\'s secret — never exposed to agents by the API)');
  log('');
  for (const r of rows) {
    if (!r.code) continue;
    log(`  #${r.n}  shipment ${r.shipment._id}  code ${r.code}  (${money(r.amount)})`);
  }

  section('Ids');
  log('');
  log(`  agency         ${ID.agency}   (agency user ${ID.agencyUser})`);
  log(`  agent          ${ID.agent}   (agent user  ${ID.agentUser})`);
  log(`  vendor         ${ID.vendor}   login ${TAG}vendor@jovitest.cm`);
  log(`  customers      ${ID.customer1}, ${ID.customer2}, ${ID.customer3}, ${ID.customer4}`);
  log(`  password       ${SEED_PASSWORD}  (every account created here)`);
  log('');
  for (const r of rows) {
    log(`  #${r.n}  order ${r.order._id} (${r.order.order_number})  shipment ${r.shipment._id}`);
  }

  const finalBalance = await codCashAccountService.getBalance('agent', ID.agent.toString());
  const finalAgent = await DeliveryAgentModel.findById(ID.agent).lean();
  section('Agent state after seeding');
  log('');
  log(`  cash held         ${money(finalBalance.balance)}`);
  log(`  active shipments  ${finalAgent?.capacity?.active_shipment_count} / ${finalAgent?.capacity?.max_active_shipments}`);

  if (notes.length) {
    section('Try next');
    log('');
    for (const n of notes) log(`  • ${n}`);
  }

  log('\n✨ Done.');
  await mongoose.disconnect();
  // Explicit, because disconnecting Mongo is not enough to end the process: the
  // WhatsApp and FCM clients this script pulls in transitively hold open
  // sockets/timers, and without this the script sits idle for minutes after
  // printing the summary. Everything above has committed by now.
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n❌ Seed failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
