/**
 * Test: Shipment Assignment — the pure auto-assignment scoring/ranking used by
 * the agent-acceptance workflow, plus catalog completeness for the new
 * offer notifications.
 *
 * DB-free by construction, following the scripts/test convention (plain ts-node,
 * hand-rolled asserts, no framework). The offer state machine
 * (offer/accept/reject/expire) loads documents before its guards and so needs a
 * Mongo-backed integration test; only the pure derivations are covered here.
 *
 * Run: npx ts-node scripts/test/test-assignment.ts   (npm run test:assignment)
 */
import {
  haversineKm,
  distanceScore,
  scoreCandidate,
  rankScored,
  AssignmentCandidateService,
} from '../../src/modules/shipment-assignment/domain/services/assignment-candidate.service';
import { ASSIGNMENT_CONFIG } from '../../src/modules/shipment-assignment/config/assignment.config';
import {
  assertAgentCatalogComplete,
  renderAgentInApp,
} from '../../src/modules/notifications/catalog/agent-notification-catalog';
import { assertAgencyCatalogComplete } from '../../src/modules/notifications/catalog/agency-notification-catalog';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  try {
    if (fn()) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

async function assertAsync(name: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    if (await fn()) {
      console.log(`  ✅ ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}`);
      failed++;
    }
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

// A deterministic config for weighting tests, independent of env overrides.
const CFG = {
  WEIGHTS: { DISTANCE: 50, FREE_CAPACITY: 20, TRUST: 30 },
  DISTANCE_FULL_SCORE_KM: 1,
  DISTANCE_ZERO_SCORE_KM: 25,
  UNKNOWN_DISTANCE_SCORE: 0.5,
} as any;

const pt = (lng: number, lat: number) => ({ type: 'Point' as const, coordinates: [lng, lat] as [number, number] });

// ── buildRanking fixtures — every collaborator faked, so the pipeline runs DB-free ──

const PICKUP = pt(9.7, 4.05);

/** An eligible agent; `position` null = nothing on file, the state of a new agent. */
function fakeAgent(id: string, position: ReturnType<typeof pt> | null): any {
  return {
    _id: id,
    cod: { trust_score: 50 },
    capacity: { max_active_shipments: 20, active_shipment_count: 0 },
    last_known_tracking_state: { last_position: position, last_reported_at: position ? new Date() : null },
    home_base: { location: null },
  };
}

interface RankingFixture {
  agents: any[];
  contracts?: any[];
  /** null = geo-tracker unavailable (the haversine fallback path). */
  geo?: 'reverse' | null;
}

async function rank(fx: RankingFixture) {
  const askedGeoAbout: string[][] = [];
  const service = new AssignmentCandidateService(
    { findManyByIds: async () => fx.agents } as any,
    { listEligibleAgentIds: async () => fx.agents.map((a) => a._id) } as any,
    { listActiveForAgencyAndAgents: async () => fx.contracts ?? [] } as any,
    { findById: async () => ({ business_addresses: [{ _id: 'addr1', location: PICKUP }] }) } as any,
    {} as any,
    { computeExpectedAmount: () => 200 } as any,
    { assertCanTakeCodShipment: async () => undefined } as any,
    {
      // Mirrors the real client: null for an empty list, else one result per agent.
      rankByProximity: async (_pickup: unknown, list: Array<{ agentId: string }>) => {
        askedGeoAbout.push(list.map((a) => a.agentId));
        if (fx.geo !== 'reverse' || list.length === 0) return null;
        return [...list].reverse().map((a, i) => ({ agentId: a.agentId, distanceMeters: (i + 1) * 1000, durationSeconds: (i + 1) * 60 }));
      },
    } as any,
    {} as any
  );
  const shipment = { _id: 's1', agency_id: 'agency1', items: [{ order_item_id: 'item1' }] } as any;
  const order = {
    _id: 'o1',
    vendor_id: 'v1',
    payment_method: 'prepaid',
    delivery_address: { components: { region: null, country_code: null } },
    items: [{ _id: 'item1', delivery: { pickup_location: { source: 'vendor_address', vendor_address_id: 'addr1' } } }],
  } as any;
  const result = await service.buildRanking(shipment, order);
  return { ...result, ids: result.candidates.map((c) => c.agentId), askedGeoAbout };
}

async function run(): Promise<void> {
  console.log('\n🧪 Shipment Assignment — scoring & ranking\n');

  // ── haversine ──────────────────────────────────────────────────────────────
  assert('haversine: same point is 0 km', () => approx(haversineKm(pt(9.7, 4.05), pt(9.7, 4.05)), 0));
  assert('haversine: ~1° latitude ≈ 111 km', () => {
    const d = haversineKm(pt(9.7, 4.0), pt(9.7, 5.0));
    return d > 108 && d < 113;
  });
  assert('haversine: is symmetric', () =>
    approx(haversineKm(pt(9.7, 4.0), pt(10.2, 4.6)), haversineKm(pt(10.2, 4.6), pt(9.7, 4.0)))
  );

  // ── distanceScore ────────────────────────────────────────────────────────────
  assert('distanceScore: at/under full-credit distance → 1', () => distanceScore(0.5, CFG) === 1 && distanceScore(1, CFG) === 1);
  assert('distanceScore: at/over zero distance → 0', () => distanceScore(25, CFG) === 0 && distanceScore(40, CFG) === 0);
  assert('distanceScore: midpoint is linear', () => approx(distanceScore(13, CFG), (25 - 13) / (25 - 1)));
  assert('distanceScore: unknown (null) is neutral, not zero', () => distanceScore(null, CFG) === CFG.UNKNOWN_DISTANCE_SCORE);
  assert('distanceScore: closer scores higher than farther', () => distanceScore(3, CFG) > distanceScore(10, CFG));

  // ── scoreCandidate ───────────────────────────────────────────────────────────
  assert('scoreCandidate: ideal candidate (near, empty, trusted) ≈ 1', () => {
    const s = scoreCandidate({ distanceKm: 0.5, freeCapacity: 5, maxActiveShipments: 5, trustScore: 100 }, CFG);
    return approx(s.weighted, 1);
  });

  assert('scoreCandidate: worst candidate (far, full, untrusted) ≈ 0', () => {
    const s = scoreCandidate({ distanceKm: 40, freeCapacity: 0, maxActiveShipments: 5, trustScore: 0 }, CFG);
    return approx(s.weighted, 0);
  });

  assert('scoreCandidate: with only TRUST weight, score == normalized trust', () => {
    const trustOnly = { WEIGHTS: { DISTANCE: 0, FREE_CAPACITY: 0, TRUST: 100 }, DISTANCE_FULL_SCORE_KM: 1, DISTANCE_ZERO_SCORE_KM: 25, UNKNOWN_DISTANCE_SCORE: 0.5 } as any;
    const s = scoreCandidate({ distanceKm: 40, freeCapacity: 0, maxActiveShipments: 5, trustScore: 80 }, trustOnly);
    return approx(s.weighted, 0.8);
  });

  assert('scoreCandidate: capacity factor is fraction free', () => {
    const s = scoreCandidate({ distanceKm: null, freeCapacity: 2, maxActiveShipments: 4, trustScore: 50 }, CFG);
    return approx(s.capacity_score, 0.5);
  });

  assert('scoreCandidate: nearer candidate beats farther, all else equal', () => {
    const near = scoreCandidate({ distanceKm: 2, freeCapacity: 3, maxActiveShipments: 5, trustScore: 70 }, CFG);
    const far = scoreCandidate({ distanceKm: 20, freeCapacity: 3, maxActiveShipments: 5, trustScore: 70 }, CFG);
    return near.weighted > far.weighted;
  });

  assert('scoreCandidate: maxActiveShipments 0 → capacity score 0 (no divide-by-zero)', () => {
    const s = scoreCandidate({ distanceKm: 1, freeCapacity: 0, maxActiveShipments: 0, trustScore: 100 }, CFG);
    return s.capacity_score === 0 && Number.isFinite(s.weighted);
  });

  // ── rankScored ───────────────────────────────────────────────────────────────
  assert('rankScored: orders highest-first and stamps rank', () => {
    const ranked = rankScored([
      { agentId: 'a', breakdown: { weighted: 0.4 } as any },
      { agentId: 'b', breakdown: { weighted: 0.9 } as any },
      { agentId: 'c', breakdown: { weighted: 0.6 } as any },
    ]);
    return (
      ranked[0].agentId === 'b' && ranked[0].rank === 0 &&
      ranked[1].agentId === 'c' && ranked[1].rank === 1 &&
      ranked[2].agentId === 'a' && ranked[2].rank === 2
    );
  });

  assert('rankScored: ties break deterministically by agentId', () => {
    const ranked = rankScored([
      { agentId: 'zeta', breakdown: { weighted: 0.5 } as any },
      { agentId: 'alpha', breakdown: { weighted: 0.5 } as any },
    ]);
    // Same order regardless of input order → stable, reproducible pool for the
    // timeout branch to walk.
    const reversed = rankScored([
      { agentId: 'alpha', breakdown: { weighted: 0.5 } as any },
      { agentId: 'zeta', breakdown: { weighted: 0.5 } as any },
    ]);
    return ranked[0].agentId === 'alpha' && reversed[0].agentId === 'alpha';
  });

  assert('rankScored: score mirrors the breakdown weighted value', () => {
    const ranked = rankScored([{ agentId: 'a', breakdown: { weighted: 0.73 } as any }]);
    return ranked[0].score === 0.73;
  });

  // ── config ───────────────────────────────────────────────────────────────────
  assert('config: default offer timeout is 120s', () => ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS === 120);
  assert('config: expiry sweep interval is under the offer timeout', () =>
    ASSIGNMENT_CONFIG.OFFER_EXPIRY_SWEEP_INTERVAL_MS < ASSIGNMENT_CONFIG.OFFER_TIMEOUT_SECONDS * 1000
  );
  assert('config: all scoring weights are non-negative and not all zero', () => {
    const w = ASSIGNMENT_CONFIG.WEIGHTS;
    return w.DISTANCE >= 0 && w.FREE_CAPACITY >= 0 && w.TRUST >= 0 && w.DISTANCE + w.FREE_CAPACITY + w.TRUST > 0;
  });

  // ── buildRanking: an agent with no position on file ─────────────────────────
  // A new agent has none — nothing writes home_base, and geo-tracker pushes a
  // position only during a tracked shipment. They used to be dropped here while
  // every eligibility panel showed them green (2026-09-22, ORD-2026-000003).
  // Everything below is the REQUIRE_LIVE_POSITION=off path; the assertion first
  // makes an env override fail as itself rather than as five wrong orderings.
  assert('config: REQUIRE_LIVE_POSITION is off (the path tested below)', () => !ASSIGNMENT_CONFIG.REQUIRE_LIVE_POSITION);

  // 'a-new' sorts FIRST by id, so every ordering below proves location decides it.
  const unlocated = fakeAgent('a-new', null);
  const near = fakeAgent('z-near', pt(9.71, 4.06));
  const far = fakeAgent('m-far', pt(9.9, 4.25));

  await assertAsync('ranking: the lone unlocated agent is a candidate, not "No eligible agents"', async () => {
    const r = await rank({ agents: [unlocated], geo: null });
    return r.ids.length === 1 && r.ids[0] === 'a-new' && r.candidates[0].distanceMeters === null;
  });

  await assertAsync('ranking (haversine): unlocated agent ranks after every located one', async () => {
    const r = await rank({ agents: [unlocated, far, near], geo: null });
    return (
      r.source === 'haversine' &&
      r.ids.join() === 'z-near,m-far,a-new' &&
      r.candidates.map((c) => c.rank).join() === '0,1,2'
    );
  });

  await assertAsync('ranking (geo): provider sees only located agents; unlocated appended after its order', async () => {
    const r = await rank({ agents: [unlocated, far, near], geo: 'reverse' });
    return (
      r.source === 'geo_matrix' &&
      r.askedGeoAbout.length === 1 &&
      !r.askedGeoAbout[0].includes('a-new') &&
      r.ids.join() === 'm-far,z-near,a-new' && // provider reversed the two it was asked about
      r.candidates.map((c) => c.rank).join() === '0,1,2' &&
      r.candidates[2].distanceMeters === null
    );
  });

  await assertAsync('ranking: on overflow the unlocated agent is cut first', async () => {
    const max = ASSIGNMENT_CONFIG.MAX_AUTO_CANDIDATES;
    const located = Array.from({ length: max }, (_, i) =>
      fakeAgent(`loc-${String(i).padStart(3, '0')}`, pt(9.7 + i * 0.001, 4.05))
    );
    const r = await rank({ agents: [unlocated, ...located], geo: null });
    return r.ids.length === max && !r.ids.includes('a-new');
  });

  await assertAsync('ranking: an unlocated agent still passes through the contract gates', async () => {
    // Value ceiling 100 against a shipment worth 200 — the gate must still refuse.
    const contracts = [{ agent_id: 'a-new', coverage: { regions: [] }, shipment_value_ceiling: 100, cod: { threshold: 0 } }];
    const r = await rank({ agents: [unlocated], contracts, geo: null });
    return r.ids.length === 0;
  });

  // ── notification catalogs (new offer situations must be complete in 5 langs) ──
  assert('agent catalog: complete for all situations incl. offers', () => {
    assertAgentCatalogComplete();
    return true;
  });
  assert('agent catalog: offer.received renders distinct EN vs FR', () => {
    const ctx = { offerId: 'o1', agencyName: 'Acme Delivery', orderNumber: 'ORD-1' };
    const en = renderAgentInApp('shipment.offer.received', 'en', ctx);
    const fr = renderAgentInApp('shipment.offer.received', 'fr', ctx);
    return en.title !== fr.title && en.message.includes('Acme Delivery') && fr.message.includes('ORD-1');
  });
  assert('agency catalog: complete for all situations incl. offer.accepted/unfilled', () => {
    assertAgencyCatalogComplete();
    return true;
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(72));
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
