import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { FileOwnerType } from './file.model';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * Entities that can reference a File. Extend this union (and the schema enum)
 * when a new feature starts attaching files — e.g. 'store', 'kyc_doc'.
 * Nothing else in the file layer needs to change to support a new type.
 */
export type FileReferenceEntityType = 'product' | 'variant' | 'digital_asset' | 'ticket' | 'vendor';

/**
 * FileReference — junction record linking a File to the entity that uses it.
 *
 * This collection is the single source of truth for "what references this file".
 * It replaces the old File.usageCount counter:
 *   - usage / orphan detection counts live rows here instead of trusting a counter
 *   - adding a new file-referencing feature requires no change to the file module
 *
 * A row is soft-deleted (deletedAt) when the reference is removed, so historical
 * links can still be inspected. The unique index makes attach idempotent.
 *
 * `ownerType`/`ownerId` are denormalized from the File's original uploader so
 * per-owner aggregates (e.g. storage quota) can be computed without a join.
 */
export interface IFileReference extends IBaseDocument {
  fileId: Types.ObjectId;
  entityType: FileReferenceEntityType;
  entityId: Types.ObjectId;
  field: string;            // which slot on the entity holds it ('media', 'digitalAsset', ...)
  ownerType?: FileOwnerType; // denormalized from File.ownerType
  ownerId?: Types.ObjectId;  // denormalized from File.ownerId
}

const FileReferenceSchema = new Schema<IFileReference>({
  fileId: { type: Schema.Types.ObjectId, ref: MODELS.FILE, required: true },
  entityType: {
    type: String,
    enum: ['product', 'variant', 'digital_asset', 'ticket', 'vendor'],
    required: true,
  },
  entityId: { type: Schema.Types.ObjectId, required: true },
  field: { type: String, required: true, default: 'media' },
  ownerType: {
    type: String,
    enum: ['vendor', 'admin', 'customer', 'agent', 'agency', 'system'],
  },
  ownerId: { type: Schema.Types.ObjectId },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// One live row per (file, entity, field): makes attach idempotent and prevents
// double-counting. Partial filter so a removed (soft-deleted) reference can be
// re-created later without colliding with its tombstone.
FileReferenceSchema.index(
  { fileId: 1, entityType: 1, entityId: 1, field: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
// "What references this file?" — usage + orphan queries.
FileReferenceSchema.index({ fileId: 1, deletedAt: 1 });
// "What files does this entity use?" — cascade cleanup on entity delete.
FileReferenceSchema.index({ entityType: 1, entityId: 1, deletedAt: 1 });
// Per-owner aggregates (storage quota, etc.).
FileReferenceSchema.index({ ownerType: 1, ownerId: 1, deletedAt: 1 });

export const FileReferenceModel =
  (mongoose.models.FileReference as mongoose.Model<IFileReference>) ||
  model<IFileReference>(MODELS.FILE_REFERENCE, FileReferenceSchema, COLLECTIONS.FILE_REFERENCE);
