/**
 * Seed: ONE customer account you can actually sign into, plus a shopping life
 * behind it — and a real, redeemable sign-in code printed at the end.
 *
 * ── WHY THIS SCRIPT EXISTS ───────────────────────────────────────────────────
 * A customer never types a password (`core/auth/system-password.ts`) and never
 * fills in a registration form. The account is created on their first contact
 * with the WhatsApp/Telegram bot, and they sign in by sending `/login` and
 * redeeming the link or the 8-character code it replies with.
 *
 * The bot half is not live yet. So the storefront has nothing to sign into, and
 * this script is the stand-in for the bot: it creates the account the bot would
 * have created, and mints the credential the bot would have replied with —
 * through `LoginSessionStore.issue`, the SAME code path `/login` uses.
 *
 * There is no development bypass anywhere in this file and there must never be
 * one. The login credential check was commented out in this codebase for a
 * period and was restored on 2026-08-21 precisely because a switch whose failure
 * direction is "open" is the wrong shape. A seed that mints a REAL credential
 * needs no such switch, which is the whole reason this is a script and not a
 * branch inside `MessagingLoginService`.
 *
 * ⚠ **THE CODE LIVES TEN MINUTES AND IS SINGLE USE.** That is
 * `LOGIN_SESSION_TTL_SECONDS`, and it is not negotiable from out here — the
 * store is its only writer. So the code printed below goes stale while you are
 * still reading it, and the answer is to mint another:
 *
 *     npm run seed:customer:code        ← seconds, touches nothing else
 *
 * Re-minting REVOKES the previous one (`revokeForIdentity`), so there is only
 * ever one live credential for this account — the same property the bot has, and
 * the reason re-running this is safe rather than an accumulation of live keys.
 *
 * ── WHAT IT CREATES ──────────────────────────────────────────────────────────
 * Everything under fixed `7e57…` ids, so a re-run replaces rather than
 * duplicates and `--clean` can find all of it:
 *
 *   • the `users` row + `customers` profile — phone AND email, so either
 *     identifier redeems the code
 *   • two geocoded Douala addresses (Bonamoussadi = default, Akwa = work)
 *   • a WhatsApp channel connection on the account's own number, so the account
 *     is already "connected" and the real bot resolves it the day it lands
 *   • three saved payment methods (MoMo, Orange Money, card)
 *   • a wishlist and a recently-viewed history
 *   • SEVEN orders spanning the states a storefront has to render differently
 *   • a non-empty cart, so the cart page is not an empty state
 *   • one support ticket against a real order
 *
 * ── IT REUSES THE WORLD, IT DOES NOT REBUILD IT ──────────────────────────────
 * No vendor, product, agency or agent is created here. Products are CHOSEN AT
 * RUNTIME by re-running the same resolution `OrderService.buildVendorOrder`
 * applies (`product.delivery.agencyId` → `vendor.default_delivery_agency_id`),
 * filtered to an agency that actually has a contracted active agent. That is
 * what keeps this script working after another seed is re-run with `--clean` and
 * every product id in the database changes — a hardcoded catalogue here would be
 * broken by a sibling seed and would look like a bug in this one.
 *
 * ── SIDE EFFECTS ARE REAL, BECAUSE THE CODE PATHS ARE ────────────────────────
 * Orders are placed through `OrderService`, dispatched, offered, accepted and
 * driven through `ShipmentService` — so stock is really reserved, capacity is
 * really held, and the timeline is really written. Customer notification
 * preferences default to in-app only (`customer-notification-preference.model`),
 * so no WhatsApp is sent for those. The ONE outbound message is the COD delivery
 * code, which the real path sends to the customer over WhatsApp; it goes to a
 * fake number and fails harmlessly, and it is the only slow step here.
 *
 * PREREQUISITES
 *   • MongoDB running as a replica set (checkout runs in a transaction)
 *   • Redis reachable (the sign-in credential lives in LOGIN_CODE_DB)
 *   • a world to shop in: an active agency with a contracted active agent, and
 *     active physical products routing to it. `seed-orders.js` +
 *     `seed:cod-shipments` produce one; this script says so plainly if it cannot
 *     find one, rather than failing later inside a transaction.
 *
 * Run:
 *   npx ts-node scripts/seed/seed-customer-account.ts             # wipe + reseed + mint
 *   npx ts-node scripts/seed/seed-customer-account.ts --code      # mint a fresh code only
 *   npx ts-node scripts/seed/seed-customer-account.ts --clean     # wipe only
 *   npx ts-node scripts/seed/seed-customer-account.ts --no-orders # account + code only
 */
import dotenv from 'dotenv';
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { CustomerModel } from '../../src/modules/customers/customer.model';
import { VendorModel } from '../../src/modules/vendors/vendor.model';
import { ProductModel } from '../../src/modules/catalog/models/product.model';
import { ProductVariantModel } from '../../src/modules/catalog/models/product-variant.model';
import { CartModel } from '../../src/modules/cart/models/cart.model';
import { OrderModel, IOrder } from '../../src/modules/orders/order.model';
import { OrderService } from '../../src/modules/orders/order.service';
import { OrderTimelineModel } from '../../src/modules/orders/order-timeline.model';
import { ShipmentModel, IShipment } from '../../src/modules/shipments/shipment.model';
import { ShipmentService } from '../../src/modules/shipments/shipment.service';
import { DeliveryAgencyModel } from '../../src/modules/delivery/delivery-agency.model';
import { AgencyMagazinModel } from '../../src/modules/magazin/models/magazin.model';
import {
  DeliveryAgentModel,
  AgentAgencyContractModel,
  agentCapacityService,
} from '../../src/modules/agents';
import { shipmentAssignmentService } from '../../src/modules/shipment-assignment';
import { ShipmentAssignmentOfferModel } from '../../src/modules/shipment-assignment/models/shipment-assignment-offer.model';
import { ShipmentAssignmentSessionModel } from '../../src/modules/shipment-assignment/models/shipment-assignment-session.model';
import { CashCollectionModel } from '../../src/modules/cod/models/cash-collection.model';
import { codExposureService } from '../../src/modules/cod/services/cod-exposure.service';
import type { IDeliveryAgent } from '../../src/modules/agents';
import { TrackingOutboxModel } from '../../src/modules/tracking-integration/models/tracking-outbox.model';
import { ChannelConnectionModel } from '../../src/modules/channel-connections/channel-connection.model';
import { UserPaymentMethodModel } from '../../src/modules/payment-methods/models/user-payment-method.model';
import { WishlistItemModel } from '../../src/modules/customers/models/wishlist-item.model';
import { RecentlyViewedItemModel } from '../../src/modules/customers/models/recently-viewed-item.model';
import { CustomerNotificationModel } from '../../src/modules/notifications/models/customer-notification.model';
import { CustomerNotificationPreferenceModel } from '../../src/modules/notifications/models/customer-notification-preference.model';
import { initializeCustomerNotificationEventConsumers } from '../../src/modules/notifications/customer-notification-event-consumer';
import { TicketModel } from '../../src/modules/tickets/models/ticket.model';
import { TicketFollowerModel } from '../../src/modules/tickets/models/ticket-follower.model';
import { TicketNoteModel } from '../../src/modules/tickets/models/ticket-note.model';
import {
  TicketType,
  TicketStatus,
  TicketPriority,
  TicketImportance,
  ActorRole,
  EntityType,
  NoteVisibility,
} from '../../src/modules/tickets/types/ticket.types';
import { generateSystemPassword } from '../../src/core/auth/system-password';
import {
  loginSessionStore,
  LOGIN_SESSION_TTL_SECONDS,
} from '../../src/modules/messaging-login/services/login-session.store';
import { IGeoAddress, GeoAddressInput } from '../../src/core/types/geo-address.types';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
const STOREFRONT_URL = process.env.STOREFRONT_URL || 'http://localhost:3000';
const API_BASE = `http://localhost:${process.env.PORT || 8022}`;
const CURRENCY = 'XAF';

// ─────────────────────────────────────────────────────────────────────────────
// The account. Fixed ids so a re-run replaces rather than duplicates.
// `7e57` reads as "test" and every character is valid hex — an ObjectId prefix
// has no room for cleverness that is not also [0-9a-f].
// ─────────────────────────────────────────────────────────────────────────────
const tid = (suffix: string) => new Types.ObjectId(`7e57${'0'.repeat(20 - suffix.length)}${suffix}`);

const ID = {
  user: tid('a1'),
  customer: tid('b1'),
};

const ACCOUNT = {
  name: 'Nadège Fotso',
  /**
   * BOTH identifiers, deliberately. `POST /api/auth/magic/code` takes a phone OR
   * an email in one field, and a fixture carrying only one of them can exercise
   * only half of `MessagingLoginService.findByIdentifier`.
   *
   * Strict E.164 — `login_phone` is stored that way and the shared helpers do not
   * repair a missing '+' (see `messagingPhoneToE164`, which exists because of it).
   */
  phone: '+237600000001',
  email: 'test-customer@jovitest.cm',
  /** How WhatsApp would address this account: BARE DIGITS, no '+'. */
  waExternalId: '237600000001',
};

const log = (msg = '') => console.log(msg);
const section = (title: string) =>
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 72 - title.length))}`);
const money = (n: number) => `${n.toLocaleString('en-US')} ${CURRENCY}`;

// ─────────────────────────────────────────────────────────────────────────────
// Addresses — real Douala places, real coordinates. GeoJSON order is [lng, lat].
// ─────────────────────────────────────────────────────────────────────────────
const geoAddress = (opts: {
  formatted: string;
  lng: number;
  lat: number;
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
      city: 'Douala',
      /**
       * ⚠ Load-bearing, and the least obvious field here.
       * `ShipmentAssignmentService.assertContractPolicy` matches this against the
       * contract's `coverage.regions`, which are lower-case slugs. A region that
       * does not match refuses the accept with
       * CONTRACT_COVERAGE_REGION_NOT_COVERED and the seed dies half-way through.
       */
      region: 'littoral',
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

const HOME = geoAddress({
  formatted: 'Rue des Écoles, Bonamoussadi, Douala, Littoral, Cameroun',
  lng: 9.742,
  lat: 4.0919,
  street: 'Rue des Écoles',
  neighbourhood: 'Bonamoussadi',
});
const WORK = geoAddress({
  formatted: 'Boulevard de la Liberté, Akwa, Douala, Littoral, Cameroun',
  lng: 9.7085,
  lat: 4.0511,
  street: 'Boulevard de la Liberté',
  neighbourhood: 'Akwa',
});
const MAKEPE = geoAddress({
  formatted: 'Makepe Missoké, Douala, Littoral, Cameroun',
  lng: 9.7539,
  lat: 4.0813,
  neighbourhood: 'Makepe',
});

const orderService = new OrderService();
const shipmentService = new ShipmentService();

/** One product per order scenario — the seven below are distinct on purpose. */
const PRODUCTS_NEEDED = 7;

// ─────────────────────────────────────────────────────────────────────────────
// The world this account shops in — DISCOVERED, never hardcoded.
// ─────────────────────────────────────────────────────────────────────────────

interface DeliveryWorld {
  agencyId: Types.ObjectId;
  agencyName: string;
  agentId: Types.ObjectId;
  agentUserId: Types.ObjectId;
  agencyUserId: Types.ObjectId;
  agentName: string;
  codThreshold: number;
  /**
   * How much more cash this agent may carry, right now — `effectiveLimit` minus
   * their current exposure, both from `CodExposureService` itself rather than
   * re-derived here.
   *
   * ⚠ It can be NEGATIVE, and on a well-used development database it usually is:
   * a seeded agent accumulates undeposited cash from every COD run, and the limit
   * is *scaled by trust*, so a trust drop shrinks the ceiling under exposure that
   * was fine when it was booked. Order #6 is skipped rather than failing the run
   * when nothing has room — see `pickCodOrder`.
   */
  codHeadroom: number;
}

interface Pick {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  vendorId: string;
  price: number;
}

/**
 * Find an agency that can carry a shipment to the end AND has enough to sell.
 *
 * ⚠ **These two questions must be answered TOGETHER, and that is the whole
 * reason this function is shaped the way it is.** They were separate at first —
 * pick the first deliverable agency, then pick products for it — and the run
 * died on a real database: the first active contract belonged to an agency with
 * six shoppable products, while an agency further down the list had a dozen.
 * Neither half was wrong on its own, and the failure was reported as a missing
 * catalogue when what was actually missing was agreement between two searches.
 *
 * "Active agency" is not enough and neither is "has agents": the accept path
 * needs an ACTIVE CONTRACT with an ACTIVE, KYC-VERIFIED agent whose coverage
 * includes Littoral. Checking all of it here — before a single order exists —
 * turns "no delivery agent could take this" into a sentence at the top of the
 * run instead of a rollback four orders in.
 */
async function findDeliveryWorld(productsNeeded: number): Promise<{ world: DeliveryWorld; picks: Pick[] }> {
  const contracts = await AgentAgencyContractModel.find({ status: 'active' }).lean();

  let deliverable = 0;
  let bestCatalogue = 0;
  let fallback: { world: DeliveryWorld; picks: Pick[] } | null = null;

  for (const contract of contracts) {
    const agency = await DeliveryAgencyModel.findById(contract.agency_id).lean();
    if (!agency || agency.status !== 'active') continue;

    const agent = await DeliveryAgentModel.findById(contract.agent_id).lean();
    if (!agent || agent.status !== 'active') continue;
    if (agent.kyc?.status !== 'verified') continue;

    // Empty `regions` means "no region declared", which `contractCoversRegion`
    // treats as unrestricted. Either that or an explicit littoral is fine.
    const regions: string[] = contract.coverage?.regions ?? [];
    if (regions.length > 0 && !regions.includes('littoral')) continue;

    deliverable++;

    const agencyId = agency._id as Types.ObjectId;
    const picks = await pickProducts(agencyId, productsNeeded);
    bestCatalogue = Math.max(bestCatalogue, picks.length);
    if (picks.length < productsNeeded) continue;

    /**
     * How much cash this agent may still carry.
     *
     * Asked through `CodExposureService` rather than recomputed, because the
     * limit is **trust-scaled** (`effectiveLimit`) and exposure counts pending
     * collections as well as cash in hand. A local re-derivation would agree
     * today and quietly disagree the first time either rule moves — and the
     * whole point of asking is to predict what `assertCanTakeCodShipment` will
     * decide at accept time.
     */
    const codThreshold = contract.cod?.threshold ?? 0;
    const codHeadroom =
      codExposureService.effectiveLimit(agent as unknown as IDeliveryAgent, codThreshold) -
      (await codExposureService.currentExposure(agent._id.toString()));

    // The agency's BUSINESS name lives on its Magazin; the agency profile itself
    // carries only an optional display name, so try the real one first.
    const magazin = await AgencyMagazinModel.findOne({ agency_id: agencyId }).select('name').lean();

    const world: DeliveryWorld = {
      agencyId,
      agencyName: magazin?.name ?? agency.display_name ?? String(agencyId),
      agentId: agent._id as Types.ObjectId,
      agentUserId: agent.user_id as Types.ObjectId,
      agencyUserId: agency.user_id as Types.ObjectId,
      agentName: agent.name ?? String(agent._id),
      codThreshold,
      codHeadroom,
    };

    /**
     * Prefer a world that can also carry the COD order, but do not REQUIRE one.
     *
     * A candidate is remembered and the search continues: six of the seven
     * scenarios need no COD at all, so refusing to seed anything because every
     * agent is holding undeposited cash would trade the whole account for one
     * order. If a later candidate has room it wins; if none does, the first
     * deliverable one is used and order #6 is skipped with its reason printed.
     */
    if (codHeadroom >= cheapestPrice(picks)) return { world, picks };
    if (!fallback) fallback = { world, picks };
  }

  if (fallback) return fallback;

  throw new Error(
    deliverable === 0
      ? 'No active agency↔agent contract covering Littoral was found.\n' +
        '   This account needs somewhere for its orders to go. Seed the delivery world first:\n' +
        `     mongosh "${MONGO_URI}" seed-orders.js\n` +
        '     npm run seed:cod-shipments'
      : `${deliverable} agency/agent pair(s) can deliver, but none has ${productsNeeded} shoppable\n` +
        `   products routing to it (the best had ${bestCatalogue}).\n` +
        '   A product qualifies when it is active + physical, has an active variant in stock, and\n' +
        '   routes to that agency via product.delivery.agencyId or the vendor default.\n' +
        '   Top the catalogue up with:  npm run seed:cod-shipments'
  );
}

/**
 * Pick up to `count` products this account can actually check out with.
 *
 * Re-runs `buildVendorOrder`'s own resolution — `product.delivery.agencyId`
 * first, then the vendor's `default_delivery_agency_id` — because that is the
 * field that decides which agency the shipment lands on, and a product routing
 * anywhere else produces a shipment our agent has no contract for.
 *
 * Returns what it found rather than throwing on a short result: the caller is
 * trying several agencies and a short answer is an ordinary "not this one".
 */
async function pickProducts(agencyId: Types.ObjectId, count: number): Promise<Pick[]> {
  const products = await ProductModel.find({
    status: 'active',
    type: 'physical',
    deletedAt: null,
  }).lean();

  const vendorCache = new Map<string, any>();
  const picks: Pick[] = [];

  for (const product of products) {
    if (picks.length >= count) break;

    const vendorId = String((product as any).vendorId);
    if (!vendorCache.has(vendorId)) {
      vendorCache.set(vendorId, await VendorModel.findById(vendorId).lean());
    }
    const vendor = vendorCache.get(vendorId);
    if (!vendor) continue;

    const resolved =
      (product as any).delivery?.agencyId?.toString() ??
      vendor.default_delivery_agency_id?.toString() ??
      null;
    if (resolved !== agencyId.toString()) continue;

    const variant = await ProductVariantModel.findOne({
      productId: product._id,
      status: 'active',
      deletedAt: null,
      $or: [{ isInfiniteStock: true }, { stock: { $gt: 5 } }],
    }).lean();
    if (!variant) continue;

    picks.push({
      productId: String(product._id),
      variantId: String(variant._id),
      sku: (variant as any).sku,
      title: (product as any).title ?? 'Article',
      vendorId,
      price: (variant as any).price,
    });
  }

  return picks;
}

/**
 * The COD order is always the CHEAPEST pick, and that is not arbitrary.
 *
 * `assertCanTakeCodShipment` compares the shipment's whole value against the
 * agent's remaining headroom, so the cheapest line is the one most likely to fit
 * — and choosing it here means the headroom check in `findDeliveryWorld` tests
 * exactly the order that will later be placed, rather than an optimistic guess.
 */
const cheapestPrice = (picks: Pick[]): number =>
  picks.reduce((lowest, pick) => Math.min(lowest, pick.price), Infinity);

const cheapestPick = (picks: Pick[]): Pick =>
  picks.reduce((lowest, pick) => (pick.price < lowest.price ? pick : lowest), picks[0]);

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — always first, and scoped to this account alone.
//
// Everything is reachable from the two fixed ids, so nothing belonging to
// another seed is in range. Ordering matters in one place, noted below.
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(world: DeliveryWorld | null): Promise<void> {
  section('Cleanup');

  const orders = await OrderModel.find({ customer_id: ID.customer }).select('_id').lean();
  const orderIds = orders.map((o) => o._id);
  const shipments = await ShipmentModel.find({ order_id: { $in: orderIds } }).select('_id').lean();
  const shipmentIds = shipments.map((s) => s._id);
  const tickets = await TicketModel.find({ created_by_user_id: ID.user }).select('_id').lean();
  const ticketIds = tickets.map((t) => t._id);

  await Promise.all([
    ShipmentAssignmentOfferModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    ShipmentAssignmentSessionModel.deleteMany({ shipment_id: { $in: shipmentIds } }),
    // No cash is ever COLLECTED by this seed (the COD order stops at in_transit),
    // so these rows are always `pending` and no money has to be reversed. If a
    // future scenario collects, copy `reverseSeededMoney` from
    // seed-cod-shipments.ts — deleting a collected row does NOT un-credit it.
    CashCollectionModel.deleteMany({ order_id: { $in: orderIds } }),
    // The timeline is append-only by design (a pre-hook rejects deletes), so a
    // teardown has to go under it via the raw collection.
    OrderTimelineModel.collection.deleteMany({ order_id: { $in: orderIds } }),
    TrackingOutboxModel.deleteMany({ 'payload.shipmentId': { $in: shipmentIds.map(String) } }),
    ShipmentModel.deleteMany({ _id: { $in: shipmentIds } }),
    // Ticket notes are append-only too — their pre-delete hook throws — so this
    // is the second place a teardown has to go under the model layer.
    TicketNoteModel.collection.deleteMany({ ticket_id: { $in: ticketIds } }),
    TicketFollowerModel.deleteMany({ ticket_id: { $in: ticketIds } }),
  ]);

  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: orderIds } }),
    TicketModel.deleteMany({ _id: { $in: ticketIds } }),
    CartModel.deleteMany({ userId: ID.customer.toString() }),
    WishlistItemModel.deleteMany({ customer_id: ID.customer }),
    RecentlyViewedItemModel.deleteMany({ customer_id: ID.customer }),
    UserPaymentMethodModel.deleteMany({ owner_role: 'customer', owner_id: ID.customer }),
    CustomerNotificationModel.deleteMany({ customerId: ID.customer }),
    CustomerNotificationPreferenceModel.deleteMany({ customerId: ID.customer }),
    ChannelConnectionModel.deleteMany({ user_id: ID.user }),
    CustomerModel.deleteMany({ _id: ID.customer }),
    UserModel.deleteMany({ _id: ID.user }),
  ]);

  log(
    `   🧹 removed ${orderIds.length} order(s), ${shipmentIds.length} shipment(s), ` +
      `${ticketIds.length} ticket(s) and the account itself`
  );

  /**
   * Deleting active shipments out from under the counter leaves the agent's
   * capacity reserved for work that no longer exists — and once it reaches the
   * ceiling the agent silently stops being offerable, which reads as a bug in
   * assignment rather than as debris from a seed. Reconcile from the shipments
   * themselves, the same backstop the nightly sweep uses.
   */
  if (world) {
    const { before, after, drifted } = await agentCapacityService.reconcile(world.agentId.toString());
    if (drifted) log(`   🔄 agent capacity counter corrected ${before} → ${after}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The account itself
// ─────────────────────────────────────────────────────────────────────────────
async function seedAccount(): Promise<void> {
  section('Account');

  /**
   * A password nobody knows, exactly as `POST /auth/register` produces for a
   * customer. It is generated, hashed and dropped — never printed, never
   * returned, never stored in plaintext.
   *
   * This is the point of the whole feature rather than an inconvenience to work
   * around: `POST /auth/login` will always refuse this account, which is why the
   * storefront must not show a customer a password field at all. If you want a
   * password on some OTHER local account, `scripts/dev-set-password.ts` is the
   * tool and it refuses to run outside development.
   */
  const passwordHash = await bcrypt.hash(generateSystemPassword(), 10);

  await UserModel.create({
    _id: ID.user,
    login_email: ACCOUNT.email,
    login_phone: ACCOUNT.phone,
    password_hash: passwordHash,
    roles: ['customer'],
    status: 'active',
  });

  await CustomerModel.create({
    _id: ID.customer,
    user_id: ID.user,
    email: ACCOUNT.email,
    email_verified: true,
    phone: ACCOUNT.phone,
    phone_verified: true,
    name: ACCOUNT.name,
    bio: null,
    saved_addresses: [
      {
        label: 'Domicile',
        address_line1: 'Rue des Écoles, Bonamoussadi',
        address_line2: 'Immeuble Sokoa, 2e étage',
        city: 'Douala',
        state: 'Littoral',
        country: 'CM',
        is_default: true,
        location: HOME.coordinates,
        geo: HOME,
      },
      {
        label: 'Bureau',
        address_line1: 'Boulevard de la Liberté, Akwa',
        city: 'Douala',
        state: 'Littoral',
        country: 'CM',
        is_default: false,
        location: WORK.coordinates,
        geo: WORK,
      },
    ],
    preferences: {
      language: 'fr',
      currency: CURRENCY,
      marketing_opt_in: true,
      ai_tone: [],
      ads_compact_mode: false,
      compact_mode: false,
    },
    timezone: 'Africa/Douala',
    status: 'active',
  });

  log(`   ✅ ${ACCOUNT.name}`);
  log(`      phone  ${ACCOUNT.phone}   (redeems the code)`);
  log(`      email  ${ACCOUNT.email}   (redeems the code too)`);
  log('      2 saved addresses, both geocoded — Domicile is the checkout default');

  /**
   * The account is already "connected" on WhatsApp.
   *
   * `external_id` is BARE DIGITS because that is how Meta sends `wa_phone_id`,
   * and `LoginIdentityResolver` matches on that shape. Storing the E.164 form
   * here would look right and resolve nothing — the exact trap
   * `messagingPhoneToE164` was written for.
   *
   * The row is not needed to redeem the code minted below; it is here so that
   * the day the bot goes live, a real `/login` from this number resolves at
   * step 1 of the ladder rather than falling through to the WhatsApp-only
   * phone match.
   */
  await ChannelConnectionModel.create({
    user_id: ID.user,
    channel: 'whatsapp',
    external_id: ACCOUNT.waExternalId,
    display_name: ACCOUNT.name,
    handle: null,
    connected_at: new Date(),
    last_seen_at: new Date(),
  });
  log(`   🔗 WhatsApp connection bound to ${ACCOUNT.waExternalId} (bare digits, as Meta sends it)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment methods — gateway-managed references, which is all this ever stores
// ─────────────────────────────────────────────────────────────────────────────
async function seedPaymentMethods(): Promise<void> {
  section('Saved payment methods');

  /**
   * Owner-keyed on the CUSTOMER PROFILE id, not the user id — the controller
   * passes `req.auth.role_entity._id`, and a row keyed on the user id would be
   * invisible to every read.
   *
   * No PAN, no CVV, no real gateway token: the ids below are obvious fixtures.
   * The model stores only what a gateway hands back plus display metadata, and
   * `gateway_*` is never serialised to a client.
   */
  const methods = [
    {
      provider: 'mtn_momo',
      method_type: 'mobile_money' as const,
      display_label: 'MTN MoMo •••• 0001',
      brand: 'MTN',
      last4: '0001',
      is_default: true,
    },
    {
      provider: 'orange_money',
      method_type: 'mobile_money' as const,
      display_label: 'Orange Money •••• 0044',
      brand: 'Orange',
      last4: '0044',
      is_default: false,
    },
    {
      provider: 'notchpay',
      method_type: 'card' as const,
      display_label: 'VISA •••• 4242',
      brand: 'visa',
      last4: '4242',
      exp_month: 11,
      exp_year: 2029,
      holder_name: ACCOUNT.name,
      is_default: false,
    },
  ];

  for (const [index, method] of methods.entries()) {
    await UserPaymentMethodModel.create({
      owner_role: 'customer',
      owner_id: ID.customer,
      gateway_customer_id: `seed_cus_7e57_${index}`,
      gateway_instrument_id: `seed_pm_7e57_${index}`,
      exp_month: null,
      exp_year: null,
      holder_name: null,
      ...method,
    });
    log(`   💳 ${method.display_label.padEnd(26)} ${method.is_default ? '(default)' : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue history — saved items and things they looked at
// ─────────────────────────────────────────────────────────────────────────────
async function seedCatalogHistory(picks: Pick[]): Promise<void> {
  section('Wishlist & recently viewed');

  // Both collections dedupe on a unique compound index rather than on a read
  // before the write, so an upsert is the correct shape here too.
  for (const pick of picks.slice(0, 4)) {
    await WishlistItemModel.updateOne(
      { customer_id: ID.customer, product_id: new Types.ObjectId(pick.productId) },
      { $setOnInsert: { customer_id: ID.customer, product_id: new Types.ObjectId(pick.productId) } },
      { upsert: true }
    );
  }
  log(`   ❤️  ${Math.min(4, picks.length)} saved item(s)`);

  // `viewed_at` is what orders this list, and a repeat view moves an entry to
  // the head. Stagger it so the list is not one flat timestamp.
  let minutesAgo = 5;
  for (const pick of picks.slice(0, 6)) {
    const viewedAt = new Date(Date.now() - minutesAgo * 60_000);
    await RecentlyViewedItemModel.updateOne(
      { customer_id: ID.customer, product_id: new Types.ObjectId(pick.productId) },
      {
        $set: { viewed_at: viewedAt },
        $setOnInsert: { customer_id: ID.customer, product_id: new Types.ObjectId(pick.productId) },
      },
      { upsert: true }
    );
    minutesAgo += 47;
  }
  log(`   👀 ${Math.min(6, picks.length)} recently viewed`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkout helpers — every one drives the real API path
// ─────────────────────────────────────────────────────────────────────────────

/** Put one line in the cart and check out, exactly as the storefront would. */
async function checkout(
  pick: Pick,
  quantity: number,
  paymentMethod: 'online' | 'cash_on_delivery',
  dropOff: IGeoAddress | null
): Promise<{ order: IOrder; shipment: IShipment | null }> {
  await CartModel.findOneAndReplace(
    { userId: ID.customer.toString() },
    {
      userId: ID.customer.toString(),
      productType: 'physical',
      items: [
        {
          variantId: pick.variantId,
          sku: pick.sku,
          variantTitle: 'Default',
          optionsSnapshot: 'default',
          productId: pick.productId,
          title: pick.title,
          vendorId: pick.vendorId,
          productType: 'physical',
          quantity,
          price: pick.price,
          currency: CURRENCY,
        },
      ],
    },
    { upsert: true, new: true }
  );

  // `dropOff: null` deliberately exercises the OTHER branch of
  // `resolveDeliveryAddress` — the fall-through to the customer's default saved
  // address. Both paths are real checkout behaviour and both should be covered.
  const { orders } = await orderService.createOrdersFromCart(
    ID.customer.toString(),
    paymentMethod,
    dropOff ? { address: asInput(dropOff) } : undefined
  );

  const order = (await OrderModel.findById(orders[0]._id))!;
  const shipment = await ShipmentModel.findOne({ order_id: order._id });
  return { order, shipment };
}

/** Mark an online order paid through the real handler (stock commit + dispatch). */
async function pay(order: IOrder): Promise<IOrder> {
  await orderService.handlePaymentSuccess(String(order._id));
  return (await OrderModel.findById(order._id))!;
}

/** Push the shipment to the agency if the vendor's auto-redirect did not. */
async function dispatch(order: IOrder): Promise<IShipment> {
  let shipment = await ShipmentModel.findOne({ order_id: order._id });
  if (shipment && shipment.status === 'pending') {
    const vendor = await VendorModel.findById(order.vendor_id).lean();
    await orderService.dispatchToAgency(String(order._id), {
      type: 'vendor',
      id: vendor ? String(vendor.user_id) : null,
    });
    shipment = await ShipmentModel.findOne({ order_id: order._id });
  }
  return shipment!;
}

/**
 * Offer to the agent and get it accepted — binds the agent, reserves capacity.
 *
 * ⚠ **`autoAccepted` must be honoured, not ignored.** An agent with
 * `settings.auto_accept_assignments: true` has their offer accepted inside
 * `offerToAgent`, so a second explicit `accept()` finds a non-pending offer and
 * throws `409 SHIPMENT_OFFER_NOT_PENDING` — a failure that looks like a broken
 * assignment and is really a seed calling one step twice. Both agents on this
 * database exist (`b0…06` is false, `b0…07` is true), so which one
 * `findDeliveryWorld` happens to choose decided whether the run survived.
 */
async function offerAndAccept(world: DeliveryWorld, shipment: IShipment): Promise<IShipment> {
  const result = await shipmentAssignmentService.offerToAgent(
    world.agencyId.toString(),
    String(shipment._id),
    world.agentId.toString(),
    { role: 'agency', userId: world.agencyUserId.toString() }
  );

  if (!result.autoAccepted) {
    await shipmentAssignmentService.accept(world.agentId.toString(), result.offer.id);
  }

  return (await ShipmentModel.findById(shipment._id))!;
}

/** Agency-driven status transition, validated against TRIGGERABLE_TRANSITIONS. */
async function advance(
  world: DeliveryWorld,
  shipment: IShipment,
  status: 'picked_up' | 'in_transit' | 'agent_delivered' | 'failed'
): Promise<IShipment> {
  await shipmentService.updateStatus(
    world.agencyId.toString(),
    String(shipment._id),
    status,
    world.agencyUserId.toString()
  );
  return (await ShipmentModel.findById(shipment._id))!;
}

/** The plaintext COD code the customer holds. Never exposed by the API. */
async function deliveryCode(shipment: IShipment): Promise<string | null> {
  const collection = await CashCollectionModel.findOne({ shipment_id: shipment._id }).select(
    '+code_plain'
  );
  return collection?.code_plain ?? null;
}

interface OrderRow {
  n: number;
  label: string;
  order: IOrder;
  note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seven orders
// ─────────────────────────────────────────────────────────────────────────────
async function seedOrders(world: DeliveryWorld, picks: Pick[]): Promise<OrderRow[]> {
  const rows: OrderRow[] = [];

  // ── #1 · awaiting payment ─────────────────────────────────────────────────
  section('#1 — AWAITING PAYMENT (online, unpaid)');
  const o1 = await checkout(picks[0], 1, 'online', null);
  log('   💤 no payment yet — the shipment stays `pending`, nothing is dispatched');
  log('      drop-off resolved from the DEFAULT SAVED ADDRESS (no inline address passed)');
  rows.push({ n: 1, label: 'awaiting payment', order: o1.order, note: 'pay-now / checkout resume' });

  // ── #2 · paid, vendor preparing ───────────────────────────────────────────
  section('#2 — PROCESSING (paid, not yet dispatched)');
  const o2 = await checkout(picks[1], 2, 'online', null);
  const paid2 = await pay(o2.order);
  log('   💰 paid — stock committed, fulfillment `processing`');
  rows.push({ n: 2, label: 'processing', order: paid2, note: 'vendor is preparing it' });

  // ── #3 · out for delivery, live tracking ──────────────────────────────────
  section('#3 — IN TRANSIT (live tracking)');
  const o3 = await checkout(picks[2], 1, 'online', MAKEPE);
  const paid3 = await pay(o3.order);
  let s3 = await dispatch(paid3);
  s3 = await offerAndAccept(world, s3);
  s3 = await advance(world, s3, 'picked_up');
  s3 = await advance(world, s3, 'in_transit');
  log(`   🚚 out for delivery · tracking ${s3.tracking_number ?? '—'}`);
  log(`      dropping at ${MAKEPE.formatted_address}`);
  rows.push({
    n: 3,
    label: 'in transit',
    order: (await OrderModel.findById(paid3._id))!,
    note: `live tracking · ${s3.tracking_number ?? '—'}`,
  });

  // ── #4 · at the door, waiting on the customer ─────────────────────────────
  section('#4 — AGENT_DELIVERED (waiting for the customer to confirm)');
  const o4 = await checkout(picks[3], 1, 'online', null);
  const paid4 = await pay(o4.order);
  let s4 = await dispatch(paid4);
  s4 = await offerAndAccept(world, s4);
  s4 = await advance(world, s4, 'picked_up');
  s4 = await advance(world, s4, 'in_transit');
  s4 = await advance(world, s4, 'agent_delivered');
  log('   🚪 the agent says it arrived — a claim of arrival is not proof of one');
  log('      this is the CUSTOMER-facing confirm button, and it is prepaid-only:');
  log(`      POST /api/customer/orders/${o4.order._id}/shipments/${s4._id}/confirm`);
  rows.push({
    n: 4,
    label: 'awaiting confirmation',
    order: (await OrderModel.findById(paid4._id))!,
    note: 'the "confirm receipt" button',
  });

  // ── #5 · delivered, confirmed by the customer ─────────────────────────────
  section('#5 — DELIVERED (customer confirmed)');
  const o5 = await checkout(picks[4], 1, 'online', null);
  const paid5 = await pay(o5.order);
  let s5 = await dispatch(paid5);
  s5 = await offerAndAccept(world, s5);
  s5 = await advance(world, s5, 'picked_up');
  s5 = await advance(world, s5, 'in_transit');
  s5 = await advance(world, s5, 'agent_delivered');
  await shipmentService.confirmDeliveryByCustomer(
    ID.customer.toString(),
    String(paid5._id),
    String(s5._id),
    ID.user.toString()
  );
  log('   ✅ confirmed by the customer — the order completes with it, no second click');
  rows.push({
    n: 5,
    label: 'delivered',
    order: (await OrderModel.findById(paid5._id))!,
    note: 'history / reorder / review',
  });

  // ── #6 · cash on delivery, code outstanding ───────────────────────────────
  section('#6 — CASH ON DELIVERY (in transit, code outstanding)');
  const codPick = cheapestPick(picks);

  if (world.codHeadroom < codPick.price) {
    /**
     * Skipped, loudly, rather than attempted and thrown.
     *
     * `assertCanTakeCodShipment` would refuse this at accept time with
     * COD_AGENT_EXPOSURE_EXCEEDED, which on a development database is the normal
     * state rather than a fault: seeded agents accumulate undeposited cash, and
     * the ceiling is trust-scaled, so it shrinks under exposure already booked.
     * The other six orders are unaffected, so losing the whole account over this
     * one would be the wrong trade — and the remedy is named rather than left to
     * be worked out from a stack trace.
     */
    log(`   ⏭  SKIPPED — ${world.agentName} has ${money(world.codHeadroom)} of COD headroom`);
    log(`      and the cheapest order here is ${money(codPick.price)}.`);
    log('      Their cash ceiling is trust-scaled and counts pending collections, so this is');
    log('      ordinary wear on a development database, not a fault. To get this order:');
    log('        • settle their outstanding cash (an AgentDeposit), or');
    log('        • raise cod.threshold on their contract, or');
    log('        • run `npm run seed:cod-shipments -- --clean` to release the seeded exposure.');
    log('      Every other order below is unaffected.');
  } else {
    /**
     * Issuing a COD delivery code sends the customer a real WhatsApp message,
     * because this is the real path. The number is a fixture, so Meta answers
     * 502 and the app logs the whole axios error — several screens of it.
     *
     * It is announced rather than silenced: the send is genuinely best-effort
     * and the code is printed below regardless, but a wall of red text with no
     * warning reads as a failed seed. Suppressing `console.error` around this
     * call would also hide a real fault here, which is the wrong trade in a
     * script whose entire output is meant to be trusted.
     */
    log('   ⏳ issuing the delivery code — this sends a REAL WhatsApp message to a fake');
    log('      number, so Meta will 502 and the app will log a long axios error.');
    log('      That is expected. Everything below it is still good.');

    const o6 = await checkout(codPick, 1, 'cash_on_delivery', HOME);
    let s6 = await dispatch((await OrderModel.findById(o6.order._id))!);
    s6 = await offerAndAccept(world, s6);
    s6 = await advance(world, s6, 'picked_up');
    s6 = await advance(world, s6, 'in_transit');
    const code6 = await deliveryCode(s6);
    log(`   💵 ${money(codPick.price)} to collect at the door`);
    log('      the code below IS the customer\'s confirmation for COD — the "confirm"');
    log('      button of #4 refuses a COD shipment on purpose');
    rows.push({
      n: 6,
      label: 'COD in transit',
      order: (await OrderModel.findById(o6.order._id))!,
      note: code6 ? `delivery code ${code6}` : 'delivery code not issued',
    });
  }

  // ── #7 · cancelled ────────────────────────────────────────────────────────
  section('#7 — CANCELLED');
  const o7 = await checkout(picks[6], 1, 'online', null);
  const order7 = (await OrderModel.findById(o7.order._id))!;
  await orderService.cancelOrder(order7, {
    actorType: 'customer',
    actorId: ID.user.toString(),
    reason: 'Changed my mind',
  });
  log('   ❌ cancelled while unpaid — the held stock goes back');
  rows.push({
    n: 7,
    label: 'cancelled',
    order: (await OrderModel.findById(order7._id))!,
    note: 'cancelled state',
  });

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// A support ticket, raised by the customer against a real order
// ─────────────────────────────────────────────────────────────────────────────
async function seedTicket(rows: OrderRow[]): Promise<void> {
  section('Support ticket');

  const target = rows.find((r) => r.n === 4) ?? rows[0];

  const ticket = await TicketModel.create({
    subject: 'Le livreur est passé mais je n\'étais pas là',
    description:
      'Bonjour, la commande est marquée comme livrée par le livreur mais je ne l\'ai pas reçue. ' +
      'J\'étais au bureau à ce moment-là. Est-ce qu\'il peut repasser demain matin ?',
    type: TicketType.ORDER_FULFILLMENT,
    status: TicketStatus.WAITING_ON_ADMIN,
    priority: TicketPriority.NORMAL,
    importance: TicketImportance.HIGH,
    priority_locked: false,
    entity_type: EntityType.ORDER,
    entity_id: String(target.order._id),
    created_by_role: ActorRole.CUSTOMER,
    created_by_user_id: ID.user,
    updated_by: [ID.user],
  });

  await TicketFollowerModel.create({
    ticket_id: ticket._id,
    user_id: ID.user,
    role: ActorRole.CUSTOMER,
    // Required: a follower row records who ADDED it as well as who it is. The
    // customer followed their own ticket by raising it, so both are them.
    added_by_user_id: ID.user,
  });

  await TicketNoteModel.create({
    ticket_id: ticket._id,
    author_user_id: ID.user,
    author_role: ActorRole.CUSTOMER,
    // PUBLIC — a private note is the admin-only kind and would not render on
    // the customer's own ticket, which is the surface being seeded here.
    visibility: NoteVisibility.PUBLIC,
    // `content`, not `body`, and it is capped at 300 characters.
    content: 'Je suis joignable au +237 6 00 00 00 01 après 17h.',
  });

  log(`   🎫 ${ticket.subject}`);
  log(`      on order ${target.order.order_number ?? target.order._id} · status ${ticket.status}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Leave something in the cart, so the cart page is not an empty state
// ─────────────────────────────────────────────────────────────────────────────
async function seedCart(picks: Pick[]): Promise<void> {
  section('Cart');

  // Last, because `createOrdersFromCart` clears the cart on its way out — a cart
  // seeded before the orders would simply not be there afterwards.
  const items = picks.slice(0, 2).map((pick, index) => ({
    variantId: pick.variantId,
    sku: pick.sku,
    variantTitle: 'Default',
    optionsSnapshot: 'default',
    productId: pick.productId,
    title: pick.title,
    vendorId: pick.vendorId,
    productType: 'physical',
    quantity: index + 1,
    price: pick.price,
    currency: CURRENCY,
  }));

  await CartModel.findOneAndReplace(
    { userId: ID.customer.toString() },
    { userId: ID.customer.toString(), productType: 'physical', items },
    { upsert: true, new: true }
  );

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  log(`   🛒 ${items.length} line(s), ${money(total)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The credential — the whole point of the script
// ─────────────────────────────────────────────────────────────────────────────
async function mintAndPrint(): Promise<void> {
  /**
   * Re-read rather than trust the ids: `--code` runs against an account this
   * process did not create, and minting for a user that has since been deleted
   * would hand back a credential that fails its gate at redemption with a
   * confusing 401 instead of a clear message here.
   */
  const user = await UserModel.findById(ID.user).lean();
  const customer = await CustomerModel.findById(ID.customer).lean();

  if (!user || !customer) {
    throw new Error(
      'The test customer does not exist yet — nothing to mint a code for.\n' +
        '   Run `npm run seed:customer` first (this flag only mints).'
    );
  }
  if (user.status !== 'active') {
    throw new Error(`The test customer is '${user.status}', not 'active' — redemption would refuse it.`);
  }

  /**
   * `LoginSessionStore.issue` — the same call `/login` makes.
   *
   * `channel: 'whatsapp'` with the account's own bare-digits number as the
   * identity, so this shares the identity key with a real bot `/login`: minting
   * here revokes a bot-minted one and vice versa, and there is never more than
   * one live credential for this person.
   */
  const session = await loginSessionStore.issue({
    userId: String(user._id),
    customerId: String(customer._id),
    channel: 'whatsapp',
    externalIdentity: ACCOUNT.waExternalId,
    identityHint: `••••${ACCOUNT.phone.slice(-4)}`,
  });

  const expires = session.expiresAt.toLocaleTimeString('en-GB', { hour12: false });
  const magicUrl = `${STOREFRONT_URL}/login/magic?t=${session.token}`;

  log('');
  log('╔══════════════════════════════════════════════════════════════════════════╗');
  log('║  SIGN IN AS THE TEST CUSTOMER                                            ║');
  log('╚══════════════════════════════════════════════════════════════════════════╝');
  log('');
  log(`   CODE      ${session.code}`);
  log(`   valid     ${LOGIN_SESSION_TTL_SECONDS / 60} minutes — until ${expires} — SINGLE USE`);
  log('');
  log('   Type it on the storefront sign-in page with either identifier:');
  log(`     ${ACCOUNT.phone}`);
  log(`     ${ACCOUNT.email}`);
  log('');
  log(`   POST ${API_BASE}/api/auth/magic/code`);
  log(`     { "identifier": "${ACCOUNT.phone}", "code": "${session.code}" }`);
  log('     → sets access_token (15 min) + refresh_token (30 days), both HttpOnly.');
  log('       No tokens in the body. Cookie clients only.');
  log('');
  log(`   POST ${API_BASE}/api/auth/mobile/magic/code     ← Capacitor / native`);
  log('     same body → the pair comes back in `data.tokens`, no cookie set.');
  log('');
  log('   …or skip the code entirely and open the magic LINK:');
  log(`     ${magicUrl}`);
  log('     Your page reads ?t= and POSTs it to /api/auth/magic/link.');
  log('     Show a spinner, not a button — the user already expressed intent.');
  log('');
  log('   ⚠ Spending either one kills the other, and minting a new pair revokes');
  log('     this one. Out of time? Just run:  npm run seed:customer:code');
  log('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cleanOnly = process.argv.includes('--clean');
  const codeOnly = process.argv.includes('--code');
  const noOrders = process.argv.includes('--no-orders');

  await mongoose.connect(MONGO_URI);
  log(`✅ Connected to MongoDB (${MONGO_URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);

  // ── Mint-only: touches no document, so it skips everything below ──────────
  if (codeOnly) {
    await mintAndPrint();
    await mongoose.disconnect();
    process.exit(0);
  }

  /**
   * Resolve the world FIRST — before the cleanup, deliberately.
   *
   * A missing fixture is then reported while the previous run's account is still
   * standing. Discovering it after the wipe would leave you with no test account
   * at all and an error about something unrelated to what you asked for.
   *
   * `--no-orders` still resolves it: it costs one query round and keeps the
   * capacity reconciliation in cleanup pointed at the right agent.
   */
  const found = cleanOnly ? null : await findDeliveryWorld(PRODUCTS_NEEDED);
  const world = found?.world ?? null;

  await cleanup(world);
  if (cleanOnly) {
    log('\n✨ Clean complete (--clean). Nothing seeded.');
    await mongoose.disconnect();
    process.exit(0);
  }

  section('Preconditions');
  log(`   ✅ agency  ${world!.agencyId}  ${world!.agencyName}`);
  log(`   ✅ agent   ${world!.agentId}  ${world!.agentName}`);
  log(`      COD ceiling ${money(world!.codThreshold)} · headroom left ${money(world!.codHeadroom)}`);

  /**
   * server.ts registers this at boot. Without it the orders below emit events
   * nobody listens to and the customer's notification list comes out empty —
   * which is one of the surfaces being seeded.
   *
   * Safe to run: customer notification preferences default to in-app only, so
   * nothing here dials out. (The COD delivery code is a different path and DOES
   * send a real WhatsApp message — see the header.)
   */
  initializeCustomerNotificationEventConsumers();

  await seedAccount();
  await seedPaymentMethods();

  if (noOrders) {
    log('\n   ⏭  --no-orders: skipping the shopping history');
  } else {
    const picks = found!.picks;
    await seedCatalogHistory(picks);
    const rows = await seedOrders(world!, picks);
    await seedTicket(rows);
    await seedCart(picks);

    section('Orders');
    log('');
    log('  #  state                   order number        note');
    log('  ─  ──────────────────────  ──────────────────  ────────────────────────────────');
    for (const row of rows) {
      log(
        `  ${row.n}  ${row.label.padEnd(22)}  ${String(row.order.order_number ?? row.order._id).padEnd(18)}  ${row.note}`
      );
    }

    const unread = await CustomerNotificationModel.countDocuments({ customerId: ID.customer });
    log('');
    log(`   🔔 ${unread} in-app notification(s) generated by the flows above`);
  }

  await mintAndPrint();

  /**
   * `process.exit` rather than falling off the end: the notification consumers
   * registered above hold event-bus subscriptions, and mongoose's connection
   * pool keeps the loop alive. Without this the script prints everything and
   * then appears to hang — same reason `seed-cod-shipments.ts` does it.
   */
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('\n❌ Failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 5).join('\n'));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
