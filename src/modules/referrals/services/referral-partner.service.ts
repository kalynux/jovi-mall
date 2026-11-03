import { randomInt } from 'crypto';
import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { ActorRef } from '../../../core/types/actor-source.types';
import { TicketNoteService } from '../../tickets/services/ticket-note.service';
import { PayoutRequestModel, PAYOUT_HELD_STATUSES } from '../../earnings/models/payout-request.model';
import { VendorModel } from '../../vendors/vendor.model';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import {
  EARNING_CATEGORIES,
  EarningCategory,
  PARTNER_TRANSITIONS,
  PartnerStatus,
  PartnerVerb,
  referralCodeStem,
} from '../domain/referral-rules';
import { IPartnerStatusChange, IReferralPartner, ReferralPartnerModel } from '../models/referral-partner.model';
import { ReferralSettingsService, referralSettingsService } from './referral-settings.service';
import { notifyPartner } from './referral-notifications';
import { ReferralSituation } from '../../notifications/catalog/referral-notification-catalog';

const CODE_ATTEMPTS = 8;

const VERB_SITUATION: Readonly<Record<PartnerVerb, ReferralSituation>> = {
  approve: 'partner.approved',
  reject: 'partner.rejected',
  suspend: 'partner.suspended',
  reinstate: 'partner.reinstated',
  terminate: 'partner.terminated',
};

/** After the commit, never awaited: a slow or failing send must not hold up an administrator's request. */
function tell(partner: IReferralPartner, situation: ReferralSituation): void {
  void notifyPartner(partner, situation, `${situation}:${partner._id.toString()}:${partner.updated_at.getTime()}`);
}

export interface PartnerTermsPatch {
  terms: Partial<Record<EarningCategory, { ratePercent?: number | null; durationMonths?: number | null }>>;
}

function historyEntry(
  from: PartnerStatus | null,
  to: PartnerStatus,
  at: Date,
  actor: ActorRef | null,
  reason: string | null
): IPartnerStatusChange {
  return {
    from,
    to,
    at,
    actor_id: actor?.userId ?? null,
    actor_source: actor?.source ?? 'platform',
    actor_name: actor?.name ?? null,
    reason,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000;
}

/**
 * The partner lifecycle (REFERRAL-PROGRAM-PLAN § 5.1). Every status change is a compare-and-set on
 * the status it starts from, and appends to `status_history` in the same write: that history is
 * what decides whether a commission earned on a given day pays this partner.
 */
export class ReferralPartnerService {
  constructor(
    private readonly settings: ReferralSettingsService = referralSettingsService,
    private readonly ticketNotes: TicketNoteService = new TicketNoteService()
  ) {}

  /** A registered user asks to join, or asks again after an administrator allowed it (owner R-9). */
  async apply(
    userId: string,
    role: string,
    input: { motivation?: string | null }
  ): Promise<IReferralPartner> {
    const settings = await this.settings.get();
    if (!settings.enabled) throw createAppError(ERROR_CODES.REFERRAL_PROGRAM_DISABLED, 409);

    const now = new Date();
    const existing = await ReferralPartnerModel.findOne({ user_id: userId });
    const motivation = input.motivation?.trim() || null;

    if (existing) {
      if (existing.status !== 'rejected' && existing.status !== 'terminated') {
        throw createAppError(ERROR_CODES.REFERRAL_ALREADY_APPLIED, 409, undefined, { status: existing.status });
      }
      if (!existing.can_reapply) throw createAppError(ERROR_CODES.REFERRAL_REAPPLY_NOT_ALLOWED, 409);
      const reopened = await ReferralPartnerModel.findOneAndUpdate(
        { _id: existing._id, status: existing.status, can_reapply: true },
        {
          $set: {
            status: 'pending',
            can_reapply: false,
            status_reason: null,
            motivation,
            applied_as_role: role,
            terms_accepted_at: now,
            applied_at: now,
          },
          $push: { status_history: historyEntry(existing.status, 'pending', now, null, null) },
        },
        { new: true }
      );
      if (!reopened) throw createAppError(ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT, 409);
      return reopened;
    }

    try {
      return await ReferralPartnerModel.create({
        user_id: userId,
        applied_as_role: role,
        status: 'pending',
        motivation,
        terms_accepted_at: now,
        applied_at: now,
        status_history: [historyEntry(null, 'pending', now, null, null)],
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw createAppError(ERROR_CODES.REFERRAL_ALREADY_APPLIED, 409);
      throw error;
    }
  }

  async transition(
    partnerId: string,
    verb: PartnerVerb,
    actor: ActorRef,
    reason: string | null
  ): Promise<IReferralPartner> {
    const partner = await this.getOrThrow(partnerId);
    const rule = PARTNER_TRANSITIONS[verb];
    if (!rule.from.includes(partner.status)) {
      throw createAppError(ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT, 409, undefined, {
        status: partner.status,
        verb,
      });
    }

    const now = new Date();
    const set: Record<string, unknown> = {
      status: rule.to,
      status_reason: rule.to === 'active' ? null : reason,
    };
    if (verb === 'approve') set.approved_at = now;
    // A reinstated partner is under no freeze, and an earlier release must not carry into a later one.
    if (verb === 'reinstate') set.balance_released = null;

    const update = async (code: string | null) =>
      ReferralPartnerModel.findOneAndUpdate(
        { _id: partner._id, status: partner.status },
        {
          $set: code ? { ...set, code } : set,
          $push: { status_history: historyEntry(partner.status, rule.to, now, actor, reason) },
        },
        { new: true }
      );

    const updated = verb === 'approve' && !partner.code
      ? await this.approveWithNewCode(partner, update)
      : await update(null);
    if (!updated) throw createAppError(ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT, 409);

    if (verb === 'suspend' || verb === 'terminate') await this.notePendingPayout(updated, verb);
    tell(updated, VERB_SITUATION[verb]);
    return updated;
  }

  /** Allow a rejected or terminated person to apply again (owner R-9). */
  async allowReapply(partnerId: string): Promise<IReferralPartner> {
    const updated = await ReferralPartnerModel.findOneAndUpdate(
      { _id: partnerId, status: { $in: ['rejected', 'terminated'] }, can_reapply: false },
      { $set: { can_reapply: true } },
      { new: true }
    );
    if (updated) {
      tell(updated, 'partner.reapply_allowed');
      return updated;
    }
    const partner = await this.getOrThrow(partnerId);
    throw createAppError(ERROR_CODES.REFERRAL_PARTNER_STATUS_CONFLICT, 409, undefined, {
      status: partner.status,
      canReapply: partner.can_reapply,
    });
  }

  /** Let a suspended or terminated partner withdraw what they had earned (owner R-9). */
  async releaseBalance(partnerId: string, actor: ActorRef, reason: string): Promise<IReferralPartner> {
    const updated = await ReferralPartnerModel.findOneAndUpdate(
      { _id: partnerId, status: { $in: ['suspended', 'terminated'] }, balance_released: null },
      {
        $set: {
          balance_released: { at: new Date(), actor_id: actor.userId, actor_name: actor.name ?? null, reason },
        },
      },
      { new: true }
    );
    if (updated) {
      tell(updated, 'partner.balance_released');
      return updated;
    }
    const partner = await this.getOrThrow(partnerId);
    throw createAppError(ERROR_CODES.REFERRAL_BALANCE_NOT_FROZEN, 409, undefined, { status: partner.status });
  }

  /**
   * Set or clear per-partner terms. Each field stands alone and `null` returns it to the global
   * value (document § 9). A rate applies to this partner's next commission; a duration applies to
   * their next referral, because an existing referral's expiry is frozen.
   */
  async updateTerms(partnerId: string, patch: PartnerTermsPatch): Promise<IReferralPartner> {
    const set: Record<string, unknown> = {};
    for (const category of EARNING_CATEGORIES) {
      const terms = patch.terms[category];
      if (terms?.ratePercent !== undefined) set[`custom_terms.${category}.rate_percent`] = terms.ratePercent;
      if (terms?.durationMonths !== undefined) set[`custom_terms.${category}.duration_months`] = terms.durationMonths;
    }
    const partner = await this.getOrThrow(partnerId);
    if (Object.keys(set).length === 0) return partner;

    // A category never customised holds a null sub-document, and Mongo cannot `$set` a path through
    // null, so it is created first.
    const empty: Record<string, unknown> = {};
    for (const category of EARNING_CATEGORIES) {
      if (patch.terms[category] && !partner.custom_terms?.[category]) {
        empty[`custom_terms.${category}`] = { rate_percent: null, duration_months: null };
      }
    }
    if (Object.keys(empty).length > 0) await ReferralPartnerModel.updateOne({ _id: partner._id }, { $set: empty });
    const updated = await ReferralPartnerModel.findByIdAndUpdate(partner._id, { $set: set }, { new: true, runValidators: true });
    return updated as IReferralPartner;
  }

  async getOrThrow(partnerId: string): Promise<IReferralPartner> {
    const partner = Types.ObjectId.isValid(partnerId) ? await ReferralPartnerModel.findById(partnerId) : null;
    if (!partner) throw createAppError(ERROR_CODES.REFERRAL_PARTNER_NOT_FOUND, 404);
    return partner;
  }

  private async approveWithNewCode(
    partner: IReferralPartner,
    update: (code: string | null) => Promise<IReferralPartner | null>
  ): Promise<IReferralPartner | null> {
    const stem = referralCodeStem(await this.nameOf(partner.user_id, partner.applied_as_role));
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      // Three digits first, as in the document's ULRICH123, then more if the name is a common one.
      const digits = attempt < 4 ? 3 : 6;
      const code = `${stem}${randomInt(10 ** (digits - 1), 10 ** digits)}`;
      try {
        return await update(code);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    throw createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 500, 'Could not generate a unique referral code');
  }

  private async nameOf(userId: Types.ObjectId, role: string): Promise<string | null> {
    const query = { user_id: userId };
    if (role === 'vendor') return (await VendorModel.findOne(query).select('display_name').lean())?.display_name ?? null;
    if (role === 'agency') return (await DeliveryAgencyModel.findOne(query).select('display_name').lean())?.display_name ?? null;
    if (role === 'agent') return (await DeliveryAgentModel.findOne(query).select('name').lean())?.name ?? null;
    return (await CustomerModel.findOne(query).select('name').lean())?.name ?? null;
  }

  /**
   * A payout already waiting is not cancelled: the administrator deciding it is told, and rejecting
   * it returns the money to the frozen balance. Best-effort, like the clawback's equivalent note.
   */
  private async notePendingPayout(partner: IReferralPartner, verb: PartnerVerb): Promise<void> {
    try {
      const payout = await PayoutRequestModel.findOne({
        owner_type: 'referral_partner',
        owner_id: partner._id,
        status: { $in: [...PAYOUT_HELD_STATUSES] },
      }).lean();
      if (!payout?.ticket_id) return;
      await this.ticketNotes.createSystemNote(
        payout.ticket_id.toString(),
        `This referral partner was ${verb === 'suspend' ? 'suspended' : 'terminated'} while this payout was waiting. ` +
          'It is NOT cancelled automatically. If you reject it, the money returns to their frozen balance.'
      );
    } catch (error) {
      console.error(`[ReferralPartner] Could not note the pending payout of partner ${String(partner._id)}:`, error);
    }
  }
}

export const referralPartnerService = new ReferralPartnerService();
