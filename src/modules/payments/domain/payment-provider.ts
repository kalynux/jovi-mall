/**
 * Payment providers: what the CUSTOMER holds (ADR-A08 D-1).
 *
 * ── TWO LAYERS, AND THIS IS THE FIRST ────────────────────────────────────────
 * A provider is what a customer pays with: an MTN wallet, an Orange wallet, a
 * card. An aggregator (`PaymentGatewayName`: NotchPay, My-CoolPay, Stripe) is
 * who the backend calls to move that money. Clients choose a provider and never
 * an aggregator; an administrator chooses the aggregator at runtime
 * (`payment-routing.ts`). Keeping the two apart is what lets the platform leave a
 * failing aggregator without shipping a new app.
 *
 * ── ⚠ NOT THE SAVED-METHOD `provider` ────────────────────────────────────────
 * `user_payment_methods.provider` and the bot's saved wallets already carry a
 * field named `provider`, with lowercase values (`mtn_momo`, `orange_money`,
 * `stripe`…). That is a different vocabulary and it is deliberately not renamed.
 * `providerForSavedWallet` below is the only bridge; never compare the two
 * strings by hand.
 *
 * Pure: no I/O, no configuration.
 */

/** Every provider, in the order `/api/payments/options` lists them. */
export const PAYMENT_PROVIDERS = ['MTN', 'ORANGE', 'MOOV', 'CARD'] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export type PaymentProviderKind = 'MOBILE_MONEY' | 'CARD';

/** `Record` so a fifth provider without a kind is a compile error. */
export const PROVIDER_KIND: Readonly<Record<PaymentProvider, PaymentProviderKind>> = Object.freeze({
  MTN: 'MOBILE_MONEY',
  ORANGE: 'MOBILE_MONEY',
  MOOV: 'MOBILE_MONEY',
  CARD: 'CARD',
});

export type MobileMoneyProvider = Exclude<PaymentProvider, 'CARD'>;

export function isPaymentProvider(value: unknown): value is PaymentProvider {
  return typeof value === 'string' && (PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export function isMobileMoneyProvider(provider: PaymentProvider): provider is MobileMoneyProvider {
  return PROVIDER_KIND[provider] === 'MOBILE_MONEY';
}

/**
 * The saved-wallet values that name a mobile-money provider, and which one.
 *
 * Only these three. `stripe`, `notchpay` and `mycoolpay` also appear as saved
 * `provider` values, but they name an AGGREGATOR, not what the customer holds,
 * so they map to nothing and the caller decides.
 */
export const SAVED_WALLET_PROVIDER: Readonly<Record<string, MobileMoneyProvider>> = Object.freeze({
  mtn_momo: 'MTN',
  orange_money: 'ORANGE',
  moov_money: 'MOOV',
});

/**
 * Map a saved payment method's lowercase `provider` to a charge provider.
 *
 * Returns null for anything that is not one of the three mobile wallets. The
 * stored value is never rewritten; this is a read-time translation.
 */
export function providerForSavedWallet(saved: string | null | undefined): MobileMoneyProvider | null {
  if (!saved) return null;
  const key = saved.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SAVED_WALLET_PROVIDER, key) ? SAVED_WALLET_PROVIDER[key] : null;
}
