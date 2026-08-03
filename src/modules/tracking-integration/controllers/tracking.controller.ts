import { asyncHandler } from '../../../api/middlewares/async-handler';
import { visibleAgentsService } from '../services/visible-agents.service';
import { agencyTrackingBoardService } from '../services/agency-tracking-board.service';

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
}
