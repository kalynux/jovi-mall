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
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { AdminSnapshotSchema, IAdminSnapshot } from '../../../core/types/admin-snapshot.types';

/**
 * Who holds a ticket on the wi-admin side, and who gave it to them.
 *
 * Exported so the repository, the enrichment service and the internal router share one
 * shape rather than three structural copies of it.
 */
export interface IAdminAssignment {
    admin: IAdminSnapshot;
    /** Null when the ticket was claimed from the pool rather than handed over. */
    assigned_by: IAdminSnapshot | null;
    assigned_at: Date;
}

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
 * - Administrators reach tickets through wi-admin only, and what they may see is decided
 *   there by tier (`resolveScope('tickets')`), never by a lock on the row. The old
 *   "first admin to touch it owns it" exclusivity is gone — see `admin_assignment`.
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

    // Optional carrier tracking number captured at creation (ORDER tickets).
    // Null when the related order is not yet dispatched / no number was given.
    tracking_number?: string | null;

    // Creator Information
    created_by_role: ActorRole;
    created_by_user_id: mongoose.Types.ObjectId;

    /**
     * Set only when an administrator opened the ticket on somebody's behalf.
     *
     * Same reason as `admin_assignment`, on the other end of the ticket: `created_by_user_id`
     * holds a wi-admin id when `created_by_role` is `admin`, and that id resolves to nothing
     * here — so "who opened this" would render as a placeholder to the very customer the
     * ticket was opened for. Null for every ticket a platform actor raised, which is most of
     * them, and null for the system tickets the payout, dispute and booking-refund paths
     * raise.
     */
    created_by_admin?: IAdminSnapshot | null;

    // Assignment
    assigned_to_role?: ActorRole;
    assigned_to_user_id?: mongoose.Types.ObjectId;

    /**
     * The wi-admin administrator holding this ticket, and who gave it to them (Phase 17).
     *
     * ── What this REPLACED, and why it is not a rename ────────────────────────
     * `assigned_admin_id` used to live here, and it was never an assignment: it was an
     * **exclusivity lock**. `setActiveAdminIfNotSet` stamped it on an admin's FIRST ACTION on
     * any ticket, and `validateActiveAdminPermission` then answered 403 to every other admin —
     * Developers included. So a Support administrator merely opening a ticket locked a
     * Developer out of it, which is the exact opposite of the tier model wi-admin enforces
     * (tier 1 sees everything). The column, the lock and the whole `/api/admin/tickets` mount
     * that depended on it are gone; that mount could not have enforced the tier rules anyway,
     * because a legacy admin is a platform `users` row and carries no tier.
     *
     * ── Why the profile is copied rather than referenced ──────────────────────
     * Administrators live in the wi-admin database. `resolveAdmins()` queries `admins` HERE,
     * so a wi-admin id resolves to nothing and every ticket read by the customer, vendor,
     * agency or agent renders `assigned_admin: null`. A cross-database join is not available
     * at any price. See `core/types/admin-snapshot.types.ts`.
     *
     * ── The two halves answer different questions ─────────────────────────────
     * `admin` is who holds it. `assigned_by` is who put it there — needed because the tier
     * rules key on the ASSIGNER: a Tier 2 may not hand a ticket a Tier 1 gave them back to a
     * Tier 1. Without this stamp that rule is unenforceable.
     *
     * Null means unassigned, which is a real state rather than a missing value: the system
     * tickets raised by the payout, dispute and booking-refund paths land in the admin POOL,
     * and any tier may claim from it.
     */
    admin_assignment?: IAdminAssignment | null;

    // Audit Trail
    updated_by: mongoose.Types.ObjectId[]; // All users who modified ticket

    /**
     * When the ticket entered a terminal status (resolved/closed). Set on the
     * transition into a terminal state and cleared when reopened. Unlike
     * updatedAt (bumped by any edit), this is a stable clock for the
     * attachment-cleanup grace period. See file-cleanup module.
     */
    terminalAt?: Date | null;

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
        maxlength: 700
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
        ref: MODELS.USER
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
    tracking_number: {
        type: String,
        default: null,
        trim: true
    },
    created_by_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES,
        required: true
    },
    created_by_user_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.USER,
        required: true,
        index: true
    },
    assigned_to_role: {
        type: String,
        enum: ACTOR_ROLE_VALUES
    },
    assigned_to_user_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.USER
    },
    created_by_admin: {
        type: AdminSnapshotSchema,
        default: null,
    },
    admin_assignment: {
        type: new Schema<IAdminAssignment>({
            admin: { type: AdminSnapshotSchema, required: true },
            assigned_by: { type: AdminSnapshotSchema, default: null },
            assigned_at: { type: Date, required: true },
        }, { _id: false }),
        default: null,
    },
    updated_by: [{
        type: Schema.Types.ObjectId,
        ref: MODELS.USER
    }],
    terminalAt: {
        type: Date,
        default: null
    },
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

// Terminal-status attachment cleanup sweep (file-cleanup module)
TicketSchema.index({ status: 1, terminalAt: 1 });

// Assignment queries
TicketSchema.index({ assigned_to_role: 1, assigned_to_user_id: 1 });

/**
 * The wi-admin read scope, which is a QUERY rather than a controller check.
 *
 * Support asks for "assigned to me, or unassigned"; an Admin asks for "assigned to me, to a
 * Tier 3, or unassigned". Both are filters on this block, sorted newest-first like every
 * other ticket list — so both indexes carry `createdAt` to serve the sort from the index
 * rather than in memory.
 *
 * Sparse on the id: an unassigned ticket is a normal, common state (every system ticket
 * starts there), and indexing thousands of nulls buys nothing. The `tier` index is NOT
 * sparse — "held by a Tier 3" and "held by nobody" are both answers an Admin's query needs,
 * and a sparse index cannot serve the second.
 */
TicketSchema.index({ 'admin_assignment.admin.id': 1, createdAt: -1 }, { sparse: true });
TicketSchema.index({ 'admin_assignment.admin.tier': 1, createdAt: -1 });

// Creator queries
TicketSchema.index({ created_by_user_id: 1, createdAt: -1 });

// Type filtering
TicketSchema.index({ type: 1, createdAt: -1 });

// Soft delete filtering (from base schema)
// TicketSchema.index({ deletedAt: 1 });

export const TicketModel = mongoose.model<ITicket>(MODELS.TICKET, TicketSchema, COLLECTIONS.TICKET);
