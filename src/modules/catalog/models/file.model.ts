import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export type StorageProvider = 'local' | 's3' | 'gcs' | 'r2';
export type FileOwnerType = 'vendor' | 'system';

/**
 * File Domain Model
 * 
 * Represents a stored file with provider-agnostic metadata.
 * Files are first-class database records that can be shared across products, variants, and digital assets.
 * 
 * Owner fields represent the original uploader and are set once on upload, never mutated.
 * Orphan status is reference-counted based on whether the file is referenced by any entity.
 */
export interface IFile extends IBaseDocument {
  key: string;              // provider-specific key (file path or object key)
  provider: StorageProvider; // storage backend
  mimeType: string;          // MIME type
  size: number;              // file size in bytes
  checksum?: string;         // optional checksum (MD5, SHA256, etc.)
  originalName?: string;     // original filename when uploaded
  
  isOrphan: boolean;         // reference-counted: true if not referenced anywhere
  
  // Original uploader - set once on upload, never mutated
  ownerType?: FileOwnerType; // 'vendor' if uploaded by vendor, 'system' otherwise
  ownerId?: Types.ObjectId;  // vendorId if vendor-uploaded
}

const FileSchema = new Schema<IFile>({
  key: { type: String, required: true },
  provider: { 
    type: String, 
    enum: ['local', 's3', 'gcs', 'r2'], 
    required: true 
  },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  checksum: { type: String },
  originalName: { type: String },
  
  isOrphan: { type: Boolean, default: true, index: true },
  
  ownerType: { 
    type: String, 
    enum: ['vendor', 'system'] 
  },
  ownerId: { type: Schema.Types.ObjectId },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
FileSchema.index({ key: 1, provider: 1 }, { unique: true }); // Unique file per provider
// FileSchema.index({ isOrphan: 1 }); // For garbage collection queries
// FileSchema.index({ deletedAt: 1 }); // Soft delete queries

export const FileModel = 
  (mongoose.models.File as mongoose.Model<IFile>) || 
  model<IFile>('File', FileSchema);
