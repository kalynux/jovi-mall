import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { ActorSource, actorStampFields } from '../../../core/types/actor-source.types';

/**
 * AgencyRemittance - the agency handing collected COD cash up to the platform
 * (bank transfer / mobile money / cash desk — identified by `reference`).
 *
 * Two-step: the AGENCY declares what it sent; an ADMIN confirms receipt.
 * Only a CONFIRMED remittance lowers the agency's cash liability and is
 * FIFO-applied to its collected CashCollections (marking them settled, which
 * unlocks the escrow release of the earnings they back). A rejected
 * declaration changes nothing.
 */

export type AgencyRemittanceStatus = 'declared' | 'confirmed' | 'rejected';

export interface IAgencyRemittance extends Document {
  agency_id: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  /** External money-movement reference (bank/transfer/receipt id). */
  reference: string;
  note: string | null;
  status: AgencyRemittanceStatus;
  declared_by_user_id: mongoose.Types.ObjectId;
  declared_at: Date;
  resolved_at: Date | null;
  resolved_by_user_id: mongoose.Types.ObjectId | null;
  /**
   * Which identity space `resolved_by_user_id` belongs to.
   *
   * `'admin'` means it is a **wi-admin** id that does NOT resolve in this database — an
   * administrator holds no `users` row since the admin backend was split out. Defaults to
   * `'platform'`, which is correct for every row written before the split.
   * See `core/types/actor-source.types.ts`.
   */
  resolved_by_source: ActorSource;
  /** Snapshot of who resolved it — an admin id cannot be looked up from this service. */
  resolved_by_name: string | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const AgencyRemittanceSchema = new Schema<IAgencyRemittance>(
  {
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    amount: { type: Number, required: true, min: 1 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    reference: { type: String, required: true, trim: true, maxlength: 200 },
    note: { type: String, default: null, trim: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['declared', 'confirmed', 'rejected'],
      required: true,
      default: 'declared',
    },
    declared_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    declared_at: { type: Date, required: true, default: () => new Date() },
    resolved_at: { type: Date, default: null },
    // `ref` kept for documentation of intent, but note it no longer always resolves:
    // an admin-resolved remittance carries a wi-admin id. `resolved_by_source` says which.
    resolved_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    ...actorStampFields('resolved_by'),
    rejection_reason: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AgencyRemittanceSchema.index({ agency_id: 1, created_at: -1 });
AgencyRemittanceSchema.index({ status: 1, created_at: -1 });

export const AgencyRemittanceModel = mongoose.model<IAgencyRemittance>(
  MODELS.AGENCY_REMITTANCE,
  AgencyRemittanceSchema,
  COLLECTIONS.AGENCY_REMITTANCE
);
