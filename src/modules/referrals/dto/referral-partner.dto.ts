import { maskPayoutMethod, PayoutMethodMasked } from '../../../core/types/payout.types';
import { IPayoutRequest } from '../../earnings/models/payout-request.model';
import { VendorModel } from '../../vendors/vendor.model';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../../agents/models/agent.model';
import {
  maskDisplayName,
  paymentKindOf,
  referralTelegramStart,
  referralWhatsappText,
  ReferredCategory,
  RewardPaymentKind,
} from '../domain/referral-rules';
import { IReferralRelationship } from '../models/referral-relationship.model';
import { IReferralReward } from '../models/referral-reward.model';

/**
 * What a partner may see (owner R-8), and the reason these are DTOs rather than documents.
 *
 * ⛔ **No order, booking, product, vendor, commission or base figure may be added here.** Combined
 * with a vendor's plan, a commission reveals that vendor's sales, and an order reveals what a person
 * bought. `test:referrals` asserts these keys and fails on a new one.
 */
export interface PartnerReferredDto {
  id: string;
  name: string;
  category: ReferredCategory;
  registeredAt: string;
  expiresAt: string | null;
  earning: boolean;
  totalEarned: number;
}

export interface PartnerRewardDto {
  id: string;
  name: string;
  category: string;
  amount: number;
  currency: string;
  status: 'held' | 'released' | 'reversed';
  earnedAt: string;
  availableFrom: string;
  adjusted: boolean;
  /**
   * A provider reward's source KIND (owner RS-7, 2026-11-08): `plan` or `credits`. Never the price
   * the provider paid, which would reveal another business's spending. Null on a commission reward.
   */
  paymentKind: RewardPaymentKind | null;
}

export interface PartnerPayoutDto {
  id: string;
  amount: number;
  currency: string;
  status: string;
  destination: PayoutMethodMasked;
  rejectionReason: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

export function toPartnerReferredDto(
  row: IReferralRelationship,
  name: string | null,
  totalEarned: number,
  now: Date
): PartnerReferredDto {
  return {
    id: row._id.toString(),
    name: maskDisplayName(name),
    category: row.category,
    registeredAt: row.registered_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    earning: !!row.expires_at && row.expires_at.getTime() > now.getTime(),
    totalEarned,
  };
}

export function toPartnerRewardDto(row: IReferralReward, name: string | null): PartnerRewardDto {
  return {
    id: row._id.toString(),
    name: maskDisplayName(name),
    category: row.category,
    amount: row.amount - row.clawed_amount,
    currency: row.currency,
    status: row.status,
    earnedAt: row.earned_at.toISOString(),
    availableFrom: row.matures_at.toISOString(),
    adjusted: row.clawed_amount > 0,
    paymentKind: paymentKindOf(row.source_type),
  };
}

export function toPartnerPayoutDto(row: IPayoutRequest): PartnerPayoutDto {
  return {
    id: row._id.toString(),
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    destination: maskPayoutMethod(row.payout_method_snapshot, true),
    rejectionReason: row.rejection_reason ?? null,
    requestedAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

/** The display name per referred user, for the masks above. One query per role, and only what is needed. */
export async function referredNames(
  people: ReadonlyArray<{ userId: string; category: string }>
): Promise<Map<string, string>> {
  const ids = (category: string) => people.filter((p) => p.category === category).map((p) => p.userId);
  // A provider is a vendor whose kind is `provider` (2026-11-08): named from the same rows.
  const sellerAndProviderUsers = [...ids('vendor'), ...ids('provider')];
  const [customers, vendors, agencies, agents] = await Promise.all([
    CustomerModel.find({ user_id: { $in: ids('customer') } }).select('user_id name').lean(),
    VendorModel.find({ user_id: { $in: sellerAndProviderUsers } }).select('user_id display_name').lean(),
    DeliveryAgencyModel.find({ user_id: { $in: ids('agency') } }).select('user_id display_name').lean(),
    DeliveryAgentModel.find({ user_id: { $in: ids('agent') } }).select('user_id name').lean(),
  ]);
  const names = new Map<string, string>();
  for (const c of customers as any[]) names.set(c.user_id.toString(), c.name);
  for (const v of vendors as any[]) names.set(v.user_id.toString(), v.display_name);
  for (const a of agencies as any[]) names.set(a.user_id.toString(), a.display_name);
  for (const a of agents as any[]) names.set(a.user_id.toString(), a.name);
  return names;
}

/** The links behind a code. Discloses nothing about the partner, on a route with no authentication. */
export function referralLinksOf(code: string | null): {
  registerUrl: string | null;
  whatsappUrl: string | null;
  telegramUrl: string | null;
} {
  const base = (process.env.STOREFRONT_URL || '').replace(/\/+$/, '');
  const digits = (process.env.WA_BOT_NUMBER ?? '').replace(/[^0-9]/g, '');
  const botName = (process.env.TELEGRAM_BOT_NAME ?? '').trim().replace(/^@/, '');
  return {
    registerUrl: base ? `${base}/register${code ? `?ref=${code}` : ''}` : null,
    whatsappUrl: digits
      ? `https://wa.me/${digits}${code ? `?text=${encodeURIComponent(referralWhatsappText(code))}` : ''}`
      : null,
    telegramUrl: botName
      ? `https://t.me/${botName}${code ? `?start=${referralTelegramStart(code)}` : ''}`
      : null,
  };
}
