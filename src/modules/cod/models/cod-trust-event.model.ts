import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CodTrustEvent - append-only history of every trust-score movement for a
 * delivery agent. The current score is denormalized onto
 * `DeliveryAgent.cod.trust_score`; this collection is the audit trail
 * (nobody edits history — only appends).
 */

export type CodTrustEventType = 'late_deposit' | 'deposit_shortfall' | 'admin_adjustment';

export interface ICodTrustEvent extends Document {
  agent_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId | null;
  event_type: CodTrustEventType;
  /** Signed score movement (negative = penalty). */
  delta: number;
  /** Agent's trust score immediately after this event (audit snapshot). */
  score_after: number;
  /** What triggered it (discrepancy id, admin note...). */
  ref_type: 'cod_discrepancy' | 'admin' | null;
  ref_id: mongoose.Types.ObjectId | null;
  note: string | null;
  created_at: Date;
}

const CodTrustEventSchema = new Schema<ICodTrustEvent>(
  {
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, default: null },
    event_type: {
      type: String,
      enum: ['late_deposit', 'deposit_shortfall', 'admin_adjustment'],
      required: true,
    },
    delta: { type: Number, required: true },
    score_after: { type: Number, required: true, min: 0, max: 100 },
    ref_type: { type: String, enum: ['cod_discrepancy', 'admin', null], default: null },
    ref_id: { type: Schema.Types.ObjectId, default: null },
    note: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

CodTrustEventSchema.index({ agent_id: 1, created_at: -1 });

export const CodTrustEventModel = mongoose.model<ICodTrustEvent>(
  MODELS.COD_TRUST_EVENT,
  CodTrustEventSchema,
  COLLECTIONS.COD_TRUST_EVENT
);
