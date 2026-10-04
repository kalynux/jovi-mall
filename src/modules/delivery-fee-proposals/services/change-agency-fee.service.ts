import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { customerDeliveryFeeOf, deliveryPayerOf } from '../../orders/domain/delivery-payer';
import { isWholeShipmentMove } from '../../orders/domain/change-agency-move.rules';
import { WholeMovePlan, planWholeMove, vendorBorneOf } from '../domain/customer-fee-change.rules';
import { CustomerFeeApplicationService, customerFeeApplicationService } from './customer-fee-application.service';
import { DeliveryFeeProposalService, deliveryFeeProposalService } from './delivery-fee-proposal.service';

/** What `prepareWholeMoveInSession` learned, carried to the writes after the items have moved. */
export interface WholeMoveContext {
  orderId: string;
  sourceShipmentId: string;
  destinationExisted: boolean;
  plan: WholeMovePlan;
  /** The destination carried an agreed override — its price is not re-derived (the agency may propose). */
  skipDifference: boolean;
}

/**
 * The vendor's share of the destination's fee before the difference is settled, and in the worst
 * case of an INCREASE — the customer declines and the vendor carries the whole difference (D-10).
 * Pure; `null` for anything but an increase.
 */
export function increaseCoverWorstCase(plan: WholeMovePlan): { borneBefore: number; borneWorst: number } | null {
  if (plan.difference.kind !== 'increase') return null;
  return {
    borneBefore: vendorBorneOf(plan.interimFee, plan.carriedCustomerFee),
    borneWorst: vendorBorneOf(plan.difference.newFee, plan.carriedCustomerFee),
  };
}

/**
 * Change of delivery agency on a CUSTOMER-paid order (owner decisions D-10 and D-12, ADR-A11).
 *
 *  - A WHOLE shipment moving (every item it carries is in the batch, so the source row is
 *    deleted): the customer's paid delivery is CARRIED to the destination (A — nothing they paid
 *    is left on a deleted row), and the move itself is money-neutral: the destination takes the
 *    source's fee and the customer's money unchanged. Then the new agency's posted price is
 *    compared, and the difference goes through the customer flow (B): lower → a decrease applied
 *    directly (online: refunded after the commit; COD: less cash); higher → a customer-approval
 *    request, and a rejection means the VENDOR covers the difference.
 *  - A PARTIAL move (other items stay on the source): the moved items' new run is VENDOR-paid —
 *    W-C's behaviour, untouched here.
 *
 * "Whole" is judged against the BATCH, not item by item: the administrator's move passes every
 * item of a shipment at once, and judging each item alone made the first N−1 partial moves and
 * priced the last one against a destination already carrying a vendor-borne fee for the rest —
 * double-counting the interim fee and turning a genuine increase into a silent, vendor-borne
 * decrease nobody approved.
 *
 * ── One transaction (D-12) ───────────────────────────────────────────────────
 * Every method here runs INSIDE the change-of-agency transaction that
 * `VendorOrderService.moveItemsToAgency` opens, and every read and write joins its `session`:
 * the move, the source deletion, the destination creation/merge, this carry, the COD collection
 * re-pricing and the difference proposal (with its pending pointer and, for a decrease, the money
 * it lands) commit together or not at all. There is no "carry failed after the move" state, and
 * so no ticket fallback: a failure anywhere rolls the whole change back and the caller sees the
 * error. What the difference implies for the outside world — events, the customer's
 * notification, a gateway refund — is returned by `raiseDifferenceInSession` as an `afterCommit`
 * the caller runs once the transaction has committed.
 *
 * Refusals, and why each is safe wherever it fires: an online order whose payment is no longer
 * simply `paid` cannot move delivery money (`DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID`, raised by
 * `prepareWholeMoveInSession`); a vendor who could not afford to cover a higher price should the
 * customer decline (`DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE`, raised by
 * `raiseDifferenceInSession` against the order AS THE MOVE LEFT IT — the source deleted, the
 * destination merged — which is the only state in which the sibling shipments are counted once).
 * Both throw inside the transaction, so whatever was written before them rolls back.
 */
export class ChangeAgencyFeeService {
  constructor(
    private readonly feeApp: CustomerFeeApplicationService = customerFeeApplicationService,
    private readonly proposals: DeliveryFeeProposalService = deliveryFeeProposalService,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  /**
   * Before any item of this source moves: is this a WHOLE customer-paid move, and what will it
   * cost? `order` and `source` must have been read in `session`. Returns null for anything that
   * stays vendor-paid (a partial move, a vendor-paid order, nothing the customer paid).
   */
  async prepareWholeMoveInSession(
    input: {
      order: IOrder;
      source: IShipment | null;
      itemIds: string[];
      destinationAgencyId: string;
    },
    session: ClientSession
  ): Promise<WholeMoveContext | null> {
    const { order, source } = input;
    if (!source) return null;
    if (deliveryPayerOf(order) !== 'customer') return null;
    if (!isWholeShipmentMove(source.items.map((i) => i.order_item_id.toString()), input.itemIds)) return null;
    const sourceCustomerFee = customerDeliveryFeeOf(order, source);
    if (sourceCustomerFee <= 0) return null;

    const sourcePolicies = (await this.agencies.findById(source.agency_id.toString(), session))?.policies ?? null;
    const destPolicies = (await this.agencies.findById(input.destinationAgencyId, session))?.policies ?? null;
    const sourceFee = this.feeApp.effectiveFee(source, order, sourcePolicies);
    // The same grouping rule `ShipmentRepository.findGroupableByOrderAndAgency` applies.
    const destination = await ShipmentModel.findOne(
      {
        order_id: order._id,
        agency_id: input.destinationAgencyId,
        status: { $in: ['pending', 'assigned'] },
      },
      null,
      { session }
    );
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

    const settlesDifference = plan.difference.kind !== 'none' && !skipDifference;
    if (settlesDifference && order.payment_method !== 'cash_on_delivery' && order.payment_status !== 'paid') {
      // The difference would be raised as a customer-paid proposal, which refuses an online
      // order that is not simply paid. Refused here, before this source's first write.
      throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID, 422, undefined, {
        paymentStatus: order.payment_status,
      });
    }

    return {
      orderId: order._id.toString(),
      sourceShipmentId: (source._id as Types.ObjectId).toString(),
      destinationExisted: !!destination,
      plan,
      skipDifference,
    };
  }

  /**
   * After the items have moved, in the same transaction: the destination takes the source's fee
   * and the customer's money (A). Money-neutral — the order's totals and the vendor's share do not
   * move. `fee_components` is deliberately NOT carried: it itemises the OLD agency's formula and
   * is display-only (no money path reads it). Throws (rolling the move back) if the destination
   * is gone.
   */
  async carryInSession(ctx: WholeMoveContext, destinationShipmentId: string, session: ClientSession): Promise<void> {
    const destination = await ShipmentModel.findById(destinationShipmentId, null, { session });
    if (!destination) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    const set: Record<string, unknown> = {
      delivery_payer: 'customer',
      customer_delivery_fee: ctx.plan.carriedCustomerFee,
      customer_fee_refundable: ctx.plan.carriedRefundable,
      delivery_fee_snapshot: ctx.plan.interimFee,
    };
    if (destination.delivery_fee_override) set['delivery_fee_override.amount'] = ctx.plan.interimFee;
    const carried = await ShipmentModel.updateOne({ _id: destination._id }, { $set: set }, { session });
    if (carried.matchedCount !== 1) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
  }

  /**
   * The new agency's price difference (B), in the same transaction: a decrease is applied (money
   * landed, proposal `approved` by `system`), an increase is raised for the customer with the
   * destination's pending pointer claimed — after checking that the vendor could carry it should
   * the customer decline. Returns what must happen once the transaction has committed — the
   * caller runs it, and never if the transaction rolled back.
   *
   * Nothing to settle (same price, or an agreed override kept) → a no-op. A destination already
   * carrying a pending proposal (the new agency's own, with the customer) → that proposal settles
   * the price, and none is raised beside it. Any other failure THROWS: there is no fallback, the
   * whole change of agency rolls back (D-12).
   */
  async raiseDifferenceInSession(ctx: WholeMoveContext, destinationShipmentId: string, session: ClientSession): Promise<() => void> {
    const noop = () => undefined;
    if (ctx.plan.difference.kind === 'none' || ctx.skipDifference) return noop;
    const order = await OrderModel.findById(ctx.orderId, null, { session });
    const destination = await ShipmentModel.findById(destinationShipmentId, null, { session });
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);
    if (!destination) throw createAppError(ERROR_CODES.SHIPMENT_NOT_FOUND, 404);
    if (destination.pending_delivery_fee_proposal_id) return noop;

    const worst = increaseCoverWorstCase(ctx.plan);
    if (worst) {
      // Measured on the order AS THIS TRANSACTION LEFT IT: the source row is gone and the
      // destination carries the merged items and the customer's money, so every sibling shipment
      // is counted exactly once.
      const net = await this.feeApp.vendorNetWithBorne(order, destination, worst.borneBefore, worst.borneWorst, session);
      if (net <= 0) throw createAppError(ERROR_CODES.DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE, 422);
    }

    const raised = await this.proposals.raiseSystemProposalInSession(
      {
        shipment: destination,
        order,
        proposedFee: ctx.plan.difference.newFee,
        reason: 'Delivery company changed',
        origin: 'change_agency',
      },
      session
    );
    return raised.afterCommit;
  }
}

export const changeAgencyFeeService = new ChangeAgencyFeeService();
