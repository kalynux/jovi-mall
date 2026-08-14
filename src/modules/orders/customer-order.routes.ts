import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CustomerOrderController } from './customer-order.controller';

/**
 * Customer Order Routes
 *
 * Path: /api/customer/orders
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

// Checkout: turn the cart into orders (one per vendor). Returns a cartId to pay once.
router.post('/checkout', CustomerOrderController.checkout);

// Order history, grouped by checkout group (cartId) → one logical order per group.
router.get('/', CustomerOrderController.listOrderGroups);

// One checkout group in detail (all its per-vendor orders with items).
//
// ⚠️ Declared BEFORE `/:id`. Express matches in declaration order, so reversing these makes
// `/groups/<cartId>` resolve as an order whose id is the literal string "groups".
router.get('/groups/:cartId', CustomerOrderController.getOrderGroup);

// One per-vendor order in detail. The group above is the customer's "logical" order; this
// is one seller's slice of it, which is what a push deep-link or an email carries.
router.get('/:id', CustomerOrderController.getOrder);

/**
 * The parcels on an order.
 *
 * This is what makes the two `:shipmentId` routes below reachable: nothing customer-facing
 * returned a shipment id except COD's `codCollections`, so a prepaid customer could never
 * confirm a delivery. Declared before them for readability — the paths differ in length, so
 * they cannot shadow each other.
 */
router.get('/:orderId/shipments', CustomerOrderController.listOrderShipments);

// Confirm delivery / satisfaction → completes the order, starts the escrow hold.
router.patch('/:id/confirm-delivery', CustomerOrderController.confirmDelivery);

// Confirm ONE shipment's delivery (multi-agency orders). Once every shipment of
// the order is confirmed, the order itself auto-completes.
router.post('/:orderId/shipments/:shipmentId/confirm-delivery', CustomerOrderController.confirmShipmentDelivery);

// Cancel an unpaid, pre-shipment order (gated by the vendor's cancellation policy).
router.post('/:id/cancel', CustomerOrderController.cancelOrder);

// COD: re-request the delivery code for one shipment (regenerates + resends via
// WhatsApp, and returns it — it is the customer's own secret). Rate-limited.
router.post('/:orderId/shipments/:shipmentId/resend-delivery-code', CustomerOrderController.resendDeliveryCode);

export default router;
