import express from 'express';
import { authRouter } from '../modules/auth/auth.routes';
import { browserAuthRoutes } from '../modules/auth/routes/browser-auth.routes';
import { createWhatsappRouter } from '../modules/whatsapp/whatsapp.routes';
import { createTelegramRouter } from '../modules/telegram/telegram.routes';
import { CommandBus } from '../modules/command-bus/command-bus';
import { register_all_commands } from '../modules/commands';
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
 * not: it sat beside `fileRoutes` near the bottom while `router.use('/auth', authRateLimiter)`
 * runs a few lines below, at the top.
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
import { authRateLimiter, publicRateLimiter } from './rate-limit/rate-limit.middleware';

const router = express.Router();

/**
 * ── Administrative action logging — MUST be registered before every `/admin*` mount ──
 *
 * One `use('/admin', …)` matches all twelve of them by prefix, so this cannot miss an
 * endpoint by omission — including ones added to the legacy surface later. That property is
 * the entire reason it sits here rather than being attached per router, and it depends on
 * registration ORDER: Express runs middleware in the order it was mounted, so moving this
 * below any `router.use('/admin…')` silently stops recording that router.
 *
 * It deliberately does NOT cover `/internal/admin/*` (mounted further down): those are
 * wi-admin's delegated calls, already audited there against a real administrator identity.
 * Recording them here would double-count every ported operation.
 *
 * Interim, and deleted with the legacy surface at the Phase 8 cutover.
 */
import { adminActionLogMiddleware } from './middlewares/admin-action-log.middleware';
router.use('/admin', adminActionLogMiddleware);

/**
 * The three legacy admin endpoints that do NOT live under `/admin`. Named individually
 * because a prefix cannot reach them, and they are exactly the kind of thing a sweep
 * misses — an admin-only capability sitting on a public-looking path.
 *
 * `/files` also serves `express.static` and public reads; the middleware skips safe methods,
 * so nothing there is affected. Both mounts are wider than the endpoints they exist for,
 * which is accepted for a surface being deleted.
 */
router.use('/files', adminActionLogMiddleware);
router.use('/webhooks/telegram', adminActionLogMiddleware);

// Shared middleware and routes can be exported from here
// export * from './middlewares';
// export * from './utils';

// Initialize Command System
export const commandBus = new CommandBus();
register_all_commands(commandBus);

/**
 * The credential bucket sits in front of BOTH auth mounts.
 *
 * It is the only strict limit in the service — 20 per minute per IP, where everything else
 * is in the hundreds. The two are protecting against different things: the global ceilings
 * are a runaway-loop backstop, this is a security control. It bounds one source spraying a
 * common password across many accounts, which is precisely the attack an account-level
 * lockout cannot see, because every individual account sees only one or two attempts.
 *
 * jovi-mall has had neither control until now. `PHASE-0-DISCOVERY` recorded it as finding
 * A6: "No login throttling, lockout, or failed-attempt record."
 *
 * Mounted here rather than inside each router so it covers registration, password reset and
 * verification-code resend as well as login — every path that takes a credential or sends
 * one out, including the ones added later.
 */
router.use('/auth', authRateLimiter);
router.use('/auth', authRouter);
router.use('/auth/browser', browserAuthRoutes);  // Browser session auth
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
import adminBillingRoutes from '../modules/billing/routes/admin-billing.routes';
router.use('/vendor', vendorBillingRoutes);
router.use('/agency', agencyBillingRoutes);
router.use('/agent', agentBillingRoutes);
router.use('/admin', adminBillingRoutes);

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
// The editor's side is /api/admin/articles, mounted below behind requireRole(['admin']).
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

// Earnings: commission/escrow ledger. Vendor sees held vs withdrawable balances;
// agency sees its own held vs withdrawable delivery-fee balance; agent sees their
// cut of the delivery fees on runs they completed; admin sees the platform
// commission account. Mounted at the role roots → /vendor/earnings,
// /agency/earnings, /agent/earnings, /admin/earnings/platform.
import vendorEarningsRoutes from '../modules/earnings/routes/vendor-earnings.routes';
import agencyEarningsRoutes from '../modules/earnings/routes/agency-earnings.routes';
import agentEarningsRoutes from '../modules/earnings/routes/agent-earnings.routes';
import adminEarningsRoutes from '../modules/earnings/routes/admin-earnings.routes';
router.use('/vendor', vendorEarningsRoutes);
router.use('/agency', agencyEarningsRoutes);
router.use('/agent', agentEarningsRoutes);
router.use('/admin/earnings', adminEarningsRoutes);

// Payout requests: vendor/agency/agent request a withdrawal of their entire
// available balance, which opens a PAYOUT_REQUEST ticket for admins to process.
// /vendor/earnings/payout, /agency/earnings/payout, /agent/earnings/payout (all
// mounted above alongside earnings) + the admin processing queue below.
import adminPayoutRequestsRoutes from '../modules/earnings/routes/admin-payout-requests.routes';
router.use('/admin/payout-requests', adminPayoutRequestsRoutes);

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

// Admin order controls (payment-dispute hold: list frozen orders, manual resolve)
import adminOrderRoutes from '../modules/orders/admin-order.routes';
router.use('/admin/orders', adminOrderRoutes);

// Ticketing Module Routes
import {
    adminTicketRoutes,
    vendorTicketRoutes,
    customerTicketRoutes,
    agencyTicketRoutes,
    agentTicketRoutes
} from '../modules/tickets';

router.use('/admin/tickets', adminTicketRoutes);
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
import adminAgentRoutes from '../modules/agents/routes/admin-agent.routes';
import internalAgentRoutes from '../modules/agents/routes/internal-agent.routes';
import internalAdminRoutes from './routes/internal-admin.routes';
router.use('/agent', agentSelfRoutes);
router.use('/agency/agents', agencyRosterRoutes);
router.use('/admin/agents', adminAgentRoutes);

// Service-to-service API consumed by geo-tracker (shared-secret auth, not a
// user session). jovi-mall answers "may this agent be tracked?"; geo-tracker
// owns tracking execution. Disabled entirely when INTERNAL_SERVICE_TOKEN is unset.
router.use('/internal/agents', internalAgentRoutes);

// Service-to-service API consumed by the wi-admin backend. Same shape as the
// geo-tracker door above, a SEPARATE secret (INTERNAL_ADMIN_SERVICE_TOKEN), and
// the same fail-closed rule. It re-exposes existing admin routers behind a
// service-token guard so wi-admin executes platform logic here rather than
// reproducing it against the shared database — see
// `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md`. The public /admin/* mounts stay live
// alongside it until cutover.
router.use('/internal/admin', internalAdminRoutes);

// Admin delivery agency management (deactivate/reactivate cascades to vendor products).
// The prefix carries the `/delivery-agencies` segment that the router used to declare on
// every route — it became path-relative at Phase 9 so the same factory could also be
// mounted under `/api/internal/admin/agencies`. Public URLs are unchanged.
import adminAgencyRoutes from '../modules/delivery/admin-agency.routes';
router.use('/admin/delivery-agencies', adminAgencyRoutes);

// Admin COD oversight (cash chain: remittance confirmation, liabilities, discrepancies)
import adminCodRoutes from '../modules/cod/admin-cod.routes';
router.use('/admin/cod', adminCodRoutes);

// Blog editor — the admin half of /api/public/articles. Mounted at its own specific
// prefixes rather than on the shared `/admin` root, so it cannot be shadowed by (or
// shadow) the four routers already stacked there.
import { adminArticleRoutes, adminArticleAuthorRoutes } from '../modules/blog/routes/admin-blog.routes';
router.use('/admin/articles', adminArticleRoutes);
router.use('/admin/article-authors', adminArticleAuthorRoutes);

// Admin profile routes
import adminRoutes from '../modules/admins/routes';
router.use('/admin', adminRoutes);

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
router.use('/files', express.static(path.join(__dirname, '../..', 'storage')));
router.use('/files', fileRoutes);

export const apiRouter = router;
