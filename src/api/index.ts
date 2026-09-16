import express from 'express';
import { commandBus } from '../modules/command-bus/instance';
import { authRouter } from '../modules/auth/auth.routes';
import { browserAuthRoutes } from '../modules/auth/routes/browser-auth.routes';
import { mobileAuthRoutes } from '../modules/auth/routes/mobile-auth.routes';
import { messagingLoginRoutes } from '../modules/messaging-login/messaging-login.routes';
import { mobileMessagingLoginRoutes } from '../modules/messaging-login/mobile-messaging-login.routes';
import { createWhatsappRouter } from '../modules/whatsapp/whatsapp.routes';
import { createTelegramRouter } from '../modules/telegram/telegram.routes';
import { googleRoutes } from '../modules/integrations/calendar/google/google.routes';
import { productBookingRouter } from '../modules/catalog/routes/product-booking.routes';
import { paymentRouter, paymentWebhookRouter } from '../modules/payments';
import { bookingPaymentRouter } from '../modules/booking/routes/booking-payment.routes';
import vendorBookingRoutes from '../modules/booking/routes/vendor-booking.routes';
import customerBookingRoutes from '../modules/booking/routes/customer-booking.routes';

/**
 * ⚠ This import MUST stay at the top of the file, unlike almost every other one here.
 *
 * The rest of this module deliberately interleaves `import` with the `router.use` it feeds,
 * which reads well and is harmless — as long as the import precedes its use. This one did
 * not: it sat beside `fileRoutes` near the bottom while
 * `router.use('/auth', authBucketDispatcher)` runs a few lines below, at the top.
 *
 * TypeScript's CommonJS emit does NOT hoist imports — it emits `const rate_limit_middleware_1
 * = require(...)` exactly where the import appears — and `target` here is `es2020`, so the
 * binding is a `const` in its temporal dead zone until then. The result was
 * `ReferenceError: Cannot access 'rate_limit_middleware_1' before initialization`, thrown
 * while loading this module: the whole API failed to boot. `tsc` cannot catch it, because it
 * type-checks against ES semantics, where imports ARE hoisted.
 *
 * If you add an import that a `router.use` above it consumes, put it here.
 */
import { authBucketDispatcher, publicRateLimiter } from './rate-limit/rate-limit.middleware';

const router = express.Router();

/**
 * ── `adminActionLogMiddleware` was mounted here, and it is GONE (Phase 5 Part E) ─────
 *
 * Three mounts recorded every request to jovi-mall's legacy admin surface: `use('/admin', …)`
 * covering the whole prefix, plus named mounts on `/files` and `/webhooks/telegram` for the
 * three admin-only endpoints that lived outside it on public-looking paths. Parts B and C
 * ported those three and took their two mounts with them; the cutover takes the last one,
 * because the prefix it matched no longer exists.
 *
 * ⚠ **The collection, the model, the recorder and `AuditLogger` all SURVIVE, and deleting
 * them would break a live path** (Phase 5 D-7). `AuditLogger.log` routes any entry whose
 * `actor.role === 'admin'` into `admin_action_log`, and `AdminAgencyService.deactivate` /
 * `reactivate` hardcode `actor: { userId, role: 'admin' }` — reached over
 * `/api/internal/admin/agencies`, which is the surface that survives. What went is the
 * COARSE `source: 'request'` row this middleware wrote; the deliberate, named rows stay.
 *
 * The middleware never covered `/internal/admin/*`, deliberately: those are wi-admin's
 * delegated calls, already audited there against a real administrator identity, and
 * recording them here would have double-counted every ported operation. That reasoning is
 * now the whole story rather than half of it — **after cutover every row still written to
 * `admin_action_log` duplicates a wi-admin audit row for the same operation.** Whether
 * `AuditLogger` should stop writing them is a follow-up (Phase 5 O-6), not part of this
 * change: it is a decision about that class's branching, not about the mounts.
 */

// Shared middleware and routes can be exported from here
// export * from './middlewares';
// export * from './utils';

/**
 * Initialize Command System.
 *
 * ⚠ The bus itself moved to `modules/command-bus/instance.ts` and is re-exported here, so
 * nothing that imported it from this file had to change. It had to move because the typed
 * slash-command router is mounted on the bot surface, and importing the bus from here would
 * close the cycle `api/index` → `bot.routes` → `bot-commands` → `api/index`.
 */
export { commandBus } from '../modules/command-bus/instance';

/**
 * One rate-limit mount in front of ALL FIVE auth routers, choosing between two buckets.
 * (`authRouter`, `browserAuthRoutes`, `mobileAuthRoutes`, `messagingLoginRoutes` and
 * `mobileMessagingLoginRoutes` — this said "ALL THREE" until 2026-09-07 and predated the two
 * magic-login mounts below.)
 *
 * The credential bucket is the only strict limit in the service — 20 per minute per IP, where
 * everything else is in the hundreds. The two kinds of limit protect against different things:
 * the global ceilings are a runaway-loop backstop, this is a security control. It bounds one
 * source spraying a common password across many accounts, which is precisely the attack an
 * account-level lockout cannot see, because every individual account sees only one or two
 * attempts. jovi-mall had neither control until Phase 16; `PHASE-0-DISCOVERY` recorded it as
 * finding A6, "No login throttling, lockout, or failed-attempt record."
 *
 * `authBucketDispatcher` sends the paths that merely EXTEND a session — the two refresh
 * routes, `/me`, both `auth-me`s — to a second, looser counter, so app-launch and token-renewal
 * traffic can no longer exhaust the counter guarding the login form. Which paths, and why the
 * list is an allowlist so a new route inherits the strict bucket, is in
 * `rate-limit/auth-paths.ts`.
 *
 * Mounted here rather than inside each router so it covers registration, password reset and
 * verification-code resend as well as login — every path that takes a credential or sends
 * one out, including the ones added later.
 */
router.use('/auth', authBucketDispatcher);
router.use('/auth', authRouter);
router.use('/auth/browser', browserAuthRoutes);  // Browser session auth
router.use('/auth/mobile', mobileAuthRoutes);    // Bearer auth for WebView / native clients
/**
 * Passwordless sign-in redemption — the two credentials `/login` hands out in a chat.
 *
 * Under `/auth` on purpose: these present a bearer secret and mint a session, so they are
 * credential endpoints and must inherit the strict 20/min bucket from the dispatcher above.
 * `rate-limit/auth-paths.ts` is an allowlist, so not naming them there IS how they get it.
 */
router.use('/auth/magic', messagingLoginRoutes);
/**
 * The bearer twin of the two routes above, for the customer app.
 *
 * Mounted BEFORE nothing and AFTER `/auth/mobile` deliberately — `router.use`
 * falls through when no route inside matches, and `mobileAuthRoutes` declares no
 * `/magic/*`, so either order works. It sits here, beside the cookie twin it
 * mirrors, because that is where someone changing one will look for the other.
 *
 * Same bucket as the cookie pair, and by the same mechanism: the dispatcher on
 * `/auth` covers this path, and `rate-limit/auth-paths.ts` names neither it nor
 * any prefix that would cover it, so it stays at the strict 20/min. The two
 * `/auth/mobile/*` entries that ARE named there match on the full anchored path
 * and do not reach `/auth/mobile/magic`.
 */
router.use('/auth/mobile/magic', mobileMessagingLoginRoutes);
router.use('/webhooks/whatsapp', createWhatsappRouter(commandBus));
router.use('/webhooks/telegram', createTelegramRouter(commandBus));  // Telegram webhook
router.use('/webhooks', paymentWebhookRouter);  // Payment gateway webhooks
router.use('/integrations/google', googleRoutes);
router.use('/products', productBookingRouter);
router.use('/payments', paymentRouter);  // Payment API endpoints

// Booking payment routes (customer-facing: initiate payment, check status)
router.use('/bookings', bookingPaymentRouter);

// Customer booking self-service (list, detail, cancel, reschedule).
// Mounted beside /customer/orders — the equivalent surface for physical goods.
router.use('/customer/bookings', customerBookingRoutes);

// Customer notification inbox + channel preferences (the fourth stack).
import customerNotificationRoutes from '../modules/notifications/routes/customer-notification.routes';
router.use('/customer/notifications', customerNotificationRoutes);

// Vendor routes
import vendorRoutes from '../modules/vendor/routes';
router.use('/vendor', vendorRoutes);

// Vendor booking management routes (bookings, calendar view, reschedule, cancel, etc.)
router.use('/vendor/bookings', vendorBookingRoutes);

// Store routes (also under /vendor path)
import storeRoutes from '../modules/store/routes';
router.use('/vendor/store', storeRoutes);

// Magazin routes — the agency's business surface (Store-equivalent for agencies)
import magazinRoutes from '../modules/magazin/routes';
router.use('/agency/magazin', magazinRoutes);

// Agency inventory — which SKUs this agency warehouses, at which depot
import agencyInventoryRoutes from '../modules/inventory/routes';
router.use('/agency/inventory', agencyInventoryRoutes);

// ─── Storage statements (Phase 6 · Step 14, D-7) ─────────────────────────────
// A monthly RECORD of warehousing rent, per (agency, vendor). No money moves through
// either mount: the platform is not a party to this rent and neither collects nor pays it.
// The agency issues and settles; the vendor reads. Two routers rather than one mounted
// twice — a Router instance re-runs its own `use` guards on a second mount.
import { agencyStorageInvoiceRoutes, vendorStorageInvoiceRoutes } from '../modules/inventory/storage-invoice.routes';
router.use('/agency/storage-invoices', agencyStorageInvoiceRoutes);
router.use('/vendor/storage-invoices', vendorStorageInvoiceRoutes);

// Vendor product management routes
import vendorProductsRoutes from '../modules/catalog/routes/vendor-products.routes';
router.use('/vendor/products', vendorProductsRoutes);

// Vendor inventory management routes
import vendorInventoryRoutes from '../modules/catalog/routes/vendor-inventory.routes';
router.use('/vendor/inventory', vendorInventoryRoutes);

// Stock-adjustment requests — the two-sided gate on `variant.stock` for SKUs an
// agency warehouses. Two mirrored routers; the verbs mean the same on both sides.
import vendorStockRequestRoutes from '../modules/stock-requests/routes/vendor-stock-request.routes';
import agencyStockRequestRoutes from '../modules/stock-requests/routes/agency-stock-request.routes';
router.use('/vendor/stock-requests', vendorStockRequestRoutes);
router.use('/agency/stock-requests', agencyStockRequestRoutes);

// Billing: pricing plans & credit wallet — same engine for vendor, agency & agent.
// Mounted at the role roots so endpoints read as /vendor/plans, /agency/plans,
// /agent/plans, /admin/plans (no extra /billing segment).
import vendorBillingRoutes from '../modules/billing/routes/vendor-billing.routes';
import agencyBillingRoutes from '../modules/billing/routes/agency-billing.routes';
import agentBillingRoutes from '../modules/billing/routes/agent-billing.routes';
router.use('/vendor', vendorBillingRoutes);
router.use('/agency', agencyBillingRoutes);
router.use('/agent', agentBillingRoutes);
// `/admin` was the fourth. Deleted at the cutover (Phase 5 Part E) — wi-admin reaches the
// SAME router through `buildAdminBillingRouter([requireAdminCaller])` on
// `/api/internal/admin`. The factory stays; only the public instantiation went.

// ─── Public (unauthenticated) ────────────────────────────────────────────────
// The published price list, for the marketing site — which prints real prices and
// until now had to hand-copy them out of the seed script because every plan
// endpoint sat behind requireAuth. Read-only, no identity, nothing owner-scoped.
//
// ⚠️ `/public` is the ONE mount with no auth guard anywhere above or below it.
// Anything added under this prefix is world-readable with no further review, so a
// router mounted here must contain only reads of already-published data. See the
// header of public-billing.routes.ts.

// The storefront bucket, in front of EVERY public router — mounted first, for the
// same reason the credential bucket is: a prefix mount cannot miss a route, including
// ones added later. `/public` is the only anonymous read surface with real traffic
// volume (a product grid fires two calls per page view), and without its own counters
// it shares Layer A's single IP bucket with every other caller on the address — so a
// crawler on an office NAT would 429 the signed-in shoppers sitting beside it.
// Layer A still applies on top; this is a separate bucket, not a replacement.
router.use('/public', publicRateLimiter);

import publicBillingRoutes from '../modules/billing/routes/public-billing.routes';
router.use('/public', publicBillingRoutes);

// The blog, for the marketing site's article pages. Same prefix, same rules — published
// prose only, five-minute cache, no identity. Two routers on one prefix is fine: their
// paths do not overlap, and Express falls through the first when nothing matches.
// The editor's side is NOT in this service: it is wi-admin's /api/v1/content, which writes
// these collections directly (ADR-004 D-4). This line claimed it was "mounted below behind
// requireRole(['admin'])" until 2026-08-25 — contradicting the comment at the old mount point
// further down this same file, which correctly says the editor USED to mount there.
import publicBlogRoutes from '../modules/blog/routes/public-blog.routes';
router.use('/public', publicBlogRoutes);

// The storefront's read side — products, categories and stores, for the shop at
// /shop/*. Same prefix, same rules: only products a vendor has deliberately put on
// sale, only stores that sell one, five-minute cache, no identity. This is the third
// router on the prefix; the paths do not overlap (/products, /categories, /stores vs
// /plans, /credit-packs, /articles*).
//
// Visibility for every route here is decided by ONE predicate —
// catalog/domain/services/public-catalog.filter.ts. The vendor's own catalogue stays
// on /api/vendor/products behind requireRole(['vendor']).
import publicCatalogRoutes from '../modules/catalog/routes/public-catalog.routes';
router.use('/public', publicCatalogRoutes);

// The platform's OWN images — one file, the stand-in for a product with no photograph. The
// FIFTH router on this prefix; it declares only `/assets/no-product-image.png`, which none of
// the four above has a route for. Declared by name rather than mounted as a directory, and
// deliberately not a second `express.static` in this file — see the router's own header, and
// the `test:uploads` note beside the storage mount at the bottom.
import botPublicAssetRoutes from '../modules/bot-surface/public-assets.routes';
router.use('/public', botPublicAssetRoutes);

// Published product reviews, for the product page's review tab and its rating
// histogram. The FOURTH router on this prefix; it declares only
// `/products/:productId/reviews`, which the catalog router above has no route for,
// so Express falls through to it. Same rules as its three neighbours: published data
// only, five-minute cache, no identity.
//
// ⚠ Product reviews ONLY. A delivery review names an agent and stays inside the
// platform — see public-review.routes.ts.
import publicReviewRoutes from '../modules/reviews/routes/public-review.routes';
router.use('/public', publicReviewRoutes);

// The agent app's APK download — the SIXTH router on this prefix. Declares only
// `/app/:app/latest` and `/app/:app/download`, which none of the five above has a route for.
//
// ⚠ **`/download` answers a 302 and never the bytes.** The artefact is ~79 MB and lives in
// the public `app-releases` storage tree, so it is served by the CDN (or, under
// `STORAGE_PROVIDER=local`, by the `express.static` mount at the bottom of this file) and
// never through this event loop. `modules/app-distribution/services/app-release.service.ts`
// carries the reasoning and what the choice costs.
//
// Same rules as its neighbours otherwise: published data only, five-minute cache, no
// identity, no write. NOT on the maintenance exemption list — a `readonly` window leaves the
// download working (it is a read) and a `down` window refuses it, which is the same verdict
// the storefront gets and the right one: nothing cross-service depends on this path.
import publicAppReleaseRoutes from '../modules/app-distribution/routes/public-app-release.routes';
router.use('/public', publicAppReleaseRoutes);

// Earnings: commission/escrow ledger. Vendor sees held vs withdrawable balances;
// agency sees its own held vs withdrawable delivery-fee balance; agent sees their
// cut of the delivery fees on runs they completed; admin sees the platform
// commission account. Mounted at the role roots → /vendor/earnings,
// /agency/earnings, /agent/earnings, /admin/earnings/platform.
import vendorEarningsRoutes from '../modules/earnings/routes/vendor-earnings.routes';
import agencyEarningsRoutes from '../modules/earnings/routes/agency-earnings.routes';
import agentEarningsRoutes from '../modules/earnings/routes/agent-earnings.routes';
router.use('/vendor', vendorEarningsRoutes);
router.use('/agency', agencyEarningsRoutes);
router.use('/agent', agentEarningsRoutes);
// `/admin/earnings` (the platform commission account) was here. Deleted at the cutover
// (Phase 5 Part E); wi-admin reaches the same router on `/api/internal/admin`.

// Payout requests: vendor/agency/agent request a withdrawal of their entire
// available balance, which opens a PAYOUT_REQUEST ticket for admins to process.
// /vendor/earnings/payout, /agency/earnings/payout, /agent/earnings/payout are mounted
// above alongside earnings. The admin PROCESSING queue was `/admin/payout-requests` and is
// deleted at the cutover — it now lives at `/api/v1/money` in wi-admin, which reaches this
// service's factory over `/api/internal/admin`.

// Unified transactions feed (merges plan purchases, credit top-ups, credit usage
// and earnings into one history) — same engine for vendor, agency & agent.
import vendorTransactionRoutes from '../modules/transactions/routes/vendor-transaction.routes';
import { agencyTransactionRouter, agentTransactionRouter } from '../modules/transactions/routes/subscriber-transaction.routes';
router.use('/vendor/transactions', vendorTransactionRoutes);
router.use('/agency/transactions', agencyTransactionRouter);
router.use('/agent/transactions', agentTransactionRouter);

// Customer shopping cart (add/get/remove/clear; checkout lives under /customer/orders)
import customerCartRoutes from '../modules/cart/routes';
router.use('/customer/cart', customerCartRoutes);

// Customer order actions (e.g. confirm delivery → completes order, starts escrow hold)
import customerOrderRoutes from '../modules/orders/customer-order.routes';
router.use('/customer/orders', customerOrderRoutes);

// ─── Reviews & ratings ───────────────────────────────────────────────────────
// One module, two subjects, three author roles. A customer reviews a PRODUCT they
// bought and a DELIVERY they received; a vendor and an agency review a delivery only.
// All three delivery reviews land on the same agent in three separate aggregates,
// which is what finally gives the trust composite its 50 weight of rating factors.
//
// Three mounts rather than one because the author's role comes from the MOUNT, never
// from the request body — see controllers/review.controller.ts. Each shares its role
// prefix with routers mounted earlier in this file; none of them declares `/reviews`,
// and Express falls through a `use`-mounted router when nothing inside it matches.
import customerReviewRoutes from '../modules/reviews/routes/customer-review.routes';
import vendorReviewRoutes from '../modules/reviews/routes/vendor-review.routes';
import agencyReviewRoutes from '../modules/reviews/routes/agency-review.routes';
router.use('/customer/reviews', customerReviewRoutes);
router.use('/vendor/reviews', vendorReviewRoutes);
router.use('/agency/reviews', agencyReviewRoutes);

// Customer digital-product delivery: mint download links, execute downloads
// (single-use token in the URL), and list the purchased library. Mounted at
// /api/digital because generated download URLs are /api/digital/download/:token.
// Entitlements are granted post-payment by OrderService → digital-fulfillment.
import { createCustomerDigitalRoutes } from '../modules/digital-delivery/routes/customer.routes';
import { DigitalEntitlementService } from '../modules/digital-delivery/services/digital-entitlement.service';
import { DownloadLinkService } from '../modules/digital-delivery/services/download-link.service';
import { DownloadExecutionService } from '../modules/digital-delivery/services/download-execution.service';
import { getStorageProvider } from '../core/storage';
router.use('/digital', createCustomerDigitalRoutes(
  new DigitalEntitlementService(),
  new DownloadLinkService(),
  new DownloadExecutionService(getStorageProvider()),
));

// `/admin/orders` (the payment-dispute hold: list frozen orders, manual resolve) was mounted
// here and is deleted at the cutover (Phase 5 Part E). `buildAdminOrderRouter` survives with
// its `'internal'` instantiation on `/api/internal/admin/orders`, which is what wi-admin's
// `/api/v1/orders/disputes` reaches.

// Ticketing Module Routes
//
// ⚠ There is deliberately NO `/admin/tickets` mount. The admin ticket surface moved to
// wi-admin (Phase 17) and is reachable only at `/api/internal/admin/tickets`, behind the
// service token. Unlike the other ported domains this one kept no public twin: the old
// mount's only access control was the `assigned_admin_id` exclusivity lock, which is gone,
// and it could not enforce the tier rules that replaced it — a legacy `admin` is a platform
// user and carries no tier. See `modules/tickets/routes/admin-ticket.routes.ts`.
import {
    vendorTicketRoutes,
    customerTicketRoutes,
    agencyTicketRoutes,
    agentTicketRoutes
} from '../modules/tickets';

router.use('/vendor/tickets', vendorTicketRoutes);
router.use('/customer/tickets', customerTicketRoutes);
router.use('/agency/tickets', agencyTicketRoutes);
router.use('/agent/tickets', agentTicketRoutes);

// Vendor <-> Agency consensual connections (request/approve linkage)
import { vendorConnectionRoutes, agencyConnectionRoutes } from '../modules/agency-connections';
router.use('/vendor/agency-connections', vendorConnectionRoutes);
router.use('/agency/vendor-connections', agencyConnectionRoutes);

// Live-tracking authorization resolution — consumed by the geo-tracker service
// (forwarding the caller's token) to learn which agents the caller may track.
import trackingRoutes from '../modules/tracking-integration/routes/tracking.routes';
router.use('/tracking', trackingRoutes);

// Geocoding: address search + reverse geocoding (Google-Maps-style workflow).
// Provider-agnostic (GEO_PROVIDER); backs every role's address entry. Any
// signed-in user may search — see modules/geo.
import geoRoutes from '../modules/geo/routes';
router.use('/geo', geoRoutes);

// Customer profile routes
import customerRoutes from '../modules/customers/routes';
router.use('/customer', customerRoutes);

// Delivery Agency profile routes
import agencyRoutes from '../modules/delivery/agency.routes';
router.use('/agency', agencyRoutes);

// Delivery Agent work routes (shipments, COD)
import agentRoutes from '../modules/delivery/agent.routes';
router.use('/agent', agentRoutes);

// ─── Agent domain ────────────────────────────────────────────────────────────
// The agent's own record: profile, onboarding, availability, working state,
// device capabilities, preferences/settings, tracking-allow, and agent↔agency
// memberships (an agent may serve several agencies at once).
//
// `agentSelfRoutes` shares the /agent prefix with the work routes above; the
// two never overlap (this one owns the agent aggregate, that one owns work).
//
// ⚠️ FOUR routers now stack on /agent — billing (:68), earnings (:82), work
// (:168) and this one. Express matches them in MOUNT ORDER, so the earliest
// mount wins a shared path and the later handler becomes dead code with no
// warning at boot and no error at request time. This bit once: both billing and
// this router declared `/settings`, billing won, and the agent-domain handler
// was unreachable for as long as it existed — a request meant for it 400'd on
// billing's schema instead. Before adding a path here, check it against
// agent-billing.routes.ts, agent-earnings.routes.ts and delivery/agent.routes.ts.
//
// Imported from their files rather than the module barrel: routers depend on
// auth.middleware, which depends on auth.service, which imports the barrel —
// re-exporting routes from it closes a require cycle that crashes at boot.
import agentSelfRoutes from '../modules/agents/routes/agent.routes';
import agencyRosterRoutes from '../modules/agents/routes/agency-roster.routes';
import internalAgentRoutes from '../modules/agents/routes/internal-agent.routes';
import internalShipmentRoutes from '../modules/shipments/internal-shipment.routes';
import internalAdminRoutes from './routes/internal-admin.routes';
import { buildKycRouter } from '../modules/identity-verification/routes/kyc.routes';
router.use('/agent', agentSelfRoutes);
router.use('/agency/agents', agencyRosterRoutes);

/**
 * Identity verification — the same surface for all three roles, from one factory.
 *
 * ⚠ **Three SEPARATE Router instances, never one mounted three times.** `buildKycRouter`
 * attaches `requireRole([role])` with `router.use`, and a shared instance would re-run every
 * one of those guards on every mount — so an agent would be required to be a vendor as well.
 * Same reason `buildAdminCodRouter(guards)` is a factory.
 *
 * Mounted here rather than inside each role's own router because the surface is genuinely one
 * thing: a slot vocabulary, a lock rule and an upload policy that must not differ by role. See
 * `modules/identity-verification/domain/kyc-subject.ts`.
 */
router.use('/vendor/kyc', buildKycRouter('vendor'));
router.use('/agency/kyc', buildKycRouter('agency'));
router.use('/agent/kyc', buildKycRouter('agent'));
// `/admin/agents` was here. Deleted at the cutover (Phase 5 Part E); the same factory is
// instantiated with `[requireAdminCaller]` on `/api/internal/admin/agents`.

// Service-to-service API consumed by geo-tracker (shared-secret auth, not a
// user session). jovi-mall answers "may this agent be tracked?"; geo-tracker
// owns tracking execution. Disabled entirely when INTERNAL_SERVICE_TOKEN is unset.
router.use('/internal/agents', internalAgentRoutes);

// The second geo-tracker door, same guard and same fail-closed rule: the
// geocoded DROP-OFF, so geo-tracker can route and estimate an arrival time.
// jovi-mall owns the address (an address is order data — the governing rule in
// ../CLAUDE.md); geo-tracker owns the road network. Read-only, deliberately:
// there is no shipment write a service that has no shipment model should make.
router.use('/internal/shipments', internalShipmentRoutes);

/**
 * The CURATED BOT SURFACE — the door the automation layer acts through (GAP-001).
 *
 * The third member of the `/internal` family, and the only one whose caller acts on a
 * PERSON's behalf rather than on its own. geo-tracker asks about agents and shipments;
 * wi-admin acts as an administrator. This one carries a messaging identity and the
 * backend resolves the customer from it — so every route below reaches a cart, an order,
 * an address or a support ticket that belongs to somebody.
 *
 * ⚠ **TWO credentials guard it, not one.** `INTERNAL_SERVICE_TOKEN` (the same value
 * geo-tracker presents on the two mounts above) AND `BOT_WEBHOOK_SECRET` (the same value
 * the bot webhooks require). A leaked service token alone opens the agent and shipment
 * surfaces; it must not also open every customer's basket and order history. The two
 * secrets are held by different parts of the deployment and rotate on different
 * schedules. Both guards live inside `bot.routes.ts`, beside the identity resolution and
 * the idempotency store, so the whole chain reads in one place.
 *
 * ⚠ **NO customer bearer token is ever issued to the automation layer**, and there is no
 * endpoint here that could produce one. That is the load-bearing half of the design: a
 * passwordless customer has no session-revocation path at all — `password_changed_at` is
 * this service's only lever and a customer who never reset has never set it — so a
 * compromised n8n must not be able to hold customer sessions.
 *
 * ⚠ **It is NOT on the maintenance exemption list**, unlike `/internal/agents`,
 * `/internal/shipments` and `/tracking`. Those are exempt because blocking them turns a
 * jovi-mall maintenance window into a geo-tracker outage. A chat bot has no such
 * property, so it is blocked in `down` and read-only in `readonly` like the ordinary
 * customer surface — see `modules/system/domain/maintenance-mode.ts`, which reads this
 * module's route table to tell a bot read from a bot write.
 */
import botRoutes from '../modules/bot-surface/bot.routes';
router.use('/internal/bot', botRoutes);

/**
 * The Telegram Mini App — the bot surface's ONE browser-facing door, and deliberately not
 * part of it.
 *
 * ⚠ **It carries NEITHER of the two credentials above, and it must never be moved under
 * `/internal/bot` to gain them.** The whole point of the pair is that they are held by the
 * automation layer and by nothing else; a page served to a customer's phone cannot hold one
 * without handing every viewer the entire bot surface. What authorises a request here is an
 * opaque handle in the URL that names one conversation's product list for thirty minutes and
 * resolves to a customer the backend already knows — the posture `pay-link.ts` established
 * for the unauthenticated payment page.
 *
 * Its own IP bucket (`publicRateLimiter`, inside the router), and NOT on the maintenance
 * exemption list — a `readonly` window leaves the page readable and refuses its cart write,
 * which is the same verdict the storefront gets.
 */
import miniAppRoutes from '../modules/bot-surface/miniapp/miniapp.routes';
router.use('/bot/miniapp', miniAppRoutes);

/**
 * The VECTORISER door — the fourth member of the `/internal` family (README
 * `api-doc/n8n/vectoriser/README.md` § 4).
 *
 * Same guard as the two geo-tracker mounts above: `requireServiceToken` on the
 * existing INTERNAL_SERVICE_TOKEN, one credential rather than the bot surface's
 * two — see the routes file for why the value class here does not warrant a
 * second secret.
 *
 * It exists because the vectoriser went ASYNCHRONOUS. `POST <base>` answers 202
 * and reports each product's outcome minutes later, so jovi-mall needs somewhere
 * to be told: `/callback` is where a vectorisation actually finishes, and the
 * only place in this service that writes `vectorisationStatus: 'completed'`.
 * `/payloads` is the read half, used only by the spreadsheet upload path.
 */
import internalVectoriserRoutes from '../modules/catalog/routes/internal-vectoriser.routes';
router.use('/internal/vectoriser', internalVectoriserRoutes);

/**
 * The NEGOTIATION door — the fifth member of the `/internal` family. The caller is
 * the n8n bargaining sub-agent's flow, fetching the playbook it puts in the model
 * request's SYSTEM position. One GET, one static document, no identity.
 *
 * Same `requireServiceToken` as `/internal/vectoriser` and the two geo-tracker
 * mounts, and deliberately NOT on the maintenance exemption list — blocking it
 * stops bargaining, which degrades to the asking price rather than to an outage.
 * Reasoning in the route file's header.
 */
import internalNegotiationRoutes from '../modules/negotiation/routes/internal-negotiation.routes';
router.use('/internal/negotiation', internalNegotiationRoutes);

// Service-to-service API consumed by the wi-admin backend. Same shape as the
// geo-tracker door above, a SEPARATE secret (INTERNAL_ADMIN_SERVICE_TOKEN), and
// the same fail-closed rule. It re-exposes existing admin routers behind a
// service-token guard so wi-admin executes platform logic here rather than
// reproducing it against the shared database — see
// `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md`.
//
// ⚠ **Since Phase 5 Part E this is the ONLY administrative door into this service.** The
// public `/admin/*` mounts that ran beside it are deleted, and with them the second
// authorization model they carried — `requireRole(['admin'])` on a platform `users` row that
// holds no tier, no permission set and no audit identity. Every routed factory below is the
// SAME factory the public mounts used; only the guard array and the prefix differ.
router.use('/internal/admin', internalAdminRoutes);

// `/admin/delivery-agencies` (deactivate/reactivate, which cascades to vendor products) and
// `/admin/cod` (the cash chain: remittance confirmation, liabilities, discrepancies) were
// mounted here. Both deleted at the cutover; both factories are alive on
// `/api/internal/admin/{agencies,cod}`. The `/delivery-agencies` segment lived on the PREFIX
// rather than on each route precisely so one factory could serve both mounts — which is what
// made deleting one of them a two-line change rather than a rewrite.

// The blog editor used to mount here, at `/admin/articles` and `/admin/article-authors`.
// It was deleted at Phase 5 Part A: wi-admin owns article and byline WRITES outright now
// (ADR-004 D-4), serving them at `/api/v1/content` against this database.
//
// What is left in `modules/blog/` is the public reader and the two Mongoose models. The
// models stay HERE deliberately, and that split is the thing to remember before editing
// either side: wi-admin writes a collection whose schema and indexes — including the
// unique multikey index on `slug_keys` — are declared in this repository and created from
// its migration ledger. Adding a field to `ArticleSchema` without adding it to wi-admin's
// writer produces documents the public DTO renders wrong, and nothing in either repo's
// tests would see it.

// `/admin` (the administrator's own profile, and the catalogue bulk-vectorise tool) was the
// LAST public admin mount and is deleted at the cutover (Phase 5 Part E).
//
// Nothing replaced it here, because both halves had already moved: `GET`/`PATCH
// /administrators/me` have existed in wi-admin since Phase 2, and `bulk-vectorise` became
// `POST /api/v1/dev-tools/catalogue/vectorise` at Phase 12 — which still runs through this
// service's controller, over `/api/internal/admin`.
//
// ⚠ **`AdminModel` and `AdminRepository` SURVIVE, and they are not admin surface.** Two live
// readers resolve historical rows through them: `ticket-enrichment.service.ts` resolves an
// `ActorRole.ADMIN` on old ticket actors, and `file-management.controller.ts` resolves owner
// names for files an admin uploaded. Deleting the model would break a customer's view of an
// old ticket — see `modules/admins/admin.model.ts`.

// Saved payment methods (shared across all roles, resolved from req.auth)
import paymentMethodRoutes from '../modules/payment-methods/routes';
router.use('/me/payment-methods', paymentMethodRoutes);

// Account routes shared across all roles (password change), resolved from
// req.auth — the password lives on the User model, not on any role entity.
import userAccountRoutes from '../modules/users/user.routes';
router.use('/me', userAccountRoutes);

// File upload and management routes
import fileRoutes from './routes/file-upload.routes';
import path from "path";
import { PUBLIC_STORAGE_TREES } from '../core/storage/storage-trees';
/**
 * ⚠ **PUBLIC trees only — this used to serve the whole of `storage/`** (ADR-A01 D-2).
 *
 * One unguarded `express.static` over the entire storage root, mounted before `fileRoutes`,
 * meant a vendor's digital product and an agent's delivery-proof photo were fetchable by
 * anyone holding the URL — and a stored file's `url`, on every `FileDetail` the platform
 * emits, *is* that URL. The download token's single-use consumption, its counter and its
 * revocation were all advisory while that path existed.
 *
 * The mount list is DERIVED from `core/storage/storage-trees.ts`, which carries an explicit
 * verdict for every tree and treats an unknown one as private. So this loop cannot drift from
 * the classification, and a tree added next year is private until somebody says otherwise —
 * which is the correct default and the opposite of what was here.
 */
/**
 * ⚠ **`Cross-Origin-Resource-Policy: cross-origin`, and it is required, not a relaxation
 * of convenience.**
 *
 * `app.use(helmet())` stamps `same-origin` on every response in this service. For an API
 * that is correct; for these bytes it is fatal, because CORP is enforced on **no-cors**
 * requests — which is exactly what a plain `<img src>`, `<video>` or `<audio>` issues. Every
 * dashboard renders this API's media from its own origin (`agency.wi-mall.com`,
 * `vendor.wi-mall.com`, the Capacitor WebViews on `*.wi-mall.internal`, `localhost:517x` in
 * development), so under `same-origin` the browser fetches the file, sees the header, and
 * throws the bytes away. Every avatar, logo and thumbnail on the platform renders blank.
 *
 * The failure is unusually hard to read from the client side, which is why this comment is
 * long. It looks like a CORS problem and is not one: `ALLOWED_ORIGINS` can name the origin,
 * the response can carry a perfectly good `Access-Control-Allow-Origin`, and the image still
 * does not paint — because a no-cors request never consults ACAO. A frontend that puts
 * `crossOrigin` on the tag to "fix CORS" makes the image load again for a reason that has
 * nothing to do with the attribute's purpose: CORS mode exempts the response from the CORP
 * check. That workaround then breaks the moment a client appears on an origin
 * `ALLOWED_ORIGINS` does not list, and it is how this arrived here.
 *
 * Scoped to the mount rather than widened globally: `PUBLIC_STORAGE_TREES` is public,
 * unauthenticated, no-cookie content by classification (`core/storage/storage-trees.ts`) —
 * anyone holding the URL may already read it, so declaring it embeddable gives away nothing.
 * Everything else in this service keeps helmet's `same-origin`, including the private trees,
 * which are not on this mount at all.
 *
 * A middleware in front of the mount rather than `express.static`'s `setHeaders` option:
 * `test:uploads` pins the exact text of the `express.static(path.join(...))` call, which is
 * what proves the mount list is derived from the classification and not a second hand-kept
 * list. Passing options through that call would defeat the assertion for a formatting reason,
 * so the header goes beside it instead of inside it.
 */
function allowCrossOriginEmbedding(
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
): void {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
}

for (const tree of PUBLIC_STORAGE_TREES) {
    router.use(`/files/${tree}`, allowCrossOriginEmbedding, express.static(path.join(__dirname, '../..', 'storage', tree)));
}
router.use('/files', fileRoutes);

export const apiRouter = router;
