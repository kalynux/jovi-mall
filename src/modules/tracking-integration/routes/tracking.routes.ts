import { Router } from 'express';
import { requireAuth } from '../../../api/middlewares/auth.middleware';
import { requireServiceToken } from '../../agents/middlewares/service-token.middleware';
import { TrackingController } from '../controllers/tracking.controller';

const router = Router();

/**
 * POST /api/tracking/agent-state
 *
 * geo-tracker reporting that an agent's tracking state changed. Declared BEFORE the
 * `router.use(requireAuth)` below and carrying its own guard, because the caller is a
 * service: geo-tracker has no user, no role entity and no refresh cookie, and forcing it
 * to impersonate one would blur the audit trail. It presents `INTERNAL_SERVICE_TOKEN`,
 * the same secret the `/api/internal/agents/*` reads already use.
 *
 * ⚠ **Route order is load-bearing here.** `router.use(requireAuth)` applies to every
 * route declared after it, so moving this line down turns a working notification into a
 * silent 401 — silent because delivery is best-effort and geo-tracker only logs.
 *
 * ── This path is the contract, and it was unserved ───────────────────────────
 * `geo-tracker/api-doc/tracking-notifications.md` has published `/api/tracking/agent-state`
 * as the receiver since the tracking lifecycle shipped, and its
 * `TRACKING_STATE_NOTIFY_PATH` defaults to it. jovi-mall never served it — the receiver
 * that got built lives at `POST /api/internal/agents/:agentId/tracking-state` and the
 * notifier has never called it. So every notification has been dropped, and
 * `last_known_tracking_state` is the schema default on every agent. Both receivers now
 * exist; this is the advertised one.
 */
router.post('/agent-state', requireServiceToken, TrackingController.receiveAgentState);

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
