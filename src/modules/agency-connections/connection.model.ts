import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../core/database/collections';

export type ConnectionStatus =
  | 'pending'
  | 'active'
  | 'rejected'
  | 'withdrawn'
  | 'paused_reapproval'
  | 'terminated';

export type ConnectionParty = 'vendor' | 'agency';

export interface IConnectionRejection {
  reason: string | null;
  rejected_by_role: ConnectionParty;
  rejected_by_user_id: mongoose.Types.ObjectId;
  rejected_at: Date;
}

export interface IConnectionWithdrawal {
  withdrawn_by_role: ConnectionParty;
  withdrawn_by_user_id: mongoose.Types.ObjectId;
  withdrawn_at: Date;
}

export interface IConnectionTermination {
  terminated_by_role: ConnectionParty;
  terminated_by_user_id: mongoose.Types.ObjectId;
  terminated_at: Date;
  reason: 'unilateral' | 'reapproval_declined';
  note: string | null;
}

export interface IConnectionStatusHistoryEntry {
  status: ConnectionStatus;
  changed_at: Date;
  changed_by_role: ConnectionParty | 'system';
  changed_by_user_id: mongoose.Types.ObjectId | null;
  note?: string | null;
}

/**
 * Consensual link between a vendor and a delivery agency. Exactly one document
 * ever exists per (vendor_id, agency_id) pair (enforced by a unique index) — a
 * rejected/withdrawn/terminated connection is re-requested by resetting the SAME
 * document back to 'pending', not by creating a new one.
 *
 * Only an 'active' connection lets a vendor assign this agency as their default
 * or as a per-product delivery override — see ProductStatusValidationService,
 * VendorProfileService.setDefaultDeliveryAgency, and ProductUpdateService.
 */
export interface IVendorAgencyConnection extends Document {
  vendor_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  status: ConnectionStatus;

  requester_role: ConnectionParty;
  requested_by_user_id: mongoose.Types.ObjectId;
  requested_at: Date;

  responded_by_user_id: mongoose.Types.ObjectId | null;
  responded_at: Date | null;

  /** Snapshot of each side's policy_version taken at the moment of (re)approval. */
  vendor_policy_version_at_approval: number | null;
  agency_policy_version_at_approval: number | null;

  /** Set only while status === 'paused_reapproval': which side must act. */
  reapproval_required_from: ConnectionParty | null;
  paused_at: Date | null;
  paused_reason: 'vendor_policy_changed' | 'agency_policy_changed' | null;

  rejection: IConnectionRejection | null;
  withdrawal: IConnectionWithdrawal | null;
  termination: IConnectionTermination | null;

  status_history: IConnectionStatusHistoryEntry[];

  created_at: Date;
  updated_at: Date;
}

const ConnectionStatusHistoryEntrySchema = new Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'withdrawn', 'paused_reapproval', 'terminated'],
      required: true,
    },
    changed_at: { type: Date, required: true },
    changed_by_role: { type: String, enum: ['vendor', 'agency', 'system'], required: true },
    changed_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    note: { type: String, default: null, maxlength: 300, trim: true },
  },
  { _id: false },
);

const VendorAgencyConnectionSchema = new Schema<IVendorAgencyConnection>(
  {
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    agency_id: { type: Schema.Types.ObjectId, ref: MODELS.DELIVERY_AGENCY, required: true },
    status: {
      type: String,
      enum: ['pending', 'active', 'rejected', 'withdrawn', 'paused_reapproval', 'terminated'],
      default: 'pending',
      required: true,
    },

    requester_role: { type: String, enum: ['vendor', 'agency'], required: true },
    requested_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    requested_at: { type: Date, required: true },

    responded_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, default: null },
    responded_at: { type: Date, default: null },

    vendor_policy_version_at_approval: { type: Number, default: null },
    agency_policy_version_at_approval: { type: Number, default: null },

    reapproval_required_from: { type: String, enum: ['vendor', 'agency'], default: null },
    paused_at: { type: Date, default: null },
    paused_reason: { type: String, enum: ['vendor_policy_changed', 'agency_policy_changed'], default: null },

    rejection: {
      type: {
        reason: { type: String, default: null, maxlength: 300, trim: true },
        rejected_by_role: { type: String, enum: ['vendor', 'agency'], required: true },
        rejected_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
        rejected_at: { type: Date, required: true },
      },
      required: false,
      default: null,
    },
    withdrawal: {
      type: {
        withdrawn_by_role: { type: String, enum: ['vendor', 'agency'], required: true },
        withdrawn_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
        withdrawn_at: { type: Date, required: true },
      },
      required: false,
      default: null,
    },
    termination: {
      type: {
        terminated_by_role: { type: String, enum: ['vendor', 'agency'], required: true },
        terminated_by_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
        terminated_at: { type: Date, required: true },
        reason: { type: String, enum: ['unilateral', 'reapproval_declined'], required: true },
        note: { type: String, default: null, maxlength: 300, trim: true },
      },
      required: false,
      default: null,
    },

    status_history: { type: [ConnectionStatusHistoryEntrySchema], default: [] },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } },
);

// Exactly one connection document per pair, ever — re-requests reuse it.
VendorAgencyConnectionSchema.index({ vendor_id: 1, agency_id: 1 }, { unique: true });
VendorAgencyConnectionSchema.index({ vendor_id: 1, status: 1 });
VendorAgencyConnectionSchema.index({ agency_id: 1, status: 1 });

export const VendorAgencyConnectionModel = mongoose.model<IVendorAgencyConnection>(
  MODELS.VENDOR_AGENCY_CONNECTION,
  VendorAgencyConnectionSchema,
  COLLECTIONS.VENDOR_AGENCY_CONNECTION,
);
