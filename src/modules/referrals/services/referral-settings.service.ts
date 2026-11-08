import { Types } from 'mongoose';
import { ActorRef } from '../../../core/types/actor-source.types';
import { EARNING_CATEGORIES, EarningCategory, GlobalTerms, REFERRAL_DEFAULTS } from '../domain/referral-rules';
import { REFERRAL_SETTINGS_KEY, ReferralSettingsModel } from '../models/referral-settings.model';

export interface ReferralSettingsView {
  enabled: boolean;
  terms: GlobalTerms;
  minPayoutAmount: number;
  rewardWaitDays: number;
  updatedAt: Date | null;
}

export interface ReferralSettingsPatch {
  enabled?: boolean;
  terms?: Partial<Record<EarningCategory, { ratePercent?: number; durationMonths?: number }>>;
  minPayoutAmount?: number;
  rewardWaitDays?: number;
}

function defaultTerms(): GlobalTerms {
  const terms = {} as GlobalTerms;
  for (const category of EARNING_CATEGORIES) {
    terms[category] = {
      rate_percent: REFERRAL_DEFAULTS.ratePercent,
      duration_months: REFERRAL_DEFAULTS.durationMonths,
    };
  }
  return terms;
}

/** The only writer of `referral_settings`. Absent means the defaults, with the program off. */
export class ReferralSettingsService {
  async get(): Promise<ReferralSettingsView> {
    const row = await ReferralSettingsModel.findOne({ key: REFERRAL_SETTINGS_KEY }).lean();
    if (!row) {
      return {
        enabled: REFERRAL_DEFAULTS.enabled,
        terms: defaultTerms(),
        minPayoutAmount: REFERRAL_DEFAULTS.minPayoutAmount,
        rewardWaitDays: REFERRAL_DEFAULTS.rewardWaitDays,
        updatedAt: null,
      };
    }
    // A category added after the document was written (`provider`, 2026-11-08) reads its defaults.
    const terms = defaultTerms();
    for (const category of EARNING_CATEGORIES) {
      const stored = (row.terms as Partial<GlobalTerms> | undefined)?.[category];
      if (stored) terms[category] = { rate_percent: stored.rate_percent, duration_months: stored.duration_months };
    }
    return {
      enabled: row.enabled,
      terms,
      minPayoutAmount: row.min_payout_amount,
      rewardWaitDays: row.reward_wait_days,
      updatedAt: row.updated_at,
    };
  }

  async update(patch: ReferralSettingsPatch, actor: ActorRef): Promise<ReferralSettingsView> {
    const set: Record<string, unknown> = {
      updated_by: Types.ObjectId.isValid(actor.userId) ? new Types.ObjectId(actor.userId) : null,
      updated_by_source: actor.source,
      updated_by_name: actor.name ?? null,
    };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.minPayoutAmount !== undefined) set.min_payout_amount = patch.minPayoutAmount;
    if (patch.rewardWaitDays !== undefined) set.reward_wait_days = patch.rewardWaitDays;
    for (const category of EARNING_CATEGORIES) {
      const terms = patch.terms?.[category];
      if (terms?.ratePercent !== undefined) set[`terms.${category}.rate_percent`] = terms.ratePercent;
      if (terms?.durationMonths !== undefined) set[`terms.${category}.duration_months`] = terms.durationMonths;
    }
    await ReferralSettingsModel.updateOne(
      { key: REFERRAL_SETTINGS_KEY },
      { $set: set },
      { upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return this.get();
  }
}

export const referralSettingsService = new ReferralSettingsService();
