/**
 * Test: the COD limits above and beside the agent (owner decisions, 2026-10-02).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: every rule is pure, and the one service exercised is driven through stubbed
 * reads.
 *
 *   1. The agency's limit — 1 000 000 by default, an administrator's pin otherwise.
 *   2. The vendor's COD terms — defaults, legacy documents, the stored shape.
 *   3. Exposure — in-flight COD + collected-unremitted, once each, per vendor on demand.
 *   4. The decision — agency first, strictly-greater, zero never refused.
 *   5. A dispatch BATCH — each hand-off counts the ones before it; force counts too.
 *   6. The agency → agent force — waives the AMOUNT limit and nothing else.
 *   7. The agent pool default — 500 000, whatever the plan.
 *   8. Validators.
 *   9. SOURCE SCANS — the wiring no behavioural test can see.
 *
 * Run: npm run test:cod-limits
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AGENCY_COD_LIMIT_SOURCES,
  COD_EXPOSURE_SHIPMENT_STATUSES,
  COD_LIMIT_HOLD_KINDS,
  DEFAULT_VENDOR_COD_TERMS,
  evaluateCodLimits,
  expectedCodAmount,
  resolveAgencyCodLimit,
  sumCodExposure,
  vendorCodTermsOf,
  ExposureShipmentRow,
  ExposureCollectionRow,
} from '../../src/modules/cod/domain/cod-limits';
import { COD_CONFIG } from '../../src/modules/cod/config/cod.config';
import { CodLimitsService } from '../../src/modules/cod/services/cod-limits.service';
import { COD_LIMIT_KINDS } from '../../src/modules/shipments/shipment.model';
import {
  ContractPolicyService,
  isForceableCodRefusal,
} from '../../src/modules/shipment-assignment/domain/services/contract-policy.service';
import { resolveCodPoolCeiling } from '../../src/modules/agents/domain/services/agent-cod-pool';
import { AGENT_CONFIG } from '../../src/modules/agents/config/agent.config';
import { AdminSetAgencyCodLimitSchema } from '../../src/modules/delivery/validators/admin-agency.validator';
import {
  BulkDispatchToAgencySchema,
  DispatchToAgencySchema,
  UpdateDeliveryAgencySchema,
} from '../../src/modules/vendor/validators/vendor-order.validator';
import { OfferAgentSchema, ReassignShipmentSchema } from '../../src/modules/shipment-assignment/validators/assignment.validator';
import { ERROR_CODES } from '../../src/core/error-codes';
import { createAppError } from '../../src/core/errors';
import { CodEligibilityService } from '../../src/modules/cod/services/cod-eligibility.service';
import {
  CASH_ON_DELIVERY_UNAVAILABLE_REASONS,
  COD_REASON_BY_CODE,
  CartQuoteService,
  cashOnDeliveryVerdictOf,
} from '../../src/modules/orders/services/cart-quote.service';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
  } catch (err) {
    console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${name}`);
    failed++;
  }
}

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;

const ship = (id: string, vendorId: string, amount: number, collectionStatus: ExposureShipmentRow['collectionStatus'] = null): ExposureShipmentRow =>
  ({ shipmentId: id, vendorId, amount, collectionStatus });
const coll = (id: string, vendorId: string, expectedAmount: number, settledAmount = 0): ExposureCollectionRow =>
  ({ collectionId: id, vendorId, expectedAmount, settledAmount });

/** A CodLimitsService whose three reads are stubs — the batch logic runs for real. */
function stubbedLimits(world: {
  limits: Record<string, number>;
  rows: Record<string, { shipments: ExposureShipmentRow[]; collections: ExposureCollectionRow[] }>;
  caps: Record<string, number | null>;
}): CodLimitsService {
  const svc = new CodLimitsService({} as never);
  (svc as any).limitFor = async (agencyId: string) => ({ limit: { amount: world.limits[agencyId], source: 'default' }, override: null });
  (svc as any).exposureRows = async (agencyId: string) => world.rows[agencyId] ?? { shipments: [], collections: [] };
  (svc as any).vendorTerms = async (vendorId: string) => ({ codEnabled: true, maxCashPerAgency: world.caps[vendorId] ?? null });
  return svc;
}

async function main(): Promise<void> {
  // ═══ 1 · The agency's limit ═══════════════════════════════════════════════
  console.log('\n── 1 · The agency\'s limit ─────────────────────────────────────────────\n');

  await assert('the platform default is the owner\'s number: 1 000 000', () =>
    COD_CONFIG.AGENCY_COD_LIMIT_DEFAULT === 1_000_000);

  await assert('no pin → the default, sourced `default`', () => {
    const l = resolveAgencyCodLimit(null);
    return l.amount === 1_000_000 && l.source === 'default';
  });

  await assert('a pin wins in BOTH directions — above and below the default', () =>
    resolveAgencyCodLimit({ amount: 3_000_000 }).amount === 3_000_000
    && resolveAgencyCodLimit({ amount: 50_000 }).amount === 50_000
    && resolveAgencyCodLimit({ amount: 50_000 }).source === 'override');

  await assert('a pin of 0 is honoured (an administrator may stop an agency taking COD)', () => {
    const l = resolveAgencyCodLimit({ amount: 0 });
    return l.amount === 0 && l.source === 'override';
  });

  await assert('a corrupt pin (negative / NaN) falls back to the default rather than to 0 or ∞', () =>
    resolveAgencyCodLimit({ amount: -5 }).source === 'default'
    && resolveAgencyCodLimit({ amount: Number.NaN }).source === 'default');

  await assert('the source vocabulary is exactly default · override', () =>
    JSON.stringify([...AGENCY_COD_LIMIT_SOURCES]) === JSON.stringify(['default', 'override']));

  // ═══ 2 · The vendor's terms ═══════════════════════════════════════════════
  console.log('\n── 2 · The vendor\'s COD terms ─────────────────────────────────────────\n');

  await assert('never set → COD accepted, no cap', () => {
    const t = vendorCodTermsOf(null);
    return t.codEnabled === true && t.maxCashPerAgency === null
      && DEFAULT_VENDOR_COD_TERMS.codEnabled === true && DEFAULT_VENDOR_COD_TERMS.maxCashPerAgency === null;
  });

  await assert('stored terms read through, snake_case → camelCase', () => {
    const t = vendorCodTermsOf({ cod_enabled: false, max_cash_per_agency: 250_000 });
    return t.codEnabled === false && t.maxCashPerAgency === 250_000;
  });

  await assert('a partial legacy block keeps the defaults for what is missing', () => {
    const t = vendorCodTermsOf({ max_cash_per_agency: 10_000 });
    return t.codEnabled === true && t.maxCashPerAgency === 10_000;
  });

  await assert('a cap of 0 is a real cap (no COD cash may sit with any agency)', () =>
    vendorCodTermsOf({ cod_enabled: true, max_cash_per_agency: 0 }).maxCashPerAgency === 0);

  // ═══ 3 · Exposure ═════════════════════════════════════════════════════════
  console.log('\n── 3 · Exposure: in-flight + collected-unremitted ─────────────────────\n');

  await assert('the exposure statuses are the in-custody ones — never pending, never terminal', () => {
    const s = [...COD_EXPOSURE_SHIPMENT_STATUSES] as string[];
    return JSON.stringify(s) === JSON.stringify(['assigned', 'handing_over', 'picked_up', 'in_transit', 'agent_delivered'])
      && !s.includes('pending') && !s.includes('delivered') && !s.includes('returned') && !s.includes('failed');
  });

  await assert('expectedCodAmount = Σ order-item price × shipment qty; an unmatched item counts 0', () =>
    expectedCodAmount(
      [{ _id: 'a', price: 1_000 }, { _id: 'b', price: 2_500 }],
      [{ order_item_id: 'a', quantity: 3 }, { order_item_id: 'b', quantity: 2 }, { order_item_id: 'zz', quantity: 9 }]
    ) === 8_000);

  await assert('in-flight and collected-unremitted add up', () => {
    const t = sumCodExposure([ship('s1', 'v1', 100_000), ship('s2', 'v2', 50_000)], [coll('c1', 'v1', 80_000, 30_000)]);
    return t.inFlight === 150_000 && t.collectedUnremitted === 50_000 && t.total === 200_000
      && t.inFlightCount === 2 && t.collectedCount === 1;
  });

  await assert('a shipment whose collection is COLLECTED is counted once — on the collected side', () => {
    const t = sumCodExposure([ship('s1', 'v1', 100_000, 'collected')], [coll('c1', 'v1', 100_000)]);
    return t.total === 100_000 && t.inFlight === 0;
  });

  await assert('a fully settled collection holds nothing; a partly settled one holds the rest', () =>
    sumCodExposure([], [coll('c1', 'v1', 100_000, 100_000), coll('c2', 'v1', 100_000, 40_000)]).total === 60_000);

  await assert('the vendor filter narrows BOTH halves to that vendor', () => {
    const rows = { s: [ship('s1', 'v1', 100_000), ship('s2', 'v2', 70_000)], c: [coll('c1', 'v1', 10_000), coll('c2', 'v2', 20_000)] };
    return sumCodExposure(rows.s, rows.c, 'v1').total === 110_000 && sumCodExposure(rows.s, rows.c, 'v2').total === 90_000;
  });

  await assert('a negative or zero amount never reduces exposure', () =>
    sumCodExposure([ship('s1', 'v1', -50_000), ship('s2', 'v1', 0)], [coll('c1', 'v1', 10, 50)]).total === 0);

  // ═══ 4 · The decision ═════════════════════════════════════════════════════
  console.log('\n── 4 · The decision ───────────────────────────────────────────────────\n');

  const agency = (exposure: number, limit = 1_000_000) => ({ exposure, limit });

  await assert('within both caps → allowed', () =>
    evaluateCodLimits({ additionalAmount: 100_000, agency: agency(500_000), vendor: { exposure: 0, cap: 300_000 } }) === null);

  await assert('holding EXACTLY the limit is allowed (strictly greater refuses)', () =>
    evaluateCodLimits({ additionalAmount: 100_000, agency: agency(900_000), vendor: null }) === null
    && evaluateCodLimits({ additionalAmount: 100_001, agency: agency(900_000), vendor: null })?.kind === 'agency_limit');

  await assert('over the agency\'s limit → agency_limit with { current, additional, limit }', () => {
    const b = evaluateCodLimits({ additionalAmount: 200_000, agency: agency(900_000), vendor: null });
    return b?.kind === 'agency_limit' && b.currentExposure === 900_000 && b.additionalAmount === 200_000 && b.limit === 1_000_000;
  });

  await assert('over the vendor\'s cap only → vendor_terms, measured on that vendor\'s share', () => {
    const b = evaluateCodLimits({ additionalAmount: 60_000, agency: agency(100_000), vendor: { exposure: 50_000, cap: 100_000 } });
    return b?.kind === 'vendor_terms' && b.currentExposure === 50_000 && b.limit === 100_000;
  });

  await assert('over BOTH → the agency\'s limit is reported (the platform rule outranks the vendor\'s)', () =>
    evaluateCodLimits({ additionalAmount: 2_000_000, agency: agency(0), vendor: { exposure: 0, cap: 10 } })?.kind === 'agency_limit');

  await assert('a vendor cap of null never refuses', () =>
    evaluateCodLimits({ additionalAmount: 900_000, agency: agency(0), vendor: { exposure: 9_999_999, cap: null } }) === null);

  await assert('a zero-value hand-off (prepaid) is never refused, even over every limit', () =>
    evaluateCodLimits({ additionalAmount: 0, agency: agency(5_000_000), vendor: { exposure: 5_000_000, cap: 0 } }) === null);

  await assert('the shipment model\'s hold kinds equal the domain\'s (a literal copy, pinned here)', () =>
    JSON.stringify([...COD_LIMIT_KINDS]) === JSON.stringify([...COD_LIMIT_HOLD_KINDS]));

  // ═══ 5 · A dispatch batch ═════════════════════════════════════════════════
  console.log('\n── 5 · A batch counts the hand-offs before it ─────────────────────────\n');

  {
    const svc = stubbedLimits({ limits: { A: 1_000_000 }, rows: { A: { shipments: [], collections: [coll('c', 'v1', 600_000)] } }, caps: {} });
    const v = await svc.evaluateHandoffs([
      { shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 300_000 },
      { shipmentId: 's2', agencyId: 'A', vendorId: 'v1', amount: 300_000 },
    ]);
    await assert('two shipments to one agency: the second sees the first (600k + 300k ok, + 300k over)', () =>
      v[0].breach === null && v[1].breach?.kind === 'agency_limit' && v[1].breach.currentExposure === 900_000);
  }

  {
    const svc = stubbedLimits({ limits: { A: 1_000_000 }, rows: { A: { shipments: [], collections: [coll('c', 'v1', 900_000)] } }, caps: {} });
    const v = await svc.evaluateHandoffs([
      { shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 200_000 },
      { shipmentId: 's2', agencyId: 'A', vendorId: 'v1', amount: 50_000 },
    ], { force: true });
    await assert('with force, a breach is still REPORTED (so it can be recorded) and its amount is counted after', () =>
      v[0].breach?.kind === 'agency_limit' && v[1].breach?.currentExposure === 1_100_000);
  }

  {
    const svc = stubbedLimits({ limits: { A: 1_000_000 }, rows: { A: { shipments: [ship('s1', 'v1', 400_000)], collections: [] } }, caps: {} });
    const v = await svc.evaluateHandoffs([{ shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 400_000 }]);
    await assert('a shipment already in custody is not counted twice against itself', () => v[0].breach === null);
  }

  {
    const svc = stubbedLimits({
      limits: { A: 1_000_000 },
      rows: { A: { shipments: [ship('x', 'v2', 500_000)], collections: [coll('c', 'v1', 80_000)] } },
      caps: { v1: 100_000 },
    });
    const v = await svc.evaluateHandoffs([{ shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 30_000 }]);
    await assert('the vendor cap counts only THAT vendor\'s cash at that agency (80k + 30k > 100k)', () =>
      v[0].breach?.kind === 'vendor_terms' && v[0].breach.currentExposure === 80_000);
  }

  {
    const svc = stubbedLimits({ limits: {}, rows: {}, caps: {} });
    (svc as any).limitFor = async () => { throw new Error('a prepaid batch must cost no query'); };
    const v = await svc.evaluateHandoffs([{ shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 0 }]);
    await assert('a batch with no COD amount reads nothing and passes', () => v[0].breach === null);
  }

  {
    const svc = new CodLimitsService({} as never);
    const err = svc.limitExceededError({
      shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 5,
      breach: { kind: 'vendor_terms', currentExposure: 1, additionalAmount: 5, limit: 3 },
    }) as unknown as { code: string; statusCode: number; details: Record<string, unknown> };
    await assert('the refusal is 422 COD_AGENCY_LIMIT_EXCEEDED with { kind, currentExposure, additionalAmount, limit }', () =>
      err.code === 'COD_AGENCY_LIMIT_EXCEEDED' && err.statusCode === 422
      && err.details.kind === 'vendor_terms' && err.details.currentExposure === 1
      && err.details.additionalAmount === 5 && err.details.limit === 3);
  }

  // ═══ 6 · The agency → agent force ═════════════════════════════════════════
  console.log('\n── 6 · Force waives the AMOUNT limit and nothing else ─────────────────\n');

  const verdict = (blocker: string | null) => ({ allowed: blocker === null, blocker } as never);
  await assert('forceable: exposure_exceeded only', () =>
    isForceableCodRefusal(verdict('exposure_exceeded')) === true
    && isForceableCodRefusal(verdict('kyc_not_verified')) === false
    && isForceableCodRefusal(verdict('trust_too_low')) === false
    && isForceableCodRefusal(verdict('open_cash_shortfall')) === false
    && isForceableCodRefusal(verdict(null)) === false
    && isForceableCodRefusal(null) === false);

  /** A ContractPolicyService whose evaluate returns a fixed gate list. */
  const policyWith = (gates: Array<{ gate: string; status: string }>, blocker: string | null) => {
    const svc = new ContractPolicyService({} as never, {} as never, {
      assertVerdict: (v: { blocker: string }) => { throw Object.assign(new Error(v.blocker), { code: v.blocker }); },
    } as never);
    (svc as any).evaluate = async () => ({
      agentId: 'a', agencyId: 'A', gates: gates.map((g) => ({ ...g, reason: null, observed: {}, summary: '', remedies: [] })),
      codVerdict: blocker === null ? null : { allowed: false, blocker },
    });
    return svc;
  };
  const passGates = [{ gate: 'contract_active', status: 'passed' }, { gate: 'coverage_region', status: 'passed' }, { gate: 'shipment_value_ceiling', status: 'passed' }];

  await assert('force + exposure_exceeded → passes and reports codLimitForced', async () => {
    const r = await policyWith([...passGates, { gate: 'cod_exposure', status: 'failed' }], 'exposure_exceeded')
      .assert({} as never, 'A', {} as never, {} as never, { forceCodLimit: true });
    return r.codLimitForced === true;
  });

  for (const blocker of ['kyc_not_verified', 'trust_too_low', 'open_cash_shortfall']) {
    await assert(`force does NOT waive ${blocker}`, async () => {
      try {
        await policyWith([...passGates, { gate: 'cod_exposure', status: 'failed' }], blocker)
          .assert({} as never, 'A', {} as never, {} as never, { forceCodLimit: true });
        return false;
      } catch (err) {
        return (err as { code?: string }).code === blocker;
      }
    });
  }

  await assert('force does NOT waive a non-COD gate (coverage) even when exposure is the forceable kind', async () => {
    try {
      await policyWith(
        [{ gate: 'contract_active', status: 'passed' }, { gate: 'coverage_region', status: 'failed' },
          { gate: 'shipment_value_ceiling', status: 'passed' }, { gate: 'cod_exposure', status: 'failed' }],
        'exposure_exceeded'
      ).assert({} as never, 'A', {} as never, { } as never, { forceCodLimit: true });
      return false;
    } catch (err) {
      return (err as { code?: string }).code === ERROR_CODES.CONTRACT_COVERAGE_REGION_NOT_COVERED;
    }
  });

  await assert('WITHOUT force, exposure_exceeded still refuses', async () => {
    try {
      await policyWith([...passGates, { gate: 'cod_exposure', status: 'failed' }], 'exposure_exceeded')
        .assert({} as never, 'A', {} as never, {} as never);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'exposure_exceeded';
    }
  });

  // ═══ 7 · The agent pool default ═══════════════════════════════════════════
  console.log('\n── 7 · The agent pool: 500 000 for every verified agent ───────────────\n');

  await assert('verified, no pin → 500 000 `default`; unverified → 0', () =>
    AGENT_CONFIG.COD_POOL_DEFAULT === 500_000
    && resolveCodPoolCeiling({ kycStatus: 'verified', override: null }).amount === 500_000
    && resolveCodPoolCeiling({ kycStatus: 'verified', override: null }).source === 'default'
    && resolveCodPoolCeiling({ kycStatus: 'pending', override: null }).amount === 0);

  // ═══ 8 · Validators ═══════════════════════════════════════════════════════
  console.log('\n── 8 · Validators ─────────────────────────────────────────────────────\n');

  await assert('the agency pin takes an amount or null, and ALWAYS a reason', () =>
    parses(AdminSetAgencyCodLimitSchema, { maxAmount: 2_000_000, reason: 'trusted partner' })
    && parses(AdminSetAgencyCodLimitSchema, { maxAmount: null, reason: 'back to default' })
    && !parses(AdminSetAgencyCodLimitSchema, { maxAmount: 2_000_000 })
    && !parses(AdminSetAgencyCodLimitSchema, { maxAmount: -1, reason: 'neg' })
    && !parses(AdminSetAgencyCodLimitSchema, { maxAmount: 10, reason: 'x', extra: 1 }));

  await assert('every vendor dispatch/move body accepts an optional boolean force (absent = no force)', () =>
    parses(DispatchToAgencySchema, {}) && parses(DispatchToAgencySchema, { force: true })
    && !parses(DispatchToAgencySchema, { force: 'yes' })
    && parses(BulkDispatchToAgencySchema, { orderIds: ['64b000000000000000000001'], force: true })
    && parses(UpdateDeliveryAgencySchema, { itemId: '64b000000000000000000001', deliveryAgencyId: '64b000000000000000000002', force: true }));

  await assert('assign-agent and reassign accept force', () =>
    parses(OfferAgentSchema, { agentId: '64b000000000000000000001', force: true })
    && parses(ReassignShipmentSchema, { agentId: '64b000000000000000000001', reason: 'r', force: true }));

  // ═══ 9 · Source scans ═════════════════════════════════════════════════════
  console.log('\n── 9 · SOURCE SCANS: the wiring ───────────────────────────────────────\n');

  const orderSvc = stripComments(read('modules/orders/order.service.ts'));
  await assert('auto-redirect evaluates the gate and NEVER forces (passes `false`)', () => {
    const start = orderSvc.indexOf('private async maybeDispatchToAgencies');
    const body = orderSvc.slice(start, orderSvc.indexOf('async dispatchToAgency', start));
    return body.includes('this.evaluateCodHandoffs(order, pending, false)') && body.includes('codLimitsService.markHeld(');
  });

  await assert('manual dispatch refuses unless force, and records a forced shipment', () => {
    const start = orderSvc.indexOf('async dispatchToAgency');
    const body = orderSvc.slice(start, start + 3500);
    return body.includes('limitExceededError(') && body.includes('codLimitsService.markForced(') && body.includes("opts.force !== true");
  });

  const vendorOrderSvc = stripComments(read('modules/orders/vendor-order.service.ts'));
  await assert('change-agency-per-item runs the same gate', () => {
    const start = vendorOrderSvc.indexOf('async updateDeliveryAgency');
    const body = vendorOrderSvc.slice(start, start + 6000);
    return body.includes('codLimitsService.evaluateHandoffs(') && body.includes('limitExceededError(');
  });

  const assignment = stripComments(read('modules/shipment-assignment/domain/services/shipment-assignment.service.ts'));
  await assert('accept re-checks with the force persisted on the offer', () =>
    assignment.includes('!!offer.cod_limit_forced'));

  await assert('auto-assign never forces (autoAssign passes no force anywhere)', () => {
    const start = assignment.indexOf('async autoAssign(');
    const body = assignment.slice(start, assignment.indexOf('private async stepSession', start));
    return start > -1 && !/force/i.test(body);
  });

  const eligibility = stripComments(read('modules/cod/services/cod-eligibility.service.ts'));
  await assert('checkout refuses COD for a vendor with codEnabled=false, BEFORE any agency rule', () =>
    eligibility.indexOf('COD_VENDOR_NOT_ACCEPTED') > -1
    && eligibility.indexOf('COD_VENDOR_NOT_ACCEPTED') < eligibility.indexOf('COD_AGENCY_NOT_SUPPORTED'));

  await assert('both checkout paths name the vendor (web checkout + the quote the Mini App and the shop read)', () =>
    /assertVendorOrderEligible\(\{[\s\S]*?vendorId,[\s\S]*?\}\)/.test(orderSvc)
    && stripComments(read('modules/orders/services/cart-quote.service.ts')).includes('vendorId: input.vendorId,'));

  const vendorProfile = stripComments(read('modules/vendor/service/vendor-profile.service.ts'));
  await assert('the vendor POLICIES path does not touch COD terms (no policy_version bump from terms)', () =>
    !vendorProfile.includes('cod_terms') && !vendorProfile.includes('codTerms'));

  await assert('both new codes are registered AND carry a registry message', () => {
    const errors = read('core/errors.ts');
    return ERROR_CODES.COD_VENDOR_NOT_ACCEPTED === 'COD_VENDOR_NOT_ACCEPTED'
      && ERROR_CODES.COD_AGENCY_LIMIT_EXCEEDED === 'COD_AGENCY_LIMIT_EXCEEDED'
      && errors.includes('[ERROR_CODES.COD_VENDOR_NOT_ACCEPTED]')
      && errors.includes('[ERROR_CODES.COD_AGENCY_LIMIT_EXCEEDED]');
  });

  const agencyRoutes = stripComments(read('modules/delivery/admin-agency.routes.ts'));
  await assert('the internal admin surface serves GET + PUT /:id/cod-limit', () =>
    agencyRoutes.includes("router.get('/:id/cod-limit'") && agencyRoutes.includes("router.put('/:id/cod-limit'"));

  const agencyModel = stripComments(read('modules/delivery/delivery-agency.model.ts'));
  await assert('the agency pin schema DECLARES set_by_user_id (actorStampFields supplies only _source/_name)', () => {
    const start = agencyModel.indexOf('const AgencyCodLimitOverrideSchema');
    return start > -1 && agencyModel.slice(start, start + 700).includes('set_by_user_id:');
  });

  // ═══ 10 · The pre-checkout COD verdict on the cart quote (ADR-A09 G-10) ═══
  console.log('\n── 10 · The cart quote\'s cashOnDelivery verdict (G-10) ───────────────\n');

  await assert('every reason maps 1:1 to a checkout refusal code, and the map is exhaustive both ways', () => {
    const codes = Object.keys(COD_REASON_BY_CODE).sort();
    const reasons = Object.values(COD_REASON_BY_CODE).sort();
    return JSON.stringify(codes) === JSON.stringify([
      ERROR_CODES.COD_AGENCY_NOT_SUPPORTED,
      ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL,
      ERROR_CODES.COD_ORDER_AMOUNT_EXCEEDS_LIMIT,
      ERROR_CODES.COD_VENDOR_NOT_ACCEPTED,
    ].sort())
      && JSON.stringify(reasons) === JSON.stringify([...CASH_ON_DELIVERY_UNAVAILABLE_REASONS].sort())
      && new Set(reasons).size === reasons.length
      && COD_REASON_BY_CODE.COD_VENDOR_NOT_ACCEPTED === 'vendor_not_accepted'
      && COD_REASON_BY_CODE.COD_AGENCY_NOT_SUPPORTED === 'agency_not_supported'
      && COD_REASON_BY_CODE.COD_ORDER_AMOUNT_EXCEEDS_LIMIT === 'order_amount_exceeds_limit'
      && COD_REASON_BY_CODE.COD_NOT_AVAILABLE_FOR_DIGITAL === 'digital_items';
  });

  const refusal = (code: string, vendorId: string | null) => ({ vendorId, error: createAppError(code as never, 422) });
  await assert('pure verdict: no refusals → available; null (not evaluated) → unavailable with no reason', () => {
    const ok = cashOnDeliveryVerdictOf([]);
    const unknown = cashOnDeliveryVerdictOf(null);
    return ok.available === true && ok.reason === null && ok.vendorIds.length === 0
      && unknown.available === false && unknown.reason === null && unknown.vendorIds.length === 0;
  });
  await assert('pure verdict: the FIRST refusal names the reason, EVERY refusing shop is listed once', () => {
    const v = cashOnDeliveryVerdictOf([
      refusal(ERROR_CODES.COD_VENDOR_NOT_ACCEPTED, 'v1'),
      refusal(ERROR_CODES.COD_ORDER_AMOUNT_EXCEEDS_LIMIT, 'v2'),
      refusal(ERROR_CODES.COD_AGENCY_NOT_SUPPORTED, 'v1'),
    ]);
    return v.available === false && v.reason === 'vendor_not_accepted' && JSON.stringify(v.vendorIds) === '["v1","v2"]';
  });
  await assert('pure verdict: the digital rule is basket-wide (no vendor ids)', () => {
    const v = cashOnDeliveryVerdictOf([refusal(ERROR_CODES.COD_NOT_AVAILABLE_FOR_DIGITAL, null)]);
    return v.reason === 'digital_items' && v.vendorIds.length === 0;
  });

  /** The quote's refusal collector, driven through the REAL CodEligibilityService over stubbed reads. */
  const eligibilityOver = (world: {
    vendors: Record<string, { cod_enabled?: boolean }>;
    agencies: Record<string, { cod: boolean; verified?: boolean; max?: number | null }>;
  }) => new CodEligibilityService(
    {
      findByIds: async (ids: string[]) => ids.filter((id) => world.agencies[id]).map((id) => ({
        _id: id,
        status: 'active',
        kyc_details: { legit_verified: world.agencies[id].verified ?? true },
        policies: { cod: { enabled: world.agencies[id].cod, max_order_amount: world.agencies[id].max ?? null } },
      })),
    } as never,
    { findNamesByAgencyIds: async () => new Map() } as never,
    { findCodTerms: async (vendorId: string) => world.vendors[vendorId] ?? null } as never,
  );
  const quoteOver = (elig: CodEligibilityService) =>
    new CartQuoteService({} as never, {} as never, {} as never, {} as never, {} as never, elig);
  const AG1 = 'a00000000000000000000001';
  const AG2 = 'a00000000000000000000002';
  const input = (vendorId: string, agencyIds: string[], unitPrice = 10_000) => ({
    vendorId,
    physical: true,
    lines: [{ unitPrice, quantity: 1, floorPrice: null }],
    groups: agencyIds.map((agencyId) => ({ agencyId, mix: { hasPickupBased: true, hasStorageBased: false }, lines: [] })),
  });
  const verdictFor = async (elig: CodEligibilityService, productType: string | null, inputs: unknown[]) => {
    const svc = quoteOver(elig);
    const perVendor = (inputs as Array<{ vendorId: string; lines: Array<{ unitPrice: number; quantity: number }> }>)
      .map((i) => ({ vendorId: i.vendorId, subtotal: i.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) }));
    return cashOnDeliveryVerdictOf(await (svc as any).codRefusalsOf(productType, inputs, perVendor));
  };

  const happy = eligibilityOver({ vendors: { v1: { cod_enabled: true } }, agencies: { [AG1]: { cod: true } } });
  await assert('collector: an accepting vendor + a COD-capable verified agency → available', async () =>
    (await verdictFor(happy, 'physical', [input('v1', [AG1])])).available === true);
  await assert('collector: a digital basket → digital_items, without asking any agency', async () =>
    (await verdictFor(happy, 'digital', [input('v1', [AG1])])).reason === 'digital_items');
  await assert('collector: vendor codEnabled=false → vendor_not_accepted (checkout\'s COD_VENDOR_NOT_ACCEPTED)', async () => {
    const elig = eligibilityOver({ vendors: { v1: { cod_enabled: false } }, agencies: { [AG1]: { cod: true } } });
    const v = await verdictFor(elig, 'physical', [input('v1', [AG1])]);
    return v.available === false && v.reason === 'vendor_not_accepted' && v.vendorIds[0] === 'v1';
  });
  await assert('collector: agency without COD, or unverified → agency_not_supported', async () => {
    const off = await verdictFor(eligibilityOver({ vendors: {}, agencies: { [AG1]: { cod: false } } }), 'physical', [input('v1', [AG1])]);
    const unverified = await verdictFor(eligibilityOver({ vendors: {}, agencies: { [AG1]: { cod: true, verified: false } } }), 'physical', [input('v1', [AG1])]);
    return off.reason === 'agency_not_supported' && unverified.reason === 'agency_not_supported';
  });
  await assert('collector: a shop with no resolvable agency → agency_not_supported (never "available")', async () =>
    (await verdictFor(happy, 'physical', [input('v1', [])])).reason === 'agency_not_supported');
  await assert('collector: the shop\'s subtotal above the agency per-order max → order_amount_exceeds_limit', async () => {
    const elig = eligibilityOver({ vendors: {}, agencies: { [AG1]: { cod: true, max: 5_000 } } });
    const over = await verdictFor(elig, 'physical', [input('v1', [AG1], 10_000)]);
    const at = await verdictFor(elig, 'physical', [input('v1', [AG1], 5_000)]);
    return over.reason === 'order_amount_exceeds_limit' && at.available === true;
  });
  await assert('collector: two shops — only the refusing one is listed; one refusal makes the basket unavailable', async () => {
    const elig = eligibilityOver({ vendors: { v2: { cod_enabled: false } }, agencies: { [AG1]: { cod: true }, [AG2]: { cod: true } } });
    const v = await verdictFor(elig, 'physical', [input('v1', [AG1]), input('v2', [AG2])]);
    return v.available === false && v.reason === 'vendor_not_accepted' && JSON.stringify(v.vendorIds) === '["v2"]';
  });
  await assert('collector: a non-AppError lookup failure propagates (the quote turns it into "not evaluated")', async () => {
    const broken = new CodEligibilityService(
      { findByIds: async () => { throw new TypeError('db down'); } } as never,
      { findNamesByAgencyIds: async () => new Map() } as never,
      { findCodTerms: async () => null } as never,
    );
    try {
      await verdictFor(broken, 'physical', [input('v1', [AG1])]);
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  });

  const quoteSrc = stripComments(read('modules/orders/services/cart-quote.service.ts'));
  await assert('the quote asks CHECKOUT\'s own rule (assertVendorOrderEligible), on every quote, and catches a failure', () =>
    quoteSrc.includes('this.codEligibility.assertVendorOrderEligible({')
    && quoteSrc.includes('cashOnDelivery: cashOnDeliveryVerdictOf(refusals),')
    && /catch \(error\) \{\s*console\.error\('\[CartQuoteService\] Cash-on-delivery eligibility not evaluable:'/.test(quoteSrc));
  await assert('exposure holds are NOT part of the verdict (they never refuse a customer)', () =>
    !/codLimitsService|evaluateHandoffs|evaluateCodLimits|COD_AGENCY_LIMIT_EXCEEDED/.test(quoteSrc));
  await assert('the verdict leaks no vendor setting or agency limit (shape is available / reason / vendorIds)', () => {
    const start = quoteSrc.indexOf('export interface CashOnDeliveryQuote');
    const body = quoteSrc.slice(start, quoteSrc.indexOf('}', start));
    const fields = [...body.matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).sort();
    return JSON.stringify(fields) === '["available","reason","vendorIds"]';
  });
  await assert('the Mini App reads the SAME refusal (no second eligibility call)', () => {
    const mini = stripComments(read('modules/bot-surface/miniapp/surfaces/checkout.controller.ts'));
    return mini.includes('cartQuoteService.quoteWithCodRefusal(') && !mini.includes('assertVendorOrderEligible');
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
