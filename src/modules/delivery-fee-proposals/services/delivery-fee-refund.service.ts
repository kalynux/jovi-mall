import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { IOrder, OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { RefundTransactionModel } from '../../payments/models/refund-transaction.model';
import type { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { ticketService } from '../../tickets/services/ticket.service';
import { EntityType, TicketImportance, TicketType } from '../../tickets/types/ticket.types';
import {
  DeliveryFeeRefundCause,
  DeliveryFeeRefundModel,
  IDeliveryFeeRefund,
  sumDeliveryRefundsPaidByHand,
} from '../models/delivery-fee-refund.model';
import { customerRefundPosition, outstandingCustomerRefund } from '../domain/customer-fee-change.rules';
import { customerFeeNotifier } from './customer-fee-notifier';

export type RefundOutcome =
  | { status: 'none' }
  | { status: 'busy' }
  | { status: 'completed'; amount: number }
  | { status: 'manual_required'; amount: number }
  | { status: 'failed'; amount: number };

/** A `processing` row older than this lost its process: its outcome is unknown. */
const STALE_PROCESSING_MS = 30 * 60 * 1000;

/**
 * Returns delivery-fee money the platform holds for a customer (ADR-A11 § Fee changes after
 * checkout): the excess after a fee DECREASE on a prepaid customer-paid shipment, and the unspent
 * RTO leftover of a customer-paid return (`shipment.customer_fee_refundable`, written by the
 * splits and by `CustomerFeeApplicationService`).
 *
 * ── How much ─────────────────────────────────────────────────────────────────
 * Per ORDER: Σ `customer_fee_refundable` − Σ claiming `delivery_fee_refunds` rows
 * (`outstandingCustomerRefund`), then capped at what the order's payments can still return
 * (`total_amount` − Σ completed `refund_transactions`). The cap is what keeps a vendor's FULL
 * refund of the order — which already returned the delivery money — from being paid twice: once
 * it has run, nothing is left to return and the owed amount is recorded as covered.
 *
 * ── How ──────────────────────────────────────────────────────────────────────
 *  - online: `PaymentOrchestratorService.refundPayment`, `prefer: 'topup_first'`, as `system`.
 *    The customer is told by the existing `payment.refunded` → `order.refunded` situation.
 *  - the gateway WON'T (mobile money; NotchPay with refunds disabled) — `manual_required`: a HIGH
 *    ticket for a person to pay it, and the customer is told a person is on it. The row still
 *    claims the money, so nothing retries it on its own.
 *  - the gateway COULDN'T (5xx) — `failed`: claims nothing, retried by the daily sweep.
 *  - COD: there was no charge to refund (only reachable on a legacy collection) — manual.
 *
 * ── Never twice ──────────────────────────────────────────────────────────────
 * The claim is a `processing` row, unique per order (partial index), written BEFORE the gateway
 * is called: two triggers racing (a decrease and a return split) cannot both refund.
 */
export class DeliveryFeeRefundService {
  private orchestrator?: PaymentOrchestratorService;

  /** Built on first use — the orchestrator's import graph reaches back into orders and bookings. */
  private async getOrchestrator(): Promise<PaymentOrchestratorService> {
    if (!this.orchestrator) {
      const { PaymentOrchestratorService } = await import('../../payments/services/payment-orchestrator.service');
      this.orchestrator = new PaymentOrchestratorService();
    }
    return this.orchestrator;
  }

  /**
   * What the SYSTEM may still refund on this order (`owed`, before the payments cap), the
   * customer's view of it (`position` — a manual row is still owed to them until settled), and
   * the ledger.
   */
  async outstandingFor(
    orderId: string
  ): Promise<{ owed: number; position: ReturnType<typeof customerRefundPosition>; ledger: IDeliveryFeeRefund[] }> {
    const [shipments, ledger] = await Promise.all([
      ShipmentModel.find({ order_id: new Types.ObjectId(orderId) }).select('customer_fee_refundable').lean().exec(),
      DeliveryFeeRefundModel.find({ order_id: new Types.ObjectId(orderId) }).sort({ created_at: -1 }).exec(),
    ]);
    const facts = {
      refundables: shipments.map((s: any) => s.customer_fee_refundable),
      ledger: ledger.map((r) => ({ status: r.status, amount: r.amount })),
    };
    return { owed: outstandingCustomerRefund(facts), position: customerRefundPosition(facts), ledger };
  }

  /**
   * Refund whatever is owed on this order now. Never throws — every outcome is recorded on the
   * ledger, and a failure here must not fail the fee change or the split that triggered it.
   */
  async refundOutstanding(
    orderId: string,
    ctx: { cause: DeliveryFeeRefundCause; shipmentId?: string | null } = { cause: 'sweep' }
  ): Promise<RefundOutcome> {
    try {
      const order = await OrderModel.findById(orderId);
      if (!order) return { status: 'none' };
      const { owed } = await this.outstandingFor(orderId);
      if (owed <= 0) return { status: 'none' };

      // The cap: what the order's payments can still return.
      const capacity = order.payment_method === 'cash_on_delivery' ? owed : await this.refundableCapacity(order);
      if (capacity <= 0) {
        // Already returned through a broader refund of the order (a vendor or administrator
        // refunded it whole). Record it as covered so it is never paid again.
        await this.recordRow(order, owed, ctx, 'completed', 'Covered by an earlier refund of the whole order');
        return { status: 'completed', amount: owed };
      }
      const amount = Math.min(owed, capacity);

      const claim = await this.claim(order, amount, ctx);
      if (!claim) return { status: 'busy' };

      if (order.payment_method === 'cash_on_delivery') {
        return this.toManual(order, claim, 'The order was paid in cash at delivery — there is no charge to refund');
      }

      try {
        const orchestrator = await this.getOrchestrator();
        const result = await orchestrator.refundPayment({
          source: { kind: 'order', orderId },
          vendorId: order.vendor_id.toString(),
          // A system refund names the order it is for; there is no acting person.
          initiatedBy: orderId,
          initiatedByRole: 'system',
          amount,
          reason: 'Delivery fee difference returned to the customer',
          prefer: 'topup_first',
        });
        claim.status = 'completed';
        claim.settled_at = new Date();
        claim.refund_transaction_ids = result.refundIds.map((id) => new Types.ObjectId(id));
        await claim.save();
        return { status: 'completed', amount };
      } catch (error) {
        const code = error instanceof AppError ? error.code : undefined;
        const refundedSoFar = Number((error as AppError)?.details?.refundedSoFar ?? 0);
        if (refundedSoFar > 0) {
          // An earlier leg went through before a later one failed: split the claim so the ledger
          // says exactly what moved and what is still owed.
          claim.amount = refundedSoFar;
          claim.status = 'completed';
          claim.settled_at = new Date();
          await claim.save();
          const rest = await this.recordRow(order, amount - refundedSoFar, ctx, 'processing', null);
          if (!rest) return { status: 'completed', amount: refundedSoFar };
          return code === ERROR_CODES.REFUND_GATEWAY_FAILED
            ? this.toFailed(rest, code)
            : this.toManual(order, rest, `Gateway could not return the rest automatically (${code ?? 'unknown'})`);
        }
        if (code === ERROR_CODES.REFUND_GATEWAY_FAILED) return this.toFailed(claim, code);
        if (
          code === ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED ||
          code === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND ||
          code === ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX ||
          code === ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED
        ) {
          return this.toManual(order, claim, `Gateway could not return it automatically (${code})`);
        }
        console.error('[DeliveryFeeRefundService] Unexpected refund failure:', error);
        return this.toFailed(claim, code ?? 'unexpected');
      }
    } catch (error) {
      console.error(`[DeliveryFeeRefundService] refundOutstanding(${orderId}) failed:`, error);
      return { status: 'failed', amount: 0 };
    }
  }

  /**
   * The durability backstop (the bus that triggers `refundOutstanding` is lossy). Called by the
   * earnings release sweep: closes stale `processing` claims as manual (their outcome is
   * unknown — never retried blind), then refunds every order still owed something.
   */
  async sweepOutstanding(limit = 200): Promise<{ staleClosed: number; attempted: number }> {
    let staleClosed = 0;
    const stale = await DeliveryFeeRefundModel.find({
      status: 'processing',
      created_at: { $lt: new Date(Date.now() - STALE_PROCESSING_MS) },
    }).limit(limit);
    for (const row of stale) {
      const order = await OrderModel.findById(row.order_id);
      if (!order) continue;
      await this.toManual(order, row, 'The refund attempt was interrupted — check the gateway before paying by hand');
      staleClosed++;
    }

    const orderIds: Types.ObjectId[] = await ShipmentModel.distinct('order_id', { customer_fee_refundable: { $gt: 0 } });
    let attempted = 0;
    for (const id of orderIds.slice(0, limit)) {
      const outcome = await this.refundOutstanding(id.toString(), { cause: 'sweep' });
      if (outcome.status !== 'none') attempted++;
    }
    return { staleClosed, attempted };
  }

  /**
   * `earnings.split` for a SHIPMENT that recorded money owed to the customer (a customer-paid
   * return, W-C's `rtoLeftoverShares`) — refund it now. Fire-and-forget; the sweep is the backstop.
   */
  async onEarningsSplit(event: DomainEvent): Promise<void> {
    const p = event.payload ?? {};
    if (p.sourceType !== 'shipment' || !(Number(p.customerRefundable) > 0) || !p.sourceId) return;
    const shipment = await ShipmentModel.findById(p.sourceId).select('order_id').lean().exec();
    if (!shipment) return;
    await this.refundOutstanding((shipment as any).order_id.toString(), { cause: 'rto_leftover', shipmentId: String(p.sourceId) });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * What the order's payments can still give back: `total_amount` − Σ completed gateway refunds
   * − Σ delivery refunds an administrator already paid BY HAND (W-E2 — money that left without a
   * `refund_transactions` row). Public: the manual-settlement guard reads the same number.
   */
  async refundableCapacity(order: Pick<IOrder, '_id' | 'total_amount'>): Promise<number> {
    const orderId = order._id as Types.ObjectId;
    const [[tally], byHand] = await Promise.all([
      RefundTransactionModel.aggregate<{ total: number }>([
        { $match: { orderId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$refundAmount' } } },
      ]),
      sumDeliveryRefundsPaidByHand([orderId]),
    ]);
    return Math.max(0, order.total_amount - (tally?.total ?? 0) - (byHand.get(orderId.toString()) ?? 0));
  }

  /** Insert the `processing` claim; null when another refund on this order is in flight. */
  private async claim(order: IOrder, amount: number, ctx: { cause: DeliveryFeeRefundCause; shipmentId?: string | null }) {
    return this.recordRow(order, amount, ctx, 'processing', null);
  }

  private async recordRow(
    order: IOrder,
    amount: number,
    ctx: { cause: DeliveryFeeRefundCause; shipmentId?: string | null },
    status: IDeliveryFeeRefund['status'],
    note: string | null
  ): Promise<IDeliveryFeeRefund | null> {
    if (amount <= 0) return null;
    try {
      return await DeliveryFeeRefundModel.create({
        order_id: order._id,
        shipment_id: ctx.shipmentId && Types.ObjectId.isValid(ctx.shipmentId) ? new Types.ObjectId(ctx.shipmentId) : null,
        customer_id: order.customer_id,
        vendor_id: order.vendor_id,
        amount,
        currency: order.currency,
        status,
        cause: ctx.cause,
        note,
        settled_at: status === 'completed' ? new Date() : null,
      });
    } catch (error: any) {
      if (error?.code === 11000) return null; // another claim holds the order
      throw error;
    }
  }

  private async toFailed(row: IDeliveryFeeRefund, code: string): Promise<RefundOutcome> {
    row.status = 'failed';
    row.note = `Gateway refused for now (${code}) — retried by the daily sweep`;
    await row.save();
    return { status: 'failed', amount: row.amount };
  }

  private async toManual(order: IOrder, row: IDeliveryFeeRefund, cause: string): Promise<RefundOutcome> {
    row.status = 'manual_required';
    row.note = cause;
    try {
      const ticket = await ticketService.createSystemTicket({
        type: TicketType.ORDER_REFUND,
        entityType: EntityType.ORDER,
        entityId: order._id.toString(),
        subject: `Manual delivery-fee refund for order ${order.order_number}`,
        description:
          `Order ${order.order_number} owes its customer ${row.amount} ${order.currency} of delivery-fee money ` +
          `(${row.cause}: a lowered customer-paid fee or an unspent return fee).\n` +
          `Cause: ${cause}\n` +
          `Ledger row: delivery_fee_refunds ${row._id.toString()}\n\n` +
          `The customer has NOT been paid yet. No earnings need reversing: delivery money was never ` +
          `allocated to the vendor.`,
        importance: TicketImportance.HIGH,
      });
      if (ticket?._id) row.ticket_id = ticket._id as Types.ObjectId;
    } catch (error) {
      console.error('[DeliveryFeeRefundService] Failed to open the manual-refund ticket:', error);
    }
    await row.save();
    customerFeeNotifier.refundPending(order, row.amount, row._id.toString());
    return { status: 'manual_required', amount: row.amount };
  }
}

export const deliveryFeeRefundService = new DeliveryFeeRefundService();

/**
 * Register the `earnings.split` subscriber (called once from `lifecycle.ts`). The bus is lossy —
 * the earnings release sweep runs `sweepOutstanding` as the backstop.
 */
export function registerDeliveryFeeRefundConsumer(): void {
  eventBus.subscribe('earnings.split', deliveryFeeRefundService.onEarningsSplit.bind(deliveryFeeRefundService));
}
