import { ClientSession, Types } from 'mongoose';
import { CashCollectionModel } from '../../cod/models/cash-collection.model';
import { expectedCodAmount } from '../../cod/domain/cod-limits';
import { ShipmentModel } from '../../shipments/shipment.model';
import { IOrder, OrderModel } from '../order.model';
import { customerDeliveryFeeOf } from '../domain/delivery-payer';
import { allocatePrepaymentAcrossParcels, ParcelValue } from '../domain/partial-payment';

/** Parcels whose prepaid part no longer moves: the cash changed hands, or the parcel came back. */
const SETTLED_PARCEL_STATUSES = ['delivered', 'returned', 'rejected'];

/**
 * The writes of a partial order's online part (owner, 2026-11-01). The rules are pure, in
 * `orders/domain/partial-payment.ts`.
 *
 * Every method runs inside the caller's transaction: the order's status, what each parcel prepaid
 * and what its agent collects must never disagree.
 */
export class PartialPaymentService {
  /**
   * Record that the online part was paid: stamp the order and share the amount across its parcels.
   *
   * The filter on `prepayment.paid_at` is the idempotency: payment webhooks are re-delivered, and a
   * replay must not move anything or run the caller's stock and dispatch steps again. Returns the
   * updated order, or `null` when it had already been paid.
   */
  async applyPaidInSession(
    orderId: string,
    amount: number,
    transactionId: Types.ObjectId | string,
    session: ClientSession,
  ): Promise<IOrder | null> {
    const order = await OrderModel.findOneAndUpdate(
      { _id: orderId, prepayment: { $ne: null }, 'prepayment.paid_at': null },
      {
        $set: {
          'prepayment.amount': amount,
          'prepayment.paid_at': new Date(),
          'prepayment.transaction_id': new Types.ObjectId(transactionId.toString()),
          payment_status: 'partially_paid',
        },
      },
      { new: true, session },
    );
    if (!order) return null;
    await this.shareAcrossParcelsInSession(order, session);
    return order;
  }

  /**
   * Share the paid amount again after a parcel's value changed (items moved agency, a delivery fee
   * changed). Parcels already settled keep what they have, and a pending collection follows its
   * parcel. A no-op on any order whose online part is unpaid: nothing has been shared yet.
   */
  async reshareInSession(orderId: string, session: ClientSession): Promise<void> {
    const order = await OrderModel.findById(orderId, null, { session });
    if (!order?.prepayment?.paid_at) return;
    await this.shareAcrossParcelsInSession(order, session);
  }

  private async shareAcrossParcelsInSession(order: IOrder, session: ClientSession): Promise<void> {
    const amount = order.prepayment?.amount ?? 0;
    const shipments = await ShipmentModel.find({ order_id: order._id }, null, { session });
    const collections = await CashCollectionModel.find({ order_id: order._id }, null, { session });
    const collected = new Set(collections.filter((c) => c.status === 'collected').map((c) => c.shipment_id.toString()));

    const settled = shipments.filter((s) => collected.has(s._id.toString()) || SETTLED_PARCEL_STATUSES.includes(s.status));
    const open = shipments.filter((s) => !settled.includes(s));
    const alreadyPlaced = settled.reduce((sum, s) => sum + (s.prepaid_amount ?? 0), 0);

    const valueOf = (s: (typeof shipments)[number]): number =>
      expectedCodAmount(order.items as any[], s.items as any[], customerDeliveryFeeOf(order, s));
    const parcels: ParcelValue[] = open.map((s) => ({ parcelId: s._id.toString(), value: valueOf(s) }));
    const { byParcel, surplus } = allocatePrepaymentAcrossParcels(amount - alreadyPlaced, parcels);

    for (const shipment of open) {
      const prepaid = byParcel.get(shipment._id.toString()) ?? 0;
      if ((shipment.prepaid_amount ?? 0) !== prepaid) {
        await ShipmentModel.updateOne({ _id: shipment._id }, { $set: { prepaid_amount: prepaid } }, { session });
      }
      const pending = collections.find((c) => c.shipment_id.toString() === shipment._id.toString() && c.status === 'pending');
      if (pending && (pending.prepaid_amount ?? 0) !== prepaid) {
        await CashCollectionModel.updateOne(
          { _id: pending._id, status: 'pending' },
          { $set: { prepaid_amount: prepaid, expected_amount: Math.max(0, valueOf(shipment) - prepaid) } },
          { session },
        );
      }
    }

    // Parcels lost value after the payment and the money no longer fits on them. It is the
    // customer's: recorded where the delivery-fee refund already looks for what is owed back.
    if (surplus > 0) {
      const home = open[0] ?? shipments[0];
      if (home) {
        await ShipmentModel.updateOne({ _id: home._id }, { $inc: { customer_fee_refundable: surplus } }, { session });
      }
    }
  }
}

export const partialPaymentService = new PartialPaymentService();
