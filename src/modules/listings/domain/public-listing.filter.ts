/**
 * What "publishable" means for a listing, in ONE place (SERVICE-LISTINGS-PLAN § C-3).
 *
 * `/api/public/*` has no auth guard anywhere above or below it, so this predicate is the
 * whole access-control story for listings on the storefront and for the bot's freshness gate
 * (`/public/listings/by-ids`). Every public read applies it — the list, the by-ids hydration
 * and the detail — so a listing can never show in the grid and 404 on its own page. Same
 * argument, and same shape, as `catalog/domain/services/public-catalog.filter.ts`.
 *
 * ── The conditions ───────────────────────────────────────────────────────────
 *
 *   status: 'live'          approved, funded and not taken down. `suspended` (any reason),
 *                           `archived`, and every never-approved status are out.
 *   published: { $ne: null } what customers see exists. `live` implies it; this is the
 *                           belt-and-braces against a row whose status and content disagree.
 *   suspension: null        the same belt for a `live` row still carrying a suspension.
 *   vendor not `inactive`   `!== 'inactive'`, NEVER `=== 'active'` — `pending_verification`
 *                           is the registration default (the storefront filter's long note).
 *   vendor kind 'provider'  a listing belongs to a provider; a seller row can never own one,
 *                           but the join costs nothing to say so.
 *
 * The vendor half lives on another collection, so it is a `$match` fragment applied after the
 * `$lookup` every public pipeline performs (joined field named `vendor`).
 */
import { PROVIDER_VENDOR_FILTER } from '../../vendors/domain/vendor-kind';

/** The listing half, as a fresh filter object on every call (callers add their own keys). */
export function publishableListingFilter(): Record<string, unknown> {
  return {
    status: 'live',
    published: { $ne: null },
    suspension: null,
  };
}

/** The vendor half, applied after `$lookup` → `vendor`. */
export const LISTING_VENDOR_PUBLISHABLE_MATCH = Object.freeze({
  'vendor.status': { $ne: 'inactive' },
  'vendor.kind': PROVIDER_VENDOR_FILTER.kind,
});

/** The vendor fields a public pipeline may project — status and kind, nothing that identifies. */
export const LISTING_VENDOR_LOOKUP_PROJECTION = Object.freeze({ status: 1, kind: 1 });
