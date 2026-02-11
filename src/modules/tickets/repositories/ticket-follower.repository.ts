import { TicketFollowerModel, ITicketFollower } from '../models/ticket-follower.model';
import { ActorRole } from '../types/ticket.types';
import mongoose from 'mongoose';

/**
 * TicketFollowerRepository
 * 
 * Data access for ticket followers (many-to-many junction table).
 * 
 * BUSINESS RULES ENFORCED HERE:
 * - Unique constraint: ticket_id + user_id (enforced by DB index)
 * - 5-user limit logic queries (count non-admin followers)
 */

export class TicketFollowerRepository {
    /**
     * Add a follower to a ticket
     */
    async addFollower(
        ticketId: string,
        userId: string,
        role: ActorRole,
        isAdmin: boolean,
        addedBy: string
    ): Promise<ITicketFollower> {
        const follower = new TicketFollowerModel({
            ticket_id: ticketId,
            user_id: userId,
            role,
            is_admin: isAdmin,
            added_by_user_id: addedBy
        });

        return await follower.save();
    }

    /**
     * Remove a follower from a ticket
     */
    async removeFollower(ticketId: string, userId: string): Promise<void> {
        await TicketFollowerModel.deleteOne({
            ticket_id: ticketId,
            user_id: userId
        });
    }

    /**
     * Get all followers for a ticket
     */
    async getFollowers(ticketId: string): Promise<ITicketFollower[]> {
        return await TicketFollowerModel.find({ ticket_id: ticketId }).sort({ added_at: 1 });
    }

    /**
     * Check if user is following a ticket
     */
    async isFollower(ticketId: string, userId: string): Promise<boolean> {
        const follower = await TicketFollowerModel.findOne({
            ticket_id: ticketId,
            user_id: userId
        });
        return follower !== null;
    }

    /**
     * Count non-admin followers for a ticket
     * 
     * Used to enforce 5-user limit
     */
    async countNonAdminFollowers(ticketId: string): Promise<number> {
        return await TicketFollowerModel.countDocuments({
            ticket_id: ticketId,
            is_admin: false
        });
    }

    /**
     * Get distinct non-admin user IDs who have ever followed this ticket
     * 
     * Used to enforce 5-user lifetime limit
     */
    async getDistinctNonAdminUserIds(ticketId: string): Promise<string[]> {
        const result = await TicketFollowerModel.distinct('user_id', {
            ticket_id: ticketId,
            is_admin: false
        });
        return result.map(id => id.toString());
    }

    /**
     * Get follower user IDs (for visibility checks)
     */
    async getFollowerUserIds(ticketId: string): Promise<string[]> {
        const followers = await TicketFollowerModel.find({ ticket_id: ticketId }).select('user_id');
        return followers.map(f => f.user_id.toString());
    }

    /**
     * Get follower by ticket and user
     */
    async getFollower(ticketId: string, userId: string): Promise<ITicketFollower | null> {
        return await TicketFollowerModel.findOne({
            ticket_id: ticketId,
            user_id: userId
        });
    }

    /**
     * Get admin followers for a ticket
     * 
     * Used for auto-including admins in private attendance visibility
     */
    async getAdminFollowers(ticketId: string): Promise<ITicketFollower[]> {
        return await TicketFollowerModel.find({
            ticket_id: ticketId,
            is_admin: true
        });
    }
}
