import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { adminCallerActor } from '../../../api/middlewares/admin-caller.middleware';
import { sendSuccess } from '../../../core/responses';
import { ActorRef } from '../../../core/types/actor-source.types';
import { PartnerVerb } from '../domain/referral-rules';
import { IReferralPartner } from '../models/referral-partner.model';
import { referralPartnerService } from '../services/referral-partner.service';
import { referralSettingsService } from '../services/referral-settings.service';
import {
  OptionalReasonBodySchema,
  RequiredReasonBodySchema,
  UpdatePartnerTermsSchema,
  UpdateSettingsSchema,
} from '../validators/referral.validators';

function actorOf(req: Request): ActorRef {
  const actor = adminCallerActor(req);
  return { userId: actor?.id ?? req.auth!.user.id, source: 'admin', name: actor?.name ?? null };
}

/** A thin acknowledgement: wi-admin re-reads its own projection after each write. */
function acknowledge(partner: IReferralPartner) {
  return {
    id: partner._id.toString(),
    status: partner.status,
    code: partner.code,
    canReapply: partner.can_reapply,
    balanceReleased: !!partner.balance_released,
  };
}

function withRequiredReason(verb: PartnerVerb) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { reason } = RequiredReasonBodySchema.parse(req.body ?? {});
    sendSuccess(res, acknowledge(await referralPartnerService.transition(req.params.partnerId, verb, actorOf(req), reason)));
  });
}

function withOptionalReason(verb: PartnerVerb) {
  return asyncHandler(async (req: Request, res: Response) => {
    const { reason } = OptionalReasonBodySchema.parse(req.body ?? {});
    sendSuccess(res, acknowledge(await referralPartnerService.transition(req.params.partnerId, verb, actorOf(req), reason ?? null)));
  });
}

/**
 * The write surface wi-admin delegates to (`/api/internal/admin/referrals`). wi-admin READS the
 * referral collections directly (ADR-004) and resolves permissions before calling, so nothing here
 * re-checks a tier.
 */
export class AdminReferralController {
  static approve = withOptionalReason('approve');
  static reject = withRequiredReason('reject');
  static suspend = withRequiredReason('suspend');
  static reinstate = withOptionalReason('reinstate');
  static terminate = withRequiredReason('terminate');

  static allowReapply = asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, acknowledge(await referralPartnerService.allowReapply(req.params.partnerId)));
  });

  static releaseBalance = asyncHandler(async (req: Request, res: Response) => {
    const { reason } = RequiredReasonBodySchema.parse(req.body ?? {});
    sendSuccess(res, acknowledge(await referralPartnerService.releaseBalance(req.params.partnerId, actorOf(req), reason)));
  });

  static updateTerms = asyncHandler(async (req: Request, res: Response) => {
    const patch = UpdatePartnerTermsSchema.parse(req.body ?? {});
    sendSuccess(res, acknowledge(await referralPartnerService.updateTerms(req.params.partnerId, patch)));
  });

  static updateSettings = asyncHandler(async (req: Request, res: Response) => {
    const patch = UpdateSettingsSchema.parse(req.body ?? {});
    const settings = await referralSettingsService.update(patch, actorOf(req));
    sendSuccess(res, { enabled: settings.enabled, updatedAt: settings.updatedAt });
  });
}
