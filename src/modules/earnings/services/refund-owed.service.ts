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
 *     either reverses the earnings (refund) or resumes them (the cancellation was a mistake).
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
  try {
    await ticketService.createSystemTicket({
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
        `To close this ticket: refund the customer (which reverses the earnings), or, if the ` +
        `cancellation was a mistake, resume the earnings so their hold continues.`,
      importance: TicketImportance.HIGH,
      priority: TicketPriority.HIGH,
    });
  } catch (error) {
    console.error(`[RefundOwed] FAILED to open the refund ticket for ${input.target.kind} ${input.target.id}:`, error);
  }
}
