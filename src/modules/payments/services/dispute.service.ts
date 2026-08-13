import { PaymentTransactionModel } from '../models/payment-transaction.model';
import { OrderModel, FulfillmentStatus } from '../../orders/order.model';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
import { TimelineActorType } from '../../orders/order-timeline.model';
import { Booking } from '../../booking/models/booking.model';
import { BookingStatus } from '../../booking/types/booking.types';
import { BookingCalendarSyncService } from '../../booking/services/booking-calendar-sync.service';
import { earningsRefundService } from '../../earnings/services/earnings-refund.service';
import { planPurchaseService } from '../../billing/services/plan-purchase.service';
import { creditTopupService } from '../../billing/services/credit-topup.service';
import { ticketService } from '../../tickets/services/ticket.service';
import { TicketType, EntityType, TicketImportance } from '../../tickets/types/ticket.types';
import { eventBus } from '../../../core/events/event-bus';
import { BillingOwnerType } from '../../billing/billing.types';

/**
 * Who resolved a dispute, for the order timeline.
 *
 * Defaulted to `SYSTEM_ACTOR` on every method below so the four webhook call sites are
 * untouched — a gateway event genuinely has no human behind it. The parameter exists for
 * the manual override, which previously recorded the one admin-driven write on an order as
 * `system`/null: an anonymous entry on the only record a payment dispute is arbitrated
 * from.
 */
export type DisputeActor = { type: TimelineActorType; id: string | null };
const SYSTEM_ACTOR: DisputeActor = { type: 'system', id: null };

/**
 * Whether a resolution actually changed anything.
 *
 * The `resolve*` methods return early when there is nothing to unwind, which is CORRECT
 * for a webhook (Stripe retries, and a replay must be harmless) and WRONG for an operator
 * — `adminResolveOrder` used to answer "resolved as won" for an order that was never
 * disputed. The service reports which happened; the CALLER decides what it means. The
 * webhook paths ignore it, the admin controller turns `noop` into a 409.
 */
export type DisputeResolution = 'resolved' | 'noop';

/** Map a billing owner type to the ticket EntityType for chargeback tickets. */
function ownerEntityType(ownerType: BillingOwnerType): EntityType {
  switch (ownerType) {
    case 'agency':
      return EntityType.AGENCY;
    case 'agent':
      return EntityType.AGENT;
    default:
      return EntityType.VENDOR;
  }
}

/**
 * PaymentDisputeService — coordinates Stripe dispute / refund webhooks.
 *
 * Routes by PaymentIntent id to whichever entity the charge funded (order →
 * plan purchase → credit top-up) and applies the correct effect:
 *
 * - `charge.dispute.created` → FREEZE the order (no warehouse shipping while the
 *   outcome is unknown). Plans/top-ups are only flagged (entitlements unchanged).
 * - `charge.dispute.closed` won  → resume the order (restore `paid`, lift hold).
 * - `charge.dispute.closed` lost / `charge.refunded` → UNWIND: order →
 *   refunded + returned/cancelled + escrow reversal; plan → reversed + downgrade
 *   to free; top-up → credits clawed back.
 *
 * Every dispute opens a support ticket for admin review. All effects are
 * idempotent and NEVER call Stripe's refund API on a lost dispute (the money is
 * already gone — we only unwind internal state).
 */
export class PaymentDisputeService {
  private readonly timelineRepo = new OrderTimelineRepository();
  private readonly calendarSync = new BookingCalendarSyncService();

  /** A dispute was opened — funds are held by Stripe, outcome unknown. */
  async onDisputeCreated(paymentIntentId: string, disputeId: string | null): Promise<void> {
    const orderId = await this.findOrderIdByPaymentIntent(paymentIntentId);
    if (orderId) {
      await this.freezeOrder(orderId, paymentIntentId, disputeId);
      return;
    }
    const bookingId = await this.findBookingIdByPaymentIntent(paymentIntentId);
    if (bookingId) {
      await this.freezeBooking(bookingId, paymentIntentId, disputeId);
      return;
    }
    // Plan/top-up: no entitlement change on open, but surface for review.
    await this.flagBillingForReview(paymentIntentId, disputeId, 'opened');
  }

  /** A dispute closed with a definitive outcome. */
  async onDisputeClosed(
    paymentIntentId: string,
    outcome: 'won' | 'lost',
    disputeId: string | null
  ): Promise<void> {
    if (outcome === 'won') {
      const orderId = await this.findOrderIdByPaymentIntent(paymentIntentId);
      if (orderId) {
        await this.resolveOrderWon(orderId, disputeId);
        return;
      }
      const bookingId = await this.findBookingIdByPaymentIntent(paymentIntentId);
      if (bookingId) await this.resolveBookingWon(bookingId, disputeId);
      // Plans/top-ups were never unwound on open, so nothing to restore.
      return;
    }
    await this.unwind(paymentIntentId, 'chargeback', disputeId);
  }

  /** A charge was refunded (outside our own refund flow) — treat like a loss. */
  async onRefunded(paymentIntentId: string): Promise<void> {
    await this.unwind(paymentIntentId, 'refund', null);
  }

  // ─── Unwind (lost / refunded) ───────────────────────────────────────────────

  private async unwind(
    paymentIntentId: string,
    reason: 'chargeback' | 'refund',
    disputeId: string | null
  ): Promise<void> {
    const orderId = await this.findOrderIdByPaymentIntent(paymentIntentId);
    if (orderId) {
      await this.resolveOrderLost(orderId, paymentIntentId, reason, disputeId);
      return;
    }

    const bookingId = await this.findBookingIdByPaymentIntent(paymentIntentId);
    if (bookingId) {
      await this.resolveBookingLost(bookingId, paymentIntentId, reason, disputeId);
      return;
    }

    const plan = await planPurchaseService.reverseByGatewayRef(paymentIntentId);
    if (plan) {
      await this.openTicket(
        TicketType.CHARGEBACK,
        ownerEntityType(plan.owner_type),
        plan.owner_id.toString(),
        `Plan purchase ${reason}: ${plan.plan_code}`,
        `${plan.owner_type} plan purchase (${plan.plan_code}, ${plan.price} ${plan.currency}) was ${reason}d ` +
          `(PaymentIntent ${paymentIntentId}). The ${plan.owner_type} was downgraded to the free tier. ` +
          `Re-assign the plan from admin billing if the dispute is resolved in their favour.`
      );
      return;
    }

    const topup = await creditTopupService.reverseByGatewayRef(paymentIntentId, reason);
    if (topup) {
      await this.openTicket(
        TicketType.CHARGEBACK,
        ownerEntityType(topup.owner_type),
        topup.owner_id.toString(),
        `Credit top-up ${reason}: ${topup.credits} credits`,
        `${topup.owner_type} credit top-up (${topup.credits} credits, ${topup.price} ${topup.currency}) was ` +
          `${reason}d (PaymentIntent ${paymentIntentId}). ${topup.credits} credits were clawed back.`
      );
      return;
    }

    console.warn(`[PaymentDispute] ${reason} for PI ${paymentIntentId} matched no order/plan/top-up`);
  }

  // ─── Orders ─────────────────────────────────────────────────────────────────

  private async freezeOrder(
    orderId: string,
    paymentIntentId: string,
    disputeId: string | null
  ): Promise<void> {
    const order = await OrderModel.findById(orderId);
    if (!order) return;
    if (order.dispute_hold?.active) return; // idempotent

    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          payment_status: 'disputed',
          'dispute_hold.active': true,
          'dispute_hold.disputed_at': new Date(),
          'dispute_hold.resolved_at': null,
          'dispute_hold.gateway_dispute_id': disputeId,
          'dispute_hold.reason': 'stripe_dispute',
          updated_at: new Date(),
        },
      }
    );

    await this.appendTimeline(orderId, 'Payment disputed — order frozen pending dispute resolution', {
      paymentIntentId,
      disputeId,
    });
    await this.publishDisputeEvent(orderId, 'order', 'frozen', { paymentIntentId, disputeId });

    await this.openTicket(
      TicketType.ORDER_DISPUTE,
      EntityType.ORDER,
      orderId,
      `Order payment disputed (#${order.order_number})`,
      `A Stripe dispute (${disputeId ?? 'n/a'}) was opened on order ${order.order_number} ` +
        `(PaymentIntent ${paymentIntentId}). The order is frozen — fulfilment is blocked until the ` +
        `dispute settles. On WIN it resumes; on LOSS it is refunded and returned/cancelled.`
    );
  }

  private async resolveOrderWon(
    orderId: string,
    disputeId: string | null,
    actor: DisputeActor = SYSTEM_ACTOR
  ): Promise<DisputeResolution> {
    const order = await OrderModel.findById(orderId);
    if (!order) return 'noop';
    if (!order.dispute_hold?.active && order.payment_status !== 'disputed') return 'noop'; // idempotent

    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          payment_status: 'paid',
          'dispute_hold.active': false,
          'dispute_hold.resolved_at': new Date(),
          updated_at: new Date(),
        },
      }
    );

    await this.appendTimeline(
      orderId,
      'Dispute won — order unfrozen, payment restored to paid',
      { disputeId },
      actor
    );
    await this.publishDisputeEvent(orderId, 'order', 'won', { disputeId });
    return 'resolved';
  }

  private async resolveOrderLost(
    orderId: string,
    paymentIntentId: string,
    reason: 'chargeback' | 'refund',
    disputeId: string | null,
    actor: DisputeActor = SYSTEM_ACTOR
  ): Promise<DisputeResolution> {
    const order = await OrderModel.findById(orderId);
    if (!order) return 'noop';
    if (order.payment_status === 'refunded') {
      // Already unwound (e.g. by our own refund flow). Just clear any hold.
      if (order.dispute_hold?.active) {
        await OrderModel.updateOne(
          { _id: order._id },
          { $set: { 'dispute_hold.active': false, 'dispute_hold.resolved_at': new Date() } }
        );
        // The hold WAS lifted, so this is a real change — an operator asking to resolve a
        // frozen-but-already-refunded order got what they wanted.
        return 'resolved';
      }
      return 'noop';
    }

    // Goods already in motion must come back; otherwise the order is cancelled.
    const inMotion: FulfillmentStatus[] = ['partially_shipped', 'shipped', 'partially_delivered', 'delivered', 'fulfilled'];
    const newFulfillment: FulfillmentStatus = inMotion.includes(order.fulfillment_status)
      ? 'returned'
      : 'cancelled';

    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          payment_status: 'refunded',
          fulfillment_status: newFulfillment,
          'dispute_hold.active': false,
          'dispute_hold.resolved_at': new Date(),
          updated_at: new Date(),
        },
      }
    );

    // Mark the gateway transaction refunded (audit), then reverse the escrow.
    await PaymentTransactionModel.updateOne(
      { gatewayRef: paymentIntentId },
      { $set: { status: 'REFUNDED' } }
    );
    try {
      await earningsRefundService.onOrderRefund(orderId);
    } catch (error) {
      console.error('[PaymentDispute] Failed to reverse earnings on dispute loss:', error);
    }

    await this.appendTimeline(
      orderId,
      `Dispute ${reason === 'refund' ? 'refund' : 'lost'} — order refunded and ${newFulfillment}`,
      { paymentIntentId, disputeId, fulfillment: newFulfillment },
      actor
    );
    await this.publishDisputeEvent(orderId, 'order', 'lost', { paymentIntentId, disputeId });

    await this.openTicket(
      TicketType.ORDER_DISPUTE,
      EntityType.ORDER,
      orderId,
      `Order dispute ${reason === 'refund' ? 'refunded' : 'lost'} (#${order.order_number})`,
      `Order ${order.order_number} was ${reason}d (PaymentIntent ${paymentIntentId}). ` +
        `It is now refunded and marked '${newFulfillment}'; vendor earnings were reversed.`
    );

    return 'resolved';
  }

  // ─── Bookings ───────────────────────────────────────────────────────────────

  private async freezeBooking(
    bookingId: string,
    paymentIntentId: string,
    disputeId: string | null
  ): Promise<void> {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;
    if (booking.paymentStatus === 'disputed' || booking.paymentStatus === 'refunded') return; // idempotent

    booking.paymentStatus = 'disputed';
    await booking.save();
    await this.calendarSync.syncBookingPaymentStatus(booking);

    await this.openTicket(
      TicketType.CHARGEBACK,
      EntityType.BOOKING,
      bookingId,
      'Booking payment disputed',
      `A Stripe dispute (${disputeId ?? 'n/a'}) was opened on booking ${bookingId} ` +
        `(PaymentIntent ${paymentIntentId}). The booking payment is undecided until the dispute settles.`
    );
  }

  private async resolveBookingWon(bookingId: string, disputeId: string | null): Promise<void> {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;
    if (booking.paymentStatus !== 'disputed') return; // idempotent

    booking.paymentStatus = 'paid';
    await booking.save();
    await this.calendarSync.syncBookingPaymentStatus(booking);
    console.log(`[PaymentDispute] Booking ${bookingId} dispute won (${disputeId ?? 'n/a'}) — restored to paid`);
  }

  private async resolveBookingLost(
    bookingId: string,
    paymentIntentId: string,
    reason: 'chargeback' | 'refund',
    disputeId: string | null
  ): Promise<void> {
    const booking = await Booking.findById(bookingId);
    if (!booking) return;
    if (booking.paymentStatus === 'refunded') return; // already unwound

    booking.paymentStatus = 'refunded';
    booking.status = BookingStatus.CANCELLED;
    booking.cancelledAt = new Date();
    booking.cancelledReason = `Payment ${reason} (Stripe dispute ${disputeId ?? 'n/a'})`;
    await booking.save();

    await PaymentTransactionModel.updateOne(
      { gatewayRef: paymentIntentId },
      { $set: { status: 'REFUNDED' } }
    );
    try {
      await earningsRefundService.onRefund('booking', bookingId);
    } catch (error) {
      console.error('[PaymentDispute] Failed to reverse earnings on booking dispute loss:', error);
    }
    await this.calendarSync.syncBookingPaymentStatus(booking);

    await this.openTicket(
      TicketType.CHARGEBACK,
      EntityType.BOOKING,
      bookingId,
      `Booking dispute ${reason === 'refund' ? 'refunded' : 'lost'}`,
      `Booking ${bookingId} was ${reason}d (PaymentIntent ${paymentIntentId}). ` +
        `It is now refunded and cancelled; vendor earnings were reversed.`
    );
  }

  // ─── Admin manual resolution ────────────────────────────────────────────────

  /**
   * Manually resolve an order dispute (admin override) — for when a Stripe event
   * is missed or the case is handled out of band. `won` lifts the hold and
   * restores `paid`; `lost` refunds + returns/cancels and reverses escrow.
   *
   * Returns `'noop'` when there was nothing to resolve. **The caller decides what that
   * means**: this method is reachable only from an operator, so its controller raises a
   * 409 rather than reporting a resolution that never happened — but the policy lives at
   * the edge, beside the other status codes, not buried in a service the webhooks share.
   */
  async adminResolveOrder(
    orderId: string,
    outcome: 'won' | 'lost',
    actor: DisputeActor = SYSTEM_ACTOR
  ): Promise<DisputeResolution> {
    if (outcome === 'won') {
      return await this.resolveOrderWon(orderId, null, actor);
    }
    // `orderIds` as well as `orderId`: a cart checkout writes ONE payment for N orders
    // (`cartId` + `orderIds[]`, never `orderId` — the model enforces exactly one source
    // field), so matching on `orderId` alone finds nothing for the entire cart-checkout
    // population and the unwind proceeds with an empty gateway ref.
    const tx = await PaymentTransactionModel.findOne({
      $or: [{ orderId }, { orderIds: orderId }],
    });
    return await this.resolveOrderLost(orderId, tx?.gatewayRef ?? '', 'chargeback', null, actor);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async findOrderIdByPaymentIntent(paymentIntentId: string): Promise<string | null> {
    const tx = await PaymentTransactionModel.findOne({ gatewayRef: paymentIntentId });
    return tx?.orderId ? tx.orderId.toString() : null;
  }

  private async findBookingIdByPaymentIntent(paymentIntentId: string): Promise<string | null> {
    const tx = await PaymentTransactionModel.findOne({ gatewayRef: paymentIntentId });
    return tx?.bookingId ? tx.bookingId.toString() : null;
  }

  private async flagBillingForReview(
    paymentIntentId: string,
    disputeId: string | null,
    phase: 'opened'
  ): Promise<void> {
    // On open we don't change any entitlement (plans/top-ups only unwind on loss),
    // so we just file a review ticket keyed by the PaymentIntent.
    await this.openTicket(
      TicketType.CHARGEBACK,
      EntityType.OTHER,
      paymentIntentId,
      `Billing payment dispute ${phase}`,
      `A Stripe dispute (${disputeId ?? 'n/a'}) was ${phase} on a billing PaymentIntent ` +
        `(${paymentIntentId}). No entitlement change yet; it will be unwound if the dispute is lost.`
    );
  }

  private async appendTimeline(
    orderId: string,
    description: string,
    metadata: Record<string, unknown>,
    actor: DisputeActor = SYSTEM_ACTOR
  ): Promise<void> {
    try {
      await this.timelineRepo.appendEvent({
        orderId,
        eventType: 'payment.updated',
        description,
        metadata,
        actorType: actor.type,
        actorId: actor.id,
      });
    } catch (error) {
      console.error('[PaymentDispute] Failed to append timeline entry:', error);
    }
  }

  private async openTicket(
    type: TicketType,
    entityType: EntityType,
    entityId: string,
    subject: string,
    description: string
  ): Promise<void> {
    try {
      await ticketService.createSystemTicket({
        type,
        entityType,
        entityId,
        subject,
        description,
        importance: TicketImportance.HIGH,
      });
    } catch (error) {
      console.error('[PaymentDispute] Failed to open dispute ticket:', error);
    }
  }

  private async publishDisputeEvent(
    aggregateId: string,
    kind: 'order',
    phase: 'frozen' | 'won' | 'lost',
    payload: Record<string, unknown>
  ): Promise<void> {
    eventBus
      .publish('payment.disputed', {
        eventType: 'payment.disputed',
        aggregateId,
        payload: { kind, phase, ...payload },
        occurredAt: new Date(),
      })
      .catch(() => { /* non-blocking */ });
  }
}

export const paymentDisputeService = new PaymentDisputeService();
