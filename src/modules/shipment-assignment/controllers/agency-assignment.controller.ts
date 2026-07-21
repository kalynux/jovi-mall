import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { shipmentAssignmentService } from '../domain/services/shipment-assignment.service';
import { OfferAgentSchema, ReassignShipmentSchema, UpdateAssignmentSettingsSchema } from '../validators/assignment.validator';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';

const agencyRepo = new DeliveryAgencyRepository();

/**
 * AgencyAssignmentController — the agency's side of the acceptance workflow:
 * place a manual offer, trigger auto-assignment, preview candidates, withdraw a
 * live offer, and toggle auto-assignment participation. All scoped to the
 * authenticated agency.
 */
export class AgencyAssignmentController {
  /**
   * PATCH /api/agency/shipments/:id/assign-agent — manual pick.
   * Repurposed from the old direct assignment: now creates an OFFER the agent
   * must accept (unless they have auto-accept on). Body: { agentId }.
   */
  static offerAgent = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const actorUserId = req.auth!.user.id;
    const { agentId } = OfferAgentSchema.parse(req.body);

    const result = await shipmentAssignmentService.offerToAgent(agencyId, req.params.id, agentId, {
      role: 'agency',
      userId: actorUserId,
    });

    res.json({
      success: true,
      data: result,
      message: result.autoAccepted ? 'Agent assigned (auto-accepted)' : 'Offer sent to agent',
    });
  });

  /**
   * POST /api/agency/shipments/:id/auto-assign — let the system pick.
   * Computes the ranked pool and offers the top candidate now, even if the
   * agency's standing auto-assign toggle is off.
   */
  static autoAssign = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();

    // Scope check: the shipment must belong to this agency (previewCandidates
    // enforces it and 404s otherwise).
    await shipmentAssignmentService.previewCandidates(agencyId, req.params.id);

    const result = await shipmentAssignmentService.autoAssign(req.params.id, {
      role: 'agency',
      userId: req.auth!.user.id,
    });
    if (!result) {
      throw createAppError(ERROR_CODES.SHIPMENT_NO_ELIGIBLE_AGENTS, 422, 'No eligible agent is available to take this shipment right now');
    }
    res.json({
      success: true,
      data: result,
      message: result.autoAccepted ? 'Agent assigned (auto-accepted)' : 'Offer sent to top-ranked agent',
    });
  });

  /** GET /api/agency/shipments/:id/assignment-candidates — preview the ranked pool. */
  static previewCandidates = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const candidates = await shipmentAssignmentService.previewCandidates(agencyId, req.params.id);
    res.json({ success: true, data: candidates });
  });

  /** POST /api/agency/shipments/:id/offer/cancel — withdraw the live offer. */
  static cancelOffer = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const result = await shipmentAssignmentService.cancelActiveOffer(agencyId, req.params.id);
    res.json({ success: true, data: result, message: 'Offer cancelled' });
  });

  /**
   * POST /api/agency/shipments/:id/reassign — change agents.
   * Detach the current agent (releasing their tracking) and offer the shipment to
   * a replacement. Body: { agentId?, reason }. `agentId` is required past pickup
   * (manual only); omit it pre-pickup to auto-assign. `reason` is mandatory.
   */
  static reassign = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const actorUserId = req.auth!.user.id;
    const { agentId, reason, pickupLocation } = ReassignShipmentSchema.parse(req.body);

    const result = await shipmentAssignmentService.reassign(agencyId, req.params.id, { agentId, reason, pickupLocation }, {
      role: 'agency',
      userId: actorUserId,
    });

    res.json({
      success: true,
      data: result,
      message: result.autoAccepted ? 'Shipment reassigned (auto-accepted)' : 'Shipment released from its agent and offered to the replacement',
    });
  });

  /** PATCH /api/agency/assignment-settings — toggle auto-assignment. Body: { autoAssignEnabled } */
  static updateSettings = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { autoAssignEnabled } = UpdateAssignmentSettingsSchema.parse(req.body);
    const agency = await agencyRepo.setAutoAssignEnabled(agencyId, autoAssignEnabled);
    if (!agency) throw createAppError(ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND, 404);
    res.json({
      success: true,
      data: { autoAssignEnabled: agency.assignment_settings?.auto_assign_enabled ?? false },
      message: 'Assignment settings updated',
    });
  });
}
