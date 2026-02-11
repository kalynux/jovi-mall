import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export interface IPricingRule {
  durationMinutes: number;
  price: number;
}

export interface IServiceConfig extends IBaseDocument {
  productId: Types.ObjectId;
  
  slotDurationMinutes: number;
  bufferTimeMinutes: number;
  
  timezone: string;
  
  pricingRules: IPricingRule[];
}

const ServiceConfigSchema = new Schema<IServiceConfig>({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  
  slotDurationMinutes: { type: Number, required: true },
  bufferTimeMinutes: { type: Number, default: 0 },
  
  timezone: { type: String, required: true },
  
  pricingRules: [{
    durationMinutes: { type: Number, required: true },
    price: { type: Number, required: true }
  }],
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

export const ServiceConfigModel = model<IServiceConfig>('ServiceConfig', ServiceConfigSchema);
