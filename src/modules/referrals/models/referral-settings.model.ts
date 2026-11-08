import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { actorStampFields, ActorSource } from '../../../core/types/actor-source.types';
import {
  DURATION_MAX_MONTHS,
  DURATION_MIN_MONTHS,
  GlobalTerms,
  RATE_MAX_PERCENT,
  RATE_MIN_PERCENT,
  REFERRAL_DEFAULTS,
} from '../domain/referral-rules';

/**
 * The program's global settings: one document, `key: 'global'`, written only by
 * `ReferralSettingsService`. Absent means the defaults in `referral-rules.ts`, and the program off.
 */
export const REFERRAL_SETTINGS_KEY = 'global';

export interface IReferralSettings extends Document {
  key: string;
  enabled: boolean;
  terms: GlobalTerms;
  min_payout_amount: number;
  reward_wait_days: number;
  updated_by: mongoose.Types.ObjectId | null;
  updated_by_source: ActorSource;
  updated_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const CategoryTermsSchema = new Schema(
  {
    rate_percent: {
      type: Number,
      required: true,
      min: RATE_MIN_PERCENT,
      max: RATE_MAX_PERCENT,
      default: REFERRAL_DEFAULTS.ratePercent,
    },
    duration_months: {
      type: Number,
      required: true,
      min: DURATION_MIN_MONTHS,
      max: DURATION_MAX_MONTHS,
      default: REFERRAL_DEFAULTS.durationMonths,
    },
  },
  { _id: false }
);

const ReferralSettingsSchema = new Schema<IReferralSettings>(
  {
    key: { type: String, required: true, default: REFERRAL_SETTINGS_KEY },
    enabled: { type: Boolean, required: true, default: REFERRAL_DEFAULTS.enabled },
    terms: {
      vendor: { type: CategoryTermsSchema, required: true, default: () => ({}) },
      customer: { type: CategoryTermsSchema, required: true, default: () => ({}) },
      agency: { type: CategoryTermsSchema, required: true, default: () => ({}) },
      // 2026-11-08 (RS-3). The live document predates it, so `ReferralSettingsService.get` fills
      // the defaults for a missing category rather than trusting the stored shape.
      provider: { type: CategoryTermsSchema, required: true, default: () => ({}) },
    },
    min_payout_amount: { type: Number, required: true, min: 1, default: REFERRAL_DEFAULTS.minPayoutAmount },
    reward_wait_days: { type: Number, required: true, min: 0, default: REFERRAL_DEFAULTS.rewardWaitDays },
    updated_by: { type: Schema.Types.ObjectId, default: null },
    ...actorStampFields('updated_by'),
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

ReferralSettingsSchema.index({ key: 1 }, { unique: true });

export const ReferralSettingsModel = mongoose.model<IReferralSettings>(
  MODELS.REFERRAL_SETTINGS,
  ReferralSettingsSchema,
  COLLECTIONS.REFERRAL_SETTINGS
);
