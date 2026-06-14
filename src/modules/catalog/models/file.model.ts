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

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
FileSchema.index({ key: 1, provider: 1 }, { unique: true }); // Unique file per provider
FileSchema.index({ ownerId: 1, checksum: 1 }); // Per-vendor duplicate detection by content hash
// FileSchema.index({ deletedAt: 1 }); // Soft delete queries

export const FileModel =
  (mongoose.models.File as mongoose.Model<IFile>) ||
  model<IFile>(MODELS.FILE, FileSchema, COLLECTIONS.FILE);
