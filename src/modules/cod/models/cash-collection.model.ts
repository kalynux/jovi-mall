import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CashCollection - the payment record of ONE COD shipment.
 *
 * Created when a COD shipment is picked up (the package is now out for
 * delivery), with the expected cash snapshot and a hashed delivery code the
 * customer receives. The agent can only mark the handoff done by submitting
 * that code — which atomically records the cash, delivers the shipment and
 * raises the agent's/agency's cash liability.
 *
 * This collection is the COD equivalent of a PaymentTransaction: append-only
 * in spirit (status only ever moves pending → collected | cancelled, amounts
 * are immutable snapshots), and the FIFO settlement target for agency
 * remittances (see cod-settlement.service).
 *
 * Amounts are integers in minor currency units.
 */

export type CashCollectionStatus = 'pending' | 'collected' | 'cancelled';

export interface ICollectionVerification {
  /** GPS fix reported by the agent app at code submission (optional). */
  location: { lat: number; lng: number } | null;
  /** Free-form device identifier/user-agent reported by the agent app. */
  device_info: string | null;
  /** Request IP captured server-side at code submission. */
  ip: string | null;
}

export interface ICashCollection extends Document {
  order_id: mongoose.Types.ObjectId;
  shipment_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  /** Agent assigned at pickup time — COD shipments cannot be picked up unassigned. */
  agent_id: mongoose.Types.ObjectId;
  customer_id: mongoose.Types.ObjectId;
  vendor_id: mongoose.Types.ObjectId;

  /** Cash to collect for this shipment: Σ item price × qty (snapshot). */
  expected_amount: number;
  currency: string;

  status: CashCollectionStatus;

  // ── Delivery code (OTP) ──────────────────────────────────────────────────
  /** sha256(code) — what agent submissions are verified against. */
  code_hash: string;
  /**
   * The plaintext code, retrievable ONLY through the customer's own order
   * view (schema-level `select: false`); agents/agencies never see it. The
   * customer also receives it via WhatsApp when possible.
   */
  code_plain?: string;
  code_generated_at: Date;
  /** Wrong-code submissions since the last (re)generation. */
  code_attempts: number;
  /** Locked after too many wrong attempts — requires a resend to regenerate. */
  code_locked: boolean;

  // ── Collection outcome ───────────────────────────────────────────────────
  collected_at: Date | null;
  verification: ICollectionVerification | null;

  // ── Settlement (remittance FIFO application — see cod-settlement.service) ─
  /** Portion of `expected_amount` covered by confirmed agency remittances. */
  settled_amount: number;
  /** Stamped when settled_amount reaches expected_amount. */
  settled_at: Date | null;

  created_at: Date;
  updated_at: Date;
}

const CashCollectionSchema = new Schema<ICashCollection>(
  {
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, required: true },
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },

    expected_amount: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },

    status: {
      type: String,
      enum: ['pending', 'collected', 'cancelled'],
      required: true,
      default: 'pending',
    },

    code_hash: { type: String, required: true },
    code_plain: { type: String, required: true, select: false },
    code_generated_at: { type: Date, required: true },
    code_attempts: { type: Number, required: true, default: 0, min: 0 },
    code_locked: { type: Boolean, required: true, default: false },

    collected_at: { type: Date, default: null },
    verification: {
      type: new Schema(
        {
          location: {
            type: new Schema(
              { lat: { type: Number, required: true }, lng: { type: Number, required: true } },
              { _id: false }
            ),
            default: null,
          },
          device_info: { type: String, default: null },
          ip: { type: String, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    settled_amount: { type: Number, required: true, default: 0, min: 0 },
    settled_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// One collection per shipment — the double-collect guard.
CashCollectionSchema.index({ shipment_id: 1 }, { unique: true });
// FIFO settlement sweep per agency (oldest collected first).
CashCollectionSchema.index({ agency_id: 1, status: 1, collected_at: 1 });
// Agent exposure/deposit queries.
CashCollectionSchema.index({ agent_id: 1, status: 1 });
// Order payment recompute.
CashCollectionSchema.index({ order_id: 1 });

export const CashCollectionModel = mongoose.model<ICashCollection>(
  MODELS.CASH_COLLECTION,
  CashCollectionSchema,
  COLLECTIONS.CASH_COLLECTION
);
