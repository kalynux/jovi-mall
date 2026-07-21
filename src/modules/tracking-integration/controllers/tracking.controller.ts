import { asyncHandler } from '../../../api/middlewares/async-handler';
import { visibleAgentsService } from '../services/visible-agents.service';

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
}
