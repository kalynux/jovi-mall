import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess } from '../../core/responses';
import { adminCallerActor } from '../../api/middlewares/admin-caller.middleware';
import { ShipmentRepository } from './shipment.repository';
import { ShipmentService } from './shipment.service';
import { SHIPMENT_REJECTION_REASONS, ShipmentRejectionReason } from './shipment.model';
// Imported from the service directly rather than through the `../shipment-assignment`
// barrel: that barrel eagerly pulls in the sweep worker and the event subscriber, and this
// file lives in the module the assignment service itself imports. Same reasoning as
// `shipment.service.ts`'s note about the agents barrel.
import { shipmentAssignmentService } from '../shipment-assignment/domain/services/shipment-assignment.service';

const shipmentRepository = new ShipmentRepository();
const shipmentService = new ShipmentService();

const ReassignShipmentSchema = z.object({
  /**
   * Optional: omitted pre-pickup means auto-assign. jovi-mall raises
   * `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT` past pickup — deliberately NOT pre-checked
   * here, because `POST_PICKUP_REASSIGN_STATUSES` is the assignment service's rule and a
   * copy of it in a controller is a copy that drifts.
   */
  agentId: z.string().trim().optional(),
  reason: z.string().trim().min(3).max(500),
  pickupLocation: z.record(z.unknown()).optional(),
});

const CancelShipmentSchema = z.object({
  reason: z
    .enum(SHIPMENT_REJECTION_REASONS as [ShipmentRejectionReason, ...ShipmentRejectionReason[]])
    .default('platform_intervention'),
  /**
   * REQUIRED here where the agency's is optional. jovi-mall stores it on the shipment, and
   * that matters because wi-admin's audit trail lives in a database this service cannot
   * read — the vendor whose delivery just vanished has to be able to be told why. Same
   * argument as `vendors.kyc.reject`.
   */
  note: z.string().trim().min(3).max(200),
});

/**
 * Administrative shipment controls.
 *
 * ── The move this whole file makes ────────────────────────────────────────────
 * Every shipment command path in jovi-mall is hard-scoped by `findByIdAndAgency`. An
 * administrator has no agency of their own, so the temptation is an unscoped variant of
 * each service method — which would be a second implementation of the assignment rules,
 * the compare-and-set, and the post-commit side effects.
 *
 * Instead: **the scope is resolved FROM THE RECORD.** One unscoped read gets the
 * shipment's own `agency_id`, and everything downstream is the ordinary agency path with a
 * different `creator.role`. `findByIdAndAgency(shipmentId, agencyId)` becomes a tautology,
 * which is correct — and `REASSIGNABLE_STATUSES`, the post-pickup manual-agent rule, the
 * replacement's eligibility and contract-coverage checks, `HandoverPickupService.resolve`,
 * the `claimForReassignment` compare-and-set, the old agent's tracking release and
 * capacity return, the COD re-open and the session disposal all still happen, because it
 * IS that path.
 *
 * An administrator does not bypass the ownership scope. They supply it from the record
 * instead of from their session.
 */
export class AdminShipmentController {
  /**
   * POST /:shipmentId/reassign
   *
   * Move a shipment to a different agent. Pre-pickup this resets it to `assigned` and
   * re-offers (auto if no `agentId`); post-pickup it enters `handing_over` and requires an
   * explicit replacement. The old agent is RELEASED, not terminated — their tracking
   * session closes, their capacity returns, and the shipment lives on.
   */
  static reassign = asyncHandler(async (req: Request, res: Response) => {
    const input = ReassignShipmentSchema.parse(req.body ?? {});
    const shipmentId = req.params.shipmentId;

    // Unscoped read. A shipment that does not exist is a 404, never a 403 — there is no
    // scope for an administrator to be outside of.
    const shipment = await shipmentRepository.findById(shipmentId);
    if (!shipment) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });
    }

    const actor = adminCallerActor(req);
    const result = await shipmentAssignmentService.reassign(
      shipment.agency_id.toString(),
      shipmentId,
      {
        agentId: input.agentId ?? null,
        reason: input.reason,
        pickupLocation: input.pickupLocation as never,
      },
      { role: 'admin', userId: actor?.id ?? null, name: actor?.name ?? null }
    );

    sendSuccess(res, result, { message: 'Shipment reassigned' });
  });

  /**
   * POST /:shipmentId/cancel
   *
   * ── Why this maps to `reject` ─────────────────────────────────────────────
   * There is no `cancelled` shipment status, and there deliberately is not: the status
   * enum is a cross-service contract duplicated in geo-tracker's Go, so inventing a member
   * would be a two-repo change. The domain's existing answer to "this shipment is not
   * happening at this agency" is `reject` — it sets `rejected`, puts the order items on
   * hold at `pending_agency_reassignment` through the same mechanism the agency-
   * deactivation cascade uses, cancels pending offers, releases agent capacity and
   * notifies the vendor. Delegating to it gets all of that; the route is named for the
   * action the PERMISSION governs.
   *
   * ── The window this covers, stated plainly ────────────────────────────────
   * `reject` refuses anything but `assigned` (422 `SHIPMENT_REJECTION_NOT_ALLOWED`), and
   * the admin path INHERITS that refusal rather than widening it. So this covers exactly
   * "dispatched to an agency, not yet picked up". A picked-up shipment is physically with
   * an agent, and the domain's answer there is a reassignment or a return — widening
   * `reject` to reach it would be inventing the parallel implementation this design exists
   * to avoid.
   */
  static cancel = asyncHandler(async (req: Request, res: Response) => {
    const { reason, note } = CancelShipmentSchema.parse(req.body ?? {});
    const shipmentId = req.params.shipmentId;

    const shipment = await shipmentRepository.findById(shipmentId);
    if (!shipment) {
      throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404, undefined, { shipmentId });
    }

    const actor = adminCallerActor(req);
    const result = await shipmentService.reject(
      shipment.agency_id.toString(),
      shipmentId,
      reason,
      note,
      {
        userId: actor?.id ?? '',
        // `actorSourceOfRole('admin')`, written out: the id belongs to the wi-admin
        // database and resolves in no collection here, and the name snapshot beside it is
        // the only record of who acted there will ever be.
        source: 'admin',
        name: actor?.name ?? null,
        role: 'admin',
      }
    );

    sendSuccess(res, result, { message: 'Shipment cancelled and returned for re-routing' });
  });
}
