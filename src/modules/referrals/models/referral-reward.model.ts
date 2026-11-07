import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { EarningsSourceType } from '../../earnings/models/earnings-allocation.model';
import { AdjustmentTakenFrom } from '../../earnings/models/earnings-adjustment.model';
import { EARNING_CATEGORIES, EarningCategory, RewardShare } from '../domain/referral-rules';

/**
 * One partner's reward for one referred account on one commission.
 *
 * ⚠ **Deliberately not an `earnings_allocations` row.** That collection is unique on (source,
 * beneficiary), and one partner who referred both the vendor and the customer earns twice on one
 * commission. Its rows also feed `NET_FORMULA`, statements and the money split, none of which
 * this program may change.
 *
 * `amount` is the reward as first calculated and is never edited, like an allocation's. What a
 * refund takes is `clawed_amount`, so what is left is `amount − clawed_amount`. `rate_percent` and
 * `share` are saved so a recalculation after a refund uses the terms of the day it was earned,
 * never today's (document § 10).
 */
export const REFERRAL_REWARD_STATUSES = ['held', 'released', 'reversed'] as const;
export type ReferralRewardStatus = (typeof REFERRAL_REWARD_STATUSES)[number];

export interface IReferralRewardAdjustment {
  at: Date;
  refund_key: string | null;
  commission_retained: number;
  amount_before: number;
  amount_after: number;
  taken_from: AdjustmentTakenFrom;
}

export interface IReferralReward extends Document {
  partner_id: mongoose.Types.ObjectId;
  relationship_id: mongoose.Types.ObjectId;
  referred_user_id: mongoose.Types.ObjectId;
  category: EarningCategory;

  /** The commission this came from. */
  commission_allocation_id: mongoose.Types.ObjectId;
  source_type: EarningsSourceType;
  source_id: mongoose.Types.ObjectId;
  /** The order or booking behind the source, which a COD collection's own id does not say. */
  order_id: mongoose.Types.ObjectId | null;
  booking_id: mongoose.Types.ObjectId | null;
  vendor_id: mongoose.Types.ObjectId;

  /** What Wi-Mall retained of the commission when this was earned. */
  commission_earned: number;
  share: RewardShare;
  rate_percent: number;
  rate_source: 'global' | 'custom';
  amount: number;
  clawed_amount: number;
  currency: string;

  status: ReferralRewardStatus;
  earned_at: Date;
  matures_at: Date;
  released_at: Date | null;
  reversed_at: Date | null;
  adjustments: IReferralRewardAdjustment[];

  created_at: Date;
  updated_at: Date;
}

const TakenFromSchema = new Schema(
  {
    pending: { type: Number, required: true, default: 0 },
    reserve: { type: Number, required: true, default: 0 },
    available: { type: Number, required: true, default: 0 },
    debt: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const ReferralRewardSchema = new Schema<IReferralReward>(
  {
    partner_id: { type: Schema.Types.ObjectId, ref: MODELS.REFERRAL_PARTNER, required: true },
    relationship_id: { type: Schema.Types.ObjectId, ref: MODELS.REFERRAL_RELATIONSHIP, required: true },
    referred_user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true },
    category: { type: String, enum: EARNING_CATEGORIES, required: true },

    commission_allocation_id: { type: Schema.Types.ObjectId, ref: MODELS.EARNINGS_ALLOCATION, required: true },
    source_type: { type: String, enum: ['order', 'booking', 'cod_collection'], required: true },
    source_id: { type: Schema.Types.ObjectId, required: true },
    order_id: { type: Schema.Types.ObjectId, ref: MODELS.ORDER, default: null },
    booking_id: { type: Schema.Types.ObjectId, default: null },
    vendor_id: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },

    commission_earned: { type: Number, required: true, min: 0 },
    share: {
      type: new Schema(
        {
          numerator: { type: Number, required: true, min: 0 },
          denominator: { type: Number, required: true, min: 1 },
        },
        { _id: false }
      ),
      required: true,
    },
    rate_percent: { type: Number, required: true, min: 0, max: 25 },
    rate_source: { type: String, enum: ['global', 'custom'], required: true },
    amount: { type: Number, required: true, min: 1 },
    clawed_amount: { type: Number, required: true, default: 0, min: 0 },
    currency: { type: String, required: true, uppercase: true, trim: true },

    status: { type: String, enum: REFERRAL_REWARD_STATUSES, required: true, default: 'held' },
    earned_at: { type: Date, required: true },
    matures_at: { type: Date, required: true },
    released_at: { type: Date, default: null },
    reversed_at: { type: Date, default: null },
    adjustments: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            refund_key: { type: String, default: null },
            commission_retained: { type: Number, required: true, min: 0 },
            amount_before: { type: Number, required: true, min: 0 },
            amount_after: { type: Number, required: true, min: 0 },
            taken_from: { type: TakenFromSchema, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// A retried evaluation cannot pay the same account twice on the same commission (document § 6).
ReferralRewardSchema.index({ commission_allocation_id: 1, relationship_id: 1 }, { unique: true });
ReferralRewardSchema.index({ status: 1, matures_at: 1 });
ReferralRewardSchema.index({ partner_id: 1, earned_at: -1 });
ReferralRewardSchema.index({ relationship_id: 1, earned_at: -1 });
ReferralRewardSchema.index({ order_id: 1 });
ReferralRewardSchema.index({ booking_id: 1 });

export const ReferralRewardModel = mongoose.model<IReferralReward>(
  MODELS.REFERRAL_REWARD,
  ReferralRewardSchema,
  COLLECTIONS.REFERRAL_REWARD
);
