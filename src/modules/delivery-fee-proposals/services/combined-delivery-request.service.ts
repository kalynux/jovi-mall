import { Types } from 'mongoose';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../magazin/repositories/magazin.repository';
import { deliveryPayerOf } from '../../orders/domain/delivery-payer';
import {
  CombinedCandidate,
  CombinedRequestStatus,
  checkCombinedRequest,
  checkCombinedResponse,
  combinedSaving,
} from '../domain/customer-fee-change.rules';
import { MAX_NON_WITHDRAWN_PROPOSALS } from '../domain/delivery-fee-proposal.rules';
import { CombinedDeliveryRequestModel, ICombinedDeliveryRequest } from '../models/combined-delivery-request.model';
import { deliveryFeeProposalRepository } from '../repositories/delivery-fee-proposal.repository';
import { CustomerFeeApplicationService, customerFeeApplicationService } from './customer-fee-application.service';
import { customerFeeNotifier } from './customer-fee-notifier';
import { DeliveryFeeProposalService, deliveryFeeProposalService } from './delivery-fee-proposal.service';

export interface CombinedDeliveryRequestDto {
  id: string;
  cartId: string;
  agencyId: string;
  currency: string;
  status: CombinedRequestStatus;
  note: string | null;
  shipments: Array<{ shipmentId: string; orderId: string; feeAtRequest: number }>;
  answer: {
    fees: Array<{ shipmentId: string; feeBefore: number; feeAfter: number; proposalId: string }>;
    saving: number;
    note: string | null;
    answeredAt: Date;
  } | null;
  declineNote: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

export function toCombinedDeliveryRequestDto(r: ICombinedDeliveryRequest): CombinedDeliveryRequestDto {
  return {
    id: (r._id as Types.ObjectId).toString(),
    cartId: r.cart_id.toString(),
    agencyId: r.agency_id.toString(),
    currency: r.currency,
    status: r.status,
    note: r.note ?? null,
    shipments: r.shipments.map((s) => ({
      shipmentId: s.shipment_id.toString(),
      orderId: s.order_id.toString(),
      feeAtRequest: s.fee_at_request,
    })),
    answer: r.answer
      ? {
          fees: r.answer.fees.map((f) => ({
            shipmentId: f.shipment_id.toString(),
            feeBefore: f.fee_before,
            feeAfter: f.fee_after,
            proposalId: f.proposal_id.toString(),
          })),
          saving: r.answer.saving,
          note: r.answer.note ?? null,
          answeredAt: r.answer.answered_at,
        }
      : null,
    declineNote: r.decline_note ?? null,
    createdAt: r.created_at,
    closedAt: r.closed_at ?? null,
  };
}

/**
 * The combined-price request (owner decision D-8, ADR-A11): a customer asks ONE agency for a
 * cheaper delivery on ≥ 2 of their parcels from ONE checkout, after paying. Fees stay posted
 * prices at checkout; this is the only bargaining over delivery, and it can only go DOWN — the
 * agency answers by lowering fees (each an ordinary decrease proposal, `origin: 'combined_request'`,
 * applied directly and refunded/discounted like any decrease) or by declining.
 *
 * The request is claimed (`open → answered`) BEFORE any fee moves, so two agency users answering
 * at once cannot both lower the same parcels; if not a single fee lands the claim is released.
 */
export class CombinedDeliveryRequestService {
  constructor(
    private readonly proposals: DeliveryFeeProposalService = deliveryFeeProposalService,
    private readonly feeApp: CustomerFeeApplicationService = customerFeeApplicationService,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly magazins: MagazinRepository = new MagazinRepository()
  ) {}

  async create(
    customerId: string,
    cartId: string,
    input: { agencyId: string; shipmentIds?: string[]; note?: string | null }
  ): Promise<CombinedDeliveryRequestDto> {
    const orders = await this.customerCart(customerId, cartId);
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));
    const all = await ShipmentModel.find({
      order_id: { $in: orders.map((o) => o._id) },
      agency_id: new Types.ObjectId(input.agencyId),
    });
    let chosen: IShipment[];
    if (input.shipmentIds && input.shipmentIds.length > 0) {
      chosen = [];
      for (const id of input.shipmentIds) {
        const s = all.find((x) => (x._id as Types.ObjectId).toString() === id);
        if (!s) {
          throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_INELIGIBLE, 422, undefined, { reason: 'cart', shipmentId: id });
        }
        chosen.push(s);
      }
    } else {
      chosen = all;
    }

    const candidates: CombinedCandidate[] = [];
    for (const s of chosen) {
      const order = orderById.get(s.order_id.toString())!;
      candidates.push({
        shipmentId: (s._id as Types.ObjectId).toString(),
        agencyId: s.agency_id.toString(),
        cartId: order.cart_id.toString(),
        status: s.status,
        payer: deliveryPayerOf(order, s),
        pendingProposal: !!s.pending_delivery_fee_proposal_id,
        countedProposals: await deliveryFeeProposalRepository.countCountedForShipment((s._id as Types.ObjectId).toString()),
      });
    }
    // Asked for "everything this agency carries": keep the eligible ones and judge the count.
    const judged = input.shipmentIds && input.shipmentIds.length > 0
      ? candidates
      : candidates.filter((c) => checkCombinedRequest({ agencyId: input.agencyId, cartId, candidates: [c, c], maxProposals: MAX_NON_WITHDRAWN_PROPOSALS }) === null);
    const refusal = checkCombinedRequest({ agencyId: input.agencyId, cartId, candidates: judged, maxProposals: MAX_NON_WITHDRAWN_PROPOSALS });
    if (refusal) {
      throw createAppError(
        ERROR_CODES.COMBINED_DELIVERY_REQUEST_INELIGIBLE,
        422,
        undefined,
        refusal.code === 'too_few'
          ? { reason: 'too_few', eligible: refusal.eligible, min: refusal.min }
          : { reason: refusal.reason, shipmentId: refusal.shipmentId }
      );
    }

    const open = await CombinedDeliveryRequestModel.findOne({ cart_id: new Types.ObjectId(cartId), agency_id: new Types.ObjectId(input.agencyId), status: 'open' });
    if (open) {
      throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_ALREADY_OPEN, 409, undefined, { requestId: (open._id as Types.ObjectId).toString() });
    }

    const policies = (await this.agencies.findById(input.agencyId))?.policies ?? null;
    const rows = judged.map((c) => {
      const s = chosen.find((x) => (x._id as Types.ObjectId).toString() === c.shipmentId)!;
      const order = orderById.get(s.order_id.toString())!;
      return {
        shipment_id: s._id as Types.ObjectId,
        order_id: order._id as Types.ObjectId,
        vendor_id: order.vendor_id as Types.ObjectId,
        fee_at_request: this.feeApp.effectiveFee(s, order, policies),
      };
    });

    let created: ICombinedDeliveryRequest;
    try {
      created = await CombinedDeliveryRequestModel.create({
        customer_id: new Types.ObjectId(customerId),
        cart_id: new Types.ObjectId(cartId),
        agency_id: new Types.ObjectId(input.agencyId),
        currency: orders[0].currency,
        shipments: rows,
        note: input.note ?? null,
        status: 'open',
      });
    } catch (error: any) {
      if (error?.code === 11000) throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_ALREADY_OPEN, 409);
      throw error;
    }

    void eventBus
      .publish('combined_delivery_request.created', {
        eventType: 'combined_delivery_request.created',
        aggregateId: (created._id as Types.ObjectId).toString(),
        occurredAt: new Date(),
        payload: {
          requestId: (created._id as Types.ObjectId).toString(),
          agencyId: input.agencyId,
          customerId,
          cartId,
          shipmentIds: rows.map((r) => r.shipment_id.toString()),
          firstShipmentId: rows[0].shipment_id.toString(),
          parcelCount: rows.length,
          totalFee: rows.reduce((s, r) => s + r.fee_at_request, 0),
          currency: created.currency,
        },
      })
      .catch((err) => console.error('[CombinedDeliveryRequestService] created emit failed:', err));
    return toCombinedDeliveryRequestDto(created);
  }

  async listForCustomer(customerId: string, cartId: string): Promise<CombinedDeliveryRequestDto[]> {
    await this.customerCart(customerId, cartId);
    const rows = await CombinedDeliveryRequestModel.find({ customer_id: new Types.ObjectId(customerId), cart_id: new Types.ObjectId(cartId) }).sort({ created_at: -1 });
    return rows.map(toCombinedDeliveryRequestDto);
  }

  async cancel(customerId: string, cartId: string, requestId: string): Promise<CombinedDeliveryRequestDto> {
    if (!Types.ObjectId.isValid(requestId)) throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_FOUND, 404);
    const updated = await CombinedDeliveryRequestModel.findOneAndUpdate(
      { _id: requestId, customer_id: new Types.ObjectId(customerId), cart_id: new Types.ObjectId(cartId), status: 'open' },
      { $set: { status: 'cancelled', closed_at: new Date() } },
      { new: true }
    );
    if (!updated) throw await this.miss({ _id: requestId, customer_id: new Types.ObjectId(customerId) });
    return toCombinedDeliveryRequestDto(updated);
  }

  async listForAgency(
    agencyId: string,
    filter: { status?: CombinedRequestStatus },
    page: number,
    limit: number
  ): Promise<{ data: CombinedDeliveryRequestDto[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const query: Record<string, unknown> = { agency_id: new Types.ObjectId(agencyId) };
    if (filter.status) query.status = filter.status;
    const [rows, total] = await Promise.all([
      CombinedDeliveryRequestModel.find(query).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit),
      CombinedDeliveryRequestModel.countDocuments(query),
    ]);
    return {
      data: rows.map(toCombinedDeliveryRequestDto),
      meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /**
   * The agency answers: `fees` (each LOWER than the parcel's current fee — applied directly) or
   * `decline`. Returns the request and, per fee, what happened (a fee that could not be applied
   * — the parcel was picked up meanwhile — is reported, never silently dropped).
   */
  async respond(
    agencyId: string,
    userId: string,
    requestId: string,
    input: { fees?: Array<{ shipmentId: string; proposedFee: number }>; decline?: boolean; note?: string | null }
  ): Promise<{ request: CombinedDeliveryRequestDto; failed: Array<{ shipmentId: string; code: string }> }> {
    if (!Types.ObjectId.isValid(requestId)) throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_FOUND, 404);
    const request = await CombinedDeliveryRequestModel.findOne({ _id: requestId, agency_id: new Types.ObjectId(agencyId) });
    if (!request) throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_FOUND, 404);
    if (request.status !== 'open') {
      throw createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_OPEN, 409, undefined, { status: request.status });
    }
    const agencyName = (await this.magazins.findNameByAgencyId(agencyId).catch(() => null)) ?? '';

    if (input.decline) {
      const declined = await CombinedDeliveryRequestModel.findOneAndUpdate(
        { _id: request._id, status: 'open' },
        { $set: { status: 'declined', decline_note: input.note ?? null, closed_at: new Date() } },
        { new: true }
      );
      if (!declined) throw await this.miss({ _id: request._id });
      await this.tellCustomer(declined, agencyName, 0, true);
      return { request: toCombinedDeliveryRequestDto(declined), failed: [] };
    }

    // Validate against the parcels as they stand NOW.
    const fees = input.fees ?? [];
    const shipments = await ShipmentModel.find({ _id: { $in: request.shipments.map((s) => s.shipment_id) } });
    const orders = await OrderModel.find({ _id: { $in: request.shipments.map((s) => s.order_id) } });
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));
    const policies = (await this.agencies.findById(agencyId))?.policies ?? null;
    const currentFees = new Map<string, number>();
    for (const s of shipments) {
      const order = orderById.get(s.order_id.toString());
      if (order) currentFees.set((s._id as Types.ObjectId).toString(), this.feeApp.effectiveFee(s, order, policies));
    }
    const refusal = checkCombinedResponse({
      requestShipmentIds: request.shipments.map((s) => s.shipment_id.toString()),
      fees,
      currentFees,
    });
    if (refusal) {
      throw createAppError(ERROR_CODES.COMBINED_DELIVERY_RESPONSE_INVALID, 422, undefined, {
        reason: refusal.code,
        ...('shipmentId' in refusal ? { shipmentId: refusal.shipmentId } : {}),
        ...('currentFee' in refusal ? { currentFee: refusal.currentFee } : {}),
      });
    }

    // Claim the request before any fee moves.
    const claimed = await CombinedDeliveryRequestModel.findOneAndUpdate(
      { _id: request._id, status: 'open' },
      { $set: { status: 'answered' } },
      { new: true }
    );
    if (!claimed) throw await this.miss({ _id: request._id });

    const applied: Array<{ shipment_id: Types.ObjectId; fee_before: number; fee_after: number; proposal_id: Types.ObjectId }> = [];
    const failed: Array<{ shipmentId: string; code: string }> = [];
    for (const f of fees) {
      const shipment = shipments.find((s) => (s._id as Types.ObjectId).toString() === f.shipmentId)!;
      const order = orderById.get(shipment.order_id.toString())!;
      try {
        const proposal = await this.proposals.raiseSystemProposal({
          shipment,
          order,
          proposedFee: f.proposedFee,
          reason: input.note?.trim() || 'Combined delivery price',
          origin: 'combined_request',
          combinedRequestId: request._id as Types.ObjectId,
          agencyActor: { agencyId, userId },
        });
        applied.push({
          shipment_id: shipment._id as Types.ObjectId,
          fee_before: proposal.fee_before,
          fee_after: proposal.proposed_fee,
          proposal_id: proposal._id as Types.ObjectId,
        });
      } catch (error) {
        failed.push({ shipmentId: f.shipmentId, code: error instanceof AppError ? error.code : 'INTERNAL_SERVER_ERROR' });
      }
    }

    if (applied.length === 0) {
      // Nothing landed — release the claim so the agency can answer again.
      await CombinedDeliveryRequestModel.updateOne({ _id: request._id, status: 'answered', answer: null }, { $set: { status: 'open' } });
      throw createAppError(ERROR_CODES.COMBINED_DELIVERY_RESPONSE_INVALID, 422, undefined, { reason: 'none_applied', failed });
    }

    const saving = combinedSaving(applied.map((a) => ({ proposedFee: a.fee_after, currentFee: a.fee_before })));
    const answered = await CombinedDeliveryRequestModel.findOneAndUpdate(
      { _id: request._id },
      {
        $set: {
          answer: {
            fees: applied,
            saving,
            note: input.note ?? null,
            answered_by_user_id: Types.ObjectId.isValid(userId) ? new Types.ObjectId(userId) : null,
            answered_at: new Date(),
          },
          closed_at: new Date(),
        },
      },
      { new: true }
    );
    await this.tellCustomer(answered!, agencyName, saving, false);
    return { request: toCombinedDeliveryRequestDto(answered!), failed };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async customerCart(customerId: string, cartId: string): Promise<IOrder[]> {
    if (!Types.ObjectId.isValid(cartId)) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    const orders = await OrderModel.find({ cart_id: new Types.ObjectId(cartId), customer_id: new Types.ObjectId(customerId) });
    if (orders.length === 0) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    return orders;
  }

  private async miss(scope: Record<string, unknown>) {
    const fresh = await CombinedDeliveryRequestModel.findOne(scope);
    if (!fresh) return createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_FOUND, 404);
    return createAppError(ERROR_CODES.COMBINED_DELIVERY_REQUEST_NOT_OPEN, 409, undefined, { status: fresh.status });
  }

  /** One message for the whole request, on the first parcel's order. */
  private async tellCustomer(request: ICombinedDeliveryRequest, agencyName: string, saving: number, declined: boolean): Promise<void> {
    const order = await OrderModel.findById(request.shipments[0]?.order_id);
    if (!order) return;
    customerFeeNotifier.combinedAnswered(order, {
      requestId: (request._id as Types.ObjectId).toString(),
      agencyName: agencyName || '—',
      saving,
      declined,
    });
  }
}

export const combinedDeliveryRequestService = new CombinedDeliveryRequestService();
