import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { deliveryFeeProposalService, ProposerActor } from '../services/delivery-fee-proposal.service';
import { DeliveryFeeProposalStatus } from '../models/delivery-fee-proposal.model';
import {
  ApproveDeliveryFeeProposalSchema,
  CreateDeliveryFeeProposalSchema,
  EditDeliveryFeeProposalSchema,
  OrderProposalParamsSchema,
  RejectDeliveryFeeProposalSchema,
  ShipmentProposalParamsSchema,
  VendorProposalQuerySchema,
} from '../validators/delivery-fee-proposal.validator';

/**
 * The proposer side (agency + agent) from one factory — the two routers are an
 * endpoint-for-endpoint mirror and only the actor differs, which comes from the token,
 * never the path. The vendor side is `VendorDeliveryFeeProposalController`.
 */
export function buildProposerController(role: 'agency' | 'agent') {
  const actorOf = (req: Request): ProposerActor =>
    role === 'agency'
      ? { role: 'agency', agencyId: req.auth!.role_entity._id.toString(), userId: req.auth!.user.id }
      : { role: 'agent', agentId: req.auth!.role_entity._id.toString(), userId: req.auth!.user.id };

  return {
    /** GET /shipments/:id/delivery-fee-proposals — this shipment's history, newest first. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const { id } = ShipmentProposalParamsSchema.parse(req.params);
      const data = await deliveryFeeProposalService.listForShipment(actorOf(req), id);
      res.json({ success: true, data });
    }),

    /** POST /shipments/:id/delivery-fee-proposals — body { proposedFee, reason }. */
    create: asyncHandler(async (req: Request, res: Response) => {
      const { id } = ShipmentProposalParamsSchema.parse(req.params);
      const input = CreateDeliveryFeeProposalSchema.parse(req.body);
      const data = await deliveryFeeProposalService.propose(actorOf(req), id, input);
      res.status(201).json({ success: true, data, message: 'Delivery-fee proposal sent to the vendor' });
    }),

    /** PATCH /shipments/:id/delivery-fee-proposals/:proposalId — body { proposedFee?, reason?, version? }. */
    edit: asyncHandler(async (req: Request, res: Response) => {
      const { id, proposalId } = ShipmentProposalParamsSchema.parse(req.params);
      const input = EditDeliveryFeeProposalSchema.parse(req.body);
      const data = await deliveryFeeProposalService.edit(actorOf(req), id, proposalId!, input);
      res.json({ success: true, data, message: 'Delivery-fee proposal updated — still awaiting the vendor' });
    }),

    /** POST /shipments/:id/delivery-fee-proposals/:proposalId/withdraw */
    withdraw: asyncHandler(async (req: Request, res: Response) => {
      const { id, proposalId } = ShipmentProposalParamsSchema.parse(req.params);
      const data = await deliveryFeeProposalService.withdraw(actorOf(req), id, proposalId!);
      res.json({ success: true, data, message: 'Delivery-fee proposal withdrawn' });
    }),
  };
}

export const AgencyDeliveryFeeProposalController = buildProposerController('agency');
export const AgentDeliveryFeeProposalController = buildProposerController('agent');

export class VendorDeliveryFeeProposalController {
  /** GET /api/vendor/delivery-fee-proposals?status=&orderId=&page=&limit= — the inbox. */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const q = VendorProposalQuerySchema.parse(req.query);
    const page = await deliveryFeeProposalService.listForVendor(
      vendorId,
      { status: q.status as DeliveryFeeProposalStatus | undefined, orderId: q.orderId },
      q.page,
      q.limit
    );
    res.json({
      success: true,
      data: page.data,
      meta: { total: page.meta.total, page: page.meta.page, limit: page.meta.limit, totalPages: page.meta.pages },
    });
  });

  /** GET /api/vendor/orders/:id/delivery-fee-proposals */
  static listForOrder = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { id } = OrderProposalParamsSchema.parse(req.params);
    const data = await deliveryFeeProposalService.listForVendorOrder(vendorId, id);
    res.json({ success: true, data });
  });

  /** POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/approve */
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const { version } = ApproveDeliveryFeeProposalSchema.parse(req.body ?? {});
    const data = await deliveryFeeProposalService.approve(vendorId, req.auth!.user.id, id, proposalId!, version);
    res.json({ success: true, data, message: 'Delivery fee updated' });
  });

  /** POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/reject — body { note? } */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const { note, version } = RejectDeliveryFeeProposalSchema.parse(req.body ?? {});
    const data = await deliveryFeeProposalService.reject(vendorId, req.auth!.user.id, id, proposalId!, note ?? null, version);
    res.json({ success: true, data, message: 'Delivery-fee proposal rejected — the original fee stands' });
  });
}
