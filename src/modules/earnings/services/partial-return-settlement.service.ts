import { OrderModel } from '../../orders/order.model';
import { OrderRepository } from '../../orders/order.repository';
import { parcelReturnPlanOf } from '../../orders/domain/partial-payment';
import { ShipmentModel } from '../../shipments/shipment.model';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import type { PartialReturnCompletedInput } from '../../payments/domain/refund-ports';
import { earningsClawbackService } from './earnings-clawback.service';
import { earningsCompletionService } from './earnings-completion.service';
import { resolveEarnedFee } from './earnings-quote.service';
import { earningsSplitService } from './earnings-split.service';

/**
 * The money side of a PARTIAL order's returned parcel (owner decisions D-2 and D-12, 2026-11-01).
 *
 * A returned cash-on-delivery parcel normally has nothing to divide: no cash, no earnings. A partial
 * one does: the customer prepaid part of it, and the agency made the trip. What happens is decided by
 * whose fault the return is (`parcelReturnPlanOf`), and runs when the refund completes, so an
 * administrator changing the fault can never leave an agency paid for a refund that went the other way.
 */
export class PartialReturnSettlementService {
  constructor(
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly orderRepo: OrderRepository = new OrderRepository()
  ) {}

  /** What the agency's own terms say this return earns, clamped to the fee it was to be paid. */
  async returnFeeOfParcel(shipmentId: string): Promise<number> {
    const shipment = await ShipmentModel.findById(shipmentId).select('agency_id delivery_fee_snapshot').lean();
    if (!shipment) return 0;
    const agency = await this.agencyRepo.findById(shipment.agency_id.toString());
    return resolveEarnedFee('returned', shipment.delivery_fee_snapshot ?? 0, agency?.policies ?? null);
  }

  async settle(input: PartialReturnCompletedInput): Promise<void> {
    const [order, shipment] = await Promise.all([
      this.orderRepo.findById(input.orderId),
      ShipmentModel.findById(input.shipmentId),
    ]);
    if (!order || !shipment) return;

    const plan = parcelReturnPlanOf({
      prepaid: shipment.prepaid_amount ?? 0,
      returnFee: input.returnFee,
      fault: input.fault,
    });

    await earningsSplitService.splitPartialReturn(order, shipment, plan.agencyFeePaid);

    const charge = input.fault === 'vendor' ? plan.vendorChargedReturnFee + input.feesCharge : input.fault === 'agency' ? input.feesCharge : 0;
    if (charge > 0 && input.fault !== 'customer') {
      await earningsClawbackService.chargeForPartialReturn({
        refundKey: input.refundKey,
        ownerType: input.fault,
        ownerId: input.fault === 'vendor' ? order.vendor_id.toString() : shipment.agency_id.toString(),
        amount: charge,
        returnFee: input.fault === 'vendor' ? plan.vendorChargedReturnFee : 0,
        fees: input.feesCharge,
        shipmentId: input.shipmentId,
        orderNumber: input.orderNumber ?? order.order_number ?? null,
        currency: order.currency,
      });
    }

    await ShipmentModel.updateOne({ _id: shipment._id }, { $set: { 'prepaid_return.settled_at': new Date() } });
    await earningsCompletionService.syncOrderHold(input.orderId);
    await this.closeOrderIfNothingLeft(input.orderId);
  }

  /**
   * Every parcel came back, no cash was ever collected and each refund is done: the money question
   * is closed. `markSourceRefundedInSession` covers a refund of everything paid; this covers the one
   * where the customer's fault kept a return fee, which never reaches that total.
   */
  private async closeOrderIfNothingLeft(orderId: string): Promise<void> {
    const shipments = await ShipmentModel.find({ order_id: orderId }).select('status prepaid_amount prepaid_return').lean();
    const allBack = shipments.length > 0 && shipments.every((s) => s.status === 'returned' || s.status === 'rejected');
    const allSettled = shipments.every((s) => (s.prepaid_amount ?? 0) <= 0 || Boolean(s.prepaid_return?.settled_at));
    if (!allBack || !allSettled) return;
    const collected = await CashCollectionModel.countDocuments({ order_id: orderId, status: 'collected' });
    if (collected > 0) return;
    await OrderModel.updateOne({ _id: orderId, payment_status: 'partially_paid' }, { $set: { payment_status: 'refunded' } });
  }
}

export const partialReturnSettlementService = new PartialReturnSettlementService();
