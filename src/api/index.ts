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

export const apiRouter = router;
