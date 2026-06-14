import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export interface IServiceAvailability extends IBaseDocument {
  serviceConfigId: Types.ObjectId;
  
  dayOfWeek: number; // 0 (Sunday) - 6 (Saturday)
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  
  isDisabled: boolean;
}

const ServiceAvailabilitySchema = new Schema<IServiceAvailability>({
  serviceConfigId: { type: Schema.Types.ObjectId, ref: MODELS.SERVICE_CONFIG, required: true, index: true },
  
  dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  
  isDisabled: { type: Boolean, default: false },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

export const ServiceAvailabilityModel = model<IServiceAvailability>(MODELS.SERVICE_AVAILABILITY, ServiceAvailabilitySchema, COLLECTIONS.SERVICE_AVAILABILITY);
