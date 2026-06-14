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
 * - Admins cannot be removed as followers
 * - Creator cannot be removed
 * - Current assignee cannot be removed
 * 
 * VISIBILITY:
 * - Followers can view ticket details
 * - Followers can see notes based on note visibility rules
 */

export interface ITicketFollower extends Document {
    ticket_id: mongoose.Types.ObjectId;
    user_id: mongoose.Types.ObjectId;
    role: ActorRole;
    is_admin: boolean; // Cached for performance (5-user limit queries)
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
