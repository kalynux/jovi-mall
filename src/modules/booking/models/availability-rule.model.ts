import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export interface IAvailabilityRule extends IBaseDocument {
  productId: Types.ObjectId;
  vendorId: Types.ObjectId;
  dayOfWeek: number; // 0 (Sunday) - 6 (Saturday)
  startTime: string; // HH:mm format
  endTime: string; // HH:mm format
  timezone: string; // IANA timezone (e.g., 'America/New_York')
  isActive: boolean;
}

const AvailabilityRuleSchema = new Schema<IAvailabilityRule>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.PRODUCT,
      required: true,
      index: true,
    },
    vendorId: {
      type: Schema.Types.ObjectId,
      ref: MODELS.VENDOR,
      required: true,
      index: true,
    },
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    startTime: {
      type: String,
      required: true,
      match: /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/,
    },
    endTime: {
      type: String,
      required: true,
      match: /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/,
    },
    timezone: {
      type: String,
      required: true,
      default: 'UTC',
    },
    isActive: {
      type: Boolean,
      required: true,
      default: false,
    },
    ...BaseSchemaFields,
  },
  BaseSchemaOptions
);

// Compound index for efficient queries
AvailabilityRuleSchema.index({ productId: 1, isActive: 1 });
AvailabilityRuleSchema.index({ vendorId: 1, isActive: 1 });

export const AvailabilityRule = model<IAvailabilityRule>(MODELS.AVAILABILITY_RULE, AvailabilityRuleSchema, COLLECTIONS.AVAILABILITY_RULE);
