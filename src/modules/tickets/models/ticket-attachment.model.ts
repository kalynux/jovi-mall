import mongoose, { Schema, Document } from 'mongoose';
import { ActorRole, ACTOR_ROLE_VALUES } from '../types/ticket.types';

/**
 * TicketAttachment Model
 * 
 * File attachments for tickets.
 * 
 * DOMAIN RULES:
 * - Max 5 files per ticket (enforced in service layer)
 * - Only admins can delete attachments
 * - Files are immutable after upload
 * - Files inherit note-level visibility rules
 * - Uses storage factory pattern
 * 
 * FILE METADATA:
 * - file_id: Reference to File model (contains key, provider, etc.)
 * - file_name: Original file name (denormalized for convenience)
 * - file_size: Size in bytes (denormalized for convenience)
 * - mime_type: MIME type for validation (denormalized for convenience)
 */

export interface ITicketAttachment extends Document {
    ticket_id: mongoose.Types.ObjectId;
    uploaded_by_user_id: mongoose.Types.ObjectId;
    uploaded_by_role: ActorRole;
    file_id: mongoose.Types.ObjectId; // Reference to File model
    file_name: string;
    file_size: number;
    mime_type: string;
    created_at: Date;
}

const TicketAttachmentSchema = new Schema<ITicketAttachment>({
    ticket_id: {
        type: Schema.Types.ObjectId,
        ref: 'Ticket',
        required: true,
        index: true
    },
    uploaded_by_user_id: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    uploaded_by_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES,
        required: true
    },
    file_id: {
        type: Schema.Types.ObjectId,
        ref: 'File',
        required: true
    },
    file_name: {
        type: String,
        required: true,
        maxlength: 255
    },
    file_size: {
        type: Number,
        required: true
    },
    mime_type: {
        type: String,
        required: true
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: false } // Immutable after upload
});

// Chronological retrieval of attachments for a ticket
TicketAttachmentSchema.index({ ticket_id: 1, created_at: 1 });

export const TicketAttachmentModel = mongoose.model<ITicketAttachment>('TicketAttachment', TicketAttachmentSchema);
