import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export interface IProductOptionValue extends IBaseDocument {
  optionId: Types.ObjectId;
  value: string;
}

const ProductOptionValueSchema = new Schema<IProductOptionValue>({
  optionId: { type: Schema.Types.ObjectId, ref: 'ProductOption', required: true, index: true },
  value: { type: String, required: true },

  ...BaseSchemaFields
}, BaseSchemaOptions);

// Prevent duplicate values within the same option (case-insensitive)
ProductOptionValueSchema.index(
  { optionId: 1, value: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export const ProductOptionValueModel = model<IProductOptionValue>('ProductOptionValue', ProductOptionValueSchema);
