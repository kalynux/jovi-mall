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

export const ProductOptionValueModel = model<IProductOptionValue>('ProductOptionValue', ProductOptionValueSchema);
