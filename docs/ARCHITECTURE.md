# jovi-mall — architecture

Read from source 2026-09-06. Route census:
[`../../DOC-PROGRAM/evidence/jovi-routes.txt`](../../DOC-PROGRAM/evidence/jovi-routes.txt)
(regenerate per [`../../DOC-PROGRAM/README.md`](../../DOC-PROGRAM/README.md) § 4).

---

## 1 · Four layers, and the one rule that holds them apart

```
src/api/       middleware · route mounting · the global error handler · the rate limiter
src/modules/   44 feature modules — the whole domain
src/core/      base repository · error system · storage · geocoding · events · jobs · validation
src/infra/     the Redis factory (one file)
```

Dependencies run **downward only**. `core/` never imports a module; `infra/` never imports
`core/`. The rule that actually does the work is narrower than "layers", and it is the one worth
stating: **a module may import another module's public entry point (`src/modules/<name>/index.ts`)
and its models, and nothing deeper.** Reaching into another module's `domain/services/` is how two
copies of one business rule appear, which is the failure this shape exists to prevent.

There is **no IoC container**, deliberately. Repositories and services are instantiated at the top
of each controller file and closed over by static handlers; dependencies flow through constructors.
See `CLAUDE.md` § Dependency injection for the worked example.

⚠ **This is a monolith with a service boundary drawn through it, not a set of microservices.**
`src/modules/tracking-integration/` is the *entire* jovi-mall half of the geo-tracker seam — the
outbox model and repository, the emitter, the dispatch worker, the visible-agents policy service
and the routes. If a change touches live tracking and does **not** touch that folder, check twice
that it belongs here at all.

---

## 2 · Forty-four modules, and the shape every one of them has

Each module under `src/modules/<name>/` follows one layout (`CLAUDE.md` § Module structure):
`controllers/` · `routes/` · `domain/services/` · `repositories/{interfaces,mongo,mappers}/` ·
`models/` · `validators/` · `dto/`. Not every module needs every folder; none invents a different
one.

Grouped by what they own:

| Group | Modules |
|---|---|
| **Identity & access** | `auth` · `users` · `admins` · `customers` · `vendors` · `agents` · `delivery` (agencies) |
| **Catalog & selling** | `catalog` · `store` · `vendor` · `magazin` · `inventory` · `stock-requests` · `cart` · `booking` |
| **Money** | `orders` · `payments` · `payment-methods` · `transactions` · `earnings` · `billing` · `cod` |
| **Fulfilment** | `shipments` · `shipment-assignment` · `agency-connections` · `tracking-integration` |
| **Content & support** | `blog` · `reviews` · `tickets` · `notifications` |
| **Messaging & bots** | `whatsapp` · `telegram` · `messaging-login` · `channel-connections` · `bot-surface` · `commands` · `command-bus` · `mail` |
| **Delivery of goods** | `digital-delivery` · `file-cleanup` |
| **Platform** | `system` · `dev-tools` · `geo` · `integrations` (Google Calendar) |

Two of these are **surfaces rather than domains**, and mistaking them for domains is the common
error:

- **`bot-surface`** (48 routes) is a *curated projection* of other modules for the n8n customer
  agent. It owns no business rule; it composes them. A rule that appears only here is in the wrong
  place.
- **`dev-tools`** owns the worker registry and the dangerous verbs. It is the only module whose
  routes are all destructive-tier by design.

---

## 3 · The route surface — 720 routes

All under one Express router mounted at `/api` (`src/api/index.ts`), except `/api/health` and
`/metrics`, which are mounted in `app.ts` **before** the rate limiter and the maintenance gate.
That ordering is not cosmetic — see [CONSTRAINTS.md § 2](./CONSTRAINTS.md#2--the-frozen-contract).

| Namespace | Routes | Caller | Guard |
|---|---|---|---|
| `/api/internal` | **173** | *services, not people* | service tokens (three of them) |
| `/api/vendor` | 166 | vendor dashboard | session/bearer, role `vendor` |
| `/api/agency` | 132 | agency dashboard | session/bearer, role `agency` |
| `/api/agent` | 91 | agent app | session/bearer, role `agent` |
| `/api/customer` | 62 | storefront | session/bearer, role `customer` |
| `/api/auth` | 24 | everyone | none — it mints the credential |
| `/api/me` | 16 | any signed-in role | session/bearer |
| `/api/public` | 15 | anonymous storefront | none |
| `/api/files` | 7 | mixed | per-tree (ADR-A01) |
| `/api/payments` + `/api/bookings` | 8 | **deliberately unauthenticated** | none — see below |
| `/api/integrations` | 6 | Google OAuth callback | session |
| `/api/webhooks` | 5 | gateways, WhatsApp, Telegram | signature / shared secret |
| `/api/products` · `/api/geo` · `/api/digital` · `/api/tracking` | 11 | mixed | mixed |
| `/api/health` · `/metrics` | 4 | orchestrator, Prometheus | none — `/metrics` has a token gate |

By method: 295 POST · 278 GET · 90 PATCH · 33 DELETE · 24 PUT.

### `/api/internal` is three different callers wearing one prefix

| Prefix | Routes | Who | Credential |
|---|---|---|---|
| `/api/internal/admin/*` | **120** | the **wi-admin** service | `INTERNAL_ADMIN_SERVICE_TOKEN` |
| `/api/internal/bot/*` | **48** | the **n8n** customer agent | bot credentials + mandatory idempotency |
| `/api/internal/agents/*` | 4 | **geo-tracker** | `INTERNAL_SERVICE_TOKEN` |
| `/api/internal/shipments/*` | 1 | **geo-tracker** — the drop-off pull | `INTERNAL_SERVICE_TOKEN` |

The 120 admin routes break down as: tickets 19 · agents 15 · cod 14 · system 12 · vendors 8 ·
billing 8 · dev-tools 7 · orders 6 · agencies 6 · users 5 · files 5 · reviews 4 · payout-requests 4
· earnings 4 · shipments 2 · messaging 1.

⚠ **These four do not share a guard, and must not be given one.** Three different secrets
authenticate three different peers with three different blast radii; a single `requireInternal`
would make the bot credential sufficient for `/api/internal/admin/*`. See
[CONTRACTS.md § 1](./CONTRACTS.md#1--four-doors-and-only-one-of-them-authenticates-a-person).

⚠ **`POST /api/payments/initiate` and `/verify` are unauthenticated BY DESIGN**, and this is the
single most-reported non-defect in the repository. A mother orders and a son pays; the payment link
is *meant* to be shareable. It was filed once as finding F-C and withdrawn. Do not "fix" it.

---

## 4 · Five core mechanics worth knowing before you edit anything

These are the flows that cross the most modules, so they are the ones where a local change has a
non-local consequence.

### 4.1 · The order → shipment → cash chain

`orders` commits the sale; `shipments` moves it; `cod` collects the cash; `earnings` splits it;
`transactions` records it. Each hand-off is a **post-commit side effect of a guarded transition**,
never a listener on the event bus — because the bus is lossy
([CONTRACTS.md § 3](./CONTRACTS.md#3--domain-events--in-process-and-lossy-by-construction)) and
money is not allowed to be. `EarningsReleaseWorker` sweeps for splits that never landed
(`recoverMissedCodSplits`, `recoverMissedDeliverySplits`), idempotent on the allocation's
per-source unique index.

⚠ **Both shipment write paths do a from-status compare-and-set** (`409 SHIPMENT_STATUS_CONFLICT`
on a miss). An agency (`POST /api/agency/shipments/:id/status`) and an agent (`POST
/api/agent/shipments/:id/status`) drive one document through one shared transition core and one
shared transition map, `TRIGGERABLE_TRANSITIONS`. With two actors on one document, an unguarded
write lets the loser's post-commit side effects fire for a status nobody is in.

### 4.2 · Agent assignment is an OFFER, not an assignment

`shipment-assignment` offers work to a ranked candidate and waits for accept / reject / timeout.
The ranking asks geo-tracker for a road-network matrix and **falls back to the haversine ordering
it already computed** when that call returns null. That fallback is load-bearing *across the
service boundary* — geo-tracker's routing chain deliberately has no straight-line member **because**
this one exists. See [CONSTRAINTS.md § 6](./CONSTRAINTS.md#6--the-degradation-contract).

`AssignmentSweepWorker` is the only thing advancing auto-assignment sessions and expiring manual
offers, and it is the one worker that starts **indirectly**, through
`initializeShipmentAssignment()` rather than a `.start()` in `lifecycle.ts`. That indirection once
kept it out of the observability list entirely; see
[OPERATIONS.md § 1](./OPERATIONS.md#1--background-work--18-workers).

### 4.3 · The tracking outbox

`tracking-integration` writes an outbox row **inside the caller's Mongo transaction**
(`TrackingOutboxRepository.enqueue(input, session)`), and `TrackingDispatchWorker` HMAC-signs and
POSTs it to geo-tracker. **Nine call sites produce rows** — verified 2026-09-06 — all passing the
session, plus one direct `outbox.enqueue` in `agent-action-audit.service.ts`. The event bus is
**not** on this path and has not been since Phase 3; `TrackingEventSubscriber` was deleted.

⚠ **`create` must be called with an ARRAY.** Mongoose reads `{ session }` only when the first
argument is an array, so `create(doc, { session })` silently writes **outside** the transaction and
produces an outbox that *looks* transactional and is not. `npm run test:tracking-outbox` § 2
asserts the array form for exactly that reason.

`session` is deliberately **optional**: a caller with no transaction — the reconcile sweep — is
better served by a row than by nothing. A session-less write is therefore possible by design; it is
simply not what an ordinary crash produces.

### 4.4 · Stock is reserved, then committed

`catalog/domain/services/pricing-inventory/` reserves; `orders/services/order-stock.service.ts`
commits. ⚠ The commit path has a **known open defect — it is a silent no-op** under the conditions
recorded with the customer-test-account seed. It is documented, not fixed; this program changes no
behaviour.

### 4.5 · Geocoding resolves once, at checkout, and is then durable

`core/geocoding/` is a provider **chain**, cached in Redis DB 15 under `geo:`, and its output is
snapshotted onto `order.delivery_address` at checkout. geo-tracker later *pulls* that snapshot with
a service token rather than being pushed it. See [ADR-A04](./ADR-A04-GEOCODING.md).

⚠ Two traps live in `core/geocoding/geocoding.sanitize.ts`: provider output is HTML-escaped and
must be unescaped **exactly once**, at the factory's return (`d&apos;AKWA` reached chat windows and
delivery labels for months), and the cache key carries a **version** that must move when the
sanitiser changes, or the old escaped values are served back.

---

## 5 · Boot order is load-bearing

`src/lifecycle.ts`, and each step is where it is for a stated reason:

```
validate configuration  →  open Mongo  →  start background work  →  open the listener
```

Two things happen *before* `startServer()` even reaches the validator, because they are import-time
throws: `modules/agents/config/agent.config.ts` refuses to load if the trust weights do not sum to
100, and `config/secrets.config.ts` refuses an unset, short or placeholder `JWT_SECRET`.

**Maintenance mode is read before the listener opens** — an instance starting during a window must
already be in it, not serve traffic for one tick and then notice.

**Redis is not touched at boot at all.** It connects on first `getRedisClient()` call, which is why
the readiness probe uses `peekRedisClient()` — a probe that pinged Redis would *create* a
connection the process may never have made, changing the thing it claims to measure on every probe
interval.

Shutdown reverses it, and the order is asserted by `verify:shutdown-live`:

1. **workers first, before Mongo closes** — a tick in flight when the connection dies throws inside
   a timer callback, the one place in this process with no handler above it, so an unhandled
   rejection there would take the process down mid-drain;
2. the listener, **with `closeIdleConnections()`** — `server.close()` alone waits for keep-alive
   sockets that never close on their own, and the drain reliably hits its deadline;
3. wait for in-flight sweeps (not "release the locks" — a money path mid-write is worth waiting
   for);
4. **flush the log sink**, which writes to Mongo, so it must precede the disconnect;
5. Mongo, then Redis.

`drain()` deliberately does **not** call `process.exit` — the caller decides, which is what keeps
the sequence assertable from a test that has to survive it. It latches on success only: a *failed*
drain leaves the process in an unknown state and is worth retrying.
