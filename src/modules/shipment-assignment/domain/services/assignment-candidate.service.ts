import { IShipment } from '../../../shipments/shipment.model';
import { IOrder } from '../../../orders/order.model';
import { IGeoPoint } from '../../../../core/types/geo.types';
import {
  AgentRepository,
  agentRepository,
  AgentEligibilityService,
  agentEligibilityService,
  AgentContractRepository,
  agentContractRepository,
  IDeliveryAgent,
} from '../../../agents';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { CashCollectionService, cashCollectionService } from '../../../cod/services/cash-collection.service';
import { CodExposureService, codExposureService } from '../../../cod/services/cod-exposure.service';
import { ASSIGNMENT_CONFIG } from '../../config/assignment.config';

/**
 * The per-factor breakdown behind a candidate's score. Persisted onto the offer
 * so a placement is explainable after the fact (why THIS agent, over that one).
 */
export interface CandidateScoreBreakdown {
  distance_km: number | null;
  distance_score: number;
  free_capacity: number;
  capacity_score: number;
  trust_score: number;
  trust_score_norm: number;
  weighted: number;
}

export interface ScoredCandidate {
  agentId: string;
  score: number;
  rank: number;
  breakdown: CandidateScoreBreakdown;
}

/** Raw inputs to the pure scorer — kept separate so it can be tested DB-free. */
export interface CandidateScoreInput {
  distanceKm: number | null;
  freeCapacity: number;
  maxActiveShipments: number;
  trustScore: number;
}

// ─── Pure scoring (no I/O — unit-tested directly) ──────────────────────────────

/** Great-circle distance in km between two GeoJSON points ([lng, lat]). */
export function haversineKm(a: IGeoPoint, b: IGeoPoint): number {
  const [lng1, lat1] = a.coordinates;
  const [lng2, lat2] = b.coordinates;
  const R = 6371; // km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Map a distance to a 0..1 score: 1 at/inside DISTANCE_FULL_SCORE_KM, 0
 * at/beyond DISTANCE_ZERO_SCORE_KM, linear between. Unknown distance (missing
 * pickup or agent coordinates) is NEUTRAL, not zero — a missing location must
 * degrade gracefully, not always lose.
 */
export function distanceScore(distanceKm: number | null, cfg = ASSIGNMENT_CONFIG): number {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return cfg.UNKNOWN_DISTANCE_SCORE;
  const { DISTANCE_FULL_SCORE_KM: full, DISTANCE_ZERO_SCORE_KM: zero } = cfg;
  if (distanceKm <= full) return 1;
  if (distanceKm >= zero) return 0;
  return (zero - distanceKm) / (zero - full);
}

/** The full weighted score + breakdown for one candidate. Pure. */
export function scoreCandidate(input: CandidateScoreInput, cfg = ASSIGNMENT_CONFIG): CandidateScoreBreakdown {
  const distScore = distanceScore(input.distanceKm, cfg);
  const capacityScore =
    input.maxActiveShipments > 0
      ? Math.max(0, Math.min(1, input.freeCapacity / input.maxActiveShipments))
      : 0;
  const trustNorm = Math.max(0, Math.min(1, input.trustScore / 100));

  const { DISTANCE: wD, FREE_CAPACITY: wC, TRUST: wT } = cfg.WEIGHTS;
  const wSum = wD + wC + wT;
  const weighted = wSum > 0 ? (wD * distScore + wC * capacityScore + wT * trustNorm) / wSum : 0;

  return {
    distance_km: input.distanceKm,
    distance_score: distScore,
    free_capacity: input.freeCapacity,
    capacity_score: capacityScore,
    trust_score: input.trustScore,
    trust_score_norm: trustNorm,
    weighted,
  };
}

/**
 * Rank pre-scored candidates highest-first and stamp their rank. Ties break by
 * agentId so ordering is deterministic (important: the auto pool is snapshotted
 * and re-read by the timeout branch — a non-deterministic order could skip an
 * agent). Pure.
 */
export function rankScored(
  scored: Array<{ agentId: string; breakdown: CandidateScoreBreakdown }>
): ScoredCandidate[] {
  return [...scored]
    .sort((a, b) => b.breakdown.weighted - a.breakdown.weighted || a.agentId.localeCompare(b.agentId))
    .map((c, i) => ({ agentId: c.agentId, score: c.breakdown.weighted, rank: i, breakdown: c.breakdown }));
}

/**
 * AssignmentCandidateService — computes the ranked list of agents an auto
 * assignment should offer a shipment to, in order.
 *
 * Pipeline (matches the spec):
 *   1. eligibility  — reuse AgentEligibilityService.listEligibleAgentIds (active,
 *      active contract, online, tracking-allowed, device-location, under-capacity).
 *   2. COD gate     — if the order is COD, drop agents over their COD headroom.
 *      If not COD, every eligible agent stays (spec: "assign to any").
 *   3. score        — distance-to-pickup + free capacity + trust, weighted.
 *
 * The scoring inputs are resolved with I/O here; the arithmetic is the pure
 * functions above.
 */
export class AssignmentCandidateService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly eligibility: AgentEligibilityService = agentEligibilityService,
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly vendors: VendorRepository = new VendorRepository(),
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly cashCollection: CashCollectionService = cashCollectionService,
    private readonly exposure: CodExposureService = codExposureService
  ) {}

  /**
   * Ranked candidates for a shipment, best first, capped at MAX_AUTO_CANDIDATES.
   * Empty when no eligible (and, for COD, COD-clearable) agent exists.
   */
  async rankCandidates(shipment: IShipment, order: IOrder): Promise<ScoredCandidate[]> {
    const agencyId = shipment.agency_id.toString();

    const eligibleIds = await this.eligibility.listEligibleAgentIds(agencyId);
    if (eligibleIds.length === 0) return [];

    const isCod = order.payment_method === 'cash_on_delivery';
    const expectedAmount = isCod ? this.cashCollection.computeExpectedAmount(order, shipment) : 0;

    const [agents, pickup] = await Promise.all([
      this.agents.findManyByIds(eligibleIds),
      this.resolvePickupLocation(shipment, order),
    ]);

    const scored: Array<{ agentId: string; breakdown: CandidateScoreBreakdown }> = [];
    for (const agent of agents) {
      const agentId = agent._id.toString();

      // COD gate: keep only agents who can carry this cash under the DISPATCHING
      // agency's cap. Non-COD orders skip the gate entirely.
      if (isCod && !(await this.canTakeCod(agent, agencyId, expectedAmount))) continue;

      const agentLoc = this.resolveAgentLocation(agent);
      const distanceKm = pickup && agentLoc ? haversineKm(pickup, agentLoc) : null;
      const maxActive = agent.capacity?.max_active_shipments ?? 0;
      const inUse = agent.capacity?.active_shipment_count ?? 0;

      scored.push({
        agentId,
        breakdown: scoreCandidate({
          distanceKm,
          freeCapacity: Math.max(0, maxActive - inUse),
          maxActiveShipments: maxActive,
          trustScore: agent.cod?.trust_score ?? 0,
        }),
      });
    }

    return rankScored(scored).slice(0, ASSIGNMENT_CONFIG.MAX_AUTO_CANDIDATES);
  }

  /** Non-throwing COD headroom check (the throwing form is for command paths). */
  private async canTakeCod(agent: IDeliveryAgent, agencyId: string, expectedAmount: number): Promise<boolean> {
    try {
      const contract = await this.contracts.findActive(agent._id.toString(), agencyId);
      await this.exposure.assertCanTakeCodShipment(agent, expectedAmount, contract?.cod?.threshold ?? 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Agent position: live tracking mirror first, else declared home base. */
  private resolveAgentLocation(agent: IDeliveryAgent): IGeoPoint | null {
    const live = agent.last_known_tracking_state?.last_position;
    if (live?.coordinates?.length === 2) return live;
    const home = agent.home_base?.location;
    if (home?.coordinates?.length === 2) return home;
    return null;
  }

  /**
   * Pickup coordinates for a shipment, resolved LIVE (the order snapshot carries
   * no coordinates). `agency_storage` ⇒ the agency's primary HQ location;
   * `vendor_address` ⇒ the referenced vendor business address's location. Uses
   * the shipment's first item's pickup config (a shipment's items share a
   * pickup in practice). Returns null when no location is on file — the distance
   * factor then goes neutral for every candidate.
   */
  private async resolvePickupLocation(shipment: IShipment, order: IOrder): Promise<IGeoPoint | null> {
    const firstItem = shipment.items[0];
    if (!firstItem) return null;

    const orderItem = (order.items as any[]).find(
      (i) => i._id?.toString() === firstItem.order_item_id.toString()
    );
    const pickup = orderItem?.delivery?.pickup_location;
    if (!pickup) return null;

    if (pickup.source === 'agency_storage') {
      const agency = await this.agencies.findById(shipment.agency_id.toString());
      return this.geoOf(agency?.headquarters_addresses?.[0]?.location);
    }

    if (pickup.source === 'vendor_address' && pickup.vendor_address_id) {
      const vendor = await this.vendors.findById(order.vendor_id.toString());
      const addr = vendor?.business_addresses?.find(
        (a: any) => a._id?.toString() === pickup.vendor_address_id.toString()
      );
      return this.geoOf(addr?.location);
    }

    return null;
  }

  private geoOf(loc: IGeoPoint | null | undefined): IGeoPoint | null {
    return loc && Array.isArray(loc.coordinates) && loc.coordinates.length === 2 ? loc : null;
  }
}

export const assignmentCandidateService = new AssignmentCandidateService();
