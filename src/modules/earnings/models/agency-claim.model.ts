import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * `agency_claims` — a DAMAGE CLAIM charged to a delivery agency for one parcel (owner decision
 * F-8, 2026-10-22). Plan: PRODUCTION-READINESS/REFUND-FEES-AND-AGENCY-LIABILITY-PLAN.md § 4.4.
 *
 * An administrator records it once the parcel was found damaged in delivery. It is only allowed
 * inside the agency's own window (its damage-claim deadline, counted from its parcel's delivery)
 * and up to its own max refund per item × the damaged items. Applying it, in one transaction:
 *   - charges the AGENCY `amount + investigation_fee` (never its rider): from its still-held money
 *     for that parcel, then its available balance, then debt (`earnings_adjustments`, reason
 *     `damage_claim`);
 *   - credits the VENDOR `amount` — they carried the loss of the broken goods — as an earnings
 *     share (`source_type: 'agency_claim'`) the nightly sweep releases, paying their debt first;
 *   - books the investigation fee to the platform the same way.
 *
 * Every number the explanation quotes is stored here, so what the agency reads is what was
 * decided. Append-only: a claim is never edited or deleted. One per parcel.
 */
export interface IAgencyClaim extends Document {
  kind: 'damage';
  shipment_id: mongoose.Types.ObjectId;
  order_id: mongoose.Types.ObjectId;
  order_number: string | null;
  tracking_number: string | null;
  agency_id: mongoose.Types.ObjectId;
  vendor_id: mongoose.Types.ObjectId | null;
  /** The refund this claim followed, when there was one. */
  refund_request_id: mongoose.Types.ObjectId | null;
  item_count: number;
  /** What the administrator asked for. */
  claimed_amount: number;
  /** The agency's max refund per item, as read when the claim was made. */
  max_per_item: number;
  /** `max_per_item × item_count`. */
  cap: number;
  /** What was charged for the damage (= claimed, refused when above the cap). */
  amount: number;
  /** The agency's investigation fee, as read when the claim was made. */
  investigation_fee: number;
  currency: string;
  delivered_at: Date;
  raised_at: Date;
  window_days: number;
  note: string;
  created_by: { id: string | null; name: string | null };
  reason_code: string;
  reason_params: Record<string, unknown>;
  explanation: string;
  /** What the agency's balances gave: held money of the parcel, available, and debt. */
  taken_from: { pending: number; reserve: number; available: number; debt: number };
  created_at: Date;
}

const AgencyClaimSchema = new Schema<IAgencyClaim>(
  {
    kind: { type: String, enum: ['damage'], required: true, default: 'damage' },
    shipment_id: { type: Schema.Types.ObjectId, required: true },
    order_id: { type: Schema.Types.ObjectId, required: true },
    order_number: { type: String, default: null },
    tracking_number: { type: String, default: null },
    agency_id: { type: Schema.Types.ObjectId, required: true },
    vendor_id: { type: Schema.Types.ObjectId, default: null },
    refund_request_id: { type: Schema.Types.ObjectId, default: null },
    item_count: { type: Number, required: true, min: 1 },
    claimed_amount: { type: Number, required: true, min: 1 },
    max_per_item: { type: Number, required: true, min: 0 },
    cap: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 1 },
    investigation_fee: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },
    delivered_at: { type: Date, required: true },
    raised_at: { type: Date, required: true },
    window_days: { type: Number, required: true, min: 0 },
    note: { type: String, required: true, trim: true, maxlength: 1000 },
    created_by: {
      id: { type: String, default: null },
      name: { type: String, default: null },
    },
    reason_code: { type: String, required: true },
    reason_params: { type: Schema.Types.Mixed, required: true },
    explanation: { type: String, required: true, maxlength: 1000 },
    taken_from: {
      pending: { type: Number, required: true, default: 0, min: 0 },
      reserve: { type: Number, required: true, default: 0, min: 0 },
      available: { type: Number, required: true, default: 0, min: 0 },
      debt: { type: Number, required: true, default: 0, min: 0 },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

/** One damage claim per parcel — also the race guard for two administrators at once. */
AgencyClaimSchema.index({ shipment_id: 1 }, { unique: true, name: 'agency_claim_one_per_shipment' });
/** The agency's own list, and the administrators' per-agency view. */
AgencyClaimSchema.index({ agency_id: 1, created_at: -1 });
/** The vendor's list, and the administrators' queue. */
AgencyClaimSchema.index({ vendor_id: 1, created_at: -1 });
AgencyClaimSchema.index({ created_at: -1 });

export const AgencyClaimModel = mongoose.model<IAgencyClaim>(MODELS.AGENCY_CLAIM, AgencyClaimSchema, COLLECTIONS.AGENCY_CLAIM);
