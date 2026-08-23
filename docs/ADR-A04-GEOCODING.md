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

> ### ✅ SUPERSEDED IN PART by D-3 — 2026-08-23
>
> *"Build ONE paid adapter"* is the half that changed. Two were built, and the reason is the
> arithmetic D-2 did not do: **every provider with a usable free tier caps out in the low
> thousands of calls a day.** Choosing one does not answer the usage-policy question this ADR
> was written about — it replaces Nominatim's ~1 rps ceiling with a 3 000/day one. The rest of
> D-2 stands: renting still beats self-hosting, and the seam still made it cheap.

**Why not self-host**, which was the alternative: an OSM import plus a box to run it on removes
the usage-policy question entirely, and it is the right answer *once address search is hot enough
that the per-request bill beats the box*. The auth-gated call sites above say that is some way
off. Revisit when the cache's hit rate stops rising and the miss volume justifies it.

---

## D-3 · Two providers, chained — not one · **2026-08-23**

**Decision: build `geoapify` AND `locationiq`, and run them behind
`ChainedGeocodingProvider` with keyless Nominatim appended as the last resort.**
`GEO_PROVIDER=chain`, `GEO_PROVIDER_CHAIN=geoapify,locationiq`. This answers **O-5**, which D-2
left open as "which of the four".

**The reasoning D-2 missed.** Its framing — pick one, the seam makes it reversible — treats the
choice as a preference. It is a capacity question. Geoapify's free tier is 3 000 credits/day at
5 rps; LocationIQ's is 5 000/day at 2 rps. Either alone is a ceiling that a busy day of checkout
address search reaches, at which point the platform is back where this ADR started: unable to
geocode. Two providers do not merely hedge the choice, they **add the allowances together**, and
the code to do it is one class.

**The order is not the obvious one, and that is the part to preserve.** LocationIQ has the larger
daily allowance and still goes *second*, because:

| | Geoapify | LocationIQ |
|---|---|---|
| daily | 3 000 | **5 000** |
| burst | **5 rps** | 2 rps |
| when exceeded | **soft** — they contact you | **hard** — immediate 429, no buffer on the free plan |

Address autocomplete is bursty by nature: three keystrokes in one second is already over
LocationIQ's limit. So the provider that tolerates bursts and degrades gracefully absorbs the
normal load, and the one that refuses hard is held in reserve for when the first runs out. Leading
with LocationIQ would produce 429s during ordinary typing while its daily allowance sat unspent.

**What the chain falls over on** — and the third row is the one somebody will want to "improve":

| Condition | Behaviour | Why |
|---|---|---|
| `429` / `5xx` / timeout / DNS | next provider | "out of quota", "it is down" — the whole point |
| an **empty result** | next provider | coverage genuinely differs here; a Douala street one has mapped and the other has not is the ordinary case, not the exotic one |
| `GEO_SEARCH_FAILED` (400, **401**, unparseable body) | **propagates** | a malformed query is malformed everywhere, and a rejected key is a configuration fault an operator must SEE. Quietly serving from the reserve is how a deployment runs for months on half its capacity |

Every provider failing re-throws the last error rather than returning empty — *"nobody could be
asked"* and *"everybody said no"* are different answers. But a 429 followed by an honest miss **is
a miss**: telling a customer the service is broken when their street is simply not on the map is
the worse of the two lies.

**Cost, stated rather than discovered later:** an unresolvable address now costs one call at every
provider instead of one. The negative cache (D-1, `GEO_CACHE_NEGATIVE_TTL_SECONDS`) is what stops
it paying that twice, and the chain sits *inside* the cache decorator, so a cached miss reaches
nobody.

**⚠ The chain is never stored.** `GEO_PROVIDERS` gains `locationiq` and deliberately **not**
`chain`. That value is persisted on every `GeoAddress.provider`, and it must name the *service*
that resolved the address — that is what keeps `provider_place_id` resolvable. A row saying
"chain" would record the plumbing and lose the fact. The chain passes candidates through untouched
and `test:geocoding-chain` asserts both halves.

**A missing key SKIPS its provider; a misspelt name is FATAL.** The first is what lets one
`GEO_PROVIDER=chain` setting serve a laptop with no keys, staging with one and production with
both. The second is the `assertUploadScannerSafe` argument: silently skipping a typo is how a
deployment runs on its fallback believing it runs on its primary. Nominatim is keyless and always
appended, so the chain can never come out empty.

**⚠ Neither adapter has been exercised against a live key.** They are written against the
published response shapes. `verify:geocoding-providers` is the check — it asserts the field
mapping, the `[lng, lat]` **order** (a swapped pair puts Douala in the Gulf of Guinea and both
halves remain plausible numbers), and that a no-match returns `[]` rather than throwing. It
**skips green** when a key is absent, and says loudly that it proved nothing. Run it before
trusting the chain in a deployment.

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
