// seed-orders.js — MongoDB order mock data for testing all order scenarios
// Usage: mongosh "mongodb://localhost:27017/jovi_mall" seed-orders.js
// Or:    mongosh "mongodb+srv://..." seed-orders.js

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const now = new Date("2026-05-14T10:00:00.000Z");
const d = (offsetDays) => new Date(now.getTime() + offsetDays * 86400000);

// ─── ID REGISTRY ─────────────────────────────────────────────────────────────
const U = {
  vendorUser:  ObjectId("a00000000000000000000001"),
  custUser1:   ObjectId("a00000000000000000000002"),
  custUser2:   ObjectId("a00000000000000000000003"),
  custUser3:   ObjectId("a00000000000000000000004"),
  agencyUser:  ObjectId("a00000000000000000000005"),
  agentUser1:  ObjectId("a00000000000000000000006"),
  agentUser2:  ObjectId("a00000000000000000000007"),

  vendor1:     ObjectId("b00000000000000000000001"),
  cust1:       ObjectId("b00000000000000000000002"),
  cust2:       ObjectId("b00000000000000000000003"),
  cust3:       ObjectId("b00000000000000000000004"),
  agency1:     ObjectId("b00000000000000000000005"),
  agent1:      ObjectId("b00000000000000000000006"),
  agent2:      ObjectId("b00000000000000000000007"),

  physProd1:   ObjectId("c00000000000000000000001"), // T-Shirt
  physProd2:   ObjectId("c00000000000000000000002"), // Headphones
  digProd1:    ObjectId("c00000000000000000000003"), // eBook
  digProd2:    ObjectId("c00000000000000000000004"), // Software License

  physVar1a:   ObjectId("d00000000000000000000001"), // T-Shirt L/Black
  physVar1b:   ObjectId("d00000000000000000000002"), // T-Shirt M/White
  physVar2a:   ObjectId("d00000000000000000000003"), // Headphones
  digVar1:     ObjectId("d00000000000000000000004"), // eBook default
  digVar2:     ObjectId("d00000000000000000000005"), // Software License default

  asset1:      ObjectId("e00000000000000000000001"),
  asset2:      ObjectId("e00000000000000000000002"),

  // 17 orders
  ord1:        ObjectId("f00000000000000000000001"), // physical, pending payment
  ord2:        ObjectId("f00000000000000000000002"), // physical, AWAITING_PAYMENT
  ord3:        ObjectId("f00000000000000000000003"), // physical, payment failed
  ord4:        ObjectId("f00000000000000000000004"), // physical, paid+processing, agency only (no agent)
  ord5:        ObjectId("f00000000000000000000005"), // physical, paid+processing, agency+agent assigned
  ord6:        ObjectId("f00000000000000000000006"), // physical, paid+shipped (in_transit)
  ord7:        ObjectId("f00000000000000000000007"), // physical, paid+delivered
  ord8:        ObjectId("f00000000000000000000008"), // physical, cancelled before payment
  ord9:        ObjectId("f00000000000000000000009"), // physical, paid then cancelled
  ord10:       ObjectId("f00000000000000000000010"), // physical, refunded
  ord11:       ObjectId("f00000000000000000000011"), // digital, pending payment
  ord12:       ObjectId("f00000000000000000000012"), // digital, paid+fulfilled, active entitlement
  ord13:       ObjectId("f00000000000000000000013"), // digital, paid+fulfilled, revoked entitlement
  ord14:       ObjectId("f00000000000000000000014"), // digital, paid+fulfilled, download limit reached
  ord15:       ObjectId("f00000000000000000000015"), // physical multi-item, paid+processing, agency+agent
  ord16:       ObjectId("f00000000000000000000016"), // physical, paid+processing, agency only (no agent yet)
  ord17:       ObjectId("f00000000000000000000017"), // digital multi-item, paid+fulfilled, 2 entitlements

  // Shipments (physical orders only)
  ship1:       ObjectId("1f0000000000000000000001"), // ord4: pending, no agent
  ship2:       ObjectId("1f0000000000000000000002"), // ord5: assigned, with agent
  ship3:       ObjectId("1f0000000000000000000003"), // ord6: in_transit
  ship4:       ObjectId("1f0000000000000000000004"), // ord7: delivered
  ship5:       ObjectId("1f0000000000000000000005"), // ord9: returned (cancelled after paid)
  ship6:       ObjectId("1f0000000000000000000006"), // ord10: returned (refunded)
  ship7:       ObjectId("1f0000000000000000000007"), // ord15: assigned (multi-item)
  ship8:       ObjectId("1f0000000000000000000008"), // ord16: pending, no agent

  // Payment transactions
  pay1:        ObjectId("2e0000000000000000000001"), // ord2: PENDING (awaiting)
  pay2:        ObjectId("2e0000000000000000000002"), // ord3: FAILED
  pay3:        ObjectId("2e0000000000000000000003"), // ord4: SUCCEEDED
  pay4:        ObjectId("2e0000000000000000000004"), // ord5: SUCCEEDED
  pay5:        ObjectId("2e0000000000000000000005"), // ord6: SUCCEEDED
  pay6:        ObjectId("2e0000000000000000000006"), // ord7: SUCCEEDED
  pay7:        ObjectId("2e0000000000000000000007"), // ord9: SUCCEEDED (later cancelled)
  pay8:        ObjectId("2e0000000000000000000008"), // ord10: REFUNDED
  pay9:        ObjectId("2e0000000000000000000009"), // ord12: SUCCEEDED
  pay10:       ObjectId("2e000000000000000000000a"), // ord13: SUCCEEDED
  pay11:       ObjectId("2e000000000000000000000b"), // ord14: SUCCEEDED
  pay12:       ObjectId("2e000000000000000000000c"), // ord15: SUCCEEDED
  pay13:       ObjectId("2e000000000000000000000d"), // ord16: SUCCEEDED
  pay14:       ObjectId("2e000000000000000000000e"), // ord17: SUCCEEDED

  ref1:        ObjectId("3d0000000000000000000001"), // refund for ord10

  ent1:        ObjectId("4c0000000000000000000001"), // ord12, active
  ent2:        ObjectId("4c0000000000000000000002"), // ord13, revoked
  ent3:        ObjectId("4c0000000000000000000003"), // ord14, download limit hit
  ent4:        ObjectId("4c0000000000000000000004"), // ord17 item1
  ent5:        ObjectId("4c0000000000000000000005"), // ord17 item2
};

// ─── 1. USERS ─────────────────────────────────────────────────────────────────
print("Inserting users...");
db.users.insertMany([
  { _id: U.vendorUser, login_email: "vendor@jovitest.cm",  password_hash: "$2b$10$testhash_vendor", roles: ["vendor"],   status: "active", created_at: d(-60), updated_at: d(-1) },
  { _id: U.custUser1,  login_email: "alice@jovitest.cm",   password_hash: "$2b$10$testhash_alice",  roles: ["customer"], status: "active", created_at: d(-30), updated_at: d(-1) },
  { _id: U.custUser2,  login_email: "bob@jovitest.cm",     password_hash: "$2b$10$testhash_bob",    roles: ["customer"], status: "active", created_at: d(-25), updated_at: d(-1) },
  { _id: U.custUser3,  login_phone: "+237670000004",        password_hash: "$2b$10$testhash_carol",  roles: ["customer"], status: "active", created_at: d(-20), updated_at: d(-1) },
  { _id: U.agencyUser, login_email: "agency@jovitest.cm",  password_hash: "$2b$10$testhash_agency", roles: ["agency"],   status: "active", created_at: d(-90), updated_at: d(-1) },
  { _id: U.agentUser1, login_phone: "+237670000006",        password_hash: "$2b$10$testhash_agent1", roles: ["agent"],    status: "active", created_at: d(-60), updated_at: d(-1) },
  { _id: U.agentUser2, login_phone: "+237670000007",        password_hash: "$2b$10$testhash_agent2", roles: ["agent"],    status: "active", created_at: d(-55), updated_at: d(-1) },
]);

// ─── 2. VENDOR ────────────────────────────────────────────────────────────────
print("Inserting vendor...");
db.vendors.insertOne({
  _id: U.vendor1,
  user_id: U.vendorUser,
  business_name: "TechStyle Cameroon",
  display_name: "TechStyle",
  business_description: "Electronics and lifestyle products shipped across Cameroon.",
  country: "CM",
  email: "vendor@jovitest.cm",
  phone: "+237699000001",
  email_verified: true,
  phone_verified: true,
  default_delivery_agency_id: U.agency1,
  status: "active",
  timezone: "Africa/Douala",
  legit_verified: true,
  kyc_details: { national_id_number: "CM123456789", legit_verified: true },
  branding: { logo_url: null, cover_image_url: null },
  business_addresses: [{ label: "HQ", address_line1: "Rue de la Joie 12", city: "Douala" }],
  policies: {
    return_policy: { refund_type: "full" },
    cancellation_policy: { cancellation_fee_type: "none" },
    support_policy: { channels: [{ type: "email" }, { type: "whatsapp" }] },
  },
  onboarding_step: 5,
  version: 3,
  created_at: d(-60),
  updated_at: d(-1),
});

// ─── 3. CUSTOMERS ─────────────────────────────────────────────────────────────
print("Inserting customers...");
db.customers.insertMany([
  {
    _id: U.cust1, user_id: U.custUser1, email: "alice@jovitest.cm",
    email_verified: true, phone: "+237670000002", phone_verified: false,
    name: "Alice Mbarga",
    saved_addresses: [{ label: "Home", address_line1: "Bvd de la République 45", city: "Douala", country: "CM", is_default: true, location: null }],
    preferences: { language: "fr", currency: "XAF", marketing_opt_in: true, ai_tone: [], ads_compact_mode: false, compact_mode: false },
    timezone: "Africa/Douala", status: "active", onboarding_step: 0, wa: { verified: false },
    created_at: d(-30), updated_at: d(-1),
  },
  {
    _id: U.cust2, user_id: U.custUser2, email: "bob@jovitest.cm",
    email_verified: true, phone: "+237670000003", phone_verified: true,
    name: "Bob Nkeng",
    saved_addresses: [{ label: "Office", address_line1: "Akwa Nord 8", city: "Douala", country: "CM", is_default: true, location: null }],
    preferences: { language: "en", currency: "XAF", marketing_opt_in: false, ai_tone: [], ads_compact_mode: false, compact_mode: false },
    timezone: "Africa/Douala", status: "active", onboarding_step: 0, wa: { verified: true },
    created_at: d(-25), updated_at: d(-1),
  },
  {
    _id: U.cust3, user_id: U.custUser3, phone: "+237670000004", phone_verified: true,
    name: "Carol Tagne",
    saved_addresses: [{ label: "Home", address_line1: "Ngousso 22", city: "Yaoundé", country: "CM", is_default: true, location: null }],
    preferences: { language: "fr", currency: "XAF", marketing_opt_in: true, ai_tone: [], ads_compact_mode: false, compact_mode: false },
    timezone: "Africa/Douala", status: "active", onboarding_step: 0, wa: { verified: false },
    created_at: d(-20), updated_at: d(-1),
  },
]);

// ─── 4. DELIVERY AGENCY ───────────────────────────────────────────────────────
print("Inserting delivery agency...");
db.deliveryagencies.insertOne({
  _id: U.agency1,
  user_id: U.agencyUser,
  email: "agency@jovitest.cm",
  email_verified: true,
  phone: "+237699000010",
  phone_verified: true,
  agency_name: "Express Delivery Cameroon",
  logo_url: null,
  coverage_areas: ["Douala", "Yaoundé", "Bafoussam"],
  headquarters_addresses: [{
    region: "Littoral", city: "Douala",
    address_description: "Zone Industrielle Bassa",
    support_contact: { phone: "+237699000010", email: "support@express-delivery.cm" },
  }],
  payout_details: [],
  kyc_details: { registration_number: "RC/DLA/2020/B/1234", transport_license_id: "TL-CM-2020-001", legit_verified: true },
  policies: {
    pricing: {
      storage_based: { enabled: true, monthly_storage_fee_per_sku: 500, pick_pack_fee_per_order: 300, local_delivery_fee: 1000, out_of_region_delivery_fee: 2500 },
      pickup_based: { base_rate_first_kg: 800, additional_per_kg: 200, out_of_region_surcharge: 1500 },
      additional_fees: { cod_handling_fee: { type: "percentage", value: 2 }, failed_delivery_fee: 500, rto_fee: 1000 },
    },
    returns: { payer: "vendor", handling_fee: 500, return_window_days: 7 },
    damage: { claim_deadline_days: 3, max_refund_per_item: 50000, inspector: "admin", investigation_fee: 1000 },
  },
  status: "active",
  timezone: "Africa/Douala",
  onboarding_step: 5,
  version: 1,
  created_at: d(-90), updated_at: d(-1),
});

// ─── 5. DELIVERY AGENTS ───────────────────────────────────────────────────────
print("Inserting delivery agents...");
db.deliveryagents.insertMany([
  {
    _id: U.agent1, user_id: U.agentUser1, agency_id: U.agency1, name: "Pierre Ekang",
    avatar_url: null,
    vehicle_info: { vehicle_type: "bike", plate_number: "LT-1234-A", color: "Red" },
    legal_identity: { drivers_license_number: "DL-CM-001", national_id_number: "CNI-001" },
    emergency_contact: { name: "Marie Ekang", phone: "+237670111001" },
    live_state: { last_known_location: null, current_capacity_status: "available" },
    status: "active", timezone: "Africa/Douala", onboarding_step: 3,
    created_at: d(-60), updated_at: d(-1),
  },
  {
    _id: U.agent2, user_id: U.agentUser2, agency_id: U.agency1, name: "Samuel Biya",
    avatar_url: null,
    vehicle_info: { vehicle_type: "car", plate_number: "LT-5678-B", color: "White" },
    legal_identity: { drivers_license_number: "DL-CM-002", national_id_number: "CNI-002" },
    emergency_contact: { name: "Grace Biya", phone: "+237670111002" },
    live_state: { last_known_location: null, current_capacity_status: "busy" },
    status: "active", timezone: "Africa/Douala", onboarding_step: 3,
    created_at: d(-55), updated_at: d(-1),
  },
]);

// ─── 6. PRODUCTS ──────────────────────────────────────────────────────────────
print("Inserting products...");
db.products.insertMany([
  {
    _id: U.physProd1, vendorId: U.vendor1, type: "physical", status: "active",
    title: "Classic Cotton T-Shirt",
    description: "Premium quality 100% cotton t-shirt. Comfortable fit, machine washable.",
    slug: "classic-cotton-t-shirt", category: "Clothing",
    tags: ["t-shirt", "cotton", "fashion"],
    seo: { title: "Classic Cotton T-Shirt | TechStyle", description: "Premium cotton t-shirts" },
    hasVariants: true, defaultVariantId: U.physVar1a, fileIds: [],
    createdAt: d(-30), updatedAt: d(-5),
  },
  {
    _id: U.physProd2, vendorId: U.vendor1, type: "physical", status: "active",
    title: "Wireless Noise-Cancelling Headphones",
    description: "Studio-quality sound with active noise cancellation. 30h battery life.",
    slug: "wireless-nc-headphones", category: "Electronics",
    tags: ["headphones", "wireless", "audio"],
    seo: { title: "Wireless Headphones | TechStyle", description: "Studio-quality headphones" },
    hasVariants: false, defaultVariantId: U.physVar2a, fileIds: [],
    createdAt: d(-45), updatedAt: d(-10),
  },
  {
    _id: U.digProd1, vendorId: U.vendor1, type: "digital", status: "active",
    title: "JavaScript Mastery Guide — 2026 Edition",
    description: "Complete guide to modern JavaScript and TypeScript. 400+ pages PDF.",
    slug: "js-mastery-guide-2026", category: "E-Books",
    tags: ["javascript", "typescript", "programming"],
    seo: { title: "JS Mastery Guide | TechStyle", description: "Learn modern JavaScript" },
    hasVariants: false, defaultVariantId: U.digVar1, fileIds: [],
    digitalConfig: { assetId: U.asset1, maxDownloads: 5, expiresAfterDays: 365, isActive: true },
    createdAt: d(-20), updatedAt: d(-3),
  },
  {
    _id: U.digProd2, vendorId: U.vendor1, type: "digital", status: "active",
    title: "DesignPro Suite — 1-Year License",
    description: "Professional design suite for UI/UX. Includes all plugins. 1-year license key.",
    slug: "designpro-suite-1yr", category: "Software",
    tags: ["design", "software", "license"],
    seo: { title: "DesignPro License | TechStyle", description: "Professional design software" },
    hasVariants: false, defaultVariantId: U.digVar2, fileIds: [],
    digitalConfig: { assetId: U.asset2, maxDownloads: 3, expiresAfterDays: 365, isActive: true },
    createdAt: d(-15), updatedAt: d(-2),
  },
]);

// ─── 7. PRODUCT VARIANTS ──────────────────────────────────────────────────────
print("Inserting product variants...");
db.productvariants.insertMany([
  {
    _id: U.physVar1a, productId: U.physProd1, sku: "TSHIRT-L-BLK",
    name: "T-Shirt Large / Black", status: "active",
    optionSignature: "size:l|color:black", price: 7500, compareAtPrice: 9000,
    stock: 50, isInfiniteStock: false, low_stock_threshold: 5, allow_oversell: false,
    weight: 0.3, length: null, width: null, height: null,
    optionValueIds: [], fileIds: [], deliveryAgencyId: U.agency1,
    createdAt: d(-30), updatedAt: d(-5),
  },
  {
    _id: U.physVar1b, productId: U.physProd1, sku: "TSHIRT-M-WHT",
    name: "T-Shirt Medium / White", status: "active",
    optionSignature: "size:m|color:white", price: 7500, compareAtPrice: 9000,
    stock: 35, isInfiniteStock: false, low_stock_threshold: 5, allow_oversell: false,
    weight: 0.3, length: null, width: null, height: null,
    optionValueIds: [], fileIds: [], deliveryAgencyId: U.agency1,
    createdAt: d(-30), updatedAt: d(-5),
  },
  {
    _id: U.physVar2a, productId: U.physProd2, sku: "HDPHN-NC-BLK",
    name: "Wireless Headphones / Black", status: "active",
    optionSignature: "default", price: 45000, compareAtPrice: 55000,
    stock: 20, isInfiniteStock: false, low_stock_threshold: 3, allow_oversell: false,
    weight: 0.35, length: 22, width: 18, height: 8,
    optionValueIds: [], fileIds: [], deliveryAgencyId: U.agency1,
    createdAt: d(-45), updatedAt: d(-10),
  },
  {
    _id: U.digVar1, productId: U.digProd1, sku: "DIG-JSGUIDE-2026",
    name: "JS Mastery Guide 2026 — PDF", status: "active",
    optionSignature: "default", price: 5000, compareAtPrice: null,
    stock: 0, isInfiniteStock: true, allow_oversell: true,
    optionValueIds: [], fileIds: [],
    createdAt: d(-20), updatedAt: d(-3),
  },
  {
    _id: U.digVar2, productId: U.digProd2, sku: "DIG-DPRO-1YR",
    name: "DesignPro 1-Year License Key", status: "active",
    optionSignature: "default", price: 15000, compareAtPrice: 18000,
    stock: 0, isInfiniteStock: true, allow_oversell: true,
    optionValueIds: [], fileIds: [],
    createdAt: d(-15), updatedAt: d(-2),
  },
]);

// ─── 8. ORDERS ────────────────────────────────────────────────────────────────
// Helper: builds a physical order item with delivery sub-doc
function physItem(opts) {
  return {
    variant_id: opts.variantId,
    sku: opts.sku,
    variant_title: opts.variantTitle,
    options_snapshot: opts.optionSignature,
    product_id: opts.productId,
    title: opts.title,
    vendor_id: U.vendor1,
    product_type: "physical",
    quantity: opts.qty,
    price: opts.price,
    currency: "XAF",
    delivery: {
      agency_id: U.agency1,
      shipment_id: opts.shipmentId || null,
      status: opts.deliveryStatus || "pending",
    },
  };
}

// Helper: builds a digital order item (no delivery)
function digItem(opts) {
  return {
    variant_id: opts.variantId,
    sku: opts.sku,
    variant_title: opts.variantTitle,
    options_snapshot: "default",
    product_id: opts.productId,
    title: opts.title,
    vendor_id: U.vendor1,
    product_type: "digital",
    quantity: 1,
    price: opts.price,
    currency: "XAF",
  };
}

print("Inserting orders...");
db.orders.insertMany([

  // ── ORD-1: Physical | payment_status=pending | fulfillment=pending
  // Customer placed order but has NOT initiated payment at all
  {
    _id: U.ord1,
    order_number: "ORD-2026-000001",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      physItem({ variantId: U.physVar1a, sku: "TSHIRT-L-BLK", variantTitle: "Large / Black", optionSignature: "size:l|color:black", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 2, price: 7500, shipmentId: null, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 15000, tax: 0, discount: 0, total: 15000 },
    total_amount: 15000,
    payment_status: "pending",
    payment_intent_id: null,
    fulfillment_status: "pending",
    created_at: d(-10), updated_at: d(-10),
  },

  // ── ORD-2: Physical | payment_status=AWAITING_PAYMENT | fulfillment=pending
  // Payment initiation sent to gateway, waiting for customer to complete on mobile
  {
    _id: U.ord2,
    order_number: "ORD-2026-000002",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      physItem({ variantId: U.physVar2a, sku: "HDPHN-NC-BLK", variantTitle: "Black", optionSignature: "default", productId: U.physProd2, title: "Wireless Noise-Cancelling Headphones", qty: 1, price: 45000, shipmentId: null, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 45000, tax: 0, discount: 0, total: 45000 },
    total_amount: 45000,
    payment_status: "AWAITING_PAYMENT",
    payment_intent_id: "notchpay_txn_abc123pending",
    fulfillment_status: "pending",
    created_at: d(-8), updated_at: d(-8),
  },

  // ── ORD-3: Physical | payment_status=failed | fulfillment=pending
  // Customer attempted payment, gateway returned failure (e.g. insufficient funds)
  {
    _id: U.ord3,
    order_number: "ORD-2026-000003",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust3,
    items: [
      physItem({ variantId: U.physVar1b, sku: "TSHIRT-M-WHT", variantTitle: "Medium / White", optionSignature: "size:m|color:white", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 1, price: 7500, shipmentId: null, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 7500, tax: 0, discount: 0, total: 7500 },
    total_amount: 7500,
    payment_status: "failed",
    payment_intent_id: "notchpay_txn_xyz_failed",
    fulfillment_status: "pending",
    created_at: d(-7), updated_at: d(-7),
  },

  // ── ORD-4: Physical | paid + processing | agency assigned | NO agent yet
  // Order paid, vendor moved to processing, shipment created and assigned to agency — agent not yet dispatched
  {
    _id: U.ord4,
    order_number: "ORD-2026-000004",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      physItem({ variantId: U.physVar2a, sku: "HDPHN-NC-BLK", variantTitle: "Black", optionSignature: "default", productId: U.physProd2, title: "Wireless Noise-Cancelling Headphones", qty: 1, price: 45000, shipmentId: U.ship1, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 45000, tax: 0, discount: 2000, total: 43000 },
    total_amount: 43000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord4_success",
    fulfillment_status: "processing",
    created_at: d(-6), updated_at: d(-5),
  },

  // ── ORD-5: Physical | paid + processing | agency + agent BOTH assigned
  // Shipment status 'assigned' — agent has accepted the delivery task
  {
    _id: U.ord5,
    order_number: "ORD-2026-000005",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      physItem({ variantId: U.physVar1a, sku: "TSHIRT-L-BLK", variantTitle: "Large / Black", optionSignature: "size:l|color:black", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 3, price: 7500, shipmentId: U.ship2, deliveryStatus: "assigned" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 22500, tax: 0, discount: 0, total: 22500 },
    total_amount: 22500,
    payment_status: "paid",
    payment_intent_id: "mycoolpay_txn_ord5_success",
    fulfillment_status: "processing",
    created_at: d(-5), updated_at: d(-4),
  },

  // ── ORD-6: Physical | paid + shipped | shipment in_transit
  {
    _id: U.ord6,
    order_number: "ORD-2026-000006",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust3,
    items: [
      physItem({ variantId: U.physVar2a, sku: "HDPHN-NC-BLK", variantTitle: "Black", optionSignature: "default", productId: U.physProd2, title: "Wireless Noise-Cancelling Headphones", qty: 1, price: 45000, shipmentId: U.ship3, deliveryStatus: "in_transit" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 45000, tax: 1350, discount: 0, total: 46350 },
    total_amount: 46350,
    payment_status: "paid",
    payment_intent_id: "stripe_pi_ord6_success",
    fulfillment_status: "shipped",
    created_at: d(-9), updated_at: d(-3),
  },

  // ── ORD-7: Physical | paid + delivered | shipment delivered
  {
    _id: U.ord7,
    order_number: "ORD-2026-000007",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      physItem({ variantId: U.physVar1b, sku: "TSHIRT-M-WHT", variantTitle: "Medium / White", optionSignature: "size:m|color:white", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 1, price: 7500, shipmentId: U.ship4, deliveryStatus: "delivered" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 7500, tax: 0, discount: 500, total: 7000 },
    total_amount: 7000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord7_success",
    fulfillment_status: "delivered",
    created_at: d(-15), updated_at: d(-2),
  },

  // ── ORD-8: Physical | cancelled BEFORE payment (payment_status=pending)
  // Customer changed their mind immediately after placing the order
  {
    _id: U.ord8,
    order_number: "ORD-2026-000008",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      physItem({ variantId: U.physVar1a, sku: "TSHIRT-L-BLK", variantTitle: "Large / Black", optionSignature: "size:l|color:black", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 1, price: 7500, shipmentId: null, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 7500, tax: 0, discount: 0, total: 7500 },
    total_amount: 7500,
    payment_status: "pending",
    payment_intent_id: null,
    fulfillment_status: "cancelled",
    created_at: d(-12), updated_at: d(-12),
  },

  // ── ORD-9: Physical | paid → then CANCELLED | shipment returned
  // Vendor accepted and paid order was later cancelled (e.g. stock issue found post-payment)
  {
    _id: U.ord9,
    order_number: "ORD-2026-000009",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust3,
    items: [
      physItem({ variantId: U.physVar2a, sku: "HDPHN-NC-BLK", variantTitle: "Black", optionSignature: "default", productId: U.physProd2, title: "Wireless Noise-Cancelling Headphones", qty: 2, price: 45000, shipmentId: U.ship5, deliveryStatus: "returned" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 90000, tax: 0, discount: 5000, total: 85000 },
    total_amount: 85000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord9_success",
    fulfillment_status: "cancelled",
    created_at: d(-18), updated_at: d(-6),
  },

  // ── ORD-10: Physical | payment_status=refunded | fulfillment=cancelled
  // Fully refunded order — both shipment returned and payment refunded
  {
    _id: U.ord10,
    order_number: "ORD-2026-000010",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      physItem({ variantId: U.physVar1a, sku: "TSHIRT-L-BLK", variantTitle: "Large / Black", optionSignature: "size:l|color:black", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 4, price: 7500, shipmentId: U.ship6, deliveryStatus: "returned" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 30000, tax: 0, discount: 0, total: 30000 },
    total_amount: 30000,
    payment_status: "refunded",
    payment_intent_id: "mycoolpay_txn_ord10_success",
    fulfillment_status: "cancelled",
    created_at: d(-22), updated_at: d(-4),
  },

  // ── ORD-11: Digital | payment_status=pending | fulfillment=pending
  // Customer added ebook to cart and placed order but has not paid
  {
    _id: U.ord11,
    order_number: "ORD-2026-000011",
    order_type: "digital",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      digItem({ variantId: U.digVar1, sku: "DIG-JSGUIDE-2026", variantTitle: "PDF", productId: U.digProd1, title: "JavaScript Mastery Guide — 2026 Edition", price: 5000 }),
    ],
    currency: "XAF",
    price_breakdown: { base: 5000, tax: 0, discount: 0, total: 5000 },
    total_amount: 5000,
    payment_status: "pending",
    payment_intent_id: null,
    fulfillment_status: "pending",
    created_at: d(-3), updated_at: d(-3),
  },

  // ── ORD-12: Digital | paid + fulfilled | ACTIVE entitlement (downloads remaining)
  {
    _id: U.ord12,
    order_number: "ORD-2026-000012",
    order_type: "digital",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      digItem({ variantId: U.digVar1, sku: "DIG-JSGUIDE-2026", variantTitle: "PDF", productId: U.digProd1, title: "JavaScript Mastery Guide — 2026 Edition", price: 5000 }),
    ],
    currency: "XAF",
    price_breakdown: { base: 5000, tax: 0, discount: 0, total: 5000 },
    total_amount: 5000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord12_success",
    fulfillment_status: "fulfilled",
    created_at: d(-14), updated_at: d(-14),
  },

  // ── ORD-13: Digital | paid + fulfilled | REVOKED entitlement
  // Vendor manually revoked access (e.g. dispute or policy violation)
  {
    _id: U.ord13,
    order_number: "ORD-2026-000013",
    order_type: "digital",
    vendor_id: U.vendor1,
    customer_id: U.cust3,
    items: [
      digItem({ variantId: U.digVar2, sku: "DIG-DPRO-1YR", variantTitle: "License Key", productId: U.digProd2, title: "DesignPro Suite — 1-Year License", price: 15000 }),
    ],
    currency: "XAF",
    price_breakdown: { base: 15000, tax: 0, discount: 0, total: 15000 },
    total_amount: 15000,
    payment_status: "paid",
    payment_intent_id: "stripe_pi_ord13_success",
    fulfillment_status: "fulfilled",
    created_at: d(-20), updated_at: d(-8),
  },

  // ── ORD-14: Digital | paid + fulfilled | download limit EXHAUSTED
  // Customer has used all 5 allowed downloads — further downloads blocked
  {
    _id: U.ord14,
    order_number: "ORD-2026-000014",
    order_type: "digital",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      digItem({ variantId: U.digVar1, sku: "DIG-JSGUIDE-2026", variantTitle: "PDF", productId: U.digProd1, title: "JavaScript Mastery Guide — 2026 Edition", price: 5000 }),
    ],
    currency: "XAF",
    price_breakdown: { base: 5000, tax: 0, discount: 0, total: 5000 },
    total_amount: 5000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord14_success",
    fulfillment_status: "fulfilled",
    created_at: d(-30), updated_at: d(-30),
  },

  // ── ORD-15: Physical multi-item | paid + processing | agency + agent assigned
  // Two different t-shirt variants in same order, same shipment, agent dispatched
  {
    _id: U.ord15,
    order_number: "ORD-2026-000015",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust3,
    items: [
      physItem({ variantId: U.physVar1a, sku: "TSHIRT-L-BLK", variantTitle: "Large / Black", optionSignature: "size:l|color:black", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 2, price: 7500, shipmentId: U.ship7, deliveryStatus: "assigned" }),
      physItem({ variantId: U.physVar1b, sku: "TSHIRT-M-WHT", variantTitle: "Medium / White", optionSignature: "size:m|color:white", productId: U.physProd1, title: "Classic Cotton T-Shirt", qty: 1, price: 7500, shipmentId: U.ship7, deliveryStatus: "assigned" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 22500, tax: 0, discount: 1500, total: 21000 },
    total_amount: 21000,
    payment_status: "paid",
    payment_intent_id: "notchpay_txn_ord15_success",
    fulfillment_status: "processing",
    created_at: d(-4), updated_at: d(-3),
  },

  // ── ORD-16: Physical | paid + processing | agency assigned | agent NOT yet assigned
  // Shipment created, agency confirmed, but no agent has been dispatched yet (status: pending)
  {
    _id: U.ord16,
    order_number: "ORD-2026-000016",
    order_type: "physical",
    vendor_id: U.vendor1,
    customer_id: U.cust1,
    items: [
      physItem({ variantId: U.physVar2a, sku: "HDPHN-NC-BLK", variantTitle: "Black", optionSignature: "default", productId: U.physProd2, title: "Wireless Noise-Cancelling Headphones", qty: 1, price: 45000, shipmentId: U.ship8, deliveryStatus: "pending" }),
    ],
    currency: "XAF",
    price_breakdown: { base: 45000, tax: 0, discount: 0, total: 45000 },
    total_amount: 45000,
    payment_status: "paid",
    payment_intent_id: "mycoolpay_txn_ord16_success",
    fulfillment_status: "processing",
    created_at: d(-2), updated_at: d(-1),
  },

  // ── ORD-17: Digital multi-item | paid + fulfilled | 2 entitlements (ebook + license)
  {
    _id: U.ord17,
    order_number: "ORD-2026-000017",
    order_type: "digital",
    vendor_id: U.vendor1,
    customer_id: U.cust2,
    items: [
      digItem({ variantId: U.digVar1, sku: "DIG-JSGUIDE-2026", variantTitle: "PDF", productId: U.digProd1, title: "JavaScript Mastery Guide — 2026 Edition", price: 5000 }),
      digItem({ variantId: U.digVar2, sku: "DIG-DPRO-1YR", variantTitle: "License Key", productId: U.digProd2, title: "DesignPro Suite — 1-Year License", price: 15000 }),
    ],
    currency: "XAF",
    price_breakdown: { base: 20000, tax: 0, discount: 2000, total: 18000 },
    total_amount: 18000,
    payment_status: "paid",
    payment_intent_id: "stripe_pi_ord17_success",
    fulfillment_status: "fulfilled",
    created_at: d(-11), updated_at: d(-11),
  },
]);

// ─── 9. SHIPMENTS ─────────────────────────────────────────────────────────────
print("Inserting shipments...");
db.shipments.insertMany([
  // ship1 → ord4: agency assigned, NO agent, status pending
  {
    _id: U.ship1, order_id: U.ord4, agency_id: U.agency1, agent_id: null,
    status: "pending",
    items: [{ order_item_id: U.ord4, product_id: U.physProd2, quantity: 1 }],
    created_at: d(-5), updated_at: d(-5),
  },
  // ship2 → ord5: agency + agent1 assigned
  {
    _id: U.ship2, order_id: U.ord5, agency_id: U.agency1, agent_id: U.agent1,
    status: "assigned",
    items: [{ order_item_id: U.ord5, product_id: U.physProd1, quantity: 3 }],
    created_at: d(-4), updated_at: d(-4),
  },
  // ship3 → ord6: in_transit with agent2
  {
    _id: U.ship3, order_id: U.ord6, agency_id: U.agency1, agent_id: U.agent2,
    status: "in_transit",
    items: [{ order_item_id: U.ord6, product_id: U.physProd2, quantity: 1 }],
    created_at: d(-7), updated_at: d(-3),
  },
  // ship4 → ord7: delivered by agent1
  {
    _id: U.ship4, order_id: U.ord7, agency_id: U.agency1, agent_id: U.agent1,
    status: "delivered",
    items: [{ order_item_id: U.ord7, product_id: U.physProd1, quantity: 1 }],
    created_at: d(-14), updated_at: d(-2),
  },
  // ship5 → ord9: returned (order paid then cancelled)
  {
    _id: U.ship5, order_id: U.ord9, agency_id: U.agency1, agent_id: U.agent2,
    status: "returned",
    items: [{ order_item_id: U.ord9, product_id: U.physProd2, quantity: 2 }],
    created_at: d(-17), updated_at: d(-6),
  },
  // ship6 → ord10: returned (refunded)
  {
    _id: U.ship6, order_id: U.ord10, agency_id: U.agency1, agent_id: U.agent1,
    status: "returned",
    items: [{ order_item_id: U.ord10, product_id: U.physProd1, quantity: 4 }],
    created_at: d(-21), updated_at: d(-4),
  },
  // ship7 → ord15: multi-item, assigned to agent2
  {
    _id: U.ship7, order_id: U.ord15, agency_id: U.agency1, agent_id: U.agent2,
    status: "assigned",
    items: [
      { order_item_id: U.ord15, product_id: U.physProd1, quantity: 2 },
      { order_item_id: U.ord15, product_id: U.physProd1, quantity: 1 },
    ],
    created_at: d(-3), updated_at: d(-3),
  },
  // ship8 → ord16: agency assigned, NO agent (pending)
  {
    _id: U.ship8, order_id: U.ord16, agency_id: U.agency1, agent_id: null,
    status: "pending",
    items: [{ order_item_id: U.ord16, product_id: U.physProd2, quantity: 1 }],
    created_at: d(-1), updated_at: d(-1),
  },
]);

// ─── 10. PAYMENT TRANSACTIONS ─────────────────────────────────────────────────
print("Inserting payment transactions...");
db.paymenttransactions.insertMany([
  // ord2: initiated/pending (AWAITING_PAYMENT)
  { _id: U.pay1, orderId: U.ord2, userId: U.cust2, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD2-0001", status: "PENDING", amountSnapshot: 45000, currencySnapshot: "XAF", idempotencyKey: "idem-ord2-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-8), updatedAt: d(-8) },
  // ord3: failed
  { _id: U.pay2, orderId: U.ord3, userId: U.cust3, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD3-0001", status: "FAILED", amountSnapshot: 7500, currencySnapshot: "XAF", idempotencyKey: "idem-ord3-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-7), updatedAt: d(-7) },
  // ord4: succeeded
  { _id: U.pay3, orderId: U.ord4, userId: U.cust1, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD4-0001", status: "SUCCEEDED", amountSnapshot: 43000, currencySnapshot: "XAF", idempotencyKey: "idem-ord4-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-6), updatedAt: d(-5) },
  // ord5: succeeded via MyCoolPay
  { _id: U.pay4, orderId: U.ord5, userId: U.cust2, gateway: "MYCOOLPAY", method: "MOBILE", gatewayRef: "MCP-REF-ORD5-0001", status: "SUCCEEDED", amountSnapshot: 22500, currencySnapshot: "XAF", idempotencyKey: "idem-ord5-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-5), updatedAt: d(-4) },
  // ord6: succeeded via Stripe card
  { _id: U.pay5, orderId: U.ord6, userId: U.cust3, gateway: "STRIPE", method: "CARD", gatewayRef: "pi_ord6_stripe_001", status: "SUCCEEDED", amountSnapshot: 46350, currencySnapshot: "XAF", idempotencyKey: "idem-ord6-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-9), updatedAt: d(-8) },
  // ord7: succeeded
  { _id: U.pay6, orderId: U.ord7, userId: U.cust1, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD7-0001", status: "SUCCEEDED", amountSnapshot: 7000, currencySnapshot: "XAF", idempotencyKey: "idem-ord7-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-15), updatedAt: d(-15) },
  // ord9: succeeded (later cancelled but no refund issued)
  { _id: U.pay7, orderId: U.ord9, userId: U.cust3, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD9-0001", status: "SUCCEEDED", amountSnapshot: 85000, currencySnapshot: "XAF", idempotencyKey: "idem-ord9-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-18), updatedAt: d(-18) },
  // ord10: refunded
  { _id: U.pay8, orderId: U.ord10, userId: U.cust1, gateway: "MYCOOLPAY", method: "MOBILE", gatewayRef: "MCP-REF-ORD10-001", status: "REFUNDED", amountSnapshot: 30000, currencySnapshot: "XAF", idempotencyKey: "idem-ord10-001", rawGatewayPayloads: [], totalRefunded: 30000, hasPartialRefund: false, createdAt: d(-22), updatedAt: d(-4) },
  // ord12: digital, succeeded
  { _id: U.pay9, orderId: U.ord12, userId: U.cust1, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD12-001", status: "SUCCEEDED", amountSnapshot: 5000, currencySnapshot: "XAF", idempotencyKey: "idem-ord12-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-14), updatedAt: d(-14) },
  // ord13: digital, succeeded
  { _id: U.pay10, orderId: U.ord13, userId: U.cust3, gateway: "STRIPE", method: "CARD", gatewayRef: "pi_ord13_stripe_001", status: "SUCCEEDED", amountSnapshot: 15000, currencySnapshot: "XAF", idempotencyKey: "idem-ord13-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-20), updatedAt: d(-20) },
  // ord14: digital, succeeded
  { _id: U.pay11, orderId: U.ord14, userId: U.cust2, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD14-001", status: "SUCCEEDED", amountSnapshot: 5000, currencySnapshot: "XAF", idempotencyKey: "idem-ord14-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-30), updatedAt: d(-30) },
  // ord15: multi-item physical, succeeded
  { _id: U.pay12, orderId: U.ord15, userId: U.cust3, gateway: "NOTCHPAY", method: "MOBILE", gatewayRef: "NP-REF-ORD15-001", status: "SUCCEEDED", amountSnapshot: 21000, currencySnapshot: "XAF", idempotencyKey: "idem-ord15-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-4), updatedAt: d(-3) },
  // ord16: succeeded
  { _id: U.pay13, orderId: U.ord16, userId: U.cust1, gateway: "MYCOOLPAY", method: "MOBILE", gatewayRef: "MCP-REF-ORD16-001", status: "SUCCEEDED", amountSnapshot: 45000, currencySnapshot: "XAF", idempotencyKey: "idem-ord16-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-2), updatedAt: d(-1) },
  // ord17: digital multi-item, Stripe card
  { _id: U.pay14, orderId: U.ord17, userId: U.cust2, gateway: "STRIPE", method: "CARD", gatewayRef: "pi_ord17_stripe_001", status: "SUCCEEDED", amountSnapshot: 18000, currencySnapshot: "XAF", idempotencyKey: "idem-ord17-001", rawGatewayPayloads: [], totalRefunded: 0, hasPartialRefund: false, createdAt: d(-11), updatedAt: d(-11) },
]);

// ─── 11. REFUND TRANSACTION ───────────────────────────────────────────────────
print("Inserting refund transaction...");
db.refundtransactions.insertOne({
  _id: U.ref1,
  paymentTransactionId: U.pay8,
  orderId: U.ord10,
  vendorId: U.vendor1,
  userId: U.custUser1,
  refundAmount: 30000,
  currency: "XAF",
  reason: "Customer received damaged items and requested full refund under return policy.",
  status: "completed",
  gateway: "MYCOOLPAY",
  gatewayRefundRef: "MCP-REFUND-ORD10-001",
  initiatedBy: U.vendor1,
  initiatedByRole: "vendor",
  createdAt: d(-5),
  completedAt: d(-4),
});

// ─── 12. DIGITAL ENTITLEMENTS ─────────────────────────────────────────────────
print("Inserting digital entitlements...");
db.customerdigitalentitlements.insertMany([
  // ent1 → ord12: ACTIVE, 2 of 5 downloads used
  {
    _id: U.ent1,
    orderId: U.ord12,
    orderItemId: U.ord12,
    productId: U.digProd1,
    assetId: U.asset1,
    customerId: U.cust1,
    vendorId: U.vendor1,
    downloadsUsed: 2,
    maxDownloads: 5,
    expiresAt: d(351),   // ~1 year from purchase
    revokedAt: null,
    deletedAt: null,
    createdAt: d(-14), updatedAt: d(-3),
  },
  // ent2 → ord13: REVOKED by vendor
  {
    _id: U.ent2,
    orderId: U.ord13,
    orderItemId: U.ord13,
    productId: U.digProd2,
    assetId: U.asset2,
    customerId: U.cust3,
    vendorId: U.vendor1,
    downloadsUsed: 1,
    maxDownloads: 3,
    expiresAt: d(345),
    revokedAt: d(-8),
    deletedAt: null,
    createdAt: d(-20), updatedAt: d(-8),
  },
  // ent3 → ord14: download limit EXHAUSTED (5/5 used)
  {
    _id: U.ent3,
    orderId: U.ord14,
    orderItemId: U.ord14,
    productId: U.digProd1,
    assetId: U.asset1,
    customerId: U.cust2,
    vendorId: U.vendor1,
    downloadsUsed: 5,
    maxDownloads: 5,
    expiresAt: d(335),
    revokedAt: null,
    deletedAt: null,
    createdAt: d(-30), updatedAt: d(-10),
  },
  // ent4 → ord17 item1 (ebook): ACTIVE
  {
    _id: U.ent4,
    orderId: U.ord17,
    orderItemId: U.ord17,
    productId: U.digProd1,
    assetId: U.asset1,
    customerId: U.cust2,
    vendorId: U.vendor1,
    downloadsUsed: 1,
    maxDownloads: 5,
    expiresAt: d(354),
    revokedAt: null,
    deletedAt: null,
    createdAt: d(-11), updatedAt: d(-9),
  },
  // ent5 → ord17 item2 (software license): ACTIVE, 0 downloads yet
  {
    _id: U.ent5,
    orderId: U.ord17,
    orderItemId: U.ord17,
    productId: U.digProd2,
    assetId: U.asset2,
    customerId: U.cust2,
    vendorId: U.vendor1,
    downloadsUsed: 0,
    maxDownloads: 3,
    expiresAt: d(354),
    revokedAt: null,
    deletedAt: null,
    createdAt: d(-11), updatedAt: d(-11),
  },
]);

// ─── 13. ORDER TIMELINES ──────────────────────────────────────────────────────
print("Inserting order timelines...");
db.ordertimelines.insertMany([
  // ORD-1
  { order_id: U.ord1,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-10) },
  // ORD-2
  { order_id: U.ord2,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-8) },
  { order_id: U.ord2,  event_type: "payment.updated",      description: "Payment initiated via NotchPay mobile money.",        metadata: { gateway: "NOTCHPAY", ref: "NP-REF-ORD2-0001" }, actor_type: "system", actor_id: null, created_at: d(-8) },
  // ORD-3
  { order_id: U.ord3,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser3, created_at: d(-7) },
  { order_id: U.ord3,  event_type: "payment.updated",      description: "Payment failed: insufficient funds.",                  metadata: { gateway: "NOTCHPAY", status: "FAILED" }, actor_type: "system", actor_id: null, created_at: d(-7) },
  // ORD-4
  { order_id: U.ord4,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-6) },
  { order_id: U.ord4,  event_type: "payment.updated",      description: "Payment confirmed via NotchPay.",                     metadata: { gateway: "NOTCHPAY", amount: 43000 }, actor_type: "system", actor_id: null, created_at: d(-6) },
  { order_id: U.ord4,  event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-5) },
  { order_id: U.ord4,  event_type: "delivery.agency_updated", description: "Delivery agency assigned: Express Delivery Cameroon.", metadata: { agency_id: U.agency1.toString() }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-5) },
  // ORD-5
  { order_id: U.ord5,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-5) },
  { order_id: U.ord5,  event_type: "payment.updated",      description: "Payment confirmed via MyCoolPay.",                    metadata: { gateway: "MYCOOLPAY", amount: 22500 }, actor_type: "system", actor_id: null, created_at: d(-5) },
  { order_id: U.ord5,  event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-4) },
  { order_id: U.ord5,  event_type: "delivery.agency_updated", description: "Agent Pierre Ekang assigned to shipment.",         metadata: { agent_id: U.agent1.toString() }, actor_type: "system", actor_id: null, created_at: d(-4) },
  // ORD-6
  { order_id: U.ord6,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser3, created_at: d(-9) },
  { order_id: U.ord6,  event_type: "payment.updated",      description: "Payment confirmed via Stripe.",                       metadata: { gateway: "STRIPE", amount: 46350 }, actor_type: "system", actor_id: null, created_at: d(-9) },
  { order_id: U.ord6,  event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-8) },
  { order_id: U.ord6,  event_type: "fulfillment.updated",  description: "Order shipped — package picked up by delivery agent.", metadata: { from: "processing", to: "shipped" }, actor_type: "system", actor_id: null, created_at: d(-3) },
  // ORD-7
  { order_id: U.ord7,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-15) },
  { order_id: U.ord7,  event_type: "payment.updated",      description: "Payment confirmed via NotchPay.",                     metadata: { gateway: "NOTCHPAY", amount: 7000 }, actor_type: "system", actor_id: null, created_at: d(-15) },
  { order_id: U.ord7,  event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-14) },
  { order_id: U.ord7,  event_type: "fulfillment.updated",  description: "Order shipped.",                                      metadata: { from: "processing", to: "shipped" }, actor_type: "system", actor_id: null, created_at: d(-5) },
  { order_id: U.ord7,  event_type: "fulfillment.updated",  description: "Order delivered successfully.",                       metadata: { from: "shipped", to: "delivered" }, actor_type: "system", actor_id: null, created_at: d(-2) },
  // ORD-8
  { order_id: U.ord8,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-12) },
  { order_id: U.ord8,  event_type: "fulfillment.updated",  description: "Order cancelled by vendor before payment.",           metadata: { from: "pending", to: "cancelled", reason: "Out of stock" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-12) },
  { order_id: U.ord8,  event_type: "note.added",           description: "Vendor note: Sorry, item went out of stock.",         metadata: {},                              actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-12) },
  // ORD-9
  { order_id: U.ord9,  event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser3, created_at: d(-18) },
  { order_id: U.ord9,  event_type: "payment.updated",      description: "Payment confirmed via NotchPay.",                     metadata: { gateway: "NOTCHPAY", amount: 85000 }, actor_type: "system", actor_id: null, created_at: d(-18) },
  { order_id: U.ord9,  event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-17) },
  { order_id: U.ord9,  event_type: "fulfillment.updated",  description: "Order cancelled post-payment: quality control failure.", metadata: { from: "processing", to: "cancelled" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-6) },
  { order_id: U.ord9,  event_type: "system.action",        description: "Shipment returned to warehouse.",                     metadata: { shipment_id: U.ship5.toString() }, actor_type: "system", actor_id: null, created_at: d(-6) },
  // ORD-10
  { order_id: U.ord10, event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-22) },
  { order_id: U.ord10, event_type: "payment.updated",      description: "Payment confirmed via MyCoolPay.",                    metadata: { gateway: "MYCOOLPAY", amount: 30000 }, actor_type: "system", actor_id: null, created_at: d(-22) },
  { order_id: U.ord10, event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-21) },
  { order_id: U.ord10, event_type: "fulfillment.updated",  description: "Order cancelled: customer received damaged goods.",   metadata: { from: "processing", to: "cancelled" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-5) },
  { order_id: U.ord10, event_type: "payment.updated",      description: "Full refund of 30,000 XAF processed via MyCoolPay.", metadata: { refund_ref: "MCP-REFUND-ORD10-001", amount: 30000 }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-4) },
  // ORD-11
  { order_id: U.ord11, event_type: "order.created",        description: "Digital order placed by customer.",                   metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-3) },
  // ORD-12
  { order_id: U.ord12, event_type: "order.created",        description: "Digital order placed by customer.",                   metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-14) },
  { order_id: U.ord12, event_type: "payment.updated",      description: "Payment confirmed. Digital entitlement granted.",     metadata: { gateway: "NOTCHPAY", amount: 5000 }, actor_type: "system", actor_id: null, created_at: d(-14) },
  { order_id: U.ord12, event_type: "fulfillment.updated",  description: "Digital order fulfilled — download link activated.",  metadata: { entitlement_id: U.ent1.toString() }, actor_type: "system", actor_id: null, created_at: d(-14) },
  // ORD-13
  { order_id: U.ord13, event_type: "order.created",        description: "Digital order placed by customer.",                   metadata: {},                              actor_type: "customer", actor_id: U.custUser3, created_at: d(-20) },
  { order_id: U.ord13, event_type: "payment.updated",      description: "Payment confirmed via Stripe.",                       metadata: { gateway: "STRIPE", amount: 15000 }, actor_type: "system", actor_id: null, created_at: d(-20) },
  { order_id: U.ord13, event_type: "fulfillment.updated",  description: "Digital order fulfilled — license key activated.",    metadata: { entitlement_id: U.ent2.toString() }, actor_type: "system", actor_id: null, created_at: d(-20) },
  { order_id: U.ord13, event_type: "entitlement.revoked",  description: "Entitlement revoked: chargeback dispute opened.",     metadata: { entitlement_id: U.ent2.toString(), reason: "Chargeback dispute opened by customer. Access suspended pending resolution." }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-8) },
  // ORD-14
  { order_id: U.ord14, event_type: "order.created",        description: "Digital order placed by customer.",                   metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-30) },
  { order_id: U.ord14, event_type: "payment.updated",      description: "Payment confirmed via NotchPay.",                     metadata: { gateway: "NOTCHPAY", amount: 5000 }, actor_type: "system", actor_id: null, created_at: d(-30) },
  { order_id: U.ord14, event_type: "fulfillment.updated",  description: "Digital order fulfilled — download link activated.",  metadata: { entitlement_id: U.ent3.toString() }, actor_type: "system", actor_id: null, created_at: d(-30) },
  { order_id: U.ord14, event_type: "system.action",        description: "Download limit reached (5/5). Further downloads blocked.", metadata: { entitlement_id: U.ent3.toString(), downloads_used: 5, max_downloads: 5 }, actor_type: "system", actor_id: null, created_at: d(-10) },
  // ORD-15
  { order_id: U.ord15, event_type: "order.created",        description: "Multi-item physical order placed.",                   metadata: {},                              actor_type: "customer", actor_id: U.custUser3, created_at: d(-4) },
  { order_id: U.ord15, event_type: "payment.updated",      description: "Payment confirmed via NotchPay.",                     metadata: { gateway: "NOTCHPAY", amount: 21000 }, actor_type: "system", actor_id: null, created_at: d(-4) },
  { order_id: U.ord15, event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-3) },
  { order_id: U.ord15, event_type: "delivery.agency_updated", description: "Agent Samuel Biya assigned to shipment.",          metadata: { agent_id: U.agent2.toString() }, actor_type: "system", actor_id: null, created_at: d(-3) },
  { order_id: U.ord15, event_type: "note.added",           description: "Fragile items — handle with care. Customer requested specific delivery window: 9am-12pm.", metadata: {}, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-3) },
  // ORD-16
  { order_id: U.ord16, event_type: "order.created",        description: "Order placed by customer.",                           metadata: {},                              actor_type: "customer", actor_id: U.custUser1, created_at: d(-2) },
  { order_id: U.ord16, event_type: "payment.updated",      description: "Payment confirmed via MyCoolPay.",                    metadata: { gateway: "MYCOOLPAY", amount: 45000 }, actor_type: "system", actor_id: null, created_at: d(-2) },
  { order_id: U.ord16, event_type: "fulfillment.updated",  description: "Order moved to processing.",                          metadata: { from: "pending", to: "processing" }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-1) },
  { order_id: U.ord16, event_type: "delivery.agency_updated", description: "Shipment created for Express Delivery Cameroon. Awaiting agent assignment.", metadata: { agency_id: U.agency1.toString() }, actor_type: "vendor", actor_id: U.vendorUser, created_at: d(-1) },
  // ORD-17
  { order_id: U.ord17, event_type: "order.created",        description: "Multi-item digital order placed.",                    metadata: {},                              actor_type: "customer", actor_id: U.custUser2, created_at: d(-11) },
  { order_id: U.ord17, event_type: "payment.updated",      description: "Payment confirmed via Stripe. Bundle discount applied.", metadata: { gateway: "STRIPE", amount: 18000, discount: 2000 }, actor_type: "system", actor_id: null, created_at: d(-11) },
  { order_id: U.ord17, event_type: "fulfillment.updated",  description: "Digital order fulfilled — 2 entitlements granted.",   metadata: { entitlement_ids: [U.ent4.toString(), U.ent5.toString()] }, actor_type: "system", actor_id: null, created_at: d(-11) },
]);

// ─── 14. VENDOR ORDER NOTES ───────────────────────────────────────────────────
print("Inserting vendor order notes...");
db.vendorordernotes.insertMany([
  // ORD-4: internal note about processing
  { order_id: U.ord4, vendor_id: U.vendor1, author_id: U.vendorUser, message: "Customer called to confirm delivery address. Shipping to Akwa, Douala. Standard 2-day delivery expected.", created_at: d(-5) },
  // ORD-8: cancellation note
  { order_id: U.ord8, vendor_id: U.vendor1, author_id: U.vendorUser, message: "Cancelled: last unit sold in-store before this order was confirmed online. Restocking expected in 2 weeks. Customer notified via WhatsApp.", created_at: d(-12) },
  // ORD-9: post-cancellation internal note
  { order_id: U.ord9, vendor_id: U.vendor1, author_id: U.vendorUser, message: "QC team flagged cosmetic defects on both units during final pack. Cancelled to avoid complaint. Refund not yet requested by customer — monitoring.", created_at: d(-6) },
  // ORD-10: refund note
  { order_id: U.ord10, vendor_id: U.vendor1, author_id: U.vendorUser, message: "Customer sent photos of damaged packaging. Accepted full refund per return policy. Refund ref: MCP-REFUND-ORD10-001. Replacement shipment NOT offered — customer declined.", created_at: d(-5) },
  // ORD-13: entitlement revoke note
  { order_id: U.ord13, vendor_id: U.vendor1, author_id: U.vendorUser, message: "Chargeback opened by customer on day 12. Access revoked pending investigation. Stripe dispute ref: dp_ord13_001.", created_at: d(-8) },
  // ORD-15: delivery instructions note
  { order_id: U.ord15, vendor_id: U.vendor1, author_id: U.vendorUser, message: "Fragile items — handle with care. Customer requested specific delivery window: 9am-12pm.", created_at: d(-3) },
  // ORD-16: urgent note
  { order_id: U.ord16, vendor_id: U.vendor1, author_id: U.vendorUser, message: "High-value order. Assign experienced agent. Customer has premium status.", created_at: d(-1) },
]);

print("\n✅ Seed complete. Collections populated:");
print("  users             → 7 documents");
print("  vendors           → 1 document");
print("  customers         → 3 documents");
print("  deliveryagencies  → 1 document");
print("  deliveryagents    → 2 documents");
print("  products          → 4 documents");
print("  productvariants   → 5 documents");
print("  orders            → 17 documents");
print("  shipments         → 8 documents");
print("  paymenttransactions → 14 documents");
print("  refundtransactions  → 1 document");
print("  customerdigitalentitlements → 5 documents");
print("  ordertimelines    → 43 documents");
print("  vendorordernotes  → 7 documents");
print("\nOrder scenarios covered:");
print("  ORD-1  Physical | pending (no payment attempted)");
print("  ORD-2  Physical | AWAITING_PAYMENT (gateway initiated)");
print("  ORD-3  Physical | payment failed");
print("  ORD-4  Physical | paid + processing | agency assigned | NO agent");
print("  ORD-5  Physical | paid + processing | agency + agent assigned");
print("  ORD-6  Physical | paid + shipped | in_transit");
print("  ORD-7  Physical | paid + delivered (terminal)");
print("  ORD-8  Physical | cancelled BEFORE payment");
print("  ORD-9  Physical | paid → cancelled (shipment returned, no refund yet)");
print("  ORD-10 Physical | paid → refunded + cancelled");
print("  ORD-11 Digital  | pending (no payment attempted)");
print("  ORD-12 Digital  | paid + fulfilled | active entitlement (2/5 downloads)");
print("  ORD-13 Digital  | paid + fulfilled | REVOKED entitlement");
print("  ORD-14 Digital  | paid + fulfilled | download limit exhausted (5/5)");
print("  ORD-15 Physical | multi-item | paid + processing | agency + agent");
print("  ORD-16 Physical | paid + processing | agency assigned | NO agent yet");
print("  ORD-17 Digital  | multi-item | paid + fulfilled | 2 active entitlements");
