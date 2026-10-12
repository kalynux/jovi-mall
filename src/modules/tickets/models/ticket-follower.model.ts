import mongoose, { Schema, Document } from 'mongoose';
import { ActorRole, ACTOR_ROLE_VALUES } from '../types/ticket.types';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * TicketFollower Model
 * 
 * Junction table for many-to-many relationship between tickets and users.
 * 
 * DOMAIN RULES:
 * - Creator auto-added as follower on ticket creation
 * - Assignee auto-added as follower when assigned
 * - Max 5 non-admin users per ticket (enforced in service layer)
 * - Admins never count toward the 5-user limit
 * - Order parties and administrator-added followers never count either (see below)
 * - Admins cannot be removed as followers
 * - Creator cannot be removed
 * - Current assignee cannot be removed
 *
 * VISIBILITY:
 * - Followers can view ticket details
 * - Followers can see notes based on note visibility rules
 *
 * ORDER PARTIES (owner decision 2026-10-09):
 * - A ticket about an order — an ORDER ticket, or a SHIPMENT ticket through its order — is
 *   followed automatically by the order's vendor and by every agency and agent on its
 *   shipments: at creation, on reopen, after an agent accepts, and after items move to
 *   another agency. See `TicketOrderPartiesService`.
 * - Those rows (`source: 'order_party'`) and every row an administrator adds
 *   (`source: 'admin'`) do NOT count toward the 5-user limit. One order can span several
 *   agencies and agents plus reassignments, so the limit would otherwise refuse the very
 *   parties the ticket is about.
 */

/**
 * Why a follower row exists. Rows written before 2026-10-09 carry no `source` and are treated
 * as counting toward the limit — which is what every one of them did when it was written.
 */
export const TICKET_FOLLOWER_SOURCES = ['creator', 'assignee', 'order_party', 'admin'] as const;
export type TicketFollowerSource = typeof TICKET_FOLLOWER_SOURCES[number];

/** The sources that never count toward the 5-non-admin-user limit. */
export const CAP_EXEMPT_FOLLOWER_SOURCES: ReadonlyArray<TicketFollowerSource> = ['order_party', 'admin'];

export interface ITicketFollower extends Document {
    ticket_id: mongoose.Types.ObjectId;
    user_id: mongoose.Types.ObjectId;
    role: ActorRole;
    is_admin: boolean; // Cached for performance (5-user limit queries)
    /** Absent on rows written before 2026-10-09 — see `TICKET_FOLLOWER_SOURCES`. */
    source?: TicketFollowerSource;
    added_by_user_id: mongoose.Types.ObjectId;
    added_at: Date;
}

const TicketFollowerSchema = new Schema<ITicketFollower>({
    ticket_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.TICKET,
        required: true,
        index: true
    },
    user_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.USER,
        required: true,
        index: true
    },
    role: {
        type: String,
        enum: ACTOR_ROLE_VALUES,
        required: true
    },
    is_admin: {
        type: Boolean,
        default: false,
        index: true // For 5-user limit queries
    },
    source: {
        type: String,
        enum: TICKET_FOLLOWER_SOURCES,
        // No default: absent is the honest marker of a pre-2026-10-09 row.
    },
    added_by_user_id: {
        type: Schema.Types.ObjectId,
        ref: MODELS.USER,
        required: true
    },
    added_at: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: false
});

// Unique constraint: One user can only follow a ticket once
TicketFollowerSchema.index({ ticket_id: 1, user_id: 1 }, { unique: true });

// Query all followers for a ticket
TicketFollowerSchema.index({ ticket_id: 1, added_at: 1 });

// Query non-admin followers (for 5-user limit enforcement)
TicketFollowerSchema.index({ ticket_id: 1, is_admin: 1 });

export const TicketFollowerModel = mongoose.model<ITicketFollower>(MODELS.TICKET_FOLLOWER, TicketFollowerSchema, COLLECTIONS.TICKET_FOLLOWER);
