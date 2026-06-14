import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export interface IProductOption extends IBaseDocument {
  productId: Types.ObjectId;
  name: string;
  position: number; // Order in which options appear (1, 2, 3) - for stable signature generation
}

const ProductOptionSchema = new Schema<IProductOption>({
  productId: { type: Schema.Types.ObjectId, ref: MODELS.PRODUCT, required: true, index: true },
  name: { type: String, required: true },
  position: { type: Number, required: true },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
ProductOptionSchema.index({ productId: 1, name: 1 }, { unique: true });
ProductOptionSchema.index({ productId: 1, position: 1 });

export const ProductOptionModel = model<IProductOption>(MODELS.PRODUCT_OPTION, ProductOptionSchema, COLLECTIONS.PRODUCT_OPTION);
