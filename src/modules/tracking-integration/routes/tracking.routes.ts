import { Router } from 'express';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { TrackingController } from '../controllers/tracking.controller';

const router = Router();

// Any authenticated actor may ask for their own trackable-agent set; the
// service returns the correct (possibly empty) set per role, so no
// requireRole gate is needed here.
router.use(requireAuth);

/**
 * GET /api/tracking/visible-agents
 * Returns { success, data: { all: boolean, agents: string[] } } — the agents
 * the caller may currently see the live location of. Consumed by the
 * geo-tracker service, forwarding the caller's access token.
 */
router.get('/visible-agents', TrackingController.getVisibleAgents);

export default router;
