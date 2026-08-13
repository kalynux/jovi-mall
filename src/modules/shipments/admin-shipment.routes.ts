import { RequestHandler, Router } from 'express';
import { AdminShipmentController } from './admin-shipment.controller';

/**
 * Shipment administration — the write surface wi-admin delegates to.
 *
 * ── Mounted ONCE, internal only ───────────────────────────────────────────────
 * The same call `buildAdminUserRouter` and `buildAdminVendorRouter` make, and for the same
 * reason: there has never been an `/api/admin/shipments` surface, so there is no dashboard
 * consumer to keep alive and a public mount would create surface whose only future is the
 * cutover deletion list.
 *
 * ── Writes only ───────────────────────────────────────────────────────────────
 * wi-admin reads `shipments` directly out of `jovi_mall` (ADR-004 D-2: delegate a write,
 * not a query). Routing a `find()` through HTTP would buy nothing and cost a hop. What is
 * here is what has invariants: reassignment moves an agent, closes a tracking session and
 * returns capacity; a cancellation puts order items back for re-routing. Both run inside
 * jovi-mall transactions paired with post-commit events that a second writer would miss.
 *
 * ── Route order ───────────────────────────────────────────────────────────────
 * Both routes sit under a distinct second segment beneath `/:shipmentId`, so Express
 * matches them without ambiguity. A future LITERAL sibling of `/:shipmentId` must be
 * declared above them.
 */
function attachRoutes(router: Router): Router {
    /**
     * POST /:shipmentId/reassign
     * Body `{ agentId?, reason, pickupLocation? }`. Pre-pickup resets to `assigned` and
     * re-offers (auto when `agentId` is omitted); post-pickup enters `handing_over` and
     * REQUIRES an explicit agent (422 `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT`).
     * 409 `SHIPMENT_REASSIGNMENT_CONFLICT` when the shipment moved under the caller.
     */
    router.post('/:shipmentId/reassign', AdminShipmentController.reassign);

    /**
     * POST /:shipmentId/cancel
     * Body `{ reason?, note }`. Delegates to `ShipmentService.reject`, so it applies only
     * to a shipment at `assigned` — 422 `SHIPMENT_REJECTION_NOT_ALLOWED` once an agent has
     * picked it up, where a reassignment or a return is the domain's answer instead.
     * 409 `SHIPMENT_STATUS_CONFLICT` when the shipment moved under the caller.
     */
    router.post('/:shipmentId/cancel', AdminShipmentController.cancel);

    return router;
}

/** Build the shipment admin surface behind an arbitrary guard chain. */
export function buildAdminShipmentRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
