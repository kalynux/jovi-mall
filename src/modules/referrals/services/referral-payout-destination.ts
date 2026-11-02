import { Types } from 'mongoose';
import { IPayoutMethod } from '../../../core/types/payout.types';
import { VendorModel } from '../../vendors/vendor.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';

/**
 * Where a partner's money goes (owner R-4): the destination already on their account, else their
 * own. Read live and never copied into a second record, so editing it on the existing page is
 * what changes it here. A payout freezes its own snapshot at request time, as every payout does.
 *
 * Its own file, importing no service: `PayoutRequestService` needs it, and this keeps that import
 * free of the referral services' graph.
 */
export type ReferralPayoutSource = 'vendor' | 'agency' | 'agent' | 'referral';

export interface ReferralPayoutDestination {
  source: ReferralPayoutSource | null;
  method: IPayoutMethod | null;
  /** True when the referral page may save a destination: no role on the account holds one. */
  editableHere: boolean;
}

const ROLE_SOURCES = ['vendor', 'agency', 'agent'] as const;
type RoleSource = (typeof ROLE_SOURCES)[number];

async function roleMethodOf(role: RoleSource, userId: Types.ObjectId): Promise<IPayoutMethod | null> {
  const query = { user_id: userId };
  const row =
    role === 'vendor' ? await VendorModel.findOne(query).select('payout_details').lean()
      : role === 'agency' ? await DeliveryAgencyModel.findOne(query).select('payout_details').lean()
        : await DeliveryAgentModel.findOne(query).select('payout_details').lean();
  return (row?.payout_details?.[0] as IPayoutMethod | undefined) ?? null;
}

export async function resolveReferralPayoutDestination(partner: {
  user_id: Types.ObjectId;
  applied_as_role: string;
  payout_details?: IPayoutMethod[] | null;
}): Promise<ReferralPayoutDestination> {
  // The role they applied from first, so somebody holding two roles gets the one they were using.
  const order = [...ROLE_SOURCES].sort(
    (a, b) => Number(b === partner.applied_as_role) - Number(a === partner.applied_as_role)
  );
  for (const role of order) {
    const method = await roleMethodOf(role, partner.user_id);
    if (method) return { source: role, method, editableHere: false };
  }
  const own = partner.payout_details?.[0] ?? null;
  return { source: own ? 'referral' : null, method: own, editableHere: true };
}
