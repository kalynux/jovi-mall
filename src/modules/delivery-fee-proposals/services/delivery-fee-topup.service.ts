import { Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { IPaymentTransaction, PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { customerExcessOf, planCustomerApprovedIncrease, windowFor } from '../domain/customer-fee-change.rules';
import { DeliveryFeeProposalModel } from '../models/delivery-fee-proposal.model';
import { CustomerFeeApplicationService, customerFeeApplicationService } from './customer-fee-application.service';
import { customerFeeNotifier } from './customer-fee-notifier';
import { deliveryFeeRefundService } from './delivery-fee-refund.service';

/**
 * Settles a paid delivery-fee TOP-UP (ADR-A11, `purpose: 'order_delivery_topup'`).
 *
 * Reached ONLY from `PaymentOrchestratorService.handlePaymentSuccess`, which branches on the
 * purpose BEFORE the order's already-paid early return (the order of a top-up is always paid —
 * routing it to `OrderService.handlePaymentSuccess` would swallow the money silently).
 *
 * Two outcomes, and the second is what makes a race harmless rather than a loss:
 *
 *  - **The proposal is still waiting for exactly this money** → the increase applies, in one
 *    transaction with the proposal's `approved` and the transaction's `appliedAt` marker: the
 *    fee moves to the proposed figure, `customer_delivery_fee` and the order total grow by the
 *    top-up, pickup unblocks. The vendor's share is untouched — the customer paid the whole delta.
 *  - **It is not** (the agency withdrew, the shipment was declined, a figure moved) → the money is
 *    the CUSTOMER's: it is credited to the shipment as paid (`customer_delivery_fee` grows, and so
 *    does the excess owed back), and the refund service returns it. Never dropped, never applied
 *    to a fee nobody agreed.
 *
 * Idempotent on the transaction: `deliveryTopup.appliedAt` is stamped by compare-and-set inside
 * the same transaction, so a re-delivered webhook changes nothing.
 */
export class DeliveryFeeTopupService {
  constructor(
    private readonly feeApp: CustomerFeeApplicationService = customerFeeApplicationService,
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository()
  ) {}

  async onTopupSucceeded(tx: IPaymentTransaction): Promise<void> {
    const link = tx.deliveryTopup;
    if (!link || link.appliedAt) return;
    const order = tx.orderId ? await OrderModel.findById(tx.orderId) : null;
    if (!order) {
      console.error(`[DeliveryFeeTopupService] Top-up ${tx._id} has no order — left for an operator`);
      return;
    }
    const amount = tx.amountSnapshot;
    const proposal = await DeliveryFeeProposalModel.findById(link.proposalId);
    const shipment = await ShipmentModel.findById(link.shipmentId);

    const expected =
      !!proposal &&
      !!shipment &&
      proposal.status === 'pending' &&
      !!proposal.customer_approval &&
      proposal.topup?.status === 'awaiting_payment' &&
      proposal.topup.amount === amount &&
      !!shipment.pending_delivery_fee_proposal_id &&
      shipment.pending_delivery_fee_proposal_id.equals(proposal._id as Types.ObjectId) &&
      windowFor(proposal.origin).includes(shipment.status);

    if (expected && proposal && shipment) {
      const state = await this.feeApp.stateOf(shipment, order);
      const plan = planCustomerApprovedIncrease(state, proposal.proposed_fee);
      if (plan.topupDue === amount) {
        try {
          const now = new Date();
          const approved = await transactionManager.runInTransactionWithRetry(async (session) => {
            const marked = await PaymentTransactionModel.updateOne(
              { _id: tx._id, 'deliveryTopup.appliedAt': null },
              { $set: { 'deliveryTopup.appliedAt': now } },
              { session }
            );
            if (marked.modifiedCount !== 1) return null; // already applied
            const application = await this.feeApp.applyInSession(
              {
                order,
                shipmentId: shipment._id as Types.ObjectId,
                proposalId: proposal._id as Types.ObjectId,
                expectedPointer: proposal._id as Types.ObjectId,
                window: windowFor(proposal.origin),
                plan,
                at: now,
              },
              session
            );
            return DeliveryFeeProposalModel.findOneAndUpdate(
              { _id: proposal._id, status: 'pending' },
              {
                $set: {
                  status: 'approved',
                  responded_by_role: 'customer',
                  responded_by_user_id: proposal.customer_approval?.user_id ?? null,
                  responded_at: now,
                  'topup.status': 'paid',
                  'topup.transaction_id': tx._id,
                  'topup.paid_at': now,
                  application: {
                    fee_at_apply: plan.feeBefore,
                    vendor_allocation_before: application.vendorAllocationBefore,
                    vendor_allocation_after: application.vendorAllocationAfter,
                    snapshot_rewritten: true,
                    customer_fee_before: plan.customerFeeBefore,
                    customer_fee_after: plan.customerFeeAfter,
                    customer_topup_amount: amount,
                    customer_refund_due: plan.refundableAfter > 0 ? plan.refundableAfter : null,
                    cod_collection_adjusted: false,
                    vendor_borne_delta: plan.vendorBorneAfter - plan.vendorBorneBefore,
                  },
                },
                $push: {
                  status_history: {
                    status: 'approved',
                    changed_at: now,
                    changed_by_role: 'customer',
                    changed_by_user_id: proposal.customer_approval?.user_id ?? null,
                    note: 'topup_paid',
                  },
                },
              },
              { new: true, session }
            );
          });
          if (approved) {
            const { deliveryFeeProposalService } = await import('./delivery-fee-proposal.service');
            deliveryFeeProposalService.emitAnswered('delivery_fee_proposal.approved', approved, {
              orderNumber: order.order_number ?? null,
              respondedByRole: 'customer',
              topupPaid: amount,
            });
            customerFeeNotifier.updated(order, {
              proposalId: (approved._id as Types.ObjectId).toString(),
              feeAfter: approved.proposed_fee,
              how: 'topup_paid',
              amount,
            });
          }
          return;
        } catch (error) {
          console.error(`[DeliveryFeeTopupService] Applying top-up ${tx._id} failed — crediting it to the customer:`, error);
        }
      }
    }

    await this.creditToCustomer(tx, amount);
  }

  async onTopupFailed(tx: IPaymentTransaction): Promise<void> {
    const order = tx.orderId ? await OrderModel.findById(tx.orderId) : null;
    if (!order) return;
    customerFeeNotifier.topupFailed(order, { transactionId: tx._id.toString(), amount: tx.amountSnapshot });
  }

  /**
   * The money arrived for a change that no longer stands: it is the customer's. Recorded as
   * delivery money PAID on the shipment (or, if that row is gone — a later change-agency move —
   * on another shipment of the order), which makes it owed back by construction, then refunded.
   */
  private async creditToCustomer(tx: IPaymentTransaction, amount: number): Promise<void> {
    const orderId = tx.orderId!;
    const now = new Date();
    try {
      await transactionManager.runInTransactionWithRetry(async (session) => {
        const marked = await PaymentTransactionModel.updateOne(
          { _id: tx._id, 'deliveryTopup.appliedAt': null },
          { $set: { 'deliveryTopup.appliedAt': now } },
          { session }
        );
        if (marked.modifiedCount !== 1) return;
        const order = await OrderModel.findById(orderId, null, { session });
        if (!order) return;
        let shipment = await ShipmentModel.findById(tx.deliveryTopup!.shipmentId, null, { session });
        if (!shipment) shipment = await ShipmentModel.findOne({ order_id: orderId }, null, { session });
        if (!shipment) {
          console.error(`[DeliveryFeeTopupService] Top-up ${tx._id}: order ${orderId} has no shipment to credit — operator action needed`);
          return;
        }
        const policies = (await this.agencies.findById(shipment.agency_id.toString()))?.policies ?? null;
        const fee = this.feeApp.effectiveFee(shipment, order, policies);
        const paidAfter = Math.max(0, shipment.customer_delivery_fee ?? 0) + amount;
        await ShipmentModel.updateOne(
          { _id: shipment._id },
          { $set: { customer_delivery_fee: paidAfter, customer_fee_refundable: customerExcessOf(fee, paidAfter) } },
          { session }
        );
        await OrderModel.updateOne(
          { _id: orderId },
          { $inc: { 'price_breakdown.delivery': amount, 'price_breakdown.total': amount, total_amount: amount }, $set: { updated_at: now } },
          { session }
        );
      });
    } catch (error) {
      console.error(`[DeliveryFeeTopupService] Crediting top-up ${tx._id} failed:`, error);
      return;
    }
    void deliveryFeeRefundService.refundOutstanding(orderId.toString(), {
      cause: 'fee_decrease',
      shipmentId: tx.deliveryTopup?.shipmentId?.toString() ?? null,
    });
  }
}

export const deliveryFeeTopupService = new DeliveryFeeTopupService();
