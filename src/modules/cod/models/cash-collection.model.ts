import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { CASH_COLLECTION_KINDS } from '../../orders/domain/delivery-payer';
import type { CashCollectionKind } from '../../orders/domain/delivery-payer';

/**
 * CashCollection - the payment record of ONE COD shipment.
 *
 * Created when a COD shipment is assigned an agent (so the customer is holding
 * their code long before anyone reaches the door), with the expected cash
 * snapshot and a hashed delivery code. Normally the agent marks the handoff
 * done by submitting that code — which atomically records the cash, delivers
 * the shipment and raises the agent's/agency's cash liability.
 *
 * The one exception is the auto-collection: a shipment left at
 * `agent_delivered` past the dispute window is collected without a code by the
 * earnings sweep, because an agent who was NOT paid is required to return the
 * shipment instead. See `CashCollectionService.autoCollectWithoutCode` and
 * `verification.method`.
 *
 * This collection is the COD equivalent of a PaymentTransaction: append-only
 * in spirit (status only ever moves pending → collected | cancelled, amounts
 * are immutable snapshots), and the FIFO settlement target for agency
 * remittances (see cod-settlement.service).
 *
 * Amounts are integers in minor currency units.
 */

export type CashCollectionStatus = 'pending' | 'collected' | 'cancelled';

/**
 * How a collection's handoff was verified.
 *
 *  - 'code'         — the agent submitted the customer's delivery code. The
 *    customer proved receipt by releasing a secret only they held.
 *  - 'auto_no_code' — no code ever arrived and the dispute window elapsed with
 *    the shipment still at `agent_delivered`, which is the agent's implicit
 *    assertion that they were paid (an unpaid agent's duty is to return the
 *    shipment). The collection was recorded by the system on the strength of
 *    that assertion alone.
 *
 * The distinction is the point: an uncoded collection carries no customer
 * evidence at all, and a delivery dispute turns on exactly that.
 */
export type CollectionVerificationMethod = 'code' | 'auto_no_code';

export interface ICollectionVerification {
  /** What proved the handoff — see CollectionVerificationMethod. */
  method: CollectionVerificationMethod;
  /** GPS fix reported by the agent app at code submission (null when uncoded). */
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

  /**
   * What this cash is (ADR-A11 § Cash for delivery, W-F):
   *  - `order`        — a COD order's cash: the goods + a customer-paid fee. Every row before W-F.
   *  - `delivery_fee` — an ONLINE order whose customer pays the delivery fee to the rider in
   *                     cash: the fee ALONE (`items_amount: 0`). Split by
   *                     `EarningsSplitService.splitDeliveryFeeCollection` to the agency and the
   *                     agent only — never to the vendor or the platform.
   * Read through `collectionKindOf` (a missing field is `order`).
   */
  kind?: CashCollectionKind;

  /**
   * Cash to collect for this shipment (snapshot): `items_amount + delivery_fee_amount`.
   * Before ADR-A11 it was the items alone (and those rows carry no breakdown).
   */
  expected_amount: number;
  /** Σ order-item price × shipment qty — the goods. The split's gross and the COD fee's base (D-5). */
  items_amount?: number | null;
  /**
   * The delivery fee the customer hands the agent with the goods — the shipment's
   * `customer_delivery_fee` on a customer-paid shipment, 0 on a vendor-paid one (ADR-A11).
   */
  delivery_fee_amount?: number | null;
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

    kind: { type: String, enum: [...CASH_COLLECTION_KINDS], default: 'order' },

    expected_amount: { type: Number, required: true, min: 0 },
    // The breakdown of expected_amount (ADR-A11). Null on rows written before it.
    items_amount: { type: Number, default: null, min: 0 },
    delivery_fee_amount: { type: Number, default: null, min: 0 },
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
          // Defaulted, not required: every row that predates the auto-collect
          // path was a code submission, so the default is the truth for them.
          method: { type: String, enum: ['code', 'auto_no_code'], default: 'code' },
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

/** A collection's kind; rows written before W-F carry none and are COD order cash. */
export function collectionKindOf(collection: { kind?: CashCollectionKind | null }): CashCollectionKind {
  return collection.kind === 'delivery_fee' ? 'delivery_fee' : 'order';
}

export const CashCollectionModel = mongoose.model<ICashCollection>(
  MODELS.CASH_COLLECTION,
  CashCollectionSchema,
  COLLECTIONS.CASH_COLLECTION
);
