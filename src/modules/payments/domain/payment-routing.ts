import {
  PAYMENT_GATEWAY_NAMES,
  PaymentGatewayName,
  GatewayCapabilities,
  ProviderCollectCapability,
  CollectField,
} from '../gateways/gateway.interface';
import {
  PAYMENT_PROVIDERS,
  PaymentProvider,
  PaymentProviderKind,
  PROVIDER_KIND,
  isPaymentProvider,
  isMobileMoneyProvider,
} from './payment-provider';
import { resolveCameroonOperator, CameroonMobileOperator } from './cm-operator';

/**
 * Payment routing: which aggregator opens a NEW charge for a provider (ADR-A08).
 *
 * ── PURE, AND THAT IS THE POINT ──────────────────────────────────────────────
 * No I/O, no environment reads, no registry. Everything this module decides from
 * arrives as arguments: the settings document and the per-aggregator `facts`
 * (credentials present, capabilities, payout support). The services that own the
 * I/O (`payment-settings.service.ts`, `payment-routing.service.ts`) build the facts
 * and call in. So the whole decision table is exercised by `test:payment-routing`
 * without a database or a key, and nothing here can drift from what it tests.
 *
 * ── ⛔ NEW CHARGES ONLY ──────────────────────────────────────────────────────
 * Nothing here is consulted by verify, refund, authorize, webhooks, reconciliation
 * or pay-link sessions. Those read `transaction.gateway` from the stored row, so a
 * charge opened on one aggregator settles through it after a switch (ADR-A08 D-6).
 *
 * Contract: `api-doc/payments/routing.md`.
 */

// ── Settings ─────────────────────────────────────────────────────────────────

export interface ProviderSetting {
  enabled: boolean;
}

/** The routing-relevant fields of the `payment_settings` document, as stored (snake_case). */
export interface PaymentSettings {
  /** The one non-Stripe aggregator for mobile-money collections (owner decision 1). */
  collection_aggregator: PaymentGatewayName;
  /** Separate from collections (owner decision 3). Must implement `createPayout`. */
  payout_aggregator: PaymentGatewayName;
  /** Stripe's own switch, independent of `collection_aggregator` (owner decisions 1–2). */
  stripe_enabled: boolean;
  providers: Record<PaymentProvider, ProviderSetting>;
}

/**
 * The refund fee (REFUND-FLOW-PLAN R-3, § 11.6): a percentage taken off every refund paid out by
 * transfer or externally — never off a card refund. Not a routing input, so it lives on the
 * record rather than on `PaymentSettings` and `validateSettingsChange` never sees it.
 */
export const REFUND_FEE_PERCENT_DEFAULT = 2;
export const REFUND_FEE_PERCENT_MAX = 20;

/** Whether a value may be stored as `refund_fee_percent`: a finite number in [0, 20]. */
export function isValidRefundFeePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= REFUND_FEE_PERCENT_MAX;
}

/** The whole stored document, minus `_id`. */
export interface PaymentSettingsRecord extends PaymentSettings {
  /** Percent, 0–20, default 2. See `REFUND_FEE_PERCENT_DEFAULT`. */
  refund_fee_percent: number;
  /** Compare-and-set counter. 0 means "no document yet". */
  version: number;
  updated_at: Date | null;
  updated_by_id: string | null;
  updated_by_name: string | null;
  reason: string | null;
}

/**
 * What applies when there is no document: exactly today's behaviour (owner decision 8).
 * NotchPay collects and pays out, Stripe is off, MTN and ORANGE are on.
 */
export const DEFAULT_PAYMENT_SETTINGS: Readonly<PaymentSettingsRecord> = Object.freeze({
  collection_aggregator: 'NOTCHPAY',
  payout_aggregator: 'NOTCHPAY',
  stripe_enabled: false,
  providers: Object.freeze({
    MTN: Object.freeze({ enabled: true }),
    ORANGE: Object.freeze({ enabled: true }),
    MOOV: Object.freeze({ enabled: false }),
    CARD: Object.freeze({ enabled: false }),
  }),
  refund_fee_percent: REFUND_FEE_PERCENT_DEFAULT,
  version: 0,
  updated_at: null,
  updated_by_id: null,
  updated_by_name: null,
  reason: null,
});

// ── Facts ────────────────────────────────────────────────────────────────────

/** What routing needs to know about one aggregator. Built by the caller from the registry and env. */
export interface AggregatorFacts {
  /** Credentials present (today `notchPayEnabled()` / `myCoolPayEnabled()` / `stripeEnabled()`). */
  configured: boolean;
  capabilities: GatewayCapabilities;
  /** The adapter has a `createPayout` method. */
  payoutImplemented: boolean;
  /** `payoutAvailable()`: the account/host may actually send right now. */
  payoutAvailable: boolean;
}

/** `Record` so a new aggregator without facts is a compile error at the caller. */
export type RoutingFacts = Readonly<Record<PaymentGatewayName, AggregatorFacts>>;

function isGatewayName(value: string): value is PaymentGatewayName {
  return (PAYMENT_GATEWAY_NAMES as readonly string[]).includes(value);
}

// ── Collection routing ───────────────────────────────────────────────────────

export type CollectionRoute =
  | { ok: true; provider: PaymentProvider; aggregator: PaymentGatewayName; capability: ProviderCollectCapability }
  | { ok: false; provider: PaymentProvider; reason: 'PROVIDER_DISABLED' | 'NO_ROUTE' };

/**
 * Which aggregator opens a new charge for this provider, or why none can.
 *
 * 1. A disabled provider has no route.
 * 2. CARD: with Stripe on, Stripe or nothing. CARD through an aggregator is
 *    impossible while Stripe is on. With Stripe off, the collection aggregator if
 *    it declares CARD (owner decision 2).
 * 3. Mobile money: the collection aggregator, if it is configured, is not Stripe,
 *    and declares the provider.
 */
export function routeCollection(
  provider: PaymentProvider,
  settings: PaymentSettings,
  facts: RoutingFacts
): CollectionRoute {
  if (!settings.providers[provider]?.enabled) return { ok: false, provider, reason: 'PROVIDER_DISABLED' };

  const via = (aggregator: PaymentGatewayName): CollectionRoute => {
    const f = facts[aggregator];
    const capability = f?.configured ? f.capabilities.collect[provider] : undefined;
    return capability
      ? { ok: true, provider, aggregator, capability }
      : { ok: false, provider, reason: 'NO_ROUTE' };
  };

  if (provider === 'CARD' && settings.stripe_enabled) return via('STRIPE');
  if (settings.collection_aggregator === 'STRIPE') return { ok: false, provider, reason: 'NO_ROUTE' };
  return via(settings.collection_aggregator);
}

export interface EffectiveProvider {
  provider: PaymentProvider;
  aggregator: PaymentGatewayName;
  capability: ProviderCollectCapability;
}

/**
 * Every provider that routes right now, in catalogue order. The only source of
 * `/api/payments/options` and of `details.offered`. The aggregator is included for
 * internal callers; the public surface strips it.
 */
export function effectiveProviders(settings: PaymentSettings, facts: RoutingFacts): EffectiveProvider[] {
  const out: EffectiveProvider[] = [];
  for (const provider of PAYMENT_PROVIDERS) {
    const route = routeCollection(provider, settings, facts);
    if (route.ok) out.push({ provider, aggregator: route.aggregator, capability: route.capability });
  }
  return out;
}

// ── Pre-routing request checks ───────────────────────────────────────────────

export type ProviderPhoneCheck =
  | { ok: true; detected: CameroonMobileOperator | null }
  | { ok: false; detected: CameroonMobileOperator };

/**
 * Does the number belong to the provider the customer chose (owner decision 7)?
 *
 * ⚠ **The prefix alone decides.** `resolveCameroonOperator` is called with NO
 * declared operator: a declared `phoneOperator` wins inside that function, and
 * passing it here would hide exactly the mismatch this exists to catch.
 *
 * An unknown prefix (Nexttel, Camtel, a ported or foreign number) is not a
 * mismatch: the declared provider wins. CARD is never checked.
 */
export function checkProviderPhone(provider: PaymentProvider, phone: string | null | undefined): ProviderPhoneCheck {
  if (!isMobileMoneyProvider(provider)) return { ok: true, detected: null };
  const detected = resolveCameroonOperator(phone);
  if (detected === null || detected === provider) return { ok: true, detected };
  return { ok: false, detected };
}

/**
 * Required channel fields when the route (and so its capability) is not known yet.
 * Every mobile-money capability requires a number; a card requires nothing up front.
 */
export const BASELINE_REQUIRES: Readonly<Record<PaymentProviderKind, readonly CollectField[]>> = Object.freeze({
  MOBILE_MONEY: Object.freeze(['phoneNumber'] as CollectField[]),
  CARD: Object.freeze([] as CollectField[]),
});

export type ChargeRequestChannel = Partial<Record<CollectField, string | null | undefined>>;

export type ChargeRequestCheck =
  | { ok: true; detected: CameroonMobileOperator | null }
  | { ok: false; refusal: 'FIELD_MISSING'; missing: CollectField[] }
  | { ok: false; refusal: 'PHONE_MISMATCH'; provider: PaymentProvider; detected: CameroonMobileOperator };

/**
 * The no-I/O checks a charge must pass before anything is written: required
 * fields, then the provider/number mismatch.
 *
 * Separate from `routeCollection` on purpose. A door runs this FIRST, then its
 * idempotency and live-attempt reuse, and only then asks for a route. So a customer
 * who presses Pay again after an administrator switch gets their live prompt back
 * rather than a refusal. Pass the route's `capability` when it is already known;
 * otherwise the provider kind's `BASELINE_REQUIRES` applies.
 */
export function checkChargeRequest(
  provider: PaymentProvider,
  channel: ChargeRequestChannel | null | undefined,
  capability?: ProviderCollectCapability
): ChargeRequestCheck {
  const requires = capability?.requires ?? BASELINE_REQUIRES[PROVIDER_KIND[provider]];
  const missing = requires.filter((field) => !(channel?.[field] ?? '').toString().trim());
  if (missing.length > 0) return { ok: false, refusal: 'FIELD_MISSING', missing };

  const phone = checkProviderPhone(provider, channel?.phoneNumber);
  if (!phone.ok) return { ok: false, refusal: 'PHONE_MISMATCH', provider, detected: phone.detected };
  return { ok: true, detected: phone.detected };
}

export type AmountLimitCheck = { ok: true } | { ok: false; min: number; max: number };

/**
 * Is the amount inside what the route's aggregator accepts for this provider?
 *
 * Needs the ROUTE (an aggregator's limit, not a provider's), so it runs where the route is known,
 * still before any write. A capability with no `limits` accepts anything, which keeps every
 * aggregator that declares none exactly as it was.
 */
export function checkAmountLimits(capability: ProviderCollectCapability, amount: number): AmountLimitCheck {
  const limits = capability.limits;
  if (!limits) return { ok: true };
  if (Number.isFinite(amount) && amount >= limits.min && amount <= limits.max) return { ok: true };
  return { ok: false, min: limits.min, max: limits.max };
}

// ── Legacy bodies ────────────────────────────────────────────────────────────

export interface ProviderDerivationInput {
  provider?: string | null;
  /** Deprecated and otherwise ignored (owner decision 4). Read here for one purpose only. */
  gateway?: string | null;
  channel?: { phoneOperator?: string | null; phoneNumber?: string | null } | null;
}

/**
 * The provider a request means, for bodies from apps that predate `provider`.
 *
 * Order: an explicit valid `provider`; then `gateway === 'STRIPE'` → CARD; then
 * `channel.phoneOperator`; then the number's prefix. Null means the caller answers
 * `400 PAYMENT_PROVIDER_REQUIRED`.
 *
 * ⚠ **STRIPE comes before the number.** An old STRIPE body means card intent. With
 * cards off it must reach `PAYMENT_PROVIDER_UNAVAILABLE`, never a mobile-money
 * push to whatever phone happens to be in the body.
 */
export function deriveProvider(input: ProviderDerivationInput): PaymentProvider | null {
  if (input.provider != null && input.provider !== '') {
    return isPaymentProvider(input.provider) ? input.provider : null;
  }
  if (input.gateway === 'STRIPE') return 'CARD';

  const operator = (input.channel?.phoneOperator ?? '').toUpperCase();
  if (operator === 'MTN' || operator === 'ORANGE' || operator === 'MOOV') return operator;

  return resolveCameroonOperator(input.channel?.phoneNumber);
}

// ── Settings validation ──────────────────────────────────────────────────────

export type SettingsIssueCode =
  // hard: the write is refused
  | 'COLLECTION_AGGREGATOR_UNKNOWN'
  | 'COLLECTION_AGGREGATOR_IS_STRIPE'
  | 'COLLECTION_AGGREGATOR_NOT_CONFIGURED'
  | 'COLLECTION_AGGREGATOR_NO_ENABLED_PROVIDER'
  | 'STRIPE_NOT_CONFIGURED'
  | 'PAYOUT_AGGREGATOR_UNKNOWN'
  | 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED'
  | 'PROVIDER_UNKNOWN'
  // soft: the write is accepted and these are returned
  | 'PROVIDER_UNROUTABLE'
  | 'CARD_UNROUTABLE'
  | 'PAYOUT_UNAVAILABLE'
  | 'NO_MOBILE_PROVIDER_ENABLED';

export interface SettingsIssue {
  code: SettingsIssueCode;
  /** English, operator-facing. */
  message: string;
  provider?: PaymentProvider;
  aggregator?: string;
}

/** A merged candidate (current document + patch), before it is known to be valid. */
export interface PaymentSettingsCandidate {
  collection_aggregator: string;
  payout_aggregator: string;
  stripe_enabled: boolean;
  providers: Readonly<Record<string, ProviderSetting | undefined>>;
}

export type SettingsValidation =
  | { ok: true; settings: PaymentSettings; warnings: SettingsIssue[] }
  | { ok: false; errors: SettingsIssue[] };

/**
 * Validate a settings write (ADR-A08 D-3, D-4).
 *
 * Hard errors refuse the write (`PAYMENT_SETTINGS_INVALID`, `details.errors`).
 * Soft warnings accept it: an enabled provider that the new route cannot serve
 * simply drops out of `/options`, so an emergency switch is never blocked by it.
 *
 * `current` is the stored state before the write (the defaults if none). It is
 * read for one rule: turning Stripe ON without credentials is refused, but
 * leaving an already-on Stripe unconfigured is not, because otherwise any change
 * (including the emergency one) would be blocked by a Stripe nobody is touching.
 *
 * A known provider missing from `candidate.providers` is treated as disabled.
 */
export function validateSettingsChange(
  candidate: PaymentSettingsCandidate,
  current: PaymentSettings,
  facts: RoutingFacts
): SettingsValidation {
  const errors: SettingsIssue[] = [];

  for (const key of Object.keys(candidate.providers)) {
    if (!isPaymentProvider(key)) {
      errors.push({ code: 'PROVIDER_UNKNOWN', message: `Unknown payment provider "${key}"` });
    }
  }

  const providers = {} as Record<PaymentProvider, ProviderSetting>;
  for (const p of PAYMENT_PROVIDERS) providers[p] = { enabled: candidate.providers[p]?.enabled === true };
  const enabledMobile = PAYMENT_PROVIDERS.filter((p) => isMobileMoneyProvider(p) && providers[p].enabled);

  const collection = candidate.collection_aggregator;
  if (!isGatewayName(collection)) {
    errors.push({
      code: 'COLLECTION_AGGREGATOR_UNKNOWN',
      message: `Unknown collection aggregator "${collection}"`,
      aggregator: collection,
    });
  } else if (collection === 'STRIPE') {
    errors.push({
      code: 'COLLECTION_AGGREGATOR_IS_STRIPE',
      message: 'Stripe cannot be the collection aggregator; it has its own switch',
      aggregator: collection,
    });
  } else if (!facts[collection].configured) {
    errors.push({
      code: 'COLLECTION_AGGREGATOR_NOT_CONFIGURED',
      message: `${collection} has no credentials on this deployment`,
      aggregator: collection,
    });
  } else if (
    enabledMobile.length > 0 &&
    !enabledMobile.some((p) => facts[collection].capabilities.collect[p] !== undefined)
  ) {
    errors.push({
      code: 'COLLECTION_AGGREGATOR_NO_ENABLED_PROVIDER',
      message: `${collection} cannot collect any of the enabled mobile providers (${enabledMobile.join(', ')})`,
      aggregator: collection,
    });
  }

  if (candidate.stripe_enabled && !current.stripe_enabled && !facts.STRIPE.configured) {
    errors.push({
      code: 'STRIPE_NOT_CONFIGURED',
      message: 'Stripe cannot be turned on: it has no credentials on this deployment',
      aggregator: 'STRIPE',
    });
  }

  const payout = candidate.payout_aggregator;
  if (!isGatewayName(payout)) {
    errors.push({ code: 'PAYOUT_AGGREGATOR_UNKNOWN', message: `Unknown payout aggregator "${payout}"`, aggregator: payout });
  } else if (!facts[payout].payoutImplemented) {
    errors.push({
      code: 'PAYOUT_AGGREGATOR_NOT_IMPLEMENTED',
      message: `${payout} cannot send payouts`,
      aggregator: payout,
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const settings: PaymentSettings = {
    collection_aggregator: collection as PaymentGatewayName,
    payout_aggregator: payout as PaymentGatewayName,
    stripe_enabled: candidate.stripe_enabled,
    providers,
  };

  const warnings: SettingsIssue[] = [];
  for (const p of enabledMobile) {
    if (!routeCollection(p, settings, facts).ok) {
      warnings.push({
        code: 'PROVIDER_UNROUTABLE',
        message: `${p} is enabled but ${settings.collection_aggregator} cannot collect it; it will not be offered`,
        provider: p,
        aggregator: settings.collection_aggregator,
      });
    }
  }
  if (providers.CARD.enabled && !routeCollection('CARD', settings, facts).ok) {
    warnings.push({
      code: 'CARD_UNROUTABLE',
      message: settings.stripe_enabled
        ? 'CARD is enabled but Stripe has no credentials; cards will not be offered'
        : `CARD is enabled but Stripe is off and ${settings.collection_aggregator} cannot take cards; cards will not be offered`,
      provider: 'CARD',
    });
  }
  if (!facts[settings.payout_aggregator].payoutAvailable) {
    warnings.push({
      code: 'PAYOUT_UNAVAILABLE',
      message: `${settings.payout_aggregator} cannot send payouts on this account right now (switched off, or the host is not allowlisted)`,
      aggregator: settings.payout_aggregator,
    });
  }
  if (enabledMobile.length === 0) {
    warnings.push({ code: 'NO_MOBILE_PROVIDER_ENABLED', message: 'No mobile money will be offered' });
  }

  return { ok: true, settings, warnings };
}
