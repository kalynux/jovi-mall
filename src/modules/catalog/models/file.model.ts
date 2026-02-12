import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

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
 * usageCount tracks how many entities reference this file:
 * - Incremented atomically when file is attached to product/variant
 * - Decremented atomically when file is detached
 * - Used for safe garbage collection (usageCount === 0)
 * - Enforced at repository level, never client-side
 */
export interface IFile extends IBaseDocument {
  key: string;              // provider-specific key (file path or object key)
  provider: StorageProvider; // storage backend
  mimeType: string;          // MIME type
  size: number;              // file size in bytes
  checksum?: string;         // optional checksum (MD5, SHA256, etc.)
  originalName?: string;     // original filename when uploaded

  usageCount: number;        // reference count for safe cleanup (atomic updates only)

  // Original uploader - set once on upload, never mutated
  ownerType?: FileOwnerType; // 'vendor', 'admin', 'customer', 'agent', 'agency', or 'system'
  ownerId?: Types.ObjectId;  // actorId (null for 'system' owner type)
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

  usageCount: { type: Number, default: 0, min: 0, index: true },

  ownerType: {
    type: String,
    enum: ['vendor', 'admin', 'customer', 'agent', 'agency', 'system']
  },
  ownerId: { type: Schema.Types.ObjectId },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
FileSchema.index({ key: 1, provider: 1 }, { unique: true }); // Unique file per provider
// FileSchema.index({ usageCount: 1 }); // For garbage collection queries (already indexed above)
// FileSchema.index({ deletedAt: 1 }); // Soft delete queries

export const FileModel =
  (mongoose.models.File as mongoose.Model<IFile>) ||
  model<IFile>('File', FileSchema);
