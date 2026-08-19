import { Router } from 'express';
import { requireServiceToken } from '../agents/middlewares/service-token.middleware';
import { InternalShipmentController } from './internal-shipment.controller';

/**
 * Internal shipment API — mounted at /api/internal/shipments.
 *
 * The second door in this family, after `/api/internal/agents`. Same caller
 * (geo-tracker), same shared service token (INTERNAL_SERVICE_TOKEN here ===
 * NODE_API_SERVICE_TOKEN there), same fail-closed rule: unset secret denies.
 *
 * Guarded by `requireServiceToken` imported from the agents module rather than
 * copied — one implementation, one timing-safe compare, one fail direction. It
 * lives there because that was the first door; it is not agent-specific.
 *
 * ⚠ Read-only, and it must stay that way. `/api/internal/agents` carries a
 * write (`POST /:agentId/tracking-state`) because geo-tracker observes
 * something jovi-mall cannot; there is no equivalent for a shipment. geo-tracker
 * owns tracking mechanics and jovi-mall owns the shipment model, so a verb here
 * would be geo-tracker writing into the model it exists not to have.
 */
const router = Router();

router.use(requireServiceToken);

/**
 * GET /api/internal/shipments/:shipmentId/destination
 * The geocoded drop-off, for routing and ETA. Null destination is a valid answer.
 */
router.get('/:shipmentId/destination', InternalShipmentController.getDestination);

export default router;
