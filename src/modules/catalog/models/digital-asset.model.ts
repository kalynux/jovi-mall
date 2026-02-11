import mongoose, { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export interface IDigitalAsset extends IBaseDocument {
    productId: Types.ObjectId;
    mediaId: Types.ObjectId; // References File model
    downloadLimit?: number;
    isUnlimited: boolean;
    expiresAt?: Date;
}

const DigitalAssetSchema = new Schema<IDigitalAsset>({
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    mediaId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
    downloadLimit: { type: Number },
    isUnlimited: { type: Boolean, default: false },
    expiresAt: { type: Date },
    ...BaseSchemaFields
}, BaseSchemaOptions);

// Use a distinct model name if needed, but 'DigitalAsset' was likely intended
// Using 'CatalogDigitalAsset' to be safe from collision with digital-delivery module
export const DigitalAssetModel =
    (mongoose.models.CatalogDigitalAsset as mongoose.Model<IDigitalAsset>) ||
    model<IDigitalAsset>('CatalogDigitalAsset', DigitalAssetSchema);
