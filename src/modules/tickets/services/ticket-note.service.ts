import { TicketNoteRepository } from '../repositories/ticket-note.repository';
import { TicketFollowerRepository } from '../repositories/ticket-follower.repository';
import { TicketRepository } from '../repositories/ticket.repository';
import { ActorRole, NoteVisibility, TicketStatus } from '../types/ticket.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ITicketNote } from '../models/ticket-note.model';
import { eventBus } from '../../../core/events/event-bus';
import mongoose from 'mongoose';

/**
 * TicketNoteService
 * 
 * Manages ticket notes with visibility controls.
 * 
 * DOMAIN RULES:
 * - Customers can ONLY create public notes
 * - Other roles can create public or private notes
 * - Private notes visible to: author + admins + users in visible_to_user_ids
 * - Public notes visible to: all ticket followers
 * - Admins always see ALL notes
 * - visible_to_user_ids must be subset of ticket followers
 * - System notes are always public
 */

export class TicketNoteService {
    private noteRepo: TicketNoteRepository;
    private followerRepo: TicketFollowerRepository;
    private ticketRepo: TicketRepository;

    constructor() {
        this.noteRepo = new TicketNoteRepository();
        this.followerRepo = new TicketFollowerRepository();
        this.ticketRepo = new TicketRepository();
    }

    /**
     * Create a note on a ticket
     * 
     * @param ticketId - Ticket ID
     * @param content - Note content
     * @param authorUserId - Author user ID
     * @param authorRole - Author role
     * @param visibility - public or private
     * @param visibleToUserIds - User IDs who can see private note (optional)
     */
    async createNote(
        ticketId: string,
        content: string,
        authorUserId: string,
        authorRole: ActorRole,
        visibility: NoteVisibility = NoteVisibility.PUBLIC,
        visibleToUserIds: string[] = []
    ): Promise<ITicketNote> {
        // Closed tickets are terminal; no new notes until reopened
        const ticket = await this.ticketRepo.findById(ticketId);
        if (!ticket) {
            throw createAppError(ERROR_CODES.TICKET_NOT_FOUND, 404);
        }
        if (ticket.status === TicketStatus.CLOSED) {
            throw createAppError(ERROR_CODES.TICKET_CLOSED, 409, 'Cannot add notes to a closed ticket');
        }

        // Validate user is follower or admin
        const isFollower = await this.followerRepo.isFollower(ticketId, authorUserId);
        if (!isFollower && authorRole !== ActorRole.ADMIN) {
            throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'Only ticket followers can create notes');
        }

        // Customers can only create public notes
        if (authorRole === ActorRole.CUSTOMER && visibility === NoteVisibility.PRIVATE) {
            throw createAppError(ERROR_CODES.TICKET_CUSTOMER_PRIVATE_NOTE_FORBIDDEN, 403, 'Customers cannot create private notes');
        }

        // For private notes, validate visibleToUserIds are ticket followers
        if (visibility === NoteVisibility.PRIVATE && visibleToUserIds.length > 0) {
            const ticketFollowerIds = await this.followerRepo.getFollowerUserIds(ticketId);
            const invalidUserIds = visibleToUserIds.filter(id => !ticketFollowerIds.includes(id));

            if (invalidUserIds.length > 0) {
                throw createAppError(ERROR_CODES.TICKET_ACCESS_DENIED, 403, 'All users in visibleToUserIds must be ticket followers');
            }
        }

        // Build final visibility list for private notes
        let finalVisibleTo: string[] = [];
        if (visibility === NoteVisibility.PRIVATE) {
            // Add author
            finalVisibleTo.push(authorUserId);

            // Add specified users
            finalVisibleTo.push(...visibleToUserIds);

            // Add all admins (get from follower list)
            const allFollowers = await this.followerRepo.getFollowers(ticketId);
            const adminFollowerIds = allFollowers
                .filter(f => f.is_admin)
                .map(f => f.user_id.toString());
            finalVisibleTo.push(...adminFollowerIds);

            // Remove duplicates
            finalVisibleTo = [...new Set(finalVisibleTo)];
        }

        // Create note
        const note = await this.noteRepo.create({
            ticket_id: new mongoose.Types.ObjectId(ticketId),
            author_user_id: new mongoose.Types.ObjectId(authorUserId),
            author_role: authorRole,
            content,
            visibility,
            is_system_note: false,
            visible_to_user_ids: finalVisibleTo.map(id => new mongoose.Types.ObjectId(id))
        });

        // Emit event
        await eventBus.publish('ticket.note_created', {
            eventType: 'ticket.note_created',
            aggregateId: ticketId,
            payload: {
                ticketId,
                noteId: note.id,
                authorRole,
                visibility
            },
            occurredAt: new Date()
        });

        return note;
    }

    /**
     * List notes for a ticket with visibility filtering
     * 
     * @param ticketId - Ticket ID
     * @param viewerUserId - User viewing the notes
     * @param viewerRole - User's role
     */
    async listNotes(
        ticketId: string,
        viewerUserId: string,
        viewerRole: ActorRole
    ): Promise<ITicketNote[]> {
        return await this.noteRepo.findByTicket(ticketId, viewerRole, viewerUserId);
    }

    /**
     * Create a system note (internal use by other services)
     */
    async createSystemNote(ticketId: string, content: string): Promise<ITicketNote> {
        return await this.noteRepo.createSystemNote(ticketId, content);
    }
}
