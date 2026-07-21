import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * AgentInvite — an agency's invitation for a delivery agent to join its roster.
 *
 * Agents self-signup independently (see auth module). This is one of the two
 * consensual paths into an agency: the agency invites an email, and the agent
 * accepts (creating an APPROVED AgentAgencyMembership) or declines. The agency
 * may revoke a pending invite. The other path is the agent's own join request,
 * which lands as a PENDING membership for the agency to approve.
 *
 * An agent may belong to several agencies at once, so accepting is guarded by
 * the membership rules (no duplicate live membership, and the per-agent agency
 * cap) rather than by a single-agency check. The invite itself only records
 * that the offer was made.
 */

export type AgentInviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked';

export interface IAgentInvite extends Document {
  agency_id: mongoose.Types.ObjectId;
  /** Invited agent's email (lowercased) — matched against DeliveryAgent.email. */
  email: string;
  status: AgentInviteStatus;
  invited_by_user_id: mongoose.Types.ObjectId;
  /** Set when the invite leaves 'pending' (accept/decline/revoke). */
  responded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const AgentInviteSchema = new Schema<IAgentInvite>(
  {
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'revoked'],
      required: true,
      default: 'pending',
    },
    invited_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    responded_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// At most one OPEN invite per (agency, email); resolved invites stay as history.
AgentInviteSchema.index(
  { agency_id: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
// Agent-side inbox lookup.
AgentInviteSchema.index({ email: 1, status: 1, created_at: -1 });

export const AgentInviteModel = mongoose.model<IAgentInvite>(
  MODELS.AGENT_INVITE,
  AgentInviteSchema,
  COLLECTIONS.AGENT_INVITE
);
