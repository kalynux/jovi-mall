import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { deliveryFeeProposalService, ProposerActor } from '../services/delivery-fee-proposal.service';
import { DeliveryFeeProposalStatus } from '../models/delivery-fee-proposal.model';
import { combinedDeliveryRequestService } from '../services/combined-delivery-request.service';
import { deriveProviderOrThrow } from '../../payments/services/payment-routing.service';
import {
  AgencyCombinedQuerySchema,
  CartCombinedParamsSchema,
  CombinedRequestParamsSchema,
  CreateCombinedDeliveryRequestSchema,
  CustomerApproveDeliveryFeeProposalSchema,
  CustomerRejectDeliveryFeeProposalSchema,
  PayDeliveryTopupSchema,
  RespondCombinedDeliveryRequestSchema,
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

  /**
   * POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/cover — ADR-A11 D-10: the
   * vendor takes a change-agency difference on itself without waiting for the customer.
   */
  static cover = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const data = await deliveryFeeProposalService.coverByVendor(vendorId, req.auth!.user.id, id, proposalId!);
    res.json({ success: true, data, message: 'You cover the delivery difference — the customer pays nothing more' });
  });

  /** POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/reject — body { note?, version } */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const vendorId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const { note, version } = RejectDeliveryFeeProposalSchema.parse(req.body ?? {});
    const data = await deliveryFeeProposalService.reject(vendorId, req.auth!.user.id, id, proposalId!, note ?? null, version);
    res.json({ success: true, data, message: 'Delivery-fee proposal rejected — the original fee stands' });
  });
}

/**
 * The CUSTOMER side (ADR-A11, owner decision D-8) — mounted under /api/customer/orders, behind
 * requireAuth + requireRole(['customer']). Every read and write is scoped to the caller's own
 * order (404, never 403, for anyone else's).
 */
export class CustomerDeliveryFeeProposalController {
  /** GET /api/customer/orders/:id/delivery-fee-proposals */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { id } = OrderProposalParamsSchema.parse(req.params);
    const data = await deliveryFeeProposalService.listForCustomerOrder(customerId, id);
    res.json({ success: true, data });
  });

  /** POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/approve — body { version } */
  static approve = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const { version } = CustomerApproveDeliveryFeeProposalSchema.parse(req.body ?? {});
    const data = await deliveryFeeProposalService.customerApprove(customerId, req.auth!.user.id, id, proposalId!, version);
    res.json({
      success: true,
      data,
      message: data.topup && data.topup.status === 'awaiting_payment'
        ? 'Approved — pay the difference to confirm your delivery'
        : 'New delivery fee confirmed',
    });
  });

  /** POST …/:proposalId/reject — body { version, note? } */
  static reject = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const { note, version } = CustomerRejectDeliveryFeeProposalSchema.parse(req.body ?? {});
    const data = await deliveryFeeProposalService.customerReject(customerId, req.auth!.user.id, id, proposalId!, note ?? null, version);
    res.json({ success: true, data, message: 'Declined' });
  });

  /** POST …/:proposalId/pay — body { provider?, gateway? (ignored), channel } — the top-up charge. */
  static pay = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { id, proposalId } = OrderProposalParamsSchema.parse(req.params);
    const body = PayDeliveryTopupSchema.parse(req.body ?? {});
    // `gateway` is accepted and ignored (ADR-A08). Not counted: this door is new, so no app
    // built before provider routing can be calling it.
    const selection = { provider: deriveProviderOrThrow(body) };
    const data = await deliveryFeeProposalService.customerPay(customerId, id, proposalId!, selection, body.channel);
    res.json({ success: data.status !== 'FAILED', data });
  });
}

export class CustomerCombinedDeliveryRequestController {
  /** POST /api/customer/orders/groups/:cartId/combined-delivery-requests — body { agencyId, shipmentIds?, note? } */
  static create = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { cartId } = CartCombinedParamsSchema.parse(req.params);
    const input = CreateCombinedDeliveryRequestSchema.parse(req.body ?? {});
    const data = await combinedDeliveryRequestService.create(customerId, cartId, input);
    res.status(201).json({ success: true, data, message: 'Request sent to the delivery company' });
  });

  /** GET /api/customer/orders/groups/:cartId/combined-delivery-requests */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { cartId } = CartCombinedParamsSchema.parse(req.params);
    const data = await combinedDeliveryRequestService.listForCustomer(customerId, cartId);
    res.json({ success: true, data });
  });

  /** POST /api/customer/orders/groups/:cartId/combined-delivery-requests/:requestId/cancel */
  static cancel = asyncHandler(async (req: Request, res: Response) => {
    const customerId = req.auth!.role_entity._id.toString();
    const { cartId, requestId } = CartCombinedParamsSchema.parse(req.params);
    const data = await combinedDeliveryRequestService.cancel(customerId, cartId, requestId!);
    res.json({ success: true, data, message: 'Request cancelled' });
  });
}

export class AgencyCombinedDeliveryRequestController {
  /** GET /api/agency/combined-delivery-requests?status=&page=&limit= */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const q = AgencyCombinedQuerySchema.parse(req.query);
    const page = await combinedDeliveryRequestService.listForAgency(agencyId, { status: q.status }, q.page, q.limit);
    res.json({ success: true, data: page.data, meta: page.meta });
  });

  /** POST /api/agency/combined-delivery-requests/:requestId/respond — body { fees } | { decline: true }, note? */
  static respond = asyncHandler(async (req: Request, res: Response) => {
    const agencyId = req.auth!.role_entity._id.toString();
    const { requestId } = CombinedRequestParamsSchema.parse(req.params);
    const input = RespondCombinedDeliveryRequestSchema.parse(req.body ?? {});
    const data = await combinedDeliveryRequestService.respond(agencyId, req.auth!.user.id, requestId, input);
    res.json({ success: true, data, message: input.decline ? 'Request declined' : 'Lower fees applied' });
  });
}
