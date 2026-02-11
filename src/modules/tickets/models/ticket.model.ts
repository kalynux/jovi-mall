import mongoose, { Schema, Document } from 'mongoose';
import { BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import {
    TicketType,
    TicketStatus,
    TicketPriority,
    TicketImportance,
    ActorRole,
    EntityType,
    TICKET_TYPE_VALUES,
    TICKET_STATUS_VALUES,
    TICKET_PRIORITY_VALUES,
    TICKET_IMPORTANCE_VALUES,
    ACTOR_ROLE_VALUES,
    ENTITY_TYPE_VALUES
} from '../types/ticket.types';

/**
 * Ticket Model
 * 
 * Core ticketing document for multi-actor communication and workflow management.
 * 
 * DOMAIN RULES:
 * - Polymorphic entity linking via (entity_type, entity_id)
 * - Max 5 distinct non-admin users across lifecycle (tracked in followers)
 * - Importance is immutable after creation
 * - Priority locks forever after admin updates it
 * - Status transitions generate system notes
 * - Admin exclusivity when assigned_admin_id is set
 * 
 * VISIBILITY:
 * - Ticket followers can view details
 * - Admins can view all tickets (unless exclusivity active)
 * - When assigned_admin_id is set, only that admin sees details
 */

export interface ITicket extends Document {
    // Core Fields
    subject: string;
    description: string;
    type: TicketType;
    status: TicketStatus;
    priority: TicketPriority;
    importance: TicketImportance;

    // Priority Locking (admin-controlled)
    priority_locked: boolean;
    priority_locked_by?: mongoose.Types.ObjectId;
    priority_locked_at?: Date;

    // Polymorphic Entity Linking
    entity_type: EntityType;
    entity_id: string;

    // Creator Information
    created_by_role: ActorRole;
    created_by_user_id: mongoose.Types.ObjectId;

    // Assignment
    assigned_to_role?: ActorRole;
    assigned_to_user_id?: mongoose.Types.ObjectId;

    // Admin Exclusivity
    assigned_admin_id?: mongoose.Types.ObjectId; // If set, only this admin can view details

    // Audit Trail
    updated_by: mongoose.Types.ObjectId[]; // All users who modified ticket

    // Soft Delete (from BaseSchemaFields)
    deletedAt?: Date | null;
    purgeAt?: Date | null;

    // Timestamps (auto-managed)
    createdAt: Date;
    updatedAt: Date;
}

const TicketSchema = new Schema<ITicket>({
    subject: {
        type: String,
        required: true,
        maxlength: 200,
        trim: true
    },
    description: {
        type: String,
        required: true,
        maxlength: 10000
    },
    type: {
        type: String,
        enum: TICKET_TYPE_VALUES,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: TICKET_STATUS_VALUES,
        required: true,
        default: TicketStatus.OPEN,
        index: true
    },
    priority: {
        type: String,
        enum: TICKET_PRIORITY_VALUES,
        required: true,
        default: TicketPriority.NORMAL
    },
    importance: {
        type: String,
        enum: TICKET_IMPORTANCE_VALUES,
        required: true,
        immutable: true // Cannot change after creation
    },
    priority_locked: {
        type: Boolean,
        default: false
    },
    priority_locked_by: {
        type: Schema.Types.ObjectId,
        ref: 'User'
    },
    priority_locked_at: {
        type: Date
    },
    entity_type: {
        type: String,
        enum: ENTITY_TYPE_VALUES,
        required: true,
        index: true
    },
    entity_id: {
        type: String,
        required: true,
        index: true
    },
    created_by_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES,
        required: true
    },
    created_by_user_id: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    assigned_to_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES
    },
    assigned_to_user_id: {
        type: Schema.Types.ObjectId,
        ref: 'User'
    },
    assigned_admin_id: {
        type: Schema.Types.ObjectId,
        ref: 'Admin',
        index: true // For admin exclusivity queries
    },
    updated_by: [{
        type: Schema.Types.ObjectId,
        ref: 'User'
    }],
    ...BaseSchemaFields
}, {
    ...BaseSchemaOptions,
    timestamps: true
});

// Compound Indexes for Performance

// Polymorphic entity lookup
TicketSchema.index({ entity_type: 1, entity_id: 1 });

// Status filtering with time ordering
TicketSchema.index({ status: 1, createdAt: -1 });

// Assignment queries
TicketSchema.index({ assigned_to_role: 1, assigned_to_user_id: 1 });

// Creator queries
TicketSchema.index({ created_by_user_id: 1, createdAt: -1 });

// Type filtering
TicketSchema.index({ type: 1, createdAt: -1 });

// Soft delete filtering (from base schema)
// TicketSchema.index({ deletedAt: 1 });

export const TicketModel = mongoose.model<ITicket>('Ticket', TicketSchema);
