import { Types } from 'mongoose';
import { BOT_SURFACE_DB, getRedisClient } from '../../../infra/redis/redis.factory';
import {
  isEarningCategory,
  normalizeReferralCode,
  referralExpiresAt,
  ReferredCategory,
  resolveDuration,
} from '../domain/referral-rules';
import { ReferralPartnerModel } from '../models/referral-partner.model';
import { ReferralRelationshipModel } from '../models/referral-relationship.model';
import { ReferralSettingsService, referralSettingsService } from './referral-settings.service';

export interface AttachReferralInput {
  /** The `users` row that was created this instant. Never an existing account (document § 4). */
  userId: Types.ObjectId | string;
  category: ReferredCategory;
  code: unknown;
  channel: 'web' | 'whatsapp' | 'telegram';
  registeredAt?: Date;
}

/** A Telegram chat has no account until the contact is shared, so its code waits here. */
const PENDING_CODE_TTL_SECONDS = 7 * 24 * 60 * 60;

function pendingKey(channel: string, externalId: string): string {
  return `referral:pending:${channel}:${externalId}`;
}

/**
 * Records who referred a new account (REFERRAL-PROGRAM-PLAN § 5.2).
 *
 * ⛔ **`attach` NEVER THROWS, and that is the requirement rather than a convenience.** An unknown
 * code, a suspended partner, a disabled program and a database fault must all leave an ordinary new
 * account: the owner's document says a suspended partner's link registers "simple new users", and a
 * registration must not fail for the sake of a referral.
 *
 * Called only from the two places that create a `users` row, never from `addRole`. That is what
 * makes an existing account unreferrable and a role added later unearning (owner R-6).
 */
export class ReferralAttributionService {
  constructor(private readonly settings: ReferralSettingsService = referralSettingsService) {}

  async attach(input: AttachReferralInput): Promise<void> {
    const code = normalizeReferralCode(input.code);
    if (!code) return;
    try {
      const settings = await this.settings.get();
      if (!settings.enabled) return;

      const partner = await ReferralPartnerModel.findOne({ code, status: 'active' }).lean();
      if (!partner) return;

      const referredUserId = new Types.ObjectId(input.userId.toString());
      // Phone and email are unique, so a new account cannot be its partner's own. Kept as the check
      // the owner's document asks for, in case an account is ever created another way.
      if (partner.user_id.equals(referredUserId)) return;

      const registeredAt = input.registeredAt ?? new Date();
      const expiresAt = isEarningCategory(input.category)
        ? referralExpiresAt(
          registeredAt,
          resolveDuration(input.category, settings.terms, partner.custom_terms).durationMonths
        )
        : null;

      await ReferralRelationshipModel.create({
        partner_id: partner._id,
        partner_user_id: partner.user_id,
        referred_user_id: referredUserId,
        category: input.category,
        code_used: code,
        channel: input.channel,
        registered_at: registeredAt,
        expires_at: expiresAt,
      });
    } catch (error) {
      const duplicate = (error as { code?: number } | null)?.code === 11000;
      if (!duplicate) console.error('[ReferralAttribution] Could not record a referral:', error);
    }
  }

  /** Telegram's `/start ref_CODE`: nothing to attach it to yet. Fail-open, like every bot-side store. */
  async rememberPendingCode(channel: string, externalId: string, code: string): Promise<void> {
    try {
      const redis = await getRedisClient(BOT_SURFACE_DB);
      await redis.set(pendingKey(channel, externalId), code, { EX: PENDING_CODE_TTL_SECONDS });
    } catch (error) {
      console.error('[ReferralAttribution] Could not remember a pending code:', error);
    }
  }

  async consumePendingCode(channel: string, externalId: string): Promise<string | null> {
    try {
      const redis = await getRedisClient(BOT_SURFACE_DB);
      const key = pendingKey(channel, externalId);
      const code = await redis.get(key);
      if (code) await redis.del(key);
      return code;
    } catch (error) {
      console.error('[ReferralAttribution] Could not read a pending code:', error);
      return null;
    }
  }
}

export const referralAttributionService = new ReferralAttributionService();
