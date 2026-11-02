import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { maskPayoutMethod, PayoutMethodZodSchema } from '../../../core/types/payout.types';
import { earningsAccountService } from '../../earnings/services/earnings-account.service';
import { EARNING_CATEGORIES, isBalanceFrozen, resolveDuration, resolveRate } from '../domain/referral-rules';
import {
  referralLinksOf,
  referredNames,
  toPartnerPayoutDto,
  toPartnerReferredDto,
  toPartnerRewardDto,
} from '../dto/referral-partner.dto';
import { IReferralPartner, ReferralPartnerModel } from '../models/referral-partner.model';
import { ReferralRelationshipModel } from '../models/referral-relationship.model';
import { ReferralRewardModel } from '../models/referral-reward.model';
import { resolveReferralPayoutDestination } from '../services/referral-payout-destination';
import { referralPayoutService } from '../services/referral-payout.service';
import { referralPartnerService } from '../services/referral-partner.service';
import { referralSettingsService } from '../services/referral-settings.service';
import { ApplySchema, PageQuerySchema } from '../validators/referral.validators';

function pageMeta(total: number, page: number, limit: number) {
  return { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function myPartner(req: Request): Promise<IReferralPartner | null> {
  return ReferralPartnerModel.findOne({ user_id: req.auth!.user.id });
}

async function requirePartner(req: Request): Promise<IReferralPartner> {
  const partner = await myPartner(req);
  if (!partner) throw createAppError(ERROR_CODES.REFERRAL_PARTNER_NOT_FOUND, 404);
  return partner;
}

/**
 * The referral page, for any role (REFERRAL-PROGRAM-PLAN § 5.9). The partner belongs to the person,
 * so it is resolved from `req.auth` whichever role they are signed in as, the way
 * `/api/me/payment-methods` is.
 */
export class MeReferralController {
  /** `GET /api/me/referral`: everything the page needs to decide what to show. */
  static overview = asyncHandler(async (req: Request, res: Response) => {
    const settings = await referralSettingsService.get();
    const partner = await myPartner(req);
    const program = { enabled: settings.enabled, minPayoutAmount: settings.minPayoutAmount, rewardWaitDays: settings.rewardWaitDays };

    if (!partner) {
      sendSuccess(res, { program, status: 'none', canApply: settings.enabled });
      return;
    }

    const [balances, destination, referredCount, earningCount] = await Promise.all([
      earningsAccountService.getBalances('referral_partner', partner._id.toString()),
      resolveReferralPayoutDestination(partner),
      ReferralRelationshipModel.countDocuments({ partner_id: partner._id }),
      ReferralRelationshipModel.countDocuments({ partner_id: partner._id, expires_at: { $gt: new Date() } }),
    ]);
    const terms = Object.fromEntries(
      EARNING_CATEGORIES.map((category) => [
        category,
        {
          ratePercent: resolveRate(category, settings.terms, partner.custom_terms).ratePercent,
          durationMonths: resolveDuration(category, settings.terms, partner.custom_terms).durationMonths,
        },
      ])
    );
    const frozen = isBalanceFrozen(partner);

    sendSuccess(res, {
      program,
      status: partner.status,
      statusReason: partner.status_reason,
      canApply: settings.enabled && (partner.status === 'rejected' || partner.status === 'terminated') && partner.can_reapply,
      code: partner.code,
      // A suspended or terminated partner still sees the code, but it earns nothing and says so here.
      codeActive: partner.status === 'active',
      links: partner.code ? referralLinksOf(partner.code) : null,
      appliedAt: partner.applied_at.toISOString(),
      approvedAt: partner.approved_at ? partner.approved_at.toISOString() : null,
      terms,
      balances,
      balanceFrozen: frozen,
      canWithdraw: !frozen && balances.available >= settings.minPayoutAmount && !!destination.method,
      payoutDestination: {
        source: destination.source,
        editableHere: destination.editableHere,
        method: destination.method ? maskPayoutMethod(destination.method, true) : null,
      },
      referred: { total: referredCount, earning: earningCount },
    });
  });

  /** `POST /api/me/referral/application` */
  static apply = asyncHandler(async (req: Request, res: Response) => {
    const input = ApplySchema.parse(req.body ?? {});
    const partner = await referralPartnerService.apply(req.auth!.user.id, req.auth!.role, { motivation: input.motivation });
    sendSuccess(res, { status: partner.status, appliedAt: partner.applied_at.toISOString() }, { status: 201 });
  });

  /** `GET /api/me/referral/referred` */
  static referred = asyncHandler(async (req: Request, res: Response) => {
    const partner = await requirePartner(req);
    const { page, limit } = PageQuerySchema.parse(req.query);
    const query = { partner_id: partner._id };
    const [rows, total] = await Promise.all([
      ReferralRelationshipModel.find(query).sort({ registered_at: -1 }).skip((page - 1) * limit).limit(limit),
      ReferralRelationshipModel.countDocuments(query),
    ]);
    const [names, earned] = await Promise.all([
      referredNames(rows.map((r) => ({ userId: r.referred_user_id.toString(), category: r.category }))),
      ReferralRewardModel.aggregate<{ _id: Types.ObjectId; total: number }>([
        { $match: { relationship_id: { $in: rows.map((r) => r._id) } } },
        { $group: { _id: '$relationship_id', total: { $sum: { $subtract: ['$amount', '$clawed_amount'] } } } },
      ]),
    ]);
    const earnedById = new Map(earned.map((e) => [e._id.toString(), e.total]));
    const now = new Date();
    sendSuccess(
      res,
      rows.map((r) =>
        toPartnerReferredDto(r, names.get(r.referred_user_id.toString()) ?? null, earnedById.get(r._id.toString()) ?? 0, now)
      ),
      { meta: pageMeta(total, page, limit) }
    );
  });

  /** `GET /api/me/referral/rewards` */
  static rewards = asyncHandler(async (req: Request, res: Response) => {
    const partner = await requirePartner(req);
    const { page, limit } = PageQuerySchema.parse(req.query);
    const query = { partner_id: partner._id };
    const [rows, total] = await Promise.all([
      ReferralRewardModel.find(query).sort({ earned_at: -1 }).skip((page - 1) * limit).limit(limit),
      ReferralRewardModel.countDocuments(query),
    ]);
    const names = await referredNames(rows.map((r) => ({ userId: r.referred_user_id.toString(), category: r.category })));
    sendSuccess(
      res,
      rows.map((r) => toPartnerRewardDto(r, names.get(r.referred_user_id.toString()) ?? null)),
      { meta: pageMeta(total, page, limit) }
    );
  });

  /** `GET /api/me/referral/payouts` */
  static payouts = asyncHandler(async (req: Request, res: Response) => {
    const partner = await requirePartner(req);
    const { page, limit } = PageQuerySchema.parse(req.query);
    const { data, total } = await referralPayoutService.listPayouts(partner._id as Types.ObjectId, page, limit);
    sendSuccess(res, data.map(toPartnerPayoutDto), { meta: pageMeta(total, page, limit) });
  });

  /** `POST /api/me/referral/payout`: withdraw the whole available balance, as every payout does. */
  static requestPayout = asyncHandler(async (req: Request, res: Response) => {
    const partner = await requirePartner(req);
    const payout = await referralPayoutService.request(partner, req.auth!.user.id);
    sendSuccess(res, toPartnerPayoutDto(payout), { status: 201 });
  });

  /** `PUT /api/me/referral/payout-method`: only for an account with no role destination (owner R-4). */
  static setPayoutMethod = asyncHandler(async (req: Request, res: Response) => {
    const partner = await requirePartner(req);
    const method = PayoutMethodZodSchema.parse(req.body ?? {});
    const updated = await referralPayoutService.setOwnDestination(partner, method);
    const destination = await resolveReferralPayoutDestination(updated);
    sendSuccess(res, {
      source: destination.source,
      editableHere: destination.editableHere,
      method: destination.method ? maskPayoutMethod(destination.method, true) : null,
    });
  });
}
