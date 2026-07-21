import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * AgentDeposit - an agent handing collected COD cash back, under exactly one
 * contract.
 *
 * ── Who it goes to (`recipient`) ────────────────────────────────────────────
 *
 *  - 'agency'   — the normal route. Lowers the agent's cash liability and draws
 *    down the contract's outstanding balance. The AGENCY's liability to the
 *    platform is untouched; that falls only when an admin confirms an
 *    AgencyRemittance.
 *  - 'platform' — the agent paid the platform directly, bypassing the agency.
 *    Does everything the agency route does AND what a confirmed remittance
 *    does: the agency's liability falls too and the cash is FIFO-applied to
 *    that agency's collections. One event, both legs — because the cash
 *    physically skipped the middle one.
 *
 * ── How it is proven (`status`) ─────────────────────────────────────────────
 *
 * Two-step, mirroring AgencyRemittance: someone DECLARES the handover and the
 * RECEIVING party confirms it. Only a `confirmed` deposit moves money; a
 * declaration is just a timestamped claim, so an agent cannot free their own
 * headroom by declaring.
 *
 * The agency may still record a receipt in ONE step (declare+confirm together)
 * — it is the receiving party, so its own record needs no counter-signature,
 * and an agent without the app in hand must still be able to hand cash over.
 * What changed is that this is no longer the ONLY way a deposit can exist: an
 * agent can now declare one the agency has to answer, which is what gives them
 * evidence when an agency under-records or ignores a handover.
 *
 * `agency_id` is always set, including for platform deposits — the cash is
 * always collected under one contract, and that contract is what gets drawn
 * down. "Which agency was this for" is not optional.
 *
 * Append-only in spirit: status moves declared → confirmed | rejected once, and
 * amounts are immutable. A wrong CONFIRMED deposit is fixed by an admin cash
 * adjustment, never by editing history.
 */

export type AgentDepositStatus = 'declared' | 'confirmed' | 'rejected';
export type AgentDepositRecipient = 'agency' | 'platform';

export interface IAgentDeposit extends Document {
  agent_id: mongoose.Types.ObjectId;
  /** The contract this cash was collected under. Always set. */
  agency_id: mongoose.Types.ObjectId;
  /** Cash actually handed over (minor units). May be less than the agent held. */
  amount: number;
  currency: string;
  note: string | null;

  recipient: AgentDepositRecipient;
  status: AgentDepositStatus;

  /**
   * External money-movement reference (bank/transfer/receipt id). Required for
   * `recipient: 'platform'` — the platform is not physically present at the
   * handover, so the reference is the only thing tying the claim to real money.
   */
  reference: string | null;

  /** The agent's user, when THEY declared it; null when the agency recorded it. */
  declared_by_user_id: mongoose.Types.ObjectId | null;
  declared_at: Date | null;

  /** Who confirmed receipt — an agency user, or an admin for platform deposits. */
  recorded_by_user_id: mongoose.Types.ObjectId | null;
  resolved_at: Date | null;
  rejection_reason: string | null;

  created_at: Date;
  updated_at: Date;
}

const AgentDepositSchema = new Schema<IAgentDeposit>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    note: { type: String, default: null, trim: true, maxlength: 500 },

    // Defaults describe the pre-existing world: every row written before this
    // existed was an agency recording a receipt it had already taken. They are
    // BACKFILLED by scripts/migrate-agent-deposits.ts rather than left to the
    // schema default — a default only applies on hydration, so a query filtering
    // `status: 'confirmed'` would silently miss every legacy row.
    recipient: { type: String, enum: ['agency', 'platform'], required: true, default: 'agency' },
    status: {
      type: String,
      enum: ['declared', 'confirmed', 'rejected'],
      required: true,
      default: 'confirmed',
    },

    reference: { type: String, default: null, trim: true, maxlength: 200 },

    declared_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    declared_at: { type: Date, default: null },

    recorded_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    resolved_at: { type: Date, default: null },
    rejection_reason: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AgentDepositSchema.index({ agency_id: 1, created_at: -1 });
AgentDepositSchema.index({ agent_id: 1, created_at: -1 });
// The agency's inbox, and the sweep's scan for declarations nobody answered.
AgentDepositSchema.index({ status: 1, recipient: 1, declared_at: 1 });
// Suppression check: what has this agent declared that is still open?
AgentDepositSchema.index({ agent_id: 1, status: 1 });

export const AgentDepositModel = mongoose.model<IAgentDeposit>(
  MODELS.AGENT_DEPOSIT,
  AgentDepositSchema,
  COLLECTIONS.AGENT_DEPOSIT
);
