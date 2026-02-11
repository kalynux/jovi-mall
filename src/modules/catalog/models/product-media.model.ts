import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export type MediaOwnerType = 'product' | 'variant';

export interface IProductMedia extends IBaseDocument {
  ownerType: MediaOwnerType;
  ownerId: Types.ObjectId;
  
  provider: string; // 'local', 's3', 'cloudinary'
  path: string;
  mimeType: string;
  size: number; // in bytes
}

const ProductMediaSchema = new Schema<IProductMedia>({
  ownerType: { 
    type: String, 
    enum: ['product', 'variant'], 
    required: true 
  },
  ownerId: { type: Schema.Types.ObjectId, required: true }, // Dynamic ref, index below
  
  provider: { type: String, required: true },
  path: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
ProductMediaSchema.index({ ownerId: 1, ownerType: 1 });

export const ProductMediaModel = model<IProductMedia>('ProductMedia', ProductMediaSchema);
