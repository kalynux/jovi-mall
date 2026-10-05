import { ticketService } from '../../tickets/services/ticket.service';
import {
  EntityType,
  TicketImportance,
  TicketPriority,
  TicketType,
} from '../../tickets/types/ticket.types';
import { EarningsPauseReason } from '../domain/earnings-hold';
import { earningsPauseService, PauseTarget, SYSTEM_PAUSE_ACTOR } from './earnings-pause.service';

export interface RefundOwedInput {
  target: PauseTarget;
  reason: Extract<EarningsPauseReason, 'seller_cancelled_paid_order' | 'booking_cancelled_unrefunded'>;
  /** Human reference for the ticket subject — the order or booking number. */
  reference: string;
  amount: number;
  currency: string;
  paymentMethod: string | null;
  /** Who cancelled, in words, for the ticket. */
  cancelledBy: string;
}

/**
 * A paid order or booking was cancelled by a path that refunds nothing. Two things happen,
 * and both must, so they live in one place (owner, 2026-10-05):
 *
 *  1. the money is PAUSED, so the seller cannot be paid out for a sale that was cancelled
 *     while the customer waits for their refund;
 *  2. a HIGH-priority refund ticket is opened, so a person refunds the customer and then
 *     either reverses the earnings (refund) or resumes them (the cancellation was a mistake);
 *  3. (D-4, 2026-10-05) a refund request AWAITING APPROVAL is opened, linked to that ticket, so
 *     the person deciding approves a prepared amount rather than re-typing it.
 *
 * Deliberately not an automatic refund: the owner asked for a ticket. The automatic paths
 * (the customer's own cancel, the seller's booking "cancel" action) are unchanged.
 *
 * Best-effort and never throws — the cancellation the caller just made stands either way,
 * and a failure here is logged loudly rather than undoing it.
 */
export async function raiseRefundOwed(input: RefundOwedInput): Promise<void> {
  try {
    await earningsPauseService.pause(
      input.target,
      input.reason,
      SYSTEM_PAUSE_ACTOR,
      `Cancelled after payment by ${input.cancelledBy}; refund owed`
    );
  } catch (error) {
    console.error(`[RefundOwed] FAILED to pause earnings for ${input.target.kind} ${input.target.id}:`, error);
  }

  const isOrder = input.target.kind === 'order';
  let ticketId: string | null = null;
  try {
    const ticket = await ticketService.createSystemTicket({
      type: isOrder ? TicketType.ORDER_REFUND : TicketType.BOOKING_CANCELLATION,
      entityType: isOrder ? EntityType.ORDER : EntityType.BOOKING,
      entityId: input.target.id,
      subject: `Refund owed: ${isOrder ? 'order' : 'booking'} ${input.reference} cancelled after payment`,
      description:
        `${isOrder ? 'Order' : 'Booking'} ${input.reference} was cancelled by ${input.cancelledBy} ` +
        `after the customer had paid, and no refund was issued.\n` +
        `Amount paid: ${input.amount} ${input.currency}\n` +
        `Payment method: ${input.paymentMethod ?? 'unknown'}\n\n` +
        `The seller's earnings for it are PAUSED and will not be paid out.\n` +
        `A refund request for the full amount is waiting for approval in the refund queue — ` +
        `approve it (or settle it externally) to refund the customer, which recovers the ` +
        `earnings; if the cancellation was a mistake, reject the request and resume the earnings ` +
        `so their hold continues.`,
      importance: TicketImportance.HIGH,
      priority: TicketPriority.HIGH,
    });
    ticketId = (ticket as { _id?: { toString(): string } } | null)?._id?.toString() ?? null;
  } catch (error) {
    console.error(`[RefundOwed] FAILED to open the refund ticket for ${input.target.kind} ${input.target.id}:`, error);
  }

  // 3. D-4 (REFUND-FLOW-PLAN § 2, 2026-10-05): a refund request AWAITING APPROVAL, linked to the
  //    ticket, so the person deciding does not re-type the amount. A person still decides —
  //    `approveNow: false`. Its own pause (`refund_in_progress`) is a no-op over the one above.
  //    Loaded on first use: `payments` reaches back into `earnings`, and this module is on the
  //    cancellation paths of both orders and bookings.
  try {
    const { refundRequestService } = await import('../../payments/services/refund-request.service');
    await refundRequestService.create({
      source: { kind: input.target.kind, id: input.target.id },
      reasonKind: 'cancellation',
      reason: `Cancelled after payment by ${input.cancelledBy}`,
      requestedBy: { id: null, role: 'system', name: `cancelled by ${input.cancelledBy}` },
      approveNow: false,
      ticketId,
    });
  } catch (error) {
    // Already open (somebody raised one), nothing refundable, or no payment on record: the
    // ticket above still carries the case. Logged, never thrown.
    console.error(`[RefundOwed] could not open the refund request for ${input.target.kind} ${input.target.id}:`, error);
  }
}
