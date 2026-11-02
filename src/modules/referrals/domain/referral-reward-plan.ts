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
