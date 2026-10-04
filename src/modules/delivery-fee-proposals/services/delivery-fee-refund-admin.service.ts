import { FilterQuery, Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { transactionManager } from '../../../core/database/transaction.manager';
import { auditLogger } from '../../../core/audit/audit-logger';
import { ActorRef } from '../../../core/types/actor-source.types';
import { OrderModel } from '../../orders/order.model';
import { ticketService } from '../../tickets/services/ticket.service';
import { TicketModel } from '../../tickets/models/ticket.model';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { ActorRole, TicketStatus } from '../../tickets/types/ticket.types';
import { DeliveryFeeRefundModel, IDeliveryFeeRefund } from '../models/delivery-fee-refund.model';
import {
  ManualRefundSettlementMethod,
  ManualSettlementRefusal,
  planManualSettlement,
} from '../domain/customer-fee-change.rules';
import { AdminDeliveryFeeRefundDto, toAdminDeliveryFeeRefundDto } from '../dto/delivery-fee-proposal.dto';
import { ListManualDeliveryFeeRefundsQuery, SettleDeliveryFeeRefundDto } from '../validators/delivery-fee-proposal.validator';
import { DeliveryFeeRefundService, deliveryFeeRefundService } from './delivery-fee-refund.service';
import { customerFeeNotifier } from './customer-fee-notifier';

/** One status per code — the `test:errors` census refuses a code raised at two statuses. */
function refusalToError(refusal: ManualSettlementRefusal) {
  switch (refusal.code) {
    case 'not_settleable':
      return createAppError(ERROR_CODES.DELIVERY_FEE_REFUND_NOT_SETTLEABLE, 409, undefined, { status: refusal.status });
    case 'already_covered':
      return createAppError(ERROR_CODES.DELIVERY_FEE_REFUND_ALREADY_COVERED, 409, undefined, {
        amount: refusal.amount,
        stillReturnable: refusal.stillReturnable,
      });
    case 'not_covered':
      return createAppError(ERROR_CODES.DELIVERY_FEE_REFUND_NOT_COVERED, 409, undefined, {
        amount: refusal.amount,
        stillReturnable: refusal.stillReturnable,
      });
  }
}

/** The manual rows: still owed, or settled by an administrator. */
const MANUAL_FILTER: FilterQuery<IDeliveryFeeRefund> = {
  $or: [{ status: 'manual_required' }, { settlement: { $ne: null } }],
};

/**
 * Manual delivery-fee refunds, as an ADMINISTRATOR settles them (ADR-A11 W-E2, owner decision
 * D-12: COD money owed back stays manual — a ticket and a notice — and an administrator records
 * that it was paid).
 *
 * `DeliveryFeeRefundService` writes a `manual_required` row when the gateway cannot or will not
 * return delivery money (mobile money, refunds disabled, COD cash). Until W-E2 nothing could
 * close one: the customer kept reading the money as owed forever. Settling makes it `completed`
 * with a `settlement` (method, reference, note, who, when) — so the customer's owed amount
 * clears on both reads — resolves the linked HIGH ticket, and tells the customer.
 *
 * ── The rules (`planManualSettlement`, pure) ─────────────────────────────────
 *  - only `manual_required` settles; the write is a compare-and-set on that status AND the
 *    amount read, so two administrators settling at once yield one settlement and one 409;
 *  - online: a paying method is refused when a wider refund of the ORDER already returned the
 *    money (paying again pays it twice); `covered_by_order_refund` records that instead, and
 *    splits off any part still owed as its own `manual_required` row on the same ticket;
 *  - money paid by hand is subtracted from every later "what can this order still return"
 *    ceiling (`sumDeliveryRefundsPaidByHand`), so the order cannot be refunded past its charge.
 *
 * Authorization is wi-admin's (the service token is full-privilege; `X-Actor-Tier` is advisory and
 * never read here). This side stamps WHO from the caller headers (`actorFromRequest`) and writes
 * an `admin_action_log` row inside the settling transaction.
 */
export class DeliveryFeeRefundAdminService {
  constructor(
    private readonly refunds: DeliveryFeeRefundService = deliveryFeeRefundService,
    private readonly ticketNotes: TicketNoteService = new TicketNoteService()
  ) {}

  async list(query: ListManualDeliveryFeeRefundsQuery): Promise<{
    data: AdminDeliveryFeeRefundDto[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const filter: FilterQuery<IDeliveryFeeRefund> =
      query.status === 'manual_required'
        ? { status: 'manual_required' }
        : query.status === 'settled'
          ? { status: 'completed', settlement: { $ne: null } }
          : { ...MANUAL_FILTER };
    if (query.orderId) filter.order_id = new Types.ObjectId(query.orderId);
    const [rows, total] = await Promise.all([
      DeliveryFeeRefundModel.find(filter)
        .sort({ created_at: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      DeliveryFeeRefundModel.countDocuments(filter).exec(),
    ]);
    const numbers = await this.orderNumbers(rows.map((r) => r.order_id));
    return {
      data: rows.map((r) => toAdminDeliveryFeeRefundDto(r, numbers.get(r.order_id.toString()) ?? null)),
      meta: { total, page: query.page, limit: query.limit, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
    };
  }

  async getById(refundId: string): Promise<AdminDeliveryFeeRefundDto> {
    const row = await DeliveryFeeRefundModel.findById(refundId).exec();
    if (!row || !(row.status === 'manual_required' || row.settlement)) {
      // Automatic rows are not this surface's: wi-admin reads the ledger directly.
      throw createAppError(ERROR_CODES.DELIVERY_FEE_REFUND_NOT_FOUND, 404);
    }
    const numbers = await this.orderNumbers([row.order_id]);
    return toAdminDeliveryFeeRefundDto(row, numbers.get(row.order_id.toString()) ?? null);
  }

  async settle(
    refundId: string,
    input: SettleDeliveryFeeRefundDto,
    actor: ActorRef
  ): Promise<{ refund: AdminDeliveryFeeRefundDto; remainder: AdminDeliveryFeeRefundDto | null }> {
    const row = await DeliveryFeeRefundModel.findById(refundId).exec();
    if (!row) throw createAppError(ERROR_CODES.DELIVERY_FEE_REFUND_NOT_FOUND, 404);
    if (row.status !== 'manual_required') throw refusalToError({ code: 'not_settleable', status: row.status });
    const order = await OrderModel.findById(row.order_id).select('_id order_number currency customer_id total_amount payment_method').exec();
    if (!order) throw createAppError(ERROR_CODES.ORDER_NOT_FOUND, 404);

    const method = input.method as ManualRefundSettlementMethod;
    // COD: there was no charge, so nothing else can have returned it — no ceiling.
    const stillReturnable = order.payment_method === 'cash_on_delivery' ? null : await this.refunds.refundableCapacity(order);
    const verdict = planManualSettlement({ status: row.status, amount: row.amount, method, stillReturnable });
    if (!verdict.ok) throw refusalToError(verdict.refusal);
    const { plan } = verdict;

    const now = new Date();
    const settlement = {
      method,
      reference: input.reference ?? null,
      note: input.note ?? null,
      settled_by_user_id: actor.userId,
      settled_by_source: actor.source,
      settled_by_name: actor.name ?? null,
      settled_at: now,
    };

    // ⚠ `runInTransaction`, NOT the retrying variant: the admin audit row is written inside, and
    // `recordAdminAction` must never run inside a callback that may be re-run.
    const result = await transactionManager.runInTransaction(async (session) => {
      const settled = await DeliveryFeeRefundModel.findOneAndUpdate(
        { _id: row._id, status: 'manual_required', amount: row.amount },
        { $set: { status: 'completed', amount: plan.settledAmount, settled_at: now, settlement } },
        { new: true, session }
      );
      if (!settled) {
        const fresh = await DeliveryFeeRefundModel.findById(row._id, null, { session });
        throw refusalToError({ code: 'not_settleable', status: fresh?.status ?? row.status });
      }
      let remainder: IDeliveryFeeRefund | null = null;
      if (plan.remainderOwed > 0) {
        [remainder] = await DeliveryFeeRefundModel.create(
          [
            {
              order_id: row.order_id,
              shipment_id: row.shipment_id,
              customer_id: row.customer_id,
              vendor_id: row.vendor_id,
              amount: plan.remainderOwed,
              currency: row.currency,
              status: 'manual_required',
              cause: row.cause,
              note: `Remainder of ${row._id.toString()} after part of it was covered by a refund of the whole order`,
              ticket_id: row.ticket_id,
              settled_at: null,
              settlement: null,
            },
          ],
          { session }
        );
      }
      await auditLogger.log(
        {
          actor: { userId: actor.userId, role: 'admin', metadata: { name: actor.name ?? null } },
          action: 'DELIVERY_FEE_REFUND_SETTLED',
          resource: { type: 'DeliveryFeeRefund', id: row._id.toString() },
          changes: {
            status: { from: 'manual_required', to: 'completed' },
            amount: { from: row.amount, to: plan.settledAmount },
          },
          metadata: {
            orderId: row.order_id.toString(),
            method,
            reference: settlement.reference,
            paidByHand: plan.paidByHand,
            remainderRefundId: remainder ? remainder._id.toString() : null,
            remainderOwed: plan.remainderOwed,
          },
          timestamp: now,
        },
        session
      );
      return { settled, remainder };
    });

    // ── After the commit: the ticket and the customer. Best-effort — the money record is the
    //    truth and is already committed; a ticketing or messaging failure must not undo it.
    await this.closeTicketBestEffort(result.settled, actor, plan.remainderOwed, order.currency);
    if (plan.paidByHand) {
      customerFeeNotifier.refundSettled(order, result.settled.amount, result.settled._id.toString());
    }

    const number = order.order_number ?? null;
    return {
      refund: toAdminDeliveryFeeRefundDto(result.settled, number),
      remainder: result.remainder ? toAdminDeliveryFeeRefundDto(result.remainder, number) : null,
    };
  }

  /**
   * Resolve the HIGH ticket the manual row opened — or, when part of the money is still owed
   * (a partial cover), only note on it: the ticket stays open for the remainder.
   */
  private async closeTicketBestEffort(
    settled: IDeliveryFeeRefund,
    actor: ActorRef,
    remainderOwed: number,
    currency: string
  ): Promise<void> {
    if (!settled.ticket_id) return;
    const ticketId = settled.ticket_id.toString();
    const s = settled.settlement;
    const how = s?.method === 'covered_by_order_refund'
      ? 'recorded as already returned by a refund of the whole order'
      : `paid by hand (${s?.method}${s?.reference ? `, ref: ${s.reference}` : ''})`;
    const text =
      `Delivery-fee refund ${settled._id.toString()} of ${currency} ${settled.amount.toLocaleString()} ${how}` +
      ` by ${actor.name ?? actor.userId}.` +
      (s?.note ? ` Note: ${s.note}` : '') +
      (remainderOwed > 0 ? ` ${currency} ${remainderOwed.toLocaleString()} is still owed and stays on this ticket.` : '');
    try {
      await this.ticketNotes.createSystemNote(ticketId, text);
    } catch (error) {
      console.error(`[DeliveryFeeRefundAdminService] Failed to note on ticket ${ticketId}:`, error);
    }
    if (remainderOwed > 0) return;
    try {
      // The ticket service allows any transition, so a ticket an operator already CLOSED by hand
      // would be moved back to `resolved` — leave a finished ticket where it is (the note records it).
      const current = await TicketModel.findById(ticketId).select('status').lean().exec();
      if (!current || current.status === TicketStatus.RESOLVED || current.status === TicketStatus.CLOSED) return;
      await ticketService.updateStatus(ticketId, TicketStatus.RESOLVED, actor.userId, ActorRole.ADMIN);
    } catch (error) {
      // Already resolved or closed by hand, most likely — the note above still records it.
      console.error(`[DeliveryFeeRefundAdminService] Failed to resolve ticket ${ticketId}:`, error);
    }
  }

  private async orderNumbers(orderIds: Types.ObjectId[]): Promise<Map<string, string>> {
    const unique = [...new Set(orderIds.map((id) => id.toString()))].map((id) => new Types.ObjectId(id));
    if (unique.length === 0) return new Map();
    const orders = await OrderModel.find({ _id: { $in: unique } }).select('order_number').lean().exec();
    return new Map(orders.map((o: any) => [o._id.toString(), o.order_number]));
  }
}

export const deliveryFeeRefundAdminService = new DeliveryFeeRefundAdminService();
