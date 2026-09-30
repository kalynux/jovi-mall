/**
 * test:payment-routing — the ADR-A08 decision table, offline.
 *
 * Everything routing decides lives in two pure modules, `payments/domain/payment-provider.ts`
 * and `payments/domain/payment-routing.ts`. Their inputs are injected (`facts`), so the whole
 * table runs here without a database, a server or a gateway key:
 *
 *   1. One list        PAYMENT_GATEWAY_NAMES is the only gateway list: the registry, the model
 *                      enums and the validators all equal it, in order.
 *   2. Capabilities    the matrix each adapter declares, against api-doc/payments/routing.md.
 *   3. Catalogue       providers, kinds, the saved-wallet bridge, the defaults.
 *   4. routeCollection the CARD/Stripe matrix and the mobile-money rules.
 *   5. effective…      what /options will be built from.
 *   6. Request checks  required fields, and the provider/number mismatch (prefix alone decides).
 *   7. deriveProvider  the legacy-body order, STRIPE first.
 *   8. Settings        every hard rule, every soft rule, and payout validity.
 *   9. Purity          the two modules import no I/O and read no environment.
 *
 * Run: npm run test:payment-routing
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { originalConsole } from '../../src/core/logging/sink-guard';
import {
  PAYMENT_GATEWAY_NAMES,
  PaymentGatewayName,
  GatewayCapabilities,
} from '../../src/modules/payments/gateways/gateway.interface';
import {
  PAYMENT_GATEWAYS as GATEWAY_MAP,
  PAYMENT_GATEWAY_NAMES as REGISTRY_NAMES,
} from '../../src/modules/payments/gateways/registry';
import {
  InitiatePaymentRequestSchema,
  InitiateBookingPaymentRequestSchema,
} from '../../src/modules/payments/validators/payment.validators';
import {
  InitiateTopupRequestSchema,
  InitiatePlanPurchaseRequestSchema,
} from '../../src/modules/billing/validators/billing.validators';
import { BotBookingPaySchema } from '../../src/modules/bot-surface/validators/bot.validators';
import { PaymentTransactionModel } from '../../src/modules/payments/models/payment-transaction.model';
import { PaymentWebhookEventModel } from '../../src/modules/payments/models/payment-webhook-event.model';
import { RefundTransactionModel } from '../../src/modules/payments/models/refund-transaction.model';
import { PlanPurchaseModel } from '../../src/modules/billing/models/plan-purchase.model';
import { CreditTopupModel } from '../../src/modules/billing/models/credit-topup.model';
import {
  PAYMENT_PROVIDERS,
  PROVIDER_KIND,
  PaymentProvider,
  isPaymentProvider,
  providerForSavedWallet,
} from '../../src/modules/payments/domain/payment-provider';
import {
  DEFAULT_PAYMENT_SETTINGS,
  PaymentSettings,
  PaymentSettingsCandidate,
  RoutingFacts,
  AggregatorFacts,
  routeCollection,
  effectiveProviders,
  checkProviderPhone,
  checkChargeRequest,
  deriveProvider,
  validateSettingsChange,
  SettingsIssueCode,
} from '../../src/modules/payments/domain/payment-routing';
import { resolveCameroonOperator } from '../../src/modules/payments/domain/cm-operator';

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

const same = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Facts built from the REAL adapter capabilities, with configuration toggled per case. */
function facts(overrides: Partial<Record<PaymentGatewayName, Partial<AggregatorFacts>>> = {}): RoutingFacts {
  const base = {} as Record<PaymentGatewayName, AggregatorFacts>;
  for (const name of PAYMENT_GATEWAY_NAMES) {
    const g = GATEWAY_MAP.get(name)!;
    base[name] = {
      configured: name !== 'STRIPE', // production today: both mobile rails keyed, Stripe absent
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

const candidate = (s: PaymentSettings, extraProviders: Record<string, { enabled: boolean }> = {}): PaymentSettingsCandidate => ({
  ...s,
  providers: { ...s.providers, ...extraProviders },
});

/** A My-CoolPay that could take cards, to exercise "Stripe off → CARD through the aggregator". */
const CARD_CAPABLE: GatewayCapabilities = {
  collect: { ...GATEWAY_MAP.get('MYCOOLPAY')!.capabilities.collect, CARD: { flow: 'REDIRECT', requires: [] } },
  settlesAsync: true,
};

function route(provider: PaymentProvider, s: PaymentSettings, f: RoutingFacts): string {
  const r = routeCollection(provider, s, f);
  return r.ok ? `${r.aggregator}:${r.capability.flow}` : r.reason;
}

function codes(v: ReturnType<typeof validateSettingsChange>): SettingsIssueCode[] {
  return v.ok ? v.warnings.map((w) => w.code) : v.errors.map((e) => e.code);
}

function enumOf(model: { schema: { eachPath(fn: (path: string, type: any) => void): void } }): string[] {
  let values: string[] = [];
  model.schema.eachPath((path, type) => {
    if (path === 'gateway' || path.endsWith('.gateway')) values = type.enumValues ?? type.options?.enum ?? [];
  });
  return values;
}

(async () => {
  // ── 1. One list ────────────────────────────────────────────────────────────
  section('1. One gateway list');

  assert('PAYMENT_GATEWAY_NAMES is NOTCHPAY, MYCOOLPAY, STRIPE, CAMPAY, in that order', () =>
    same(PAYMENT_GATEWAY_NAMES, ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE', 'CAMPAY']));
  assert('the registry re-exports the SAME tuple (not a second copy)', () => REGISTRY_NAMES === PAYMENT_GATEWAY_NAMES);
  assert('the registry Map registers exactly these names, in order', () =>
    same([...GATEWAY_MAP.keys()], PAYMENT_GATEWAY_NAMES));

  for (const [label, model] of [
    ['PaymentTransaction', PaymentTransactionModel],
    ['PaymentWebhookEvent', PaymentWebhookEventModel],
    ['RefundTransaction', RefundTransactionModel],
    ['PlanPurchase', PlanPurchaseModel],
    ['CreditTopup', CreditTopupModel],
  ] as const) {
    assert(`${label}.gateway enum equals the tuple`, () => same(enumOf(model as any), PAYMENT_GATEWAY_NAMES));
  }
  // C1: the gateway-enum request schemas are gone. Every surviving request schema ACCEPTS the
  // legacy `gateway` as any string (old apps and the live n8n MCP still send it — owner decision 4)
  // and closes `provider` to the catalogue.
  const requestSchemas: Array<[string, { safeParse(v: unknown): { success: boolean } }, Record<string, unknown>]> = [
    ['InitiatePaymentRequestSchema', InitiatePaymentRequestSchema, { orderId: 'o1' }],
    ['InitiateBookingPaymentRequestSchema', InitiateBookingPaymentRequestSchema, {}],
    ['InitiateTopupRequestSchema', InitiateTopupRequestSchema, { packCode: 'P1' }],
    ['InitiatePlanPurchaseRequestSchema', InitiatePlanPurchaseRequestSchema, {}],
  ];
  for (const [label, schema, base] of requestSchemas) {
    assert(`${label}: legacy gateway (any string) parses; provider is closed`, () =>
      [...PAYMENT_GATEWAY_NAMES, 'NOT_A_GATEWAY'].every((g) => schema.safeParse({ ...base, gateway: g, provider: 'MTN' }).success)
      && schema.safeParse({ ...base, provider: 'CARD' }).success
      && !schema.safeParse({ ...base, provider: 'NOTCHPAY' }).success);
  }
  assert('C1: the gateway-enum schemas and the PAYMENT_GATEWAYS validator alias are gone', () => {
    const payments = readFileSync(join(__dirname, '../../src/modules/payments/validators/payment.validators.ts'), 'utf8');
    const billing = readFileSync(join(__dirname, '../../src/modules/billing/validators/billing.validators.ts'), 'utf8');
    return !/export const (InitiatePaymentSchema|InitiateBookingPaymentSchema|PAYMENT_GATEWAYS)\b/.test(payments)
      && !/export const (InitiateTopupSchema|InitiatePlanPurchaseSchema)\b/.test(billing);
  });
  // W2b (ADR-A08): the bot's `gateway` is accepted and IGNORED, like the HTTP doors' — so any
  // string parses, a known name or not. What the chat may choose is the PROVIDER, and that is closed.
  assert('bot BotBookingPaySchema ignores `gateway` (any string parses) and closes `provider`', () =>
    PAYMENT_GATEWAY_NAMES.every((g) => BotBookingPaySchema.safeParse({ gateway: g, phoneNumber: '+237670000001' }).success)
    && BotBookingPaySchema.safeParse({ gateway: 'NOT_A_GATEWAY', phoneNumber: '+237670000001' }).success
    && ['MTN', 'ORANGE', 'CARD'].every((p) => BotBookingPaySchema.safeParse({ provider: p, phoneNumber: '+237670000001' }).success)
    && !BotBookingPaySchema.safeParse({ provider: 'MOOV', phoneNumber: '+237670000001' }).success
    && !BotBookingPaySchema.safeParse({ provider: 'NOTCHPAY', phoneNumber: '+237670000001' }).success);

  const SRC = join(__dirname, '../../src');
  const handCopied = /['"]NOTCHPAY['"]\s*,\s*['"]MYCOOLPAY['"]\s*,\s*['"]STRIPE['"]/;
  for (const rel of [
    'modules/payments/models/payment-transaction.model.ts',
    'modules/payments/models/payment-webhook-event.model.ts',
    'modules/payments/models/refund-transaction.model.ts',
    'modules/billing/models/plan-purchase.model.ts',
    'modules/billing/models/credit-topup.model.ts',
    'modules/billing/validators/billing.validators.ts',
    'modules/bot-surface/validators/bot.validators.ts',
    'modules/payments/validators/payment.validators.ts',
    'modules/billing/domain/gateway-otp.ts',
  ]) {
    assert(`${rel} carries no hand-copied gateway list`, () => {
      const text = readFileSync(join(SRC, rel), 'utf8');
      return !handCopied.test(text) && !/'NOTCHPAY'\s*\|\s*'MYCOOLPAY'\s*\|\s*'STRIPE'/.test(text);
    });
  }

  // ── 2. Capabilities ────────────────────────────────────────────────────────
  section('2. Capability matrix (routing.md)');

  const cap = (g: PaymentGatewayName) => GATEWAY_MAP.get(g)!.capabilities;
  const flowOf = (g: PaymentGatewayName, p: PaymentProvider) => cap(g).collect[p]?.flow ?? '—';
  const matrix: Array<[PaymentGatewayName, Record<PaymentProvider, string>, boolean]> = [
    ['NOTCHPAY', { MTN: 'PUSH', ORANGE: 'PUSH', MOOV: '—', CARD: '—' }, true],
    ['MYCOOLPAY', { MTN: 'PUSH', ORANGE: 'OTP', MOOV: '—', CARD: '—' }, true],
    ['STRIPE', { MTN: '—', ORANGE: '—', MOOV: '—', CARD: 'CARD_ELEMENT' }, false],
    ['CAMPAY', { MTN: 'PUSH', ORANGE: 'PUSH', MOOV: '—', CARD: '—' }, true],
  ];
  for (const [g, row, async] of matrix) {
    assert(`${g}: ${PAYMENT_PROVIDERS.map((p) => `${p}=${row[p]}`).join(' ')}, settlesAsync=${async}`, () =>
      PAYMENT_PROVIDERS.every((p) => flowOf(g, p) === row[p]) && cap(g).settlesAsync === async);
  }
  assert('every mobile-money capability requires phoneNumber', () =>
    PAYMENT_GATEWAY_NAMES.every((g) =>
      (['MTN', 'ORANGE', 'MOOV'] as const).every((p) => {
        const c = cap(g).collect[p];
        return !c || same(c.requires, ['phoneNumber']);
      })));
  assert('Stripe CARD requires nothing up front', () => same(cap('STRIPE').collect.CARD!.requires, []));
  assert('NOTCHPAY and CAMPAY can send payouts (My-CoolPay and Stripe cannot)', () =>
    PAYMENT_GATEWAY_NAMES.filter((g) => typeof GATEWAY_MAP.get(g)!.createPayout === 'function').join() === 'NOTCHPAY,CAMPAY');

  // ── 3. Catalogue ───────────────────────────────────────────────────────────
  section('3. Provider catalogue, saved wallets, defaults');

  assert('PAYMENT_PROVIDERS is MTN, ORANGE, MOOV, CARD', () => same(PAYMENT_PROVIDERS, ['MTN', 'ORANGE', 'MOOV', 'CARD']));
  assert('kinds: three mobile money, CARD is CARD', () =>
    PROVIDER_KIND.MTN === 'MOBILE_MONEY' && PROVIDER_KIND.ORANGE === 'MOBILE_MONEY'
    && PROVIDER_KIND.MOOV === 'MOBILE_MONEY' && PROVIDER_KIND.CARD === 'CARD');
  assert('isPaymentProvider refuses lowercase and aggregator names', () =>
    isPaymentProvider('MTN') && !isPaymentProvider('mtn') && !isPaymentProvider('NOTCHPAY') && !isPaymentProvider(null));
  assert('saved wallets: mtn_momo→MTN, orange_money→ORANGE, moov_money→MOOV', () =>
    providerForSavedWallet('mtn_momo') === 'MTN' && providerForSavedWallet('orange_money') === 'ORANGE'
    && providerForSavedWallet('moov_money') === 'MOOV');
  assert('saved wallets: stripe / notchpay / mycoolpay / unknown / null → null', () =>
    [ 'stripe', 'notchpay', 'mycoolpay', 'paystack', '', null, undefined, 'toString', '__proto__' ]
      .every((v) => providerForSavedWallet(v as string) === null));
  assert('saved wallets tolerate case and whitespace', () => providerForSavedWallet(' MTN_MOMO ') === 'MTN');
  assert('defaults: NotchPay collects and pays out, Stripe off, version 0', () =>
    DEFAULT_PAYMENT_SETTINGS.collection_aggregator === 'NOTCHPAY'
    && DEFAULT_PAYMENT_SETTINGS.payout_aggregator === 'NOTCHPAY'
    && DEFAULT_PAYMENT_SETTINGS.stripe_enabled === false && DEFAULT_PAYMENT_SETTINGS.version === 0);
  assert('defaults: MTN and ORANGE on, MOOV and CARD off', () =>
    DEFAULT_PAYMENT_SETTINGS.providers.MTN.enabled && DEFAULT_PAYMENT_SETTINGS.providers.ORANGE.enabled
    && !DEFAULT_PAYMENT_SETTINGS.providers.MOOV.enabled && !DEFAULT_PAYMENT_SETTINGS.providers.CARD.enabled);
  assert('defaults are frozen, deep', () =>
    Object.isFrozen(DEFAULT_PAYMENT_SETTINGS) && Object.isFrozen(DEFAULT_PAYMENT_SETTINGS.providers)
    && Object.isFrozen(DEFAULT_PAYMENT_SETTINGS.providers.MTN));

  // ── 4. routeCollection ─────────────────────────────────────────────────────
  section('4. routeCollection — mobile money');

  const F = facts();
  assert('defaults: MTN → NOTCHPAY:PUSH', () => route('MTN', settings(), F) === 'NOTCHPAY:PUSH');
  assert('defaults: ORANGE → NOTCHPAY:PUSH', () => route('ORANGE', settings(), F) === 'NOTCHPAY:PUSH');
  assert('MyCoolPay active: ORANGE → MYCOOLPAY:OTP', () =>
    route('ORANGE', settings({ collection_aggregator: 'MYCOOLPAY' }), F) === 'MYCOOLPAY:OTP');
  assert('MyCoolPay active: MTN → MYCOOLPAY:PUSH', () =>
    route('MTN', settings({ collection_aggregator: 'MYCOOLPAY' }), F) === 'MYCOOLPAY:PUSH');
  assert('a disabled provider → PROVIDER_DISABLED', () =>
    route('MTN', settings({ providers: { MTN: false } }), F) === 'PROVIDER_DISABLED');
  assert('MOOV enabled, no aggregator declares it → NO_ROUTE', () =>
    route('MOOV', settings({ providers: { MOOV: true } }), F) === 'NO_ROUTE');
  assert('the collection aggregator lost its credentials → NO_ROUTE', () =>
    route('MTN', settings(), facts({ NOTCHPAY: { configured: false } })) === 'NO_ROUTE');
  assert('collection_aggregator STRIPE never routes mobile money', () =>
    route('MTN', settings({ collection_aggregator: 'STRIPE' }), facts({ STRIPE: { configured: true } })) === 'NO_ROUTE');

  section('4b. routeCollection — the CARD / Stripe matrix (owner decision 2)');

  const cardCases: Array<[string, PaymentSettings, RoutingFacts, string]> = [
    ['Stripe ON, configured, CARD on → STRIPE',
      settings({ stripe_enabled: true, providers: { CARD: true } }), facts({ STRIPE: { configured: true } }), 'STRIPE:CARD_ELEMENT'],
    ['Stripe ON, NOT configured, CARD on → NO_ROUTE',
      settings({ stripe_enabled: true, providers: { CARD: true } }), facts(), 'NO_ROUTE'],
    ['Stripe ON, CARD OFF → no cards (PROVIDER_DISABLED)',
      settings({ stripe_enabled: true, providers: { CARD: false } }), facts({ STRIPE: { configured: true } }), 'PROVIDER_DISABLED'],
    ['Stripe ON, aggregator CAN take cards → still STRIPE, never the aggregator',
      settings({ stripe_enabled: true, collection_aggregator: 'MYCOOLPAY', providers: { CARD: true } }),
      facts({ STRIPE: { configured: true }, MYCOOLPAY: { capabilities: CARD_CAPABLE } }), 'STRIPE:CARD_ELEMENT'],
    ['Stripe ON unconfigured, aggregator CAN take cards → NO_ROUTE (no fallback to the aggregator)',
      settings({ stripe_enabled: true, collection_aggregator: 'MYCOOLPAY', providers: { CARD: true } }),
      facts({ MYCOOLPAY: { capabilities: CARD_CAPABLE } }), 'NO_ROUTE'],
    ['Stripe OFF, aggregator declares CARD → the aggregator',
      settings({ collection_aggregator: 'MYCOOLPAY', providers: { CARD: true } }),
      facts({ MYCOOLPAY: { capabilities: CARD_CAPABLE } }), 'MYCOOLPAY:REDIRECT'],
    ['Stripe OFF, aggregator has no CARD → NO_ROUTE',
      settings({ providers: { CARD: true } }), facts({ STRIPE: { configured: true } }), 'NO_ROUTE'],
    ['Stripe OFF, CARD OFF → PROVIDER_DISABLED',
      settings(), facts(), 'PROVIDER_DISABLED'],
  ];
  for (const [label, s, f, expected] of cardCases) assert(label, () => route('CARD', s, f) === expected);

  // ── 5. effectiveProviders ──────────────────────────────────────────────────
  section('5. effectiveProviders — what /options is built from');

  const summary = (s: PaymentSettings, f: RoutingFacts) =>
    effectiveProviders(s, f).map((e) => `${e.provider}@${e.aggregator}:${e.capability.flow}`).join(' ');
  assert('defaults → MTN and ORANGE via NotchPay, both PUSH', () =>
    summary(settings(), F) === 'MTN@NOTCHPAY:PUSH ORANGE@NOTCHPAY:PUSH');
  assert('MyCoolPay active → ORANGE is OTP', () =>
    summary(settings({ collection_aggregator: 'MYCOOLPAY' }), F) === 'MTN@MYCOOLPAY:PUSH ORANGE@MYCOOLPAY:OTP');
  assert('MTN disabled → only ORANGE', () => summary(settings({ providers: { MTN: false } }), F) === 'ORANGE@NOTCHPAY:PUSH');
  assert('Stripe on + CARD on → CARD appended last, via Stripe', () =>
    summary(settings({ stripe_enabled: true, providers: { CARD: true } }), facts({ STRIPE: { configured: true } }))
      === 'MTN@NOTCHPAY:PUSH ORANGE@NOTCHPAY:PUSH CARD@STRIPE:CARD_ELEMENT');
  assert('Stripe on + CARD off → no CARD', () =>
    !summary(settings({ stripe_enabled: true }), facts({ STRIPE: { configured: true } })).includes('CARD'));
  assert('aggregator unconfigured → empty (a valid answer)', () =>
    effectiveProviders(settings(), facts({ NOTCHPAY: { configured: false } })).length === 0);

  // ── 6. Request checks ──────────────────────────────────────────────────────
  section('6. checkProviderPhone / checkChargeRequest (owner decision 7)');

  const phoneCases: Array<[PaymentProvider, string | null, boolean, string | null, string]> = [
    ['ORANGE', '+237670000001', false, 'MTN', 'ORANGE + MTN number (67x) → mismatch'],
    ['MTN', '+237690000001', false, 'ORANGE', 'MTN + ORANGE number (69x) → mismatch'],
    ['MTN', '+237650000001', true, 'MTN', 'MTN + MTN number (650) → ok'],
    ['ORANGE', '+237655000001', true, 'ORANGE', 'ORANGE + ORANGE number (655) → ok'],
    ['ORANGE', '237685000001', true, 'ORANGE', 'bare-digits WhatsApp form resolves too (685 → ORANGE)'],
    ['MTN', '680000001', true, 'MTN', 'national form resolves too (680 → MTN)'],
    ['MTN', '+237660000001', true, null, 'MTN + Nexttel 66x (unknown) → declared wins'],
    ['ORANGE', '+237620000001', true, null, 'ORANGE + Camtel 62x (unknown) → declared wins'],
    ['MTN', '+33612345678', true, null, 'MTN + a foreign number (unknown) → declared wins'],
    ['MOOV', '+237670000001', false, 'MTN', 'MOOV + MTN number → mismatch'],
    ['CARD', '+237670000001', true, null, 'CARD → the number is never checked'],
    ['MTN', null, true, null, 'no number → nothing to compare (required-field check is separate)'],
  ];
  for (const [provider, phone, ok, detected, label] of phoneCases) {
    assert(label, () => {
      const r = checkProviderPhone(provider, phone);
      return r.ok === ok && r.detected === detected;
    });
  }

  assert('⚠ prefix alone decides: resolveCameroonOperator would let a declared ORANGE win, the check does not', () =>
    resolveCameroonOperator('+237670000001', 'ORANGE') === 'ORANGE'
    && checkProviderPhone('ORANGE', '+237670000001').ok === false);

  assert('mobile money with no number → FIELD_MISSING [phoneNumber] (baseline, no capability)', () => {
    const r = checkChargeRequest('MTN', {});
    return !r.ok && r.refusal === 'FIELD_MISSING' && same(r.missing, ['phoneNumber']);
  });
  assert('a whitespace-only number counts as missing', () => {
    const r = checkChargeRequest('ORANGE', { phoneNumber: '   ' });
    return !r.ok && r.refusal === 'FIELD_MISSING';
  });
  assert('CARD with an empty channel passes (baseline requires nothing)', () => checkChargeRequest('CARD', null).ok);
  assert('a capability requiring customerEmail is honoured over the baseline', () => {
    const r = checkChargeRequest('CARD', {}, { flow: 'REDIRECT', requires: ['customerEmail'] });
    return !r.ok && r.refusal === 'FIELD_MISSING' && same(r.missing, ['customerEmail']);
  });
  assert('a missing field is reported BEFORE a mismatch is looked for', () => {
    const r = checkChargeRequest('ORANGE', { phoneNumber: '' });
    return !r.ok && r.refusal === 'FIELD_MISSING';
  });
  assert('ORANGE + MTN number → PHONE_MISMATCH {provider: ORANGE, detected: MTN}', () => {
    const r = checkChargeRequest('ORANGE', { phoneNumber: '+237670000001' });
    return !r.ok && r.refusal === 'PHONE_MISMATCH' && r.provider === 'ORANGE' && r.detected === 'MTN';
  });
  assert('MTN + MTN number → ok, detected MTN', () => {
    const r = checkChargeRequest('MTN', { phoneNumber: '+237670000001' });
    return r.ok && r.detected === 'MTN';
  });

  // ── 7. deriveProvider ──────────────────────────────────────────────────────
  section('7. deriveProvider — legacy bodies, STRIPE first');

  const deriveCases: Array<[string, Parameters<typeof deriveProvider>[0], PaymentProvider | null]> = [
    ['explicit provider wins over everything', { provider: 'ORANGE', gateway: 'STRIPE', channel: { phoneOperator: 'MTN', phoneNumber: '+237670000001' } }, 'ORANGE'],
    ['an explicit but invalid provider → null (never silently re-derived)', { provider: 'mtn', channel: { phoneNumber: '+237670000001' } }, null],
    ['⚠ gateway STRIPE + a phone number → CARD (never a push to that phone)', { gateway: 'STRIPE', channel: { phoneOperator: 'MTN', phoneNumber: '+237670000001' } }, 'CARD'],
    ['gateway STRIPE alone → CARD', { gateway: 'STRIPE' }, 'CARD'],
    ['phoneOperator MTN beats an ORANGE prefix', { gateway: 'NOTCHPAY', channel: { phoneOperator: 'MTN', phoneNumber: '+237690000001' } }, 'MTN'],
    ['phoneOperator is case-insensitive', { channel: { phoneOperator: 'orange' } }, 'ORANGE'],
    ['phoneOperator MOOV → MOOV', { channel: { phoneOperator: 'MOOV' } }, 'MOOV'],
    ['no operator: the prefix decides (69x → ORANGE)', { gateway: 'MYCOOLPAY', channel: { phoneNumber: '+237690000001' } }, 'ORANGE'],
    ['acceptance body {gateway: MYCOOLPAY, phone +23765…} → MTN', { gateway: 'MYCOOLPAY', channel: { phoneNumber: '+237650000001' } }, 'MTN'],
    ['unknown prefix and nothing else → null (400 PAYMENT_PROVIDER_REQUIRED)', { gateway: 'NOTCHPAY', channel: { phoneNumber: '+237660000001' } }, null],
    ['empty body → null', {}, null],
    ['an empty-string provider is treated as absent', { provider: '', channel: { phoneNumber: '+237650000001' } }, 'MTN'],
  ];
  for (const [label, input, expected] of deriveCases) assert(label, () => deriveProvider(input) === expected);

  // ── 8. Settings validation ─────────────────────────────────────────────────
  section('8. validateSettingsChange — hard rules');

  const CUR = settings();
  const hard: Array<[string, PaymentSettingsCandidate, PaymentSettings, RoutingFacts, SettingsIssueCode]> = [
    ['unknown collection aggregator', { ...candidate(CUR), collection_aggregator: 'NOT_A_GATEWAY' }, CUR, F, 'COLLECTION_AGGREGATOR_UNKNOWN'],
    ['STRIPE as collection aggregator', { ...candidate(CUR), collection_aggregator: 'STRIPE' }, CUR, facts({ STRIPE: { configured: true } }), 'COLLECTION_AGGREGATOR_IS_STRIPE'],
    ['collection aggregator without credentials', candidate(settings({ collection_aggregator: 'MYCOOLPAY' })), CUR, facts({ MYCOOLPAY: { configured: false } }), 'COLLECTION_AGGREGATOR_NOT_CONFIGURED'],
    ['aggregator serves none of the enabled mobile providers (only MOOV on)', candidate(settings({ providers: { MTN: false, ORANGE: false, MOOV: true } })), CUR, F, 'COLLECTION_AGGREGATOR_NO_ENABLED_PROVIDER'],
    ['turning Stripe ON without credentials', candidate(settings({ stripe_enabled: true })), CUR, F, 'STRIPE_NOT_CONFIGURED'],
    ['unknown payout aggregator', { ...candidate(CUR), payout_aggregator: 'NOT_A_GATEWAY' }, CUR, F, 'PAYOUT_AGGREGATOR_UNKNOWN'],
    ['payout aggregator without createPayout (MYCOOLPAY)', candidate(settings({ payout_aggregator: 'MYCOOLPAY' })), CUR, F, 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED'],
    ['payout aggregator without createPayout (STRIPE)', candidate(settings({ payout_aggregator: 'STRIPE' })), CUR, F, 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED'],
    ['unknown provider name', candidate(CUR, { WAVE: { enabled: true } }), CUR, F, 'PROVIDER_UNKNOWN'],
  ];
  for (const [label, c, cur, f, code] of hard) {
    assert(`refused: ${label} → ${code}`, () => {
      const v = validateSettingsChange(c, cur, f);
      return !v.ok && codes(v).includes(code) && v.errors.every((e) => e.message.length > 0);
    });
  }
  assert('several faults are all reported at once', () => {
    const v = validateSettingsChange(
      { ...candidate(CUR, { WAVE: { enabled: true } }), collection_aggregator: 'NOT_A_GATEWAY', payout_aggregator: 'MYCOOLPAY' }, CUR, F);
    return !v.ok && ['PROVIDER_UNKNOWN', 'COLLECTION_AGGREGATOR_UNKNOWN', 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED']
      .every((c) => codes(v).includes(c as SettingsIssueCode));
  });

  section('8b. validateSettingsChange — accepted, with soft warnings');

  assert('the defaults are valid with no warnings', () => {
    const v = validateSettingsChange(candidate(CUR), CUR, F);
    return v.ok && v.warnings.length === 0;
  });
  assert('switching collections to MyCoolPay is valid with no warnings', () => {
    const v = validateSettingsChange(candidate(settings({ collection_aggregator: 'MYCOOLPAY' })), CUR, F);
    return v.ok && v.warnings.length === 0 && v.settings.collection_aggregator === 'MYCOOLPAY';
  });
  assert('emergency switch is never blocked by an unroutable enabled provider → PROVIDER_UNROUTABLE (MOOV)', () => {
    const v = validateSettingsChange(candidate(settings({ collection_aggregator: 'MYCOOLPAY', providers: { MOOV: true } })), CUR, F);
    return v.ok && same(codes(v), ['PROVIDER_UNROUTABLE']) && v.warnings[0].provider === 'MOOV';
  });
  assert('all mobile providers OFF is allowed (the "stop mobile money" lever) → NO_MOBILE_PROVIDER_ENABLED', () => {
    const v = validateSettingsChange(candidate(settings({ providers: { MTN: false, ORANGE: false } })), CUR, F);
    return v.ok && same(codes(v), ['NO_MOBILE_PROVIDER_ENABLED']);
  });
  assert('card-only (mobile off, Stripe on + configured, CARD on) is valid', () => {
    const v = validateSettingsChange(
      candidate(settings({ stripe_enabled: true, providers: { MTN: false, ORANGE: false, CARD: true } })), CUR,
      facts({ STRIPE: { configured: true } }));
    return v.ok && same(codes(v), ['NO_MOBILE_PROVIDER_ENABLED']);
  });
  assert('CARD on with Stripe off and no card-capable aggregator → CARD_UNROUTABLE', () => {
    const v = validateSettingsChange(candidate(settings({ providers: { CARD: true } })), CUR, F);
    return v.ok && same(codes(v), ['CARD_UNROUTABLE']);
  });
  assert('Stripe ALREADY on and now unconfigured does not block an unrelated switch (warns CARD_UNROUTABLE)', () => {
    const cur = settings({ stripe_enabled: true, providers: { CARD: true } });
    const v = validateSettingsChange(candidate({ ...cur, collection_aggregator: 'MYCOOLPAY' }), cur, F);
    return v.ok && same(codes(v), ['CARD_UNROUTABLE']);
  });
  assert('turning Stripe on WITH credentials is valid', () => {
    const v = validateSettingsChange(candidate(settings({ stripe_enabled: true, providers: { CARD: true } })), CUR,
      facts({ STRIPE: { configured: true } }));
    return v.ok && v.warnings.length === 0;
  });
  assert('payout aggregator implemented but not available → PAYOUT_UNAVAILABLE, accepted', () => {
    const v = validateSettingsChange(candidate(CUR), CUR, facts({ NOTCHPAY: { payoutAvailable: false } }));
    return v.ok && same(codes(v), ['PAYOUT_UNAVAILABLE']);
  });
  assert('a known provider missing from the candidate is treated as disabled', () => {
    const v = validateSettingsChange({ ...candidate(CUR), providers: { MTN: { enabled: true } } }, CUR, F);
    return v.ok && v.settings.providers.ORANGE.enabled === false && v.settings.providers.MTN.enabled === true;
  });
  assert('a valid result carries all four providers, normalised', () => {
    const v = validateSettingsChange(candidate(CUR), CUR, F);
    return v.ok && same(Object.keys(v.settings.providers), PAYMENT_PROVIDERS);
  });

  // ── 9. Purity ──────────────────────────────────────────────────────────────
  section('9. Purity — no I/O, no environment');

  for (const rel of ['modules/payments/domain/payment-routing.ts', 'modules/payments/domain/payment-provider.ts']) {
    const text = readFileSync(join(SRC, rel), 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    assert(`${rel} imports only the interface, the provider catalogue and cm-operator`, () =>
      imports.every((i) => ['../gateways/gateway.interface', './payment-provider', './cm-operator'].includes(i)));
    assert(`${rel} reads no process.env`, () => !/process\.env/.test(text));
  }

  originalConsole.log(`\n${'═'.repeat(76)}`);
  originalConsole.log(`  ${passed} passed, ${failed} failed`);
  originalConsole.log('═'.repeat(76));
  process.exit(failed > 0 ? 1 : 0);
})();
