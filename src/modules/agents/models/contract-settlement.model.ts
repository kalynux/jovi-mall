import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * ContractSettlement — an append-only record of money moving between an agent
 * and an agency under one contract.
 *
 * Two directions, deliberately in one collection because they are the two
 * halves of the same relationship and §4 gates termination on BOTH reaching
 * zero — querying one collection to answer "is this contract clear?" is the
 * point.
 *
 *   `cod_remittance`   agent → agency. The agent hands back collected COD cash.
 *                      Decrements contract.cod.outstanding_balance. This is the
 *                      mechanism by which allocated COD headroom is released;
 *                      without it, an agent's pool fills up and never drains.
 *
 *   `agent_payment`    agency → agent. The agency pays the agent for work done.
 *                      Decrements contract.payment.outstanding_to_agent and
 *                      debits the agent's earnings account.
 *
 * Append-only by contract: the repository exposes no update or delete. A
 * correcting entry is a new row (`reversal`), never an edit — a settlement
 * ledger that can be rewritten is not evidence.
 */

export type SettlementType = 'cod_remittance' | 'agent_payment' | 'reversal';

export type SettlementDirection = 'agent_to_agency' | 'agency_to_agent';

export interface IContractSettlement extends Document {
  contract_id: mongoose.Types.ObjectId;
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;

  type: SettlementType;
  direction: SettlementDirection;
  /** Minor units. Always positive; `direction` carries the sign. */
  amount: number;
  currency: string;

  /** Balance on this contract after the settlement applied — audit anchor. */
  balance_after: number;

  /** Whether the amount matched what was expected (feeds the trust signal). */
  had_discrepancy: boolean;
  discrepancy_amount: number | null;

  /** Late relative to the contract's remittance cadence + grace (trust signal). */
  was_late: boolean;

  recorded_by_role: 'agent' | 'agency' | 'admin' | 'system';
  recorded_by_user_id: mongoose.Types.ObjectId | null;
  reference: string | null;
  note: string | null;
  /** For `reversal`: the settlement being corrected. */
  reverses_settlement_id: mongoose.Types.ObjectId | null;

  occurred_at: Date;
  created_at: Date;
}

const ContractSettlementSchema = new Schema<IContractSettlement>(
  {
    contract_id: { type: Schema.Types.ObjectId, ref: MODELS.AGENT_AGENCY_CONTRACT, required: true },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },

    type: { type: String, enum: ['cod_remittance', 'agent_payment', 'reversal'], required: true },
    direction: { type: String, enum: ['agent_to_agency', 'agency_to_agent'], required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, default: 'XAF' },

    balance_after: { type: Number, required: true, min: 0 },

    had_discrepancy: { type: Boolean, default: false, required: true },
    discrepancy_amount: { type: Number, default: null },
    was_late: { type: Boolean, default: false, required: true },

    recorded_by_role: { type: String, enum: ['agent', 'agency', 'admin', 'system'], required: true },
    recorded_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    reference: { type: String, default: null, trim: true },
    note: { type: String, default: null, trim: true },
    reverses_settlement_id: {
      type: Schema.Types.ObjectId,
      ref: MODELS.CONTRACT_SETTLEMENT,
      default: null,
    },

    occurred_at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

/** One contract's settlement trail, newest first. */
ContractSettlementSchema.index({ contract_id: 1, occurred_at: -1 });
/** Agent-scoped history + the COD trust signals (clean returns, volume). */
ContractSettlementSchema.index({ agent_id: 1, type: 1, occurred_at: -1 });
/** Agency reconciliation view. */
ContractSettlementSchema.index({ agency_id: 1, type: 1, occurred_at: -1 });

export const ContractSettlementModel = mongoose.model<IContractSettlement>(
  MODELS.CONTRACT_SETTLEMENT,
  ContractSettlementSchema,
  COLLECTIONS.CONTRACT_SETTLEMENT
);
