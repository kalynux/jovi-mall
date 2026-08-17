import { asyncHandler } from '../../../api/middlewares/async-handler';
import { visibleAgentsService } from '../services/visible-agents.service';
import { agencyTrackingBoardService } from '../services/agency-tracking-board.service';
import { agentStateReceiverService } from '../services/agent-state-receiver.service';
import { AgentStateNotificationSchema } from '../validators/tracking.validator';

/**
 * Serves the live-tracking authorization resolution consumed by geo-tracker.
 * geo-tracker calls this AS the viewer (forwarding their access token), so the
 * result is exactly the agent set that viewer may track right now. This keeps
 * the tracking authorization policy in jovi-mall — geo-tracker never
 * reimplements the shipment/order model.
 */
export class TrackingController {
  /** GET /api/tracking/visible-agents */
  static getVisibleAgents = asyncHandler(async (req, res) => {
    const role = req.auth!.role;
    // admin has no role_entity id relevant here; others carry their profile id.
    const roleEntityId = req.auth!.role_entity?._id ? req.auth!.role_entity._id.toString() : '';

    const result = await visibleAgentsService.resolve(role, roleEntityId);

    res.json({ success: true, data: result });
  });

  /**
   * GET /api/agency/tracking/board
   *
   * The agency live-tracking map's one load. Unlike `getVisibleAgents` above —
   * which is the service-to-service authorization seam geo-tracker calls — this
   * is frontend-facing, and is mounted on the agency router (which carries the
   * `requireRole(['agency'])` guard) rather than under `/api/tracking`.
   *
   * An empty board is a 200 with `agents: []`: "nothing to track right now" is
   * an answer, not a missing resource.
   */
  static getAgencyBoard = asyncHandler(async (req, res) => {
    const agencyId = req.auth!.role_entity._id.toString();

    const board = await agencyTrackingBoardService.forAgency(agencyId);

    res.json({ success: true, data: board });
  });

  /**
   * POST /api/tracking/agent-state — geo-tracker reporting a state change.
   *
   * The inbound half of the reverse channel, and the address geo-tracker has been
   * POSTing to all along (`TRACKING_STATE_NOTIFY_PATH`). Authenticated by the shared
   * service token, not a session: the caller is a service.
   *
   * ⚠ **Always 200, whatever the outcome.** geo-tracker treats any status ≥ 300 as a
   * dropped best-effort delivery and does not retry, so a 404 for an agent this service
   * no longer has would produce a permanent error line for a condition nobody can fix,
   * and a 5xx would lose a notification that a retry could not recover anyway. What
   * happened is in `data.outcome` — `applied`, `ignored_stale` or `unknown_agent`.
   */
  static receiveAgentState = asyncHandler(async (req, res) => {
    const notification = AgentStateNotificationSchema.parse(req.body);

    const outcome = await agentStateReceiverService.receive({
      eventId: notification.eventId,
      agentId: notification.agentId,
      previousState: notification.previousState,
      state: notification.state,
      trigger: notification.trigger,
      reason: notification.reason,
      occurredAt: notification.occurredAt,
      position: notification.position,
    });

    res.json({ success: true, data: { outcome } });
  });
}
