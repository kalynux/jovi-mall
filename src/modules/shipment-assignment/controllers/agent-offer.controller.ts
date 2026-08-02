import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';
import { ListOffersQuerySchema, RejectOfferSchema, CancelShipmentSchema } from '../validators/assignment.validator';

/**
 * AgentOfferController — the agent's side of the acceptance workflow.
 *
 * Every handler is scoped to the authenticated agent (`role_entity._id`); the
 * service reports a mismatched offer as not-found, so one agent can never see or
 * act on another's offer.
 */
export class AgentOfferController {
  /** GET /api/agent/offers — the agent's offers, pending first. */
  static list = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agentId = req.auth!.role_entity._id.toString();
    const { status, q, page, limit } = ListOffersQuerySchema.parse(req.query);
    const result = await shipmentAssignmentService.listForAgent(agentId, { status, q }, { page, limit });
    res.json({ success: true, data: result.data, meta: result.meta });
  });

  /** GET /api/agent/offers/:id — one offer's detail. */
  static get = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agentId = req.auth!.role_entity._id.toString();
    const offer = await shipmentAssignmentService.getForAgent(agentId, req.params.id);
    res.json({ success: true, data: offer });
  });

  /** POST /api/agent/offers/:id/accept — take the job. */
  static accept = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agentId = req.auth!.role_entity._id.toString();
    const result = await shipmentAssignmentService.accept(agentId, req.params.id);
    res.json({ success: true, data: result, message: 'Offer accepted' });
  });

  /** POST /api/agent/offers/:id/reject — decline the job. Body: { reason? } */
  static reject = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agentId = req.auth!.role_entity._id.toString();
    const { reason } = RejectOfferSchema.parse(req.body);
    const result = await shipmentAssignmentService.reject(agentId, req.params.id, reason ?? null);
    res.json({ success: true, data: result, message: 'Offer rejected' });
  });

  /**
   * POST /api/agent/shipments/:id/cancel — the assigned agent cancels a shipment
   * mid-delivery. Body: { reason: <enum>, note?: <=200 chars }. Releases this
   * agent (capacity + tracking) and RESUMES auto-assignment from where it had
   * reached (never restarting), so the shipment is re-offered without operator
   * intervention. `reason` is required; `note` is required when reason is 'other'.
   */
  static cancelShipment = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agentId = req.auth!.role_entity._id.toString();
    const { reason, note } = CancelShipmentSchema.parse(req.body);
    const result = await shipmentAssignmentService.cancelByAgent(agentId, req.params.id, {
      reason,
      note: note ?? null,
    });
    res.json({ success: true, data: result, message: 'Shipment cancelled' });
  });
}
