import { RequestHandler, Router } from 'express';
import { AdminOrderController } from './admin-order.controller';

/**
 * Order administration.
 *
 * ── Mounted TWICE, and asymmetrically ─────────────────────────────────────────
 * Unlike `buildAdminUserRouter` and `buildAdminVendorRouter`, this router keeps its public
 * mount: `/api/admin/orders` has a live dashboard consumer for the dispute queue, and
 * deleting it before cutover would break a screen somebody is using today.
 *
 * But the four capabilities Phase 10 adds are **internal only**, which is why `scope` is a
 * parameter rather than the guards alone. The reason is the same one that kept the user
 * and vendor routers off the public mount, with a sharper edge: a refund moves money
 * through a payment gateway, and the public mount's guard is `requireRole(['admin'])` on a
 * platform `users` row — a credential that predates wi-admin's permission catalog entirely
 * and knows nothing about `orders.refund` being a `financial` permission held by tier 2
 * alone. Authorization for these four is resolved in wi-admin, before the call.
 *
 * `buildAdminOrderRouter` takes its guards as a parameter for the usual reason: a single
 * `Router` instance cannot be mounted twice, because its `router.use` guards would re-run.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * `/disputes` is a LITERAL sibling of `/:orderId` and must stay declared above it, or it
 * is read as an order id. Any future literal sibling goes above it too.
 */

/** The two endpoints that already existed publicly. Both mounts serve these. */
function attachSharedRoutes(router: Router): Router {
    /** GET /disputes — orders frozen by a payment dispute, newest first. */
    router.get('/disputes', AdminOrderController.listDisputed);

    /**
     * POST /:orderId/dispute/resolve
     * Body `{ outcome: 'won' | 'lost' }`. `won` lifts the hold and restores `paid`;
     * `lost` refunds, returns/cancels, and reverses escrow. 409 when there was no
     * dispute to resolve — idempotency is for the webhook, not for an operator.
     */
    router.post('/:orderId/dispute/resolve', AdminOrderController.resolveDispute);

    return router;
}

/** The four capabilities Phase 10 adds. Internal only — see the header. */
function attachInternalRoutes(router: Router): Router {
    /**
     * GET /:orderId/refund-eligibility
     * What the platform may refund, and which of the vendor's commercial gates a refund
     * would bypass. Read-only; never throws on ineligibility.
     */
    router.get('/:orderId/refund-eligibility', AdminOrderController.refundEligibility);

    /**
     * POST /:orderId/cancel
     * Body `{ reason }`. Runs the same six guards as the customer's cancel, minus the
     * vendor's cancellation policy. 409 if already cancelled, 422 past `processing` or
     * once a COD parcel has left the agency.
     */
    router.post('/:orderId/cancel', AdminOrderController.cancel);

    /**
     * POST /:orderId/dispatch
     * Hands a paid-but-undispatched order to its delivery agency. `shipmentsAssigned: 0`
     * is a no-op, not an error.
     */
    router.post('/:orderId/dispatch', AdminOrderController.dispatch);

    /**
     * POST /:orderId/refund
     * Body `{ amount?, reason, overridePolicy? }`. `amount` absent means the full
     * remaining balance. `overridePolicy` waives the VENDOR's return terms and nothing
     * else — 422 `REFUND_POLICY_OVERRIDE_REQUIRED` without it when the refund exceeds
     * them, and the money invariants refuse regardless.
     */
    router.post('/:orderId/refund', AdminOrderController.refund);

    return router;
}

/** Build the order admin surface behind an arbitrary guard chain. */
export function buildAdminOrderRouter(guards: RequestHandler[], scope: 'public' | 'internal'): Router {
    const router = Router();
    router.use(...guards);
    attachSharedRoutes(router);
    if (scope === 'internal') attachInternalRoutes(router);
    return router;
}

/**
 * ── There is NO public mount any more (Phase 5 Part E) ──────────────────────
 *
 * `export default buildAdminOrderRouter([requireAuth, requireRole(['admin'])], 'public');`
 * stood here, serving the payment-dispute hold to any platform session whose `users` row
 * carried `roles: ['admin']` — jovi-mall's second authorization model, which the cutover
 * retired. The factory is untouched: `internal-admin.routes.ts` instantiates it with
 * `[requireAdminCaller]` and `'internal'`, and that mount is live.
 *
 * ⚠ **The `scope` parameter now has one caller and one value, and it is LEFT THAT WAY on
 * purpose** (Phase 5 E.2). Collapsing it is a signature change across a router whose internal
 * mount is live, for no behavioural gain — and the parameter still documents something true:
 * `attachInternalRoutes` exists because a subset of this surface was never public. If a
 * second caller never appears, collapse it in a change that is only about that.
 */
