import { Types } from 'mongoose';
import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus, DomainEvent } from '../../../core/events/event-bus';
import { IOrder, OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { RefundTransactionModel } from '../../payments/models/refund-transaction.model';
import type { IRefundRequest } from '../../payments/models/refund-request.model';
import type { RefundRequestService } from '../../payments/services/refund-request.service';
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
  /**
   * A refund REQUEST holds the money (REFUND-FLOW-PLAN § 4): a transfer to the number that paid
   * is in flight, or the request waits in the refund queue (`awaiting_approval` — COD / no
   * paying number; `failed` — the gateway refused, an administrator retries or settles it).
   */
  | { status: 'requested'; amount: number; refundRequestId: string; requestStatus: string }
  | { status: 'manual_required'; amount: number }
  | { status: 'failed'; amount: number };

/**
 * The statuses a row linked to a refund request may hold while that request is open: `processing`
 * (raised by this service) or `manual_required` (an old manual row moved onto a request by
 * `migrate:legacy-refunds-to-requests`). Both CLAIM the money.
 */
const LINKED_STATUSES: IDeliveryFeeRefund['status'][] = ['processing', 'manual_required'];

/** A legacy `processing` row (no refund request) older than this lost its process: outcome unknown. */
const STALE_PROCESSING_MS = 30 * 60 * 1000;

/**
 * Returns delivery-fee money the platform holds for a customer (ADR-A11 § Fee changes after
 * checkout): the excess after a fee DECREASE on a customer-paid shipment, and the unspent RTO
 * leftover of a customer-paid return (`shipment.customer_fee_refundable`, written by the splits
 * and by `CustomerFeeApplicationService`).
 *
 * ── How much ─────────────────────────────────────────────────────────────────
 * Per ORDER: Σ `customer_fee_refundable` − Σ claiming `delivery_fee_refunds` rows
 * (`outstandingCustomerRefund`), then capped at what the order's payments can still return
 * (`total_amount` − Σ completed `refund_transactions` − Σ paid by hand). The cap is what keeps a
 * FULL refund of the order — which already returned the delivery money — from paying it twice.
 *
 * ── How (REFUND-FLOW-PLAN § 4, rewired 2026-10-05) ────────────────────────────
 * A SYSTEM refund REQUEST (`RefundRequestService.create`), `prefer: 'topup_first'`, asked to be
 * approved and sent at once, with `earningsImpact: 'none'` — this money was never allocated to
 * anybody (§ 6.2 "nothing"), so no earnings are paused and nothing is clawed back:
 *  - card          → Stripe refunds it in the call → `completed`;
 *  - mobile money  → a payout to the number that paid (`sending`), the 2% fee taken (R-3) — it
 *                    used to be `manual_required`, because no mobile gateway has a refund API;
 *  - COD, or no paying number → the request waits `awaiting_approval` in the refund queue for a
 *    typed number + proof + a second administrator (R-7). The customer is told a person is on it.
 * The ledger row stays `processing` while its request is open — it CLAIMS the money, and the
 * one-processing-per-order index keeps a second delivery refund from starting meanwhile — and
 * follows the request: `completed` → `completed` (the `payment.refunded` subscriber below, with
 * the daily sweep as the backstop), `rejected` → `manual_required` (a person decided; nothing
 * retries it on its own, and the legacy settle screen can still record a cover).
 *
 * `manual_required` + a HIGH ticket remains only where NO request can be opened at all (the
 * order's payments cannot express it) — the old path, kept as the floor.
 *
 * ── Never twice ──────────────────────────────────────────────────────────────
 * The claim is a `processing` row, unique per order (partial index), written BEFORE the request:
 * two triggers racing (a decrease and a return split) cannot both refund. The refund request's own
 * `refund_one_open_per_source` index is the second guard.
 */
export class DeliveryFeeRefundService {
  private refunds?: RefundRequestService;

  /** Built on first use — the payments import graph reaches back into orders and bookings. */
  private async getRefunds(): Promise<RefundRequestService> {
    if (!this.refunds) {
      const { refundRequestService } = await import('../../payments/services/refund-request.service');
      this.refunds = refundRequestService;
    }
    return this.refunds;
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

      let request: IRefundRequest;
      try {
        const refunds = await this.getRefunds();
        request = await refunds.create({
          source: { kind: 'order', id: orderId },
          amount,
          reasonKind: ctx.cause === 'rto_leftover' ? 'return' : 'goodwill',
          reason: 'Delivery fee difference returned to the customer',
          // A SYSTEM refund: automatic to the number that paid (R-2); never COD (it waits).
          requestedBy: { id: null, role: 'system', name: 'delivery-fee refund' },
          approveNow: true,
          prefer: 'topup_first',
          // Delivery money nobody was allocated: no pause, no clawback (§ 6.2).
          earningsImpact: 'none',
        });
      } catch (error) {
        const code = error instanceof AppError ? error.code : undefined;
        if (code === ERROR_CODES.REFUND_ALREADY_OPEN) {
          // Another refund of this order is in progress (a vendor's, an administrator's): it may
          // well return this money. Claim nothing; the daily sweep re-measures afterwards.
          return this.toFailed(claim, code);
        }
        if (
          code === ERROR_CODES.REFUND_PAYMENT_NOT_FOUND ||
          code === ERROR_CODES.REFUND_ORDER_NOT_PAID ||
          code === ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX ||
          code === ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED
        ) {
          return this.toManual(order, claim, `A refund request could not be opened (${code})`);
        }
        console.error('[DeliveryFeeRefundService] Could not open the refund request:', error);
        return this.toFailed(claim, code ?? 'unexpected');
      }

      claim.refund_request_id = request._id as Types.ObjectId;
      await claim.save();
      const outcome = await this.followRequest(claim, request);
      if (outcome.status === 'requested' && request.status === 'awaiting_approval') {
        // A person has to provide the number (COD, or none on record) — tell the customer.
        customerFeeNotifier.refundPending(order, claim.amount, claim._id.toString());
      }
      return outcome;
    } catch (error) {
      console.error(`[DeliveryFeeRefundService] refundOutstanding(${orderId}) failed:`, error);
      return { status: 'failed', amount: 0 };
    }
  }

  /**
   * The durability backstop (the bus that triggers `refundOutstanding` is lossy). Called by the
   * earnings release sweep:
   *  1. rows linked to a refund request follow it (completed / rejected) — the lost-event backstop
   *     for `payment.refunded`;
   *  2. LEGACY `processing` rows (no request — written before 2026-10-05) older than 30 minutes
   *     are closed as manual: their outcome is unknown, never retried blind;
   *  3. every order still owed something is refunded.
   */
  async sweepOutstanding(limit = 200): Promise<{ staleClosed: number; attempted: number; followed: number }> {
    let followed = 0;
    // `manual_required` too: a row moved to a refund request by `migrate:legacy-refunds-to-requests` keeps
    // that status while its request is open. (A rejected request unlinks its rows, so nothing here
    // is a permanent no-op.) Newest first, so an old backlog cannot starve a fresh row.
    const linked = await DeliveryFeeRefundModel.find({ status: { $in: LINKED_STATUSES }, refund_request_id: { $ne: null } })
      .sort({ created_at: -1 })
      .limit(limit);
    if (linked.length > 0) {
      const refunds = await this.getRefunds();
      for (const row of linked) {
        try {
          const request = await refunds.getById(row.refund_request_id!.toString());
          if (!request) continue;
          const before = row.status;
          const outcome = await this.followRequest(row, request);
          if (outcome.status !== 'requested' && before === 'processing') followed++;
        } catch (error) {
          console.error(`[DeliveryFeeRefundService] could not follow refund request for row ${row._id}:`, error);
        }
      }
    }

    let staleClosed = 0;
    const stale = await DeliveryFeeRefundModel.find({
      status: 'processing',
      refund_request_id: null,
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
    return { staleClosed, attempted, followed };
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

  /**
   * `payment.refunded` (published by `RefundRequestService.complete`) — a delivery refund whose
   * transfer settled after the call returned: close its ledger row. Looked up by
   * `{ order_id, refund_request_id }` so the order index serves it. Fire-and-forget; the sweep
   * is the backstop.
   */
  async onPaymentRefunded(event: DomainEvent): Promise<void> {
    const p = event.payload ?? {};
    if (!p.refundRequestId || !p.orderId || !Types.ObjectId.isValid(String(p.refundRequestId))) return;
    if (!Types.ObjectId.isValid(String(p.orderId))) return;
    // Several rows, possibly: a migrated order's manual rows share ONE request.
    const rows = await DeliveryFeeRefundModel.find({
      order_id: new Types.ObjectId(String(p.orderId)),
      refund_request_id: new Types.ObjectId(String(p.refundRequestId)),
      status: { $in: LINKED_STATUSES },
    });
    if (rows.length === 0) return;
    const request = await (await this.getRefunds()).getById(String(p.refundRequestId));
    if (!request) return;
    for (const row of rows) await this.followRequest(row, request);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * What the order's payments can still give back: `total_amount` − Σ completed refunds
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

  /**
   * Bring a ledger row in line with the refund request that returns its money. Idempotent: every
   * write is a compare-and-set on the row's status, so the subscriber and the sweep cannot both act.
   *   completed → `completed` with the request's ledger rows (no `settlement`: the money left
   *               through the request, and `refund_transactions` already counts it in every ceiling);
   *   rejected  → `manual_required` (a person decided; nothing retries it automatically). The
   *               link MOVES to `rejected_refund_request_id` — history, and what stops the
   *               migration re-raising it — so the row is back on the legacy settle screen;
   *   otherwise → unchanged — the request is open.
   */
  private async followRequest(row: IDeliveryFeeRefund, request: IRefundRequest): Promise<RefundOutcome> {
    if (request.status === 'completed') {
      const done = await DeliveryFeeRefundModel.findOneAndUpdate(
        { _id: row._id, status: { $in: LINKED_STATUSES } },
        {
          $set: {
            status: 'completed',
            settled_at: request.completed_at ?? new Date(),
            refund_transaction_ids: request.refund_transaction_ids ?? [],
            note: null,
          },
        },
        { new: true }
      );
      if (done) Object.assign(row, { status: done.status, settled_at: done.settled_at });
      return { status: 'completed', amount: row.amount };
    }
    if (request.status === 'rejected') {
      const note =
        `Refund request ${request.id} was rejected by ${request.rejected_by?.name ?? 'an administrator'}`
        + `${request.rejection_reason ? `: ${request.rejection_reason}` : ''} — settle by hand, or record it as covered`;
      await DeliveryFeeRefundModel.updateOne(
        { _id: row._id, status: { $in: LINKED_STATUSES }, refund_request_id: request._id },
        {
          $set: {
            status: 'manual_required',
            note: note.slice(0, 1000),
            ticket_id: request.ticket_id ?? row.ticket_id ?? null,
            refund_request_id: null,
            rejected_refund_request_id: request._id,
          },
        }
      );
      row.status = 'manual_required';
      row.refund_request_id = null;
      return { status: 'manual_required', amount: row.amount };
    }
    return { status: 'requested', amount: row.amount, refundRequestId: request.id, requestStatus: request.status };
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
    row.note = `Could not be refunded for now (${code}) — retried by the daily sweep`;
    await row.save();
    return { status: 'failed', amount: row.amount };
  }

  /**
   * The floor: NO refund request could be opened, so a person pays it from a HIGH ticket and
   * records it on the settle screen (W-E2). Still CLAIMS the money, so nothing retries it.
   */
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
 * Register the two subscribers (called once from `lifecycle.ts`): `earnings.split` starts a
 * refund on a customer-paid return; `payment.refunded` closes a ledger row whose refund request
 * completed after the call returned (a payout callback). The bus is lossy — the earnings release
 * sweep runs `sweepOutstanding` as the backstop for both.
 */
export function registerDeliveryFeeRefundConsumer(): void {
  eventBus.subscribe('earnings.split', deliveryFeeRefundService.onEarningsSplit.bind(deliveryFeeRefundService));
  eventBus.subscribe(
    'payment.refunded',
    deliveryFeeRefundService.onPaymentRefunded.bind(deliveryFeeRefundService),
    'delivery-fee-refund.request-completed'
  );
}
