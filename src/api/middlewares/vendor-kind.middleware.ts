import { Request, Response, NextFunction, RequestHandler } from 'express';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { VendorKind, vendorKindOf } from '../../modules/vendors/domain/vendor-kind';

/**
 * `requireVendorKind` — which vendor KIND a vendor route serves (SERVICE-LISTINGS-PLAN § C-1).
 *
 * ⛔ **Every router that admits a vendor declares one, and `test:service-listings` refuses a
 * vendor router that does not** — the same way wi-admin's `test:authz` refuses a raw
 * `router.get(`. Without the scan, the first seller feature somebody adds next year is open
 * to providers (orders, payouts, a store page that publishes contacts), and nothing fails.
 *
 *   'seller'   — catalog, orders, stock, bookings, earnings, store, agency links, analytics …
 *   'provider' — listings, leads, listing settings
 *   'both'     — profile, billing, files, transactions, KYC, tickets, notifications. A
 *                DECLARATION, not a check: it always passes. It exists so the scan can tell
 *                "decided: shared" apart from "nobody thought about it".
 *
 * Reads `req.auth.role_entity`, which `requireAuth` already loaded — no query. A vendor with
 * no `kind` is a seller (`vendorKindOf`), so every vendor registered before 2026-10-19 passes
 * the seller routes exactly as before. Mount AFTER `requireAuth` + `requireRole(['vendor'])`.
 *
 * ⚠ **Never `router.use(requireVendorKind('seller'|'provider'))` in a router mounted at bare
 * `/vendor`** (`vendor/routes.ts`, `vendor-billing.routes.ts`, `vendor-earnings.routes.ts`).
 * A sub-router's `use` runs for every request that ENTERS it, matched or not, and the later
 * `/vendor/*` mounts are entered through it — a seller guard in the earnings router would
 * lock providers out of `/vendor/tickets` and `/vendor/kyc`. Those three declare per route;
 * the scan enforces it.
 *
 * Refusal: `403 AUTH_VENDOR_KIND_FORBIDDEN`, `details: { required }` (a 403's `details` are
 * allowlisted to `required` / `requiredAny` / `resource` / `hint`).
 */
export function requireVendorKind(kind: VendorKind | 'both'): RequestHandler {
  if (kind === 'both') {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    // Read through a local shape rather than the global `Request.auth` augmentation, which
    // lives in auth.middleware.ts and is only in scope where that module was loaded first —
    // not in a DB-free suite that imports this guard alone.
    const auth = (req as Request & { auth?: { role?: string; role_entity?: unknown } }).auth;
    if (!auth?.role) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }
    // Not a vendor session at all — `requireRole` decides that, not this guard. Passing
    // keeps the two guards answering one question each.
    if (auth.role !== 'vendor') return next();
    if (vendorKindOf(auth.role_entity as { kind?: unknown } | null) !== kind) {
      return next(
        createAppError(
          ERROR_CODES.AUTH_VENDOR_KIND_FORBIDDEN,
          403,
          kind === 'seller'
            ? 'This feature is for sellers. Service providers manage listings instead.'
            : 'This feature is for service providers.',
          { required: kind },
        ),
      );
    }
    return next();
  };
}
