import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { IPayoutMethod, PayoutMethodOutput } from '../../../core/types/payout.types';
import { payoutRequestService } from '../../earnings/services/payout-request.service';
import { IPayoutRequest, PayoutRequestModel } from '../../earnings/models/payout-request.model';
import { UserModel } from '../../users/user.model';
import { ActorRole } from '../../tickets/types/ticket.types';
import { isBalanceFrozen } from '../domain/referral-rules';
import { IReferralPartner, ReferralPartnerModel } from '../models/referral-partner.model';
import { ReferralRelationshipModel } from '../models/referral-relationship.model';
import { ReferralSettingsService, referralSettingsService } from './referral-settings.service';
import { resolveReferralPayoutDestination } from './referral-payout-destination';

/**
 * Withdrawal (REFERRAL-PROGRAM-PLAN § 5.7): the existing payout pipeline, ticket and transfer
 * included, with the program's own minimum.
 */
export class ReferralPayoutService {
  constructor(private readonly settings: ReferralSettingsService = referralSettingsService) {}

  async request(partner: IReferralPartner, userId: string): Promise<IPayoutRequest> {
    if (isBalanceFrozen(partner)) {
      throw createAppError(ERROR_CODES.REFERRAL_BALANCE_FROZEN, 409, undefined, { status: partner.status });
    }
    const settings = await this.settings.get();
    const destination = await resolveReferralPayoutDestination(partner);
    return payoutRequestService.requestPayout(
      'referral_partner',
      partner._id.toString(),
      userId,
      ActorRole.ADMIN,
      'manual',
      {
        minAmount: settings.minPayoutAmount,
        ticketNote: await this.ticketNote(partner, destination.method),
      }
    );
  }

  /**
   * Save the partner's own destination. Refused when a role on the account already holds one, since
   * that one is what payouts use and it is edited on its existing page (owner R-4).
   */
  async setOwnDestination(partner: IReferralPartner, method: PayoutMethodOutput): Promise<IReferralPartner> {
    const destination = await resolveReferralPayoutDestination(partner);
    if (!destination.editableHere) {
      throw createAppError(ERROR_CODES.REFERRAL_PAYOUT_METHOD_MANAGED_ELSEWHERE, 409, undefined, {
        source: destination.source,
      });
    }
    const updated = await ReferralPartnerModel.findByIdAndUpdate(
      partner._id,
      { $set: { payout_details: [method] } },
      { new: true, runValidators: true }
    );
    return updated as IReferralPartner;
  }

  async listPayouts(partnerId: Types.ObjectId, page: number, limit: number) {
    const query = { owner_type: 'referral_partner', owner_id: partnerId };
    const [data, total] = await Promise.all([
      PayoutRequestModel.find(query).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit),
      PayoutRequestModel.countDocuments(query),
    ]);
    return { data, total };
  }

  /**
   * What the reviewer reads on the payout ticket. A partner has no KYC of their own, so this replaces
   * that line, and it warns when the destination is a phone a referred account signed up with: what a
   * person referring themself through a second number looks like (document § 4). Stated, not enforced.
   */
  private async ticketNote(partner: IReferralPartner, method: IPayoutMethod | null): Promise<string> {
    const counted = await ReferralRelationshipModel.countDocuments({ partner_id: partner._id });
    const lines = [`Referral code: ${partner.code ?? 'none'}. Accounts referred: ${counted}. Status: ${partner.status}.`];
    const phone = method?.mobile_money?.phone_number;
    if (phone) {
      const holder = await UserModel.findOne({ login_phone: phone }).select('_id').lean();
      const matches = holder
        ? await ReferralRelationshipModel.exists({ partner_id: partner._id, referred_user_id: holder._id })
        : null;
      if (matches) {
        lines.push('⚠ This payout number is the phone of an account this partner referred. Check for self-referral before releasing funds.');
      }
    }
    return lines.join('\n');
  }
}

export const referralPayoutService = new ReferralPayoutService();
