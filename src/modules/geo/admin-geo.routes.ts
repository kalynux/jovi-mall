import { Router, RequestHandler } from 'express';
import { GeoController } from './controllers/geo.controller';

/**
 * `/api/internal/admin/geo` — address search and reverse geocoding for the wi-admin service.
 *
 * ── Why this mount exists at all ─────────────────────────────────────────────
 * The public `/api/geo` router is guarded by `requireAuth`, which resolves a `users` row. An
 * administrator has none — they live in a separate database and hold no platform identity, by
 * the decision the whole admin architecture rests on (ADR-004 D-1). So the existing geocoder
 * was reachable by every role on the platform EXCEPT the one staffing it, and wi-admin could
 * not offer an address field of any kind.
 *
 * The alternative was giving wi-admin its own geocoding provider and key. Rejected for the
 * reason `CLAUDE.md` states about the Geoapify/LocationIQ keys: a second spender on one
 * free-tier quota, with nothing anywhere adding the two together, so a burst on one side
 * exhausts the allowance the other depends on and the symptom lands in a different service
 * from the cause. One geocoder, one chain, one quota.
 *
 * ── The handlers are the PUBLIC ones, mounted unchanged ──────────────────────
 * `GeoController.search` and `.reverse` are the same two functions `/api/geo` serves, not
 * copies and not variants. They read nothing off `req.auth` — geocoding is a provider call
 * with no subject — so there is nothing for the synthetic admin actor to satisfy, and a
 * second implementation would be a second place for the provider chain, the language handling
 * and the candidate shape to drift.
 *
 * ── This is a READ of a third party, not of platform data ────────────────────
 * Worth stating because `SERVICE_ROUTE_ALLOWLIST` on the wi-admin side draws its bound at
 * "a service route may never read platform data". Nothing here touches this database: the
 * query is free text the administrator typed and the answer comes from Geoapify, LocationIQ
 * or Nominatim. There is no subject to grade and therefore no tier logic missing.
 *
 * ⚠ **It spends the shared quota.** Every call here is a call jovi-mall's checkout geocoding
 * does not get to make. Address entry on the admin surface is rare — a staff member types
 * their home address once — so this is a rounding error today; if a bulk address tool ever
 * lands on that dashboard, this mount is where its cost shows up. See `docs/RUNBOOK.md`
 * § "Shared configuration that is not a secret — routing / geocoding providers".
 */
export function buildAdminGeoRouter(guards: RequestHandler[] = []): Router {
    const router = Router();
    if (guards.length > 0) router.use(...guards);

    /** GET /search?q=&limit=&country=&lang= — free-form text to ranked candidates. */
    router.get('/search', GeoController.search);

    /** GET /reverse?lat=&lng= — a coordinate to its best-matching address, or null. */
    router.get('/reverse', GeoController.reverse);

    return router;
}
