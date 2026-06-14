import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * DigitalAsset - Vendor-owned file for digital products
 * 
 * This model represents a digital file uploaded by a vendor that can be
 * attached to digital products for customer download after purchase.
 * 
 * Links to the File model which handles actual storage provider integration.
 */
export interface IDigitalAsset extends IBaseDocument {
  vendorId: Types.ObjectId;      // Owner of the asset
  fileId: Types.ObjectId;         // Reference to File model (storage)
  originalName: string;           // User-friendly filename
  mimeType: string;               // File content type
  size: number;                   // File size in bytes
}

const DigitalAssetSchema = new Schema<IDigitalAsset>({
  vendorId: { 
    type: Schema.Types.ObjectId, 
    ref: MODELS.VENDOR, 
    required: true, 
    index: true 
  },
  fileId: { 
    type: Schema.Types.ObjectId, 
    ref: MODELS.FILE, 
    required: true,
    index: true
  },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true, min: 0 },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
// DigitalAssetSchema.index({ vendorId: 1 }); // List all assets for a vendor
// DigitalAssetSchema.index({ fileId: 1 }); // Link to storage
// DigitalAssetSchema.index({ deletedAt: 1 }); // Soft delete queries

export const DigitalAssetModel = 
  (mongoose.models.DigitalAsset as mongoose.Model<IDigitalAsset>) || 
  model<IDigitalAsset>(MODELS.DIGITAL_ASSET, DigitalAssetSchema, COLLECTIONS.DIGITAL_ASSET);
