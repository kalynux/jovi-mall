import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * AgentDeposit - a cash hand-over from an agent to their agency, recorded by
 * the AGENCY at the moment it physically receives the cash (single-step:
 * recording IS the confirmation — the agency is the receiving party).
 *
 * Recording a deposit lowers the agent's cash liability by `amount`. It does
 * NOT touch the agency's liability to the platform — that only falls when an
 * admin confirms an AgencyRemittance. Append-only: a wrong deposit is fixed
 * by an admin cash adjustment, never by editing history.
 */
export interface IAgentDeposit extends Document {
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  /** Cash actually received (minor units). May be less than the agent held. */
  amount: number;
  currency: string;
  note: string | null;
  recorded_by_user_id: mongoose.Types.ObjectId;
  created_at: Date;
}

const AgentDepositSchema = new Schema<IAgentDeposit>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    recorded_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

AgentDepositSchema.index({ agency_id: 1, created_at: -1 });
AgentDepositSchema.index({ agent_id: 1, created_at: -1 });

export const AgentDepositModel = mongoose.model<IAgentDeposit>(
  MODELS.AGENT_DEPOSIT,
  AgentDepositSchema,
  COLLECTIONS.AGENT_DEPOSIT
);
