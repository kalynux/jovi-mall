/**
 * test:billing-routing — credit top-ups and plan purchases on the provider model (ADR-A08, W2b billing).
 *
 * Billing used to take an aggregator from the client and call it without asking whether it was
 * offered. Both doors now go provider → checks → route → gateway → row, through
 * `billing/domain/billing-charge.ts`. This suite drives the REAL services with fake repositories
 * and fake gateways swapped into the real registry:
 *
 *   1. Refusals    no provider, a missing number, a number on another operator, a provider that
 *                  nothing routes: each refused with ZERO rows written and no gateway called, on
 *                  both doors.
 *   2. Legacy      an old app's body carrying only `gateway` is charged through the ACTIVE
 *                  aggregator, with the provider derived from the number.
 *   3. Switch      after an administrator switches the collection aggregator, a new top-up and a
 *                  new purchase use the new one; the adapter receives `phoneOperator = provider`.
 *   4. Stored      verify and authorize still use the gateway STORED on the row, not the setting.
 *   5. Controllers the deprecated `gateway` is counted per door and never forwarded.
 *   6. Source      controllers take the provider-based schemas; the route is resolved before the
 *                  pending row is written; verify/authorize never consult routing.
 *
 * Run: npm run test:billing-routing
 */

// ⚠ The payment config reads its keys at IMPORT time, so the gateways must be "configured"
// before anything below is loaded. Everything is `require`d after this block for that reason.
process.env.NOTCHPAY_PUBLIC_KEY = 'pk_test_billing_routing';
process.env.NOTCHPAY_WEBHOOK_SECRET = 'whsec_billing_routing';
process.env.MYCOOLPAY_PUBLIC_KEY = 'mcp_public_billing_routing';
process.env.MYCOOLPAY_PRIVATE_KEY = 'mcp_private_billing_routing';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

/* eslint-disable @typescript-eslint/no-require-imports -- env fixtures must be set before these modules load */
import type { PaymentGateway, PaymentGatewayName } from '../../src/modules/payments/gateways/gateway.interface';
import type { PaymentSettingsRecord } from '../../src/modules/payments/domain/payment-routing';

const { readFileSync } = require('fs') as typeof import('fs');
const { join } = require('path') as typeof import('path');
const { originalConsole } = require('../../src/core/logging/sink-guard');
const { PAYMENT_GATEWAYS } = require('../../src/modules/payments/gateways/registry');
const { DEFAULT_PAYMENT_SETTINGS } = require('../../src/modules/payments/domain/payment-routing');
const {
  __resetPaymentSettingsCacheForTests,
  __setPaymentSettingsStoreForTests,
} = require('../../src/modules/payments/services/payment-settings.service');
const { deriveProviderOrThrow } = require('../../src/modules/payments/services/payment-routing.service');
const { CreditTopupService } = require('../../src/modules/billing/services/credit-topup.service');
const { PlanPurchaseService } = require('../../src/modules/billing/services/plan-purchase.service');
const {
  InitiateTopupRequestSchema,
  InitiatePlanPurchaseRequestSchema,
} = require('../../src/modules/billing/validators/billing.validators');

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
  let ok: boolean;
  try {
    ok = fn();
  } catch (err) {
    originalConsole.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
    failed++;
    return;
  }
  if (ok) {
    passed++;
    originalConsole.log(`  ✅ ${name}`);
  } else {
    failed++;
    originalConsole.error(`  ❌ FAIL: ${name}`);
  }
}

function section(title: string): void {
  originalConsole.log(`\n── ${title} ${'─'.repeat(Math.max(0, 72 - title.length))}`);
}

const MTN_NUMBER = '+237670000000';
const ORANGE_NUMBER = '+237690000000';
const OWNER = '64b000000000000000000001';

// ── Settings, without a database ─────────────────────────────────────────────

__setPaymentSettingsStoreForTests({
  ready: () => false,
  read: async () => null,
  create: async () => { throw new Error('not in this suite'); },
  compareAndSet: async () => null,
});

function setCollectionAggregator(name: PaymentGatewayName): void {
  __resetPaymentSettingsCacheForTests(
    { ...DEFAULT_PAYMENT_SETTINGS, collection_aggregator: name } as PaymentSettingsRecord,
    true,
  );
}

// ── Fake gateways in the real registry ───────────────────────────────────────

interface Charge { gateway: PaymentGatewayName; channel: Record<string, unknown> }
const charges: Charge[] = [];
const verifies: PaymentGatewayName[] = [];
const otps: PaymentGatewayName[] = [];

const registry = PAYMENT_GATEWAYS as Map<PaymentGatewayName, PaymentGateway>;
const realGateways = new Map(registry);

function fakeGateway(name: PaymentGatewayName): PaymentGateway {
  const real = realGateways.get(name)!;
  return {
    name,
    capabilities: real.capabilities,
    initiatePayment: async (p: { channel: Record<string, unknown> }) => {
      charges.push({ gateway: name, channel: p.channel });
      return { success: true, status: 'PENDING', gatewayRef: `${name.toLowerCase()}_ref`, instructions: null };
    },
    verifyPayment: async () => {
      verifies.push(name);
      return { status: 'PENDING' };
    },
    authorizePayment: async () => {
      otps.push(name);
      return { success: true, status: 'PENDING', message: 'ok' };
    },
  } as unknown as PaymentGateway;
}

for (const name of realGateways.keys()) registry.set(name, fakeGateway(name));

// ── Fake repositories ────────────────────────────────────────────────────────

type Row = Record<string, any>;
let writes = 0;
let nextId = 1;

function makeRepo() {
  const rows = new Map<string, Row>();
  return {
    rows,
    create: async (data: Row) => {
      writes++;
      const id = `6500000000000000000000${String(nextId++).padStart(2, '0')}`;
      const row = { ...data, _id: { toString: () => id }, otp_attempts: 0, save: async () => row };
      rows.set(id, row);
      return row;
    },
    setStatus: async (id: { toString(): string }, status: string, extra: Row = {}) => {
      const row = rows.get(id.toString());
      if (!row) return null;
      writes++;
      Object.assign(row, { status }, extra);
      return row;
    },
    findById: async (id: string) => rows.get(id) ?? null,
  };
}

const topupRepo = makeRepo();
const purchaseRepo = makeRepo();

const PLAN = {
  _id: { toString: () => '64c000000000000000000001' },
  code: 'plus',
  role: 'vendor',
  price: 5000,
  currency: 'XAF',
  is_active: true,
};

const topups = new CreditTopupService(topupRepo as any, {} as any);
const purchases = new PlanPurchaseService(
  purchaseRepo as any,
  { findById: async () => PLAN } as any,
  { findByOwnerAndStatus: async () => null } as any,
  {} as any,
);

// The controllers' pipeline, exactly: parse the body, derive the provider, call the service.
async function topupDoor(body: unknown) {
  const parsed = InitiateTopupRequestSchema.parse(body);
  const provider = deriveProviderOrThrow(parsed);
  return topups.initiateTopup('vendor', OWNER, parsed.packCode, { provider }, parsed.channel);
}

async function purchaseDoor(body: unknown) {
  const parsed = InitiatePlanPurchaseRequestSchema.parse(body);
  const provider = deriveProviderOrThrow(parsed);
  return purchases.initiatePurchase('vendor', OWNER, 'plan1', { provider }, parsed.channel);
}

type Outcome = { ok: true; value: any } | { ok: false; code: string; status: number; details: any; zodPath?: string };

async function attempt(fn: () => Promise<any>): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return { ok: false, code: 'VALIDATION_ERROR', status: 400, details: null, zodPath: err.issues?.[0]?.path?.join('.') };
    }
    return { ok: false, code: err?.code, status: err?.statusCode, details: err?.details };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const pack = (require('../../src/modules/billing/config/credit.config').CREDIT_TOPUP_PACKS as Array<{ code: string }>)[0].code;
  setCollectionAggregator('NOTCHPAY');

  section('1. Refusals write nothing, on both doors');

  const refusals: Array<[string, unknown, string, number]> = [
    ['no provider and nothing to derive it from', { channel: {} }, 'PAYMENT_PROVIDER_REQUIRED', 400],
    ['MTN with no number', { provider: 'MTN', channel: {} }, 'VALIDATION_ERROR', 400],
    ['ORANGE with an MTN number', { provider: 'ORANGE', channel: { phoneNumber: MTN_NUMBER } }, 'PAYMENT_PROVIDER_PHONE_MISMATCH', 422],
    ['MOOV, which nothing routes', { provider: 'MOOV', channel: { phoneNumber: '+237600000000' } }, 'PAYMENT_PROVIDER_UNAVAILABLE', 422],
    ['CARD with Stripe off', { provider: 'CARD', channel: {} }, 'PAYMENT_PROVIDER_UNAVAILABLE', 422],
    ['a legacy STRIPE body means card intent, never a push', { gateway: 'STRIPE', channel: { phoneNumber: MTN_NUMBER } }, 'PAYMENT_PROVIDER_UNAVAILABLE', 422],
  ];

  for (const [label, body, code, status] of refusals) {
    for (const [door, run] of [
      ['top-up', () => topupDoor({ packCode: pack, ...(body as object) })],
      ['plan purchase', () => purchaseDoor(body)],
    ] as const) {
      const before = { writes, charges: charges.length };
      const out = await attempt(run);
      assert(`${door}: ${label} → ${status} ${code}, zero writes, no gateway call`, () =>
        !out.ok && out.code === code && out.status === status
        && writes === before.writes && charges.length === before.charges);
    }
  }

  {
    const out = await attempt(() => topupDoor({ packCode: pack, provider: 'ORANGE', channel: { phoneNumber: MTN_NUMBER } }));
    assert('the mismatch names both operators and says nothing was spent', () =>
      !out.ok && out.details?.provider === 'ORANGE' && out.details?.detected === 'MTN' && out.details?.spent === false);
  }
  {
    const out = await attempt(() => topupDoor({ packCode: pack, provider: 'MTN', channel: {} }));
    assert('a missing number is a 400 on channel.phoneNumber, the HTTP doors\' shape', () =>
      !out.ok && out.zodPath === 'channel.phoneNumber');
  }
  {
    const out = await attempt(() => topupDoor({ packCode: pack, provider: 'MOOV', channel: { phoneNumber: '+237600000000' } }));
    assert('an unavailable provider lists what IS offered', () =>
      !out.ok && Array.isArray(out.details?.offered) && out.details.offered.join(',') === 'MTN,ORANGE');
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('2. A legacy body carrying only `gateway`');

  {
    const before = charges.length;
    const out = await attempt(() => topupDoor({ packCode: pack, gateway: 'MYCOOLPAY', channel: { phoneNumber: MTN_NUMBER } }));
    const row = out.ok ? out.value.topup : null;
    assert('an old app naming MYCOOLPAY is charged through the ACTIVE NOTCHPAY', () =>
      out.ok && charges.length === before + 1 && charges[before].gateway === 'NOTCHPAY');
    assert('...the row records gateway NOTCHPAY and provider MTN (derived from the number)', () =>
      row?.gateway === 'NOTCHPAY' && row?.provider === 'MTN');
    assert('...and the response carries `provider` at the top, as the payment doors do', () =>
      out.ok && out.value.provider === 'MTN');
  }
  {
    const before = charges.length;
    const out = await attempt(() => purchaseDoor({ gateway: 'NOTCHPAY', channel: { phoneNumber: ORANGE_NUMBER } }));
    assert('a legacy purchase body is routed the same way: NOTCHPAY, provider ORANGE', () =>
      out.ok && charges[before]?.gateway === 'NOTCHPAY'
      && out.value.purchase.gateway === 'NOTCHPAY' && out.value.purchase.provider === 'ORANGE'
      && out.value.provider === 'ORANGE');
  }
  {
    const out = await attempt(() => topupDoor({ packCode: pack, gateway: 'NOT_A_GATEWAY', provider: 'MTN', channel: { phoneNumber: MTN_NUMBER } }));
    assert('an unknown `gateway` value is accepted and ignored, never a 400', () => out.ok);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('3. After an administrator switches the collection aggregator');

  setCollectionAggregator('MYCOOLPAY');
  let switchedTopupId = '';
  {
    const before = charges.length;
    const out = await attempt(() => topupDoor({ packCode: pack, provider: 'ORANGE', channel: { phoneNumber: ORANGE_NUMBER } }));
    switchedTopupId = out.ok ? out.value.topup._id.toString() : '';
    assert('a NEW top-up goes to MYCOOLPAY and the row says so', () =>
      out.ok && charges[before]?.gateway === 'MYCOOLPAY'
      && out.value.topup.gateway === 'MYCOOLPAY' && out.value.topup.provider === 'ORANGE');
    assert('...and the adapter receives phoneOperator = the declared provider', () =>
      charges[before]?.channel.phoneOperator === 'ORANGE');
  }
  {
    const before = charges.length;
    const out = await attempt(() => purchaseDoor({ provider: 'MTN', channel: { phoneNumber: MTN_NUMBER, phoneOperator: 'ORANGE' } }));
    assert('a NEW purchase goes to MYCOOLPAY too', () =>
      out.ok && charges[before]?.gateway === 'MYCOOLPAY' && out.value.purchase.gateway === 'MYCOOLPAY');
    assert('...a stale client phoneOperator is overridden by the provider', () =>
      charges[before]?.channel.phoneOperator === 'MTN');
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('4. Verify and authorize use the STORED gateway');

  const notchTopupId = [...topupRepo.rows.entries()].find(([, r]) => r.gateway === 'NOTCHPAY')![0];
  const notchPurchaseId = [...purchaseRepo.rows.entries()].find(([, r]) => r.gateway === 'NOTCHPAY')![0];

  {
    verifies.length = 0;
    await topups.verifyAndComplete('vendor', OWNER, notchTopupId);
    await purchases.verifyAndComplete('vendor', OWNER, notchPurchaseId);
    assert('with MYCOOLPAY active, a NOTCHPAY top-up and purchase are verified on NOTCHPAY', () =>
      verifies.join(',') === 'NOTCHPAY,NOTCHPAY');
  }
  {
    verifies.length = 0;
    setCollectionAggregator('NOTCHPAY');
    await topups.verifyAndComplete('vendor', OWNER, switchedTopupId);
    assert('after switching BACK to NOTCHPAY, the MYCOOLPAY top-up is still verified on MYCOOLPAY', () =>
      verifies.join(',') === 'MYCOOLPAY');
  }
  {
    otps.length = 0;
    await attempt(() => topups.authorizeTopup('vendor', OWNER, switchedTopupId, '1234'));
    assert('an OTP for the MYCOOLPAY top-up goes to MYCOOLPAY, whatever is active', () =>
      otps.join(',') === 'MYCOOLPAY');
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('5. The controllers: the deprecated field is counted, never forwarded');

  /**
   * By source, deliberately. A controller cannot be loaded under ts-node: the `req.auth`
   * augmentation it compiles against is not in this program, so importing one fails to compile
   * (the project records this trap). The pipeline these lines drive is exercised behaviourally in
   * sections 1-3 through the same schema, `deriveProviderOrThrow` and service calls.
   */
  {
    const { PAYMENT_DOORS } = require('../../src/modules/system/metrics/metrics');
    assert('the metric knows both billing doors', () =>
      PAYMENT_DOORS.includes('credit_topup') && PAYMENT_DOORS.includes('plan_purchase'));

    for (const [label, rel] of [
      ['vendor', 'src/modules/billing/controllers/vendor-billing.controller.ts'],
      ['subscriber', 'src/modules/billing/controllers/subscriber-billing.controller.ts'],
    ] as const) {
      const src = readFileSync(join(__dirname, '../..', rel), 'utf8');
      for (const [door, parse] of [
        ['credit_topup', 'InitiateTopupRequestSchema.parse(req.body)'],
        ['plan_purchase', 'InitiatePlanPurchaseRequestSchema.parse(req.body)'],
      ] as const) {
        const at = src.indexOf(parse);
        const span = at === -1 ? '' : src.slice(at, src.indexOf('res.status(201)', at));
        assert(`${label} ${door}: counts a present gateway under its own door, then derives the provider`, () =>
          span.includes(`if (body.gateway !== undefined) recordDeprecatedGatewayField('${door}');`)
          && span.indexOf('recordDeprecatedGatewayField(') < span.indexOf('deriveProviderOrThrow(body)'));
        assert(`${label} ${door}: the service is handed { provider }, never the body gateway`, () =>
          span.includes('{ provider }, body.channel)') && !/body\.gateway\s*[,)]/.test(span));
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('6. Source');

  const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf8');
  const TOPUP = read('src/modules/billing/services/credit-topup.service.ts');
  const PURCHASE = read('src/modules/billing/services/plan-purchase.service.ts');
  const CONTROLLERS = [
    read('src/modules/billing/controllers/vendor-billing.controller.ts'),
    read('src/modules/billing/controllers/subscriber-billing.controller.ts'),
  ];

  for (const [name, src, method] of [
    ['top-up', TOPUP, 'async initiateTopup('],
    ['purchase', PURCHASE, 'async initiatePurchase('],
  ] as const) {
    const body = src.slice(src.indexOf(method));
    const route = body.indexOf('resolveBillingCharge(');
    const write = body.indexOf('this.repo.create(');
    assert(`${name}: the route is resolved BEFORE the pending row is written`, () =>
      route !== -1 && write !== -1 && route < write);
    assert(`${name}: the row records the provider`, () => /provider: charge\.provider/.test(body.slice(0, body.indexOf('initiatePayment('))));
  }

  for (const [name, src] of [['top-up', TOPUP], ['purchase', PURCHASE]] as const) {
    const verify = src.slice(src.indexOf('async verifyAndComplete('));
    const verifyBody = verify.slice(0, verify.indexOf('\n  }\n'));
    assert(`${name}: verify reads the stored gateway and never the routing`, () =>
      /getPaymentGateway\((topup|purchase)\.gateway\)/.test(verifyBody)
      && !/resolveCollectionRoute|resolveBillingCharge|getPaymentSettingsSync/.test(verifyBody));
  }

  assert('both controllers parse the provider-based schemas and derive the provider', () =>
    CONTROLLERS.every((c) =>
      c.includes('InitiateTopupRequestSchema.parse(') && c.includes('InitiatePlanPurchaseRequestSchema.parse(')
      && (c.match(/deriveProviderOrThrow\(body\)/g) ?? []).length === 2
      && !/InitiateTopupSchema\.parse|InitiatePlanPurchaseSchema\.parse/.test(c)));

  assert('no controller passes a client gateway to a service', () =>
    CONTROLLERS.every((c) => !/initiate(Topup|Purchase)\([^)]*\bgateway\b/.test(c)));
}

main()
  .catch((err) => {
    originalConsole.error(`  ❌ THROW: suite — ${(err as Error).stack ?? err}`);
    failed++;
  })
  .finally(() => {
    for (const [name, gateway] of realGateways) registry.set(name, gateway);
    __setPaymentSettingsStoreForTests(null);
    originalConsole.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
