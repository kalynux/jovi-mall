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

// Vendor product management routes
import vendorProductsRoutes from '../modules/catalog/routes/vendor-products.routes';
router.use('/vendor/products', vendorProductsRoutes);

// Vendor inventory management routes
import vendorInventoryRoutes from '../modules/catalog/routes/vendor-inventory.routes';
router.use('/vendor/inventory', vendorInventoryRoutes);

// Billing: vendor pricing plans & credit wallet.
// Mounted at the role roots so endpoints read as /vendor/plans, /vendor/credits,
// /admin/plans, /admin/vendors/:vendorId/plan (no extra /billing segment).
import vendorBillingRoutes from '../modules/billing/routes/vendor-billing.routes';
import adminBillingRoutes from '../modules/billing/routes/admin-billing.routes';
router.use('/vendor', vendorBillingRoutes);
router.use('/admin', adminBillingRoutes);

// Earnings: commission/escrow ledger. Vendor sees held vs withdrawable balances;
// agency sees its own held vs withdrawable delivery-fee balance; admin sees the
// platform commission account. Mounted at the role roots →
// /vendor/earnings, /agency/earnings, /admin/earnings/platform.
import vendorEarningsRoutes from '../modules/earnings/routes/vendor-earnings.routes';
import agencyEarningsRoutes from '../modules/earnings/routes/agency-earnings.routes';
import adminEarningsRoutes from '../modules/earnings/routes/admin-earnings.routes';
router.use('/vendor', vendorEarningsRoutes);
router.use('/agency', agencyEarningsRoutes);
router.use('/admin', adminEarningsRoutes);

// Unified vendor transactions feed (merges plan purchases, credit top-ups,
// credit usage and sales earnings into one history).
import vendorTransactionRoutes from '../modules/transactions/routes/vendor-transaction.routes';
router.use('/vendor/transactions', vendorTransactionRoutes);

// Customer shopping cart (add/get/remove/clear; checkout lives under /customer/orders)
import customerCartRoutes from '../modules/cart/routes';
router.use('/customer/cart', customerCartRoutes);

// Customer order actions (e.g. confirm delivery → completes order, starts escrow hold)
import customerOrderRoutes from '../modules/orders/customer-order.routes';
router.use('/customer/orders', customerOrderRoutes);

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

// Customer profile routes
import customerRoutes from '../modules/customers/routes';
router.use('/customer', customerRoutes);

// Delivery Agency profile routes
import agencyRoutes from '../modules/delivery/agency.routes';
router.use('/agency', agencyRoutes);

// Delivery Agent profile routes
import agentRoutes from '../modules/delivery/agent.routes';
router.use('/agent', agentRoutes);

// Admin delivery agency management (deactivate/reactivate cascades to vendor products)
import adminAgencyRoutes from '../modules/delivery/admin-agency.routes';
router.use('/admin', adminAgencyRoutes);

// Admin profile routes
import adminRoutes from '../modules/admins/routes';
router.use('/admin', adminRoutes);

// Saved payment methods (shared across all roles, resolved from req.auth)
import paymentMethodRoutes from '../modules/payment-methods/routes';
router.use('/me/payment-methods', paymentMethodRoutes);

// File upload and management routes
import fileRoutes from './routes/file-upload.routes';
import path from "path";
router.use('/files', express.static(path.join(__dirname, '../..', 'storage')));
router.use('/files', fileRoutes);

export const apiRouter = router;
