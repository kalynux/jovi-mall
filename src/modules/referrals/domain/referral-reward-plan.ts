import {
  EarningCategory,
  GlobalTerms,
  isEarningCategory,
  isWithinEarningPeriod,
  PartnerOverrides,
  PartnerStatusChange,
  resolveRate,
  rewardAmount,
  RewardShare,
  ReferredCategory,
  wasPartnerActiveAt,
} from './referral-rules';

/**
 * Who earns what on one commission (REFERRAL-PROGRAM-PLAN § 5.4). PURE, so every worked example of
 * the owner's document runs without a database. Each participant is judged alone: one failing never
 * affects the others (document § 12).
 */
export interface CommissionParticipant {
  userId: string;
  category: EarningCategory;
  share: RewardShare;
}

export interface PlanRelationship {
  id: string;
  partnerId: string;
  partnerUserId: string;
  referredUserId: string;
  category: ReferredCategory;
  expiresAt: Date | null;
}

export interface PlanPartner {
  id: string;
  statusHistory: readonly PartnerStatusChange[];
  customTerms: PartnerOverrides | null;
}

export interface PlannedReward {
  relationshipId: string;
  partnerId: string;
  referredUserId: string;
  category: EarningCategory;
  share: RewardShare;
  ratePercent: number;
  rateSource: 'global' | 'custom';
  amount: number;
}

export function planCommissionRewards(input: {
  participants: readonly CommissionParticipant[];
  relationships: readonly PlanRelationship[];
  partners: readonly PlanPartner[];
  globalTerms: GlobalTerms;
  retainedCommission: number;
  earnedAt: Date;
}): PlannedReward[] {
  const relationshipByUser = new Map(input.relationships.map((r) => [r.referredUserId, r]));
  const partnerById = new Map(input.partners.map((p) => [p.id, p]));
  const paid = new Set<string>();
  const planned: PlannedReward[] = [];

  for (const participant of input.participants) {
    const relationship = relationshipByUser.get(participant.userId);
    if (!relationship) continue;
    // Only the role signed up with earns (owner R-6), and each account counts once (document § 6).
    if (!isEarningCategory(relationship.category) || relationship.category !== participant.category) continue;
    if (paid.has(relationship.id)) continue;
    if (relationship.partnerUserId === relationship.referredUserId) continue;
    if (!isWithinEarningPeriod(relationship.expiresAt, input.earnedAt)) continue;

    const partner = partnerById.get(relationship.partnerId);
    if (!partner || !wasPartnerActiveAt(partner.statusHistory, input.earnedAt)) continue;

    const rate = resolveRate(participant.category, input.globalTerms, partner.customTerms);
    const amount = rewardAmount(input.retainedCommission, rate.ratePercent, participant.share);
    if (amount <= 0) continue;

    paid.add(relationship.id);
    planned.push({
      relationshipId: relationship.id,
      partnerId: partner.id,
      referredUserId: relationship.referredUserId,
      category: participant.category,
      share: participant.share,
      ratePercent: rate.ratePercent,
      rateSource: rate.source,
      amount,
    });
  }
  return planned;
}

/** Statuses a parcel has actually been delivered in. A replaced agency or a returned parcel earns nothing (R-7). */
const DELIVERED_SHIPMENT_STATUSES: readonly string[] = ['agent_delivered', 'delivered'];

export interface AgencyShareShipment {
  agencyId: string;
  status: string;
  items: ReadonlyArray<{ orderItemId: string; quantity: number }>;
}

/**
 * Each agency's share of a prepaid order's commission, by the goods value of the parcels it
 * delivered (owner R-7). An agency with two parcels on the order gets one share, summed.
 */
export function agencySharesByParcelValue(
  shipments: readonly AgencyShareShipment[],
  priceByOrderItem: ReadonlyMap<string, number>,
  orderGoodsValue: number
): Map<string, RewardShare> {
  const delivered = new Map<string, number>();
  for (const shipment of shipments) {
    if (!DELIVERED_SHIPMENT_STATUSES.includes(shipment.status)) continue;
    const value = shipment.items.reduce(
      (sum, item) => sum + (priceByOrderItem.get(item.orderItemId) ?? 0) * item.quantity,
      0
    );
    delivered.set(shipment.agencyId, (delivered.get(shipment.agencyId) ?? 0) + value);
  }
  const shares = new Map<string, RewardShare>();
  if (orderGoodsValue <= 0) return shares;
  for (const [agencyId, value] of delivered) {
    if (value > 0) shares.set(agencyId, { numerator: value, denominator: orderGoodsValue });
  }
  return shares;
}

/**
 * What a partner earns on ONE payment a referred provider made to Wi-Mall (LISTING-REVIEWS-SAVES-
 * REFERRALS-PLAN § 3.3; owner RS-3, RS-5, RS-6, 2026-11-08). PURE, like `planCommissionRewards`.
 *
 *  - Only a `provider` relationship earns here; a seller's `vendor` relationship earns on commission
 *    and never on what the seller pays for a plan.
 *  - Judged AT THE PAYMENT (RS-5): the relationship must be inside its period and the partner
 *    active at `paidAt`, read from the history, so a sweep running late judges the day it was paid.
 *  - The base is the FULL price paid (RS-6), the whole share; the rate is the provider category's,
 *    or the partner's own override. Under 1 FCFA after flooring is no reward at all.
 *
 * Null whenever nothing is earned. The caller still marks the payment judged.
 */
export function planProviderPaymentReward(input: {
  relationship: PlanRelationship | null;
  partner: PlanPartner | null;
  globalTerms: GlobalTerms;
  pricePaid: number;
  paidAt: Date;
}): PlannedReward | null {
  const { relationship, partner } = input;
  if (!relationship || !partner || relationship.category !== 'provider') return null;
  if (relationship.partnerId !== partner.id) return null;
  // A partner cannot earn on their own payment. Attribution already refuses that; kept as the rule.
  if (relationship.partnerUserId === relationship.referredUserId) return null;
  if (!isWithinEarningPeriod(relationship.expiresAt, input.paidAt)) return null;
  if (!wasPartnerActiveAt(partner.statusHistory, input.paidAt)) return null;
  if (!(input.pricePaid > 0)) return null;

  const { ratePercent, source } = resolveRate('provider', input.globalTerms, partner.customTerms);
  const amount = rewardAmount(Math.floor(input.pricePaid), ratePercent);
  if (amount < 1) return null;

  return {
    relationshipId: relationship.id,
    partnerId: partner.id,
    referredUserId: relationship.referredUserId,
    category: 'provider',
    share: { numerator: 1, denominator: 1 },
    ratePercent,
    rateSource: source,
    amount,
  };
}
