/**
 * The vendor kind (SERVICE-LISTINGS-PLAN L-1, § C-1) — the ONE place that says what a missing
 * value means.
 *
 * Every vendor registered before 2026-10-19 has no `kind` and is a seller; there is no
 * backfill. So:
 *   - READ a kind through `vendorKindOf()`, never `vendor.kind === 'seller'`;
 *   - QUERY sellers with `SELLER_VENDOR_FILTER` (`{ kind: { $ne: 'provider' } }`), never
 *     `{ kind: 'seller' }`, which matches none of the existing ones.
 *
 * Imports only the listings vocabulary (which itself imports nothing), so the model, the
 * middleware, the auth service and the tests can share it without a cycle.
 */
import { DEFAULT_LISTING_SETTINGS } from '../../listings/domain/listing.types';
import { DEFAULT_DIAL_COUNTRY, dialCountryOfNumber } from '../../../core/validation/dial-codes';

export const VENDOR_KINDS = ['seller', 'provider'] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export function isVendorKind(value: unknown): value is VendorKind {
  return typeof value === 'string' && (VENDOR_KINDS as readonly string[]).includes(value);
}

/** The kind of a vendor document (or anything shaped like one). Missing / unknown → `'seller'`. */
export function vendorKindOf(doc: { kind?: unknown } | null | undefined): VendorKind {
  return doc?.kind === 'provider' ? 'provider' : 'seller';
}

export function isProviderVendor(doc: { kind?: unknown } | null | undefined): boolean {
  return vendorKindOf(doc) === 'provider';
}

/**
 * The `vendorKind` an auth response carries beside `role_entity` (§ C-1): the kind for a vendor
 * session, `null` for every other role. The dashboards branch on this, not on the token —
 * a cookie client cannot read an httpOnly token, and every response that issues one carries it.
 */
export function vendorKindForRole(role: string | undefined, roleEntity: unknown): VendorKind | null {
  return role === 'vendor' ? vendorKindOf(roleEntity as { kind?: unknown } | null) : null;
}

/**
 * The fields a NEW vendor row is created with, per kind — the only place registration and
 * add-role learn what a provider starts with.
 *
 * A provider starts at `onboarding_step: 0` (COMPLETED): the seller checklist is payouts,
 * delivery agencies, branding and return/cancellation policies, and a provider has none of
 * those (L-2). Their profile completion is judged by their listings, not by that checklist.
 * The kind is written explicitly for sellers too, so a row created from today on is never
 * ambiguous; only pre-2026-10-19 rows lack it.
 */
export function newVendorKindFields(kind: VendorKind, signUpPhone?: string | null): Record<string, unknown> {
  return kind === 'provider'
    ? {
      kind: 'provider',
      onboarding_step: 0,
      listing_settings: { ...DEFAULT_LISTING_SETTINGS },
      country: providerCountryOf(signUpPhone),
    }
    : { kind: 'seller' };
}

/**
 * A PROVIDER's country, set at registration (2026-11-08). A seller chooses it in onboarding
 * Step 1; a provider starts with onboarding complete and never sees that step, so without this
 * their country stayed null for good. It is the sign-up phone's country, by the platform's own
 * dial-code table (`+237…` → `CM`), with Cameroon when the number matches nothing. Country is
 * set-once (`assertCountryUnchangedOrFirstSet`), so this is the value the provider keeps.
 */
export function providerCountryOf(signUpPhone: string | null | undefined): string {
  return dialCountryOfNumber(signUpPhone) ?? DEFAULT_DIAL_COUNTRY;
}

/** Mongo filter for sellers that is correct for vendors with no `kind` at all. */
export const SELLER_VENDOR_FILTER = Object.freeze({ kind: { $ne: 'provider' } });

/** Mongo filter for providers (they always carry the field — it is written at registration). */
export const PROVIDER_VENDOR_FILTER = Object.freeze({ kind: 'provider' });
