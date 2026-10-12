/**
 * Test: the administrator's cash-on-delivery restriction (owner decision, 2026-10-10).
 *
 * An administrator may switch COD off for one CUSTOMER or one delivery AGENCY, and back on.
 * With nothing recorded — the state of every account written before the feature — COD must
 * behave exactly as it did, and most of this suite is that sentence asserted from both sides.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free: the rules are pure and the services are driven through injected reads.
 *
 *   1. The rule — absent / null read as NOT restricted; the two views.
 *   2. A restricted CUSTOMER at checkout, and on the cart quote.
 *   3. A restricted AGENCY at checkout — the same answer as an agency that never opted in.
 *   4. A restricted AGENCY at hand-off — refused first, zero-value passes, force never waives.
 *   5. The write — a compare-and-set, with its three refusals.
 *   6. The validator.
 *   7. SOURCE SCANS — the wiring no behavioural test can see.
 *
 * Run: npm run test:cod-restrictions
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  COD_RESTRICTION_REASON_MAX,
  COD_RESTRICTION_SUBJECTS,
  codRestrictionPublicViewOf,
  codRestrictionViewOf,
  isCodRestricted,
} from '../../src/modules/cod/domain/cod-restriction';
import {
  COD_LIMIT_HOLD_KINDS,
  evaluateCodLimits,
  isForceableCodBreach,
} from '../../src/modules/cod/domain/cod-limits';
import { CodEligibilityService } from '../../src/modules/cod/services/cod-eligibility.service';
import { CodLimitsService } from '../../src/modules/cod/services/cod-limits.service';
import { CodRestrictionPorts, CodRestrictionService } from '../../src/modules/cod/services/cod-restriction.service';
import { AdminSetCodRestrictionSchema } from '../../src/modules/cod/validators/cod-restriction.validator';
import { CartQuoteService, cashOnDeliveryVerdictOf } from '../../src/modules/orders/services/cart-quote.service';
import { COD_LIMIT_KINDS } from '../../src/modules/shipments/shipment.model';
import { VENDOR_COD_HOLD_REASON } from '../../src/modules/notifications/catalog/notification-catalog';
import { __BOT_ERROR_COPY } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { AppError, DEFAULT_ERROR_MESSAGES, GENERIC_ERROR_MESSAGE } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';

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

/** The refusal an async call raises, or null when it resolves. */
async function refusalOf(fn: () => Promise<unknown>): Promise<AppError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

const AT = new Date('2026-10-10T09:00:00.000Z');
const STORED = {
  reason: 'Refused three parcels without a valid reason',
  restricted_at: AT,
  restricted_by_user_id: 'adm_1',
  restricted_by_source: 'admin' as const,
  restricted_by_name: 'Ada Admin',
};

const CUSTOMER = 'c00000000000000000000001';
const AG1 = 'a00000000000000000000001';
const AG2 = 'a00000000000000000000002';

/** The REAL eligibility service over stubbed reads. */
function eligibilityOver(world: {
  restrictedCustomers?: string[];
  agencies?: Record<string, { cod?: boolean; restriction?: unknown; omitField?: boolean }>;
}): CodEligibilityService {
  return new CodEligibilityService(
    {
      findByIds: async (ids: string[]) => ids.filter((id) => world.agencies?.[id]).map((id) => {
        const a = world.agencies![id];
        const doc: Record<string, unknown> = {
          _id: id,
          status: 'active',
          kyc_details: { legit_verified: true },
          policies: { cod: { enabled: a.cod ?? true, max_order_amount: null } },
        };
        // `omitField` is a document written before 2026-10-10: the key is not there at all.
        if (!a.omitField) doc.cod_restriction = a.restriction ?? null;
        return doc;
      }),
    } as never,
    { findNamesByAgencyIds: async () => new Map() } as never,
    { findCodTerms: async () => null } as never,
    { isCustomerRestricted: async (id: string) => (world.restrictedCustomers ?? []).includes(id) },
  );
}

const quoteInput = (vendorId: string, agencyIds: string[]) => ({
  vendorId,
  physical: true,
  lines: [{ unitPrice: 10_000, quantity: 1 }],
  groups: agencyIds.map((agencyId) => ({ agencyId })),
});

async function quoteVerdict(elig: CodEligibilityService, productType: string | null, inputs: Array<ReturnType<typeof quoteInput>>) {
  const svc = new CartQuoteService({} as never, {} as never, elig);
  const perVendor = inputs.map((i) => ({ vendorId: i.vendorId, subtotal: 10_000 }));
  return cashOnDeliveryVerdictOf(await (svc as any).codRefusalsOf(CUSTOMER, productType, inputs, perVendor));
}

/** A CodLimitsService whose three reads are stubs — the batch logic runs for real. */
function limitsOver(world: { limits: Record<string, number>; restricted: string[] }): CodLimitsService {
  const svc = new CodLimitsService({} as never);
  (svc as any).limitFor = async (agencyId: string) => ({
    limit: { amount: world.limits[agencyId], source: 'default' },
    override: null,
    restriction: { restricted: world.restricted.includes(agencyId), restrictedAt: null },
  });
  (svc as any).exposureRows = async () => ({ shipments: [], collections: [] });
  (svc as any).vendorTerms = async () => ({ codEnabled: true, maxCashPerAgency: null });
  return svc;
}

/** In-memory ports with the SAME conditional-write semantics as the Mongo ones. */
function memoryPorts(seed: {
  customers?: Record<string, { id: string; restriction: unknown }>;
  agencies?: Record<string, { userId: string; restriction: unknown }>;
}): CodRestrictionPorts & { writes: number } {
  const customers = seed.customers ?? {};
  const agencies = seed.agencies ?? {};
  const conditional = (current: unknown, next: Record<string, unknown> | null): boolean =>
    next === null ? isCodRestricted(current) : !isCodRestricted(current);
  const ports = {
    writes: 0,
    async findCustomerByUser(userId: string) {
      const c = customers[userId];
      return c ? { id: c.id, userId, codRestriction: c.restriction } : null;
    },
    async findCustomerById(customerId: string) {
      const hit = Object.entries(customers).find(([, c]) => c.id === customerId);
      return hit ? { id: hit[1].id, userId: hit[0], codRestriction: hit[1].restriction } : null;
    },
    async findAgency(agencyId: string) {
      const a = agencies[agencyId];
      return a ? { id: agencyId, userId: a.userId, codRestriction: a.restriction } : null;
    },
    async writeCustomerByUser(userId: string, next: Record<string, unknown> | null) {
      const c = customers[userId];
      if (!c || !conditional(c.restriction, next)) return null;
      c.restriction = next;
      ports.writes++;
      return { id: c.id, userId, codRestriction: next };
    },
    async writeAgency(agencyId: string, next: Record<string, unknown> | null) {
      const a = agencies[agencyId];
      if (!a || !conditional(a.restriction, next)) return null;
      a.restriction = next;
      ports.writes++;
      return { id: agencyId, userId: a.userId, codRestriction: next };
    },
  };
  return ports;
}

const ADMIN = { userId: 'adm_1', source: 'admin' as const, name: 'Ada Admin' };

async function main(): Promise<void> {
  // ═══ 1 · The rule ═════════════════════════════════════════════════════════
  console.log('\n── 1 · The rule: nothing recorded means nothing changed ───────────────\n');

  await assert('an ABSENT field (every document written before the feature) is not restricted', () =>
    isCodRestricted(undefined) === false);
  await assert('null is not restricted', () => isCodRestricted(null) === false);
  await assert('an empty sub-document is not restricted (no restricted_at)', () => isCodRestricted({}) === false);
  await assert('a recorded restriction is restricted', () => isCodRestricted(STORED) === true);
  await assert('the two subjects are customer and agency, and nothing else', () =>
    JSON.stringify([...COD_RESTRICTION_SUBJECTS]) === '["customer","agency"]');

  await assert('the administrator\'s view carries the reason and the author', () => {
    const v = codRestrictionViewOf(STORED);
    return v !== null && v.reason === STORED.reason && v.restrictedAt === AT
      && v.restrictedByUserId === 'adm_1' && v.restrictedBySource === 'admin' && v.restrictedByName === 'Ada Admin';
  });
  await assert('...and is null when unrestricted', () => codRestrictionViewOf(null) === null && codRestrictionViewOf(undefined) === null);
  await assert('the PUBLIC view (what the restricted party may read) carries NO reason and NO author', () => {
    const v = codRestrictionPublicViewOf(STORED);
    const json = JSON.stringify(v);
    return v.restricted === true && v.restrictedAt === AT
      && !json.includes('Refused') && !json.includes('Ada') && !json.includes('adm_1')
      && JSON.stringify(Object.keys(v).sort()) === '["restricted","restrictedAt"]';
  });
  await assert('the public view of an unrestricted account is { restricted: false, restrictedAt: null }', () => {
    const v = codRestrictionPublicViewOf(null);
    return v.restricted === false && v.restrictedAt === null;
  });

  // ═══ 2 · A restricted customer ════════════════════════════════════════════
  console.log('\n── 2 · A restricted CUSTOMER — checkout and the cart quote ────────────\n');

  const open = eligibilityOver({ agencies: { [AG1]: {} } });
  const barred = eligibilityOver({ restrictedCustomers: [CUSTOMER], agencies: { [AG1]: {} } });

  await assert('BASELINE: an unrestricted customer is allowed', async () =>
    (await refusalOf(() => open.assertCustomerAllowed(CUSTOMER))) === null);
  await assert('a restricted customer is refused 422 COD_CUSTOMER_RESTRICTED', async () => {
    const e = await refusalOf(() => barred.assertCustomerAllowed(CUSTOMER));
    return e?.code === ERROR_CODES.COD_CUSTOMER_RESTRICTED && e.statusCode === 422 && e.category === 'business_rule';
  });
  await assert('...and the refusal carries NO details — the reason is the administrator\'s', async () => {
    const e = await refusalOf(() => barred.assertCustomerAllowed(CUSTOMER));
    return e !== null && e.details === undefined;
  });
  await assert('...another customer is untouched', async () =>
    (await refusalOf(() => barred.assertCustomerAllowed('c00000000000000000000002'))) === null);

  await assert('BASELINE quote: an unrestricted customer with a COD-capable agency → available', async () =>
    (await quoteVerdict(open, 'physical', [quoteInput('v1', [AG1])])).available === true);
  await assert('quote: a restricted customer → customer_restricted, no shop named', async () => {
    const v = await quoteVerdict(barred, 'physical', [quoteInput('v1', [AG1])]);
    return v.available === false && v.reason === 'customer_restricted' && v.vendorIds.length === 0;
  });
  await assert('quote: customer_restricted is the FIRST reason even when a shop refuses too (no basket change helps)', async () => {
    const elig = eligibilityOver({ restrictedCustomers: [CUSTOMER], agencies: { [AG1]: { cod: false } } });
    const v = await quoteVerdict(elig, 'physical', [quoteInput('v1', [AG1])]);
    return v.reason === 'customer_restricted' && JSON.stringify(v.vendorIds) === '["v1"]';
  });
  await assert('quote: a digital basket still answers digital_items (the basket rule is asked first)', async () =>
    (await quoteVerdict(barred, 'digital', [quoteInput('v1', [AG1])])).reason === 'digital_items');
  await assert('quote: a lookup failure propagates rather than reading as "allowed"', async () => {
    const broken = new CodEligibilityService(
      { findByIds: async () => [] } as never,
      { findNamesByAgencyIds: async () => new Map() } as never,
      { findCodTerms: async () => null } as never,
      { isCustomerRestricted: async () => { throw new TypeError('db down'); } },
    );
    try {
      await quoteVerdict(broken, 'physical', [quoteInput('v1', [AG1])]);
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  });

  // ═══ 3 · A restricted agency at checkout ══════════════════════════════════
  console.log('\n── 3 · A restricted AGENCY — checkout ─────────────────────────────────\n');

  const order = (elig: CodEligibilityService, agencyIds: string[]) =>
    refusalOf(() => elig.assertVendorOrderEligible({ orderType: 'physical', totalAmount: 10_000, agencyIds, vendorId: 'v1' }));

  await assert('BASELINE: an agency with cod_restriction: null is eligible', async () =>
    (await order(eligibilityOver({ agencies: { [AG1]: {} } }), [AG1])) === null);
  await assert('BASELINE: an agency document with NO cod_restriction key at all is eligible', async () =>
    (await order(eligibilityOver({ agencies: { [AG1]: { omitField: true } } }), [AG1])) === null);
  await assert('a restricted agency refuses COD although its own policies.cod.enabled is true', async () => {
    const e = await order(eligibilityOver({ agencies: { [AG1]: { cod: true, restriction: STORED } } }), [AG1]);
    return e?.code === ERROR_CODES.COD_AGENCY_NOT_SUPPORTED && e.statusCode === 422;
  });
  await assert('...with the SAME code as an agency that never opted in (the shopper is not told it was sanctioned)', async () => {
    const restricted = await order(eligibilityOver({ agencies: { [AG1]: { restriction: STORED } } }), [AG1]);
    const optedOut = await order(eligibilityOver({ agencies: { [AG1]: { cod: false } } }), [AG1]);
    return restricted?.code === optedOut?.code
      && JSON.stringify(Object.keys(restricted?.details ?? {}).sort()) === JSON.stringify(Object.keys(optedOut?.details ?? {}).sort());
  });
  await assert('...and the refusal does not carry the reason', async () => {
    const e = await order(eligibilityOver({ agencies: { [AG1]: { restriction: STORED } } }), [AG1]);
    return !JSON.stringify(e?.details ?? {}).includes('Refused');
  });
  await assert('one restricted agency among two refuses the order (every carrying agency must take cash)', async () => {
    const e = await order(eligibilityOver({ agencies: { [AG1]: {}, [AG2]: { restriction: STORED } } }), [AG1, AG2]);
    return e?.code === ERROR_CODES.COD_AGENCY_NOT_SUPPORTED && e.details?.agencyId === AG2;
  });
  await assert('quote: a restricted agency reads agency_not_supported and names the shop', async () => {
    const v = await quoteVerdict(eligibilityOver({ agencies: { [AG1]: { restriction: STORED } } }), 'physical', [quoteInput('v1', [AG1])]);
    return v.available === false && v.reason === 'agency_not_supported' && JSON.stringify(v.vendorIds) === '["v1"]';
  });

  // ═══ 4 · A restricted agency at hand-off ══════════════════════════════════
  console.log('\n── 4 · A restricted AGENCY — hand-off of a COD shipment ───────────────\n');

  await assert('the hold kinds gained agency_restricted, in both copies of the list', () =>
    (COD_LIMIT_HOLD_KINDS as readonly string[]).includes('agency_restricted')
    && JSON.stringify([...COD_LIMIT_KINDS]) === JSON.stringify([...COD_LIMIT_HOLD_KINDS]));

  await assert('BASELINE: an agency with headroom and no restriction passes', () =>
    evaluateCodLimits({ additionalAmount: 50_000, agency: { exposure: 0, limit: 1_000_000 }, vendor: null }) === null);
  await assert('BASELINE: restricted: false passes exactly like an absent flag', () =>
    evaluateCodLimits({ additionalAmount: 50_000, agency: { exposure: 0, limit: 1_000_000, restricted: false }, vendor: null }) === null);
  await assert('a restricted agency is refused with all its headroom free — it is not an amount', () => {
    const b = evaluateCodLimits({ additionalAmount: 50_000, agency: { exposure: 0, limit: 1_000_000, restricted: true }, vendor: null });
    return b?.kind === 'agency_restricted' && b.limit === 0 && b.additionalAmount === 50_000;
  });
  await assert('restricted outranks an amount breach (waiting for a remittance would change nothing)', () =>
    evaluateCodLimits({ additionalAmount: 2_000_000, agency: { exposure: 0, limit: 1_000_000, restricted: true }, vendor: { exposure: 0, cap: 10 } })?.kind === 'agency_restricted');
  await assert('a zero-value hand-off (a PREPAID shipment) still passes — the restriction is COD only', () =>
    evaluateCodLimits({ additionalAmount: 0, agency: { exposure: 0, limit: 1_000_000, restricted: true }, vendor: null }) === null);

  await assert('force waives the two AMOUNT kinds and never agency_restricted', () =>
    isForceableCodBreach({ kind: 'agency_limit' }) && isForceableCodBreach({ kind: 'vendor_terms' })
    && !isForceableCodBreach({ kind: 'agency_restricted' }));

  {
    const svc = limitsOver({ limits: { A: 1_000_000, B: 1_000_000 }, restricted: ['A'] });
    const v = await svc.evaluateHandoffs([
      { shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 100_000 },
      { shipmentId: 's2', agencyId: 'B', vendorId: 'v1', amount: 100_000 },
      { shipmentId: 's3', agencyId: 'A', vendorId: 'v1', amount: 0 },
    ]);
    await assert('batch: the restricted agency\'s COD shipment is refused, another agency\'s goes, a prepaid one goes', () =>
      v[0].breach?.kind === 'agency_restricted' && v[1].breach === null && v[2].breach === null);
  }
  {
    const svc = limitsOver({ limits: { A: 1_000_000 }, restricted: ['A'] });
    const v = await svc.evaluateHandoffs([
      { shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 400_000 },
      { shipmentId: 's2', agencyId: 'A', vendorId: 'v1', amount: 400_000 },
    ], { force: true });
    await assert('batch WITH force: still refused, and a refused shipment is not counted as going', () =>
      v[0].breach?.kind === 'agency_restricted' && v[1].breach?.kind === 'agency_restricted' && v[1].breach.currentExposure === 0);
  }
  {
    const svc = limitsOver({ limits: { A: 1_000_000 }, restricted: ['A'] });
    const [verdict] = await svc.evaluateHandoffs([{ shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 100_000 }]);
    const e = svc.limitExceededError(verdict) as AppError;
    await assert('the hand-off refusal is 422 COD_AGENCY_RESTRICTED, not the forceable COD_AGENCY_LIMIT_EXCEEDED', () =>
      e.code === ERROR_CODES.COD_AGENCY_RESTRICTED && e.statusCode === 422
      && e.details?.kind === 'agency_restricted' && e.details?.agencyId === 'A' && e.details?.shipmentId === 's1');
    await assert('...its hint does not tell the vendor to retry with force', () =>
      !/retry with force/i.test(String(e.details?.hint ?? '')) && /another agency/i.test(String(e.details?.hint ?? '')));
  }
  {
    const svc = limitsOver({ limits: { A: 100 }, restricted: [] });
    const [verdict] = await svc.evaluateHandoffs([{ shipmentId: 's1', agencyId: 'A', vendorId: 'v1', amount: 100_000 }]);
    await assert('BASELINE: an amount breach is still COD_AGENCY_LIMIT_EXCEEDED', () =>
      (svc.limitExceededError(verdict) as AppError).code === ERROR_CODES.COD_AGENCY_LIMIT_EXCEEDED);
  }

  await assert('the vendor\'s hold notice has an agency_restricted line in all five languages, with no placeholder', () => {
    const line = VENDOR_COD_HOLD_REASON.agency_restricted as Record<string, string>;
    return ['en', 'fr', 'pt', 'es', 'ar'].every((l) => typeof line[l] === 'string' && line[l].length > 10 && !line[l].includes('{{'));
  });

  // ═══ 5 · The write ════════════════════════════════════════════════════════
  console.log('\n── 5 · The write — a compare-and-set ──────────────────────────────────\n');

  {
    const ports = memoryPorts({ customers: { u1: { id: CUSTOMER, restriction: null } } });
    const svc = new CodRestrictionService(ports);

    const before = await svc.reportForCustomerUser('u1');
    await assert('BASELINE read: a customer nobody touched reports restricted: false, restriction: null', () =>
      before.subject === 'customer' && before.subjectId === CUSTOMER && before.userId === 'u1'
      && before.restricted === false && before.restriction === null);

    const set = await svc.setForCustomerUser({ userId: 'u1', restricted: true, reason: STORED.reason, actor: ADMIN });
    await assert('restricting stamps the reason, the time and the administrator (source: admin, name snapshot)', () =>
      set.restricted === true && set.restriction?.reason === STORED.reason
      && set.restriction.restrictedAt instanceof Date
      && set.restriction.restrictedByUserId === 'adm_1' && set.restriction.restrictedBySource === 'admin'
      && set.restriction.restrictedByName === 'Ada Admin');
    await assert('...and the eligibility read now sees it', async () => (await svc.isCustomerRestricted(CUSTOMER)) === true);

    const again = await refusalOf(() => svc.setForCustomerUser({ userId: 'u1', restricted: true, reason: 'a second reason', actor: ADMIN }));
    await assert('restricting an already-restricted customer is 409 COD_RESTRICTION_UNCHANGED', () =>
      again?.code === ERROR_CODES.COD_RESTRICTION_UNCHANGED && again.statusCode === 409 && again.details?.restricted === true);
    await assert('...and the first reason is still the one on record (the refused write wrote nothing)', async () =>
      (await svc.reportForCustomerUser('u1')).restriction?.reason === STORED.reason && ports.writes === 1);

    const lifted = await svc.setForCustomerUser({ userId: 'u1', restricted: false, reason: 'Apologised; agreed to stop', actor: ADMIN });
    await assert('lifting clears the field entirely — restriction: null, as if never set', () =>
      lifted.restricted === false && lifted.restriction === null);
    await assert('...and the customer is allowed again', async () => (await svc.isCustomerRestricted(CUSTOMER)) === false);

    const liftAgain = await refusalOf(() => svc.setForCustomerUser({ userId: 'u1', restricted: false, reason: 'again', actor: ADMIN }));
    await assert('lifting an unrestricted customer is 409 COD_RESTRICTION_UNCHANGED', () =>
      liftAgain?.code === ERROR_CODES.COD_RESTRICTION_UNCHANGED && liftAgain.details?.restricted === false);

    const noProfile = await refusalOf(() => svc.setForCustomerUser({ userId: 'vendor-only', restricted: true, reason: 'x y z', actor: ADMIN }));
    await assert('an account with NO customer profile is 404 AUTH_PROFILE_NOT_FOUND (it cannot order at all)', () =>
      noProfile?.code === ERROR_CODES.AUTH_PROFILE_NOT_FOUND && noProfile.statusCode === 404);
    await assert('...on the read too', async () =>
      (await refusalOf(() => svc.reportForCustomerUser('vendor-only')))?.code === ERROR_CODES.AUTH_PROFILE_NOT_FOUND);
    await assert('an UNKNOWN customer id reads as not restricted (a narrowing rule, not an authorisation)', async () =>
      (await svc.isCustomerRestricted('c0000000000000000000ffff')) === false);
  }

  {
    const ports = memoryPorts({ agencies: { [AG1]: { userId: 'u9', restriction: null } } });
    const svc = new CodRestrictionService(ports);
    const set = await svc.setForAgency({ agencyId: AG1, restricted: true, reason: 'Two remittances overdue', actor: ADMIN });
    await assert('agency: restricting reports subject agency with the reason and the author', () =>
      set.subject === 'agency' && set.subjectId === AG1 && set.userId === 'u9'
      && set.restricted === true && set.restriction?.reason === 'Two remittances overdue');
    await assert('agency: restricting twice is 409', async () =>
      (await refusalOf(() => svc.setForAgency({ agencyId: AG1, restricted: true, reason: 'again', actor: ADMIN })))?.statusCode === 409);
    await assert('agency: lifting clears it', async () =>
      (await svc.setForAgency({ agencyId: AG1, restricted: false, reason: 'Cash received', actor: ADMIN })).restriction === null);
    await assert('agency: an unknown agency is 404 DELIVERY_AGENCY_NOT_FOUND, on the write and the read', async () =>
      (await refusalOf(() => svc.setForAgency({ agencyId: AG2, restricted: true, reason: 'x y z', actor: ADMIN })))?.code === ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND
      && (await refusalOf(() => svc.reportForAgency(AG2)))?.code === ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND);
  }

  // ═══ 6 · The validator ════════════════════════════════════════════════════
  console.log('\n── 6 · The validator ──────────────────────────────────────────────────\n');

  const parses = (v: unknown) => AdminSetCodRestrictionSchema.safeParse(v).success;
  await assert('{ restricted: true, reason } parses', () => parses({ restricted: true, reason: 'Refused three parcels' }));
  await assert('a LIFT needs a reason too (it survives only in the audit row)', () =>
    parses({ restricted: false, reason: 'Resolved with support' }) && !parses({ restricted: false }));
  await assert('restricted must be a boolean, and present', () =>
    !parses({ reason: 'no flag at all' }) && !parses({ restricted: 'true', reason: 'a string flag' }));
  await assert('the reason is trimmed, at least 3 characters and at most the shared maximum', () =>
    !parses({ restricted: true, reason: '  a ' }) && parses({ restricted: true, reason: 'x'.repeat(COD_RESTRICTION_REASON_MAX) })
    && !parses({ restricted: true, reason: 'x'.repeat(COD_RESTRICTION_REASON_MAX + 1) }));
  await assert('strict: the subject is the path, so an id in the body is a 400', () =>
    !parses({ restricted: true, reason: 'three parcels', userId: 'u1' }) && !parses({ restricted: true, reason: 'three parcels', agencyId: AG1 }));

  // ═══ 7 · Source scans ═════════════════════════════════════════════════════
  console.log('\n── 7 · SOURCE SCANS — the wiring ──────────────────────────────────────\n');

  const orderSvc = stripComments(read('modules/orders/order.service.ts'));
  await assert('checkout asks assertCustomerAllowed for a COD checkout, BEFORE the delivery address and the transaction', () => {
    const at = orderSvc.indexOf('codEligibilityService.assertCustomerAllowed(customerId)');
    const guard = orderSvc.lastIndexOf("paymentMethod === 'cash_on_delivery'", at);
    return at > -1 && guard > -1 && at - guard < 120
      && at < orderSvc.indexOf('this.resolveDeliveryAddress(customerId, deliveryInput)')
      && at < orderSvc.indexOf('await this.buildVendorOrder(');
  });
  await assert('manual dispatch refuses a non-forceable breach BEFORE it looks at force', () => {
    const fn = orderSvc.slice(orderSvc.indexOf('async dispatchToAgency('), orderSvc.indexOf('private async evaluateCodHandoffs('));
    const blocked = fn.indexOf('!isForceableCodBreach(v.breach)');
    return blocked > -1 && blocked < fn.indexOf('opts.force !== true') && blocked < fn.indexOf('assignPendingByIds(');
  });
  const vendorOrderSvc = stripComments(read('modules/orders/vendor-order.service.ts'));
  await assert('change-agency refuses a non-forceable breach even with force: true', () =>
    /opts\.force !== true \|\| !isForceableCodBreach\(verdict\.breach\)/.test(vendorOrderSvc));

  const quoteSrc = stripComments(read('modules/orders/services/cart-quote.service.ts'));
  await assert('the quote asks the customer rule through the eligibility service, once, before the per-shop loop', () => {
    const at = quoteSrc.indexOf('this.codEligibility.assertCustomerAllowed(customerId)');
    return at > -1 && at < quoteSrc.indexOf('this.codEligibility.assertVendorOrderEligible({')
      && quoteSrc.split('assertCustomerAllowed(').length === 2;
  });

  const eligSrc = stripComments(read('modules/cod/services/cod-eligibility.service.ts'));
  await assert('the agency condition reads cod_restriction through the one rule (isCodRestricted)', () =>
    eligSrc.includes('isCodRestricted(agency.cod_restriction)'));

  const limitsSrc = stripComments(read('modules/cod/services/cod-limits.service.ts'));
  await assert('the hand-off gate loads cod_restriction with the limit, and feeds it to the pure rule', () =>
    limitsSrc.includes('cod_limit_override: 1, cod_restriction: 1')
    && limitsSrc.includes('restricted: agencyLimit.restriction.restricted'));
  await assert('the agency-facing limit report says restricted and when, and reportForAgency adds no reason', () => {
    const forAgency = limitsSrc.slice(limitsSrc.indexOf('async reportForAgency('), limitsSrc.indexOf('async evaluateHandoffs('));
    return limitsSrc.includes('codRestricted: restriction.restricted') && limitsSrc.includes('codRestrictedAt: restriction.restrictedAt')
      && !forAgency.includes('reason');
  });

  const customerModel = stripComments(read('modules/customers/customer.model.ts'));
  const agencyModel = stripComments(read('modules/delivery/delivery-agency.model.ts'));
  await assert('both models embed the shared sub-schema with default: null (never an empty object)', () =>
    customerModel.includes('cod_restriction: { type: CodRestrictionSchema, default: null }')
    && agencyModel.includes('cod_restriction: { type: CodRestrictionSchema, default: null }'));
  const typesSrc = stripComments(read('core/types/cod-restriction.types.ts'));
  await assert('the sub-schema DECLARES restricted_by_user_id (actorStampFields supplies only _source/_name)', () =>
    typesSrc.includes('restricted_by_user_id:') && typesSrc.includes("...actorStampFields('restricted_by')"));

  await assert('ONE writer: no file but the restriction service writes cod_restriction', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!full.endsWith('.ts') || full.endsWith(join('cod', 'services', 'cod-restriction.service.ts'))) continue;
        const src = stripComments(readFileSync(full, 'utf8'));
        if (/\$set:\s*\{[^}]*cod_restriction|['"]cod_restriction['"]\s*:|cod_restriction\s*=[^=]/.test(src)) offenders.push(full);
      }
    };
    walk(SRC);
    if (offenders.length) console.error('     writers:', offenders.join(', '));
    return offenders.length === 0;
  });
  const restrictionSvc = stripComments(read('modules/cod/services/cod-restriction.service.ts'));
  await assert('the write is CONDITIONAL on the opposite state (the compare-and-set is in the filter)', () =>
    restrictionSvc.includes('{ cod_restriction: { $ne: null } }') && restrictionSvc.includes('{ cod_restriction: null }')
    && restrictionSvc.includes('...stateFilter(next)') && restrictionSvc.split('...stateFilter(next)').length === 3);

  const userRoutes = stripComments(read('modules/users/admin-user.routes.ts'));
  const agencyRoutes = stripComments(read('modules/delivery/admin-agency.routes.ts'));
  await assert('the internal admin surface serves GET + PUT /users/:userId/cod-restriction', () =>
    userRoutes.includes("router.get('/:userId/cod-restriction'") && userRoutes.includes("router.put('/:userId/cod-restriction'"));
  await assert('...and GET + PUT /agencies/:id/cod-restriction', () =>
    agencyRoutes.includes("router.get('/:id/cod-restriction'") && agencyRoutes.includes("router.put('/:id/cod-restriction'"));
  await assert('there is NO self-service route: no customer/agency/vendor/agent router mentions cod-restriction', () =>
    ![
      'modules/cod/controllers/agency-cod.controller.ts',
      'modules/cod/controllers/agent-cod.controller.ts',
      'modules/delivery/agency.routes.ts',
      'modules/vendor/routes.ts',
      'api/index.ts',
    ].some((f) => stripComments(read(f)).includes('cod-restriction')));

  await assert('all three codes have their own registry message (never the generic sentence)', () =>
    [ERROR_CODES.COD_CUSTOMER_RESTRICTED, ERROR_CODES.COD_AGENCY_RESTRICTED, ERROR_CODES.COD_RESTRICTION_UNCHANGED]
      .every((code) => {
        const message = (DEFAULT_ERROR_MESSAGES as Record<string, string>)[code];
        return typeof message === 'string' && message.length > 10 && message !== GENERIC_ERROR_MESSAGE;
      }));
  await assert('the bot has customer copy for COD_CUSTOMER_RESTRICTED in all five languages, naming no reason', () => {
    const copy = (__BOT_ERROR_COPY.CODE_COPY as Record<string, Record<string, string>>)[ERROR_CODES.COD_CUSTOMER_RESTRICTED];
    return !!copy && ['en', 'fr', 'pt', 'es', 'ar'].every((l) => typeof copy[l] === 'string' && copy[l].length > 20)
      && !/refus|fraud|abus/i.test(copy.en);
  });

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
