import mongoose, { Schema, Document } from 'mongoose';
import { ActorRole, NoteVisibility, ACTOR_ROLE_VALUES, NOTE_VISIBILITY_VALUES } from '../types/ticket.types';

/**
 * TicketNote Model
 * 
 * Notes attached to tickets with visibility controls.
 * 
 * DOMAIN RULES:
 * - System notes are always public
 * - Customers can ONLY create public notes
 * - Vendors, Admins, Agencies, Agents can create private notes
 * - Private notes visible to: author + admins + users in visible_to_user_ids
 * - Public notes visible to: all ticket followers
 * - Admins always see ALL notes (enforced at query level)
 * - Notes are append-only (no updates/deletes)
 * 
 * SYSTEM NOTES:
 * - Generated automatically for:
 *   - Status changes
 *   - Assignment changes
 *   - Priority changes
 *   - Admin lock events
 *   - Follower add/remove
 */

export interface ITicketNote extends Document {
    ticket_id: mongoose.Types.ObjectId;
    author_user_id: mongoose.Types.ObjectId;
    author_role: ActorRole;
    content: string;
    visibility: NoteVisibility;
    is_system_note: boolean;
    visible_to_user_ids: mongoose.Types.ObjectId[]; // Explicit visibility list for private notes
    created_at: Date;
}

const TicketNoteSchema = new Schema<ITicketNote>({
    ticket_id: {
        type: Schema.Types.ObjectId,
        ref: 'Ticket',
        required: true,
        index: true
    },
    author_user_id: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    author_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES,
        required: true
    },
    content: {
        type: String,
        required: true,
        maxlength: 5000
    },
    visibility: {
        type: String,
        enum: NOTE_VISIBILITY_VALUES,
        required: true,
        default: NoteVisibility.PUBLIC
    },
    is_system_note: {
        type: Boolean,
        default: false
    },
    visible_to_user_ids: [{
        type: Schema.Types.ObjectId,
        ref: 'User'
    }]
}, {
    timestamps: { createdAt: 'created_at', updatedAt: false } // Append-only
});

// Chronological retrieval of notes for a ticket
TicketNoteSchema.index({ ticket_id: 1, created_at: 1 });

// Visibility filtering
TicketNoteSchema.index({ ticket_id: 1, visibility: 1 });

// System notes filtering
TicketNoteSchema.index({ ticket_id: 1, is_system_note: 1 });

// APPEND-ONLY ENFORCEMENT: Prevent updates and deletes
TicketNoteSchema.pre('updateOne', function (next) {
    next(new Error('Ticket notes cannot be updated'));
});

TicketNoteSchema.pre('updateMany', function (next) {
    next(new Error('Ticket notes cannot be updated'));
});

TicketNoteSchema.pre('findOneAndUpdate', function (next) {
    next(new Error('Ticket notes cannot be updated'));
});

TicketNoteSchema.pre('deleteOne', function (next) {
    next(new Error('Ticket notes cannot be deleted'));
});

TicketNoteSchema.pre('deleteMany', function (next) {
    next(new Error('Ticket notes cannot be deleted'));
});

export const TicketNoteModel = mongoose.model<ITicketNote>('TicketNote', TicketNoteSchema);
