import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Who raised a proposal. The agency always may; the agent holding the accepted offer may
 * only while their agency has `assignment_settings.agents_can_propose_delivery_fee` on.
 */
export type DeliveryFeeProposerRole = 'agency' | 'agent' | 'system';
/**
 * Who answered or closed it. `system` is the auto-withdrawal on a decline / detach, and the
 * direct application of a customer-paid decrease (ADR-A11). `customer` answers a customer-paid
 * increase; `vendor` also covers a change-agency difference.
 */
export type DeliveryFeeResponderRole = 'vendor' | 'agency' | 'agent' | 'system' | 'customer';
export type { ProposalApprover, ProposalOrigin, FeeDirection } from '../domain/customer-fee-change.rules';
import type { ProposalApprover, ProposalOrigin, FeeDirection } from '../domain/customer-fee-change.rules';
import { PROPOSAL_APPROVERS, PROPOSAL_ORIGINS } from '../domain/customer-fee-change.rules';

export type DeliveryFeeProposalStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export const DELIVERY_FEE_PROPOSAL_STATUSES: DeliveryFeeProposalStatus[] = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
];

export interface IDeliveryFeeProposalHistoryEntry {
  status: DeliveryFeeProposalStatus;
  changed_at: Date;
  changed_by_role: DeliveryFeeProposerRole | DeliveryFeeResponderRole;
  changed_by_user_id: Types.ObjectId | null;
  note: string | null;
}

/** One edit of a pending proposal. */
export interface IDeliveryFeeProposalEdit {
  edited_by_role: DeliveryFeeProposerRole;
  edited_by_user_id: Types.ObjectId | null;
  edited_by_agent_id: Types.ObjectId | null;
  fee_before: number;
  fee_after: number;
  reason_before: string;
  reason_after: string;
  /** The version the edit produced. */
  version: number;
  at: Date;
}

/**
 * What an approval actually did to the money — the audit half of the decision. Recorded so
 * "why did my net move by 1 500?" is answerable from this row alone.
 */
export interface IDeliveryFeeApplication {
  /** The shipment's effective fee the instant the approval replaced it. */
  fee_at_apply: number;
  /**
   * PREPAID only: the vendor's `('order', vendor)` allocation before and after the in-place
   * adjustment. `null` when no allocation was touched (COD, or an order not split yet — the
   * split then charges the approved fee itself).
   */
  vendor_allocation_before: number | null;
  vendor_allocation_after: number | null;
  /** Whether `delivery_fee_snapshot` was rewritten (prepaid, already split). */
  snapshot_rewritten: boolean;
  /**
   * ADR-A11 — a CUSTOMER-paid change. What `shipment.customer_delivery_fee` was and became, what
   * the customer paid on top (online top-up) or is owed back (online), and whether a pending COD
   * collection was re-priced. Null/false on a vendor-paid approval.
   */
  customer_fee_before?: number | null;
  customer_fee_after?: number | null;
  customer_topup_amount?: number | null;
  customer_refund_due?: number | null;
  cod_collection_adjusted?: boolean;
  /** How much the vendor's share of the fee moved (+ = the vendor bears more). */
  vendor_borne_delta?: number | null;
}

/** The customer's answer to an increase they must pay for (online), before the money arrives. */
export interface IDeliveryFeeCustomerApproval {
  approved_at: Date;
  /** The version the customer approved — an edit after it is refused. */
  version: number;
  user_id: Types.ObjectId | null;
  /** The top-up the approval needs (online). */
  topup_amount: number;
}

/** The online top-up an approved increase is waiting for. */
export interface IDeliveryFeeTopup {
  amount: number;
  /** The payment transaction that settled it (`purpose: 'order_delivery_topup'`). Null until paid. */
  transaction_id: Types.ObjectId | null;
  status: 'awaiting_payment' | 'paid';
  paid_at: Date | null;
}

/**
 * A proposed change to ONE shipment's delivery fee, awaiting the vendor's approval.
 *
 * The delivery fee is a flat per-shipment amount derived from the agency's
 * `policies.pricing` (`deliveryFeeForPickupMix`), and the VENDOR pays it out of their net —
 * the customer never sees it. So the agency cannot change it unilaterally, and neither can
 * the agent; one of them proposes and the vendor approves or rejects. The fee moves in the
 * same transaction that records the approval.
 *
 * Append-only in spirit: rows are never deleted, and every transition is a compare-and-set
 * on `status: 'pending'` that appends to `status_history`. The shipment carries a pointer to
 * its pending proposal (`pending_delivery_fee_proposal_id`), which is what blocks pickup.
 */
export interface IDeliveryFeeProposal extends Document {
  shipment_id: Types.ObjectId;
  order_id: Types.ObjectId;
  vendor_id: Types.ObjectId;
  agency_id: Types.ObjectId;

  proposed_by_role: DeliveryFeeProposerRole;
  proposed_by_user_id: Types.ObjectId | null;
  /** Set when the agent proposed — the agent holding the accepted offer at that moment. */
  proposed_by_agent_id: Types.ObjectId | null;

  /** Snapshot of the order's payment method; decides how an approval applies the money. */
  payment_method: string;
  currency: string;

  /** The shipment's effective fee when the proposal was raised. */
  fee_before: number;
  proposed_fee: number;
  /** Required free text — why the fee should change. */
  reason: string;

  status: DeliveryFeeProposalStatus;

  /**
   * ADR-A11. Who must answer: `vendor` (vendor-paid, ADR-A09), `customer` (an increase on a
   * customer-paid shipment), `none` (a customer-paid decrease — applied on creation). Rows
   * written before ADR-A11 read the default `vendor`.
   */
  approver: ProposalApprover;
  /** Where it came from: an agency/agent proposal, a change-agency difference, a combined request. */
  origin: ProposalOrigin;
  direction: FeeDirection | null;
  /** The order's customer, on a customer-paid proposal (the customer reads are scoped by it). */
  customer_id: Types.ObjectId | null;
  /** The combined-price request this proposal answered, if any. */
  combined_request_id: Types.ObjectId | null;
  customer_approval: IDeliveryFeeCustomerApproval | null;
  topup: IDeliveryFeeTopup | null;

  responded_by_role: DeliveryFeeResponderRole | null;
  responded_by_user_id: Types.ObjectId | null;
  responded_at: Date | null;
  /** The vendor's optional explanation on a rejection. */
  rejection_note: string | null;
  /** Why a withdrawal happened when the system did it (`shipment_declined`, `agent_detached`). */
  withdrawal_reason: string | null;

  application: IDeliveryFeeApplication | null;

  /**
   * Bumped on every edit (starts at 1). The vendor's approve/reject carries the version it
   * SAW and is refused on a mismatch, so a vendor never approves a figure they did not see.
   */
  version: number;
  /** Append-only edit trail — one entry per PATCH, never rewritten. */
  edits: IDeliveryFeeProposalEdit[];
  last_edited_by: { role: DeliveryFeeProposerRole; user_id: Types.ObjectId | null; agent_id: Types.ObjectId | null; at: Date } | null;
  /**
   * Sticky: true once the AGENCY has edited it. An agency-edited proposal is agency-owned —
   * it survives the proposing agent being detached, and that agent may no longer edit or
   * withdraw it.
   */
  agency_edited: boolean;

  status_history: IDeliveryFeeProposalHistoryEntry[];

  created_at: Date;
  updated_at: Date;
}

const ROLES = ['agency', 'agent', 'vendor', 'system', 'customer'];

const HistoryEntrySchema = new Schema<IDeliveryFeeProposalHistoryEntry>(
  {
    status: { type: String, enum: DELIVERY_FEE_PROPOSAL_STATUSES, required: true },
    changed_at: { type: Date, required: true },
    changed_by_role: { type: String, enum: ROLES, required: true },
    changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    note: { type: String, default: null, maxlength: 500, trim: true },
  },
  { _id: false }
);

const DeliveryFeeProposalSchema = new Schema<IDeliveryFeeProposal>(
  {
    shipment_id: { type: Schema.Types.ObjectId, ref: MODELS.SHIPMENT, required: true },
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, required: true },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },

    proposed_by_role: { type: String, enum: ['agency', 'agent', 'system'], required: true },
    proposed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    proposed_by_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },

    payment_method: { type: String, required: true },
    currency: { type: String, required: true, uppercase: true, trim: true },

    fee_before: { type: Number, required: true, min: 0 },
    proposed_fee: { type: Number, required: true, min: 0 },
    reason: { type: String, required: true, trim: true, maxlength: 500 },

    status: {
      type: String,
      enum: DELIVERY_FEE_PROPOSAL_STATUSES,
      required: true,
      default: 'pending',
    },

    // ADR-A11 — see the interface. The defaults keep every earlier row a vendor-approver proposal.
    approver: { type: String, enum: [...PROPOSAL_APPROVERS], required: true, default: 'vendor' },
    origin: { type: String, enum: [...PROPOSAL_ORIGINS], required: true, default: 'agency' },
    direction: { type: String, enum: ['increase', 'decrease', null], default: null },
    customer_id: { type: Schema.Types.ObjectId, ref: MODELS.CUSTOMER, default: null },
    combined_request_id: { type: Schema.Types.ObjectId, default: null },
    customer_approval: {
      type: new Schema<IDeliveryFeeCustomerApproval>(
        {
          approved_at: { type: Date, required: true },
          version: { type: Number, required: true, min: 1 },
          user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
          topup_amount: { type: Number, required: true, min: 0 },
        },
        { _id: false }
      ),
      default: null,
    },
    topup: {
      type: new Schema<IDeliveryFeeTopup>(
        {
          amount: { type: Number, required: true, min: 0 },
          transaction_id: { type: Schema.Types.ObjectId, ref: MODELS.PAYMENT_TRANSACTION, default: null },
          status: { type: String, enum: ['awaiting_payment', 'paid'], required: true },
          paid_at: { type: Date, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    responded_by_role: { type: String, enum: [...ROLES, null], default: null },
    responded_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    responded_at: { type: Date, default: null },
    rejection_note: { type: String, default: null, trim: true, maxlength: 500 },
    withdrawal_reason: { type: String, default: null, trim: true, maxlength: 100 },

    application: {
      type: new Schema<IDeliveryFeeApplication>(
        {
          fee_at_apply: { type: Number, required: true, min: 0 },
          vendor_allocation_before: { type: Number, default: null },
          vendor_allocation_after: { type: Number, default: null },
          snapshot_rewritten: { type: Boolean, required: true, default: false },
          customer_fee_before: { type: Number, default: null },
          customer_fee_after: { type: Number, default: null },
          customer_topup_amount: { type: Number, default: null },
          customer_refund_due: { type: Number, default: null },
          cod_collection_adjusted: { type: Boolean, default: false },
          vendor_borne_delta: { type: Number, default: null },
        },
        { _id: false }
      ),
      default: null,
    },

    version: { type: Number, required: true, default: 1, min: 1 },
    edits: {
      type: [
        new Schema<IDeliveryFeeProposalEdit>(
          {
            edited_by_role: { type: String, enum: ['agency', 'agent', 'system'], required: true },
            edited_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
            edited_by_agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
            fee_before: { type: Number, required: true, min: 0 },
            fee_after: { type: Number, required: true, min: 0 },
            reason_before: { type: String, required: true, maxlength: 500 },
            reason_after: { type: String, required: true, maxlength: 500 },
            version: { type: Number, required: true, min: 2 },
            at: { type: Date, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    last_edited_by: {
      type: new Schema(
        {
          role: { type: String, enum: ['agency', 'agent', 'system'], required: true },
          user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
          agent_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENT, default: null },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    agency_edited: { type: Boolean, required: true, default: false },

    status_history: { type: [HistoryEntrySchema], default: [] },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ── Indexes (built by `npm run migrate:delivery-fee-proposal-indexes`; autoIndex is OFF in
// production, so these must stay in step with that script's PLANNED list) ─────────────────
//
// ONE pending proposal per shipment. The service pre-checks via the shipment's pending
// pointer (a CAS), and this is what makes it true under a race the CAS does not see.
DeliveryFeeProposalSchema.index(
  { shipment_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
    name: 'delivery_fee_proposal_one_pending_per_shipment',
  }
);
// A shipment's proposal history, newest first (the agency / agent detail, the count cap).
DeliveryFeeProposalSchema.index(
  { shipment_id: 1, created_at: -1 },
  { name: 'delivery_fee_proposal_by_shipment' }
);
// The vendor's inbox (status filter + newest first) and an order's proposals.
DeliveryFeeProposalSchema.index(
  { vendor_id: 1, status: 1, created_at: -1 },
  { name: 'delivery_fee_proposal_vendor_inbox' }
);
DeliveryFeeProposalSchema.index(
  { order_id: 1, created_at: -1 },
  { name: 'delivery_fee_proposal_by_order' }
);

export const DeliveryFeeProposalModel = mongoose.model<IDeliveryFeeProposal>(
  MODELS.DELIVERY_FEE_PROPOSAL,
  DeliveryFeeProposalSchema,
  COLLECTIONS.DELIVERY_FEE_PROPOSAL
);
