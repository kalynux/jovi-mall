import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export type StorageProvider = 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary';
export type FileOwnerType = 'vendor' | 'admin' | 'customer' | 'agent' | 'agency' | 'system';

/**
 * File Domain Model
 * 
 * Represents a stored file with provider-agnostic metadata.
 * Files are first-class database records that can be shared across products, variants, and digital assets.
 * 
 * Owner fields represent the original uploader and are set once on upload, never mutated.
 *
 * References are tracked in the `file_references` collection (one row per
 * entity that uses the file). A file is "in use" iff it has at least one live
 * reference; orphan garbage collection reclaims files with none. See
 * {@link IFileReference}.
 */
export interface IFile extends IBaseDocument {
  key: string;              // provider-specific key (file path or object key)
  provider: StorageProvider; // storage backend
  mimeType: string;          // MIME type
  size: number;              // file size in bytes
  checksum?: string;         // optional checksum (MD5, SHA256, etc.)
  originalName?: string;     // original filename when uploaded

  // Original uploader - set once on upload, never mutated
  ownerType?: FileOwnerType; // 'vendor', 'admin', 'customer', 'agent', 'agency', or 'system'
  ownerId?: Types.ObjectId;  // actorId (null for 'system' owner type)

  /**
   * When the file became "lonely" — its live reference count dropped to 0.
   * Maintained by the file-reference layer: set to now when the last reference
   * is removed, cleared (null) when a reference is (re)added. Null means the file
   * is currently referenced (or was never attached — fall back to createdAt).
   * Drives the lonely-file deletion grace period. See file-cleanup module.
   */
  orphanedAt?: Date | null;

  /**
   * When this file was blocked for exceeding the owner's plan storage cap.
   * Null = not blocked, which is every file until a plan downgrade puts the owner
   * over their allowance. Written only by `PlanQuotaEnforcementService`, which
   * blocks strictly newest-first and lifts strictly oldest-first.
   *
   * ── A TIMESTAMP rather than a boolean, deliberately ─────────────────────────
   * "blocked since" is reportable and answers a support question a boolean cannot
   * ("did this go dark before or after they downgraded?"). It also keeps the
   * default `null` meaningful, so no backfill is needed — every existing row is
   * correctly unblocked on the day this ships.
   *
   * ⚠ This is NOT a deletion and NOT a soft delete. The bytes stay, the row stays,
   * the file keeps counting toward `MediaStorageService.getUsedBytes` — blocking is
   * what the owner gets *instead* of losing data, and an upgrade must restore the
   * exact same files. Never let a cleanup sweep key on this field.
   *
   * Read at exactly one place on the way out: `toFileDetail`, which turns it into
   * `access: 'quota_blocked'` + `url: null`.
   */
  quotaBlockedAt?: Date | null;
}

const FileSchema = new Schema<IFile>({
  key: { type: String, required: true },
  provider: {
    type: String,
    enum: ['local', 's3', 'gcs', 'r2', 'firebase', 'cloudinary'],
    required: true
  },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  checksum: { type: String },
  originalName: { type: String },

  ownerType: {
    type: String,
    enum: ['vendor', 'admin', 'customer', 'agent', 'agency', 'system']
  },
  ownerId: { type: Schema.Types.ObjectId },

  orphanedAt: { type: Date, default: null },

  quotaBlockedAt: { type: Date, default: null },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
FileSchema.index({ key: 1, provider: 1 }, { unique: true }); // Unique file per provider
FileSchema.index({ ownerId: 1, checksum: 1 }); // Per-vendor duplicate detection by content hash
FileSchema.index({ orphanedAt: 1 }); // Lonely-file deletion sweep (file-cleanup module)
// The plan-quota sweep's ordering index. `createdAt` ASC is the blocking order itself
// (oldest-first until the cap is reached), so this is not merely a filter — the sweep
// walks it in index order. Built by `migrate:plan-quota-indexes`; autoIndex is off in
// production, and without it every recompute collection-scans `files`.
FileSchema.index({ ownerType: 1, ownerId: 1, deletedAt: 1, createdAt: 1 });
// FileSchema.index({ deletedAt: 1 }); // Soft delete queries

export const FileModel =
  (mongoose.models.File as mongoose.Model<IFile>) ||
  model<IFile>(MODELS.FILE, FileSchema, COLLECTIONS.FILE);
