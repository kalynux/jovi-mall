import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

export interface IAvailabilityRule extends IBaseDocument {
  productId: Types.ObjectId;
  vendorId: Types.ObjectId;
  dayOfWeek: number; // 0 (Sunday) - 6 (Saturday), in `timezone`
  startTime: string; // HH:mm wall-clock, in `timezone`
  endTime: string; // HH:mm wall-clock, in `timezone`
  /**
   * IANA timezone the wall-clock times are expressed in (e.g. 'Africa/Douala').
   *
   * Optional: unset means "use the vendor's `timezone`", which is the platform's
   * source of truth. Set it only to override a single rule.
   */
  timezone?: string | null;
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
    // No default: an absent value means "inherit the vendor's timezone" and is a
    // real steady state, not missing data. The old `default: 'UTC'` stamped a zone
    // nobody chose onto every rule — and nothing read it, so the hours were
    // resolved against the server's clock regardless.
    timezone: {
      type: String,
      required: false,
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
