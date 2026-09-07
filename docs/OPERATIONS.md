# jovi-mall — operations

Read from source 2026-09-06: `src/lifecycle.ts`, `src/modules/dev-tools/worker-registry.ts`,
`src/core/jobs/`, `src/config/env.ts`, `src/modules/system/metrics/metrics.ts`.

Deployment, rollback and secret rotation are **not** here — they span all three services and live
in [`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md).

---

## 1 · Background work — 18 workers

`WORKER_INVENTORY` in `src/modules/dev-tools/worker-registry.ts` is the census: **17 triggerable +
1 not**, surfaced on `GET /api/internal/admin/system/workers`.

| Key | Does | Cadence source |
|---|---|---|
| `plan-expiry` | expires billing plans | hardcoded cron |
| `agency-shipment-cap` | the soft agency shipment cap | hardcoded |
| `file-cleanup` | orphaned uploads | `FILE_CLEANUP_CRON` |
| `earnings-release` | **moves money** — releases matured escrow holds | `EARNINGS_CRON` |
| `unpaid-order-cancel` | cancels unpaid orders | `UNPAID_ORDER_CANCEL_CRON` |
| `unpaid-booking-cancel` | cancels unpaid bookings | hardcoded |
| `payment-reconciliation` | **settles payments** against the gateway | `PAYMENT_RECONCILE_CRON` |
| `booking-reminder` | booking reminders | hardcoded |
| `cod-deposit-deadline` | **moves money** — late-deposit flags + trust penalties | `COD_DEPOSIT_SWEEP_CRON` |
| `tracking-dispatch` | drains the tracking outbox to geo-tracker | interval |
| `tracking-allow-reconcile` | re-pushes stuck tracking **revocations** | interval |
| `agent-capacity-reconcile` | rebuilds the admission-control counter | `AGENT_CAPACITY_RECONCILE_CRON` |
| `agent-trust-recompute` | ⚠ **SHADOW** — see below | `AGENT_TRUST_RECOMPUTE_CRON` |
| `agency-inventory-reconcile` | rebuilds stored-SKU rosters, repairs drifted counters | `AGENCY_INVENTORY_RECONCILE_CRON` |
| `agency-storage-invoice` | writes last month's storage statements — **a record only** | `AGENCY_STORAGE_INVOICE_CRON` |
| `assignment-sweep` | advances auto-assignment sessions, expires manual offers | interval |
| `analytics-aggregation` | daily vendor analytics | `ANALYTICS_AGGREGATION_CRON` |
| `inbound-calendar-sync` | **not triggerable** — two horizons + per-instance state | two intervals |

### Three properties of this list that are not obvious

**1 · A schedule is DERIVED, never typed.** `WorkerSchedule` (`core/jobs/worker-schedule.ts`) makes
a worker report the same value it schedules with, and the registry has nowhere to type a literal.
The reason is a real defect: the old hand-typed `schedule: string` was **wrong for eight of ten
entries** — `plan-expiry` advertised `daily 00:05` against a real `0 3 * * *`,
`unpaid-order-cancel` advertised `every 10 minutes` against a daily `0 5 * * *`. An operator was
told a sweep had run six hours ago when it had not run at all. `npm run test:system` asserts each
worker's reported expression equals the value it holds, so retyping a literal **fails the suite**
rather than misleading somebody.

**2 · "Exists" and "can be triggered" are two questions, and conflating them lost two workers.**
`WORKER_INVENTORY` is an *observation*; `WORKER_REGISTRY` is a *capability*. When there was one
list — the triggerable one — `assignment-sweep` was absent **by oversight** (it starts indirectly,
via `initializeShipmentAssignment()`, so it was missing from the import block the list was written
from) and it is *the only thing* advancing auto-assignment sessions, so a stuck sweep was invisible
from every angle. `inbound-calendar-sync` is absent from the *registry* **deliberately and
correctly** — its work splits across two private methods with different horizons and it holds
per-instance state, so "run it once" has no single honest meaning — but an operator could not
previously see that it exists at all, which is a different problem.

**3 · Overlap is guarded, and the guard fails OPEN.** `core/jobs/worker-lock.ts`, two layers:

- **in-process** — a `Set` of keys held by this process. Unconditional, no dependency, and what
  actually closes the defect on a single-instance deploy.
- **Redis** — `SET <key> <token> NX PX <ttl>` on DB 12, which is what makes multi-instance safe.

⛔ **The Redis layer failing open is not negotiable.** Failing closed would let a Redis outage
silently stop every sweep in the platform — *including the two that move money* — with no symptom
but work quietly not happening. Failing open degrades to layer 1, which is exactly the guarantee a
single-instance deploy needs anyway.

The TTL is short and a timer extends it while the sweep is alive, because a TTL long enough for the
slowest sweep is also long enough to strand the lock after a crash. **Both the extension and the
release are Lua compare-and-swaps on the token** — without them a sweep that overran its TTL would
delete a *successor's* lock on the way out and hand a third pass the key.

⚠ **The overlap guard sits INSIDE `runSweep`; the maintenance guard sits at the TICK site.** That
asymmetry is deliberate: maintenance is a policy an operator is entitled to override (ADR-014 D-4),
so a manual trigger routes around it. Overlap is a **correctness constraint**, and an operator's
intent does not make two concurrent writes to the same earnings row safe. A trigger arriving
mid-sweep is refused and returns `ran: false` — **reported, not swallowed**, because otherwise the
endpoint answers "Expired plans processed" for a trigger that did nothing.

⚠ **`agent-trust-recompute` is a SHADOW worker.** It writes `trust_signals.composite_score` and
**never** `cod.trust_score`, which `CodTrustService.applyEvent` still owns. Reading its output as
the live trust score is wrong. Phase 6 D-2; the flip was scheduled as Step 11 and has not happened.

⚠ **`readonly` maintenance deliberately does NOT pause workers**; `down` does. A read-only window
usually means a schema change is in flight, and a sweep that only reads is safer running than
stopped — but `down` means nothing touches the data, and a cron firing mid-migration is exactly what
`down` exists to stop.

---

## 2 · Configuration — 300 variables

**Measured by `npm run test:env` on 2026-09-06: 1 020 source files scanned, 300 variables read, 299
documented** (one is on the `INTENTIONALLY_UNDOCUMENTED` list). That suite asserts the contract in
**both** directions — a variable `src/` reads and `.env.example` omits is a deploy misconfigured
with no error at boot; a variable `.env.example` offers and nothing reads is an operator setting
something that does nothing.

⚠ **`src/config/env.ts`'s own docstring says "254 variables through ~15 module-level `*.config.ts`
objects".** Both figures are stale: it is **300** variables and **27** `*.config.ts` files. Filed as
DOC-PROGRAM **P-12**. The argument the docstring makes is unaffected — it is about *shape*, not
size — but the numbers should not be quoted onward.

### The division of labour, which is a decision and not an omission

wi-admin's `config/env.ts` is a Zod schema that *supplies* every value; nothing there reads
`process.env` at a call site. **This service does not do that**, and the difference is deliberate:

- the **module configs** own values and defaults (`AGENT_CONFIG`, `SYSTEM_CONFIG`, …), and
- **`src/config/env.ts`** owns *whether the environment those defaults are applied to makes sense*.

What that buys is the property the module configs structurally **cannot** have. Every one of them
uses the same `intEnv(name, fallback)` shape, which silently substitutes the fallback for a value it
cannot parse — so `COD_DEPOSIT_DEADLINE_DAYS=two` boots clean and runs on 2, and
`STORAGE_PROVIDER=cloudinary` with no Cloudinary credentials boots clean and **writes uploads to
local disk**. A per-variable default cannot detect either; only a pass over the whole environment
can.

### Two properties to preserve when adding a rule

1. **Every problem is reported at once.** Collect into `problems`; never throw on the first. An
   operator should fix one list, not restart five times to discover five mistakes.
2. **Errors and warnings are different things, and the split is not severity theatre.** An `error`
   refuses the boot. A `warning` prints and continues, and is reserved for what the process
   genuinely cannot decide — whether there is a proxy in front of it, whether anyone intends to
   scrape `/metrics`. Making those errors would refuse valid deployments; leaving them silent is
   what produced the report this file answers.

### Secrets

`config/secrets.config.ts` — `getJwtSecret()` **throws** when unset, and refuses a value under 16
characters or a known placeholder in production. `assertSigningSecrets()` runs at boot.
**geo-tracker applies the same two thresholds**, deliberately identical numbers: one secret with two
readers must not hold two opinions about what is acceptable.

⚠ **A boot proves the variable is SET on both sides. It does not prove the two values MATCH.**
Nothing anywhere compares them, so a mismatch is silent. The only proof is the end-to-end check in
[`../../docs/RUNBOOK.md`](../../docs/RUNBOOK.md) § Verifying a rotation actually took. `.env.example`
carries a `SOURCE:` line at each shared variable naming the other side's variable name.

---

## 3 · External services

| Service | Used for | Module | Failure posture |
|---|---|---|---|
| **Stripe** | card payments | `payments/gateways/stripe.*` | webhook-confirmed |
| **My-CoolPay** | ⚠ **LIVE money** | `payments/gateways/mycoolpay.gateway.ts` | webhook-confirmed |
| **NotchPay** | mobile money | `payments/gateways/notchpay.gateway.ts` | webhook-confirmed |
| **Geoapify · LocationIQ · Nominatim** | geocoding, as a **chain** | `core/geocoding/providers/` | falls through on empty; **never on a 401** |
| **Firebase · Cloudinary · local disk** | file storage | `core/storage/providers/` | see the ⚠ below |
| **WhatsApp (Meta)** | messaging, bot | `modules/whatsapp/` | best-effort |
| **Telegram** | messaging, bot | `modules/telegram/` | best-effort |
| **FCM** | push | `config/fcm.config.ts` | best-effort |
| **SMTP** | mail | `modules/mail/` | best-effort |
| **Google Calendar** | booking sync | `modules/integrations/calendar/` | optional, per-vendor |
| **geo-tracker** | routing matrix, ETA | `shipment-assignment/services/geo-routing.client.ts` | **returns null; caller degrades** |

⚠ **The storage capability matrix is INVERTED from what you would guess**: the *local* provider
streams bytes and **Firebase does not**. Digital download and delivery-proof paths therefore break
on `firebase`/`cloudinary`. The production provider is still undecided; this is a recorded open
issue, not a fixed design.

The chain (`core/geocoding/geocoding.chain.ts`) **adds free-tier allowances together** rather than
picking one provider and being down when its quota runs out: Geoapify 3 000/day at 5 rps in front,
LocationIQ 5 000/day at 2 rps behind it, keyless Nominatim last so a deployment with no keys at all
still resolves an address. It falls through on exactly two things and deliberately not on a third:

| Falls through on | Does **not** fall through on |
|---|---|
| a **failover error** — `GEO_PROVIDER_RATE_LIMITED` (429) or `GEO_PROVIDER_UNAVAILABLE` (5xx, timeout, DNS) | `GEO_SEARCH_FAILED` — a malformed query is just as wrong at the next provider, and retrying spends the reserve's quota to reproduce the failure |
| an **EMPTY result** — coverage genuinely differs between providers on Cameroonian addresses | **a 401**, which surfaces as `GEO_SEARCH_FAILED`. A rejected key is a *configuration fault an operator must see*; quietly serving from the other provider is how a deployment runs for months on half its capacity with nobody aware |

⚠ Failing over on empty means a genuinely unmatchable address costs one call at **every** provider.
That is the deliberate trade — a customer who cannot find their own street is a lost order — and the
negative cache (`GEO_CACHE_NEGATIVE_TTL_SECONDS`) is what stops the same query paying it twice. The
chain sits **inside** the cache decorator, so a cached miss reaches no provider at all.

⚠ **There is deliberately no `'chain'` in `GeoProviderName`.** That value is persisted on every
stored `GeoAddress.provider`, and a row saying "chain" would record which *mechanism* answered
instead of which *service* — making `provider_place_id` unresolvable forever. `name` reports the
first provider; every candidate reports the one that actually resolved it, passed through untouched.
The last error is re-thrown when all providers fail, because **"nobody could be asked" and
"everybody said no" are different answers** and the caller must be able to tell them apart.

⚠ **Geoapify and LocationIQ keys are shared with geo-tracker** — and there the interesting failure
is *not* a mismatch. Holding the **same** key means **one quota with two spenders**: jovi-mall spends
it on checkout address search, geo-tracker on auto-dispatch ranking and the tracking ETA. Nothing
adds the two together, so a routing burst can exhaust the allowance checkout geocoding depends on,
and **the symptom lands in a different service from the cause**. geo-tracker has a
`geotracker_routing_provider_calls_total` counter; **jovi-mall has no counterpart**.

---

## 4 · Metrics, health and maintenance

### Metrics

`GET /metrics`, Prometheus, token-gated with a **404 on refusal** (not a 401 — the endpoint does not
confirm it exists to somebody without the token). **22 collectors**, in `system/metrics/metrics.ts`:

- HTTP — `httpRequestsTotal`, `httpRequestDuration`, `httpRequestsInFlight`
- workers — `workerRunsTotal`, `workerDuration`, `workerLastSuccess`, `workerProcessedTotal`
- integration — `integrationCallsTotal`, `integrationDuration`, `geocodingCacheEventsTotal`
- events — `eventBusPublishedTotal`, `eventBusHandlerFailuresTotal`
- outbox — `outboxDispatchedTotal`, `outboxDepth`, `outboxOldestPendingAge`
- stores — `redisOperationErrorsTotal`, `mongoOperationErrorsTotal`
- errors and limits — `errorsTotal`, `rateLimitedTotal`, `rateLimitStoreErrorsTotal`
- state — `maintenanceModeGauge`, `metricsCollectFailuresTotal`

⚠ **Never label a metric by error code, raw path, agent id or user id** — cardinality is unbounded.
Route labels come from `system/domain/route-group.ts`, which exists exactly to bound that space.

### The health split

| Route | Semantics | Consumer |
|---|---|---|
| `GET /api/health` | **liveness — unconditional 200** | geo-tracker's `NodeAPIChecker`, **as a readiness dependency** |
| `GET /api/health/ready` | readiness — dependencies checked, may 503 | orchestrator |

⛔ `/api/health` is a **frozen contract**. Full reasoning in
[CONSTRAINTS.md § 2](./CONSTRAINTS.md#2--the-frozen-contract).

### Maintenance mode

Three modes: `off` · `readonly` · `down`, read **before the listener opens**.

**Five always-exempt prefixes**, each with a written reason in
`system/domain/maintenance-mode.ts`: `/api/internal/admin` (locking the operator out of the window
is a lockout recoverable only by redeploy), `/api/internal/agents`, `/api/tracking`,
`/api/internal/shipments` (all three so a jovi-mall window does not become a geo-tracker outage),
and `/api/health`.

Two further exemptions apply in `readonly` only, and both are writes that must not be lost:

- `/api/digital/download` — burning a single-use download token is technically a write, and exactly
  the write that must not be lost mid-download.
- `/api/auth/mobile/refresh` — it mints a token and writes nothing, and it is a bearer client's
  **only** renewal path. A cookie client renews inside an ordinary GET, so without this a read-only
  window would sign out every native client fifteen minutes in while browsers carried on.

The bot surface is **read-only in `readonly` and blocked in `down`**, classified by *method and
shape* rather than by name — an unrecognised request under that prefix is on its way to a 404 anyway.

⚠ **The maintenance gate fails OPEN.** The failure mode of failing closed is a platform that is down
and whose own operator door may be part of what is down. **A maintenance window nobody can exit is
worse than one that leaks a request.**

---

## 5 · Startup and shutdown

The ordered sequence, and why each step sits where it does, is
[ARCHITECTURE.md § 5](./ARCHITECTURE.md#5--boot-order-is-load-bearing). Two operational notes belong
here:

- `SYSTEM_CONFIG.SHUTDOWN_TIMEOUT_MS` bounds the whole drain; in-flight sweeps get **half** of it.
- A second `SIGTERM` (or an impatient Ctrl-C) does **not** start a parallel drain, and a drain that
  already completed does not run again — a second pass would flush the log sink into a Mongo
  connection the first one already closed.

## 6 · The dangerous verbs

`/api/internal/admin/dev-tools/*` — worker triggers, cache flushes, index operations. Every one of
them is `destructive`-tier in wi-admin, tier-1 only, and **audited on every call**. The read-only
diagnostics are a separate mount (`/api/internal/admin/system/*`, every route a GET, nothing
audited), and keeping the two apart is what lets Support hold the second without the first.
