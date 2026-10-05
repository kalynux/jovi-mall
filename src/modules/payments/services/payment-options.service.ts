import { CollectField, CollectFlow } from '../gateways/gateway.interface';
import { PaymentProvider, PaymentProviderKind, PROVIDER_KIND } from '../domain/payment-provider';
import {
  EffectiveProvider,
  PaymentSettings,
  RoutingFacts,
  effectiveProviders,
} from '../domain/payment-routing';

/**
 * `GET /api/payments/options`: which payment methods a client may offer right now (ADR-A08).
 *
 * Contract: `api-doc/payments/routing.md` § GET /api/payments/options.
 *
 * ── ⛔ THIS IS THE ONE SURFACE THAT NEVER NAMES AN AGGREGATOR ─────────────────
 * `effectiveProviders` returns the aggregator beside each provider, because internal callers
 * need it. This service projects it away: every entry is built field by field, never spread.
 * A spread would publish whatever `EffectiveProvider` or a capability gains next, and the first
 * thing it would publish is the aggregator's name, which is exactly what lets a client start
 * branching on it again. `test:payment-options` serialises every scenario and scans for one.
 *
 * ── INPUTS ARE INJECTED ──────────────────────────────────────────────────────
 * Settings and per-aggregator facts arrive as getters, so the whole projection runs in a test
 * with fixtures and no database, registry or environment. The route mount supplies the live
 * getters from the settings and routing services.
 *
 * ── THE 5-SECOND CACHE ──────────────────────────────────────────────────────
 * The answer is recomputed at most once per window per process. That matches the settings
 * service's own refresh window, so an administrator's switch shows here within the same
 * convergence the rest of the platform reports. The HTTP response is `no-store` regardless:
 * the cache is ours, and a client must never hold a copy longer than one request.
 */

export interface PaymentOptionEntry {
  provider: PaymentProvider;
  kind: PaymentProviderKind;
  flow: CollectFlow;
  /** The `channel` fields the charge requires: the route capability's `requires`. */
  fields: CollectField[];
  /** True exactly when `flow` is `OTP`. */
  mayRequireOtp: boolean;
  /** Only on a `CARD_ELEMENT` entry. Never an `sk_`/`rk_` key (see `stripePublishableKey`). */
  publishableKey?: string;
  /**
   * Only on a `CODE_FIRST` entry: what the customer dials to get the payment code that must be
   * sent as `channel.paymentCode` WITH the charge (NovaSend Orange Money).
   */
  codeUssd?: string;
  /** Only when the route declares one: the amounts it accepts, in XAF. Outside → `422 PAYMENT_AMOUNT_OUT_OF_RANGE`. */
  limits?: { min: number; max: number };
}

export interface PaymentOptions {
  providers: PaymentOptionEntry[];
}

/**
 * The pure projection. Exported so the test can assert it without a clock.
 *
 * ⚠ **A `CARD_ELEMENT` route with no publishable key is DROPPED, not listed without one.** The
 * client needs the key to mount Stripe.js, so an entry without it is a Pay button that can never
 * work. The only ways to get here are an absent `STRIPE_PUBLISHABLE_KEY` or a secret key in that
 * slot, which `stripePublishableKey()` refuses and logs. Dropping it keeps the guarantee that
 * every listed provider can actually be paid with.
 */
export function buildPaymentOptions(
  effective: readonly EffectiveProvider[],
  publishableKey: string | null
): PaymentOptions {
  const providers: PaymentOptionEntry[] = [];

  for (const route of effective) {
    const flow = route.capability.flow;
    const entry: PaymentOptionEntry = {
      provider: route.provider,
      kind: PROVIDER_KIND[route.provider],
      flow,
      fields: [...route.capability.requires],
      mayRequireOtp: flow === 'OTP',
    };

    if (flow === 'CARD_ELEMENT') {
      if (!publishableKey) continue;
      entry.publishableKey = publishableKey;
    }
    // Projected field by field (see the header): a capability field is never spread onto the wire.
    if (flow === 'CODE_FIRST' && route.capability.codeUssd) entry.codeUssd = route.capability.codeUssd;
    if (route.capability.limits) {
      entry.limits = { min: route.capability.limits.min, max: route.capability.limits.max };
    }

    providers.push(entry);
  }

  return { providers };
}

export interface PaymentOptionsDeps {
  settings: () => PaymentSettings;
  facts: () => RoutingFacts;
  /** The Stripe publishable key, already guarded (see `stripePublishableKey`). */
  publishableKey: () => string | null;
  /** Injected for tests. */
  now?: () => number;
  cacheTtlMs?: number;
}

export const PAYMENT_OPTIONS_CACHE_TTL_MS = 5_000;

export class PaymentOptionsService {
  private cached: { value: PaymentOptions; expiresAt: number } | null = null;

  constructor(private readonly deps: PaymentOptionsDeps) {}

  get(): PaymentOptions {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now < this.cached.expiresAt) return this.cached.value;

    const effective = effectiveProviders(this.deps.settings(), this.deps.facts());
    const value = buildPaymentOptions(effective, this.deps.publishableKey());
    this.cached = { value, expiresAt: now + (this.deps.cacheTtlMs ?? PAYMENT_OPTIONS_CACHE_TTL_MS) };
    return value;
  }
}
