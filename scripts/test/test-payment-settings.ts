/**
 * test:payment-settings — the ADR-A08 settings store, the routing resolver and the registry's
 * new accept rule (W1). DB-free: storage is a stub behind the service's store seam.
 *
 *   1. Cache          fresh reads do not touch storage; a stale read serves the old value and
 *                     refreshes in the background; concurrent refreshes share one read.
 *   2. Failure        a failed or impossible refresh KEEPS THE LAST KNOWN settings; no document
 *                     means the defaults; an unreadable field falls back to its default.
 *   3. The write      compare-and-set, the version-0 create race, 422 with details.errors,
 *                     previous / changed / warnings / convergenceSeconds, the cache bust.
 *   4. Registry       gatewayConfigured, buildRoutingFacts, and the ADR-A08 accept rule with
 *                     and without a document (C1 removed the version-0 "configured alone" bridge).
 *   5. Resolver       resolveCollectionRoute, offeredProviders, resolvePayoutAggregator,
 *                     deriveProviderOrThrow, the mismatch → error helper.
 *   6. Scans          the boot prime, the lazy registry import, and — STRICT since C1 — no
 *                     routing decision from an env predicate or a raw credential read outside
 *                     the allowlist, and `payments` never imports `bot-surface`.
 *
 * Run: npm run test:payment-settings
 */

// Before the first import: the pino console bridge otherwise swallows this suite's output.
process.env.LOG_STDOUT = 'false';
// The mobile-money config objects are frozen at import, so their fixtures go first.
process.env.NOTCHPAY_WEBHOOK_SECRET = 'hsk_test.fixture_hash_key';
process.env.NOTCHPAY_PUBLIC_KEY = 'pk_test.fixture_public_key';
process.env.MYCOOLPAY_PUBLIC_KEY = 'fixture-public-key-uuid';
process.env.MYCOOLPAY_PRIVATE_KEY = 'fixture-private-key';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
// The settings service is imported BEFORE the registry on purpose: if the two formed a load-time
// cycle, this order is the one that would leave a binding undefined.
import {
  PaymentSettingsDocument,
  PaymentSettingsStore,
  getPaymentSettingsSync,
  primePaymentSettings,
  setPaymentSettings,
  toPaymentSettingsView,
  __setPaymentSettingsStoreForTests,
  __resetPaymentSettingsCacheForTests,
} from '../../src/modules/payments/services/payment-settings.service';
import {
  PAYMENT_GATEWAYS,
  PAYMENT_GATEWAY_NAMES,
  assertGatewayOffered,
  buildRoutingFacts,
  gatewayAcceptsNewPayments,
  gatewayConfigured,
  offeredPaymentGateways,
} from '../../src/modules/payments/gateways/registry';
import {
  buildRoutingFacts as buildRoutingFactsFromService,
  checkChargeRequestOrThrow,
  deriveProviderOrThrow,
  enforceChargeRequestCheck,
  offeredProviders,
  resolveCollectionRoute,
  resolvePayoutAggregator,
} from '../../src/modules/payments/services/payment-routing.service';
import {
  DEFAULT_PAYMENT_SETTINGS,
  PaymentSettingsRecord,
  RoutingFacts,
} from '../../src/modules/payments/domain/payment-routing';
import { PaymentGatewayName } from '../../src/modules/payments/gateways/gateway.interface';
import { PaymentProvider } from '../../src/modules/payments/domain/payment-provider';

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  let ok: boolean;
  try {
    ok = await fn();
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

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Run `fn` and return the AppError it throws, or null. */
async function caught(fn: () => unknown): Promise<AppError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error : null;
  }
}

// ── Stub storage ─────────────────────────────────────────────────────────────

interface Stub extends PaymentSettingsStore {
  doc: PaymentSettingsDocument | null;
  reads: number;
  writes: number;
  isReady: boolean;
  failRead: boolean;
  /** Make the next create lose a race (duplicate key) or fail otherwise. */
  createError: unknown;
  /** Make the next compare-and-set miss even though the version matched at read time. */
  casMiss: boolean;
}

function stub(doc: PaymentSettingsDocument | null = null): Stub {
  const s: Stub = {
    doc,
    reads: 0,
    writes: 0,
    isReady: true,
    failRead: false,
    createError: null,
    casMiss: false,
    ready: () => s.isReady,
    read: async () => {
      s.reads++;
      if (s.failRead) throw new Error('mongo wobble');
      return s.doc ? { ...s.doc } : null;
    },
    create: async (fields) => {
      if (s.createError) {
        const e = s.createError;
        s.createError = null;
        throw e;
      }
      s.writes++;
      s.doc = { _id: 'payments', ...fields, version: 1 } as PaymentSettingsDocument;
      return { ...s.doc };
    },
    compareAndSet: async (expected, fields) => {
      if (s.casMiss || !s.doc || s.doc.version !== expected) return null;
      s.writes++;
      s.doc = { ...s.doc, ...fields, version: expected + 1 } as PaymentSettingsDocument;
      return { ...s.doc };
    },
  };
  return s;
}

function docOf(patch: Partial<PaymentSettingsRecord> = {}): PaymentSettingsDocument {
  const base: PaymentSettingsRecord = {
    ...DEFAULT_PAYMENT_SETTINGS,
    providers: {
      MTN: { enabled: true }, ORANGE: { enabled: true }, MOOV: { enabled: false }, CARD: { enabled: false },
    },
    version: 3,
    updated_at: new Date('2026-09-30T10:00:00Z'),
    updated_by_id: 'adm-1',
    updated_by_name: 'Jane',
    reason: 'earlier',
    ...patch,
  };
  return { _id: 'payments', ...base } as PaymentSettingsDocument;
}

function record(patch: Partial<PaymentSettingsRecord> = {}): PaymentSettingsRecord {
  const { _id, ...rest } = docOf(patch);
  void _id;
  return rest as PaymentSettingsRecord;
}

/** Facts from the real registry, with overrides per case. */
function facts(overrides: Partial<Record<PaymentGatewayName, Partial<RoutingFacts[PaymentGatewayName]>>> = {}): RoutingFacts {
  const live = buildRoutingFacts();
  const out = {} as Record<PaymentGatewayName, RoutingFacts[PaymentGatewayName]>;
  for (const name of PAYMENT_GATEWAY_NAMES) out[name] = { ...live[name], ...overrides[name] };
  return out;
}

const ACTOR = { id: 'adm-7', name: 'Awa' };

function withStripe<T>(fn: () => T): T {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
  try {
    return fn();
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
}

(async () => {
  // ── 1. Cache ───────────────────────────────────────────────────────────────
  section('1. Cache — synchronous read, background refresh');

  {
    const s = stub(docOf({ collection_aggregator: 'MYCOOLPAY' }));
    __setPaymentSettingsStoreForTests(s);

    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);
    await assert('a fresh cache is served without touching storage', () =>
      getPaymentSettingsSync().collection_aggregator === 'NOTCHPAY' && s.reads === 0);

    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, false);
    const first = getPaymentSettingsSync();
    await assert('a stale read returns the OLD value immediately (never awaits)', () =>
      first.collection_aggregator === 'NOTCHPAY' && s.reads === 1);
    await tick();
    await assert('…and the background refresh replaces it', () =>
      getPaymentSettingsSync().collection_aggregator === 'MYCOOLPAY' && getPaymentSettingsSync().version === 3);

    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, false);
    s.reads = 0;
    getPaymentSettingsSync();
    getPaymentSettingsSync();
    getPaymentSettingsSync();
    await tick();
    await assert('concurrent stale reads share ONE storage read', () => s.reads === 1);

    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, false);
    const primed = await primePaymentSettings();
    await assert('primePaymentSettings awaits the read and returns it', () => primed.collection_aggregator === 'MYCOOLPAY');
  }

  // ── 2. Failure direction ───────────────────────────────────────────────────
  section('2. Failure — keep the last known settings');

  {
    const s = stub(docOf());
    __setPaymentSettingsStoreForTests(s);
    const known = record({ collection_aggregator: 'MYCOOLPAY', version: 9 });

    s.failRead = true;
    __resetPaymentSettingsCacheForTests(known, false);
    await primePaymentSettings();
    await assert('a failed refresh keeps the last known settings, NOT the defaults', () =>
      getPaymentSettingsSync().collection_aggregator === 'MYCOOLPAY' && getPaymentSettingsSync().version === 9);
    const readsAfterFailure = s.reads;
    getPaymentSettingsSync();
    await assert('…and stamps the cache, so a failing store is not re-read on every charge', () =>
      s.reads === readsAfterFailure);

    s.failRead = false;
    s.isReady = false;
    __resetPaymentSettingsCacheForTests(known, false);
    await primePaymentSettings();
    await assert('a disconnected store is not read at all; the last known value stays', () =>
      s.reads === readsAfterFailure && getPaymentSettingsSync().version === 9);

    s.isReady = true;
    s.doc = null;
    __resetPaymentSettingsCacheForTests(known, false);
    await primePaymentSettings();
    await assert('no document → DEFAULT_PAYMENT_SETTINGS (version 0)', () => {
      const c = getPaymentSettingsSync();
      return c.version === 0 && c.collection_aggregator === 'NOTCHPAY' && c.payout_aggregator === 'NOTCHPAY'
        && !c.stripe_enabled && c.providers.MTN.enabled && c.providers.ORANGE.enabled && !c.providers.CARD.enabled;
    });

    s.doc = { ...docOf(), collection_aggregator: 'NOT_A_GATEWAY' as PaymentGatewayName, providers: { MTN: { enabled: false } } as never };
    __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, false);
    await primePaymentSettings();
    await assert('an unreadable aggregator (rolled-back build) falls back to its default', () =>
      getPaymentSettingsSync().collection_aggregator === 'NOTCHPAY');
    await assert('a provider missing from the document falls back to its default; a stored one is kept', () =>
      getPaymentSettingsSync().providers.ORANGE.enabled === true && getPaymentSettingsSync().providers.MTN.enabled === false);
  }

  // ── 3. The write ───────────────────────────────────────────────────────────
  section('3. setPaymentSettings — compare-and-set, refusals, result');

  {
    const s = stub(null);
    __setPaymentSettingsStoreForTests(s);
    __resetPaymentSettingsCacheForTests();
    // Payouts reported available, so the only warnings are the ones each case provokes (the live
    // env may have NOTCHPAY_PAYOUTS_ENABLED off, which is its own soft warning).
    const F = facts({ NOTCHPAY: { payoutAvailable: true } });

    const res = await setPaymentSettings({ collectionAggregator: 'MYCOOLPAY' }, 0, ACTOR, '  NotchPay outage  ', F);
    await assert('first write (expectedVersion 0) creates at version 1', () => res.settings.version === 1 && s.writes === 1);
    await assert('previous is the DEFAULTS view when there was no document', () =>
      res.previous.version === 0 && res.previous.collectionAggregator === 'NOTCHPAY' && res.previous.updatedBy === null
      && res.previous.updatedAt === null);
    await assert('changed names exactly the moved key', () => same(res.changed, ['collectionAggregator']));
    await assert('actor and trimmed reason are stamped', () =>
      res.settings.updatedBy?.id === 'adm-7' && res.settings.updatedBy?.name === 'Awa' && res.settings.reason === 'NotchPay outage'
      && res.settings.updatedAt instanceof Date);
    await assert('convergenceSeconds is the TTL in seconds (5)', () => res.convergenceSeconds === 5);
    await assert('no warnings for a clean switch', () => res.warnings.length === 0);
    const readsBefore = s.reads;
    await assert('the cache is busted: the new value is served at once, with no storage read', () =>
      getPaymentSettingsSync().collection_aggregator === 'MYCOOLPAY' && getPaymentSettingsSync().version === 1
      && s.reads === readsBefore);

    const res2 = await setPaymentSettings({ providers: { MOOV: { enabled: true } } }, 1, ACTOR, 'try moov', F);
    await assert('providers merge per provider (MTN and ORANGE untouched)', () =>
      res2.settings.providers.MOOV.enabled && res2.settings.providers.MTN.enabled && res2.settings.providers.ORANGE.enabled);
    await assert('previous is the stored state the CAS was made against', () =>
      res2.previous.version === 1 && res2.previous.collectionAggregator === 'MYCOOLPAY' && res2.previous.providers.MOOV.enabled === false);
    await assert('changed = [providers], version 2', () => same(res2.changed, ['providers']) && res2.settings.version === 2);
    await assert('soft warnings come back on the accepted write (MOOV unroutable)', () =>
      res2.warnings.length === 1 && res2.warnings[0].code === 'PROVIDER_UNROUTABLE' && res2.warnings[0].provider === 'MOOV');

    const noop = await setPaymentSettings({}, 2, ACTOR, 'audit only', F);
    await assert('a no-op write is accepted, bumps the version, and changes nothing', () =>
      noop.changed.length === 0 && noop.settings.version === 3);

    const writes = s.writes;
    const stale = await caught(() => setPaymentSettings({ stripeEnabled: false }, 2, ACTOR, 'stale', F));
    await assert('a stale expectedVersion → 409 PAYMENT_SETTINGS_VERSION_CONFLICT, nothing written', () =>
      stale?.code === ERROR_CODES.PAYMENT_SETTINGS_VERSION_CONFLICT && stale.statusCode === 409 && s.writes === writes);

    s.casMiss = true;
    const miss = await caught(() => setPaymentSettings({ stripeEnabled: false }, 3, ACTOR, 'raced', F));
    s.casMiss = false;
    await assert('a compare-and-set miss (another admin won between read and write) → 409', () =>
      miss?.code === ERROR_CODES.PAYMENT_SETTINGS_VERSION_CONFLICT && miss.statusCode === 409 && s.writes === writes);

    const zeroOnExisting = await caught(() => setPaymentSettings({}, 0, ACTOR, 'x', F));
    await assert('expectedVersion 0 against an existing document → 409', () =>
      zeroOnExisting?.code === ERROR_CODES.PAYMENT_SETTINGS_VERSION_CONFLICT);

    // STRIPE is the aggregator with no createPayout (My-CoolPay gained one), so it provokes the
    // payout refusal beside the collection one: two hard errors from one write, both reported.
    const invalid = await caught(() => setPaymentSettings({ payoutAggregator: 'STRIPE', collectionAggregator: 'STRIPE' }, 3, ACTOR, 'bad', F));
    await assert('a hard rule → 422 PAYMENT_SETTINGS_INVALID with details.errors[], nothing written', () => {
      const errors = (invalid?.details as { errors?: Array<{ code: string; message: string }> } | undefined)?.errors ?? [];
      return invalid?.code === ERROR_CODES.PAYMENT_SETTINGS_INVALID && invalid.statusCode === 422 && s.writes === writes
        && errors.some((e) => e.code === 'COLLECTION_AGGREGATOR_IS_STRIPE')
        && errors.some((e) => e.code === 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED')
        && errors.every((e) => e.message.length > 0);
    });
    await assert('…and the cache still holds the last GOOD settings', () => getPaymentSettingsSync().version === 3);
  }

  {
    const s = stub(null);
    __setPaymentSettingsStoreForTests(s);
    s.createError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    const race = await caught(() => setPaymentSettings({ collectionAggregator: 'MYCOOLPAY' }, 0, ACTOR, 'first', facts()));
    await assert('the version-0 create race: a duplicate-key loser → 409 VERSION_CONFLICT', () =>
      race?.code === ERROR_CODES.PAYMENT_SETTINGS_VERSION_CONFLICT && race.statusCode === 409);

    s.createError = new Error('disk full');
    let rethrown = false;
    try {
      await setPaymentSettings({}, 0, ACTOR, 'x', facts());
    } catch (error) {
      rethrown = !(error instanceof AppError) && (error as Error).message === 'disk full';
    }
    await assert('any other create failure is NOT disguised as a conflict', () => rethrown);
  }

  await assert('toPaymentSettingsView is the camelCase projection routing.md fixes', () => {
    const v = toPaymentSettingsView(record());
    return same(Object.keys(v), ['collectionAggregator', 'payoutAggregator', 'stripeEnabled', 'providers', 'version', 'updatedAt', 'updatedBy', 'reason'])
      && v.updatedBy?.id === 'adm-1' && same(Object.keys(v.providers), ['MTN', 'ORANGE', 'MOOV', 'CARD']);
  });

  // ── 4. Registry ────────────────────────────────────────────────────────────
  section('4. Registry — configured, facts, and the transitional accept rule');

  await assert('precondition: both mobile rails are configured by this suite’s fixtures', () =>
    gatewayConfigured('NOTCHPAY') && gatewayConfigured('MYCOOLPAY') && !gatewayConfigured('STRIPE'));
  await assert('gatewayConfigured is false for an unknown name', () => !gatewayConfigured('PAYPAL') && !gatewayConfigured(''));
  await assert('buildRoutingFacts covers every gateway with the adapter’s own capabilities', () => {
    const f = buildRoutingFacts();
    return PAYMENT_GATEWAY_NAMES.every((n) => f[n].capabilities === PAYMENT_GATEWAYS.get(n)!.capabilities)
      && f.NOTCHPAY.payoutImplemented && f.MYCOOLPAY.payoutImplemented && f.CAMPAY.payoutImplemented
      && !f.STRIPE.payoutImplemented;
  });
  await assert('the routing service re-exports the same buildRoutingFacts', () => buildRoutingFactsFromService === buildRoutingFacts);

  __setPaymentSettingsStoreForTests(stub(null));
  __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);
  // C1 flipped these two: the version-0 transition bridge is gone, so no document means the
  // DEFAULTS decide — NotchPay only, Stripe off — exactly as a written document would.
  await assert('C1, no document (version 0): only the default aggregator — MYCOOLPAY is REFUSED', () =>
    !gatewayAcceptsNewPayments('MYCOOLPAY') && gatewayAcceptsNewPayments('NOTCHPAY')
    && offeredPaymentGateways().join(',') === 'NOTCHPAY');
  await assert('C1, no document: Stripe keys alone do NOT turn cards on (stripe_enabled defaults off)', () =>
    !gatewayAcceptsNewPayments('STRIPE') && !withStripe(() => gatewayAcceptsNewPayments('STRIPE')));
  await assert('C1: the transition bridge is gone from the registry source', () =>
    !readFileSync(join(__dirname, '../../src/modules/payments/gateways/registry.ts'), 'utf8')
      .includes('settings.version === 0'));

  __resetPaymentSettingsCacheForTests(record({ collection_aggregator: 'NOTCHPAY', version: 4 }), true);
  await assert('with a document: a non-active aggregator is REFUSED (the one rule since C1)', () =>
    !gatewayAcceptsNewPayments('MYCOOLPAY') && gatewayAcceptsNewPayments('NOTCHPAY')
    && offeredPaymentGateways().join(',') === 'NOTCHPAY');
  const refusal = await caught(() => assertGatewayOffered('MYCOOLPAY'));
  await assert('…assertGatewayOffered keeps its code, status and details shape', () =>
    refusal?.code === ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED && refusal.statusCode === 400
    && same((refusal.details as { offered: string[] }).offered, ['NOTCHPAY']));
  await assert('with a document: Stripe needs its keys AND stripe_enabled', () =>
    !withStripe(() => gatewayAcceptsNewPayments('STRIPE')));
  __resetPaymentSettingsCacheForTests(record({ stripe_enabled: true, version: 4 }), true);
  await assert('…both present → accepted; keys absent → refused', () =>
    withStripe(() => gatewayAcceptsNewPayments('STRIPE')) && !gatewayAcceptsNewPayments('STRIPE'));
  __resetPaymentSettingsCacheForTests(record({ collection_aggregator: 'MYCOOLPAY', version: 4 }), true);
  await assert('switching collections to MYCOOLPAY flips which mobile rail is accepted', () =>
    gatewayAcceptsNewPayments('MYCOOLPAY') && !gatewayAcceptsNewPayments('NOTCHPAY'));

  // ── 5. Resolver ────────────────────────────────────────────────────────────
  section('5. payment-routing.service — the door for new charges');

  __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);
  await assert('defaults: MTN → NOTCHPAY, flow PUSH', () => {
    const r = resolveCollectionRoute('MTN');
    return r.aggregator === 'NOTCHPAY' && r.provider === 'MTN' && r.capability.flow === 'PUSH';
  });
  await assert('defaults: offeredProviders = MTN, ORANGE', () => same(offeredProviders(), ['MTN', 'ORANGE']));
  await assert('defaults: resolvePayoutAggregator = NOTCHPAY', () => resolvePayoutAggregator() === 'NOTCHPAY');

  __resetPaymentSettingsCacheForTests(record({ collection_aggregator: 'MYCOOLPAY', version: 4 }), true);
  await assert('MyCoolPay active: ORANGE → MYCOOLPAY with flow OTP', () => {
    const r = resolveCollectionRoute('ORANGE');
    return r.aggregator === 'MYCOOLPAY' && r.capability.flow === 'OTP';
  });

  __resetPaymentSettingsCacheForTests(
    record({ version: 4, providers: { MTN: { enabled: false }, ORANGE: { enabled: true }, MOOV: { enabled: false }, CARD: { enabled: true } } }),
    true,
  );
  for (const provider of ['MTN', 'CARD'] as PaymentProvider[]) {
    const e = await caught(() => resolveCollectionRoute(provider));
    await assert(`${provider} unroutable → 422 PAYMENT_PROVIDER_UNAVAILABLE {provider, offered: [ORANGE]}`, () => {
      const d = e?.details as { provider?: string; offered?: string[] } | undefined;
      return e?.code === ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE && e.statusCode === 422
        && d?.provider === provider && same(d?.offered ?? [], ['ORANGE']);
    });
  }

  __resetPaymentSettingsCacheForTests(record({ payout_aggregator: 'NOT_A_GATEWAY' as PaymentGatewayName, version: 4 }), true);
  await assert('resolvePayoutAggregator → null for a name this build does not register', () => resolvePayoutAggregator() === null);
  __resetPaymentSettingsCacheForTests(DEFAULT_PAYMENT_SETTINGS, true);

  const required = await caught(() => deriveProviderOrThrow({ gateway: 'NOTCHPAY', channel: { phoneNumber: '+237660000001' } }));
  await assert('deriveProviderOrThrow: nothing derivable → 400 PAYMENT_PROVIDER_REQUIRED', () =>
    required?.code === ERROR_CODES.PAYMENT_PROVIDER_REQUIRED && required.statusCode === 400);
  await assert('deriveProviderOrThrow: legacy STRIPE → CARD; a prefix → its operator', () =>
    deriveProviderOrThrow({ gateway: 'STRIPE', channel: { phoneNumber: '+237650000001' } }) === 'CARD'
    && deriveProviderOrThrow({ channel: { phoneNumber: '+237690000001' } }) === 'ORANGE');

  const mismatch = await caught(() => checkChargeRequestOrThrow('ORANGE', { phoneNumber: '+237670000001' }));
  await assert('mismatch → 422 PAYMENT_PROVIDER_PHONE_MISMATCH {provider, detected, spent:false}', () => {
    const d = mismatch?.details as { provider?: string; detected?: string; spent?: boolean } | undefined;
    return mismatch?.code === ERROR_CODES.PAYMENT_PROVIDER_PHONE_MISMATCH && mismatch.statusCode === 422
      && d?.provider === 'ORANGE' && d?.detected === 'MTN' && d?.spent === false;
  });
  await assert('a missing field is RETURNED for the door’s own error, never raised', () => {
    const r = checkChargeRequestOrThrow('MTN', {});
    return !r.ok && r.refusal === 'FIELD_MISSING' && same(r.missing, ['phoneNumber']);
  });
  await assert('a passing check is returned unchanged', () => {
    const r = enforceChargeRequestCheck({ ok: true, detected: 'MTN' });
    return r.ok && r.detected === 'MTN';
  });

  // ── 6. Scans ───────────────────────────────────────────────────────────────
  section('6. Source scans');

  const SRC = join(__dirname, '../../src');
  const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

  await assert('lifecycle primes the payment settings, awaited, right after maintenance and before listen', () => {
    const text = read('lifecycle.ts');
    const maintenance = text.indexOf('await primeMaintenanceState()');
    const prime = text.indexOf('await primePaymentSettings()');
    const listen = text.indexOf('= app.listen(');
    return maintenance > 0 && prime > maintenance && listen > prime;
  });

  await assert('the settings service loads the registry LAZILY (a static import would be a cycle)', () => {
    const text = read('modules/payments/services/payment-settings.service.ts');
    const staticImports = [...text.matchAll(/^import[^;]+from\s+'([^']+)'/gm)].map((m) => m[1]);
    return !staticImports.some((i) => i.includes('registry')) && text.includes("await import('../gateways/registry')");
  });

  // STRICT since C1 (was a report). "Which aggregator" is decided by the settings; the
  // environment only says whether one CAN be used, and only the registry asks it that.
  //
  // May call the credential predicates: the file that defines them, the registry (its CONFIGURED
  // table is the one routing input), and the integration inventory (a diagnostic that decides
  // nothing). May read a raw credential from the environment: the config file, the Stripe client
  // (builds the client), the Stripe adapter (verifies its own webhook), and the two system
  // diagnostics. Anything else is a second routing opinion, or a hidden one.
  const predicateAllowed = new Set([
    'modules/payments/config/payments.config.ts',
    'modules/payments/gateways/registry.ts',
    'modules/system/services/integration-inventory.service.ts',
  ]);
  const credentialAllowed = new Set([
    'modules/payments/config/payments.config.ts',
    'modules/payments/gateways/stripe.client.ts',
    'modules/payments/gateways/stripe.gateway.ts',
    'modules/system/domain/exposed-config.ts',
    'modules/system/services/integration-inventory.service.ts',
  ]);
  const PREDICATE_CALL = /\b(notchPayEnabled|myCoolPayEnabled|stripeEnabled)\s*\(/;
  const PREDICATE_IMPORT = /import\s*\{[^}]*\b(notchPayEnabled|myCoolPayEnabled|stripeEnabled)\b[^}]*\}\s*from\s*'[^']*payments\.config'/;
  const CREDENTIAL_READ =
    /process\.env\.(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|NOTCHPAY_PUBLIC_KEY|NOTCHPAY_PRIVATE_KEY|NOTCHPAY_WEBHOOK_SECRET|MYCOOLPAY_PUBLIC_KEY|MYCOOLPAY_PRIVATE_KEY)\b/;
  const predicateHits: string[] = [];
  const credentialHits: string[] = [];
  const botSurfaceImports: string[] = [];
  let scanned = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts')) {
        scanned++;
        const rel = relative(SRC, full).replace(/\\/g, '/');
        const text = readFileSync(full, 'utf8');
        if (!predicateAllowed.has(rel) && PREDICATE_IMPORT.test(text)) predicateHits.push(`${rel}  (imports a predicate)`);
        if (rel.startsWith('modules/payments/') && /from\s+'[^']*bot-surface[^']*'|require\('[^']*bot-surface/.test(text)) {
          botSurfaceImports.push(rel);
        }
        text.split(/\r?\n/).forEach((line, i) => {
          if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
          if (!predicateAllowed.has(rel) && PREDICATE_CALL.test(line)) predicateHits.push(`${rel}:${i + 1}  ${line.trim()}`);
          if (!credentialAllowed.has(rel) && CREDENTIAL_READ.test(line)) credentialHits.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
      }
    }
  };
  walk(SRC);
  const show = (hits: string[]) => hits.forEach((hit) => originalConsole.error(`      ${hit}`));
  await assert(`the scans ran (${scanned} files)`, () => scanned > 500);
  await assert('⛔ no routing decision from an env predicate outside the registry (strict since C1)', () => {
    show(predicateHits);
    return predicateHits.length === 0;
  });
  await assert('⛔ no raw gateway-credential read outside the allowlist', () => {
    show(credentialHits);
    return credentialHits.length === 0;
  });
  await assert('⛔ src/modules/payments never imports bot-surface', () => {
    show(botSurfaceImports);
    return botSurfaceImports.length === 0;
  });

  __setPaymentSettingsStoreForTests(null);

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log('═'.repeat(76));
  process.exit(failed > 0 ? 1 : 0);
})();
