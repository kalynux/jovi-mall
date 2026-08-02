import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ContractStatus } from './agent-agency-membership.model';

/**
 * ContractStatusRequest — a proposed change to a contract's status.
 *
 * §4's rule: "any status change is itself a conditional action — it can be
 * approved or rejected, not an unconditional write". So every transition is
 * modelled as a request that must be cleared, rather than a direct mutation.
 *
 * ── Who may clear what ──────────────────────────────────────────────────────
 *
 * Not every transition needs the counterparty's consent, and pretending
 * otherwise produces absurdities — an agency suspending an agent for cash
 * shortfalls cannot require that agent to approve their own suspension. The
 * authority matrix lives in CONTRACT_TRANSITION_POLICY (see the service), and a
 * request whose initiator holds unilateral authority is auto-approved inside
 * the same transaction, still leaving a full request + history trail.
 *
 * Requests that need clearance stay `pending` until the counterparty resolves
 * them — or, for deactivation, until the §4 conditions (COD returned, agent
 * paid) are met and someone retries. The conditions are re-checked at approval
 * time, never trusted from when the request was raised.
 */

export type ContractTransition =
  | 'approve'
  | 'reject'
  | 'withdraw'
  | 'pause'
  | 'suspend'
  | 'reactivate'
  | 'deactivate';

export type StatusRequestState = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Who raised or resolved the request. */
export type ContractParty = 'agent' | 'agency' | 'admin' | 'system';

export interface IContractStatusRequest extends Document {
  contract_id: mongoose.Types.ObjectId;
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;

  transition: ContractTransition;
  /** The status the contract would land in if this request is approved. */
  target_status: ContractStatus;
  /** The contract's status when the request was raised — staleness detection. */
  from_status: ContractStatus;

  state: StatusRequestState;
  requested_by_role: ContractParty;
  requested_by_user_id: mongoose.Types.ObjectId | null;
  reason: string | null;

  resolved_by_role: ContractParty | null;
  resolved_by_user_id: mongoose.Types.ObjectId | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  /**
   * Why a pending deactivation cannot proceed yet, refreshed on each attempt:
   * e.g. { outstandingCod: 50000, outstandingPayment: 0 }. Lets the UI explain
   * "waiting on cash return" without re-deriving the rule.
   */
  blocking_conditions: Record<string, unknown> | null;
  /** True when the initiator had unilateral authority and it self-cleared. */
  auto_approved: boolean;

  created_at: Date;
  updated_at: Date;
}

const ContractStatusRequestSchema = new Schema<IContractStatusRequest>(
  {
    contract_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENT_AGENCY_CONTRACT, required: true },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },

    transition: {
      type: String,
      enum: ['approve', 'reject', 'withdraw', 'pause', 'suspend', 'reactivate', 'deactivate'],
      required: true,
    },
    target_status: {
      type: String,
      enum: ['pending', 'rejected', 'withdrawn', 'active', 'paused', 'suspended', 'deactivated'],
      required: true,
    },
    from_status: {
      type: String,
      enum: ['pending', 'rejected', 'withdrawn', 'active', 'paused', 'suspended', 'deactivated'],
      required: true,
    },

    state: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      required: true,
    },
    requested_by_role: { type: String, enum: ['agent', 'agency', 'admin', 'system'], required: true },
    requested_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    reason: { type: String, default: null, trim: true },

    resolved_by_role: { type: String, enum: ['agent', 'agency', 'admin', 'system'], default: null },
    resolved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    resolved_at: { type: Date, default: null },
    resolution_note: { type: String, default: null, trim: true },
    blocking_conditions: { type: Schema.Types.Mixed, default: null },
    auto_approved: { type: Boolean, default: false, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * At most one OPEN request per (contract, transition). Two simultaneous
 * "deactivate" proposals on the same contract are one intent, not two, and
 * letting both exist means resolving one leaves a phantom pending behind.
 * Different transitions may be open concurrently (an agency could propose
 * suspend while the agent proposes deactivate) — that is a real disagreement
 * the parties resolve, not a data error.
 */
ContractStatusRequestSchema.index(
  { contract_id: 1, transition: 1 },
  { unique: true, partialFilterExpression: { state: 'pending' } }
);

/** Inbox queries: "what needs my decision?" */
ContractStatusRequestSchema.index({ agency_id: 1, state: 1, created_at: -1 });
ContractStatusRequestSchema.index({ agent_id: 1, state: 1, created_at: -1 });
/** One contract's request trail. */
ContractStatusRequestSchema.index({ contract_id: 1, created_at: -1 });

export const ContractStatusRequestModel = mongoose.model<IContractStatusRequest>(
  MODELS.CONTRACT_STATUS_REQUEST,
  ContractStatusRequestSchema,
  COLLECTIONS.CONTRACT_STATUS_REQUEST
);
