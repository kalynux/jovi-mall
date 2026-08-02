import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { MembershipStatus } from './agent-agency-membership.model';

/**
 * AgentMembershipEvent — append-only history of every membership transition.
 *
 * The membership row carries only the CURRENT state plus its latest stamps;
 * this collection is what answers "when was he suspended, by whom, and why —
 * the first time?". Suspend → reinstate → suspend overwrites the stamps on the
 * membership but appends here, so the record survives.
 *
 * Append-only by contract: the repository exposes no update or delete. Do not
 * add one. Correcting history means appending a correcting event, and a
 * soft-delete filter has no business on an audit trail.
 */

export type MembershipEventType =
  /** An agency raised a contract request against a specific agent. */
  | 'invited'
  /**
   * Legacy email-invite trail. No longer emitted — the invite subsystem was
   * replaced by the directory + request handshake — but kept in the enum
   * because historical rows still carry these values and this is an
   * append-only log.
   */
  | 'invite_accepted'
  | 'invite_declined'
  | 'invite_revoked'
  | 'join_requested'
  | 'approved'
  | 'request_declined'
  /** The party that raised a pending contract pulled it back. */
  | 'withdrawn'
  | 'suspended'
  | 'paused'
  | 'reinstated'
  | 'removed'
  | 'transferred_out'
  | 'transferred_in'
  | 'primary_changed'
  | 'employment_updated'
  /** Any negotiated term other than employment or the COD threshold. */
  | 'terms_updated'
  | 'cod_limit_changed';

export interface IAgentMembershipEvent extends Document {
  membership_id: mongoose.Types.ObjectId | null;
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  type: MembershipEventType;
  /** null when the event did not move the state machine (e.g. cod_limit_changed). */
  from_status: MembershipStatus | null;
  to_status: MembershipStatus | null;
  actor_user_id: mongoose.Types.ObjectId | null;
  /** 'agent' | 'agency' | 'admin' | 'system' */
  actor_role: string;
  reason: string | null;
  /** Event-specific extras (e.g. transfer counterpart agency, old/new limit). */
  metadata: Record<string, unknown> | null;
  occurred_at: Date;
  created_at: Date;
}

const AgentMembershipEventSchema = new Schema<IAgentMembershipEvent>(
  {
    membership_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.AGENT_AGENCY_CONTRACT,
      default: null,
    },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    type: {
      type: String,
      required: true,
      enum: [
        'invited',
        'invite_accepted',
        'invite_declined',
        'invite_revoked',
        'join_requested',
        'approved',
        'request_declined',
        'withdrawn',
        'suspended',
        'paused',
        'reinstated',
        'removed',
        'transferred_out',
        'transferred_in',
        'primary_changed',
        'employment_updated',
        'terms_updated',
        'cod_limit_changed',
      ],
    },
    from_status: { type: String, default: null },
    to_status: { type: String, default: null },
    actor_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    actor_role: { type: String, required: true },
    reason: { type: String, default: null, trim: true },
    metadata: { type: Schema.Types.Mixed, default: null },
    occurred_at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

/** Agent-scoped history feed, newest first. */
AgentMembershipEventSchema.index({ agent_id: 1, occurred_at: -1 });
/** Agency-scoped history feed. */
AgentMembershipEventSchema.index({ agency_id: 1, occurred_at: -1 });
/** One membership's full trail. */
AgentMembershipEventSchema.index({ membership_id: 1, occurred_at: 1 });

export const AgentMembershipEventModel = mongoose.model<IAgentMembershipEvent>(
  MODELS.AGENT_MEMBERSHIP_EVENT,
  AgentMembershipEventSchema,
  COLLECTIONS.AGENT_MEMBERSHIP_EVENT
);
