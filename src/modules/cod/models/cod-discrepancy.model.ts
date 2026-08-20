import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ActorSource, actorStampFields } from '../../../core/types/actor-source.types';

/**
 * CodDiscrepancy - a flagged problem in the cash chain.
 *
 *  - 'late_deposit'          (system): the agent sat on collected cash past the
 *    deposit deadline (opened by the daily sweep, one open per agent).
 *    Suppressed while an unresolved declaration covers the balance — see
 *    CodDepositDeadlineWorker.
 *  - 'cash_shortfall'        (agency): the agent handed over less than they held.
 *  - 'deposit_not_confirmed' (system): the agent DECLARED a handover and the
 *    agency neither confirmed nor rejected it within the confirm deadline. The
 *    counterpart to 'late_deposit', pointing the other way: this one is the
 *    agency's failure, so it carries no agent trust penalty.
 *  - 'other'                 (agency/admin/agent): anything else worth an audit
 *    trail — including an agent disputing what an agency recorded.
 *
 * Consequences while OPEN:
 *  - any open discrepancy blocks the agency's rolling-reserve releases — which
 *    is the only automatic pressure on an agency to answer a declaration;
 *  - an open 'cash_shortfall' blocks new COD assignments to that agent.
 * Resolution ('resolved' = recovered/explained, 'written_off' = platform ate
 * the loss) is admin-only and append-styled: the row keeps its full history.
 *
 * `raised_by` includes 'agent' deliberately. Without it the cash chain had no
 * way to represent "the agent says this is wrong" — an agency's record of a
 * handover was unfalsifiable, and the agent wore the late-deposit penalty for
 * cash the agency had simply not recorded.
 */

export type CodDiscrepancyType =
  | 'late_deposit'
  | 'cash_shortfall'
  | 'deposit_not_confirmed'
  | 'other';
export type CodDiscrepancyStatus = 'open' | 'resolved' | 'written_off';

export interface ICodDiscrepancy extends Document {
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  type: CodDiscrepancyType;
  /** Money at stake (minor units); null for non-monetary flags. */
  amount: number | null;
  currency: string;
  status: CodDiscrepancyStatus;
  raised_by: 'system' | 'agency' | 'admin' | 'agent';
  raised_by_user_id: mongoose.Types.ObjectId | null;
  /** The deposit at issue — set for 'deposit_not_confirmed' and agent disputes. */
  deposit_id: mongoose.Types.ObjectId | null;
  note: string | null;
  resolution_note: string | null;
  resolved_by_user_id: mongoose.Types.ObjectId | null;
  resolved_by_source: ActorSource;
  resolved_by_name: string | null;
  opened_at: Date;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const CodDiscrepancySchema = new Schema<ICodDiscrepancy>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    type: {
      type: String,
      enum: ['late_deposit', 'cash_shortfall', 'deposit_not_confirmed', 'other'],
      required: true,
    },
    amount: { type: Number, default: null, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, enum: ['open', 'resolved', 'written_off'], required: true, default: 'open' },
    raised_by: { type: String, enum: ['system', 'agency', 'admin', 'agent'], required: true },
    raised_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    deposit_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENT_DEPOSIT, default: null },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    resolution_note: { type: String, default: null, trim: true, maxlength: 500 },
    resolved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    /**
     * Resolving a discrepancy is an **admin-only** act — there is no agency or agent path
     * to it — so this id is a wi-admin one on every write since the split, and it resolves
     * in neither this database's `users` nor anywhere a reader can reach. It was the last
     * actor field on the platform still stamped bare (J7, Phase 4 step 22).
     *
     * Note `raised_by` above is a different question and needs no companion: it is a
     * four-value enum naming WHAT KIND of actor opened the flag, and `raised_by_user_id`
     * beside it is `system`/`agency`/`agent` in practice — all of which resolve here.
     */
    ...actorStampFields('resolved_by'),
    opened_at: { type: Date, required: true, default: () => new Date() },
    resolved_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

/**
 * At most ONE open late-deposit flag per CONTRACT — i.e. per (agent, agency).
 *
 * It was per agent, globally, which stopped working once each contract got its
 * own remittance cadence. An agent can be perfectly on time with agency A and a
 * week late with agency B, and the two are separate creditors with separate
 * recourse; one row can only name one `agency_id`, so a global flag silently
 * left every agency but the first uninformed that they were owed.
 *
 * The TRUST PENALTY stays agent-global and applied once, in
 * CodDiscrepancyService.openLateDeposit — see the note there. Scoping the flag
 * per contract without scoping the penalty is the point: four agencies must
 * each learn they are owed, and the agent must not take four penalties for one
 * bad week.
 *
 * ⚠️ MIGRATION: the old `{ agent_id, type }` unique index must be DROPPED
 * explicitly. `autoIndex` creates but never drops, and a failed build is
 * silent at boot. See scripts/migrate-cod-late-deposit-index.ts.
 */
CodDiscrepancySchema.index(
  { agent_id: 1, agency_id: 1, type: 1 },
  { unique: true, partialFilterExpression: { status: 'open', type: 'late_deposit' } }
);
// ...and at most ONE unconfirmed-declaration flag per deposit. Keyed by deposit
// rather than by agent: an agency can be sitting on several declarations at
// once, and each is a separate thing to answer.
CodDiscrepancySchema.index(
  { deposit_id: 1 },
  { unique: true, partialFilterExpression: { status: 'open', type: 'deposit_not_confirmed' } }
);
CodDiscrepancySchema.index({ agency_id: 1, status: 1, created_at: -1 });
CodDiscrepancySchema.index({ status: 1, created_at: -1 });

export const CodDiscrepancyModel = mongoose.model<ICodDiscrepancy>(
  MODELS.COD_DISCREPANCY,
  CodDiscrepancySchema,
  COLLECTIONS.COD_DISCREPANCY
);
