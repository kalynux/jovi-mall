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
import { RankingSource } from '../../models/shipment-assignment-session.model';
import { GeoRoutingClient, geoRoutingClient } from '../../services/geo-routing.client';

/**
 * The per-factor breakdown behind a candidate's score. Persisted onto the
 * session so a placement is explainable after the fact (why THIS agent).
 * NOTE: under the requirement the ranking ORDER is proximity (nearest first);
 * this weighted score is retained for explainability/audit and tie-breaking,
 * not as the primary sort key.
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

/** One ranked candidate. `rank` is the proximity order (0 = nearest). */
export interface RankedCandidate {
  agentId: string;
  rank: number;
  distanceMeters: number | null;
  durationSeconds: number | null;
  score: number;
  breakdown: CandidateScoreBreakdown;
}

/** The full ranking + how it was ordered (geo provider vs local fallback). */
export interface RankingResult {
  candidates: RankedCandidate[];
  source: RankingSource;
}

/** Raw inputs to the pure scorer — kept separate so it can be tested DB-free. */
export interface CandidateScoreInput {
  distanceKm: number | null;
  freeCapacity: number;
  maxActiveShipments: number;
  trustScore: number;
}

/** A candidate ranked by weighted score (retained for previews + unit tests). */
export interface ScoredCandidate {
  agentId: string;
  score: number;
  rank: number;
  breakdown: CandidateScoreBreakdown;
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
 * pickup or agent coordinates) is NEUTRAL, not zero.
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
 * agentId so ordering is deterministic. Pure. (Retained for the weighted-score
 * preview and the DB-free unit tests; the live ranking orders by proximity.)
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
 * assignment should offer a shipment to, nearest first.
 *
 * Pipeline (matches the requirement):
 *   1. eligibility — active · approved · online · tracking-allowed · device-loc
 *      · under-capacity (AgentEligibilityService).
 *   2. current-location gate — an agent with no resolvable position is dropped
 *      (they cannot be ranked by proximity). With REQUIRE_LIVE_POSITION on, only
 *      a FRESH pushed position counts.
 *   3. trust floor — MIN_TRUST_SCORE gates receiving ANY order.
 *   4. COD gate — for a COD order, drop agents over their COD headroom (checked
 *      in parallel, not a sequential N+1). Prepaid orders skip it entirely.
 *   5. cap to MAX_AUTO_CANDIDATES nearest (local haversine pre-cut).
 *   6. proximity ranking — send the capped set + pickup to the Geo Provider
 *      (geo-tracker's road-network matrix); fall back to local haversine order
 *      if it is unavailable. Order is nearest → farthest.
 */
export class AssignmentCandidateService {
  constructor(
    private readonly agents: AgentRepository = agentRepository,
    private readonly eligibility: AgentEligibilityService = agentEligibilityService,
    private readonly contracts: AgentContractRepository = agentContractRepository,
    private readonly vendors: VendorRepository = new VendorRepository(),
    private readonly agencies: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly cashCollection: CashCollectionService = cashCollectionService,
    private readonly exposure: CodExposureService = codExposureService,
    private readonly geoRouting: GeoRoutingClient = geoRoutingClient
  ) {}

  /**
   * Ranked candidates for a shipment, nearest first, capped at
   * MAX_AUTO_CANDIDATES. Empty when no eligible (and, for COD, COD-clearable)
   * agent with a usable location exists.
   */
  async buildRanking(shipment: IShipment, order: IOrder): Promise<RankingResult> {
    const agencyId = shipment.agency_id.toString();

    const eligibleIds = await this.eligibility.listEligibleAgentIds(agencyId);
    if (eligibleIds.length === 0) return { candidates: [], source: 'haversine' };

    const isCod = order.payment_method === 'cash_on_delivery';
    const expectedAmount = isCod ? this.cashCollection.computeExpectedAmount(order, shipment) : 0;

    const [agents, pickup] = await Promise.all([
      this.agents.findManyByIds(eligibleIds),
      this.resolvePickupLocation(shipment, order),
    ]);

    // Steps 2 + 3 — location-available and trust-floor gates (pure, no I/O).
    const located = agents
      .map((agent) => ({ agent, position: this.resolvePosition(agent) }))
      .filter((c): c is { agent: IDeliveryAgent; position: ResolvedPosition } => {
        if (!c.position) return false; // no current location → cannot rank by proximity
        if (ASSIGNMENT_CONFIG.REQUIRE_LIVE_POSITION && !c.position.fresh) return false;
        if ((c.agent.cod?.trust_score ?? 0) < ASSIGNMENT_CONFIG.MIN_TRUST_SCORE) return false;
        return true;
      });

    // Step 4 — COD headroom gate, evaluated in PARALLEL (was a sequential N+1).
    let survivors = located;
    if (isCod) {
      const codOk = await Promise.all(
        located.map((c) => this.canTakeCod(c.agent, agencyId, expectedAmount))
      );
      survivors = located.filter((_, i) => codOk[i]);
    }
    if (survivors.length === 0) return { candidates: [], source: 'haversine' };

    // Step 5 — pre-cut to the nearest MAX_AUTO_CANDIDATES by local haversine, so
    // the Geo Provider is only ever asked about the plausible set (the
    // requirement's "up to 20 to the provider").
    const withDistance = survivors.map((c) => ({
      ...c,
      haversineKm: pickup ? haversineKm(pickup, c.position.point) : null,
    }));
    withDistance.sort((a, b) => this.byNearest(a.haversineKm, b.haversineKm, a.agent, b.agent));
    const capped = withDistance.slice(0, ASSIGNMENT_CONFIG.MAX_AUTO_CANDIDATES);

    // Step 6 — proximity ranking via the Geo Provider, with haversine fallback.
    return await this.rankByProximity(capped, pickup);
  }

  /** Order the capped set nearest-first via the Geo Provider, else haversine. */
  private async rankByProximity(
    capped: Array<{ agent: IDeliveryAgent; position: ResolvedPosition; haversineKm: number | null }>,
    pickup: IGeoPoint | null
  ): Promise<RankingResult> {
    const geo = pickup
      ? await this.geoRouting.rankByProximity(
          pickup,
          capped.map((c) => ({ agentId: c.agent._id.toString(), position: c.position.point }))
        )
      : null;

    if (geo) {
      // Provider order wins. Build candidates in the returned nearest→farthest order.
      const byId = new Map(capped.map((c) => [c.agent._id.toString(), c]));
      const candidates: RankedCandidate[] = [];
      geo.forEach((r, rank) => {
        const c = byId.get(r.agentId);
        if (!c) return;
        const distanceKm = Number.isFinite(r.distanceMeters) ? r.distanceMeters / 1000 : c.haversineKm;
        candidates.push(this.toRanked(c.agent, rank, r.distanceMeters, r.durationSeconds, distanceKm));
      });
      return { candidates, source: 'geo_matrix' };
    }

    // Fallback: local haversine order (already sorted nearest-first above).
    const candidates = capped.map((c, rank) =>
      this.toRanked(c.agent, rank, c.haversineKm != null ? c.haversineKm * 1000 : null, null, c.haversineKm)
    );
    return { candidates, source: 'haversine' };
  }

  private toRanked(
    agent: IDeliveryAgent,
    rank: number,
    distanceMeters: number | null,
    durationSeconds: number | null,
    distanceKm: number | null
  ): RankedCandidate {
    const maxActive = agent.capacity?.max_active_shipments ?? 0;
    const inUse = agent.capacity?.active_shipment_count ?? 0;
    const breakdown = scoreCandidate({
      distanceKm,
      freeCapacity: Math.max(0, maxActive - inUse),
      maxActiveShipments: maxActive,
      trustScore: agent.cod?.trust_score ?? 0,
    });
    return {
      agentId: agent._id.toString(),
      rank,
      distanceMeters: distanceMeters != null && Number.isFinite(distanceMeters) ? distanceMeters : null,
      durationSeconds: durationSeconds != null && Number.isFinite(durationSeconds) ? durationSeconds : null,
      score: breakdown.weighted,
      breakdown,
    };
  }

  /** nearest-first comparator; unknown distances sort last, ties by agentId. */
  private byNearest(a: number | null, b: number | null, agA: IDeliveryAgent, agB: IDeliveryAgent): number {
    const da = a == null || !Number.isFinite(a) ? Infinity : a;
    const db = b == null || !Number.isFinite(b) ? Infinity : b;
    if (da !== db) return da - db;
    return agA._id.toString().localeCompare(agB._id.toString());
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

  /**
   * Agent position + whether it counts as CURRENT. A live pushed position within
   * POSITION_FRESHNESS_SECONDS is fresh; an older mirror or the declared home
   * base is a usable fallback but not "fresh". Null when nothing is on file — an
   * agent with no coordinates at all cannot be ranked by proximity.
   */
  private resolvePosition(agent: IDeliveryAgent): ResolvedPosition | null {
    const lk = agent.last_known_tracking_state;
    const live = lk?.last_position;
    if (live?.coordinates?.length === 2) {
      const reportedAt = lk?.last_reported_at ? new Date(lk.last_reported_at).getTime() : 0;
      const fresh =
        reportedAt > 0 && Date.now() - reportedAt <= ASSIGNMENT_CONFIG.POSITION_FRESHNESS_SECONDS * 1000;
      return { point: live, fresh };
    }
    const home = agent.home_base?.location;
    if (home?.coordinates?.length === 2) return { point: home, fresh: false };
    return null;
  }

  /**
   * Pickup coordinates for a shipment, resolved LIVE. `agency_storage` ⇒ the
   * agency's primary HQ location; `vendor_address` ⇒ the referenced vendor
   * business address's location. Returns null when no location is on file.
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

interface ResolvedPosition {
  point: IGeoPoint;
  fresh: boolean;
}

export const assignmentCandidateService = new AssignmentCandidateService();
