import mongoose from 'mongoose';
import { ActorRole, EntityType } from '../types/ticket.types';
import { ITicket } from '../models/ticket.model';
import { TicketRepository } from '../repositories/ticket.repository';
import { TicketNoteService } from './ticket-note.service';
import { isProblemReport, mayReleaseHold } from '../domain/problem-report.rule';
import { OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { Booking } from '../../booking/models/booking.model';
import { adminLiftedProblemPause } from '../../earnings/domain/earnings-hold';
import { EarningsAllocationRepository } from '../../earnings/repositories/earnings-allocation.repository';
import { earningsCompletionService } from '../../earnings/services/earnings-completion.service';
import {
    bookingSourcesOf,
    earningsPauseService,
    EarningsPauseService,
    PauseActor,
    PauseTarget,
    SYSTEM_PAUSE_ACTOR,
} from '../../earnings/services/earnings-pause.service';

const REASON = 'customer_problem_reported' as const;

/**
 * Who a resume is signed by when an administrator ended the request. `source: 'admin'` is the
 * part that is read back. No id: the administrator's own id is on the ticket's history, and
 * an admin id does not resolve in this database anyway.
 */
const ADMIN_ENDED_REQUEST_ACTOR: PauseActor = { userId: null, source: 'admin', name: 'administrator (request ended)' };

/** The public system notes left on the request, so every follower sees what happened and why. */
export const HOLD_NOTE_PAUSED =
    'The earnings for this purchase are on hold while this request is open.';
export const HOLD_NOTE_RELEASED =
    'This request no longer holds the earnings for this purchase.';

/**
 * TicketEarningsHoldService — a customer's problem report keeps the purchase's money paused
 * (owner decision, 2026-10-10).
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * A customer opens a request of a problem type (`domain/problem-report.rule.ts`) about THEIR
 * OWN order, shipment or booking, while its money has not been released yet → the order's or
 * booking's earnings are paused with reason `customer_problem_reported`, for every actor on
 * it, until the request ends. After the money was released there is nothing to pause: the
 * request is still opened and handled, it simply holds nothing.
 *
 * ── Two records, and why the ticket's STATUS is not one of them ──────────────
 *  - the PAUSE on the order/booking (`EarningsPauseService`) is what stops the release;
 *  - `Ticket.holds_earnings` records WHICH requests stand behind it.
 * A seller follows every request about their order and may set any status on it. If
 * "resolved" freed the money, a seller could pay themselves by resolving a complaint against
 * them. So the flag is cleared only by an administrator or by the customer who opened the
 * request (`mayReleaseHold`), and the pause is lifted only when no flagged request is left.
 *
 * ── `reconcile` is the single decision ───────────────────────────────────────
 * Every entry point changes a flag and then calls `reconcile`, which reads the present state
 * and does the one thing it implies. It is idempotent and safe to call at any time:
 *  - a `customer_problem_reported` pause with no flagged request and no refund holding it → resume;
 *  - no active pause, a flagged request, money still held → pause.
 * The second case is what covers a request opened while ANOTHER pause was active (a refund in
 * progress): when that pause ends without a refund, the refund adapter calls this and the
 * customer's report takes over rather than letting the money go.
 *
 * ── What stops abuse ────────────────────────────────────────────────────────
 * An administrator can resume the earnings by hand at any time (`releaseAll`), and once they
 * have, a new request about the same purchase no longer pauses it by itself
 * (`adminLiftedProblemPause`). The request must also come from the purchase's own customer:
 * ticket creation checks only that the order exists, and without this check any customer
 * could freeze any seller's money by quoting an order id.
 *
 * Every public method is best-effort for its caller: the ticket write that preceded it
 * stands either way. Callers wrap them and log.
 */
export class TicketEarningsHoldService {
    constructor(
        private readonly ticketRepo: TicketRepository = new TicketRepository(),
        private readonly noteService: TicketNoteService = new TicketNoteService(),
        private readonly pauses: EarningsPauseService = earningsPauseService,
        private readonly allocationRepo: EarningsAllocationRepository = new EarningsAllocationRepository()
    ) {}

    /**
     * A ticket was just created. Returns true when it now holds the purchase's earnings.
     * `creator.entityId` is the role entity (the customer profile id an order is keyed by).
     */
    async onTicketCreated(ticket: ITicket, creator: { userId: string; entityId: string }): Promise<boolean> {
        if (!isProblemReport({
            type: ticket.type,
            createdByRole: ticket.created_by_role,
            entityType: ticket.entity_type,
        })) return false;

        const target = await this.targetOf(ticket.entity_type, ticket.entity_id);
        if (!target) return false;
        if (!(await this.ownsTarget(target, creator))) return false;
        if (adminLiftedProblemPause(await this.pauses.currentPause(target))) return false;
        if (!(await this.moneyNotReleased(target))) return false;

        const ticketId = String(ticket._id);
        await this.ticketRepo.setHoldsEarnings(ticketId, true);
        await this.reconcile(target, ticketId);
        await this.noteService.createSystemNote(ticketId, HOLD_NOTE_PAUSED);
        return true;
    }

    /**
     * A ticket was resolved or closed. Frees its hold only when the person ending it may
     * (`mayReleaseHold`); a seller ending it changes nothing here.
     */
    async onTicketEnded(ticket: ITicket, endedBy: { userId: string; role: string }): Promise<void> {
        if (!ticket.holds_earnings) return;
        if (!mayReleaseHold(endedBy, ticket.created_by_user_id.toString())) return;

        const ticketId = String(ticket._id);
        await this.ticketRepo.setHoldsEarnings(ticketId, false);
        await this.noteService.createSystemNote(ticketId, HOLD_NOTE_RELEASED);

        const target = await this.targetOf(ticket.entity_type, ticket.entity_id);
        if (target) await this.reconcile(target, ticketId, endedBy.role === ActorRole.ADMIN);
    }

    /**
     * An administrator resumed this order's or booking's earnings by hand: no request about
     * it holds them any more. Called AFTER the resume, so it never lifts anything itself.
     */
    async releaseAll(target: PauseTarget): Promise<void> {
        const released = await this.ticketRepo.releaseHoldingEarnings(await this.aboutOf(target));
        for (const ticketId of released) {
            await this.noteService.createSystemNote(ticketId, HOLD_NOTE_RELEASED);
        }
    }

    /**
     * Bring the pause in line with the flagged requests. See the class comment.
     *
     * `liftedByAdmin`: the request was ended by an ADMINISTRATOR, so a resume here is their
     * decision and is recorded as one — which is what makes a later request about the same
     * purchase not pause it again (`adminLiftedProblemPause`). A customer ending their own
     * request leaves that door open: they may report a different problem tomorrow.
     */
    async reconcile(target: PauseTarget, ticketId: string | null = null, liftedByAdmin = false): Promise<void> {
        const [pause, holding] = await Promise.all([
            this.pauses.currentPause(target),
            this.ticketRepo.countHoldingEarnings(await this.aboutOf(target)),
        ]);

        if (pause?.active) {
            if (pause.reason !== REASON || holding > 0) return;
            // A refund that is open, or paid and not yet recovered, needs the money to stay
            // where it is; its own completion or rejection brings us back here.
            if (await this.refundHolds(target)) return;
            await this.pauses.resume(
                target,
                liftedByAdmin ? ADMIN_ENDED_REQUEST_ACTOR : SYSTEM_PAUSE_ACTOR,
                ticketId ? `Problem report ${ticketId} ended` : 'No open problem report',
                [REASON]
            );
            return;
        }

        if (holding === 0) return;
        if (!(await this.moneyNotReleased(target))) return;
        await this.pauses.pause(
            target,
            REASON,
            SYSTEM_PAUSE_ACTOR,
            ticketId ? `The customer reported a problem (request ${ticketId})` : 'The customer reported a problem'
        );
    }

    /** The order or booking a ticket is about, or null when it is about neither. */
    private async targetOf(entityType: EntityType, entityId: string): Promise<PauseTarget | null> {
        if (!entityId || !mongoose.Types.ObjectId.isValid(entityId)) return null;
        switch (entityType) {
            case EntityType.ORDER:
                return { kind: 'order', id: entityId };
            case EntityType.SHIPMENT: {
                const shipment = await ShipmentModel.findById(entityId).select('order_id').lean();
                return shipment?.order_id ? { kind: 'order', id: shipment.order_id.toString() } : null;
            }
            case EntityType.BOOKING:
                return { kind: 'booking', id: entityId };
            default:
                return null;
        }
    }

    /** Every (entity type, ids) a ticket about this target can carry. */
    private async aboutOf(target: PauseTarget): Promise<Array<{ entityType: EntityType; entityIds: string[] }>> {
        if (target.kind === 'booking') return [{ entityType: EntityType.BOOKING, entityIds: [target.id] }];
        const shipments = await ShipmentModel.find({ order_id: target.id }, { _id: 1 }).lean();
        return [
            { entityType: EntityType.ORDER, entityIds: [target.id] },
            { entityType: EntityType.SHIPMENT, entityIds: shipments.map((s) => String(s._id)) },
        ];
    }

    private async ownsTarget(target: PauseTarget, creator: { userId: string; entityId: string }): Promise<boolean> {
        if (target.kind === 'order') {
            const order = await OrderModel.findById(target.id).select('customer_id').lean();
            return !!order && order.customer_id?.toString() === creator.entityId;
        }
        const booking = await Booking.findById(target.id).select('userId').lean();
        return !!booking && (booking as any).userId?.toString() === creator.userId;
    }

    /**
     * Is there still money to hold? Yes while any share is `held`, and yes while nothing has
     * been split yet (a row created later is caught by the release worker's own check). No
     * once every share was released or reversed: the window is over.
     */
    private async moneyNotReleased(target: PauseTarget): Promise<boolean> {
        const sources = target.kind === 'order'
            ? await earningsCompletionService.sourcesOfOrder(target.id)
            : await bookingSourcesOf(target.id);
        const rows = await this.allocationRepo.findBySources(sources);
        return rows.length === 0 || rows.some((r) => r.status === 'held');
    }

    private async refundHolds(target: PauseTarget): Promise<boolean> {
        // Lazy: `payments` imports `tickets` through the refund paths.
        const { refundRequestService } = await import('../../payments/services/refund-request.service');
        return (await refundRequestService.findHoldingEarningsPause(target.kind, target.id)) !== null;
    }
}

export const ticketEarningsHoldService = new TicketEarningsHoldService();
