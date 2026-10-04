import { Types } from 'mongoose';
import { AppError, createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { customerDeliveryFeeOf, deliveryPayerOf } from '../../orders/domain/delivery-payer';
import { ticketService } from '../../tickets/services/ticket.service';
import { EntityType, TicketImportance, TicketType } from '../../tickets/types/ticket.types';
import { WholeMovePlan, planWholeMove, vendorBorneOf } from '../domain/customer-fee-change.rules';
import { deliveryFeeProposalRepository } from '../repositories/delivery-fee-proposal.repository';
import { CustomerFeeApplicationService, customerFeeApplicationService } from './customer-fee-application.service';
import { DeliveryFeeProposalService, deliveryFeeProposalService } from './delivery-fee-proposal.service';

/** What `prepareWholeMove` learned, carried to `completeWholeMove` after the item has moved. */
export interface WholeMoveContext {
  orderId: string;
  sourceShipmentId: string;
  sourcePendingProposalId: string | null;
  destinationExisted: boolean;
  plan: WholeMovePlan;
  /** The destination carried an agreed override — its price is not re-derived (the agency may propose). */
  skipDifference: boolean;
}

/**
 * Change of delivery agency on a CUSTOMER-paid order (owner decision D-10, ADR-A11).
 *
 *  - A WHOLE shipment moving (the moved item was its last one, so the source row is deleted):
 *    the customer's paid delivery is CARRIED to the destination (A — nothing they paid is left
 *    on a deleted row), and the move itself is money-neutral: the destination takes the source's
 *    fee and the customer's money unchanged. Then the new agency's posted price is compared, and
 *    the difference goes through the customer flow (B): lower → a decrease applied directly
 *    (online: refunded; COD: less cash); higher → a customer-approval request, and a rejection
 *    means the VENDOR covers the difference.
 *  - A PARTIAL move (other items stay on the source): the moved item's new run is VENDOR-paid —
 *    today's behaviour (W-C), untouched here.
 *
 * `prepareWholeMove` runs BEFORE the move and may refuse it: if the vendor could not afford to
 * cover the new price should the customer decline, the move is refused
 * (`DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE`) rather than leaving a request nobody can
 * answer safely. `completeWholeMove` runs after it and never throws — a failure there opens a
 * HIGH ticket, because the change-agency path it is called from is not transactional.
 */
export class ChangeAgencyFeeService {
  constructor(
    private readonly feeApp: CustomerFeeApplicationService = customerFeeApplicationService,
    private readonly proposals: DeliveryFeeProposalService = deliveryFeeProposalService,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  async prepareWholeMove(input: {
    orderId: string;
    itemId: string;
    sourceShipmentId: string | null;
    destinationAgencyId: string;
  }): Promise<WholeMoveContext | null> {
    if (!input.sourceShipmentId) return null;
    const order = await OrderModel.findById(input.orderId);
    if (!order || deliveryPayerOf(order) !== 'customer') return null;
    const source = await ShipmentModel.findById(input.sourceShipmentId);
    if (!source) return null;
    const whole = source.items.length === 1 && source.items[0].order_item_id.toString() === input.itemId;
    if (!whole) return null;
    const sourceCustomerFee = customerDeliveryFeeOf(order, source);
    if (sourceCustomerFee <= 0) return null;

    const sourcePolicies = (await this.agencies.findById(source.agency_id.toString()))?.policies ?? null;
    const destPolicies = (await this.agencies.findById(input.destinationAgencyId))?.policies ?? null;
    const sourceFee = this.feeApp.effectiveFee(source, order, sourcePolicies);
    // The same grouping rule `ShipmentRepository.findGroupableByOrderAndAgency` applies.
    const destination = await ShipmentModel.findOne({
      order_id: order._id,
      agency_id: input.destinationAgencyId,
      status: { $in: ['pending', 'assigned'] },
    });
    const destinationFee = destination ? this.feeApp.effectiveFee(destination, order, destPolicies) : 0;
    const destinationCustomerFee = destination ? customerDeliveryFeeOf(order, destination) : 0;
    const composition = [...(destination?.items ?? []), ...source.items];
    const skipDifference = !!destination?.delivery_fee_override;
    const newAgencyFee = this.feeApp.formulaFee(
      { items: composition, agency_id: new Types.ObjectId(input.destinationAgencyId) as any, _id: destination?._id },
      order,
      destPolicies
    );

    const plan = planWholeMove({
      mode: this.feeApp.modeOf(order),
      source: { fee: sourceFee, customerFee: sourceCustomerFee, refundable: Math.max(0, source.customer_fee_refundable ?? 0) },
      destination: destination
        ? { fee: destinationFee, customerFee: destinationCustomerFee, refundable: Math.max(0, destination.customer_fee_refundable ?? 0) }
        : null,
      newAgencyFee: skipDifference ? sourceFee + destinationFee : newAgencyFee,
    });

    if (plan.difference.kind === 'increase') {
      // The worst case: the customer declines and the vendor carries the whole difference.
      const borneBefore = vendorBorneOf(plan.interimFee, plan.carriedCustomerFee);
      const borneWorst = vendorBorneOf(plan.difference.newFee, plan.carriedCustomerFee);
      const shipmentLike = {
        _id: destination?._id ?? new Types.ObjectId(),
        agency_id: new Types.ObjectId(input.destinationAgencyId),
        items: composition,
      } as unknown as IShipment;
      const net = await this.feeApp.vendorNetWithBorne(order, shipmentLike, borneBefore, borneWorst);
      if (net <= 0) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE, 422);
    }

    return {
      orderId: input.orderId,
      sourceShipmentId: input.sourceShipmentId,
      sourcePendingProposalId: source.pending_delivery_fee_proposal_id ? source.pending_delivery_fee_proposal_id.toString() : null,
      destinationExisted: !!destination,
      plan,
      skipDifference,
    };
  }

  /** After the move. Never throws (see the class header). */
  async completeWholeMove(ctx: WholeMoveContext, destinationShipmentId: string): Promise<void> {
    try {
      await transactionManager.runInTransactionWithRetry(async (session) => {
        const destination = await ShipmentModel.findById(destinationShipmentId, null, { session });
        if (!destination) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
        const set: Record<string, unknown> = {
          delivery_payer: 'customer',
          customer_delivery_fee: ctx.plan.carriedCustomerFee,
          customer_fee_refundable: ctx.plan.carriedRefundable,
          delivery_fee_snapshot: ctx.plan.interimFee,
        };
        if (destination.delivery_fee_override) set['delivery_fee_override.amount'] = ctx.plan.interimFee;
        await ShipmentModel.updateOne({ _id: destination._id }, { $set: set }, { session });

        // The source row is gone with its last item; a fee change pending on it is closed.
        if (ctx.sourcePendingProposalId) {
          await deliveryFeeProposalRepository.transitionFromPending(
            new Types.ObjectId(ctx.sourcePendingProposalId),
            'withdrawn',
            { role: 'system', userId: null, withdrawalReason: 'shipment_moved' },
            session
          );
        }
      });
    } catch (error) {
      await this.ticket(ctx, destinationShipmentId, `Carrying the customer's delivery money failed: ${(error as Error).message}`);
      return;
    }

    if (ctx.plan.difference.kind === 'none' || ctx.skipDifference) return;
    try {
      const [order, destination] = await Promise.all([
        OrderModel.findById(ctx.orderId),
        ShipmentModel.findById(destinationShipmentId),
      ]);
      if (!order || !destination) return;
      await this.proposals.raiseSystemProposal({
        shipment: destination,
        order,
        proposedFee: ctx.plan.difference.newFee,
        reason: 'Delivery company changed',
        origin: 'change_agency',
      });
    } catch (error) {
      if (error instanceof AppError && error.code === ERROR_CODES.DELIVERY_FEE_PROPOSAL_ALREADY_PENDING) {
        // The new agency's own proposal is already with the customer; it settles the price.
        return;
      }
      await this.ticket(ctx, destinationShipmentId, `Raising the price difference failed: ${(error as Error).message}`);
    }
  }

  private async ticket(ctx: WholeMoveContext, destinationShipmentId: string, cause: string): Promise<void> {
    console.error(`[ChangeAgencyFeeService] order ${ctx.orderId}: ${cause}`);
    try {
      await ticketService.createSystemTicket({
        type: TicketType.ORDER_ISSUE,
        entityType: EntityType.ORDER,
        entityId: ctx.orderId,
        subject: `Delivery fee not carried after a change of agency (order ${ctx.orderId})`,
        description:
          `A customer-paid shipment moved to another agency (destination shipment ${destinationShipmentId}).\n` +
          `Customer delivery money to carry: ${ctx.plan.carriedCustomerFee}; interim fee ${ctx.plan.interimFee}; ` +
          `new agency price difference: ${JSON.stringify(ctx.plan.difference)}.\n` +
          `Cause: ${cause}\n\nSet the destination shipment's customer_delivery_fee / delivery_fee_snapshot by hand.`,
        importance: TicketImportance.HIGH,
      });
    } catch (error) {
      console.error('[ChangeAgencyFeeService] Failed to open the ticket:', error);
    }
  }
}

export const changeAgencyFeeService = new ChangeAgencyFeeService();
