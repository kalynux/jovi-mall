import Stripe from 'stripe';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * Shared Stripe SDK client + money/FX helpers.
 *
 * The WiMall Stripe account is Canadian and settles in USD, so every Stripe
 * charge is created in `STRIPE_CHARGE_CURRENCY` (default `usd`). The catalog is
 * priced in XAF, so we convert XAF → USD at charge time using a fixed
 * configurable rate (`STRIPE_XAF_PER_USD`). Centralising the conversion here
 * keeps charges and refunds on the identical rate.
 */

let client: Stripe | null = null;

/** Lazily-initialised Stripe client singleton. Throws if the key is missing. */
export function getStripeClient(): Stripe {
  if (client) return client;

  const key = process.env.STRIPE_SECRET_KEY;
  console.log({key});
  if (!key) {
    throw createAppError(
      ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED,
      503,
      'Stripe is not configured. Set STRIPE_SECRET_KEY in the environment.'
    );
  }

  // apiVersion is intentionally omitted: the SDK pins it to the account's
  // default. The integration only reads version-stable fields (id, status,
  // amount, currency, metadata).
  client = new Stripe(key);
  return client;
}

/**
 * Currencies Stripe treats as zero-decimal: the `amount` is the value itself,
 * with no multiplication by 100. (Subset of https://stripe.com/docs/currencies)
 */
const ZERO_DECIMAL_CURRENCIES = new Set<string>([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/** Convert a major-unit amount to Stripe's minor unit for the given currency. */
export function toMinorUnit(amount: number, currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return Math.round(amount);
  return Math.round(amount * 100);
}

/** Convert a Stripe minor-unit amount back to its major unit. */
export function fromMinorUnit(amount: number, currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return amount;
  return amount / 100;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Configured XAF-per-USD rate (how many XAF equal 1 USD). */
export function xafPerUsd(): number {
  const rate = Number(process.env.STRIPE_XAF_PER_USD || '600');
  return Number.isFinite(rate) && rate > 0 ? rate : 600;
}

/** The presentment currency Stripe charges in (default `usd`). */
export function stripeChargeCurrency(): string {
  return (process.env.STRIPE_CHARGE_CURRENCY || 'usd').toLowerCase();
}

/** Convert an XAF amount to USD using the fixed configured rate. */
export function xafToUsd(xaf: number): number {
  return round2(xaf / xafPerUsd());
}

/**
 * Resolve a catalog amount (typically XAF) into a Stripe charge in the account's
 * presentment currency, returned as ready-to-send minor units.
 *
 * - If the charge currency is USD and the source is XAF, convert via the fixed rate.
 * - If the source already matches the charge currency, pass it through unchanged.
 */
export function toStripeCharge(
  amount: number,
  sourceCurrency: string
): { amount: number; currency: string } {
  const charge = stripeChargeCurrency();
  const source = (sourceCurrency || 'xaf').toLowerCase();

  if (source === charge) {
    return { amount: toMinorUnit(amount, charge), currency: charge };
  }

  if (charge === 'usd' && source === 'xaf') {
    return { amount: toMinorUnit(xafToUsd(amount), 'usd'), currency: 'usd' };
  }

  // Fallback: charge in the source currency as-is rather than silently mis-converting.
  return { amount: toMinorUnit(amount, source), currency: source };
}
