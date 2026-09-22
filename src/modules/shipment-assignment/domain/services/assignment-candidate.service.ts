import { IShipment } from '../../../shipments/shipment.model';
import { IOrder } from '../../../orders/order.model';
import { IGeoPoint } from '../../../../core/types/geo.types';
import { haversineKm } from '../../../../core/utils/geo-distance.util';
import {
  AgentRepository,
  agentRepository,
  AgentEligibilityService,
  agentEligibilityService,
  AgentContractRepository,
  agentContractRepository,
  IDeliveryAgent,
  contractCoversRegion,
  contractAllowsShipmentValue,
} from '../../../agents';
import { VendorRepository } from '../../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../../delivery/delivery-agency.repository';
import { MagazinRepository } from '../../../magazin/repositories/magazin.repository';
import { resolveHqAddress } from '../../../magazin/domain/hq-address.resolver';
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

/**
 * Great-circle distance in km. Defined in `core/utils/geo-distance.util` and
 * re-exported here so the assignment module's long-standing public surface
 * (`shipment-assignment/index.ts`) is unchanged.
 */
export { haversineKm };

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
 *   2. current-location gate — only with REQUIRE_LIVE_POSITION on, where an
 *      agent without a FRESH pushed position is dropped. Off (the default), an
 *      agent with no position on file at all is KEPT and ranked after every
 *      located agent — see `resolvePosition` for why dropping them was wrong.
 *   3. trust floor — MIN_TRUST_SCORE gates receiving ANY order.
 *   4. COD gate — for a COD order, drop agents over their COD headroom (checked
 *      in parallel, not a sequential N+1). Prepaid orders skip it entirely.
 *   5. cap to MAX_AUTO_CANDIDATES nearest (local haversine pre-cut).
 *   6. proximity ranking — send the capped set's LOCATED agents + pickup to the
 *      Geo Provider (geo-tracker's road-network matrix); fall back to local
 *      haversine order if it is unavailable. Order is nearest → farthest, then
 *      the unlocated agents.
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
    private readonly geoRouting: GeoRoutingClient = geoRoutingClient,
    // HQ addresses (the agency-storage pickup point) live on the Magazin.
    private readonly magazins: MagazinRepository = new MagazinRepository()
  ) {}

  /**
   * Ranked candidates for a shipment, nearest first, capped at
   * MAX_AUTO_CANDIDATES. Empty when no eligible (and, for COD, COD-clearable)
   * agent exists — or, with REQUIRE_LIVE_POSITION on, none with a fresh fix.
   */
  async buildRanking(shipment: IShipment, order: IOrder): Promise<RankingResult> {
    const agencyId = shipment.agency_id.toString();

    const eligibleIds = await this.eligibility.listEligibleAgentIds(agencyId);
    if (eligibleIds.length === 0) return { candidates: [], source: 'haversine' };

    const isCod = order.payment_method === 'cash_on_delivery';
    // Computed for EVERY payment method now: the value ceiling is about the
    // goods, not the cash. Fails open to null — see resolveShipmentValue.
    const shipmentValue = this.resolveShipmentValue(order, shipment);

    // ONE query for every candidate's contract, not one per candidate. The COD
    // gate below used to call `findActive` inside a `Promise.all`, which is a
    // concurrent N+1 rather than a fixed one — and the coverage and value gates
    // need the same document, so batching it here serves all three.
    const [agents, pickup, contracts] = await Promise.all([
      this.agents.findManyByIds(eligibleIds),
      this.resolvePickupLocation(shipment, order),
      this.contracts.listActiveForAgencyAndAgents(agencyId, eligibleIds),
    ]);
    const contractByAgent = new Map(contracts.map((c) => [c.agent_id.toString(), c]));

    const deliveryRegion = order.delivery_address?.components?.region ?? null;
    const countryCode = order.delivery_address?.components?.country_code ?? null;

    // Steps 2–4 — every pure gate in one pass, no I/O.
    const pool = agents
      .map((agent) => ({ agent, position: this.resolvePosition(agent) }))
      .filter((c) => {
        // A missing position fails only the fresh-fix requirement. Without it,
        // the agent stays in and sorts after everyone located (see resolvePosition).
        if (ASSIGNMENT_CONFIG.REQUIRE_LIVE_POSITION && !c.position?.fresh) return false;
        if ((c.agent.cod?.trust_score ?? 0) < ASSIGNMENT_CONFIG.MIN_TRUST_SCORE) return false;

        // Contract-term gates. A missing contract cannot happen for an eligible
        // agent (eligibility requires an active one), but if it somehow does,
        // fall through rather than throw — the COD gate below will refuse them
        // for a reason an operator can act on.
        const contract = contractByAgent.get(c.agent._id.toString());
        if (contract) {
          if (!contractCoversRegion(contract.coverage, deliveryRegion, countryCode)) return false;
          if (!contractAllowsShipmentValue(contract.shipment_value_ceiling, shipmentValue)) {
            return false;
          }
        }
        return true;
      });

    // Step 5 — COD headroom gate. Still last: it is the only one that reads the
    // agent's live exposure, so it is the most expensive to be wrong about.
    let survivors = pool;
    if (isCod) {
      const codOk = await Promise.all(
        pool.map((c) =>
          this.canTakeCod(
            c.agent,
            contractByAgent.get(c.agent._id.toString())?.cod?.threshold ?? 0,
            shipmentValue ?? 0
          )
        )
      );
      survivors = pool.filter((_, i) => codOk[i]);
    }
    if (survivors.length === 0) return { candidates: [], source: 'haversine' };

    // Step 5 — pre-cut to the nearest MAX_AUTO_CANDIDATES by local haversine, so
    // the Geo Provider is only ever asked about the plausible set (the
    // requirement's "up to 20 to the provider"). An unlocated agent's distance is
    // null, which `byNearest` sorts last — so they are the first cut when the
    // pool overflows: an agent known to be close beats one nothing is known about.
    const withDistance = survivors.map((c) => ({
      ...c,
      haversineKm: pickup && c.position ? haversineKm(pickup, c.position.point) : null,
    }));
    withDistance.sort((a, b) => this.byNearest(a.haversineKm, b.haversineKm, a.agent, b.agent));
    const capped = withDistance.slice(0, ASSIGNMENT_CONFIG.MAX_AUTO_CANDIDATES);

    // Step 6 — proximity ranking via the Geo Provider, with haversine fallback.
    return await this.rankByProximity(capped, pickup);
  }

  /**
   * Order the capped set nearest-first via the Geo Provider, else haversine.
   * Only LOCATED agents can go to the provider; the unlocated ones follow them.
   */
  private async rankByProximity(
    capped: Array<{ agent: IDeliveryAgent; position: ResolvedPosition | null; haversineKm: number | null }>,
    pickup: IGeoPoint | null
  ): Promise<RankingResult> {
    const located = capped.filter(
      (c): c is typeof c & { position: ResolvedPosition } => c.position !== null
    );
    const geo = pickup
      ? await this.geoRouting.rankByProximity(
          pickup,
          located.map((c) => ({ agentId: c.agent._id.toString(), position: c.position.point }))
        )
      : null;

    if (geo) {
      // Provider order wins. Build candidates in the returned nearest→farthest order.
      const byId = new Map(located.map((c) => [c.agent._id.toString(), c]));
      const candidates: RankedCandidate[] = [];
      geo.forEach((r) => {
        const c = byId.get(r.agentId);
        if (!c) return;
        const distanceKm = Number.isFinite(r.distanceMeters) ? r.distanceMeters / 1000 : c.haversineKm;
        candidates.push(this.toRanked(c.agent, candidates.length, r.distanceMeters, r.durationSeconds, distanceKm));
      });
      // Then everyone with no position, in the order the pre-cut left them.
      for (const c of capped) {
        if (c.position === null) candidates.push(this.toRanked(c.agent, candidates.length, null, null, null));
      }
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

  /**
   * Non-throwing COD headroom check (the throwing form is for command paths).
   *
   * Takes the threshold rather than looking the contract up: the caller already
   * holds every candidate's contract from one batched query.
   */
  private async canTakeCod(
    agent: IDeliveryAgent,
    codThreshold: number,
    expectedAmount: number
  ): Promise<boolean> {
    try {
      await this.exposure.assertCanTakeCodShipment(agent, expectedAmount, codThreshold);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A shipment's value, or null when it cannot be computed.
   *
   * The twin of `ShipmentAssignmentService.resolveShipmentValue`, and it exists
   * for the sharper version of the same reason: `computeExpectedAmount` throws
   * on a shipment referencing a missing order item, and an unguarded throw here
   * would abort the whole ranking — leaving the shipment with zero candidates
   * and the agency with no explanation for why nobody was offered it.
   */
  private resolveShipmentValue(order: IOrder, shipment: IShipment): number | null {
    try {
      return this.cashCollection.computeExpectedAmount(order, shipment);
    } catch (error) {
      console.error(
        `[AssignmentCandidateService] Could not value shipment ${shipment._id.toString()} — ` +
          'value-ceiling and COD gates will be skipped for this ranking:',
        error
      );
      return null;
    }
  }

  /**
   * Agent position + whether it counts as CURRENT. A live pushed position within
   * POSITION_FRESHNESS_SECONDS is fresh; an older mirror or the declared home
   * base is a usable fallback but not "fresh". Null when nothing is on file.
   *
   * ⚠ Null is the NORMAL state of a new agent, which is why it no longer drops
   * them. Neither source can be filled before a first delivery: nothing writes
   * `home_base` (`agentRepository.setHomeBase` has no caller), and geo-tracker
   * pushes a position only on a tracking-SESSION transition, which exists only
   * for an active shipment — an idle agent's live fix stays in geo-tracker. So
   * a dropped agent could never be offered the shipment that would give them a
   * position, while every eligibility screen showed them all green.
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
   * chosen agency depot's location (the primary when none was chosen);
   * `vendor_address` ⇒ the referenced vendor business address's location.
   * Returns null when no location is on file.
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
      const magazin = await this.magazins.findByAgencyIdOrNull(shipment.agency_id.toString());
      const depot = resolveHqAddress(magazin?.headquarters_addresses, pickup.agency_address_id);
      return this.geoOf(depot?.location);
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
