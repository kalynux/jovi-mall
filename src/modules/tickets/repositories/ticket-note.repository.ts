import { TicketNoteModel, ITicketNote } from '../models/ticket-note.model';
import { ActorRole, NoteVisibility } from '../types/ticket.types';
import mongoose from 'mongoose';

/**
 * TicketNoteRepository
 * 
 * Data access for ticket notes with visibility enforcement.
 * 
 * VISIBILITY RULES:
 * - Admins see ALL notes (enforced here)
 * - Public notes: visible to all ticket followers
 * - Private notes: visible to author + admins + users in visible_to_user_ids
 */

export class TicketNoteRepository {
    /**
     * Create a new note
     */
    async create(noteData: Partial<ITicketNote>): Promise<ITicketNote> {
        const note = new TicketNoteModel(noteData);
        return await note.save();
    }

    /**
     * Create a system note (always public)
     */
    async createSystemNote(ticketId: string, content: string): Promise<ITicketNote> {
        const note = new TicketNoteModel({
            ticket_id: ticketId,
            author_user_id: new mongoose.Types.ObjectId('000000000000000000000000'), // System user
            author_role: ActorRole.ADMIN,
            content,
            visibility: NoteVisibility.PUBLIC,
            is_system_note: true,
            visible_to_user_ids: []
        });

        return await note.save();
    }

    /**
     * Find notes for a ticket with visibility filtering
     * 
     * @param ticketId - Ticket ID
     * @param viewerRole - Role of user viewing notes
     * @param viewerUserId - User ID of viewer
     */
    async findByTicket(
        ticketId: string,
        viewerRole: ActorRole,
        viewerUserId: string
    ): Promise<ITicketNote[]> {
        // Admins see everything
        if (viewerRole === ActorRole.ADMIN) {
            return await TicketNoteModel.find({ ticket_id: ticketId }).sort({ created_at: 1 });
        }

        // Non-admins see:
        // 1. All public notes
        // 2. Private notes they authored
        // 3. Private notes where they are in visible_to_user_ids
        return await TicketNoteModel.find({
            ticket_id: ticketId,
            $or: [
                { visibility: NoteVisibility.PUBLIC },
                { author_user_id: viewerUserId },
                { visible_to_user_ids: viewerUserId }
            ]
        }).sort({ created_at: 1 });
    }

    /**
     * Find all notes for a ticket (admin use only)
     */
    async findAllByTicket(ticketId: string): Promise<ITicketNote[]> {
        return await TicketNoteModel.find({ ticket_id: ticketId }).sort({ created_at: 1 });
    }

    /**
     * Count notes for a ticket
     */
    async countByTicket(ticketId: string): Promise<number> {
        return await TicketNoteModel.countDocuments({ ticket_id: ticketId });
    }

    /**
     * Find system notes for a ticket
     */
    async findSystemNotesByTicket(ticketId: string): Promise<ITicketNote[]> {
        return await TicketNoteModel.find({
            ticket_id: ticketId,
            is_system_note: true
        }).sort({ created_at: 1 });
    }
}
