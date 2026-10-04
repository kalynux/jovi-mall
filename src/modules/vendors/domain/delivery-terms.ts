import { z } from 'zod';

/**
 * Shop delivery terms — who pays the delivery fee for this shop's part of a basket
 * (ADR-A11, owner decisions D-1 · D-2 · D-6, 2026-10-03).
 *
 * PURE: no I/O, no clock, no Mongoose. The stored shape lives on
 * `vendor_settings.delivery_terms` (snake_case, absent until the vendor sets it);
 * everything that reads it goes through `vendorDeliveryTermsOf()` so the default is
 * applied in exactly one place.
 *
 * Free delivery is a SHOP setting, never a product flag (D-1) — the product
 * `free_delivery` flag was removed in the same change. The default for every shop is
 * `always` (D-2): the shop pays, which is the platform's behaviour before
 * customer-paid delivery existed, so a shop that never opens the setting changes
 * nothing.
 */

export type VendorDeliveryTermsMode = 'always' | 'never' | 'above';

export const VENDOR_DELIVERY_TERMS_MODES: readonly VendorDeliveryTermsMode[] = Object.freeze([
  'always',
  'never',
  'above',
]) as readonly VendorDeliveryTermsMode[];

/** Upper bound on `freeAboveAmount` (XAF) — the same ceiling the COD terms use. */
export const FREE_ABOVE_AMOUNT_MAX = 100_000_000;

/** The wire/domain shape (camelCase). `freeAboveAmount` is non-null iff `mode === 'above'`. */
export interface VendorDeliveryTerms {
  mode: VendorDeliveryTermsMode;
  freeAboveAmount: number | null;
}

export const DEFAULT_VENDOR_DELIVERY_TERMS: VendorDeliveryTerms = Object.freeze({
  mode: 'always' as const,
  freeAboveAmount: null,
});

/**
 * Read stored terms (snake_case, possibly absent) with the default applied.
 *
 * Defensive on a malformed row: an unknown mode reads as the default, and an `above`
 * with no usable threshold reads as `always` — the shop-pays reading, never one that
 * starts charging a customer on the strength of a value nobody set.
 */
export function vendorDeliveryTermsOf(
  stored: { mode?: string | null; free_above_amount?: number | null } | null | undefined
): VendorDeliveryTerms {
  const mode = stored?.mode;
  if (mode === 'never') return { mode: 'never', freeAboveAmount: null };
  if (mode === 'above') {
    const amount = stored?.free_above_amount;
    if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 1) {
      return { mode: 'above', freeAboveAmount: Math.floor(amount) };
    }
    return { ...DEFAULT_VENDOR_DELIVERY_TERMS };
  }
  return { ...DEFAULT_VENDOR_DELIVERY_TERMS };
}

/**
 * Why a shop part's delivery is paid by whom. `cap_fallback` is NOT produced here — it
 * is applied by checkout when a vendor-paid part fails the ADR-A07 30% cost cap (D-6),
 * and lives in this union so every consumer shares one vocabulary.
 */
export type DeliveryPayerReason =
  | 'shop_always'
  | 'shop_never'
  | 'shop_threshold_met'
  | 'threshold_not_met'
  | 'cap_fallback';

export type DeliveryPayer = 'vendor' | 'customer';

export interface DeliveryPayerVerdict {
  payer: DeliveryPayer;
  reason: DeliveryPayerReason;
  /** How much more of this shop's items would make delivery free; null when n/a. */
  freeDeliveryShortfall: number | null;
}

/**
 * Who pays delivery for one shop's part of a basket.
 *
 * `shopSubtotal` is that vendor order's items subtotal at the (negotiated) unit prices,
 * before any delivery. The threshold is INCLUSIVE: a subtotal equal to
 * `freeAboveAmount` is free.
 */
export function resolveDeliveryPayer(terms: VendorDeliveryTerms, shopSubtotal: number): DeliveryPayerVerdict {
  switch (terms.mode) {
    case 'never':
      return { payer: 'customer', reason: 'shop_never', freeDeliveryShortfall: null };
    case 'above': {
      const threshold = terms.freeAboveAmount;
      if (threshold === null) {
        // Unreachable through vendorDeliveryTermsOf(); a hand-built value reads as the default.
        return { payer: 'vendor', reason: 'shop_always', freeDeliveryShortfall: null };
      }
      const subtotal = Number.isFinite(shopSubtotal) ? shopSubtotal : 0;
      if (subtotal >= threshold) {
        return { payer: 'vendor', reason: 'shop_threshold_met', freeDeliveryShortfall: null };
      }
      return { payer: 'customer', reason: 'threshold_not_met', freeDeliveryShortfall: threshold - subtotal };
    }
    case 'always':
    default:
      return { payer: 'vendor', reason: 'shop_always', freeDeliveryShortfall: null };
  }
}

/** Storefront shorthand: does this shop ALWAYS deliver free? (the derived product `freeDelivery`). */
export function isAlwaysFreeDelivery(terms: VendorDeliveryTerms): boolean {
  return terms.mode === 'always';
}

/**
 * `PUT /api/vendor/profile/delivery-terms` body — a full replace, `.strict()` so a
 * misspelt key is a 400 rather than a silently ignored term. `freeAboveAmount` is
 * required with `mode: 'above'` and must be null/absent otherwise (a threshold on a
 * mode that ignores it would be a stored lie about what the shop charges).
 *
 * Lives here rather than inline in the controller so it is testable without importing
 * a controller (and with it the whole module graph).
 */
export const SetDeliveryTermsSchema = z
  .object({
    mode: z.enum(['always', 'never', 'above']),
    freeAboveAmount: z.number().int().min(1).max(FREE_ABOVE_AMOUNT_MAX).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const amount = value.freeAboveAmount ?? null;
    if (value.mode === 'above' && amount === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeAboveAmount'],
        message: "freeAboveAmount is required when mode is 'above'",
      });
    }
    if (value.mode !== 'above' && amount !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freeAboveAmount'],
        message: "freeAboveAmount must be null unless mode is 'above'",
      });
    }
  });

export type SetDeliveryTermsInput = z.infer<typeof SetDeliveryTermsSchema>;
