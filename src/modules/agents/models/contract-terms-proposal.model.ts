import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ContractTermsParty } from './agent-agency-membership.model';

/**
 * ContractTermsProposal — a proposed change to the terms of a contract that is
 * ALREADY LIVE.
 *
 * ── Why this exists at all, and why only for live contracts ──────────────────
 *
 * Formation and amendment look alike and are not the same operation. A
 * `pending` contract IS the proposal: its terms are written straight onto the
 * document, a counter overwrites them and flips `terms_proposed_by`, and
 * nothing is at risk because no work has been done under them. An `active`
 * contract HAS a proposal: there is an agreed set of terms that deliveries are
 * being priced by right now, and that set must keep applying until the other
 * party agrees to replace it.
 *
 * So a live amendment is written HERE, never onto the contract. `fee_split` on
 * the contract remains the agreed number for the whole time a proposal is
 * open, which is what lets EarningsQuoteService keep dividing by it without
 * knowing this model exists. The contract is only touched at the moment a
 * proposal is accepted.
 *
 * Do not "unify" this with the pending-contract path. Routing formation
 * through proposal rows too is possible, but it costs a join to render a
 * pending contract's own terms and an extra write inside the approval
 * transaction, for a uniformity nothing needs.
 *
 * ── Why not ContractStatusRequest ────────────────────────────────────────────
 *
 * That model is about STATUS, structurally: `target_status` and `from_status`
 * are required and have no honest value for a terms amendment, and its
 * transition enum keys five exhaustive tables in the service. A terms change is
 * not a transition; the contract stays `active` throughout.
 *
 * ── Why not a sub-document on the contract ───────────────────────────────────
 *
 * No history. A rejected proposal would be overwritten and gone, and a counter
 * chain would be unreconstructible — on the one document where the terms of an
 * agent's pay live. An append-only row per proposal keeps the whole
 * negotiation, and `supersedes_id` keeps its order.
 */

export type TermsProposalState = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'superseded';

/**
 * A partial set of negotiated term groups. Deliberately loose (`Mixed` in the
 * schema): the authoritative shape is the Zod validator, and freezing a copy of
 * it here would be a second definition to keep in step. Only the groups in
 * NEGOTIABLE_TERM_GROUPS ever reach this field — the service rejects anything
 * else before persisting.
 */
export type ProposedTerms = Record<string, unknown>;

export interface IContractTermsProposal extends Document {
  contract_id: mongoose.Types.ObjectId;
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;

  proposed_by_role: ContractTermsParty;
  proposed_by_user_id: mongoose.Types.ObjectId | null;

  /**
   * The agreed terms as they stood when this proposal was raised, snapshotted.
   *
   * Load-bearing rather than convenient: it lets the DTO render an honest
   * "before → after" from this single row even after the proposal is resolved
   * and the contract has moved on. Reconstructing it later from the contract
   * would show the CURRENT terms, not the ones the proposer was arguing with.
   */
  terms_before: ProposedTerms;
  proposed_terms: ProposedTerms;

  state: TermsProposalState;
  /** The proposal this one counters, forming the negotiation chain. */
  supersedes_id: mongoose.Types.ObjectId | null;

  note: string | null;
  resolved_by_role: ContractTermsParty | null;
  resolved_by_user_id: mongoose.Types.ObjectId | null;
  resolved_at: Date | null;
  resolution_note: string | null;

  created_at: Date;
  updated_at: Date;
}

const ContractTermsProposalSchema = new Schema<IContractTermsProposal>(
  {
    contract_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENT_AGENCY_CONTRACT, required: true },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },

    proposed_by_role: { type: String, enum: ['agent', 'agency'], required: true },
    proposed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },

    terms_before: { type: Schema.Types.Mixed, default: {} },
    proposed_terms: { type: Schema.Types.Mixed, required: true },

    state: {
      type: String,
      enum: ['pending', 'accepted', 'rejected', 'withdrawn', 'superseded'],
      default: 'pending',
      required: true,
    },
    supersedes_id: { type: Schema.Types.ObjectId, ref: MODELS.CONTRACT_TERMS_PROPOSAL, default: null },

    note: { type: String, default: null, trim: true },
    resolved_by_role: { type: String, enum: ['agent', 'agency', null], default: null },
    resolved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    resolved_at: { type: Date, default: null },
    resolution_note: { type: String, default: null, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * At most ONE open proposal per contract.
 *
 * Stricter than ContractStatusRequest's (contract, transition) pair, and
 * deliberately so: two open status requests can be a genuine disagreement the
 * parties resolve separately ("you propose suspend, I propose deactivate"), but
 * two open terms proposals are one negotiation with two heads — accepting both
 * would apply two conflicting fee splits in an order nobody chose. A counter
 * supersedes rather than adds, which is what keeps this index satisfiable.
 */
ContractTermsProposalSchema.index(
  { contract_id: 1 },
  { unique: true, partialFilterExpression: { state: 'pending' } }
);

/** Inbox queries: "what needs my decision?" */
ContractTermsProposalSchema.index({ agency_id: 1, state: 1, created_at: -1 });
ContractTermsProposalSchema.index({ agent_id: 1, state: 1, created_at: -1 });
/** One contract's negotiation trail, newest first. */
ContractTermsProposalSchema.index({ contract_id: 1, created_at: -1 });

export const ContractTermsProposalModel = mongoose.model<IContractTermsProposal>(
  MODELS.CONTRACT_TERMS_PROPOSAL,
  ContractTermsProposalSchema,
  COLLECTIONS.CONTRACT_TERMS_PROPOSAL
);
