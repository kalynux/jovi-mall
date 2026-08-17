# ADR-A04 — Cache the geocoding, then rent it

**Date:** 2026-08-18 (evidence gathered 2026-08-17)
**Status:** Accepted — decided; implemented in Phase 6.H
**Scope:** jovi-mall
**Answers:** [Q-8](../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md#q-8--does-the-platform-own-its-geocoding-or-rent-it)
of the Phase D register

---

## Context

- `GEO_PROVIDER` accepts `nominatim | google | mapbox | here | geoapify`. **Only Nominatim has an
  adapter**; the factory throws `GEO_PROVIDER_NOT_CONFIGURED` for the other four
  (`core/geocoding/geocoding.factory.ts:41-49`) and `config/env.ts:405` reports it **at boot**
  rather than letting it surface on a customer's first address search. The seam is deliberately
  visible.
- **There is no cache and no throttle anywhere in `core/geocoding/`.** The provider is called once
  per request.
- The only callers are `GET /api/geo/search` and `GET /api/geo/reverse`
  (`modules/geo/controllers/geo.controller.ts:24,38`), and their router is `router.use(requireAuth)`
  (`modules/geo/routes.ts:13`).

**That last point corrects the framing of the question.** No anonymous storefront traffic reaches
Nominatim — checkout snapshots a candidate the *signed-in* client already resolved. The exposure
is bounded by signed-in address entry, not by browse volume, which makes this less urgent than
[08](../../PRODUCTION-READINESS/08-AMBIGUITIES.md) implies. It does not make the public
instance's usage policy (one request per second, no bulk) survivable in production.

---

## D-1 · A result cache lands first

**Decision: cache geocoding results in Redis before choosing a provider.**

It is the cheapest item on the page and it reduces whichever bill is chosen afterwards. Address
strings repeat heavily in this domain — a handful of neighbourhoods carry most of a city's orders,
and the same query arrives from every customer typing the same street.

Notes for the implementation:

- Key on the **normalised query plus the country bias and language**, not the raw string; the
  provider is already given all three (`defaultCountryCodes`, `opts.language`).
- Cache the *candidate list*, not a chosen address — the choice is the user's and is snapshotted
  onto the order separately.
- Reverse lookups cache too, at coarser coordinate precision.
- Use a dedicated Redis DB from `REDIS_DB_CATALOG`. **Not 4 or 9** — those are retired on purpose
  so a stale pre-cutover key cannot be read back.
- The cache must fail **open**: a Redis outage degrades to direct provider calls, never to a
  failed address search. Same argument as `FailOpenStore` and the worker lock.

## D-2 · Then rent, rather than self-host

**Decision: build one paid adapter.** Which of the four is a commercial question, not a technical
one, and the `IGeocodingProvider` seam means it is reversible for the cost of a second adapter —
roughly a day, since `NominatimProvider` is the worked example.

**Why not self-host**, which was the alternative: an OSM import plus a box to run it on removes
the usage-policy question entirely, and it is the right answer *once address search is hot enough
that the per-request bill beats the box*. The auth-gated call sites above say that is some way
off. Revisit when the cache's hit rate stops rising and the miss volume justifies it.

---

## Consequences

- **`config/env.ts:405` starts passing for a value other than `nominatim`** — the boot check
  currently errors on any provider without an adapter, and the new adapter's key becomes a
  required variable in that environment. `.env.example` gains it; `test:env` enforces that.
- **The key is a rotatable secret** and belongs in the ADR-019 D-1 secret mapping, with the
  rotation procedure (Step 2.E.2).
- Nominatim stays the default and stays working, which keeps local development keyless. Do not
  remove the adapter.
- **No business logic branches on the provider** — that rule is unchanged and is what makes this
  decision cheap. The only code that knows which provider is live is the factory and
  `/system/config`'s `wiring` block.
