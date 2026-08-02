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

const router = express.Router();

// Shared middleware and routes can be exported from here
// export * from './middlewares';
// export * from './utils';

// Initialize Command System
export const commandBus = new CommandBus();
register_all_commands(commandBus);

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

// Vendor product management routes
import vendorProductsRoutes from '../modules/catalog/routes/vendor-products.routes';
router.use('/vendor/products', vendorProductsRoutes);

// Vendor inventory management routes
import vendorInventoryRoutes from '../modules/catalog/routes/vendor-inventory.routes';
router.use('/vendor/inventory', vendorInventoryRoutes);

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
router.use('/admin', adminEarningsRoutes);

// Payout requests: vendor/agency/agent request a withdrawal of their entire
// available balance, which opens a PAYOUT_REQUEST ticket for admins to process.
// /vendor/earnings/payout, /agency/earnings/payout, /agent/earnings/payout (all
// mounted above alongside earnings) + the admin processing queue below.
import adminPayoutRequestsRoutes from '../modules/earnings/routes/admin-payout-requests.routes';
router.use('/admin', adminPayoutRequestsRoutes);

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
router.use('/agent', agentSelfRoutes);
router.use('/agency/agents', agencyRosterRoutes);
router.use('/admin/agents', adminAgentRoutes);

// Service-to-service API consumed by geo-tracker (shared-secret auth, not a
// user session). jovi-mall answers "may this agent be tracked?"; geo-tracker
// owns tracking execution. Disabled entirely when INTERNAL_SERVICE_TOKEN is unset.
router.use('/internal/agents', internalAgentRoutes);

// Admin delivery agency management (deactivate/reactivate cascades to vendor products)
import adminAgencyRoutes from '../modules/delivery/admin-agency.routes';
router.use('/admin', adminAgencyRoutes);

// Admin COD oversight (cash chain: remittance confirmation, liabilities, discrepancies)
import adminCodRoutes from '../modules/cod/admin-cod.routes';
router.use('/admin/cod', adminCodRoutes);

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
