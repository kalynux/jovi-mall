import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IOrder, OrderModel } from '../../orders/order.model';
import { IShipment, ShipmentModel } from '../../shipments/shipment.model';
import { ticketService } from '../../tickets/services/ticket.service';
import { EntityType, TicketImportance, TicketPriority, TicketType } from '../../tickets/types/ticket.types';
import {
  amountPaidOnlineOf,
  parcelReturnPlanOf,
  PartialReturnFault,
  proposedFaultOf,
} from '../../orders/domain/partial-payment';
import { getRefundEarningsPort } from '../domain/refund-ports';
import { IRefundRequest } from '../models/refund-request.model';
import { RefundActor, refundRequestService, RefundRequestService } from './refund-request.service';

/** Fees the customer does not pay are charged to whoever caused the return (D-12). */
const feesPaidByOf = (fault: PartialReturnFault | null) => fault ?? 'customer';

/**
 * A PARTIAL order's parcel came back while the platform holds what the customer prepaid on it (owner
 * decisions D-2, D-10, D-11, D-12, 2026-11-01). The rules are pure (`parcelReturnPlanOf`,
 * `proposedFaultOf`); the money side, once the refund completes, is
 * `PartialReturnSettlementService`.
 *
 * ⛔ **Nothing here sends money.** Every refund waits for an administrator, who can change the fault
 * the agent's report proposed: an agent's word costs the customer money, so a person confirms it.
 *
 * ── Why one parcel at a time ──────────────────────────────────────────────────
 * One order may have only one refund request open (`findOpenForSource`, a unique index). A second
 * returned parcel simply waits: its `prepaid_return` stays null and the sweep opens it next.
 */
export class PartialReturnService {
  constructor(private readonly refunds: RefundRequestService = refundRequestService) {}

  /** Open the refund of the next returned parcel of this order. Safe to call repeatedly. */
  async openForReturnedParcels(orderId: string): Promise<IRefundRequest | null> {
    const order = await OrderModel.findById(orderId);
    if (!order || amountPaidOnlineOf(order) <= 0) return null;
    if (await this.refunds.findOpenForSource('order', orderId)) return null;

    const parcel = await ShipmentModel.findOne({
      order_id: order._id,
      status: 'returned',
      prepaid_amount: { $gt: 0 },
      prepaid_return: null,
    });
    if (!parcel) return null;

    const claimed = await ShipmentModel.findOneAndUpdate(
      { _id: parcel._id, status: 'returned', prepaid_return: null },
      { $set: { prepaid_return: { refund_request_id: null, opened_at: new Date(), settled_at: null } } },
      { new: true }
    );
    if (!claimed) return null;

    try {
      const lastReport = lastFailureOf(claimed);
      return await this.openForParcel(order, claimed, proposedFaultOf(lastReport.reason), null);
    } catch (error) {
      // Nothing was opened: leave the parcel for the sweep rather than stranding the money.
      await ShipmentModel.updateOne({ _id: claimed._id }, { $set: { prepaid_return: null } });
      throw error;
    }
  }

  /** The nightly backstop, and what opens a second returned parcel once the first is done. */
  async sweep(limit = 100): Promise<number> {
    const orderIds: Types.ObjectId[] = await ShipmentModel.distinct('order_id', {
      status: 'returned',
      prepaid_amount: { $gt: 0 },
      prepaid_return: null,
    });
    let opened = 0;
    for (const orderId of orderIds.slice(0, limit)) {
      try {
        if (await this.openForReturnedParcels(orderId.toString())) opened += 1;
      } catch (error) {
        console.error(`[PartialReturnService] could not open a returned parcel's refund on order ${orderId}:`, error);
      }
    }
    return opened;
  }

  /**
   * An administrator says whose fault the return is (D-11). The amount and who pays the fees both
   * depend on it, so the waiting request is replaced rather than edited: every figure on a request
   * was fixed together, and the rejected one stays as the record of what was first proposed.
   */
  async setFault(requestId: string, fault: PartialReturnFault, actor: RefundActor): Promise<IRefundRequest> {
    const row = await this.refunds.getByIdOrThrow(requestId);
    if (!row.partial_return || row.status !== 'awaiting_approval') {
      throw createAppError(ERROR_CODES.REFUND_PARTIAL_RETURN_NOT_APPLICABLE, 422, undefined, { status: row.status });
    }
    const [order, parcel] = await Promise.all([
      OrderModel.findById(row.source_id),
      ShipmentModel.findById(row.partial_return.shipment_id),
    ]);
    if (!order || !parcel) {
      throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, 'The order to refund was not found');
    }
    await this.refunds.reject(requestId, actor, `Replaced: the fault was set to ${fault}`);
    const replacement = await this.openForParcel(order, parcel, fault, actor);
    // The return fee used everything: settled with nothing to send, so the rejected row is the record.
    return replacement ?? this.refunds.getByIdOrThrow(requestId);
  }

  /**
   * Paid after the order was cancelled: a mobile-money prompt approved late. The order is not coming
   * back and the money is real, so a refund waits for an administrator. No parcel went anywhere, so
   * no return fee and no fault.
   */
  async openForLatePayment(order: IOrder): Promise<void> {
    const orderId = order._id.toString();
    let ticketId: string | null = null;
    try {
      const ticket = await ticketService.createSystemTicket({
        type: TicketType.ORDER_REFUND,
        entityType: EntityType.ORDER,
        entityId: orderId,
        subject: `Refund owed: order ${order.order_number} was paid after it was cancelled`,
        description:
          `Order ${order.order_number} was already cancelled when the customer's online part arrived ` +
          `(${amountPaidOnlineOf(order)} ${order.currency}). A refund request for it is waiting for approval.`,
        importance: TicketImportance.HIGH,
        priority: TicketPriority.HIGH,
      });
      ticketId = (ticket as { _id?: { toString(): string } } | null)?._id?.toString() ?? null;
    } catch (error) {
      console.error(`[PartialReturnService] could not open the late-payment ticket on order ${orderId}:`, error);
    }
    try {
      await this.refunds.create({
        source: { kind: 'order', id: orderId },
        reasonKind: 'cancellation',
        reason: 'The online part was paid after the order was cancelled',
        requestedBy: { id: null, role: 'system', name: 'late payment on a cancelled order' },
        approveNow: false,
        ticketId,
        earningsImpact: 'none',
        amount: amountPaidOnlineOf(order),
      });
    } catch (error) {
      // The ticket above still carries the case.
      console.error(`[PartialReturnService] could not open the late-payment refund on order ${orderId}:`, error);
    }
  }

  private async openForParcel(
    order: IOrder,
    parcel: IShipment,
    fault: PartialReturnFault | null,
    actor: RefundActor | null
  ): Promise<IRefundRequest | null> {
    const orderId = order._id.toString();
    const parcelId = parcel._id.toString();
    const prepaid = parcel.prepaid_amount ?? 0;
    const returnFee = await getRefundEarningsPort().returnFeeOfParcel(parcelId);
    // With no fault named yet the request shows the whole prepaid part. It cannot be approved until
    // somebody says (`approve`), and saying replaces it with the real figures.
    const plan = parcelReturnPlanOf({ prepaid, returnFee, fault: fault ?? 'agency' });
    const report = lastFailureOf(parcel);

    // The return fee took everything: nothing to send, and nothing for `approve` to wait on.
    if (plan.refundGross <= 0) {
      await getRefundEarningsPort().onPartialReturnCompleted({
        refundKey: `partial_return:${parcelId}`,
        orderId,
        shipmentId: parcelId,
        fault: fault ?? 'customer',
        returnFee,
        feesCharge: 0,
        orderNumber: order.order_number ?? null,
      });
      await this.openTicket(order, parcel, fault, `The agency's return fee (${returnFee} ${order.currency}) used all of the ${prepaid} prepaid on this parcel, so no refund was opened.`);
      return null;
    }

    const ticketId = actor
      ? null
      : await this.openTicket(order, parcel, fault, `A refund request is waiting for approval in the refund queue.`);
    const row = await this.refunds.create({
      source: { kind: 'order', id: orderId },
      amount: plan.refundGross,
      reasonKind: 'return',
      reason: `Parcel ${parcel.tracking_number ?? parcelId} came back${report.reason ? ` (${report.reason})` : ''}`,
      requestedBy: actor
        ? { id: actor.id, role: 'admin', name: actor.name }
        : { id: null, role: 'system', name: 'parcel returned' },
      approveNow: false,
      ticketId,
      earningsImpact: 'none',
      feesPaidBy: feesPaidByOf(fault),
      partialReturn: {
        shipment_id: parcel._id as Types.ObjectId,
        fault,
        return_fee: returnFee,
        prepaid_amount: prepaid,
        agent_reason: report.reason,
        agent_note: report.note,
        fault_set_by: actor ? { id: actor.id, name: actor.name, at: new Date() } : null,
      },
    });
    await ShipmentModel.updateOne({ _id: parcel._id }, { $set: { 'prepaid_return.refund_request_id': row._id } });
    return row;
  }

  /** Best-effort: the refund queue carries the case either way. */
  private async openTicket(
    order: IOrder,
    parcel: IShipment,
    fault: PartialReturnFault | null,
    outcome: string
  ): Promise<string | null> {
    const report = lastFailureOf(parcel);
    try {
      const ticket = await ticketService.createSystemTicket({
        type: TicketType.ORDER_REFUND,
        entityType: EntityType.ORDER,
        entityId: order._id.toString(),
        subject: `Returned parcel on partly paid order ${order.order_number}`,
        description:
          `A parcel on order ${order.order_number} came back while the customer had prepaid ` +
          `${parcel.prepaid_amount ?? 0} ${order.currency} on it.\n` +
          `Agent's reason: ${report.reason ?? 'none given'}\n` +
          `Agent's note: ${report.note ?? 'none'}\n` +
          `Proposed fault: ${fault ?? 'none: an administrator must decide'}\n\n` +
          `${outcome}\n` +
          `Customer at fault: the agency's return fee is kept and the rest refunded minus normal fees. ` +
          `Vendor or agency at fault: the customer gets everything back and that party pays.`,
        importance: TicketImportance.HIGH,
        priority: TicketPriority.HIGH,
      });
      return (ticket as { _id?: { toString(): string } } | null)?._id?.toString() ?? null;
    } catch (error) {
      console.error(`[PartialReturnService] could not open the ticket of a returned parcel on order ${order._id}:`, error);
      return null;
    }
  }
}

/** The agent's last report on this parcel: failures are append-only, and the last one is the return. */
function lastFailureOf(parcel: IShipment): { reason: string | null; note: string | null } {
  const failures = parcel.delivery_failures ?? [];
  const last = failures[failures.length - 1];
  return { reason: last?.reason ?? null, note: last?.note ?? null };
}

export const partialReturnService = new PartialReturnService();
