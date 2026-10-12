import mongoose from 'mongoose';
import { ActorRole, EntityType } from '../types/ticket.types';
import { ITicket } from '../models/ticket.model';
import { TicketRepository } from '../repositories/ticket.repository';
import { TicketFollowerRepository } from '../repositories/ticket-follower.repository';
import { TicketFollowerService } from './ticket-follower.service';
import { OrderModel } from '../../orders/order.model';
import { ShipmentModel } from '../../shipments/shipment.model';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import { SYSTEM_ACTOR_ID } from '../../../core/types/system-actor';
import { logger } from '../../../core/logging';

/**
 * The parties of an order follow every ticket about it (owner decision 2026-10-09).
 *
 * ── Who ──────────────────────────────────────────────────────────────────────
 * The order's VENDOR, and every AGENCY and AGENT on its shipments. Not the customer: a
 * vendor-to-agency problem may not concern them, and an administrator can still add them by
 * hand. Each party is the profile's owning `users` row (`user_id`, unique on all three).
 *
 * The shipments are the whole truth for agencies and agents. Every shipment is created with
 * its agency at checkout, inside the order's own transaction, so a ticket can never predate
 * one; a change of agency moves the items to the destination's shipment and DELETES the
 * emptied source; `agent_id` is set by exactly one write (`bindAgentIfUnassigned`). So the
 * order's shipments name its current agencies and agents and nothing else.
 *
 * ── Which tickets ─────────────────────────────────────────────────────────────
 * ORDER tickets, and SHIPMENT tickets through their shipment's order — whoever opened them,
 * the platform and administrators included. Followers see public notes only; a staff note
 * stays private exactly as it does for the customer.
 *
 * ── When ─────────────────────────────────────────────────────────────────────
 *   - the ticket is created            → `addToTicket`, from `TicketService.createTicket`
 *   - the ticket is reopened           → `syncOrder`, from `TicketService.reopenTicket`
 *   - an agent accepts a shipment      → `syncTicketFollowersForOrder`, after the accept commits
 *   - items move to another agency     → `syncTicketFollowersForOrder`, after the move commits
 * A sync only ever ADDS. A replaced agent or agency keeps following: they were party to the
 * case, and what they said in it stays theirs to read. Terminal tickets are left alone.
 *
 * ── What it never does ───────────────────────────────────────────────────────
 *   - re-add a user an administrator removed (`Ticket.removed_follower_user_ids`)
 *   - count toward the 5-user limit (`source: 'order_party'` is cap-exempt)
 *   - fail the write that triggered it. A ticket is still created, and a shipment still
 *     accepted, when a party cannot be resolved; the failure is logged, and the next sync on
 *     the order (or a reopen) adds whoever was missed, since a sync re-derives everything.
 */

export interface OrderParty {
    userId: string;
    role: ActorRole.VENDOR | ActorRole.AGENCY | ActorRole.AGENT;
}

/**
 * The parties still to add to one ticket: the order's parties, minus anyone already
 * following and anyone an administrator removed. One row per user — a user holding two of
 * the order's roles at once keeps the first (vendor, then agency, then agent).
 *
 * Pure, so the rule is testable without a database.
 */
export function planOrderPartyFollowers(
    parties: OrderParty[],
    existingFollowerIds: Iterable<string>,
    removedUserIds: Iterable<string>
): OrderParty[] {
    const skip = new Set<string>([...existingFollowerIds, ...removedUserIds]);
    const plan: OrderParty[] = [];
    for (const party of parties) {
        if (skip.has(party.userId)) continue;
        skip.add(party.userId);
        plan.push(party);
    }
    return plan;
}

export class TicketOrderPartiesService {
    constructor(
        private readonly ticketRepo = new TicketRepository(),
        private readonly followerRepo = new TicketFollowerRepository(),
        private readonly followerService = new TicketFollowerService()
    ) {}

    /**
     * Add the order's parties to ONE ticket — the creation path. Silent: the ticket has no
     * history yet for a "user added" note to explain, exactly as with the creator.
     *
     * @returns how many followers were added (0 for a ticket that is not about an order)
     */
    async addToTicket(ticket: ITicket): Promise<number> {
        const orderId = await this.orderIdOf(ticket.entity_type, ticket.entity_id);
        if (!orderId) return 0;
        const { parties } = await this.resolveParties(orderId);
        return this.apply(ticket, parties, true);
    }

    /**
     * Add the order's CURRENT parties to every open ticket about it. Each addition leaves the
     * usual public "User added as follower" system note, so the customer and the other
     * parties can see who joined, and when.
     *
     * @returns how many followers were added across all tickets
     */
    async syncOrder(orderId: string): Promise<number> {
        if (!mongoose.Types.ObjectId.isValid(orderId)) return 0;
        const { parties, shipmentIds } = await this.resolveParties(orderId);
        if (parties.length === 0) return 0;

        const tickets = await this.ticketRepo.findOpenAboutOrder(orderId, shipmentIds);
        let added = 0;
        for (const ticket of tickets) {
            added += await this.apply(ticket, parties, false);
        }
        return added;
    }

    /** The order a ticket is about, or null when it is about something else. */
    async orderIdOf(entityType: EntityType, entityId: string): Promise<string | null> {
        if (!entityId || !mongoose.Types.ObjectId.isValid(entityId)) return null;
        switch (entityType) {
            case EntityType.ORDER:
                return entityId;
            case EntityType.SHIPMENT: {
                const shipment = await ShipmentModel.findById(entityId).select('order_id').lean();
                return shipment?.order_id?.toString() ?? null;
            }
            default:
                return null;
        }
    }

    private async apply(ticket: ITicket, parties: OrderParty[], silent: boolean): Promise<number> {
        const ticketId = (ticket._id as mongoose.Types.ObjectId).toString();
        const existing = await this.followerRepo.getFollowerUserIds(ticketId);
        const removed = (ticket.removed_follower_user_ids ?? []).map((id) => id.toString());

        let added = 0;
        for (const party of planOrderPartyFollowers(parties, existing, removed)) {
            const wrote = await this.followerService.addFollower(ticketId, party.userId, party.role, SYSTEM_ACTOR_ID, {
                source: 'order_party',
                silent,
            });
            if (wrote) added++;
        }
        return added;
    }

    /** The vendor, then each agency, then each agent — as owning `users` ids. */
    private async resolveParties(orderId: string): Promise<{ parties: OrderParty[]; shipmentIds: string[] }> {
        const order = await OrderModel.findById(orderId).select('vendor_id').lean();
        if (!order) return { parties: [], shipmentIds: [] };

        const shipments = await ShipmentModel.find({ order_id: orderId }).select('agency_id agent_id').lean();
        const shipmentIds = shipments.map((s) => s._id.toString());
        const agencyIds = unique(shipments.map((s) => s.agency_id?.toString()));
        const agentIds = unique(shipments.map((s) => s.agent_id?.toString()));

        const [vendor, agencies, agents] = await Promise.all([
            order.vendor_id ? VendorModel.findById(order.vendor_id).select('user_id').lean() : null,
            agencyIds.length ? DeliveryAgencyModel.find({ _id: { $in: agencyIds } }).select('user_id').lean() : [],
            agentIds.length ? DeliveryAgentModel.find({ _id: { $in: agentIds } }).select('user_id').lean() : [],
        ]);

        const parties: OrderParty[] = [];
        if (vendor?.user_id) parties.push({ userId: vendor.user_id.toString(), role: ActorRole.VENDOR });
        for (const a of agencies) {
            if (a.user_id) parties.push({ userId: a.user_id.toString(), role: ActorRole.AGENCY });
        }
        for (const a of agents) {
            if (a.user_id) parties.push({ userId: a.user_id.toString(), role: ActorRole.AGENT });
        }
        return { parties, shipmentIds };
    }
}

function unique(ids: Array<string | undefined>): string[] {
    return [...new Set(ids.filter((id): id is string => !!id))];
}

export const ticketOrderPartiesService = new TicketOrderPartiesService();

/**
 * The hook for write paths OUTSIDE this module — fire-and-forget, never throws.
 *
 * Called after a commit, never inside a transaction: a follower row written for an accept
 * that then rolled back would show an agent a ticket about a delivery they never got.
 * A direct call rather than an event-bus subscription, because the bus is lossy and nothing
 * sweeps behind it (`core/events/event-bus.ts`); a sync is cheap and re-derives everything, so
 * one lost run is repaired by the next event on the order.
 */
export function syncTicketFollowersForOrder(orderId: string, origin: string): void {
    void ticketOrderPartiesService.syncOrder(orderId).catch((err) => {
        logger().error({ err, orderId, origin }, 'tickets: order-party follower sync failed');
    });
}
