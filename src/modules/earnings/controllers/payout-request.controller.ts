import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { payoutRequestService } from '../services/payout-request.service';
import { ActorRole } from '../../tickets/types/ticket.types';
import { EarningsOwnerType } from '../models/earnings-account.model';

/**
 * Shared vendor/agency payout-request endpoints. `req.auth!.role` picks which
 * EarningsAccount bucket this requester owns. Mounted at `/api/vendor` →
 * `/vendor/earnings/payout` and `/api/agency` → `/agency/earnings/payout`.
 */
export class PayoutRequestController {
  static requestPayout = asyncHandler(async (req: Request, res: Response) => {
    const ownerType = req.auth!.role as EarningsOwnerType;
    const ownerId = req.auth!.role_entity._id.toString();
    const requestedByUserId = req.auth!.user.id;
    const requestedByRole = req.auth!.role as ActorRole;

    const payoutRequest = await payoutRequestService.requestPayout(
      ownerType,
      ownerId,
      requestedByUserId,
      requestedByRole
    );

    res.status(201).json({
      success: true,
      data: {
        id: payoutRequest.id,
        amount: payoutRequest.amount,
        currency: payoutRequest.currency,
        status: payoutRequest.status,
        origin: payoutRequest.origin,
        ticketId: payoutRequest.ticket_id?.toString() ?? null,
        createdAt: payoutRequest.created_at.toISOString(),
      },
      message: 'Payout request created. Track its progress under Tickets.',
    });
  });

  static getCurrent = asyncHandler(async (req: Request, res: Response) => {
    const ownerType = req.auth!.role as EarningsOwnerType;
    const ownerId = req.auth!.role_entity._id.toString();

    const payoutRequest = await payoutRequestService.getLatestForOwner(ownerType, ownerId);

    res.status(200).json({
      success: true,
      data: payoutRequest
        ? {
            id: payoutRequest.id,
            amount: payoutRequest.amount,
            currency: payoutRequest.currency,
            status: payoutRequest.status,
            origin: payoutRequest.origin,
            ticketId: payoutRequest.ticket_id?.toString() ?? null,
            rejectionReason: payoutRequest.rejection_reason,
            createdAt: payoutRequest.created_at.toISOString(),
            resolvedAt: payoutRequest.resolved_at?.toISOString() ?? null,
          }
        : null,
    });
  });
}
