import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * CleanupAudit — an append-only record of every action the file-cleanup sweep
 * takes (or would take, under dryRun). Gives operators a traceable history of
 * what was detached/deleted, why, and when, and supports post-hoc investigation
 * if a vendor reports missing media.
 *
 * One row per affected file/entity per sweep. Never updated.
 */

export type CleanupStage =
  | 'product_detach'
  | 'ticket_detach'
  | 'lonely_delete'
  | 'storage_alert';

export type CleanupAction = 'detach' | 'delete' | 'skip' | 'alert';

export interface ICleanupAudit extends Document {
  /** Correlates all rows produced by a single sweep run. */
  sweepId: string;
  stage: CleanupStage;
  action: CleanupAction;
  /** True when the sweep was in log-only mode (no real mutation happened). */
  dryRun: boolean;

  fileId?: mongoose.Types.ObjectId;
  entityType?: string;
  entityId?: mongoose.Types.ObjectId;
  vendorId?: mongoose.Types.ObjectId;

  /** Free-text explanation (e.g. why a file was skipped). */
  reason?: string;
  /** Stage-specific structured detail (sizes, thresholds, counts). */
  metadata?: Record<string, unknown>;

  createdAt: Date;
}

const CleanupAuditSchema = new Schema<ICleanupAudit>(
  {
    sweepId: { type: String, required: true, index: true },
    stage: {
      type: String,
      enum: ['product_detach', 'ticket_detach', 'lonely_delete', 'storage_alert'],
      required: true,
    },
    action: {
      type: String,
      enum: ['detach', 'delete', 'skip', 'alert'],
      required: true,
    },
    dryRun: { type: Boolean, required: true, default: false },

    fileId: { type: Schema.Types.ObjectId, ref: MODELS.FILE },
    entityType: { type: String },
    entityId: { type: Schema.Types.ObjectId },
    vendorId: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR },

    reason: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

CleanupAuditSchema.index({ createdAt: -1 });
CleanupAuditSchema.index({ fileId: 1 });

export const CleanupAuditModel =
  (mongoose.models.FileCleanupAudit as mongoose.Model<ICleanupAudit>) ||
  mongoose.model<ICleanupAudit>(MODELS.FILE_CLEANUP_AUDIT, CleanupAuditSchema, COLLECTIONS.FILE_CLEANUP_AUDIT);
