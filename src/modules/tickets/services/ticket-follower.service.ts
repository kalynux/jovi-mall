import { TicketFollowerRepository } from '../repositories/ticket-follower.repository';
import { TicketRepository } from '../repositories/ticket.repository';
import { TicketNoteRepository } from '../repositories/ticket-note.repository';
import { ActorRole } from '../types/ticket.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * TicketFollowerService
 * 
 * Manages ticket follower relationships with strict 5-user limit enforcement.
 * 
 * DOMAIN RULES:
 * - Max 5 distinct non-admin users per ticket (lifetime)
 * - Creator auto-added as follower
 * - Assignee auto-added as follower
 * - Admins never count toward limit
 * - Admins cannot be removed
 * - Creator cannot be removed
 * - Current assignee cannot be removed
 * - Only admins can remove followers
 */

export class TicketFollowerService {
    private followerRepo: TicketFollowerRepository;
    private ticketRepo: TicketRepository;
    private noteRepo: TicketNoteRepository;

    constructor() {
        this.followerRepo = new TicketFollowerRepository();
        this.ticketRepo = new TicketRepository();
        this.noteRepo = new TicketNoteRepository();
    }

    /**
     * Add a follower to a ticket
     * 
     * Enforces 5-user limit for non-admin users.
     * 
     * @param ticketId - Ticket ID
     * @param userId - User ID to add as follower
     * @param role - User's role
     * @param addedByUserId - User ID of the person adding this follower
     * @param silent - If true, don't create system note (for auto-add scenarios)
     */
    async addFollower(
        ticketId: string,
        userId: string,
        role: ActorRole,
        addedByUserId: string,
        silent: boolean = false
    ): Promise<void> {
        // Check if already a follower
        const isAlreadyFollower = await this.followerRepo.isFollower(ticketId, userId);
        if (isAlreadyFollower) {
            return; // Idempotent operation
        }

        const isAdmin = role === ActorRole.ADMIN;

        // Enforce 5-user limit for non-admins
        if (!isAdmin) {
            const distinctNonAdminUserIds = await this.followerRepo.getDistinctNonAdminUserIds(ticketId);

            // Check if this user would be the 6th distinct non-admin user
            if (!distinctNonAdminUserIds.includes(userId) && distinctNonAdminUserIds.length >= 5) {
                throw createAppError(ERROR_CODES.TICKET_FOLLOWER_LIMIT_EXCEEDED, 422, 'Cannot add follower: maximum of 5 non-admin users per ticket has been reached');
            }
        }

        // Add follower
        await this.followerRepo.addFollower(ticketId, userId, role, isAdmin, addedByUserId);

        // Create system note (unless silent)
        if (!silent) {
            await this.noteRepo.createSystemNote(
                ticketId,
                `User added as follower (Role: ${role})`
            );
        }
    }

    /**
     * Remove a follower from a ticket
     * 
     * Validates:
     * - Requester is admin
     * - Target is not the creator
     * - Target is not the current assignee
     * - Target is not an admin
     * 
     * @param ticketId - Ticket ID
     * @param userIdToRemove - User ID to remove
     * @param requesterId - User ID making the request
     * @param requesterRole - Role of requester
     */
    async removeFollower(
        ticketId: string,
        userIdToRemove: string,
        requesterId: string,
        requesterRole: ActorRole
    ): Promise<void> {
        // Only admins can remove followers
        if (requesterRole !== ActorRole.ADMIN) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only admins can remove followers');
        }

        // Get ticket details
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }

        // Get follower details
        const follower = await this.followerRepo.getFollower(ticketId, userIdToRemove);
        if (!follower) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404, 'Follower not found');
        }

        // Cannot remove creator
        if (ticket.created_by_user_id.toString() === userIdToRemove) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Cannot remove ticket creator from followers');
        }

        // Cannot remove current assignee
        if (ticket.assigned_to_user_id && ticket.assigned_to_user_id.toString() === userIdToRemove) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Cannot remove current assignee from followers');
        }

        // Cannot remove admins
        if (follower.is_admin) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Cannot remove admins from followers');
        }

        // Remove follower
        await this.followerRepo.removeFollower(ticketId, userIdToRemove);

        // Create system note
        await this.noteRepo.createSystemNote(
            ticketId,
            `User removed from followers`
        );
    }

    /**
     * Get all followers for a ticket
     */
    async getFollowers(ticketId: string) {
        return await this.followerRepo.getFollowers(ticketId);
    }

    /**
     * Check if user is follower
     */
    async isFollower(ticketId: string, userId: string): Promise<boolean> {
        return await this.followerRepo.isFollower(ticketId, userId);
    }

    /**
     * Whether the ticket has at least one follower with the given role.
     *
     * Creator and assignee are auto-added as followers, so this reflects every
     * party currently participating in the ticket. Used to validate that a
     * "waiting on <role>" status targets someone actually on the ticket.
     */
    async hasParticipantWithRole(ticketId: string, role: ActorRole): Promise<boolean> {
        const followers = await this.followerRepo.getFollowers(ticketId);
        return followers.some(f => f.role === role);
    }

    /**
     * Get follower count for a ticket
     */
    async getFollowerCount(ticketId: string): Promise<{ total: number; nonAdminCount: number }> {
        const allFollowers = await this.followerRepo.getFollowers(ticketId);
        const nonAdminCount = await this.followerRepo.countNonAdminFollowers(ticketId);

        return {
            total: allFollowers.length,
            nonAdminCount
        };
    }
}
