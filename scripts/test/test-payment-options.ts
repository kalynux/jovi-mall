/**
 * test:payment-options — GET /api/payments/options (ADR-A08, W3), offline.
 *
 * The endpoint is a projection of `effectiveProviders` over injected settings and facts, so the
 * whole thing runs here with fixtures: no database, no server, no gateway key.
 *
 *   1. Default        MTN and ORANGE as PUSH, in catalogue order, the documented entry shape.
 *   2. Flows          MyCoolPay active makes ORANGE `OTP` with `mayRequireOtp: true`.
 *   3. CARD           Stripe ON with CARD OFF shows no CARD; CARD on + Stripe routes with the key;
 *                     no key, or a SECRET key in the slot, drops the entry rather than listing it.
 *   4. Absent         disabled and unroutable providers are not listed; nothing routable is `[]`.
 *   5. No leak        every scenario serialised: no aggregator name, no `gateway`/`aggregator` key,
 *                     no secret, and only the documented keys on each entry.
 *   6. Cache          5 s: the getters are read once inside the window and again after it.
 *   7. Handler        `no-store`, 200, `{ success, data }`.
 *   8. Mount          declared ABOVE `GET /:transactionId`, which would otherwise 401 it.
 *
 * Run: npm run test:payment-options
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { PAYMENT_GATEWAY_NAMES, PaymentGatewayName } from '../../src/modules/payments/gateways/gateway.interface';
import { PAYMENT_GATEWAYS as GATEWAY_MAP } from '../../src/modules/payments/gateways/registry';
import { PAYMENT_PROVIDERS, PaymentProvider } from '../../src/modules/payments/domain/payment-provider';
import {
  DEFAULT_PAYMENT_SETTINGS,
  PaymentSettings,
  RoutingFacts,
  AggregatorFacts,
} from '../../src/modules/payments/domain/payment-routing';
import { stripePublishableKey } from '../../src/modules/payments/domain/pay-link';
import {
  PaymentOptions,
  PaymentOptionsService,
  PAYMENT_OPTIONS_CACHE_TTL_MS,
} from '../../src/modules/payments/services/payment-options.service';
import { createPaymentOptionsHandler } from '../../src/modules/payments/controllers/payment-options.controller';

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PK = 'pk_test_options_fixture';

/** Facts built from the REAL adapter capabilities, with configuration toggled per case. */
function facts(overrides: Partial<Record<PaymentGatewayName, Partial<AggregatorFacts>>> = {}): RoutingFacts {
  const base = {} as Record<PaymentGatewayName, AggregatorFacts>;
  for (const name of PAYMENT_GATEWAY_NAMES) {
    const g = GATEWAY_MAP.get(name)!;
    base[name] = {
      configured: name !== 'STRIPE',
      capabilities: g.capabilities,
      payoutImplemented: typeof g.createPayout === 'function',
      payoutAvailable: true,
      ...overrides[name],
    };
  }
  return base;
}

function settings(patch: Partial<Omit<PaymentSettings, 'providers'>> & {
  providers?: Partial<Record<PaymentProvider, boolean>>;
} = {}): PaymentSettings {
  const providers = {} as PaymentSettings['providers'];
  for (const p of PAYMENT_PROVIDERS) {
    providers[p] = { enabled: patch.providers?.[p] ?? DEFAULT_PAYMENT_SETTINGS.providers[p].enabled };
  }
  return {
    collection_aggregator: patch.collection_aggregator ?? DEFAULT_PAYMENT_SETTINGS.collection_aggregator,
    payout_aggregator: patch.payout_aggregator ?? DEFAULT_PAYMENT_SETTINGS.payout_aggregator,
    stripe_enabled: patch.stripe_enabled ?? DEFAULT_PAYMENT_SETTINGS.stripe_enabled,
    providers,
  };
}

function options(s: PaymentSettings, f: RoutingFacts = facts(), key: string | null = PK): PaymentOptions {
  return new PaymentOptionsService({ settings: () => s, facts: () => f, publishableKey: () => key }).get();
}

const names = (o: PaymentOptions): string => o.providers.map((p) => p.provider).join(',');
const entry = (o: PaymentOptions, p: PaymentProvider) => o.providers.find((e) => e.provider === p);

const CARD_VIA_STRIPE = { stripe_enabled: true, providers: { CARD: true } } as const;
const STRIPE_KEYED = facts({ STRIPE: { configured: true } });

/** Every scenario section 5 serialises. */
const SCENARIOS: Array<[string, PaymentOptions]> = [];
function scenario(label: string, o: PaymentOptions): PaymentOptions {
  SCENARIOS.push([label, o]);
  return o;
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. Default settings');

const DEFAULT = scenario('default', options(settings()));

assert('MTN and ORANGE, in catalogue order', () => names(DEFAULT) === 'MTN,ORANGE');

assert('each entry is exactly the documented shape', () => {
  const mtn = entry(DEFAULT, 'MTN')!;
  return mtn.kind === 'MOBILE_MONEY'
    && mtn.flow === 'PUSH'
    && mtn.fields.length === 1 && mtn.fields[0] === 'phoneNumber'
    && mtn.mayRequireOtp === false
    && !('publishableKey' in mtn);
});

assert('ORANGE through NotchPay is PUSH, no OTP', () =>
  entry(DEFAULT, 'ORANGE')!.flow === 'PUSH' && entry(DEFAULT, 'ORANGE')!.mayRequireOtp === false);

assert('`fields` is a copy, not the adapter capability array', () => {
  const o = options(settings());
  o.providers[0].fields.push('customerEmail');
  return GATEWAY_MAP.get('NOTCHPAY')!.capabilities.collect.MTN!.requires.length === 1;
});

// ─────────────────────────────────────────────────────────────────────────────
section('2. Flows follow the active aggregator');

const MCP = scenario('mycoolpay', options(settings({ collection_aggregator: 'MYCOOLPAY' })));

assert('MyCoolPay active → ORANGE is OTP with mayRequireOtp true', () =>
  entry(MCP, 'ORANGE')!.flow === 'OTP' && entry(MCP, 'ORANGE')!.mayRequireOtp === true);

assert('MyCoolPay active → MTN stays PUSH', () =>
  entry(MCP, 'MTN')!.flow === 'PUSH' && entry(MCP, 'MTN')!.mayRequireOtp === false);

assert('mayRequireOtp is true exactly when flow is OTP, in every scenario so far', () =>
  [DEFAULT, MCP].every((o) => o.providers.every((e) => e.mayRequireOtp === (e.flow === 'OTP'))));

// ─────────────────────────────────────────────────────────────────────────────
section('3. CARD');

assert('Stripe ON with CARD OFF → no CARD', () =>
  !names(scenario('stripe-on-card-off', options(settings({ stripe_enabled: true }), STRIPE_KEYED))).includes('CARD'));

const CARD = scenario('card-via-stripe', options(settings(CARD_VIA_STRIPE), STRIPE_KEYED));

assert('CARD on + Stripe on and keyed → a CARD entry, last in catalogue order', () =>
  names(CARD) === 'MTN,ORANGE,CARD');

assert('the CARD entry is CARD_ELEMENT, no fields, no OTP, with the publishable key', () => {
  const card = entry(CARD, 'CARD')!;
  return card.kind === 'CARD' && card.flow === 'CARD_ELEMENT' && card.fields.length === 0
    && card.mayRequireOtp === false && card.publishableKey === PK;
});

assert('publishableKey appears on NO mobile-money entry', () =>
  CARD.providers.filter((e) => e.provider !== 'CARD').every((e) => !('publishableKey' in e)));

assert('CARD routed but NO publishable key → the entry is dropped, not listed keyless', () =>
  names(scenario('card-no-key', options(settings(CARD_VIA_STRIPE), STRIPE_KEYED, null))) === 'MTN,ORANGE');

assert('CARD on, Stripe on but unconfigured → no CARD', () =>
  !names(options(settings(CARD_VIA_STRIPE))).includes('CARD'));

assert('CARD on, Stripe OFF, aggregator declares no CARD → no CARD', () =>
  !names(options(settings({ providers: { CARD: true } }), STRIPE_KEYED)).includes('CARD'));

/**
 * The real guard, end to end: a SECRET key in the publishable slot yields no key, so no card.
 * `stripePublishableKey` logs an error on this path; that line is expected output.
 */
{
  const saved = process.env.STRIPE_PUBLISHABLE_KEY;
  try {
    process.env.STRIPE_PUBLISHABLE_KEY = 'sk_live_must_never_be_published';
    const leaked = scenario('secret-key-in-slot', new PaymentOptionsService({
      settings: () => settings(CARD_VIA_STRIPE),
      facts: () => STRIPE_KEYED,
      publishableKey: stripePublishableKey,
    }).get());
    assert('an sk_ key in STRIPE_PUBLISHABLE_KEY → no CARD entry and no key anywhere', () =>
      !names(leaked).includes('CARD') && !JSON.stringify(leaked).includes('sk_'));

    process.env.STRIPE_PUBLISHABLE_KEY = 'rk_live_restricted';
    assert('an rk_ key is refused the same way', () =>
      !names(new PaymentOptionsService({
        settings: () => settings(CARD_VIA_STRIPE),
        facts: () => STRIPE_KEYED,
        publishableKey: stripePublishableKey,
      }).get()).includes('CARD'));

    process.env.STRIPE_PUBLISHABLE_KEY = PK;
    assert('a real pk_ key through the real guard is published', () =>
      entry(new PaymentOptionsService({
        settings: () => settings(CARD_VIA_STRIPE),
        facts: () => STRIPE_KEYED,
        publishableKey: stripePublishableKey,
      }).get(), 'CARD')?.publishableKey === PK);
  } finally {
    if (saved === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = saved;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('4. Disabled and unroutable providers are absent');

assert('MTN disabled → only ORANGE', () =>
  names(scenario('mtn-off', options(settings({ providers: { MTN: false } })))) === 'ORANGE');

assert('MOOV enabled, but no aggregator declares it → absent', () =>
  !names(scenario('moov-on', options(settings({ providers: { MOOV: true } })))).includes('MOOV'));

assert('active aggregator unconfigured → an empty list (a valid answer)', () => {
  const o = scenario('nothing-routable', options(settings(), facts({ NOTCHPAY: { configured: false } })));
  return Array.isArray(o.providers) && o.providers.length === 0;
});

assert('every mobile provider disabled → an empty list', () =>
  options(settings({ providers: { MTN: false, ORANGE: false } })).providers.length === 0);

// ─────────────────────────────────────────────────────────────────────────────
section('5. Never names an aggregator, never leaks a secret');

const ENTRY_KEYS = new Set(['provider', 'kind', 'flow', 'fields', 'mayRequireOtp', 'publishableKey']);

assert(`all ${SCENARIOS.length} scenarios: no aggregator name anywhere in the body`, () =>
  SCENARIOS.every(([, o]) => {
    const body = JSON.stringify({ success: true, data: o }).toUpperCase();
    return PAYMENT_GATEWAY_NAMES.every((n) => !body.includes(n));
  }));

assert('no `gateway` or `aggregator` key or value, in any case', () =>
  SCENARIOS.every(([, o]) => !/gateway|aggregator/i.test(JSON.stringify(o))));

assert('no secret-shaped value (sk_ / rk_ / whsec_)', () =>
  SCENARIOS.every(([, o]) => !/\b(sk|rk|whsec)_/.test(JSON.stringify(o))));

assert('every entry carries only the documented keys', () =>
  SCENARIOS.every(([, o]) => o.providers.every((e) => Object.keys(e).every((k) => ENTRY_KEYS.has(k)))));

assert('the top level of `data` is `{ providers }` and nothing else', () =>
  SCENARIOS.every(([, o]) => Object.keys(o).join(',') === 'providers'));

// ─────────────────────────────────────────────────────────────────────────────
section('6. The 5-second server cache');

assert('the documented window is 5 s', () => PAYMENT_OPTIONS_CACHE_TTL_MS === 5_000);

{
  let clock = 1_000_000;
  let reads = 0;
  let current = settings();
  const svc = new PaymentOptionsService({
    settings: () => { reads++; return current; },
    facts: () => facts(),
    publishableKey: () => PK,
    now: () => clock,
  });

  const first = svc.get();
  current = settings({ collection_aggregator: 'MYCOOLPAY' });
  clock += PAYMENT_OPTIONS_CACHE_TTL_MS - 1;
  const inside = svc.get();

  assert('inside the window: the settings are read once and the answer is unchanged', () =>
    reads === 1 && inside === first && entry(inside, 'ORANGE')!.flow === 'PUSH');

  clock += 1;
  const after = svc.get();
  assert('at the window edge: recomputed, and the switch shows', () =>
    reads === 2 && entry(after, 'ORANGE')!.flow === 'OTP');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7. The handler');

{
  const headers: Record<string, string> = {};
  let status = 0;
  let body: any = null;
  const res: any = {
    set(name: string, value: string) { headers[name.toLowerCase()] = value; return res; },
    status(code: number) { status = code; return res; },
    json(payload: unknown) { body = payload; return res; },
  };

  const handler = createPaymentOptionsHandler(new PaymentOptionsService({
    settings: () => settings(),
    facts: () => facts(),
    publishableKey: () => PK,
  }));

  // asyncHandler resolves on a microtask; the assertions run after it.
  const done = new Promise<void>((resolve, reject) => {
    handler({} as any, res, (err?: unknown) => (err ? reject(err) : resolve()));
    setImmediate(resolve);
  });

  done.then(() => {
    assert('Cache-Control: no-store', () => headers['cache-control'] === 'no-store');
    assert('200 with the standard { success, data } envelope', () =>
      status === 200 && body?.success === true && Array.isArray(body?.data?.providers)
      && Object.keys(body).join(',') === 'success,data');
    finish();
  }).catch((err) => {
    originalConsole.error(`  ❌ THROW: handler — ${(err as Error).message}`);
    failed++;
    finish();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
function mountSection(): void {
  section('8. The mount');

  const ROUTES = readFileSync(
    join(__dirname, '../../src/modules/payments/routes/payment.routes.ts'),
    'utf8'
  );

  const mount = ROUTES.search(/router\.get\(\s*'\/options'/);
  const byId = ROUTES.search(/router\.get\(\s*'\/:transactionId'/);

  assert('GET /options is mounted on the payment router', () => mount !== -1);
  assert('...ABOVE GET /:transactionId, whose requireAuth would otherwise 401 it', () =>
    mount !== -1 && byId !== -1 && mount < byId);
  assert('...with no auth guard of its own', () => {
    const line = ROUTES.slice(mount, ROUTES.indexOf('\n', mount));
    return mount !== -1 && !/requireAuth|requireRole/.test(line);
  });

  const SERVICE = readFileSync(
    join(__dirname, '../../src/modules/payments/services/payment-options.service.ts'),
    'utf8'
  );
  assert('the service reads no registry, no environment and no database (inputs are injected)', () =>
    !/gateways\/registry|process\.env|mongoose|\/models\//.test(SERVICE));
  // The one permitted spread is the array copy of `requires`, which carries field names only.
  assert('entries are built field by field: no spread of a route or capability', () =>
    !/\.\.\.\s*(route|capability|effective)(?!\.capability\.requires\])/.test(SERVICE));
}

function finish(): void {
  mountSection();
  originalConsole.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
