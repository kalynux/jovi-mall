/**
 * Seed: Agent App Test Data
 *
 * Builds a complete, self-contained world around ONE agent — the existing user
 * `a00000000000000000000006` / `+237670000006` — so the agent mobile app can be
 * exercised end to end: offers to accept or reject, jobs to pick up and deliver,
 * a COD code to collect against, cash to deposit, earnings to look at, a second
 * agency inviting them, and a post-pickup handover taken over from a peer agent.
 *
 * Like `seed-cod.ts` (and unlike the raw-insert `seed-orders.js`), this drives the
 * REAL services — OrderService, ShipmentAssignmentService, ShipmentService,
 * CashCollectionService, AgentDepositService — so every row is exactly what the
 * running API would have produced: real hashed+plaintext delivery codes, real
 * capacity reservations, real cash ledgers and earnings splits.
 *
 * ── What it does NOT touch ──────────────────────────────────────────────────
 * Everything it creates besides the agent themself carries a fixed `a9e7…` id or
 * an `agentapp-` tagged email, and cleanup (always run first) only removes
 * documents reachable from those. Pre-existing shipments that happen to point at
 * this agent (e.g. from `seed-orders.js`) are left alone and reported at the end.
 *
 * The agent's own `users` row is kept (same _id, same phone) but its
 * `password_hash` is replaced with a real bcrypt hash — the checked-in fixture
 * carries a placeholder that no login can ever match.
 *
 * ── Side effects are real, because the code paths are ────────────────────────
 * Issuing a COD delivery code notifies the customer over WhatsApp exactly as the
 * live app does, so with WhatsApp credentials in `.env` those requests really do
 * go to Meta and fail loudly against the seeded (fake) numbers. Harmless and
 * best-effort — every code is printed in the summary regardless.
 *
 * PREREQUISITES
 *   • MongoDB running as a replica set (the app's transactions require it)
 *   • `npm run seed:plans` (the agent free plan drives capacity)
 *
 * Run:
 *   npx ts-node scripts/seed/seed-agent-app.ts          # wipe + reseed
 *   npx ts-node scripts/seed/seed-agent-app.ts --clean  # wipe only
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
import { AgencyMagazinModel } from '../../src/modules/magazin/models/magazin.model';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import {
  DeliveryAgentModel,
  AgentAgencyMembershipModel,
  AgentMembershipEventModel,
  agentContractService,
} from '../../src/modules/agents';
import { AgentInviteModel } from '../../src/modules/agents/models/agent-invite.model';
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
import { AgentDepositModel } from '../../src/modules/cod/models/agent-deposit.model';
import { AgencyRemittanceModel } from '../../src/modules/cod/models/agency-remittance.model';
import { CodDiscrepancyModel } from '../../src/modules/cod/models/cod-discrepancy.model';
import { CodTrustEventModel } from '../../src/modules/cod/models/cod-trust-event.model';
import { cashCollectionService } from '../../src/modules/cod/services/cash-collection.service';
import { codCashAccountService } from '../../src/modules/cod/services/cod-cash-account.service';
import { agentDepositService } from '../../src/modules/cod/services/agent-deposit.service';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { AgentNotificationModel } from '../../src/modules/notifications/models/agent-notification.model';
import { TrackingOutboxModel } from '../../src/modules/tracking-integration/models/tracking-outbox.model';
import { initializeAgentNotificationEventConsumers } from '../../src/modules/notifications/agent-notification-event-consumer';
import { subscriberPlanService } from '../../src/modules/billing/services/subscriber-plan.service';
import { creditWalletService } from '../../src/modules/billing/services/credit-wallet.service';
import { AgentOnboardingStep } from '../../src/core/constants/onboarding-steps';
import { IGeoAddress } from '../../src/core/types/geo-address.types';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
const CURRENCY = 'XAF';

/** The password every seeded account (including the agent) logs in with. */
const SEED_PASSWORD = 'AgentTest123!';
/** Email tag on the supporting cast — the cleanup handle. */
const TAG = 'agentapp-';

const log = (msg = '') => console.log(msg);
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 72 - title.length))}`);

// ─────────────────────────────────────────────────────────────────────────────
// ID registry — fixed ids so re-running is idempotent and seeded rows are
// recognisable on sight. `a9e7…` = "agent app"; the two exceptions are the
// agent's own user/profile, which already exist in the fixture data.
// ─────────────────────────────────────────────────────────────────────────────
const sid = (suffix: string) => new Types.ObjectId(`a9e7${'0'.repeat(20 - suffix.length)}${suffix}`);

const ID = {
  // The agent under test (pre-existing rows — reused, never re-keyed).
  agentUser: new Types.ObjectId('a00000000000000000000006'),
  agent: new Types.ObjectId('b00000000000000000000006'),

  // Peer agent — exists only to hand a picked-up shipment over to our agent.
  peerUser: sid('a1'),
  peer: sid('b1'),

  // Agency 1: the agent's primary, active contract.
  agency1User: sid('a2'),
  agency1: sid('b2'),
  magazin1: sid('c2'),

  // Agency 2: a pending invite for the agent to accept/decline in the app.
  agency2User: sid('a3'),
  agency2: sid('b3'),
  magazin2: sid('c3'),

  vendorUser: sid('a4'),
  vendor: sid('b4'),
  store: sid('c4'),

  customer1User: sid('a5'),
  customer1: sid('b5'),
  customer2User: sid('a6'),
  customer2: sid('b6'),
};

/** Every user this script owns besides the agent (used by cleanup). */
const SEEDED_USER_IDS = [
  ID.peerUser,
  ID.agency1User,
  ID.agency2User,
  ID.vendorUser,
  ID.customer1User,
  ID.customer2User,
];

// ─────────────────────────────────────────────────────────────────────────────
// Geo helpers — real Douala/Yaoundé coordinates so the map screens look sane.
// ─────────────────────────────────────────────────────────────────────────────
const geoAddress = (opts: {
  formatted: string;
  lng: number;
  lat: number;
  city: string;
  region: string;
  street?: string;
}): IGeoAddress =>
  ({
    formatted_address: opts.formatted,
    coordinates: { type: 'Point', coordinates: [opts.lng, opts.lat] },
    provider: 'nominatim',
    provider_place_id: null,
    components: {
      street: opts.street ?? null,
      neighbourhood: null,
      city: opts.city,
      region: opts.region,
      postal_code: null,
      country: 'Cameroon',
      country_code: 'CM',
    },
    raw_input: opts.formatted,
    resolved_at: new Date(),
  }) as unknown as IGeoAddress;

const PICKUP_GEO = geoAddress({
  formatted: 'Rue Joss, Akwa, Douala, Cameroun',
  lng: 9.7043,
  lat: 4.0483,
  city: 'Douala',
  region: 'Littoral',
  street: 'Rue Joss',
});
const DROPOFF_1 = geoAddress({
  formatted: 'Carrefour Ndokotti, Douala, Cameroun',
  lng: 9.7368,
  lat: 4.0611,
  city: 'Douala',
  region: 'Littoral',
});
const DROPOFF_2 = geoAddress({
  formatted: 'Boulevard de la Liberté, Bonanjo, Douala, Cameroun',
  lng: 9.6903,
  lat: 4.0435,
  city: 'Douala',
  region: 'Littoral',
});

// ─────────────────────────────────────────────────────────────────────────────
// Services
// ─────────────────────────────────────────────────────────────────────────────
const orderService = new OrderService();
const shipmentService = new ShipmentService();
const vendorSettingsRepo = new VendorSettingsRepository();

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — always first. Scoped to this script's own fixed ids plus everything
// reachable from them, so a re-run never duplicates and never eats other data.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  const agencyIds = [ID.agency1, ID.agency2];
  const agentIds = [ID.agent, ID.peer];
  const customerIds = [ID.customer1, ID.customer2];

  const orders = await OrderModel.find({ vendor_id: ID.vendor }).select('_id').lean();
  const orderIds = orders.map((o) => o._id);
  const shipments = await ShipmentModel.find({ order_id: { $in: orderIds } }).select('_id').lean();
  const shipmentIds = shipments.map((s) => s._id);
  const products = await ProductModel.find({ vendorId: ID.vendor }).select('_id').lean();
  const productIds = products.map((p) => p._id);

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
    // Money & audit rows are agent- or agency-scoped rather than order-scoped.
    AgentDepositModel.deleteMany({ agency_id: { $in: agencyIds } }),
    AgencyRemittanceModel.deleteMany({ agency_id: { $in: agencyIds } }),
    CodDiscrepancyModel.deleteMany({ agency_id: { $in: agencyIds } }),
    CodTrustEventModel.deleteMany({ agent_id: { $in: agentIds } }),
    CodCashLedgerModel.deleteMany({ owner_id: { $in: [...agentIds, ...agencyIds] } }),
    CodCashAccountModel.deleteMany({ owner_id: { $in: [...agentIds, ...agencyIds] } }),
    EarningsLedgerModel.deleteMany({ owner_id: { $in: [ID.vendor, ...agencyIds, ...agentIds] } }),
    EarningsAllocationModel.deleteMany({ beneficiary_id: { $in: [ID.vendor, ...agencyIds, ...agentIds] } }),
    EarningsAccountModel.deleteMany({ owner_id: { $in: [ID.vendor, ...agencyIds, ...agentIds] } }),
    AgentNotificationModel.deleteMany({ agentId: { $in: agentIds } }),
    AgentAgencyMembershipModel.deleteMany({ agent_id: { $in: agentIds } }),
    AgentMembershipEventModel.deleteMany({ agent_id: { $in: agentIds } }),
    AgentInviteModel.deleteMany({ agency_id: { $in: agencyIds } }),
    VendorSettingsModel.deleteMany({ vendor_id: ID.vendor }),
  ]);

  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: orderIds } }),
    ProductModel.deleteMany({ _id: { $in: productIds } }),
    StoreModel.deleteMany({ vendor_id: ID.vendor }),
    AgencyMagazinModel.deleteMany({ agency_id: { $in: agencyIds } }),
    DeliveryAgencyModel.deleteMany({ _id: { $in: agencyIds } }),
    DeliveryAgentModel.deleteMany({ _id: ID.peer }),
    VendorModel.deleteMany({ _id: ID.vendor }),
    CustomerModel.deleteMany({ _id: { $in: customerIds } }),
  ]);

  await UserModel.deleteMany({ _id: { $in: SEEDED_USER_IDS } });

  log(
    `🧹 Cleaned ${orderIds.length} order(s), ${shipmentIds.length} shipment(s) and the supporting cast.`
  );
  log('   (The agent user + profile are reset in place, not deleted.)');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The agent under test
// ─────────────────────────────────────────────────────────────────────────────
async function seedAgent(passwordHash: string) {
  section('Agent identity');

  // Same _id and phone as the checked-in fixture; a usable password hash, an
  // email (invites match on email), and the `agent` role.
  await UserModel.updateOne(
    { _id: ID.agentUser },
    {
      $set: {
        login_phone: '+237670000006',
        login_email: `${TAG}pierre@jovitest.cm`,
        password_hash: passwordHash,
        roles: ['agent'],
        status: 'active',
      },
    },
    { upsert: true }
  );

  const agent = await DeliveryAgentModel.findOneAndUpdate(
    { _id: ID.agent },
    {
      $set: {
        user_id: ID.agentUser,
        name: 'Pierre Ekang',
        email: `${TAG}pierre@jovitest.cm`,
        email_verified: true,
        phone: '+237670000006',
        phone_verified: true,
        vehicle_info: { vehicle_type: 'bike', plate_number: 'LT-4471-AB', color: 'Rouge' },
        legal_identity: { drivers_license_number: 'DL-CM-884213', national_id_number: 'CNI-1198320' },
        emergency_contact: { name: 'Marie Ekang', phone: '+237699112233' },
        // Pool big enough to hold agency 1's 300k slice with headroom to spare.
        cod: { trust_score: 100, max_threshold: 500_000 },
        capacity: { max_active_shipments: 20, active_shipment_count: 0, reconciled_at: new Date() },
        kyc: {
          status: 'verified',
          verified_at: new Date(),
          verified_by_user_id: null,
          rejection_reason: null,
          reference: 'SEED-KYC-PIERRE',
        },
        platform_ban: { banned: false, reason: null, banned_at: null, banned_by_user_id: null },
        payout_details: [
          {
            method: 'mobile_money',
            mobile_money: { provider: 'MTN', phone_number: '+237670000006', account_name: 'Pierre Ekang' },
            bank: null,
          },
        ],
        home_base: {
          location: { type: 'Point', coordinates: [9.7043, 4.0483] },
          service_radius_km: 25,
          label: 'Douala — Akwa',
        },
        trust_signals: {
          on_time_rate: 0.94,
          assignment_response_rate: 0.88,
          completed_shipments: 63,
          customer_rating_avg: 4.6,
          customer_rating_count: 41,
          agency_rating_avg: 4.4,
          agency_rating_count: 12,
          vendor_rating_avg: 4.5,
          vendor_rating_count: 8,
          cod_clean_return_count: 47,
          cod_discrepancy_count: 1,
          cod_volume_returned: 1_850_000,
          computed_at: new Date(),
        },
        // Online + tracking allowed + location granted = eligible for dispatch.
        availability: { state: 'online', changed_at: new Date(), reason: null },
        working_state: { state: 'idle', active_shipment_count: 0, computed_at: new Date() },
        tracking: {
          allowed: true,
          reason: null,
          changed_at: new Date(),
          changed_by_user_id: null,
          changed_by_role: 'agent',
        },
        device: {
          platform: 'android',
          app_version: '1.0.0',
          location_permission: 'always',
          location_services_enabled: true,
          background_location_enabled: true,
          battery_optimization_exempt: true,
          push_enabled: true,
          reported_at: new Date(),
        },
        last_known_tracking_state: {
          status: 'streaming',
          last_position: { type: 'Point', coordinates: [9.7101, 4.0521] },
          last_reported_at: new Date(),
          source: 'geo-tracker',
        },
        preferences: {
          navigation_app: 'google_maps',
        },
        settings: { auto_accept_assignments: false },
        timezone: 'Africa/Douala',
        preferred_language: 'fr',
        status: 'active',
        status_reason: null,
        onboarding_step: AgentOnboardingStep.COMPLETED,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  log(`   ✅ Pierre Ekang  agentId=${ID.agent}  userId=${ID.agentUser}`);
  log('      online · tracking allowed · KYC verified · capacity 0/20 · COD pool 500,000 XAF');
  return agent!;
}

/** The peer agent exists for exactly one thing: handing a parcel over. */
async function seedPeerAgent(passwordHash: string) {
  await UserModel.create({
    _id: ID.peerUser,
    login_email: `${TAG}samuel@jovitest.cm`,
    login_phone: '+237670000106',
    password_hash: passwordHash,
    roles: ['agent'],
    status: 'active',
  });

  const peer = await DeliveryAgentModel.create({
    _id: ID.peer,
    user_id: ID.peerUser,
    name: 'Samuel Biya',
    email: `${TAG}samuel@jovitest.cm`,
    email_verified: true,
    phone: '+237670000106',
    phone_verified: true,
    vehicle_info: { vehicle_type: 'car', plate_number: 'LT-9920-CD', color: 'Bleu' },
    cod: { trust_score: 100, max_threshold: 300_000 },
    capacity: { max_active_shipments: 10, active_shipment_count: 0, reconciled_at: null },
    kyc: { status: 'verified', verified_at: new Date(), verified_by_user_id: null, rejection_reason: null, reference: 'SEED-KYC-SAMUEL' },
    home_base: { location: { type: 'Point', coordinates: [9.7180, 4.0620] }, service_radius_km: 20, label: 'Douala — Bonapriso' },
    availability: { state: 'online', changed_at: new Date(), reason: null },
    tracking: { allowed: true, reason: null, changed_at: new Date(), changed_by_user_id: null, changed_by_role: 'agent' },
    device: {
      platform: 'android',
      app_version: '1.0.0',
      location_permission: 'always',
      location_services_enabled: true,
      background_location_enabled: true,
      battery_optimization_exempt: true,
      push_enabled: true,
      reported_at: new Date(),
    },
    // The handover pickup point for a picked-up reassignment is read from here.
    last_known_tracking_state: {
      status: 'streaming',
      last_position: { type: 'Point', coordinates: [9.7288, 4.0574] },
      last_reported_at: new Date(),
      source: 'geo-tracker',
    },
    timezone: 'Africa/Douala',
    preferred_language: 'fr',
    status: 'active',
    onboarding_step: AgentOnboardingStep.COMPLETED,
  });

  log(`   ✅ Samuel Biya (peer, for the handover scenario)  agentId=${ID.peer}`);
  return peer;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Agencies
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `pickup_based.base_rate_first_kg` matters more than it looks: the seeded
 * products are collected from a vendor address, and EarningsSplitService charges
 * the pickup-based component for exactly that class of shipment. The agent's cut
 * is a share OF that delivery fee — leave the rate at 0 and every delivery earns
 * the agent nothing, which makes the earnings screen useless to test against.
 */
const agencyPolicies = () => ({
  pricing: {
    storage_based: {
      enabled: true,
      monthly_storage_fee_per_sku: 500,
      pick_pack_fee_per_order: 300,
      local_delivery_fee: 1000,
      out_of_region_delivery_fee: 2500,
    },
    pickup_based: { enabled: true, base_rate_first_kg: 1500, additional_per_kg: 300, out_of_region_surcharge: 500 },
    additional_fees: {
      cod_handling_fee: { type: 'percentage', value: 2 },
      failed_delivery_fee: 500,
      rto_fee: 1000,
      peak_season_surcharge: 0,
    },
    notes: null,
  },
  returns: { payer: 'vendor', handling_fee: 500, return_window_days: 7, notes: null },
  damage: { claim_deadline_days: 3, max_refund_per_item: 50_000, notes: null },
  cod: { enabled: true, max_order_amount: null },
  documents: [],
});

async function seedAgencies(passwordHash: string) {
  section('Delivery agencies');

  const specs = [
    {
      userId: ID.agency1User,
      agencyId: ID.agency1,
      magazinId: ID.magazin1,
      email: `${TAG}agency1@jovitest.cm`,
      phone: '+237699000101',
      name: 'Douala Express Logistics',
      city: 'Douala',
      region: 'Littoral',
    },
    {
      userId: ID.agency2User,
      agencyId: ID.agency2,
      magazinId: ID.magazin2,
      email: `${TAG}agency2@jovitest.cm`,
      phone: '+237699000102',
      name: 'Littoral Swift Couriers',
      city: 'Douala',
      region: 'Littoral',
    },
  ];

  for (const s of specs) {
    await UserModel.create({
      _id: s.userId,
      login_email: s.email,
      password_hash: passwordHash,
      roles: ['agency'],
      status: 'active',
    });
    await DeliveryAgencyModel.create({
      _id: s.agencyId,
      user_id: s.userId,
      email: s.email,
      email_verified: true,
      phone: s.phone,
      phone_verified: true,
      agency_name: s.name,
      coverage_areas: [s.city],
      headquarters_addresses: [
        {
          region: s.region,
          city: s.city,
          address_description: `Zone Industrielle Bassa, ${s.city}`,
          support_contact: { phone: s.phone, email: s.email },
          geo: PICKUP_GEO,
        },
      ],
      kyc_details: { registration_number: `RC/DLA/2026/${s.city}`, transport_license_id: 'TL-CM-2026-001', legit_verified: true },
      policies: agencyPolicies(),
      payout_details: [
        {
          method: 'mobile_money',
          mobile_money: { provider: 'MTN', phone_number: s.phone, account_name: s.name },
          bank: null,
        },
      ],
      status: 'active',
      onboarding_step: 0,
    });
    // Business identity lives on the Magazin, never on the agency profile.
    await AgencyMagazinModel.create({
      _id: s.magazinId,
      agency_id: s.agencyId,
      name: s.name,
      description: `${s.name} — agent-app seed.`,
      support_email: s.email,
      support_phone: s.phone,
    });
    log(`   ✅ ${s.name}  agencyId=${s.agencyId}  login=${s.email}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Contracts & invites
// ─────────────────────────────────────────────────────────────────────────────
async function seedContracts() {
  section('Agent ↔ agency contracts');

  // Agency 1 — the live relationship. 300,000 XAF of the agent's 500,000 pool,
  // which is also the COD exposure cap every accept is checked against.
  const contract = await agentContractService.createFromAcceptedInvite(
    ID.agent.toString(),
    ID.agency1.toString(),
    ID.agency1User.toString(),
    new Date(Date.now() - 30 * 86_400_000),
    { userId: ID.agentUser.toString(), role: 'agent' },
    300_000
  );
  await AgentAgencyMembershipModel.updateOne(
    { _id: contract._id },
    {
      $set: {
        'employment.employment_type': 'contractor',
        'employment.employee_ref': 'DEL-0042',
        'employment.started_at': new Date(Date.now() - 30 * 86_400_000),
        'remittance_terms.cadence': 'daily',
        'remittance_terms.grace_hours': 24,
        'fee_split.model': 'percentage',
        'fee_split.agent_share_percent': 70,
        'fee_split.currency': CURRENCY,
        'coverage.regions': ['Littoral'],
        shipment_value_ceiling: 200_000,
      },
    }
  );
  log(`   ✅ Douala Express Logistics — ACTIVE, primary  contractId=${contract._id}`);
  log('      COD slice 300,000 XAF · daily remittance · 70% of the delivery fee');

  // Agency 2 — a pending contract from the peer agent's side is irrelevant; what
  // the app needs is an invite sitting in the agent's inbox.
  const invite = await AgentInviteModel.create({
    agency_id: ID.agency2,
    email: `${TAG}pierre@jovitest.cm`,
    status: 'pending',
    invited_by_user_id: ID.agency2User,
  });
  log(`   📨 Littoral Swift Couriers — PENDING INVITE  inviteId=${invite._id}`);

  // The peer needs a contract too, or agency 1 cannot dispatch to them.
  await agentContractService.createFromAcceptedInvite(
    ID.peer.toString(),
    ID.agency1.toString(),
    ID.agency1User.toString(),
    new Date(Date.now() - 20 * 86_400_000),
    { userId: ID.peerUser.toString(), role: 'agent' },
    100_000
  );

  return { contract, invite };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Vendor, store, catalog, customers
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
    business_name: 'Akwa Electronics',
    display_name: 'Akwa Electronics',
    business_description: 'Agent-app seed vendor.',
    country: 'CM',
    email: `${TAG}vendor@jovitest.cm`,
    phone: '+237699000201',
    email_verified: true,
    phone_verified: true,
    business_addresses: [
      {
        label: 'Boutique Akwa',
        address_line1: 'Rue Joss, Akwa',
        city: 'Douala',
        state: 'Littoral',
        location: { type: 'Point', coordinates: [9.7043, 4.0483] },
        geo: PICKUP_GEO,
      },
    ],
    kyc_details: { national_id_number: 'CNI-VENDOR-01', legit_verified: true },
    default_delivery_agency_id: ID.agency1,
    status: 'active',
    onboarding_step: 0,
  });

  await StoreModel.create({
    _id: ID.store,
    vendor_id: ID.vendor,
    name: 'Akwa Electronics',
    slug: `${TAG}akwa-electronics`,
    description: 'Agent-app seed store.',
  });

  // Auto-redirect ON: shipments land on the agency as `assigned` at checkout
  // (COD) / payment (prepaid), which is the state an offer can be placed from.
  await vendorSettingsRepo.setAutoRedirectOrdersToAgency(ID.vendor.toString(), true);

  const pickupAddressId = (vendor.business_addresses as any)[0]._id;
  log(`   ✅ Akwa Electronics  vendorId=${ID.vendor}  login=${TAG}vendor@jovitest.cm`);
  return { vendor, pickupAddressId };
}

interface ProductFixture {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  sku: string;
  title: string;
  price: number;
  vendorId: Types.ObjectId;
  productType: 'physical';
}

async function createProduct(opts: {
  title: string;
  slug: string;
  price: number;
  pickupAddressId: Types.ObjectId;
}): Promise<ProductFixture> {
  const product = await ProductModel.create({
    vendorId: ID.vendor,
    type: 'physical',
    status: 'active',
    title: opts.title,
    description: `${opts.title} — agent-app seed product.`,
    slug: `${TAG}${opts.slug}`,
    category: 'Electronics',
    tags: ['agent-app-seed'],
    seo: { title: opts.title, description: opts.title },
    hasVariants: false,
    delivery: {
      agency_id: ID.agency1,
      free_delivery: false,
      // A real vendor address (with geo) so the agent app has somewhere to
      // navigate to for the pickup leg.
      pickup_location: { source: 'vendor_address', vendor_address_id: opts.pickupAddressId },
    },
  });

  const sku = `${opts.slug.toUpperCase()}-001`;
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

  log(`   ✅ ${opts.title.padEnd(24)} ${opts.price.toLocaleString()} ${CURRENCY}`);
  return {
    productId: product._id,
    variantId: variant._id,
    sku,
    title: opts.title,
    price: opts.price,
    vendorId: ID.vendor,
    productType: 'physical',
  };
}

async function seedCustomers(passwordHash: string) {
  section('Customers');

  const specs = [
    {
      userId: ID.customer1User,
      customerId: ID.customer1,
      email: `${TAG}amina@jovitest.cm`,
      phone: '+237655000301',
      name: 'Amina Njoya',
      geo: DROPOFF_1,
      line1: 'Carrefour Ndokotti, immeuble Sokoa',
    },
    {
      userId: ID.customer2User,
      customerId: ID.customer2,
      email: `${TAG}jean@jovitest.cm`,
      phone: '+237655000302',
      name: 'Jean Talla',
      geo: DROPOFF_2,
      line1: 'Boulevard de la Liberté, Bonanjo',
    },
  ];

  for (const s of specs) {
    await UserModel.create({
      _id: s.userId,
      login_email: s.email,
      password_hash: passwordHash,
      roles: ['customer'],
      status: 'active',
    });
    await CustomerModel.create({
      _id: s.customerId,
      user_id: s.userId,
      email: s.email,
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
    log(`   ✅ ${s.name}  ${s.phone}  → ${s.geo.formatted_address}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Scenario helpers — every one drives the real API path.
// ─────────────────────────────────────────────────────────────────────────────
async function checkout(
  customerId: Types.ObjectId,
  items: Array<{ p: ProductFixture; qty: number }>,
  paymentMethod: 'online' | 'cash_on_delivery'
): Promise<{ order: IOrder; shipment: IShipment }> {
  await CartModel.findOneAndReplace(
    { userId: customerId.toString() },
    {
      userId: customerId.toString(),
      productType: 'physical',
      items: items.map(({ p, qty }) => ({
        variantId: p.variantId,
        sku: p.sku,
        variantTitle: 'Default',
        optionsSnapshot: 'default',
        productId: p.productId,
        title: p.title,
        vendorId: p.vendorId,
        productType: p.productType,
        quantity: qty,
        price: p.price,
        currency: CURRENCY,
      })),
    },
    { upsert: true, new: true }
  );

  const { orders } = await orderService.createOrdersFromCart(customerId.toString(), paymentMethod);
  const order = orders[0];

  if (paymentMethod === 'online') {
    await orderService.handlePaymentSuccess((order._id as Types.ObjectId).toString());
  }

  // Auto-redirect normally dispatches; fall back to an explicit dispatch so the
  // shipment is `assigned` (offerable) whatever the settings did.
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

/** Place a manual offer from agency 1 on a shipment. */
async function offer(shipment: IShipment, agentId: Types.ObjectId) {
  const result = await shipmentAssignmentService.offerToAgent(
    ID.agency1.toString(),
    (shipment._id as Types.ObjectId).toString(),
    agentId.toString(),
    { role: 'agency', userId: ID.agency1User.toString() }
  );
  return result;
}

/** Push a pending offer's deadline out so it survives until you test it. */
async function keepAlive(offerId: string, days = 7) {
  await ShipmentAssignmentOfferModel.updateOne(
    { _id: offerId },
    { $set: { expires_at: new Date(Date.now() + days * 86_400_000) } }
  );
}

/** Agency-driven status transition (the agent has no endpoint for these). */
async function advance(shipment: IShipment, status: 'picked_up' | 'in_transit' | 'agent_delivered' | 'failed' | 'returned') {
  await shipmentService.updateStatus(
    ID.agency1.toString(),
    (shipment._id as Types.ObjectId).toString(),
    status,
    ID.agency1User.toString()
  );
  return (await ShipmentModel.findById(shipment._id))!;
}

/** The plaintext delivery code the customer holds (never exposed by the API). */
async function deliveryCode(shipment: IShipment): Promise<{ code: string; amount: number } | null> {
  const collection = await CashCollectionModel.findOne({ shipment_id: shipment._id }).select('+code_plain');
  if (!collection?.code_plain) return null;
  return { code: collection.code_plain, amount: collection.expected_amount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const cleanOnly = process.argv.includes('--clean');

  await mongoose.connect(MONGO_URI);
  log(`✅ Connected to MongoDB (${MONGO_URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);

  // server.ts registers these at boot; without them the flows below would emit
  // offer/deposit events nobody listens to and the agent's notification list
  // would come out empty.
  initializeAgentNotificationEventConsumers();

  await cleanup();
  if (cleanOnly) {
    log('\n✨ Clean complete (--clean). Nothing seeded.');
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  await seedAgent(passwordHash);
  await seedPeerAgent(passwordHash);
  await seedAgencies(passwordHash);
  const { invite } = await seedContracts();
  const { pickupAddressId } = await seedVendor(passwordHash);

  const products = {
    earbuds: await createProduct({ title: 'Écouteurs Bluetooth', slug: 'ecouteurs-bt', price: 12_500, pickupAddressId }),
    powerbank: await createProduct({ title: 'Batterie externe 20k', slug: 'powerbank-20k', price: 8_000, pickupAddressId }),
    kettle: await createProduct({ title: 'Bouilloire électrique', slug: 'bouilloire', price: 22_000, pickupAddressId }),
    fan: await createProduct({ title: 'Ventilateur sur pied', slug: 'ventilateur', price: 15_000, pickupAddressId }),
    lamp: await createProduct({ title: 'Lampe solaire', slug: 'lampe-solaire', price: 9_000, pickupAddressId }),
    router: await createProduct({ title: 'Routeur 4G', slug: 'routeur-4g', price: 18_000, pickupAddressId }),
  };

  await seedCustomers(passwordHash);

  const notes: string[] = [];
  const codes: Array<{ label: string; shipmentId: string; code: string; amount: number }> = [];

  // ── S1 — a pending offer waiting in the app ────────────────────────────────
  section('S1 — PENDING offer (COD, 12,500 XAF)');
  const s1 = await checkout(ID.customer1, [{ p: products.earbuds, qty: 1 }], 'cash_on_delivery');
  const o1 = await offer(s1.shipment, ID.agent);
  await keepAlive(o1.offer.id);
  log(`   📨 offer ${o1.offer.id} → pending for 7 days (not the usual 120s)`);
  notes.push(`Accept or reject the pending offer: POST /api/agent/offers/${o1.offer.id}/accept`);

  // ── S2 — accepted, waiting to be picked up ────────────────────────────────
  section('S2 — ACCEPTED, awaiting pickup (COD, 8,000 XAF)');
  const s2 = await checkout(ID.customer2, [{ p: products.powerbank, qty: 1 }], 'cash_on_delivery');
  const o2 = await offer(s2.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o2.offer.id);
  log('   ✅ accepted — shipment is `assigned` with the agent bound; delivery code issued');

  // ── S3 — out for delivery with a collectable COD code ─────────────────────
  section('S3 — IN TRANSIT, cash to collect (COD, 22,000 XAF)');
  const s3 = await checkout(ID.customer1, [{ p: products.kettle, qty: 1 }], 'cash_on_delivery');
  const o3 = await offer(s3.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o3.offer.id);
  let s3ship = await advance(s3.shipment, 'picked_up');
  s3ship = await advance(s3ship, 'in_transit');
  const c3 = await deliveryCode(s3ship);
  if (c3) {
    codes.push({ label: 'S3 — Bouilloire électrique', shipmentId: (s3ship._id as Types.ObjectId).toString(), ...c3 });
  }

  // ── S4 — prepaid, agent says delivered, customer has not confirmed ────────
  section('S4 — AGENT_DELIVERED, awaiting customer confirmation (prepaid, 15,000 XAF)');
  const s4 = await checkout(ID.customer2, [{ p: products.fan, qty: 1 }], 'online');
  const o4 = await offer(s4.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o4.offer.id);
  let s4ship = await advance(s4.shipment, 'picked_up');
  s4ship = await advance(s4ship, 'in_transit');
  s4ship = await advance(s4ship, 'agent_delivered');
  log('   ⏳ waiting on the customer (or the auto-confirm sweep) to reach `delivered`');

  // ── S5 — a completed COD delivery: cash collected, earnings split ─────────
  section('S5 — DELIVERED via COD collection (9,000 XAF)');
  const s5 = await checkout(ID.customer1, [{ p: products.lamp, qty: 1 }], 'cash_on_delivery');
  const o5 = await offer(s5.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o5.offer.id);
  let s5ship = await advance(s5.shipment, 'picked_up');
  s5ship = await advance(s5ship, 'in_transit');
  const c5 = await deliveryCode(s5ship);
  await cashCollectionService.collect(
    ID.agent.toString(),
    ID.agentUser.toString(),
    (s5ship._id as Types.ObjectId).toString(),
    { code: c5!.code, location: { lat: 4.0611, lng: 9.7368 }, deviceInfo: 'SeedScript/1.0 (Android)' }
  );
  log(`   💰 collected ${c5!.amount.toLocaleString()} ${CURRENCY} — shipment delivered, cash on the agent's account`);

  // ── S6 — the unhappy path: failed then returned ───────────────────────────
  section('S6 — FAILED → RETURNED (prepaid, 18,000 XAF)');
  const s6 = await checkout(ID.customer2, [{ p: products.router, qty: 1 }], 'online');
  const o6 = await offer(s6.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o6.offer.id);
  let s6ship = await advance(s6.shipment, 'picked_up');
  s6ship = await advance(s6ship, 'in_transit');
  s6ship = await advance(s6ship, 'failed');
  s6ship = await advance(s6ship, 'returned');
  log('   ↩️  returned — closed, capacity released, in the agent\'s history');

  // ── S7 — a handover offer taken over from the peer agent ──────────────────
  section('S7 — HANDOVER offer from a peer agent (COD, 12,500 XAF)');
  const s7 = await checkout(ID.customer1, [{ p: products.earbuds, qty: 1 }], 'cash_on_delivery');
  const o7peer = await offer(s7.shipment, ID.peer);
  await shipmentAssignmentService.accept(ID.peer.toString(), o7peer.offer.id);
  await advance(s7.shipment, 'picked_up');
  const reassigned = await shipmentAssignmentService.reassign(
    ID.agency1.toString(),
    (s7.shipment._id as Types.ObjectId).toString(),
    { agentId: ID.agent.toString(), reason: 'Panne de véhicule — passage de relais' },
    { role: 'agency', userId: ID.agency1User.toString() }
  );
  await keepAlive(reassigned.offer.id);
  log(`   📨 handover offer ${reassigned.offer.id} → shipment is \`handing_over\``);
  log(`      collection point: ${reassigned.pickupLocation?.source} — ${reassigned.pickupLocation?.label ?? 'n/a'}`);
  notes.push(`Accept the handover offer (pickup = the peer's last position): POST /api/agent/offers/${reassigned.offer.id}/accept`);

  // ── S8 — a rejected offer, for the history tab ────────────────────────────
  section('S8 — REJECTED offer (history)');
  const s8 = await checkout(ID.customer2, [{ p: products.powerbank, qty: 2 }], 'cash_on_delivery');
  const o8 = await offer(s8.shipment, ID.agent);
  await shipmentAssignmentService.reject(ID.agent.toString(), o8.offer.id, 'Trop loin de ma zone');
  log('   ❌ rejected — back in agency 1\'s queue, visible in the agent\'s offer history');

  // ── COD cash chain ────────────────────────────────────────────────────────
  section('COD cash chain');
  const balanceAfterCollect = await codCashAccountService.getBalance('agent', ID.agent.toString());
  const settled = await agentDepositService.declare({
    agentId: ID.agent.toString(),
    agencyId: ID.agency1.toString(),
    amount: balanceAfterCollect.balance,
    recipient: 'agency',
    note: 'Seed: remise du soir',
    declaredByUserId: ID.agentUser.toString(),
  });
  await agentDepositService.confirm({
    depositId: (settled._id as Types.ObjectId).toString(),
    by: 'agency',
    agencyId: ID.agency1.toString(),
    confirmedByUserId: ID.agency1User.toString(),
  });
  log(`   ✅ deposit ${settled._id} — declared ${balanceAfterCollect.balance.toLocaleString()} ${CURRENCY} and CONFIRMED (settled)`);

  // A second collection, this one left with an open declaration the agency has
  // not answered — the state the agent's deposit screen is really about.
  section('S9 — DELIVERED via COD, deposit DECLARED but unconfirmed (12,500 XAF)');
  const s9 = await checkout(ID.customer1, [{ p: products.earbuds, qty: 1 }], 'cash_on_delivery');
  const o9 = await offer(s9.shipment, ID.agent);
  await shipmentAssignmentService.accept(ID.agent.toString(), o9.offer.id);
  let s9ship = await advance(s9.shipment, 'picked_up');
  s9ship = await advance(s9ship, 'in_transit');
  const c9 = await deliveryCode(s9ship);
  await cashCollectionService.collect(
    ID.agent.toString(),
    ID.agentUser.toString(),
    (s9ship._id as Types.ObjectId).toString(),
    { code: c9!.code, location: { lat: 4.0483, lng: 9.7043 }, deviceInfo: 'SeedScript/1.0 (Android)' }
  );
  const heldBalance = await codCashAccountService.getBalance('agent', ID.agent.toString());
  const openDeposit = await agentDepositService.declare({
    agentId: ID.agent.toString(),
    agencyId: ID.agency1.toString(),
    amount: heldBalance.balance,
    recipient: 'agency',
    note: 'Seed: remise déclarée, en attente de confirmation',
    declaredByUserId: ID.agentUser.toString(),
  });
  log(`   ⏳ deposit ${openDeposit._id} — ${heldBalance.balance.toLocaleString()} ${CURRENCY} DECLARED, awaiting agency confirmation`);
  notes.push(
    `Confirm the open deposit as agency 1: POST /api/agency/cod/deposits/${openDeposit._id}/confirm`
  );

  // ── Billing ───────────────────────────────────────────────────────────────
  section('Billing');
  // Lazily materialises the agent free tier (and grants its credit allowance) —
  // the same call the agent's own billing endpoints make on first read.
  const plan = await subscriberPlanService.getActivePlan('agent', ID.agent.toString());
  const credits = await creditWalletService.getBalance('agent', ID.agent.toString());
  log(`   ✅ plan=${plan.plan_code} · credit balance=${credits}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  const finalAgent = await DeliveryAgentModel.findById(ID.agent).lean();
  const mine = await ShipmentModel.find({ agent_id: ID.agent }).select('_id status').lean();
  const foreign = await ShipmentModel.countDocuments({
    agent_id: ID.agent,
    order_id: { $nin: (await OrderModel.find({ vendor_id: ID.vendor }).select('_id').lean()).map((o) => o._id) },
  });
  const cash = await codCashAccountService.getBalance('agent', ID.agent.toString());

  section('SUMMARY');
  log(`\n🔑 LOGIN (agent app)`);
  log(`   POST /api/auth/login   { "identifier": "+237670000006", "password": "${SEED_PASSWORD}" }`);
  log(`   (the email ${TAG}pierre@jovitest.cm works as an identifier too)`);
  log(`   agentId  ${ID.agent}`);
  log(`   userId   ${ID.agentUser}`);

  log(`\n👥 OTHER LOGINS — all with password ${SEED_PASSWORD}`);
  log(`   agency 1 (dispatcher)  ${TAG}agency1@jovitest.cm   agencyId=${ID.agency1}`);
  log(`   agency 2 (inviter)     ${TAG}agency2@jovitest.cm   agencyId=${ID.agency2}`);
  log(`   vendor                 ${TAG}vendor@jovitest.cm`);
  log(`   customer 1 / 2         ${TAG}amina@jovitest.cm / ${TAG}jean@jovitest.cm`);
  log(`   peer agent             ${TAG}samuel@jovitest.cm   agentId=${ID.peer}`);

  log(`\n📦 THE AGENT'S SHIPMENTS (${mine.length})`);
  for (const s of mine) log(`   ${s._id}  ${s.status}`);
  if (foreign > 0) {
    log(`   ⚠️  ${foreign} of these predate this seed (other fixtures) and were left untouched.`);
  }

  log(`\n📨 OFFERS`);
  log(`   pending  ${o1.offer.id}   (S1, ordinary assignment)`);
  log(`   pending  ${reassigned.offer.id}   (S7, handover — carries a pickupLocation)`);
  log(`   rejected ${o8.offer.id}   (S8, history)`);
  log(`   ${(await ShipmentAssignmentOfferModel.countDocuments({ agent_id: ID.agent }))} offer rows in total for this agent.`);

  log(`\n💵 COD`);
  log(`   cash in hand          ${cash.balance.toLocaleString()} ${CURRENCY}`);
  log(`   contract COD slice    300,000 ${CURRENCY} (agency 1)`);
  log(`   agent COD pool        ${(finalAgent?.cod?.max_threshold ?? 0).toLocaleString()} ${CURRENCY}`);
  if (codes.length) {
    log(`\n   Delivery codes still collectable (the customer's secret — printed here only for testing):`);
    for (const c of codes) {
      log(`     ${c.label}: code ${c.code} for ${c.amount.toLocaleString()} ${CURRENCY}`);
      log(`       POST /api/agent/shipments/${c.shipmentId}/cod/collect   { "code": "${c.code}" }`);
    }
  }

  log(`\n💰 EARNINGS`);
  const agentAllocations = await EarningsAllocationModel.find({
    beneficiary_type: 'agent',
    beneficiary_id: ID.agent,
  })
    .select('amount status')
    .lean();
  const earned = agentAllocations.reduce((sum, a) => sum + a.amount, 0);
  log(`   ${agentAllocations.length} allocation(s), ${earned.toLocaleString()} ${CURRENCY} total (70% of each delivery fee)`);
  log(`   Held until the order completes AND the cash is settled up the chain — that is COD escrow, not a bug.`);
  log(`   Prepaid deliveries pay the agent nothing yet (known gap: see AGENT-CONTRACT-REFACTOR.md).`);

  log(`\n🔔 NOTIFICATIONS`);
  log(`   ${await AgentNotificationModel.countDocuments({ agentId: ID.agent })} in-app notification(s) for this agent.`);

  log(`\n🧭 CAPACITY & STATE`);
  log(`   availability ${finalAgent?.availability?.state} · tracking ${finalAgent?.tracking?.allowed ? 'allowed' : 'blocked'} · KYC ${finalAgent?.kyc?.status}`);
  log(`   capacity     ${finalAgent?.capacity?.active_shipment_count}/${finalAgent?.capacity?.max_active_shipments} active`);

  log(`\n📋 THINGS TO TRY`);
  log(`   Accept the pending agency-2 invite: GET /api/agent/invites → POST /api/agent/invites/${invite._id}/accept`);
  for (const n of notes) log(`   ${n}`);
  log(`   Go offline/online: PUT /api/agent/availability { "state": "on_break", "reason": "déjeuner" }`);
  log(`   Cancel a job mid-delivery: POST /api/agent/shipments/<id>/cancel { "reason": "vehicle_breakdown" }`);

  log('\n✨ Done.');
  await mongoose.disconnect();
}

// Redis, the WhatsApp client and the storage provider all hold the event loop
// open, so an explicit exit is what ends the process rather than a hang.
main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('\n❌ Seed failed:', err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
