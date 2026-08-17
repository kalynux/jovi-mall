/**
 * Seed: Cash on Delivery (COD) Test Data
 *
 * Creates a self-contained dataset for manually exercising the COD feature
 * end-to-end: 5 delivery agencies, 6 delivery agents (5 linked + 1 unlinked
 * with a pending invite), 4 vendors (some with auto-redirect-to-agency
 * enabled), a matching product catalog, 4 customers, and 8 order scenarios
 * covering the full lifecycle — including a single order whose items span
 * FOUR different delivery agencies (4 shipments), a fully-settled cash
 * remittance chain, a pending (unconfirmed) remittance, a cash-shortfall
 * discrepancy, and three deliberate negative-path rejections.
 *
 * Unlike seed-orders.js (raw mongosh inserts), this script drives the REAL
 * application services (OrderService, ShipmentService, CashCollectionService,
 * AgentDepositService, AgencyRemittanceService, CodDiscrepancyService) so the
 * generated state is exactly what the running API would produce — real
 * hashed/plaintext delivery codes, real transactions, real cash ledgers, real
 * earnings splits.
 *
 * Does NOT touch any pre-existing data — every seeded document is tagged with
 * a `cod-` prefixed email/slug, and cleanup (always run first) only removes
 * documents reachable from those tagged users.
 *
 * PREREQUISITE: MongoDB must be a replica set (the app's own transactions
 * require it) and pricing plans should already be seeded (`npm run seed:plans`)
 * — if not, COD earnings splits will log a harmless internal error and can be
 * recovered later by the daily earnings sweep.
 *
 * Run:
 *   npx ts-node scripts/seed/seed-cod.ts          # wipe COD seed data + reseed
 *   npx ts-node scripts/seed/seed-cod.ts --clean  # wipe COD seed data only
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { AdminModel } from '../../src/modules/admins/admin.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { VendorSettingsModel } from '../../src/modules/vendors/models/vendor-settings.model';
import { VendorSettingsRepository } from '../../src/modules/vendors/repositories/vendor-settings.repository';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { DeliveryAgentModel, IDeliveryAgent } from '../../src/modules/delivery/delivery-agent.model';
import { AgentInviteModel } from '../../src/modules/delivery/agent-invite.model';
import { agentRosterService } from '../../src/modules/delivery/services/agent-roster.service';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { CartModel } from '../../src/modules/cart/models/cart.model';
import { OrderModel, IOrder } from '../../src/modules/orders/order.model';
import { OrderService } from '../../src/modules/orders/order.service';
import { OrderTimelineModel } from '../../src/modules/orders/order-timeline.model';
import { ShipmentModel, IShipment } from '../../src/modules/shipments/shipment.model';
import { ShipmentService } from '../../src/modules/shipments/shipment.service';
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
import { agencyRemittanceService } from '../../src/modules/cod/services/agency-remittance.service';
import { codDiscrepancyService } from '../../src/modules/cod/services/cod-discrepancy.service';
import { EarningsAccountModel } from '../../src/modules/earnings/models/earnings-account.model';
import { EarningsAllocationModel } from '../../src/modules/earnings/models/earnings-allocation.model';
import { EarningsLedgerModel } from '../../src/modules/earnings/models/earnings-ledger.model';
import { EarningsReserveHoldModel } from '../../src/modules/earnings/models/earnings-reserve-hold.model';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
const EMAIL_PREFIX = 'cod-';
const SEED_PASSWORD = 'CodTest123!';
const CURRENCY = 'XAF';

const log = (msg: string) => console.log(msg);
const section = (title: string) => console.log(`\n${'─'.repeat(2)} ${title} ${'─'.repeat(Math.max(2, 70 - title.length))}`);

const orderService = new OrderService();
const shipmentService = new ShipmentService();
const vendorSettingsRepo = new VendorSettingsRepository();

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — always run first. Only touches documents reachable from `cod-`
// tagged users, never pre-existing data.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  const users = await UserModel.find({ login_email: { $regex: /^cod-/ } }).select('_id').lean();
  const userIds = users.map((u) => u._id);
  if (userIds.length === 0) {
    log('No previous COD seed data found — nothing to clean.');
    return;
  }

  const [customers, vendors, agencies, agents] = await Promise.all([
    CustomerModel.find({ user_id: { $in: userIds } }).select('_id').lean(),
    VendorModel.find({ user_id: { $in: userIds } }).select('_id').lean(),
    DeliveryAgencyModel.find({ user_id: { $in: userIds } }).select('_id').lean(),
    DeliveryAgentModel.find({ user_id: { $in: userIds } }).select('_id').lean(),
  ]);
  const customerIds = customers.map((c) => c._id);
  const vendorIds = vendors.map((v) => v._id);
  const agencyIds = agencies.map((a) => a._id);
  const agentIds = agents.map((a) => a._id);
  const financeOwnerIds = [...agentIds, ...agencyIds];
  const earningsOwnerIds = [...vendorIds, ...agencyIds];

  const products = await ProductModel.find({ vendorId: { $in: vendorIds } }).select('_id').lean();
  const productIds = products.map((p) => p._id);
  const orders = await OrderModel.find({ vendor_id: { $in: vendorIds } }).select('_id').lean();
  const orderIds = orders.map((o) => o._id);

  await Promise.all([
    CashCollectionModel.deleteMany({ order_id: { $in: orderIds } }),
    ShipmentModel.deleteMany({ order_id: { $in: orderIds } }),
    OrderTimelineModel.deleteMany({ order_id: { $in: orderIds } }),
    CartModel.deleteMany({ userId: { $in: customerIds.map(String) } }),
    ProductVariantModel.deleteMany({ productId: { $in: productIds } }),
    AgentInviteModel.deleteMany({ agency_id: { $in: agencyIds } }),
    CodDiscrepancyModel.deleteMany({ agency_id: { $in: agencyIds } }),
    CodTrustEventModel.deleteMany({ agent_id: { $in: agentIds } }),
    AgentDepositModel.deleteMany({ agency_id: { $in: agencyIds } }),
    AgencyRemittanceModel.deleteMany({ agency_id: { $in: agencyIds } }),
    CodCashLedgerModel.deleteMany({ owner_id: { $in: financeOwnerIds } }),
    CodCashAccountModel.deleteMany({ owner_id: { $in: financeOwnerIds } }),
    EarningsLedgerModel.deleteMany({ owner_id: { $in: earningsOwnerIds } }),
    EarningsAllocationModel.deleteMany({ beneficiary_id: { $in: earningsOwnerIds } }),
    EarningsAccountModel.deleteMany({ owner_id: { $in: earningsOwnerIds } }),
    EarningsReserveHoldModel.deleteMany({ owner_id: { $in: agencyIds } }),
    VendorSettingsModel.deleteMany({ vendor_id: { $in: vendorIds } }),
  ]);
  await OrderModel.deleteMany({ _id: { $in: orderIds } });
  await Promise.all([
    ProductModel.deleteMany({ _id: { $in: productIds } }),
    DeliveryAgentModel.deleteMany({ _id: { $in: agentIds } }),
    DeliveryAgencyModel.deleteMany({ _id: { $in: agencyIds } }),
    VendorModel.deleteMany({ _id: { $in: vendorIds } }),
    CustomerModel.deleteMany({ _id: { $in: customerIds } }),
    AdminModel.deleteMany({ user_id: { $in: userIds } }),
  ]);
  await UserModel.deleteMany({ _id: { $in: userIds } });

  log(`🧹 Cleaned up ${userIds.length} previous COD seed user(s) and all linked data.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity creation
// ─────────────────────────────────────────────────────────────────────────────
async function createUser(email: string, role: 'agency' | 'agent' | 'vendor' | 'customer' | 'admin', passwordHash: string) {
  return UserModel.create({ login_email: `${EMAIL_PREFIX}${email}`, password_hash: passwordHash, roles: [role], status: 'active' });
}

interface AgencyFixture {
  key: string;
  user: mongoose.Document & { _id: mongoose.Types.ObjectId };
  doc: mongoose.Document & { _id: mongoose.Types.ObjectId; agency_name: string };
}

interface AgentFixture {
  key: string;
  user: mongoose.Document & { _id: mongoose.Types.ObjectId };
  doc: IDeliveryAgent;
}

interface VendorFixture {
  key: string;
  user: mongoose.Document & { _id: mongoose.Types.ObjectId };
  doc: mongoose.Document & { _id: mongoose.Types.ObjectId; business_name: string };
}

const commonAgencyPolicy = (codEnabled: boolean, codCap: number | null) => ({
  pricing: {
    storage_based: { enabled: true, monthly_storage_fee_per_sku: 500, pick_pack_fee_per_order: 300, local_delivery_fee: 1000, out_of_region_delivery_fee: 2500 },
    pickup_based: { enabled: false, base_rate_first_kg: 0, additional_per_kg: 0, out_of_region_surcharge: 0 },
    additional_fees: { cod_handling_fee: { type: 'percentage', value: 2 }, failed_delivery_fee: 500, rto_fee: 1000, peak_season_surcharge: 0 },
    notes: null,
  },
  returns: { payer: 'vendor', handling_fee: 500, return_window_days: 7, notes: null },
  damage: { claim_deadline_days: 3, max_refund_per_item: 50000, notes: null },
  cod: { enabled: codEnabled, max_order_amount: codCap },
  documents: [],
});

async function createAgencies(passwordHash: string): Promise<Record<string, AgencyFixture>> {
  section('Creating 5 delivery agencies');
  const specs = [
    { key: 'agency1', email: 'agency1@jovitest.cm', name: 'Douala Express Logistics', city: 'Douala', region: 'Littoral', codEnabled: true, codCap: null },
    { key: 'agency2', email: 'agency2@jovitest.cm', name: 'Yaoundé Rapid Delivery', city: 'Yaoundé', region: 'Centre', codEnabled: true, codCap: 50000 },
    { key: 'agency3', email: 'agency3@jovitest.cm', name: 'Bafoussam Swift Couriers', city: 'Bafoussam', region: 'Ouest', codEnabled: true, codCap: null },
    { key: 'agency4', email: 'agency4@jovitest.cm', name: 'Kribi Coastal Delivery', city: 'Kribi', region: 'Sud', codEnabled: true, codCap: null },
    { key: 'agency5', email: 'agency5@jovitest.cm', name: 'Garoua North Logistics', city: 'Garoua', region: 'Nord', codEnabled: false, codCap: null },
  ];

  const result: Record<string, AgencyFixture> = {};
  for (const s of specs) {
    const user = await createUser(s.email, 'agency', passwordHash);
    const doc = await DeliveryAgencyModel.create({
      user_id: user._id,
      email: `${EMAIL_PREFIX}${s.email}`,
      email_verified: true,
      phone: `+2376${Math.floor(90000000 + Math.random() * 9000000)}`,
      phone_verified: true,
      agency_name: s.name,
      coverage_areas: [s.city, 'Douala'],
      headquarters_addresses: [{
        region: s.region,
        city: s.city,
        address_description: `Zone Industrielle, ${s.city}`,
        support_contact: { phone: '+237699000000', email: `support+${s.key}@jovitest.cm` },
      }],
      kyc_details: { registration_number: `RC/${s.key.toUpperCase()}/2026`, transport_license_id: `TL-CM-2026-${s.key}`, legit_verified: true },
      policies: commonAgencyPolicy(s.codEnabled, s.codCap),
      status: 'active',
      onboarding_step: 0,
    });
    result[s.key] = { key: s.key, user, doc: doc as any };
    log(`   ✅ ${s.name}  (COD: ${s.codEnabled ? `enabled${s.codCap ? `, cap ${s.codCap}` : ''}` : 'DISABLED'})  login=${EMAIL_PREFIX}${s.email}`);
  }
  return result;
}

async function createAgents(passwordHash: string, agencies: Record<string, AgencyFixture>): Promise<Record<string, AgentFixture>> {
  section('Creating 6 delivery agents (5 linked + 1 unlinked)');
  const specs = [
    { key: 'agent1', email: 'agent1@jovitest.cm', name: 'Pierre Ekang', agency: 'agency1', trust: 100, maxExposure: null as number | null },
    { key: 'agent2', email: 'agent2@jovitest.cm', name: 'Samuel Biya', agency: 'agency2', trust: 100, maxExposure: null },
    { key: 'agent3', email: 'agent3@jovitest.cm', name: 'Jean Fotso', agency: 'agency3', trust: 35, maxExposure: null }, // low trust → COD_AGENT_TRUST_TOO_LOW
    { key: 'agent4', email: 'agent4@jovitest.cm', name: 'Marie Ngo', agency: 'agency4', trust: 100, maxExposure: 10000 }, // low cap → COD_AGENT_EXPOSURE_EXCEEDED
    { key: 'agent5', email: 'agent5@jovitest.cm', name: 'Andre Mbala', agency: 'agency5', trust: 100, maxExposure: null }, // agency5 has COD disabled
    { key: 'agent6', email: 'agent6@jovitest.cm', name: 'Chantal Owona', agency: null, trust: 100, maxExposure: null }, // unlinked — pending invite target
  ];

  const result: Record<string, AgentFixture> = {};
  for (const s of specs) {
    const user = await createUser(s.email, 'agent', passwordHash);
    const doc = await DeliveryAgentModel.create({
      user_id: user._id,
      agency_id: s.agency ? agencies[s.agency].doc._id : undefined,
      email: `${EMAIL_PREFIX}${s.email}`,
      email_verified: true,
      phone: `+2376${Math.floor(90000000 + Math.random() * 9000000)}`,
      phone_verified: true,
      name: s.name,
      vehicle_info: { vehicle_type: 'bike', plate_number: `LT-${Math.floor(1000 + Math.random() * 8999)}`, color: 'Red' },
      legal_identity: { drivers_license_number: `DL-${s.key}`, national_id_number: `CNI-${s.key}` },
      emergency_contact: { name: 'Emergency Contact', phone: '+237670000000' },
      status: 'active',
      onboarding_step: 0,
      cod: { trust_score: s.trust, max_exposure_override: s.maxExposure },
    });
    result[s.key] = { key: s.key, user, doc };
    log(`   ✅ ${s.name}  → ${s.agency ?? 'UNLINKED'}  trust=${s.trust}  maxExposureOverride=${s.maxExposure ?? 'default(300000)'}  login=${EMAIL_PREFIX}${s.email}`);
  }

  // Demonstrate the invite flow: agency1 invites the unlinked agent6.
  const invite = await agentRosterService.invite(
    agencies.agency1.doc._id.toString(),
    `${EMAIL_PREFIX}agent6@jovitest.cm`,
    agencies.agency1.user._id.toString()
  );
  log(`   📨 agency1 invited agent6 (pending invite ${invite._id}) — log in as agent6 and accept/decline via POST /api/agent/invites/:id/accept|decline`);

  return result;
}

async function createVendors(passwordHash: string, agencies: Record<string, AgencyFixture>): Promise<Record<string, VendorFixture>> {
  section('Creating 4 vendors (2 with auto-redirect-to-agency enabled)');
  const specs = [
    { key: 'vendor1', email: 'vendor1@jovitest.cm', name: 'Douala Multi-Agency Traders', defaultAgency: 'agency4', autoRedirect: true },
    { key: 'vendor2', email: 'vendor2@jovitest.cm', name: 'Yaoundé Basics Co.', defaultAgency: 'agency1', autoRedirect: false },
    { key: 'vendor3', email: 'vendor3@jovitest.cm', name: 'Bafoussam Home Goods', defaultAgency: 'agency2', autoRedirect: true },
    { key: 'vendor4', email: 'vendor4@jovitest.cm', name: 'Kribi Traders', defaultAgency: 'agency5', autoRedirect: false },
  ];

  const result: Record<string, VendorFixture> = {};
  for (const s of specs) {
    const user = await createUser(s.email, 'vendor', passwordHash);
    const doc = await VendorModel.create({
      user_id: user._id,
      business_name: s.name,
      display_name: s.name,
      business_description: `${s.name} — COD seed test vendor.`,
      country: 'CM',
      email: `${EMAIL_PREFIX}${s.email}`,
      phone: `+2376${Math.floor(90000000 + Math.random() * 9000000)}`,
      email_verified: true,
      phone_verified: true,
      default_delivery_agency_id: agencies[s.defaultAgency].doc._id,
      status: 'active',
      onboarding_step: 0,
    });
    await vendorSettingsRepo.setAutoRedirectOrdersToAgency(doc._id.toString(), s.autoRedirect);
    result[s.key] = { key: s.key, user, doc: doc as any };
    log(`   ✅ ${s.name}  defaultAgency=${s.defaultAgency}  autoRedirect=${s.autoRedirect}  login=${EMAIL_PREFIX}${s.email}`);
  }
  return result;
}

interface ProductFixture {
  productId: mongoose.Types.ObjectId;
  variantId: mongoose.Types.ObjectId;
  sku: string;
  title: string;
  price: number;
  vendorId: mongoose.Types.ObjectId;
  productType: 'physical' | 'digital';
}

async function createProduct(opts: {
  vendor: VendorFixture;
  title: string;
  slug: string;
  price: number;
  type: 'physical' | 'digital';
  agencyOverride?: mongoose.Types.ObjectId | null;
}): Promise<ProductFixture> {
  const product = await ProductModel.create({
    vendorId: opts.vendor.doc._id,
    type: opts.type,
    status: 'active',
    title: opts.title,
    description: `${opts.title} — COD seed test product.`,
    slug: `${EMAIL_PREFIX}${opts.slug}`,
    category: opts.type === 'digital' ? 'Digital Goods' : 'General',
    tags: ['cod-seed'],
    seo: { title: opts.title, description: opts.title },
    hasVariants: false,
    ...(opts.type === 'physical'
      ? { delivery: { agency_id: opts.agencyOverride ?? null, free_delivery: false, pickup_location: { source: 'agency_storage', vendor_address_id: null } } }
      : { digitalConfig: { isActive: true } }),
  });

  const sku = `${opts.slug.toUpperCase()}-001`;
  const variant = await ProductVariantModel.create({
    productId: product._id,
    sku,
    name: 'Default',
    status: 'active',
    optionSignature: 'default',
    price: opts.price,
    stock: opts.type === 'digital' ? 0 : 100,
    isInfiniteStock: opts.type === 'digital',
    allow_oversell: opts.type === 'digital',
    ...(opts.type === 'digital' ? { digitalConfig: { maxDownloads: 5, expiresAfterDays: 365 } } : {}),
  });

  product.defaultVariantId = variant._id;
  await product.save();

  return {
    productId: product._id,
    variantId: variant._id,
    sku,
    title: opts.title,
    price: opts.price,
    vendorId: opts.vendor.doc._id,
    productType: opts.type,
  };
}

async function createProducts(vendors: Record<string, VendorFixture>, agencies: Record<string, AgencyFixture>) {
  section('Creating product catalog');
  const products = {
    prodA: await createProduct({ vendor: vendors.vendor1, title: 'Insulated Cooler Box', slug: 'cooler-box', price: 8000, type: 'physical', agencyOverride: agencies.agency1.doc._id }),
    prodB: await createProduct({ vendor: vendors.vendor1, title: 'Solar Lantern', slug: 'solar-lantern', price: 12000, type: 'physical', agencyOverride: agencies.agency2.doc._id }),
    prodC: await createProduct({ vendor: vendors.vendor1, title: 'Camping Stove', slug: 'camping-stove', price: 9000, type: 'physical', agencyOverride: agencies.agency3.doc._id }),
    prodD: await createProduct({ vendor: vendors.vendor1, title: 'Portable Generator', slug: 'portable-generator', price: 15000, type: 'physical', agencyOverride: null }), // falls back to vendor1 default = agency4

    prodE: await createProduct({ vendor: vendors.vendor2, title: 'Kitchen Knife Set', slug: 'knife-set', price: 6000, type: 'physical', agencyOverride: null }), // vendor2 default = agency1
    prodF: await createProduct({ vendor: vendors.vendor2, title: 'Non-stick Pan', slug: 'nonstick-pan', price: 7000, type: 'physical', agencyOverride: null }), // vendor2 default = agency1

    prodG: await createProduct({ vendor: vendors.vendor3, title: 'Ceramic Dinner Set', slug: 'dinner-set', price: 18000, type: 'physical', agencyOverride: null }), // vendor3 default = agency2, under its 50000 cap
    prodH: await createProduct({ vendor: vendors.vendor3, title: 'Premium Sofa Set', slug: 'sofa-set', price: 60000, type: 'physical', agencyOverride: null }), // over agency2's 50000 cap

    prodI: await createProduct({ vendor: vendors.vendor4, title: 'Fishing Gear Set', slug: 'fishing-gear', price: 5000, type: 'physical', agencyOverride: null }), // vendor4 default = agency5 (COD disabled)
    prodJ: await createProduct({ vendor: vendors.vendor4, title: 'Digital Recipe eBook', slug: 'recipe-ebook', price: 4000, type: 'digital' }),
  };
  for (const [key, p] of Object.entries(products)) {
    log(`   ✅ ${key}: ${p.title} — ${p.price} ${CURRENCY} (${p.productType})`);
  }
  return products;
}

async function createCustomers(passwordHash: string) {
  section('Creating 4 customers');
  const specs = [
    { key: 'amina', email: 'customer-amina@jovitest.cm', name: 'Amina Njoya', city: 'Douala' },
    { key: 'jean', email: 'customer-jean@jovitest.cm', name: 'Jean Talla', city: 'Yaoundé' },
    { key: 'grace', email: 'customer-grace@jovitest.cm', name: 'Grace Fondzenyuy', city: 'Bafoussam' },
    { key: 'paul', email: 'customer-paul@jovitest.cm', name: 'Paul Etoundi', city: 'Kribi' },
  ];
  const result: Record<string, { user: any; doc: any }> = {};
  for (const s of specs) {
    const user = await createUser(s.email, 'customer', passwordHash);
    const doc = await CustomerModel.create({
      user_id: user._id,
      email: `${EMAIL_PREFIX}${s.email}`,
      email_verified: true,
      phone: `+2376${Math.floor(90000000 + Math.random() * 9000000)}`,
      phone_verified: true,
      name: s.name,
      saved_addresses: [{ label: 'Home', address_line1: '12 Rue Principale', city: s.city, country: 'CM', is_default: true }],
      status: 'active',
    });
    result[s.key] = { user, doc };
    log(`   ✅ ${s.name}  login=${EMAIL_PREFIX}${s.email}`);
  }
  return result;
}

async function createAdmin(passwordHash: string) {
  section('Creating 1 admin (used to confirm remittances)');
  const user = await createUser('admin@jovitest.cm', 'admin', passwordHash);
  const doc = await AdminModel.create({ user_id: user._id, name: 'COD Seed Admin' });
  log(`   ✅ COD Seed Admin  login=${EMAIL_PREFIX}admin@jovitest.cm`);
  return { user, doc };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cart / checkout helpers
// ─────────────────────────────────────────────────────────────────────────────
async function setCart(customerId: string, productType: 'physical' | 'digital', items: Array<{ p: ProductFixture; qty: number }>) {
  await CartModel.findOneAndReplace(
    { userId: customerId },
    {
      userId: customerId,
      productType,
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
}

/** Checkout wrapper: returns the created order on success, or null (logged) on the expected rejection. */
async function attemptCheckout(
  label: string,
  customerId: string,
  productType: 'physical' | 'digital',
  items: Array<{ p: ProductFixture; qty: number }>,
  paymentMethod: 'online' | 'cash_on_delivery',
  expectRejection = false
): Promise<IOrder | null> {
  await setCart(customerId, productType, items);
  try {
    const { orders } = await orderService.createOrdersFromCart(customerId, paymentMethod);
    const order = orders[0];
    if (expectRejection) {
      log(`   ⚠️  ${label}: expected a rejection but checkout SUCCEEDED (order ${order.order_number}) — check test data.`);
    } else {
      log(`   ✅ ${label}: order ${order.order_number} created (${order._id}) — total ${order.total_amount} ${order.currency}, paymentMethod=${order.payment_method}`);
    }
    return order;
  } catch (err: any) {
    if (expectRejection) {
      log(`   ✅ ${label}: correctly rejected — ${err.code ?? err.message}`);
    } else {
      log(`   ❌ ${label}: unexpected failure — ${err.code ?? err.message}`);
    }
    return null;
  }
}

/** Assign an agent to a shipment then mark it picked_up — creates the CashCollection. Returns the plaintext code. */
async function assignAndPickUp(
  agency: AgencyFixture,
  shipment: IShipment,
  agent: AgentFixture
): Promise<{ code: string; collectionId: string; expectedAmount: number }> {
  await shipmentService.assignAgent(agency.doc._id.toString(), (shipment._id as any).toString(), agent.doc._id.toString());
  await shipmentService.updateStatus(agency.doc._id.toString(), (shipment._id as any).toString(), 'picked_up', agency.user._id.toString());

  const collection = await CashCollectionModel.findOne({ shipment_id: shipment._id }).select('+code_plain');
  if (!collection || !collection.code_plain) {
    throw new Error(`No cash collection / plaintext code found for shipment ${shipment._id}`);
  }
  return { code: collection.code_plain, collectionId: collection._id.toString(), expectedAmount: collection.expected_amount };
}

async function findShipmentForAgency(orderId: mongoose.Types.ObjectId, agencyId: mongoose.Types.ObjectId): Promise<IShipment> {
  const shipment = await ShipmentModel.findOne({ order_id: orderId, agency_id: agencyId });
  if (!shipment) throw new Error(`No shipment found for order ${orderId} / agency ${agencyId}`);
  return shipment;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const cleanOnly = process.argv.includes('--clean');

  await mongoose.connect(MONGO_URI);
  log(`✅ Connected to MongoDB (${MONGO_URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);

  await cleanup();
  if (cleanOnly) {
    log('\n✨ Clean complete (--clean). No data seeded.');
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  const agencies = await createAgencies(passwordHash);
  const agents = await createAgents(passwordHash, agencies);
  const vendors = await createVendors(passwordHash, agencies);
  const products = await createProducts(vendors, agencies);
  const customers = await createCustomers(passwordHash);
  const admin = await createAdmin(passwordHash);

  const codeBook: Array<{ label: string; shipmentId: string; agent: string; code: string; amount: number }> = [];

  // ── O1: MULTI-AGENCY showcase — 1 order, 4 items, 4 shipments, 4 different agencies ──
  section('O1 — Multi-agency COD order (vendor1, auto-redirect ON) — 4 shipments across 4 agencies');
  const o1 = await attemptCheckout(
    'O1 (Amina @ vendor1: cooler+lantern+stove+generator)',
    customers.amina.doc._id.toString(),
    'physical',
    [
      { p: products.prodA, qty: 1 }, // → agency1
      { p: products.prodB, qty: 1 }, // → agency2
      { p: products.prodC, qty: 1 }, // → agency3
      { p: products.prodD, qty: 1 }, // → agency4 (vendor default)
    ],
    'cash_on_delivery'
  );

  if (o1) {
    const o1Shipments = await ShipmentModel.find({ order_id: o1._id });
    log(`   📦 ${o1Shipments.length} shipments created, auto-dispatched to 'assigned' (vendor1.autoRedirect=true):`);
    for (const s of o1Shipments) {
      const agencyKey = Object.keys(agencies).find((k) => agencies[k].doc._id.equals(s.agency_id));
      log(`      shipment ${s._id}  → ${agencyKey} (${s.status})`);
    }

    // agency1 shipment: assign agent1, pick up, LEAVE code visible for manual collect testing.
    const shipA1 = await findShipmentForAgency(o1._id as any, agencies.agency1.doc._id);
    const codeA1 = await assignAndPickUp(agencies.agency1, shipA1, agents.agent1);
    codeBook.push({ label: 'O1/agency1 (Insulated Cooler Box, 8000 XAF)', shipmentId: (shipA1._id as any).toString(), agent: 'agent1', code: codeA1.code, amount: codeA1.expectedAmount });
    log(`   🔑 agency1 shipment picked up by agent1 — delivery code ${codeA1.code} (LEFT UNCOLLECTED for manual testing)`);

    // agency2 shipment: assign agent2, pick up, then actually COLLECT (feeds the confirmed remittance chain below).
    const shipA2 = await findShipmentForAgency(o1._id as any, agencies.agency2.doc._id);
    const codeA2 = await assignAndPickUp(agencies.agency2, shipA2, agents.agent2);
    await cashCollectionService.collect(agents.agent2.doc._id.toString(), agents.agent2.user._id.toString(), (shipA2._id as any).toString(), {
      code: codeA2.code,
      location: { lat: 3.8667, lng: 11.5167 },
      deviceInfo: 'SeedScript/1.0 (Simulated Agent Device)',
    });
    log(`   💰 agency2 shipment collected by agent2 — ${codeA2.expectedAmount} ${CURRENCY} added to agent2's cash balance`);

    // agency3 (low-trust agent3) and agency4 (low-exposure agent4) shipments are LEFT UNTOUCHED
    // ('assigned', no agent) — deliberate manual negative-test surfaces, see summary below.
  }

  // ── O2: fresh COD order left 100% untouched — full manual walkthrough ──
  section('O2 — Fresh COD order (vendor2, auto-redirect OFF) — left fully untouched for manual walkthrough');
  await attemptCheckout(
    'O2 (Jean @ vendor2: kitchen knife set)',
    customers.jean.doc._id.toString(),
    'physical',
    [{ p: products.prodE, qty: 1 }],
    'cash_on_delivery'
  );
  log('   ⏸️  Shipment stays "pending" — dispatch/assign/pickup/collect all left for manual API testing.');

  // ── O3: legit COD order under agency2's cap — collected, feeds the confirmed chain ──
  section('O3 — COD order under agency2\'s cap (vendor3, auto-redirect ON) — collected');
  const o3 = await attemptCheckout(
    'O3 (Grace @ vendor3: ceramic dinner set, 18000 XAF, cap is 50000)',
    customers.grace.doc._id.toString(),
    'physical',
    [{ p: products.prodG, qty: 1 }],
    'cash_on_delivery'
  );
  let agent2Collected = 0;
  if (o3) {
    const shipO3 = await findShipmentForAgency(o3._id as any, agencies.agency2.doc._id);
    const codeO3 = await assignAndPickUp(agencies.agency2, shipO3, agents.agent2);
    await cashCollectionService.collect(agents.agent2.doc._id.toString(), agents.agent2.user._id.toString(), (shipO3._id as any).toString(), {
      code: codeO3.code,
      location: { lat: 5.4781, lng: 10.4179 },
      deviceInfo: 'SeedScript/1.0 (Simulated Agent Device)',
    });
    agent2Collected = codeO3.expectedAmount;
    log(`   💰 Collected by agent2 — ${codeO3.expectedAmount} ${CURRENCY} added to agent2's cash balance`);
  }

  // ── O4: NEGATIVE — order total exceeds agency2's COD cap ──
  section('O4 — NEGATIVE: order total exceeds agency2\'s 50000 XAF cap');
  await attemptCheckout(
    'O4 (Paul @ vendor3: premium sofa set, 60000 XAF)',
    customers.paul.doc._id.toString(),
    'physical',
    [{ p: products.prodH, qty: 1 }],
    'cash_on_delivery',
    true
  );

  // ── O5: NEGATIVE — vendor4's default agency (agency5) has COD disabled ──
  section('O5 — NEGATIVE: vendor4\'s delivery agency does not support COD');
  await attemptCheckout(
    'O5 (Paul @ vendor4: fishing gear set)',
    customers.paul.doc._id.toString(),
    'physical',
    [{ p: products.prodI, qty: 1 }],
    'cash_on_delivery',
    true
  );

  // ── O6: NEGATIVE — digital cart cannot be COD ──
  section('O6 — NEGATIVE: digital product cannot be cash-on-delivery');
  await attemptCheckout(
    'O6 (Paul @ vendor4: digital recipe eBook)',
    customers.paul.doc._id.toString(),
    'digital',
    [{ p: products.prodJ, qty: 1 }],
    'cash_on_delivery',
    true
  );

  // ── O7: plain ONLINE order for contrast (same vendor4 physical product) ──
  section('O7 — Plain ONLINE order for contrast (vendor4, same physical product)');
  await attemptCheckout(
    'O7 (Amina @ vendor4: fishing gear set, ONLINE)',
    customers.amina.doc._id.toString(),
    'physical',
    [{ p: products.prodI, qty: 1 }],
    'online'
  );

  // ── O8: COD order → collected → deposited → remittance DECLARED (left unconfirmed) → discrepancy raised ──
  section('O8 — vendor2/agency1 chain: collect → deposit → remittance DECLARED (unconfirmed) → discrepancy');
  const o8 = await attemptCheckout(
    'O8 (Jean @ vendor2: non-stick pan, 2nd checkout)',
    customers.jean.doc._id.toString(),
    'physical',
    [{ p: products.prodF, qty: 1 }],
    'cash_on_delivery'
  );
  if (o8) {
    await orderService.dispatchToAgency((o8._id as any).toString(), { type: 'vendor', id: vendors.vendor2.user._id.toString() });
    const shipO8 = await findShipmentForAgency(o8._id as any, agencies.agency1.doc._id);
    const codeO8 = await assignAndPickUp(agencies.agency1, shipO8, agents.agent1);
    await cashCollectionService.collect(agents.agent1.doc._id.toString(), agents.agent1.user._id.toString(), (shipO8._id as any).toString(), {
      code: codeO8.code,
      location: { lat: 4.0511, lng: 9.7679 },
      deviceInfo: 'SeedScript/1.0 (Simulated Agent Device)',
    });
    log(`   💰 Collected by agent1 — ${codeO8.expectedAmount} ${CURRENCY} added to agent1's cash balance`);

    const agent1Balance = await codCashAccountService.getBalance('agent', agents.agent1.doc._id.toString());
    await agentDepositService.record({
      agencyId: agencies.agency1.doc._id.toString(),
      agentId: agents.agent1.doc._id.toString(),
      amount: agent1Balance.balance,
      note: 'Seed: full cash hand-over',
      recordedByUserId: agencies.agency1.user._id.toString(),
    });
    log(`   🏦 agency1 recorded a deposit of ${agent1Balance.balance} ${CURRENCY} from agent1 (agent1 balance → 0)`);

    const agency1Liability = await codCashAccountService.getBalance('agency', agencies.agency1.doc._id.toString());
    const remittance = await agencyRemittanceService.declare({
      agencyId: agencies.agency1.doc._id.toString(),
      amount: agency1Liability.balance,
      reference: 'BANKTX-SEED-AGENCY1-001',
      note: 'Seed: weekly settlement',
      declaredByUserId: agencies.agency1.user._id.toString(),
    });
    log(`   📤 agency1 DECLARED remittance ${remittance._id} for ${agency1Liability.balance} ${CURRENCY} — LEFT UNCONFIRMED for manual admin testing`);
    log(`      → POST /api/admin/cod/remittances/${remittance._id}/confirm  (as ${EMAIL_PREFIX}admin@jovitest.cm)`);

    const discrepancy = await codDiscrepancyService.raiseByAgency({
      agencyId: agencies.agency1.doc._id.toString(),
      agentId: agents.agent1.doc._id.toString(),
      type: 'cash_shortfall',
      amount: 500,
      note: 'Seed: illustrative shortfall for admin-resolution testing',
      raisedByUserId: agencies.agency1.user._id.toString(),
    });
    log(`   🚩 Raised cash_shortfall discrepancy ${discrepancy._id} on agent1 (trust penalty applied: 100 → 80)`);
    log(`      → POST /api/admin/cod/discrepancies/${discrepancy._id}/resolve  (as ${EMAIL_PREFIX}admin@jovitest.cm)`);
    log(`      → New COD assignments to agent1 are now BLOCKED until this is resolved (COD_AGENT_TRUST_TOO_LOW).`);
  }

  // ── agency2 CONFIRMED chain: deposit + declare + CONFIRM → shows a fully settled remittance ──
  section('agency2 chain: collect (O1+O3) → deposit → remittance DECLARED and CONFIRMED (fully settled)');
  const agent2Balance = await codCashAccountService.getBalance('agent', agents.agent2.doc._id.toString());
  await agentDepositService.record({
    agencyId: agencies.agency2.doc._id.toString(),
    agentId: agents.agent2.doc._id.toString(),
    amount: agent2Balance.balance,
    note: 'Seed: full cash hand-over (O1 + O3 combined)',
    recordedByUserId: agencies.agency2.user._id.toString(),
  });
  log(`   🏦 agency2 recorded a deposit of ${agent2Balance.balance} ${CURRENCY} from agent2 (agent1 balance → 0)`);

  const agency2Liability = await codCashAccountService.getBalance('agency', agencies.agency2.doc._id.toString());
  const remittance2 = await agencyRemittanceService.declare({
    agencyId: agencies.agency2.doc._id.toString(),
    amount: agency2Liability.balance,
    reference: 'BANKTX-SEED-AGENCY2-001',
    note: 'Seed: weekly settlement',
    declaredByUserId: agencies.agency2.user._id.toString(),
  });
  const confirmResult = await agencyRemittanceService.confirm(remittance2._id.toString(), admin.user._id.toString());
  log(`   ✅ agency2 remittance ${remittance2._id} for ${agency2Liability.balance} ${CURRENCY} DECLARED and CONFIRMED`);
  log(`      → FIFO-settled ${confirmResult.settledCollectionIds.length} collection(s): ${confirmResult.settledCollectionIds.join(', ')}`);
  log(`      → Those collections' earnings allocations now have cash_settled_at set — eligible for release once the hold window (7 days) elapses.`);

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  section('SUMMARY');
  log(`\nAll seeded accounts share the password:  ${SEED_PASSWORD}\n`);

  log('AGENCIES:');
  for (const key of Object.keys(agencies)) {
    log(`  ${key.padEnd(8)} ${agencies[key].doc.agency_name.padEnd(28)} login=${EMAIL_PREFIX}${key}@jovitest.cm`);
  }

  log('\nAGENTS:');
  for (const key of Object.keys(agents)) {
    const a = agents[key].doc;
    log(`  ${key.padEnd(8)} trust=${(a.cod?.trust_score ?? 100).toString().padEnd(4)} agency=${(a.agency_id ?? 'UNLINKED').toString().padEnd(26)} login=${EMAIL_PREFIX}${key}@jovitest.cm`);
  }

  log('\nVENDORS:');
  for (const key of Object.keys(vendors)) {
    log(`  ${key.padEnd(8)} ${vendors[key].doc.business_name.padEnd(28)} login=${EMAIL_PREFIX}${key}@jovitest.cm`);
  }

  log('\nCUSTOMERS:');
  for (const key of Object.keys(customers)) {
    log(`  ${key.padEnd(8)} login=${EMAIL_PREFIX}customer-${key}@jovitest.cm`);
  }

  log(`\nADMIN:  login=${EMAIL_PREFIX}admin@jovitest.cm`);

  log('\n📋 MANUAL TEST SURFACES:');
  log('  1. Collect cash with a visible delivery code:');
  for (const c of codeBook) {
    log(`     ${c.label}`);
    log(`       POST /api/agent/shipments/${c.shipmentId}/cod/collect  (as ${c.agent})  body: { "code": "${c.code}" }  → expect ${c.amount} ${CURRENCY} collected`);
  }
  log('  2. Negative test — assign agent3 (trust 35) to O1\'s agency3 shipment → expect COD_AGENT_TRUST_TOO_LOW:');
  log(`     PATCH /api/agency/shipments/:id/assign-agent  (as agency3)  body: { "agentId": "${agents.agent3.doc._id}" }`);
  log('  3. Negative test — assign agent4 (10000 XAF cap) to O1\'s agency4 shipment (15000 XAF) → expect COD_AGENT_EXPOSURE_EXCEEDED:');
  log(`     PATCH /api/agency/shipments/:id/assign-agent  (as agency4)  body: { "agentId": "${agents.agent4.doc._id}" }`);
  log('  4. Fully manual order (O2, vendor2) — dispatch, assign, pick up, collect from scratch as vendor2 → agency1 → agent1.');
  log('  5. Accept/decline the pending invite as agent6: GET /api/agent/invites, POST /api/agent/invites/:id/accept.');
  log('  6. Confirm the pending remittance and resolve the discrepancy from O8 (see above), as admin.');
  log('  7. Run the earnings sweep manually (e.g. from a REPL) to observe release timing:');
  log('       earningsReleaseWorker.runSweep(new Date(Date.now() + 8*86400000))');

  log('\n✨ Done.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\n❌ Seed failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
