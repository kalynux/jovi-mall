# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ## ⚠️ A refactor is in flight — compiles, but incomplete
>
> A large agent-contract / COD-shared-pool refactor is part-applied. As of
> **2026-07-30** `npx tsc --noEmit` and `npm run lint` are clean and the app loads.
> Steps 1–3 are done: the COD cash chain is complete and reachable, and the
> mechanism that **releases COD headroom now exists** — an agent→agency deposit
> (`POST /api/agent/cod/deposits` declare → agency confirm, or the agency's
> one-step `POST /api/agency/cod/deposits`) draws down the contract's outstanding
> balance via `AgentDepositService` → `recordSettlement`, so a COD pool drains.
> **Agent earnings are complete for both payment methods** (see "The earnings
> split" below). The admin/agent controllers (threshold, contract terms,
> settlements, KYC/ban, status-request inbox) **landed 2026-07-29** — including
> the KYC write path, without which no agent could accept an offer outside a
> seeded database. What is still missing: the trust composite engine, the
> collection-rename migration, and the doc refresh.
>
> **Read [AGENT-CONTRACT-REFACTOR.md](./AGENT-CONTRACT-REFACTOR.md) before touching
> `src/modules/agents/`, `src/modules/cod/`, or `src/modules/shipments/shipment.service.ts`.**
> It lists what is built, what is not, decisions already settled with the product
> owner, and the order to finish in.
>
> `npm run test:agent-domain` was stale against the new model and is **repaired**;
> it is green at **211 assertions** as of 2026-08-06. It is DB-free, so it still
> cannot cover the COD allocation race or the money movements — see the handoff doc.
> `npm run test:agent-shipment-status` (green at **32**, added 2026-07-30) covers
> the shared transition map, the map↔schema drift guard, and the agency
> notification catalog's five-language completeness.
> `npm run test:earnings-quote` (green at **29**, added 2026-08-05) covers the fee
> arithmetic itself — it re-derives what both splits allocate from the same pure
> helpers they call, so the estimate and the actual cannot drift apart unnoticed.
>
> Parts of this file below still describe the *pre-refactor* model (notably
> per-agency `cod.max_exposure_override` and membership statuses). The handoff doc
> wins where they disagree. Delete this banner when the refactor lands.

## Commands

```bash
npm run dev          # Start dev server with hot reload (ts-node-dev) — :8022 by default
npm run build        # Compile TypeScript → dist/
npm run start        # Run compiled server (production)
npm run lint         # ESLint with zero warnings allowed
```

Data/ops scripts (all `ts-node scripts/…`, and `src/scripts/**` is ESLint-ignored):

```bash
npm run aggregate:analytics              # Populate vendor analytics data
npm run backfill:last-ordered            # Backfill last-ordered-at
npm run backfill:pickup-locations        # Backfill pickup locations
npm run backfill:shipment-tracking-numbers  # Stamp legacy shipments (idempotent, --dry-run)
npm run migrate:customer-payment-methods
npm run migrate:agent-memberships        # agency_id → memberships (idempotent, --dry-run)
npm run migrate:agent-deposits           # backfill deposit status/recipient (idempotent, --dry-run)
npm run migrate:contract-terms           # terms_proposed_by/terms_version (idempotent, --dry-run)
npm run migrate:cod-late-deposit-index   # DROP the agent-scoped late_deposit index (--dry-run)
npm run migrate:agent-vehicle-colors     # normalize vehicle_info.color to the palette; reports
                                         # every off-vocabulary value (idempotent, --dry-run)
npm run migrate:booking-rule-timezones   # clear the legacy 'UTC' default off availability rules so
                                         # they inherit the vendor's zone; reports every rule whose
                                         # effective hours would move (idempotent, --dry-run)
npm run seed:tickets [-- --clean]        # also: seed:plans, seed:cod [-- --clean]
npm run seed:blog                        # the house byline ONLY — no articles, deliberately
npm run seed:cod-shipments [-- --clean]  # 7 COD shipments across the lifecycle, on the
                                         # EXISTING agency b0…05 + agent b0…06, with real
                                         # geocoded Douala pickup/drop-off addresses
npm run simulate:notifications
```

No test *framework* is configured. Tests are plain ts-node scripts under `scripts/test/` with
hand-rolled asserts — follow that convention rather than introducing a runner:

```bash
npm run test:agent-domain                      # agent domain (211 assertions, no DB needed)
npm run test:earnings-quote                    # the delivery-fee arithmetic (29, no DB needed)
npm run test:pickup-depot                      # the agency-depot pickup location (44, no DB needed)
npm run test:agency-inventory                  # the agency stored-SKU roster (31, no DB needed)
npm run test:vehicle-profile                   # vehicle colour + photo merge (31, no DB needed)
npm run test:payout-methods                    # the shared payout schema + switch (53, no DB needed)
npm run test:booking-availability               # booking windows/timezones/seats (54, no DB needed)
npm run test:customer-notifications             # customer catalog + balance settlement (30, no DB needed)
npm run test:blog                              # article blocks, slugs, DTO projection (100, no DB needed)
npm run test:errors                            # Phase 16: the taxonomy, the exposure policy, the
                                               # envelope, the body-parser branch and the rate-limit
                                               # policy (69, no DB). Includes a CENSUS of all 1362
                                               # createAppError sites — it fails if a NEW code is
                                               # raised at two statuses that disagree on category.
                                               # 25 pre-existing conflicts are baselined in the file
                                               # with the reasoning, and the baseline cannot go stale.
npm run test:system                            # worker schedules, maintenance exemptions, cache-flush
                                               # policy, metric cardinality, plus Phase 15's scrubber,
                                               # ring buffer, console bridge, exposed-config whitelist,
                                               # index-drift diff, prune policy and the safe-execution
                                               # source scan (175, no DB needed)
npm run verify:logs                            # the logging sink against real Mongo (18) — proves the
                                               # collection is genuinely CAPPED, $collStats is permitted
                                               # here, and the warn+ level floor is enforced. NEEDS Mongo
npm run verify:live-parity                     # agent↔agency smoke test — NEEDS Mongo
npm run verify:blog                            # blog lifecycle + index builds + route order — NEEDS Mongo
npx ts-node scripts/test/test-profile-mappers.ts
```

`verify:blog` is the blog's counterpart to `verify:live-parity`, for the same three reasons — it is
the only place the unique multikey index on `slug_keys` is proven to build, the `$elemMatch`
translation queries are proven to run, and `/articles/index` is proven to be declared before
`/articles/:slug`. Unlike `verify:live-parity` it **writes**, then deletes its own `verify-blog-*`
documents, pass or fail.

`verify:live-parity` is the other script here that requires a database, and it exists because the
DB-free suites structurally cannot cover four things: that the schema **indexes actually build**
against real data (`autoIndex` is on, so a failed 2dsphere fails *silently* at boot), that the
directory **aggregation pipeline runs** (Mongo validates pipelines at execution time, not compile
time), that the contract lists page and return terminal rows, and that the **Express route table**
resolves literals before `:id` params. It is read-only. Run it after any change to the agent
directory query, the contract list methods, or either router's route order.

Pure derivations are deliberately extracted onto services (`deriveWorkingState`, `buildPolicy`,
`effectiveLimit`) so they can be tested without Mongo. Note that unit tests here cannot catch
circular imports or duplicate Mongoose model registration — boot the server to check those.

## Architecture Overview

**jovi-mall-backend** is an Express/TypeScript modular monolith following DDD-influenced layered architecture.

### Layers (top → bottom)
1. **API layer** (`src/api/`) — middleware, route mounting, global error handler
2. **Module layer** (`src/modules/`) — feature modules with controllers, services, repositories, models, validators, routes
3. **Core layer** (`src/core/`) — base repository, error system, storage abstraction, shared types
4. **Infra layer** (`src/infra/`) — Redis factory, DB connection helpers

### Module structure (consistent across all modules)
Each module under `src/modules/<name>/` follows this layout:
- `controllers/` — HTTP handlers using `asyncHandler` wrapper
- `routes/` — Express router definitions, attaches guards and controllers
- `domain/services/` — single-responsibility business logic classes
- `repositories/interfaces/` — repository contracts (`IProductRepository`, etc.)
- `repositories/mongo/` — Mongoose implementations extending `BaseRepository`
- `repositories/mappers/` — domain ↔ persistence object mapping
- `models/` — Mongoose schema definitions
- `validators/` — Zod schemas for request validation
- `dto/` — Data transfer objects

### Dependency injection
No IoC container. Repositories and services are instantiated manually at the top of each controller file, then closed over in static handler methods. Dependencies flow via constructor injection.

```typescript
// Pattern used in every controller file
const productRepository = new ProductRepositoryMongo();
const productDraftService = new ProductDraftService(productRepository, slugService);

export class VendorProductController {
  static createProduct = asyncHandler(async (req, res) => { ... });
}
```

### Error handling (Phase 16 — `../admin/docs/ADR-016-ERROR-SYSTEM.md`)
**Never** use `throw new Error()` or `res.status().json({ error: ... })`. ESLint enforces this — and the `res.json` selector now matches `error` **anywhere** in the object literal, not only as its first property, which is exactly how eight hand-rolled error responses had accumulated.
- Use `createAppError(code, statusCode, message?, details?)` from `src/core/errors.ts`
- Pass errors to `next(error)` — the global handler normalises AppError, ZodError, body-parser rejections, Mongoose and Multer errors into one shape
- Error codes are domain-prefixed literals in `src/core/error-codes.ts` (541 of them, 1362 call sites, zero ad-hoc strings)

**Every error carries a `category`** — one of nine (`src/core/error-category.ts`), **derived** from `(code, statusCode)` in the `AppError` constructor rather than in the factory, because four subclasses and six `ticket.service.ts` sites call `super()` directly. Never annotate one by hand: the same code is raised at different statuses at different sites, so an annotation would be wrong at one of them. **`400` is a schema failure and `422` is a business rule** — that split already exists at 136 and 139 call sites and the derivation depends on it.

**Filtering happens at the BOUNDARY, keyed on category — never at the throw site.** For `internal` and `external_service` the handler substitutes the code's registry message and **drops `details` entirely**, in *every* environment. That is what closed the `{ cause: error.message }` leak in `payment-orchestrator.service.ts` without editing it, and it is why a service may still put diagnostic context in `details` on a 5xx — it is journaled, not sent.

**The client envelope gained one field, `category`, and nothing else.** `isOperational` is now derived (`statusCode < 500`); it was hardcoded `true`, so the masking its own docstring promised had never once happened.

**Errors are journaled under one `httpError` key** on the log line, read back through `GET /api/internal/admin/system/errors`. That endpoint returns the FULL record — the developer/admin/support ladder is applied in **wi-admin**, the only service that knows an administrator's tier. `X-Actor-Tier` reaches this service and must stay advisory: the token authenticating that call grants everything, so enforcing on the header would be theatre.

⚠ `core/logging/log-record.ts` assigns every persisted field **by name**. A new field must be added there, in the sink, AND in `log-query.service.ts`'s `toRecord` — miss one and the data is written and silently dropped on read. That is why the whole error record nests under a single key.

### Rate limiting (`src/api/rate-limit/`)
Three layers. **Layer A** (`globalRateLimiter`, mounted in `app.ts`) is IP-scoped and runs before auth, so it protects the login endpoint. **Layer B** (`identityRateLimiter`) is attached at the **tail of `requireAuth`** — one edit, and every authenticated route inherits the per-role ceiling; a router added next year gets it without its author knowing. **Layer C** is per-endpoint and deliberately unbuilt.

**Never classify a caller from an unverified JWT.** Selecting a *more generous* bucket from an attacker-chosen claim hands a forger the biggest one — that is the entire reason for the two-layer split rather than one clever limiter.

Ceilings are backstops, not budgets (agent/admin 1200, vendor/agency 900, customer 600, anonymous 600/IP; **auth endpoints 20/IP**, the one strict number and the one security control). Redis DB 11. **The store fails OPEN** — `rate-limit-redis` rejects when Redis is down and express-rate-limit turns that into a 500 on *every* request, so `FailOpenStore` is not garnish: without it, wiring Redis in adds a single point of failure in front of every route. `/api/health*`, `/metrics` and `/api/webhooks/*` are exempt, with a written reason each.

`app.set('trust proxy')` and `express.json({ limit })` are load-bearing companions — the first because `req.ip` is the limiter's key, the second because `REQUEST_BODY_TOO_LARGE` is unreachable without a named ceiling.

### Auth & request context
`requireAuth` middleware (`src/api/middlewares/auth.middleware.ts`) populates `req.auth = { user, role, role_entity }`.

**There is a second door onto `req.auth`, and it builds one from nothing.** `requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`) guards `/api/internal/admin/*`, the surface the **wi-admin** backend calls. Administrators live in a separate database and hold no `users` row and no `admins` row here, so that middleware *synthesises* the whole `req.auth` shape from request headers with **no database query** — `X-Actor-Id` becomes both `user.id` and `role_entity._id`, and the role is the constant `'admin'`.

The consequence is deliberate and worth knowing before you touch an actor field: **a `*_by_user_id` written through that door holds an id that resolves to nothing in this database.** It is safe only because no `.populate()` anywhere dereferences an actor (`*_by*`) field — 13 populate sites, none of them. Adding one would silently return null. What makes it legible instead of mysterious is the pair of companion fields from `core/types/actor-source.types.ts`: `*_source: 'platform' | 'admin'` says which identity space the id belongs to, and `*_name` snapshots who it was, because a cross-database join cannot exist. Use `actorStampFields()` in the schema and `actorStamp()` on the write — writing the three together is what stops a source disagreeing with the id beside it. Applied so far to `agency_remittances.resolved_by` and `agent_deposits.recorded_by`.

`INTERNAL_ADMIN_SERVICE_TOKEN` authenticates that caller and is deliberately **not** `INTERNAL_SERVICE_TOKEN` (geo-tracker's) — different blast radii, so one secret would make either compromise the other's. Both fail closed when unset. Note the token is a *full-privilege* credential: authorization is resolved in wi-admin before the call and this service re-checks nothing, exactly as it trusts geo-tracker.

**Admin routers are dual-mounted, via a factory.** `buildAdminCodRouter(guards)` is instantiated twice — once with `[requireAuth, requireRole(['admin'])]` at `/api/admin/cod` for the dashboard, once with `[requireAdminCaller]` at `/api/internal/admin/cod`. A single Router instance cannot be mounted twice because its `router.use` guards would re-run, which is why the guards are a parameter. The remaining admin routers follow the same shape as they migrate; both surfaces run until cutover. Ownership per domain is recorded in `../admin/docs/ADR-004-DOMAIN-OWNERSHIP.md`.

**`buildAdminAgentRouter` and `buildAdminAgencyRouter` followed at Phase 9**, mounted at `/api/admin/agents` + `/api/internal/admin/agents` and `/api/admin/delivery-agencies` + `/api/internal/admin/agencies`. The agency one carries a trap worth knowing: its routes used to declare `/delivery-agencies/...` because it was mounted at the bare `/admin` prefix, so they were made **path-relative** and `api/index.ts` absorbed the segment. Public URLs are byte-identical; if you change one of those paths, check that mount. wi-admin reads both collections directly and calls only the writes plus the three *verdict* reads (`tracking-policy`, `cod-allocation`, `eligibility`) — see `../admin/docs/ADR-009-DELIVERY-NETWORK.md` D-1.

**`buildAdminUserRouter` is the exception: mounted ONCE, internal only.** The user domain never had a public admin surface, so there is no dashboard calling `/api/admin/users` to keep alive — a public mount would create surface whose only future is the cutover deletion list. It carries writes only (`PATCH /:userId` for the login identifiers, `POST /:userId/{suspend,restore}`); wi-admin reads the `users` collection directly.

**`buildAdminVendorRouter` follows it** — mounted once at `/api/internal/admin/vendors`, writes only, no public twin. Seven operations: suspend/restore, KYC approve/reject, per-product suspend/restore, and a narrow settings PATCH. Contract in `api-doc/admin/vendors.md`; design record `../admin/docs/ADR-008-VENDOR-MANAGEMENT.md`. Note this domain *does* already have one public admin endpoint — `POST /api/admin/vendors/:vendorId/plan` in the billing module, which sets commission by assigning a plan. Nothing on the internal router duplicates it.

**`Vendor.status` is now enforced, and this is the second time that sentence has been written here.** It used to be read by exactly one query (`findAvailableForAgencies`, hiding `inactive` vendors from the agency directory) and written by nothing — `updateStatus` had zero callers, and the three guards in `auth/guards/index.ts` that would have read it (`requireActiveUser`, `requireRoleEntityActive`, `requireLegitBusiness`) **still have zero call sites**. `requireAuth` and `login` now refuse a vendor whose role entity is `inactive` with `403 AUTH_VENDOR_SUSPENDED`.

The check is deliberately `=== 'inactive'`, **never `!== 'active'`**: `pending_verification` is the schema default at registration, so the negated form would lock out every vendor who never verified their email. Refusing only `inactive` is provably a no-op against existing data. Don't "tidy" it — `wi-admin`'s `test:vendors` asserts the narrow form is what is in the file, and `verify:vendors` plants a `pending_verification` vendor to prove it stays untouched.

Suspension is written **only** through `/api/internal/admin/vendors` as a compare-and-set, carries `suspended_at` / `suspended_reason` / `suspended_from_status` / a `suspended_by` actor stamp, and **cascades**: it takes every `active` product of that vendor off sale in the same transaction (`ProductPlatformSuspensionService`, reason `vendor_suspended`), and the restore re-runs the activation gate on each rather than republishing blindly. `Vendor.status` and `User.status` remain separate axes and do **not** cascade into one another in either direction — one account can hold `vendor` and `customer`, and closing the shop must not sign the person out of their own shopping.

**`markEmailVerified` is now conditional, and that matters.** It used to `$set: { status: 'active' }` unconditionally — harmless while nothing wrote any other value, but the moment an administrator can suspend a vendor it means a suspended vendor lifts their own suspension by re-clicking an old verification link. It is a `$cond` pipeline update that only ever promotes out of `pending_verification`. `delivery-agency.repository.ts:135` has the same shape and therefore the same latent bug; flagged, not fixed.

**The deprecated top-level `Vendor.legit_verified` is gone**, and it was worse than dead: its schema path was commented out, so Mongoose strict mode silently stripped it from `setLegitVerified`'s `$set` — half that method never did anything — while `requireLegitBusiness` read it and would therefore have denied *every* vendor the day anybody attached it. The single source of truth is `kyc_details`, which now carries a three-valued `status` (`pending|verified|rejected`) beside the boolean, plus `verified_at`, `rejection_reason` and a reviewer stamp. `legit_verified` stays as the boolean projection because `agency-vendor-browse.dto.ts` renders `kycVerified` from it; the two are written in one `$set` and never apart.
Vendor-scoped queries extract `req.auth!.role_entity._id.toString()` as `vendorId` and pass it to repositories, which enforce scoping at the query level.

Token resolution order: `access_token` httpOnly **cookie first**, then `Authorization: Bearer`. On expiry `requireAuth` performs a **silent refresh** from the refresh cookie and transparently re-issues the access cookie — so bearer-only callers (e.g. geo-tracker forwarding a viewer's token) get no refresh and simply fail closed on expiry.

**`User.status` is now enforced, and on three paths rather than one.** It used to be written by nothing and read by nothing — `requireActiveUser` had zero call sites, `login` never looked at it, `rotateRefreshToken` never looked at it, and `UserRepository.updateStatus` had no callers. A suspended account was a label. `login`, `rotateRefreshToken` **and `requireAuth`** now refuse a non-`active` account with `403 AUTH_ACCOUNT_SUSPENDED`. The third is the load-bearing one: access tokens are stateless and 15 minutes long while the refresh cookie is 30 days, so a check at login alone would let a suspended person keep working and then silently refresh back in. `requireAuth` already loads the user row, so it costs a comparison and no query. **Consequence:** any `users` row already sitting at `suspended` loses access the moment this deploys, and there is no way for the person to get back in without an administrator — which is the correct meaning of the column, but check the count before rolling out.

Suspension is written **only** through `/api/internal/admin/users` (wi-admin's `users.suspend`), as a compare-and-set on the current status, and it carries `suspended_at` / `suspended_reason` / a `suspended_by` actor stamp. It deliberately does **not** cascade into the role entities: `Vendor.status`, `DeliveryAgent.status` and the rest are a separate axis with their own meanings, and collapsing the two makes reinstatement guess which was true before. The account lock is complete on its own — a suspended user cannot authenticate at all, whatever their role entities say. Design record: `../admin/docs/ADR-007-USER-MANAGEMENT.md`.

`JWT_SECRET` falls back to the literal string `'secret'` here, while geo-tracker fails closed on an empty secret. A misconfigured deploy therefore fails asymmetrically — treat the fallback as a known smell, not a default to rely on.

### Startup composition (`src/server.ts`)
Background workers/consumers register at boot, all after the Mongo connection: aggregation scheduler, plan-expiry worker + notification consumer, vendor / agency / **agent** notification consumers, file-cleanup, earnings-release, unpaid-order-cancel, COD deposit-deadline, and the tracking event subscriber + dispatch worker. A feature that needs periodic sweeps registers here; sub-minute cadences use `setInterval`, daily ones use `node-cron`.

Two things now run **before the listener opens**: `initializeMetrics()` (the private Prometheus registry, plus the Redis error sink) and `primeMaintenanceState()`. The second is load-bearing — an instance starting during a maintenance window must come up already closed, or a rolling deploy serves one full cache window of writes against a platform that is supposed to be shut.

**Register the singleton, never `new` a worker inline.** `server.ts` used to do `new InboundCalendarSyncWorker().start()`, which left the running worker unreachable by anything else: the operations surface could not report on it even in principle, and `stop()` could never reach the instance that was actually scheduled. Every worker now exports a singleton and `server.ts` starts that.

### System operations (`src/modules/system/`)
The operator surface, split across two mounts by what it does rather than by convention:

- **`/api/internal/admin/system/*` — every route a GET, nothing audited.** `dependencies` (Mongo readyState + `serverStatus`, Redis per logical DB), `integrations`, `queues`, `cache`, `workers`, `metrics` (JSON), `maintenance`.
- **`/api/internal/admin/dev-tools/*` — everything that changes something**, including the two Phase-14 additions: `PUT /maintenance` and `POST /cache/flush`.

Four rules run through it, and each exists because the obvious implementation is wrong:

- **A probe observes; it does not provision.** Redis connects lazily here and never at boot, so every read goes through `peekRedisClient` (already-open client or null) — a DB this process has not needed reports `idle`, not `down`. `/api/health/ready` therefore treats Redis as **non-required**: requiring it would create a connection on DB 0 (which nothing uses) on every probe interval, and would fail the whole instance for a partial capability loss. The cache *flush* is the one deliberate exception and uses `getRedisClient`; the asymmetry is documented on both accessors.
- **`configured` and `reachable` are different columns**, and most integrations may not be probed at all — a Stripe health check is an authenticated call on a live merchant account, a WhatsApp one is a message to a real person. `domain/integration-catalog.ts` holds the per-provider policy; unprobeable providers report what **real traffic** last learned, via `recordIntegrationCall()`.
- **Metric labels are bounded by a closed allowlist, not by normalisation.** prom-client enforces no cardinality cap, so `domain/route-group.ts`'s allowlist *is* the cap; `event_type` is bounded by *subscription* instead. Never label by user, role, vendor or order id.
- **Maintenance state lives in Mongo and every unknown fails OPEN.** Redis would converge faster but a restart would silently drop the window. An unrecognised mode or a corrupt document reads as `off`, because the failure mode of failing closed is a platform that is down and whose own operator door may be part of what is down.

**`GET /api/health` is FROZEN** — exact path, exact body, unconditional 200. geo-tracker's `NodeAPIChecker` is a **readiness** checker pointed at it and treats any status ≥ 300 as an error, so putting readiness semantics on that path means a jovi-mall Redis wobble pulls geo-tracker out of rotation and kills every live tracking session. `/api/health/{live,ready}` sit beside it. Contracts: `api-doc/health.md`, `api-doc/admin/system.md`, `api-doc/admin/dev-tools.md`; design record `../admin/docs/ADR-014-SYSTEM-OPERATIONS.md`. Covered DB-free by `npm run test:system` (70 assertions).

**Phase 15 added the developer-tools half** — four more GETs on `/system` (`config`, `logs`,
`cache/keys`, `database`) and one more verb on `/dev-tools` (`outbox/prune`, the only new
dangerous one). Design record: `../admin/docs/ADR-015-DEVELOPER-TOOLS.md`. Four rules of its own:

- **`GET /system/config` is a whitelist, never a dump** (`domain/exposed-config.ts`).
  `assertExposedConfigSafe()` runs at boot beside `assertSigningSecrets()` and kills the process
  if the list names anything credential-shaped. No `*_URL`/`*_URI` is exposed at all — the
  derived `wiring` block answers "is it pointed anywhere" without being able to carry a password.
  `SMTP_USER` is absent by a *human* decision the regex cannot make, which is the point.
- **Values never leave the cache.** `/system/cache/keys` returns names, types and TTLs; there is
  deliberately no single-key value read, because that is a disclosure oracle for download tokens,
  verification codes and WhatsApp idempotency keys. Every Redis command goes through the closed
  allowlist in `domain/redis-command-policy.ts` — *the allowlist is the cap*, the same argument
  `route-group.ts` makes about metric labels.
- **`/system/database` reports index drift and never repairs it.** `autoIndex` is on and a failed
  build fails *silently* at boot, so `missing` is the actionable bucket. Building or dropping an
  index is a migration, not a button.
- **`outbox/prune` accepts `status: 'sent'` and nothing else.** Pruning `failed` destroys what
  `outbox/replay` acts on; pruning `pending` destroys undelivered events. `confirm` repeats the
  *age*, because the age is what decides the blast radius.

### Logging (`src/core/logging/`) — Phase 15

This service had **no logging library** until Phase 15: 1268 `console.*` calls, stdout only, no
levels, no redaction, nothing queryable. It now has **pino**, with two sinks — a bounded in-memory
ring buffer and a **capped** `system_logs` collection persisting warn+ — behind
`GET /api/internal/admin/system/logs`.

- **`initLogging()` runs first in `startServer()`**, before the secret assertions, so a refused
  boot is itself captured. `enableLogPersistence()` runs after `mongoose.connect`. Lines between
  the two land in the ring only, and the endpoint reports the sink state so that boundary is
  visible rather than mysterious.
- **`console.*` is bridged** through the logger — that is what gives the 311 existing
  `console.error('…', err)` sites structured, searchable stacks without editing one. Only the
  five level-shaped methods are swapped; `console.table`/`dir`/`trace` stay native.
  `LOG_CONSOLE_BRIDGE=false` is the kill switch. **A test harness must print through
  `originalConsole`**, or the bridge swallows its own results.
- **Redaction is two layers and only one is a boundary.** `REDACTED_PATHS` is derived from
  `core/audit/redact.ts` (so it cannot drift), filtering out that set's two bracketed *path
  fragments* — they are not valid pino paths and pino throws at construction. `scrub.ts` is a
  heuristic net over rendered strings and says so in its own header; it deliberately does not
  match bare long hex, because ObjectIds and upload fingerprints are logged legitimately.
- **The collection is capped, not TTL'd**, and has **no Mongoose model** — `autoIndex` would
  create it uncapped first, and a capped collection cannot be converted afterwards.
  `LOG_MONGO_CAP_BYTES` is a one-way door.
- **`requestId` reaches every line via an `AsyncLocalStorage` mixin**, not a child logger — a
  child would have to be threaded through ~500 signatures and could never reach a bridged
  `console.*` call. `requireAdminCaller` stamps the administrator too, so wi-admin's audit
  `correlation_id` and a jovi-mall log line share one value.

**Workers report three booleans, never one.** `scheduled` / `executing` / `manualClaim`, because three different things in this codebase were all called `running` and `GET /dev-tools/workers` reported the least useful of them — a scheduled sweep churning for ten minutes showed `running: false`. Schedules are **derived** from the value each worker schedules with (`core/jobs/worker-schedule.ts`); the old hand-typed strings were wrong for **eight of ten** workers. Two workers were missing entirely: `AssignmentSweepWorker` is now registered (it is the only thing advancing auto-assignment sessions, so a stalled sweep was invisible from every angle), and `InboundCalendarSyncWorker` appears in `WORKER_INVENTORY` but stays out of the triggerable `WORKER_REGISTRY` — "run it once" has no single meaning for it. ⚠ The seven cron workers still have **no overlap guard**; `executing` makes that visible and deliberately does not fix it.

### Notifications (`src/modules/notifications/`)
**Four** parallel multi-channel stacks — vendor, agency, agent, and **customer** — each its own model + preference + repository + catalog + event-handler + consumer, all following the same rules (mandatory in-app record, always-on FCM push, at most one preference-gated secondary channel of email/telegram/whatsapp, catalog-driven copy localized in en/fr/pt/es/ar with a startup completeness assert). They are deliberately **not** DRY'd into one generic stack: the copy is written per-audience and the situations barely overlap. When adding a situation, add its `base` copy in **all five languages** or the consumer throws at boot.

**Derive the Mongoose enum from the type union — never hand-maintain both.** Each stack exports a `*_NOTIFICATION_TYPES` array that the schema `enum` spreads. This is not tidiness: the agent stack kept two copies and they drifted, leaving all eight `agent_contract.*` situations in the union and absent from the enum, so every contract notification threw a `ValidationError` and the agent was simply never told. The same applied to its `aggregateType: 'contract'`. Covered by `npm run test:customer-notifications`, which asserts catalog↔enum agreement for **both** stacks.

**`shipment.status_changed` now carries descriptive fields, and that is NOT a geo-tracker change.** `trackingNumber`, `failureReason` and `failureNote` were added for the customer stack's "on its way / attempt failed" copy. `TrackingEventSubscriber` reads *named* fields into a fixed outbox row, so anything it does not name never reaches geo-tracker — this was a one-sided change. They are taken from the shipment the CAS returned, not re-read: `delivery_failures` is append-only and `failed → in_transit → failed` is an allowed cycle, so a later read would describe the wrong attempt. Three subscribers share this event (tracking, assignment, customer notifications); none branches on the new fields.

**`renderTemplate` tidies whitespace after substitution.** Several situations end in an optional sentence (`{{codLine}}`, `{{reasonLine}}`), and an empty one otherwise leaves a trailing or doubled space that reaches push and email un-trimmed — only the in-app copy passes a `trim: true` Mongoose path. Runs of *spaces/tabs* are collapsed, never newlines: no catalog template contains one today, but a multi-paragraph email body added later must not be flattened.

**The customer stack is the newest, and two of its rules are its own.** (1) Times are formatted in the **customer's** timezone (`Customer.timezone`) before reaching a template — a reminder printing a UTC instant is worse than no reminder. (2) **Some situations cannot be muted.** Money (payments, refunds, balance due) and cancellations carry no key in `SITUATION_PREFERENCE`, so no preference silences them; a customer is the *counterparty* to someone else's action there, not the owner of a dashboard. Only progress reporting is gated (`bookingUpdates`, `bookingReminders`, `orderUpdates`; `marketing` is reserved and defaults **off**). Several events are consumed by two stacks at once (`booking.created`, `order.created`) — one event, two audiences, two entirely different messages, exactly as `cod.deposit.recorded` already works across agent and agency. Deep links use `STOREFRONT_URL`. The agent stack is the newest and narrowest — it exists because the COD cash chain moves an agent's money on an agency's say-so, and the agent needed a durable record of it (`cod.deposit.recorded` with no prior declaration is the agent's only signal that an agency under-recorded a hand-over). Some events are shared: `cod.deposit.recorded` is consumed by both the agent handler (all cases) and the agency handler (direct-to-platform only), each no-oping on payloads that are not theirs — the same pattern the `connection.*` events use across vendor and agency.

### Domain events (`src/core/events/event-bus.ts`)
In-memory, **per-process**, no persistence and no retry — a `Map<eventType, handler[]>` where `publish` awaits handlers in sequence and swallows their errors. Anything that must survive a crash or cross a process boundary needs its own durable buffer on top (this is exactly why the geo-tracker integration has an outbox).

Emission convention is **post-commit and fire-and-forget** (`void eventBus.publish(...).catch(log)`), so an event is never inside the transaction that caused it. See the caveat under `tracking-integration` below.

### Agent vs agency actions (important)
Shipment status transitions are **driven by either the agency or the agent** — two doors onto one state machine. `PATCH /api/agency/shipments/:id/status` → `ShipmentService.updateStatus(agencyId, …)` and `POST /api/agent/shipments/:id/status` → `ShipmentService.updateStatusByAgent(agentId, …)`. Both are thin ownership-scoping wrappers over a shared private `_transitionStatus`; the actor is a discriminated union, and only three things differ:

| | agency | agent |
|---|---|---|
| ownership scope | `findByIdAndAgency` | `findByIdAndAgent` (404, never 403) |
| transition map | `TRIGGERABLE_TRANSITIONS` | **the same map** |
| `status_history.changed_by_role` + audit `actorRole` | `'agency'` | `'agent'` |
| optional failure `reason`/`note` | no | yes, on `failed`/`returned` |

**There is ONE transition map, shared.** The agency and the agent have the same rights over the lifecycle — the agent is the person physically doing it, and the agency endpoint is the desk mirroring that. In particular `handing_over → picked_up|returned` is agent-reachable: **a reassigned shipment is not a second-class one**, and the replacement agent records their own pickup out of `handing_over` exactly as the original agent does out of `assigned` (acceptance binds `agent_id` while the status is still `handing_over` — see `bindAgentIfUnassigned` and `OFFERABLE_STATUSES`). If the two ever genuinely need to diverge, split the map and select on `actor.role` in `_transitionStatus` — don't let a role-specific exception creep into the shared one.

**Both paths write through a from-guarded compare-and-set** (`ShipmentRepository.applyStatusChangeIfCurrent`, filter `{ _id, status: fromStatus }` + the actor's ownership predicate) under `runInTransactionWithRetry`, and a miss is `409 SHIPMENT_STATUS_CONFLICT`. This is load-bearing now that two actors share the document: without it both can read `in_transit`, one write `agent_delivered` and the other `failed`, and the loser's post-commit block (earnings split, capacity release, COD return handling) still fires for a status nobody is in. Every side effect reads the document the CAS returned, never a fresh `findById` — verdicts must describe the status the event was emitted *for*.

The agent may attach an optional `reason` (`ShipmentFailureReason` — a **distinct** enum from `AgentCancellationReason`, see the model) + `note` on `failed`/`returned`; it is appended to the shipment's **append-only `delivery_failures`** array in the same atomic write as the transition. Append-only because `failed → in_transit → failed → returned` is an allowed cycle and each attempt's reason is the record. The agency endpoint stays reason-less by design.

The agent's other self-service write paths *on shipments*: **accept/reject an assignment offer** (`POST /api/agent/offers/:id/{accept,reject}` — the agent-acceptance workflow, see below), `POST /api/agent/shipments/:id/cancel` (release + re-offer mid-delivery), and `POST /api/agent/shipments/:id/cod/collect` (delivery-code submission — the only *API* by which a COD shipment reaches `delivered`).

**The tracking number is generated, not written.** `PATCH /api/{agency,agent}/shipments/:id/tracking-number` is **gone** on both roles: `ShipmentRepository.create` stamps every shipment with `ACR-YYMMDD-HHMMSS-XXXXX` (agency acronym from its Magazin name · UTC creation date · UTC time · 5 Crockford-base32 characters) via `shipments/utils/tracking-number.generator.ts`, and nothing else ever writes the field. Generating it in `create` rather than at the two call sites is the point — a third call site cannot forget. The acronym is **snapshotted**, never re-derived: an agency rename must not rewrite the reference a customer is already holding. Uniqueness is a partial unique index on `tracking_number` (partial so legacy `null`s don't block the build) with a pre-check in the generator; legacy rows are filled by `npm run backfill:shipment-tracking-numbers`. Pure parts are covered by `npm run test:tracking-number` (26 assertions, DB-free).

Agent-driven `picked_up`/`agent_delivered`/`failed`/`returned` also emit `shipment.agent_status_changed`, which the agency notification stack renders (`in_transit` is excluded as a routine progress ping). **geo-tracker needed no change**: `actor_role` is a free TEXT column there and already receives `'agent'` from the COD collect path.

### Agent-acceptance workflow (`src/modules/shipment-assignment/`)
Assignment is **offer-based, not a direct push**. `PATCH /api/agency/shipments/:id/assign-agent` (and `POST …/auto-assign`, gated by the agency's `assignment_settings.auto_assign_enabled`) create a `ShipmentAssignmentOffer` the agent must **accept** before the shipment is theirs. The shipment stays `assigned` (to the agency) with `agent_id = null` until acceptance — the moment `agent_id` is written, the shipment becomes trackable and (COD) the delivery code issues. **No new shipment status was added**, deliberately: that enum is the geo-tracker contract. State is mirrored on a `shipment.assignment` sub-doc (`unassigned | offered | accepted`), which is *not* the status. Auto-assignment is a **broadcast over a ranking session**, not a one-at-a-time relay: `autoAssign` ranks eligible agents nearest-first (Geo Provider road-network matrix, haversine fallback; location + trust gates on top of eligibility) and snapshots the pool onto a `ShipmentAssignmentSession`. The sweep (`AssignmentSweepWorker`, 30s) offers the next-nearest each `SHIPMENT_OFFER_TIMEOUT_SECONDS` (120s) window **while earlier offers still stand** — so several agents can hold a pending offer at once and the first to accept wins (a shipment-level bind CAS); a reject advances immediately, an ignore keeps an acceptable offer (**auto offers never expire** — only manual ones do, via `expireDueOffers`). After `MAX_ROUNDS` (2) passes — round 2 re-nudges ignored offers — the agency is told `shipment.assignment.unfilled`. An agent cancelling mid-delivery resumes the broadcast from its cursor; the session is disposed only on `delivered`/`returned`/`rejected`. Capacity admission control (`AgentCapacityService.tryReserve`/`release`) — previously inert — is now live: reserved on accept, released on `delivered`/`returned`/`rejected`, reconciled nightly. Full design in [SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md); API in `api-doc/agent/offers.md` + `api-doc/agency/assignment.md`.

**Auto-assignment** (the system-driven branch) is documented separately in [AUTO-ASSIGNMENT.md](./AUTO-ASSIGNMENT.md). It ranks up to 20 eligible agents nearest-first via geo-tracker's routing matrix (`GeoRoutingClient`, haversine fallback — geo-tracker stays off the critical path), stores the ranking as a temporary `ShipmentAssignmentSession` (cursor + round + state; deleted when the shipment finishes), and broadcasts down it one candidate per 2-min window across **two rounds**. Several agents can hold an acceptable offer at once — "first valid approval wins" is enforced by a shipment-level CAS (`ShipmentRepository.bindAgentIfUnassigned`) under `runInTransactionWithRetry`, **not** by an offer-uniqueness index (that index was removed). An agent may **cancel mid-delivery** (`POST /api/agent/shipments/:id/cancel`, reason enum + ≤200-char note) — `ShipmentService.releaseForAgentCancel` releases them and the broadcast **resumes from its cursor**. The `AssignmentSweepWorker` drives session advancement + manual-offer expiry, multi-instance-safe via guarded compare-and-set.

**Agent → agent reassignment** (`POST /api/agency/shipments/:id/reassign`, `ShipmentAssignmentService.reassign` → `ShipmentService.reassignAgent`) changes the agent handling a shipment — the critical case where the bound agent picked up but cannot deliver. It **releases** the old agent (session closed, not terminated — a `shipment.agent_released` event; capacity returned) then re-offers to a replacement who must accept before their tracking opens, so two agents are never tracked for one shipment. Detach is a guarded compare-and-set (`claimForReassignment`, the race guard → `SHIPMENT_REASSIGNMENT_CONFLICT`). Pre-pickup it resets to `assigned` (auto or manual); **post-pickup (`picked_up`/`in_transit`/`failed`/`returned`) it enters `handing_over`** — a new, trackable, non-terminal status that lasts until the replacement picks the parcel up — and is **manual-only** (`agentId` required). `reason` is mandatory. `handing_over` is a jovi-mall-only status addition (added to `TRACKABLE_SHIPMENT_STATUSES`, `ACTIVE_SHIPMENT_STATUSES`, fulfillment `SHIPPED_OR_BEYOND`); geo-tracker consumes the trackable *verdict*, not the status, so it needs no enum change.

**Secure handover:** clearing `agent_id` on detach revokes the old agent's access to customer PII, live tracking and shipment actions (all `findByIdAndAgent`-scoped → 404); they keep only their accepted-offer activity history and get a `shipment.reassigned_away` notification. **Dynamic pickup location** (`HandoverPickupService`): where the replacement collects is derived from the status at reassignment — `previous_agent_location` (picked_up/in_transit, from `last_known_tracking_state.last_position`), `original_pickup` (returned), `agency_business` (failed) — always overridable by the agency (`pickupLocation` in the body, `source: 'manual'`). It is stored on `shipment.handover.pickup` and mirrored onto the replacement's offer (`pickup_location`). A settled order is never re-opened (completed-order guard). Full design in [SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md).

### The COD cash chain (`src/modules/cod/`)

Cash normally travels **Customer → Agent → Agency → Platform**, mirrored by two *independent*
liability balances: `collect()` credits the agent AND the agency, and each is discharged separately
(agent by an `AgentDeposit`, agency by a confirmed `AgencyRemittance`). The agency owes the platform
whether or not its agent has paid up — that independence is what caps the platform's exposure, and
must not be "simplified" into one balance.

**Every leg is two-sided, and each in its own way.** Customer→agent is proven by the delivery code (a
secret the payer holds). Agency→platform is declare + admin-confirm with an external transfer
reference. Agent→agency was the odd one out until step 3f — the agency simply typed a number, which
made its account of a handover unfalsifiable and left the agent wearing a `late_deposit` trust
penalty for cash the agency had not recorded. It is now declare (agent) → confirm/reject (agency),
with the agency's one-step `record()` kept for the desk. **A declaration moves no money** — that is
what stops an agent freeing their own headroom by lying.

`AgentDeposit.recipient: 'platform'` lets an agent bypass the agency entirely: it settles both legs
in one row (agent, contract, *and* the agency's liability + FIFO collection settlement). It is
bounded by the agency's live liability — if the agency already remitted that cash, the platform is
square and the agent genuinely owes the agency, so paying the platform again would only create a
refund obligation.

**COD delivery is closed to every other path, and that is deliberate.** For COD, `delivered` ⟺ cash collected — `recomputeCodPaymentStatus` derives the order's payment status from that equivalence, and `splitCodCollection` only ever runs off a collection, so a COD shipment that reaches `delivered` without one leaves an order that is delivered, completed, and that **nobody is ever paid for** (not even the vendor), with a payment status that is a lie. Consequently: the customer's `confirm-delivery` endpoint **rejects COD** (their code is their confirmation), and the shipment auto-confirm sweep does **not** confirm COD — it routes through `CashCollectionService.autoCollectWithoutCode`, which records the cash and delivers in one transaction. Any new route to `delivered` must go through a collection too.

### The earnings split (`src/modules/earnings/`)

One order's gross is divided across **two moments**, and that is the whole design. At **payment**
(`splitOrder`) only the platform commission and the vendor's net are allocated. The vendor's net is
already reduced by the delivery fee, but that fee is deliberately **not** given to anyone yet: at
payment success the shipments exist at `pending` with `agent_id: null`, and the agent who will earn
a share of that fee has not been dispatched. At **delivery** (`splitShipmentDelivery`, hooked
post-commit on `agent_delivered`/`returned` in `ShipmentService.updateStatus`) the fee is divided
between the agency and the agent who actually ran it.

```
gross = commission + vendorNet + Σ per shipment(agency + agent + vendor refund)
```

COD is the same shape with a different trigger: `splitCodCollection` pays all four parties off the
verified cash handoff, because that is when both the cash and the agent are known. **A prepaid
order never reaches `splitCodCollection` and a COD order never reaches `splitOrder`.**

Four rules that are load-bearing:

- **The agent's cut comes OUT of the agency's fee, never on top** (`fee_split` on their contract,
  clamped to the fee). The vendor pays the same either way. The agency *owes* it; the **platform
  pays** it, through the agent's own `EarningsAccount` — nobody is paid off-platform.
- **`delivery_fee_snapshot` on the Shipment is the contract between the two moments.** The fee
  derives from the agency's *mutable* `policies.pricing`; splitting at delivery would otherwise
  divide a different number than the vendor was charged. `splitOrder` writes it, the delivery split
  divides exactly it.
- **`EarningsCompletionService.onOrderCompleted` must sweep EVERY source type an order produced** —
  `order`, `cod_collection` *and* `shipment`. `markCompletedBySource` is keyed by source, and
  `findMaturedHeld` skips a null `hold_release_at`, so a source it forgets is money held forever.
  This has already been caught once (COD) and is the first thing to check when adding a source type.
  It is also what makes the hold uniform: **every actor on an order matures on the same date**,
  `HOLD_DAYS` (7) after the order completes — never at delivery, never per shipment.
- **A `returned` shipment still splits**, at the agency's `additional_fees.rto_fee` (clamped),
  with the unspent remainder credited back to the vendor. `failed` does not: it is not terminal
  (`failed → in_transit | returned`), so `failed_delivery_fee` needs its own charge path.

Both splits are post-commit and best-effort, so both have a recovery stage in
`EarningsReleaseWorker` (`recoverMissedCodSplits`, `recoverMissedDeliverySplits`).

**Payout destinations are ONE schema for all three owners** (`src/core/types/payout.types.ts`):
vendor, agency and agent each store an ordered `IPayoutMethod[]` (1–3, index 0 preferred), and
`PayoutRequest` snapshots index 0 at request time. Adding a *kind* means the discriminated union,
the Mongoose sub-schema, `maskPayoutMethods`, the vendor and agency DTOs' own copies of the masker,
and `describePayoutMethod` — five places, none of which the compiler will point you at except the
DTOs. The three kinds are `mobile_money`, `bank` and `card`.

**Which kinds may be CONFIGURED is a switch, separate from which exist** —
`ENABLED_PAYOUT_METHODS`, currently `['mobile_money']`. Two schemas express the split:
`PayoutMethodShapeZodSchema` is what a payout method *is* (all three kinds, always), and
`PayoutMethodZodSchema` — what every write path parses with — is the switch **piped in front of**
it, so a client posting a half-filled bank form hears "not available right now" instead of
"bank_name is required". Three things deliberately ignore the switch: reads (`maskPayoutMethods`
and both DTO maskers), the payout pipeline (`resolvePreferredPayoutMethod`, `describePayoutMethod`),
and the Mongoose enum. Switching a kind off must never hide an owner's stored destination or strand
money already addressed to one — it closes the door on *new* configuration only. Re-enabling is
adding the string back to that array; the tests assert the current setting rather than a hardcoded
one, so they follow it.

**`card` holds no PAN and no CVV, and that asymmetry with `bank` is deliberate.** A card's account
number *is* the PAN, so storing it the way `bank.account_number` is stored would put every
collection in PCI-DSS scope — the opposite of the rule `UserPaymentMethod` already established. A
card is identified by brand + last4 + holder + expiry, and the transfer rides an optional
`gateway_token`. The validator **refuses** `number`/`pan`/`cvv`/… rather than letting Zod silently
strip them: a client that gets a 200 back would otherwise reasonably believe the number is on file.
Don't "fix" that by adding the field. Contract is documented **per role** —
`api-doc/{vendor,agency,agent}/payout-methods.md`, one schema written out three times because each
role reaches it through different endpoints; change the schema and all three need the edit. Covered
DB-free by `npm run test:payout-methods`.

**All of the fee arithmetic lives in `EarningsQuoteService`, and `EarningsSplitService` calls it** —
that is what stops what somebody is *quoted* drifting from what they are *paid*. Four pure,
DB-free functions divide every delivery, and **both sides of the fee are named**:

| Function | Answers |
|---|---|
| `resolveEarnedFee(outcome, reservedFee, policies)` | what the run earned out of the reserved fee — the whole fee `delivered`, the clamped `rto_fee` `returned` |
| `applyFeeSplit(fee_split, earnedFee)` | the **agent's** cut, clamped to `[0, fee]` |
| `computeCodHandlingFee(config, collected)` | the COD charge, percentage-of-cash or fixed |
| `computeAgencyCut(earnedFee, agentCut, codFee)` | the **agency's** share — the complement of `applyFeeSplit` |

`agentCut + computeAgencyCut(...) === earnedFee` always. Covered DB-free by
`npm run test:earnings-quote` (29 assertions), which re-derives both split paths from these helpers,
so changing either side breaks the test. Add a fee component here, not at a call site.

Both roles are quoted from them before the money moves: `quoteForShipment(s)` is the **agent's**
offer-time estimate, `quoteAgencyForShipment(s)` the **agency's** (`earnedFee − agentCut +
codHandlingFee`, itemised) on their shipment list and detail. The agency's quote reports
`agencyEarningUnavailable: 'no_agent'` rather than a figure while a shipment is still out on offer —
there is no `fee_split` to subtract yet, and quoting the gross fee would show a number that drops the
instant somebody accepts. A missing *contract* is not unavailable: the cut is 0 and the agency keeps
the whole fee, which is exactly what the split does.

### Agent domain (`src/modules/agents/`)
The agent is a **platform identity, not an agency-owned record** — they sign up independently and may serve **several agencies at once**. `DeliveryAgent.agency_id` no longer exists; the relationship is `AgentAgencyMembership` (one row per agent↔agency), with `AgentMembershipEvent` as its append-only history.

**The rule for any new agent field: if the value could differ per agency, it belongs on the membership.** Employment terms and the COD exposure cap are per-membership; identity, trust score, availability, device and tracking permission are per-agent.

**The handshake is symmetric, and the terms are NEGOTIATED.** Both directions —
`requestFromAgency` (an agency naming a specific agent, **terms required**) and `requestToJoin` (an
agent applying, terms optional) — land in `pending`; neither shortcuts to `active`.

Who may answer is derived from **`terms_proposed_by`**, not from `origin`, by
`AgentContractService.proposerOf`: the counterparty of the standing proposal `approve`/`reject`s or
**counters**, the proposer `withdraw`s, and asking for the wrong one is a 403. A counter overwrites
the terms, flips `terms_proposed_by` and bumps `terms_version` — which is exactly what `origin`
cannot express, being immutable. `origin` survives as audit plus the **fallback** for legacy rows
(`proposerOf` reads it when `terms_proposed_by` is null), which reproduces the old behaviour
exactly. The DTO exposes the verdict as **`awaitingDecisionFrom`**; `initiatedBy` is still there but
is no longer the button rule.

Scoping *all three* of approve/reject/withdraw to the proposer is load-bearing, not tidiness. Key
`withdraw` on `origin` instead and an agency-invited contract the agent counters leaves the agency
two exits (withdraw as initiator, reject as counterparty) and the agent **none** — trapped inside
their own counter-offer. See `PROPOSER_SCOPED_TRANSITIONS`.

**Terms nobody proposed cannot be approved** (`assertTermsApprovable` → 422
`CONTRACT_TERMS_NOT_PROPOSED`). One guard covers three cases: a bare agent join-request, a legacy
row whose fee split was never configured, and the `contractDefaults.feeSplit()` trap — a
`percentage` model with a null share, which `applyFeeSplit` resolves to a cut of **zero**. Before
this, approving such a contract bound the agent to being paid nothing and nobody was asked.

**A live contract's terms change by proposal, never by edit.** `ContractTermsProposal` is a separate
collection precisely so the agreed `fee_split` keeps applying while a change is pending —
`EarningsQuoteService` goes on dividing by it, unaware the model exists. `PATCH …/terms` is
status-aware: on `pending` it delegates to `counterTerms` (one code path, no drift); on a live
contract it is **409 `CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED`**. Formation and amendment differ
because a pending contract *is* the offer while a live one *has* one — don't unify them.

The agent's levers are **`fee_split` + `coverage` only** (`AGENT_NEGOTIABLE_TERM_GROUPS`).
`employment` and `cod.threshold` are outside negotiation entirely and keep their own unilateral
routes — the first is the agency's HR record, the second a pool sub-allocation that must stay
transactional.

**Discovery is the front door, and the email-invite subsystem is gone.** `AgentInvite` (model,
repository, service, and all six routes) was deleted: an agency finds agents through
`GET /api/agency/agents/browse` and requests one by id, and an agent finds agencies through
`GET /api/agent/agencies/browse`. `AgentDirectoryService` owns both, deliberately apart from the
contract FSM. The directory's hard filter is `assertCanHoldContract` plus completed onboarding —
listing an agent who cannot accept would render a button whose request dead-ends. Exposure is a
**public work profile only**: `AgentDirectoryMapper` never emits email, phone, `legal_identity`,
`payout_details`, `emergency_contact`, device telemetry or raw capacity counters, and load is the
`working_state` label rather than a count. `AgentRosterEntryDto` *does* carry contact details — the
two DTOs answer different questions and must not be merged. The cost of dropping invites, accepted
knowingly: an agency can no longer approach someone who has not signed up yet.

**The whole surface is an endpoint-for-endpoint mirror of `agency-connections/`, on purpose.** Four
verbs — `approve`, `reject`, `withdraw`, `terminate` — mean the same thing on all four routers of
both flows, plus `browse` / a request POST / a paginated list / a single GET. Don't reintroduce a
role-specific spelling: the HTTP verbs used to say `accept`/`decline` on one side while the FSM said
`approve`/`reject`, and that split bought nothing. `POST /:id/terminate` is canonical on the agency
side; `DELETE /:membershipId` is the same handler under its original name. `deactivate` is
deliberately **not** in `RequestTransitionSchema` — `/terminate` owns it, and leaving it in the
dispatcher would be a second way to end a contract with a different status code.

**Both list endpoints return every status by default**, terminal rows included, and paginate exactly
like `ConnectionRepository.listForVendor` (`{ data, meta: { total, page, limit, pages } }`, renamed
to `totalPages` on the wire). The old live-only default made a relationship history impossible to
fetch. Nothing on the dispatch path reads them — eligibility and COD go through `findActive` /
`findLive` / `listAllocating`, which are still status-scoped. The admin agent view uses
`listAllForAgent` and stays unpaginated: an investigation must not lose rows to a page boundary.

Four state axes are kept deliberately separate — collapsing any two makes "is he offline, or just full?" unanswerable:

| Axis | Question | Written by |
|---|---|---|
| `status` | may this account work at all? | admin |
| `availability` | does the agent *want* work now? | the agent |
| `working_state` | how loaded is he? (derived from shipment counts) | system |
| `tracking.allowed` | may he be tracked? | admin (`PUT /api/admin/agents/:agentId/tracking-allow`) — there is no agency or agent write path |

Two more are worth knowing because nothing agent-facing writes them either: `kyc.status` (admin;
**eligibility passes only on `verified`**, so an unverified agent is undispatchable) and
`capacity.max_active_shipments` (the billing plan, via `AgentPlanCapacityConsumer` — never the
agent, or a plan renewal would undo it). Both are readable on the agent's profile.

Note the two active-shipment counters are **not** interchangeable: `capacity.active_shipment_count`
is authoritative — it is what `tryReserveCapacity` compare-and-sets on accept — while
`working_state.active_shipment_count` is a recomputed input to the label above and can lag it.
Report the former.

Consume the domain through the barrel (`src/modules/agents/index.ts`) — **except routes**, which the API layer imports directly from `routes/*`. Routers pull in `auth.middleware` → `auth.service` → the barrel; re-exporting routes from it closes a require cycle that crashes at boot with "AuthService is not a constructor".

**Eligibility** (`agent-eligibility.service.ts`) gates assignment on the agent: active · approved with the *dispatching* agency · online · tracking allowed · device location not disabled · under capacity. It reports **every** failed rule at once, never just the first. An agent may hold several active shipments — capacity bounds that, and counts across all agencies.

**Contract terms gate the SHIPMENT, and live elsewhere.** `evaluate(agentId, agencyId)` takes no shipment, so a rule that needs one cannot go there. `contract-coverage.service.ts` holds the two pure predicates — `contractCoversRegion` (against `order.delivery_address.components.region`) and `contractAllowsShipmentValue` — enforced in `AssignmentCandidateService.buildRanking` (the auto pool) and in `ShipmentAssignmentService.assertContractPolicy`, which runs on **all three** command paths: `offerToAgent`, `accept` and `reassign`. Gate the ranking but miss a command path and a manual assign silently bypasses the term, which is worse than not enforcing it — the rule would appear to work.

**Everything unknown here FAILS OPEN.** Empty `coverage.regions` is the schema default on every contract ever written, so treating it as "covers nowhere" would make the whole roster undispatchable at once; a missing delivery region (orders predating the snapshot) and an uncomputable shipment value do the same. These are narrowing terms, not authorization — see the header of `contract-coverage.service.ts`.

**Writing coverage is the strict half, and that asymmetry is the design.** `coverage.regions` used to be free text; it is now **picked**, from the agency's country's region catalogue in `locations.json` — the same list the agency's own `coverage_areas` use on its location tab. `normalizeContractRegions` (third pure function in `contract-coverage.service.ts`) canonicalises every write and refuses anything that does not resolve to a region of that country: `"Extrême-Nord"` → `far_north`, `"Douala"` → `400 CONTRACT_COVERAGE_REGION_INVALID`. It runs through **one choke point**, `AgentContractService.normalizeCoverageTerms`, called on all six terms-write paths (both request paths, `updateTerms`→`counterTerms`, `counterTerms`, `proposeTermsChange`, `counterTermsProposalAs`) — a term is only as good as its weakest write path. Reading still fails open for the legacy free-text rows. The catalogue is the **country's**, deliberately not the agency's declared areas (an agency contracts agents for a region before it declares it); the agent side is given `agencyCountry` + `agencyCoverageAreas` on `AgentMembershipWithAgencyDto` so its picker can scope itself and mark what the agency actually serves.

**`remittance_terms` drives the COD late-deposit clock** via `nextRemittanceDueAt` (pure, UTC, `on_demand` ⇒ no deadline ever). `CodDepositDeadlineWorker` iterates **contracts, not cash accounts**: the agent's cash pot is global while the cadence is per-agency, so there is no single deadline to compare a pot against. The `late_deposit` flag is now per-contract while the trust penalty stays agent-global and applied once — four agencies must each learn they are owed, and the agent must not take four penalties for one bad week.

**Device location** is the one input jovi-mall cannot observe; it resolves via `IAgentDeviceLocationProvider` (`ports/device-location.port.ts`), swapped in `agent.bootstrap.ts`. The signal is tri-state and `null` (unknown) must never be coerced to `false` — that would make every agent ineligible the instant geo-tracker went down. Policy for unknown lives in `AGENT_CONFIG`, not in the rule.

**Tracking split:** jovi-mall owns whether tracking is *allowed*; geo-tracker owns *execution*. `agent.last_known_tracking_state` is a business mirror, stale by construction — never serve it as a live position, and no assignment rule reads it.

**The admin tracking flag now actually reaches geo-tracker (Phase 9).** `agent.tracking_allow_changed` was published from the day the flag existed and **nothing subscribed to it**, so disabling tracking refused new dispatch (`assertEligible`) and changed nothing else — the agent kept streaming and kept being broadcast. `TrackingEventSubscriber` now enqueues an `agent.tracking_allow_changed` outbox row carrying `trackingAllowed` and **no shipment verdicts** (it says nothing about any shipment), the dispatcher POSTs it to `/webhooks/node`, and geo-tracker suppresses the live position. **This changed the outbox event shape, so it was a two-repo change** — `webhook/domain/entity.go` gained `TrackingAllowed *bool` in the same commit. Note what it still does not do: `visible-agents` does not consult the flag, so a watcher is not revoked — they stay subscribed and receive nothing.

Because `assertEligible` requires tracking-allowed before dispatch, geo-tracker **refuses** an agent's attempt to switch Tracking Allow off while they hold an active shipment (it would strand a delivery assigned on that promise). Note what Tracking Allow is *for* on geo-tracker's side: it is the permission to read an agent's **live position at all** — including an agent with no shipment, which is exactly the read that finds the one nearest a pickup. It is not what starts a tracking session; only a shipment is.

Migration for pre-existing data: `npm run migrate:agent-memberships` (idempotent; `--dry-run` supported). The dead `agent_invites` collection is left in place — nothing reads it, and dropping it is a manual call.

### Base repository (`src/core/repositories/base.repository.ts`)
Generic `BaseRepository<TDoc, TDomain>` provides: `findOne`, `findById`, `paginate`, `create`, `softDelete`, `restore`, `hardDelete`. All queries automatically filter `deletedAt: null`. Pass a Mongoose `ClientSession` for transactional operations.

### Storage (`src/core/storage/`)
Factory + Strategy pattern. Active provider is selected via `STORAGE_PROVIDER` env var (`local` | `firebase` | `cloudinary`). Use `getStorageProvider()` singleton — never instantiate providers directly. Interface: `IStorageProvider` in `storage-provider.interface.ts`.

### Geocoding & geospatial addresses (`src/core/geocoding/` + `src/core/types/geo-address.types.ts`)
Same factory + strategy + singleton shape as storage. Active provider is `GEO_PROVIDER` (`nominatim` — the keyless default — `| google | mapbox | here | geoapify`); only Nominatim has an adapter in this build, the factory throws `GEO_PROVIDER_NOT_CONFIGURED` for the rest so the seam stays visible. Use `getGeocodingProvider()`; the interface is `IGeocodingProvider` (`search` + `reverse`). **No business logic ever branches on the provider.** The HTTP surface is `src/modules/geo/` → `GET /api/geo/search` + `GET /api/geo/reverse` (any signed-in role), backing a Maps-style "type → search → select → store" flow.

The stored value object is **`GeoAddress`** (`geo-address.types.ts`): `formatted_address` + `coordinates` (GeoJSON `[lng,lat]`) + `provider` + `provider_place_id` + structured `components` (city/region/country/postal…) + `raw_input`. It is embedded at all five address sites — customer `saved_addresses[].geo`, vendor `business_addresses[].geo`, agency `headquarters_addresses[].geo`, the order pickup snapshot (`items[].delivery.pickup_location.address_snapshot.geo`), and the order **drop-off** (`order.delivery_address`, snapshotted at checkout). Adoption is **additive**: legacy loose fields are kept and geo is optional at the schema level, enforced on write by the Zod validators; use `toGeoAddress` / `withGeoAddress` (`geo-address.types.ts`) to normalise a validated candidate before persisting. A `2dsphere` index sits on every `…geo.coordinates`. Full contract: `api-doc/geo/README.md`.

Geocoding lives in jovi-mall by the governing rule: an address is order/profile-model data, and jovi-mall owns that — geo-tracker owns live positions and road networks, not address resolution. The order's durable geocoded drop-off is **available to geo-tracker routing** but was a **data-only** change: no outbox event shape changed, so geo-tracker code is untouched.

### Pickup locations, and which agency depot (`agency_address_id`)

A physical product's `delivery.pickup_location` is `{ source, vendor_address_id, agency_address_id }`, and **exactly one id is meaningful per source** — `mergeDeliveryConfig` normalises the other to null rather than trusting the caller, so a stale id can't resurface if the source is flipped back.

The two sources snapshot **different amounts** onto the order at checkout, and the asymmetry is the design:

| | `vendor_address` | `agency_storage` |
|---|---|---|
| snapshotted onto the order | the whole address (`address_snapshot`) | only the **choice** (`agency_address_id`) |
| address resolved | frozen at checkout | **live**, every read |
| why | it is the vendor's record of a place they chose per product; history must not re-point when they edit their profile | the depot's address is the *agency's* record — an agent must be driven to where it is now, so a corrected typo fixes every in-flight shipment |

**`agency_address_id: null` means the agency's PRIMARY depot** (`headquarters_addresses[0]`), and that is a real steady state, not a missing value: it keeps tracking the primary if the agency reorders. Three populations rely on it — every product predating the depot picker, every auto-derived one (`PickupLocationResolver` deliberately never picks a depot, even when the agency has exactly one), and any product whose depot the agency later deleted. Consequently **activation can never fail over a depot**, and no backfill was needed.

**`resolveHqAddress` (`magazin/domain/hq-address.resolver.ts`) is the only place that fallback lives.** Four readers route an agent off it — `ShipmentService._resolvePickupEntries` + the detail builder, `AssignmentCandidateService.resolvePickupLocation`, and `HandoverPickupService.fromAgencyBusiness` — and they resolve **per item**, not per shipment, because two items can name two depots of one agency (the pickup dedupe then correctly reports two stops). `MagazinRepository.findHqAddressListsByAgencyIds` returns the whole list for the batch paths; it replaced the old index-0 method rather than sitting beside it, so nothing can keep resolving the primary by accident.

**HQ subdocument `_id`s are now a durable reference, and the magazin PATCH is a full-array replace.** `MagazinHeadquartersAddressSchema` accepts an optional `id` that clients echo back; `toPersistableHeadquarters` sets `_id` from it, and falls back to a **one-to-one consuming** content match (`address_description` + `geoAddressEquals`) for clients that don't. An `id` not on the caller's own magazin is `409 MAGAZIN_CONFLICT` — same remedy as a version miss. Both write paths (`PATCH /api/agency/magazin` and onboarding Step 1) must pass the **raw** `headquarters_addresses` for preservation, never the country-gated `existingHq`, or a country change re-mints every `_id` and orphans every product pointing at one.

`PickupLocationValidationService` takes depot **ids** (`string[] | null`) as a required 4th parameter rather than the magazin document — it stays repository-free, and required-not-optional so a new call site must decide instead of silently skipping the check. Both call sites load the list only when a depot was actually named. The vendor-facing picker is `GET /api/vendor/delivery-agencies/:agencyId/locations` (connection-gated) — the one place the "only the primary HQ is exposed" rule in `VendorAgencyMapper.toListItemDto` is narrowly reversed.

Covered DB-free by `npm run test:pickup-depot`.

### Agency inventory (`src/modules/inventory/`)

`agency_stock_levels` — `(agency_id, location_id, vendor_id, product_id, variant_id)` + `quantity_on_hand` / `quantity_reserved` — is the platform's only record of **what an agency warehouses**. Before it, `agency_storage` was a routing flag carrying no quantity and `ProductVariant.stock` was one global scalar with no location dimension. `GET /api/agency/inventory` + `/:id` read it.

**Phase 1 rows are DERIVED, not counted, and the wire says so** (`countsAreDerived` + per-row `source: 'derived' | 'counted'`). `AgencyInventoryReconciler` builds the roster from products whose pickup is `agency_storage` and whose effective agency is this one, one row per active variant; quantities stay **0**. Do not seed them from `variant.stock` — that is the vendor's global number across every channel, and copying it per depot manufactures precision nobody can verify. Reconciliation is **mark-and-sweep** (one shared `last_reconciled_at`, then retire older `derived` rows) and runs debounced on the read path, not from a cron — a derived roster isn't worth a scheduled job, and Phase 2's event-driven quantities are where a worker earns its place. `source: 'counted'` rows are **never** swept: once a row asserts goods are physically present, a config change must not silently delete it.

**`resolveStockLocationId` is not `resolveHqAddress`, and the difference is the whole design.** Both send a product naming no depot to the primary, and a product naming a live depot to that depot. They diverge on a **dangling** id: routing falls back to the primary (an agent must be sent *somewhere*), inventory records **`location_id: null`** and the screen surfaces it as unassigned. Falling back would move goods between buildings on paper. Never call the routing resolver from the inventory module.

**Deleting a depot that holds stock is refused** — `409 MAGAZIN_LOCATION_IN_USE` on both magazin write paths (`MagazinProfileService.updateMagazin`, `AgencyProfileService.persistLogisticsToMagazin`). Removals are diffed against the array `toPersistableHeadquarters` is about to persist, **not** the request: an entry that omitted its `id` may still have kept one by content match, and diffing the raw payload would 409 every save from a client that hasn't shipped the id echo. "Holds stock" is **row existence** in Phase 1 — every quantity is 0, so a `quantity > 0` test would never fire; tighten `countByLocations` when Phase 2 lands. The guard is check-then-write (`updateByAgencyId` is not session-aware); the `version` CAS narrows the race.

**`IShipmentItem.variant_id` exists now and is nullable forever.** Stock lives on the variant, so a delivered shipment previously could not say which variant left. Written at all three construction sites (checkout + both reassignment branches). Nullable because legacy shipments have none and `addItem` uses a raw `$push` no default reaches — readers treat null as "legacy, join `order_item_id` against the order", which is what they already do for title/sku. `sku` is deliberately **not** denormalized: `CashCollectionService.computeExpectedAmount` hard-throws on a missing order-item join where ~14 other readers tolerate it, and a second source of truth would change that failure behaviour for money code.

Covered DB-free by `npm run test:agency-inventory`. Contract in `api-doc/agency/inventory.md`.

**The agency now WRITES, and three of the four writes are one-sided on purpose.** Phase 1
was read-only; `src/modules/inventory/services/agency-stored-product.service.ts` adds
`PATCH /products/:productId/depot` + `POST /products/:productId/{suspend,unsuspend}`, all
keyed on the **product** (the depot lives once on `product.delivery.pickup_location`;
suspension is a product status) and all authorised by the same predicate —
`findRowsForAgencyAndProduct` returning rows. That predicate *is* the storage arrangement,
it avoids a cross-vendor product query, and it yields the `vendorId` each write needs to
stay vendor-scoped. Depot changes go through `mergeDeliveryConfig` and force a reconcile so
the row moves before the next read; they apply with **no vendor confirmation**, because the
depot's address is already the agency's own record (the same reason checkout snapshots only
the depot *choice* for `agency_storage`).

**Suspension reuses `Product.status = 'suspended'` with a fourth reason,
`agency_storage_suspended`.** Two properties keep it from colliding with the
delivery-agency cascade, and both are load-bearing: `DELIVERY_AGENCY_REASONS` is a closed
list that excludes it (so a restore sweep can never lift an agency's leverage — **do not
widen it**), and `suspendVendorPhysicalProducts` only touches `active` products (so the
cascade skips an already-suspended one, and the agency's later unsuspend re-runs the gate
and correctly refuses).

**There are now FOUR disjoint reason sets, and none may absorb another's members.** Vendor
management added `vendor_suspended` (the vendor-level cascade — a system act, reversed by
reinstating the vendor) and `platform_oversight` (one listing removed by an administrator —
a *human* act, so nothing automatic clears it, **including the vendor restore**). That last
exclusion is the point: suspending and reinstating a vendor must not silently republish a
counterfeit listing somebody took down on its merits. `ProductPlatformSuspensionService`
owns both, mirrors `ProductDeliveryAgencySuspensionService` including its `restoreEligible`
re-validation, and covers **every product type** rather than physical only — a suspension
that left the downloads and the bookable services selling would not be one.

The `enum` on `suspension.reason` is now spread from `PRODUCT_SUSPENSION_REASONS` rather
than hand-maintained beside the union — the same rule the notification stacks follow, for
the same reason.

**`ProductStatusValidationService` now blocks activation while the VENDOR is suspended**
(`CATALOG_PRODUCT_VENDOR_SUSPENDED`), as a product-level check that applies to every type.
That is not belt-and-braces: the vendor cascade takes listings down, but three *other*
paths put them back — the delivery-agency cascade, the agency-storage unsuspend, and the
vendor's own activation — and an agency problem resolved while a vendor is suspended would
otherwise walk their catalogue back onto the storefront. Putting the rule in the one
function that answers "may this be on sale" closes all of them at once, and closes the ones
added later by construction. Unsuspend is the one place a 422 carries the whole blocker
checklist (`INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` + `details.blockers`) rather than silently
skipping, because it is an explicit human action. `findAgencyStoredVariants` was widened to
keep `agency_storage_suspended` rows — otherwise suspending a product deletes the row its
own unsuspend button lives on.

**The storage fee is displayed, never charged.** `storage-fee.calculator.ts` is pure and
quotes `monthly_storage_fee_per_sku × quantity`. Two things it deliberately does not do:
it does not price by size (dimensions and volume are surfaced so an agency can sanity-check
a flat rate against what it is shelving — a client must not multiply by them), and it does
not read `quantity_on_hand`, which is Phase 2's and still 0. The quantity is
`ProductVariant.stock`, exposed on the wire as a **separate `catalogStock` block** and never
written into `quantity_on_hand`: the model's prohibition on seeding derived counters from
the catalogue stands. What makes the catalogue number legitimate to bill against is the
stock-request flow below — it is now jointly agreed and guaranteed finite.

### Two-sided stock adjustment (`src/modules/stock-requests/`)

**On an `agency_storage` product, nobody writes `ProductVariant.stock` alone.** One party
proposes, the other approves, and the number moves in the same transaction that records the
approval — a request marked `approved` whose stock never landed would leave the two sides
believing different things about a warehouse. The module is an endpoint-for-endpoint mirror
of `agency-connections/` (`approve`/`reject`/`withdraw` on both routers, per-outcome
sub-documents, every status in the list by default); the FSM mechanics are lifted from
`ContractTermsProposal` — one-open-per-SKU as a partial unique index, and resolution as a
compare-and-set on `status: 'pending'` whose null return is a **conflict, never a
not-found**.

Three things worth knowing before extending it:

- **`resolveAvailableActions` is the single authority table**, read by the service to
  enforce and by the DTO to render buttons. The asymmetry is deliberate: author ⇒
  `withdraw` only, counterparty ⇒ `approve`/`reject` only. A second copy is how a
  dashboard offers a verb the API refuses.
- **The quantity is ABSOLUTE, never a delta.** A delta approved days later applies to a
  number nobody agreed on. `quantity_before` (proposal time) and
  `approval.quantity_at_apply` (approval time) both persist, so drift is *auditable*
  rather than rejected — it is not a 409.
- **`StockChangeGate` intercepts the three existing vendor write paths** (variant PATCH,
  simple-product PATCH, `PATCH /api/vendor/inventory/bulk-update`) rather than sitting
  beside them as an opt-in surface. Leaving those writing directly would make the rule
  advisory — bypassable by not using it. They return **200** (not 202) with
  `meta.stockAdjustment` and an unchanged `data.stock`; bulk-update gains
  `requested[]`/`notRequested[]` siblings to `variants[]`, raised **after** the commit
  because a proposal is not a stock write. *Creating* a variant or a simple product still
  writes stock directly: an initial quantity is a declaration, not an adjustment.

**A warehoused product cannot have unlimited stock**
(`catalog/domain/services/agency-storage-stock.rule.ts`). Enforced in three places from one
definition — as an activation blocker, as a refusal on `ProductUpdateService` when pickup
becomes `agency_storage` (throwing rather than letting `revalidateActiveStatus` silently
demote a live product to `draft`), and at request *creation*, so no approvable request can
leave a product failing its own gate. Deliberately **not** a `stock > 0` rule: that would
unpublish a product the moment it sold out. Pre-existing offenders are listed by
`npm run audit:infinite-agency-stock` (read-only, no migration).

Covered DB-free by `npm run test:stock-requests` (40) and the extended
`npm run test:agency-inventory` (53). Contracts in `api-doc/{agency,vendor}/stock-requests.md`;
the dashboard hand-off is `api-doc/FRONTEND-CHANGELOG-agency-storage.md`.

### Blog / editorial (`src/modules/blog/`)

The marketing site's article pages, in two halves that never touch: a **public reader**
(`/api/public/articles`, no auth, `Cache-Control: public, max-age=300`) and an **editor**
(`/api/admin/articles` + `/api/admin/article-authors`, `requireRole(['admin'])`). Built to
`api-doc/BACKEND-BLOG-REQUIREMENTS.md`; contracts in `api-doc/public/articles.md` and
`api-doc/admin/articles.md`.

**Bodies are typed blocks, never an HTML string, and `article-body.validator.ts` is the security
boundary.** The frontend renders blocks through React components rather than
`dangerouslySetInnerHTML`, so what that Zod union accepts is what renders on the same origin as the
auth pages. It is `.strict()` throughout — an unknown block type *and* an unknown key on a known
block are both 400s. Mongoose stores `body` as `Mixed` on purpose (a parallel sub-schema would be a
second copy of a 9-type union that nothing keeps in step), which makes one rule load-bearing: **no
write path may set a body that did not come through `ArticleBodySchema`.** Adding a block type is a
two-repo change — `ArticleBody.tsx` switches exhaustively over the union.

**One article, many translations — not one document per language.** `hreflang` and the sitemap's
language alternates are only reconstructible if the languages are one document. The corollary is
that **a missing translation is a 404, never a fallback**: serving English at a Portuguese URL
publishes a page contradicting its own `lang` attribute and competing with its own original. The one
deliberate fallback in the module is the **author bio** (`toPublicAuthorDto`), because a blank byline
where the structured data expects an author is worse than a bio in the wrong language.

**`slug_keys` exists because MongoDB refuses the index you'd reach for first.** A compound unique
index on `translations.locale` + `translations.slug` is two parallel array paths and is rejected at
write time, so every `(locale, slug)` pair is flattened to `"<locale>:<slug>"` in one array with an
ordinary unique multikey index. It holds **retired slugs too**: a renamed slug keeps answering
(`404 BLOG_ARTICLE_MOVED` carrying the current one) and no other article can claim it, because a
reused slug turns a permanent redirect into a wrong answer. `buildSlugKeys` derives it on every
write — never set it by hand.

**The redirect is a machine-readable hint, not an HTTP redirect, and that is the correct split.**
This API can only redirect its own URL; the address needing the 301 is the *page*, which only the
frontend can emit. Same reasoning behind `410 BLOG_ARTICLE_GONE` carrying `categoryKey`.

**`draft` and `archived` are both invisible publicly and are not interchangeable** — a draft 404s
(never live), an archived article 410s with its hub (was live, has inbound links). That is why
`DELETE` is refused once `published_at` is set, and why a preview is
`GET /api/admin/articles/:id/preview` returning the *public* DTO behind the admin guard rather than a
flag that returns drafts from the public route.

**`content_updated_at` is stamped from a content comparison, not from Mongoose's `updatedAt`.**
`featured`, `categoryKey` and a translation's `published` all move the document; stamping off the row
would put a `dateModified` in the structured data for a revision that never happened. `contentChanged`
fingerprints only what a reader sees. Likewise `wordCount` is derived on write and `readingMinutes`
is deliberately **not sent** — the frontend computes it from the body it is about to render.

Two rules the requirements ask for that are **not** enforced in code, by agreement: no prices in
article bodies (they go stale silently — link `/pricing`), and no invented metrics.

Covered by `npm run test:blog` (100 assertions, DB-free) and `npm run verify:blog` (47, needs Mongo —
index builds, the whole lifecycle against real persistence, and that `/articles/index` is declared
before `/articles/:slug`). `npm run seed:blog` creates the house byline; **no articles are seeded**,
deliberately.

### Payments (`src/modules/payments/`)
Gateway-agnostic orchestrator (`PaymentOrchestratorService`) supports Stripe (cards), NotchPay, and MyCoolPay (mobile money). Each gateway implements `PaymentGateway` interface. Webhook payloads are deduplicated via hash before processing.

**`refundPayment` serves BOTH payable things** — orders and bookings — via a `RefundSource` discriminated union. Only four points branch (the payment lookup, the `RefundTransaction` foreign key, the source-status write, the earnings reversal); the money invariants in between are shared *on purpose*, so a second implementation cannot drift on refundable balance or escrow. Only **Stripe** implements a real gateway refund; NotchPay's and MyCoolPay's are explicitly `PLACEHOLDER` and raise `REFUND_GATEWAY_NOT_SUPPORTED` — callers must handle that as an expected outcome, not a bug.

### Bookings (`src/modules/booking/`) — service products

Services never enter the cart; they are booked. Availability → 15-min Redis hold → booking → payment.

**The booking rows are the authority on a product's own occupancy, not Google Calendar.** This is the load-bearing rule. Availability previously derived busy time from the calendar alone, so a `manual` booking — which writes no calendar event until the vendor accepts it — never blocked its own slot and the same hour could be sold without limit. `ProductBookingService.getAvailability` now subtracts `fullWindows(bookedWindows, seats)` for **every** mode; the calendar only ever *adds* the vendor's other commitments on top. Consequences that follow, and must not be "simplified" back:

- Calendar writes are **best-effort everywhere** (create, reschedule, capacity). A Google outage can no longer reject or lose a confirmed sale, and a vendor with no calendar connected still sells correctly. Safe *only* because of the rule above.
- `AvailabilityService` **unions** persisted `ExternalCalendarBlock` rows with a live query rather than choosing one. Subtracting an interval twice is idempotent, so a union only ever over-blocks (self-healing on the next sync) and never under-blocks. `InboundCalendarSyncWorker` is registered in `server.ts` and keeps that cache warm.
- `createBooking` re-checks overlap and inserts **inside one transaction** (`BOOKING_SLOT_UNAVAILABLE`, 409). The Redis hold is the first line of defence; it evaporates if Redis restarts, so the CAS is what actually guarantees single occupancy.

**Wall-clock times resolve in the VENDOR's timezone.** `Vendor.timezone` (required, defaults `Africa/Douala`) is the source of truth; `AvailabilityRule.timezone` is now an optional per-rule override, not a `'UTC'` default nobody read. Both availability windows and the peak-hours surcharge go through `booking/utils/availability-timezone.util.ts` — never `setHours`/`getHours`, which resolved against the *server's* clock and shifted every vendor's day when the server moved. `npm run migrate:booking-rule-timezones` (idempotent, `--dry-run`, reports every rule whose hours would move) clears legacy `'UTC'` rows to inherit.

**The pure window arithmetic lives in `booking/utils/availability-windows.util.ts`**, extracted off `AvailabilityService` so it can be tested without Mongo *and* Google. Every availability defect found in review lived there — notably `clipWindow`, which now trims a window to the query range instead of discarding any window not wholly inside it (a mid-day query used to lose the whole day, indistinguishable from fully booked). Covered DB-free by `npm run test:booking-availability` (54).

**Cancelling a paid booking refunds it** (`BookingRefundService`), from **both** the customer and vendor paths — neither refunded anything before. Auto where the gateway supports it; otherwise `paymentStatus: 'refund_pending'` + a HIGH ticket for manual payout, with earnings reversed either way. A refund failure never blocks the cancellation: releasing the slot matters more, and money owed is recoverable from the ticket.

**The customer surface is `/api/customer/bookings`** (list · detail · cancel · reschedule), beside `/customer/orders`. Before it, a customer could pay and then do nothing — `cancelBooking` was fully written, complete with `assertCancellationAllowed`, and simply had no route, so the vendor's cancellation policy was enforced *nowhere*. `UnpaidBookingCancelWorker` sweeps confirmed-but-unpaid bookings (never `pending` ones, which await the vendor).

**The completion balance is REQUESTED, never auto-charged.** `CompletionPricingService` used to compute a shortfall, bury it in `metadata` and stop. It now writes a first-class `booking.settlement` (`finalPrice`, `balanceDue`, `balancePaid`, `creditDue`, indexed for the vendor's outstanding-balance report) and asks the customer for it (`booking.balance.due`). Three rules hold it together:

- **The balance is measured against what was PAID, not what was quoted.** `max(0, finalPrice − amountPaid)`, where `amountPaid` is 0 unless the booking is `paid`. Comparing to `priceSnapshot` billed an unpaid customer only for the overrun and let the original price vanish.
- **Charging is the customer's action.** They agreed to the quote, not to whatever the vendor settles at afterwards. They pay via `POST /api/customer/bookings/:id/pay-balance`, or the vendor records cash via `POST /api/vendor/bookings/:id/settle-balance` (clamped to what is owed, so a mistyped amount cannot inflate earnings).
- **A balance payment is a SECOND payment on the same booking**, discriminated by `PaymentTransaction.purpose = 'booking_balance'` (default `'primary'`, so no migration). Without it the webhook's already-paid early return swallows it. It splits through `splitBookingBalance`, which uses its own source id — `('booking', bookingId)` is already taken by the original — and matures immediately, since the completion that would otherwise start the hold clock has already happened.

`creditDue` (settling *below* what was paid) is **recorded, not refunded**, by explicit product decision — usually a goodwill discount the vendor hands back themselves. It is surfaced so it is at least visible.

**Customers are notified now** — see the notifications section. `BookingReminderWorker` fires ~24h before `startAt`, which the platform owed them: it records `no-show` against people it had never once reminded. Each sweep covers `[now+lead, now+lead+interval)` so consecutive passes tile exactly, and the idempotency key makes a replay harmless.

### Redis (`src/infra/redis/redis.factory.ts`)
Uses dedicated DB indices (3–10) per feature (email tokens, WhatsApp codes, booking slot locks, download tokens, etc.). Connects lazily — **never at boot**, which is why the readiness probe treats it as non-required (see System operations above).

`REDIS_DB_CATALOG` is the table three separate features needed (`/system/dependencies`, `/system/cache`, the flush allowlist) and which previously existed only as trailing comments on the eight constants. The constants stay exported, so no call site changed.

Two accessors, and they are not interchangeable: `getRedisClient(db)` connects if needed (real work, and the cache flush); `peekRedisClient(db)` returns an already-open client or null and **never connects** (every diagnostics read). `redisClientSnapshot()` hands out data rather than handles — exporting the `clients` map would let a caller `quit()` a client out from under a live request.

### Live tracking integration (`src/modules/tracking-integration/`)
The whole jovi-mall half of the geo-tracker contract: the durable outbox (`models/tracking-outbox.model.ts` + repository), `services/tracking-event-subscriber.ts` (subscribes to `shipment.status_changed`, `cod.collection.recorded`, and `shipment.agent_released`), `services/visible-agents.service.ts` (**the tracking authorization policy** — admin=all, agent=self, agency=agents on approved+active shipments, customer=agents on active orders, vendor=none), `workers/tracking-dispatch.worker.ts` (drains every 2s, HMAC-SHA256, POSTs), and `GET /api/tracking/visible-agents`.

`shipment.agent_released` is the reassignment release: it carries the **old** agent's id with a forced `shipmentTrackable=false, shipmentTerminal=null` verdict (a *release*, independent of the shipment's resulting `assigned`/`handing_over` status), so geo-tracker closes that agent's session and drops the agency/customer's visibility of them — without terminating the shipment, which a fresh session resumes when the replacement accepts.

**jovi-mall decides when geo-tracker tracks a shipment.** A geo-tracker *tracking session* is one shipment's tracking lifecycle, and geo-tracker has no shipment model — so it cannot start or end one on its own. Every outbox event therefore carries three verdicts computed here, in the source of truth, from the same `TRACKABLE_SHIPMENT_STATUSES` that drives agency visibility:

| Field | Scope | Effect in geo-tracker |
|---|---|---|
| `shipmentTrackable` | this shipment | `true` **opens** its tracking session; `false` closes it |
| `shipmentTerminal` | this shipment | `delivered`/`returned`/`failed` — closes it with the outcome stamped |
| `agentHasActiveShipment` | the whole agent | aggregate backstop: `false` closes every session; can open none |

`visibleAgentsService.shipmentTrackability(status)` is the policy. Note `rejected` and `pending_agency_reassignment` are **not** terminal — the shipment isn't over, it just left this agent, so geo-tracker *releases* the session instead. Verdicts are derived from the status the event was emitted **for**, not a re-read of the shipment, so a burst of transitions produces one honest verdict each rather than all reporting the final state. **Changing this shape means changing geo-tracker's `webhook/domain/entity.go` in the same change** — see the cross-service contract in `../CLAUDE.md`.

**Agent-action audit (Phase 6):** `services/agent-action-audit.service.ts` emits `agent.action` outbox rows describing an agent shipment action (pickup/delivery/return/cancel) and its outcome (attempt/success/validation/authorization/system failure). It is wired into `AgentCodController.collect` (the agent's own COD delivery — the full outcome spectrum) and, post-commit, into `ShipmentService.updateStatus`/`reject` (agency-driven lifecycle transitions on an agent's shipment — success). The dispatcher routes these rows to geo-tracker's `/webhooks/agent-actions`, which captures the agent's GPS and writes an immutable spatial-audit row. jovi-mall keeps the **business** event; geo-tracker keeps the **spatial** audit — the two never merge.

Inert when `GEO_TRACKER_BASE_URL` is unset — the outbox still fills, nothing dispatches. That is the intended local default.

**Caveat worth knowing:** the outbox is *not* transactional with the state change it describes. `ShipmentService._emitTrackingStatusChanged` fires after `runInTransaction` returns, fire-and-forget, and the subscriber enqueues asynchronously — so a crash between commit and enqueue loses the event, despite the model's docstring claiming crash-durability. A true outbox writes in the same transaction as the state change.

### Key external integrations
- **Google Calendar** — OAuth 2.0 with encrypted token vault (`src/modules/integrations/calendar/`)
- **WhatsApp** — Meta Cloud API v18.0 (`src/modules/whatsapp/`)
- **Telegram** — Bot notifications and account linking (`src/modules/telegram/`)
- **Email** — SMTP (Nodemailer + Handlebars templates) or console provider (`src/modules/mail/`)

## Critical Files

| Purpose | Path |
|---|---|
| App bootstrap & middleware stack | `src/app.ts` |
| Route mounting | `src/api/index.ts` |
| Agent domain public surface | `src/modules/agents/index.ts` |
| Agent↔agency contract lifecycle + handshake | `src/modules/agents/domain/services/agent-contract.service.ts` |
| Agent/agency discovery (both browse directions) | `src/modules/agents/domain/services/agent-directory.service.ts` |
| Assignment eligibility rules | `src/modules/agents/domain/services/agent-eligibility.service.ts` |
| Tracking-allow policy (geo-tracker consumes) | `src/modules/agents/domain/services/agent-tracking-policy.service.ts` |
| geo-tracker integration seam | `src/modules/agents/ports/device-location.port.ts` |
| Agent domain config (all eligibility assumptions) | `src/modules/agents/config/agent.config.ts` |
| Article block vocabulary (the blog's security boundary) | `src/modules/blog/validators/article-body.validator.ts` |
| Error factory & AppError class | `src/core/errors.ts` |
| Error code registry | `src/core/error-codes.ts` |
| Base repository | `src/core/repositories/base.repository.ts` |
| Auth middleware | `src/api/middlewares/auth.middleware.ts` |
| Storage factory/singleton | `src/core/storage/storage.factory.ts` |
| Geocoding provider abstraction | `src/core/geocoding/` (factory, `getGeocodingProvider()`, Nominatim adapter) |
| GeoAddress value object (all address sites) | `src/core/types/geo-address.types.ts` |
| Transaction manager | `src/core/database/transaction.manager.ts` |
