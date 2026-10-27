import { RequestHandler, Router } from 'express';
import { AdminBookingController } from '../controllers/admin-booking.controller';

/**
 * Booking administration — the surface wi-admin delegates to (`/api/internal/admin/bookings`,
 * ADMIN-BOOKINGS-PLAN § 4). Mounted ONCE, internal only, like every admin router since the
 * Phase 5 cutover: do not add a public `/api/admin/*` mount.
 *
 * wi-admin READS bookings directly (ADR-004: direct read, delegated write). The two reads here are
 * the exceptions that state the rule (ADR-008 D-1): `access-state` and `availability` answer
 * VERDICTS the platform acts on — whether the customer may see the link, which times may be
 * booked — and a copy of either rule in wi-admin would be a second opinion that drifts.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/services/...` is a LITERAL first segment and is declared above `/:bookingId/...`.
 */
function attachRoutes(router: Router): Router {
  router.get('/services/:productId/availability', AdminBookingController.availability);
  router.post('/services/:productId/sessions/cancel', AdminBookingController.cancelSession);

  router.get('/:bookingId/access-state', AdminBookingController.accessState);
  router.post('/:bookingId/cancel', AdminBookingController.cancel);
  router.post('/:bookingId/complete', AdminBookingController.complete);
  router.post('/:bookingId/payment/recheck', AdminBookingController.recheckPayment);
  router.post('/:bookingId/payment/cash', AdminBookingController.markCashPaid);
  router.post('/:bookingId/proposal/withdraw', AdminBookingController.withdrawProposal);
  router.post('/:bookingId/reminder', AdminBookingController.resendReminder);
  return router;
}

/** Build the booking admin surface behind an arbitrary guard chain. */
export function buildAdminBookingRouter(guards: RequestHandler[]): Router {
  const router = Router();
  router.use(...guards);
  return attachRoutes(router);
}
