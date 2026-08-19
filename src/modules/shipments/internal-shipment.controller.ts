import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { ShipmentService } from './shipment.service';
import { ShipmentIdParamSchema } from './shipment.validator';

const shipmentService = new ShipmentService();

/**
 * InternalShipmentController — the shipment half of the surface geo-tracker
 * consumes, beside `InternalAgentController`.
 *
 * Authenticated by shared service token, not a user session, for the same
 * reason: geo-tracker is a service, and making it impersonate a user would
 * corrupt the audit trail.
 *
 * ── What this may and may not answer ───────────────────────────────────────
 *
 *   jovi-mall answers "where is this parcel GOING?"     (order data)
 *   geo-tracker answers "where is the agent NOW?"       (execution)
 *
 * The destination is order/profile data and belongs here by the governing rule
 * in the workspace `CLAUDE.md` — geo-tracker consumes coordinates for routing
 * and never resolves an address. Nothing here returns a live position, a trail,
 * or a shipment STATUS: geo-tracker holds a shipment's id and jovi-mall's
 * trackable/terminal verdicts, and giving it the status would be handing it a
 * copy of the model it deliberately does not have.
 */
export class InternalShipmentController {
  /**
   * GET /api/internal/shipments/:shipmentId/destination
   *
   * The drop-off, so geo-tracker can estimate an arrival time for every watcher
   * of the agent running this shipment — not just the customers whose client
   * sends a destination on the subscribe frame.
   *
   * `data.destination` is null when nothing on the shipment's path carries
   * coordinates. That is an answer, not a failure: geo-tracker degrades to no
   * ETA, which is its behaviour today. A missing shipment is a 404, and
   * geo-tracker's client treats any status >= 300 as an error and leaves the
   * destination unresolved — the same degradation by a different road.
   */
  static getDestination = asyncHandler(async (req: Request, res: Response) => {
    const { shipmentId } = ShipmentIdParamSchema.parse(req.params);
    const destination = await shipmentService.resolveTrackingDestination(shipmentId);
    res.json({ success: true, data: destination });
  });
}
