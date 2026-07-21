# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ## ⚠️ A refactor is in flight — compiles, but incomplete
>
> A large agent-contract / COD-shared-pool refactor is part-applied. As of
> **2026-07-16** `npx tsc --noEmit` and `npm run lint` are clean and the app loads,
> but most of the new surface is still unreachable over HTTP and the mechanism
> that releases COD headroom (the settlement service) does not exist yet — so a
> COD pool currently fills and never drains.
>
> **Read [AGENT-CONTRACT-REFACTOR.md](./AGENT-CONTRACT-REFACTOR.md) before touching
> `src/modules/agents/`, `src/modules/cod/`, or `src/modules/shipments/shipment.service.ts`.**
> It lists what is built, what is not, decisions already settled with the product
> owner, and the order to finish in.
>
> `npm run test:agent-domain` was stale against the new model and is **repaired**
> as of 2026-07-16 (47 assertions, green). It is DB-free, so it still cannot cover
> the COD allocation race — see the handoff doc.
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
npm run migrate:customer-payment-methods
npm run migrate:agent-memberships        # agency_id → memberships (idempotent, --dry-run)
npm run migrate:agent-deposits           # backfill deposit status/recipient (idempotent, --dry-run)
npm run seed:tickets [-- --clean]        # also: seed:plans, seed:cod [-- --clean]
npm run simulate:notifications
```

No test *framework* is configured. Tests are plain ts-node scripts under `scripts/test/` with
hand-rolled asserts — follow that convention rather than introducing a runner:

```bash
npm run test:agent-domain                      # agent domain (47 assertions, no DB needed)
npx ts-node scripts/test/test-profile-mappers.ts
```

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

### Error handling
**Never** use `throw new Error()` or `res.status().json({ error: ... })`. ESLint enforces this.
- Use `createAppError(code, statusCode, message?, details?)` from `src/core/errors.ts`
- Pass errors to `next(error)` — the global error handler in `src/api/middlewares/error-handler.middleware.ts` normalises AppError, ZodError, and Mongoose errors into a consistent JSON shape
- Error codes are domain-prefixed string literals defined in `src/core/error-codes.ts` (e.g. `AUTH_INVALID_CREDENTIALS`, `CATALOG_INSUFFICIENT_STOCK`)

### Auth & request context
`requireAuth` middleware (`src/api/middlewares/auth.middleware.ts`) populates `req.auth = { user, role, role_entity }`.
Vendor-scoped queries extract `req.auth!.role_entity._id.toString()` as `vendorId` and pass it to repositories, which enforce scoping at the query level.

Token resolution order: `access_token` httpOnly **cookie first**, then `Authorization: Bearer`. On expiry `requireAuth` performs a **silent refresh** from the refresh cookie and transparently re-issues the access cookie — so bearer-only callers (e.g. geo-tracker forwarding a viewer's token) get no refresh and simply fail closed on expiry.

`JWT_SECRET` falls back to the literal string `'secret'` here, while geo-tracker fails closed on an empty secret. A misconfigured deploy therefore fails asymmetrically — treat the fallback as a known smell, not a default to rely on.

### Startup composition (`src/server.ts`)
Background workers/consumers register at boot, all after the Mongo connection: aggregation scheduler, plan-expiry worker + notification consumer, vendor / agency / **agent** notification consumers, file-cleanup, earnings-release, unpaid-order-cancel, COD deposit-deadline, and the tracking event subscriber + dispatch worker. A feature that needs periodic sweeps registers here; sub-minute cadences use `setInterval`, daily ones use `node-cron`.

### Notifications (`src/modules/notifications/`)
Three parallel multi-channel stacks — vendor, agency, and **agent** — each its own model + preference + repository + catalog + event-handler + consumer, all following the same rules (mandatory in-app record, always-on FCM push, at most one preference-gated secondary channel of email/telegram/whatsapp, catalog-driven copy localized in en/fr/pt/es/ar with a startup completeness assert). They are deliberately **not** DRY'd into one generic stack: the copy is written per-audience and the situations barely overlap. When adding a situation, add its `base` copy in **all five languages** or the consumer throws at boot. The agent stack is the newest and narrowest — it exists because the COD cash chain moves an agent's money on an agency's say-so, and the agent needed a durable record of it (`cod.deposit.recorded` with no prior declaration is the agent's only signal that an agency under-recorded a hand-over). Some events are shared: `cod.deposit.recorded` is consumed by both the agent handler (all cases) and the agency handler (direct-to-platform only), each no-oping on payloads that are not theirs — the same pattern the `connection.*` events use across vendor and agency.

### Domain events (`src/core/events/event-bus.ts`)
In-memory, **per-process**, no persistence and no retry — a `Map<eventType, handler[]>` where `publish` awaits handlers in sequence and swallows their errors. Anything that must survive a crash or cross a process boundary needs its own durable buffer on top (this is exactly why the geo-tracker integration has an outbox).

Emission convention is **post-commit and fire-and-forget** (`void eventBus.publish(...).catch(log)`), so an event is never inside the transaction that caused it. See the caveat under `tracking-integration` below.

### Agent vs agency actions (important)
Shipment status transitions are **agency-driven, not agent-driven**: `PATCH /api/agency/shipments/:id/status` → `ShipmentService.updateStatus(agencyId, …)`, guarded by `requireRole(['agency'])`, validated against `AGENCY_TRIGGERABLE_TRANSITIONS`, and recorded in `status_history` with `changed_by_role: 'agency'`.

The agent's self-service write paths *on shipments* are: **accept/reject an assignment offer** (`POST /api/agent/offers/:id/{accept,reject}` — the agent-acceptance workflow, see below), `POST /api/agent/shipments/:id/cod/collect` (delivery-code submission — the only *API* by which a COD shipment reaches `delivered`), and `PATCH /api/agent/shipments/:id/tracking-number`. There is still **no agent endpoint for pickup / deliver / return / cancel** — those stay agency-driven.

### Agent-acceptance workflow (`src/modules/shipment-assignment/`)
Assignment is **offer-based, not a direct push**. `PATCH /api/agency/shipments/:id/assign-agent` (and `POST …/auto-assign`, gated by the agency's `assignment_settings.auto_assign_enabled`) create a `ShipmentAssignmentOffer` the agent must **accept** before the shipment is theirs. The shipment stays `assigned` (to the agency) with `agent_id = null` until acceptance — the moment `agent_id` is written, the shipment becomes trackable and (COD) the delivery code issues. **No new shipment status was added**, deliberately: that enum is the geo-tracker contract. State is mirrored on a `shipment.assignment` sub-doc (`unassigned | offered | accepted`), which is *not* the status. Offer timeout is a platform default (`SHIPMENT_OFFER_TIMEOUT_SECONDS`, 120s); the expiry sweep (`OfferExpiryWorker`) reaps ignored offers and, for auto offers, walks the snapshotted candidate pool to the next agent. Capacity admission control (`AgentCapacityService.tryReserve`/`release`) — previously inert — is now live: reserved on accept, released on `delivered`/`returned`/`rejected`, reconciled nightly. Full design in [SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md); API in `api-doc/agent/offers.md` + `api-doc/agency/assignment.md`.

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

### Agent domain (`src/modules/agents/`)
The agent is a **platform identity, not an agency-owned record** — they sign up independently and may serve **several agencies at once**. `DeliveryAgent.agency_id` no longer exists; the relationship is `AgentAgencyMembership` (one row per agent↔agency), with `AgentMembershipEvent` as its append-only history.

**The rule for any new agent field: if the value could differ per agency, it belongs on the membership.** Employment terms and the COD exposure cap are per-membership; identity, trust score, availability, device and tracking permission are per-agent.

Four state axes are kept deliberately separate — collapsing any two makes "is he offline, or just full?" unanswerable:

| Axis | Question | Written by |
|---|---|---|
| `status` | may this account work at all? | admin |
| `availability` | does the agent *want* work now? | the agent |
| `working_state` | how loaded is he? (derived from shipment counts) | system |
| `tracking.allowed` | may he be tracked? | admin/agency |

Consume the domain through the barrel (`src/modules/agents/index.ts`) — **except routes**, which the API layer imports directly from `routes/*`. Routers pull in `auth.middleware` → `auth.service` → the barrel; re-exporting routes from it closes a require cycle that crashes at boot with "AuthService is not a constructor".

**Eligibility** (`agent-eligibility.service.ts`) is the single gate on assignment: active · approved with the *dispatching* agency · online · tracking allowed · device location not disabled · under capacity. It reports **every** failed rule at once, never just the first. An agent may hold several active shipments — capacity bounds that, and counts across all agencies.

**Device location** is the one input jovi-mall cannot observe; it resolves via `IAgentDeviceLocationProvider` (`ports/device-location.port.ts`), swapped in `agent.bootstrap.ts`. The signal is tri-state and `null` (unknown) must never be coerced to `false` — that would make every agent ineligible the instant geo-tracker went down. Policy for unknown lives in `AGENT_CONFIG`, not in the rule.

**Tracking split:** jovi-mall owns whether tracking is *allowed*; geo-tracker owns *execution*. `agent.last_known_tracking_state` is a business mirror, stale by construction — never serve it as a live position, and no assignment rule reads it.

Because `assertEligible` requires tracking-allowed before dispatch, geo-tracker **refuses** an agent's attempt to switch Tracking Allow off while they hold an active shipment (it would strand a delivery assigned on that promise). Note what Tracking Allow is *for* on geo-tracker's side: it is the permission to read an agent's **live position at all** — including an agent with no shipment, which is exactly the read that finds the one nearest a pickup. It is not what starts a tracking session; only a shipment is.

Migration for pre-existing data: `npm run migrate:agent-memberships` (idempotent; `--dry-run` supported).

### Base repository (`src/core/repositories/base.repository.ts`)
Generic `BaseRepository<TDoc, TDomain>` provides: `findOne`, `findById`, `paginate`, `create`, `softDelete`, `restore`, `hardDelete`. All queries automatically filter `deletedAt: null`. Pass a Mongoose `ClientSession` for transactional operations.

### Storage (`src/core/storage/`)
Factory + Strategy pattern. Active provider is selected via `STORAGE_PROVIDER` env var (`local` | `firebase` | `cloudinary`). Use `getStorageProvider()` singleton — never instantiate providers directly. Interface: `IStorageProvider` in `storage-provider.interface.ts`.

### Geocoding & geospatial addresses (`src/core/geocoding/` + `src/core/types/geo-address.types.ts`)
Same factory + strategy + singleton shape as storage. Active provider is `GEO_PROVIDER` (`nominatim` — the keyless default — `| google | mapbox | here | geoapify`); only Nominatim has an adapter in this build, the factory throws `GEO_PROVIDER_NOT_CONFIGURED` for the rest so the seam stays visible. Use `getGeocodingProvider()`; the interface is `IGeocodingProvider` (`search` + `reverse`). **No business logic ever branches on the provider.** The HTTP surface is `src/modules/geo/` → `GET /api/geo/search` + `GET /api/geo/reverse` (any signed-in role), backing a Maps-style "type → search → select → store" flow.

The stored value object is **`GeoAddress`** (`geo-address.types.ts`): `formatted_address` + `coordinates` (GeoJSON `[lng,lat]`) + `provider` + `provider_place_id` + structured `components` (city/region/country/postal…) + `raw_input`. It is embedded at all five address sites — customer `saved_addresses[].geo`, vendor `business_addresses[].geo`, agency `headquarters_addresses[].geo`, the order pickup snapshot (`items[].delivery.pickup_location.address_snapshot.geo`), and the order **drop-off** (`order.delivery_address`, snapshotted at checkout). Adoption is **additive**: legacy loose fields are kept and geo is optional at the schema level, enforced on write by the Zod validators; use `toGeoAddress` / `withGeoAddress` (`geo-address.types.ts`) to normalise a validated candidate before persisting. A `2dsphere` index sits on every `…geo.coordinates`. Full contract: `api-doc/geo/README.md`.

Geocoding lives in jovi-mall by the governing rule: an address is order/profile-model data, and jovi-mall owns that — geo-tracker owns live positions and road networks, not address resolution. The order's durable geocoded drop-off is **available to geo-tracker routing** but was a **data-only** change: no outbox event shape changed, so geo-tracker code is untouched.

### Payments (`src/modules/payments/`)
Gateway-agnostic orchestrator (`PaymentOrchestratorService`) supports Stripe (cards), NotchPay, and MyCoolPay (mobile money). Each gateway implements `PaymentGateway` interface. Webhook payloads are deduplicated via hash before processing.

### Redis (`src/infra/redis/redis.factory.ts`)
Uses dedicated DB indices (3–10) per feature (email tokens, WhatsApp codes, booking slot locks, download tokens, etc.). Connects lazily.

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
| Agent↔agency membership lifecycle | `src/modules/agents/domain/services/agent-membership.service.ts` |
| Assignment eligibility rules | `src/modules/agents/domain/services/agent-eligibility.service.ts` |
| Tracking-allow policy (geo-tracker consumes) | `src/modules/agents/domain/services/agent-tracking-policy.service.ts` |
| geo-tracker integration seam | `src/modules/agents/ports/device-location.port.ts` |
| Agent domain config (all eligibility assumptions) | `src/modules/agents/config/agent.config.ts` |
| Error factory & AppError class | `src/core/errors.ts` |
| Error code registry | `src/core/error-codes.ts` |
| Base repository | `src/core/repositories/base.repository.ts` |
| Auth middleware | `src/api/middlewares/auth.middleware.ts` |
| Storage factory/singleton | `src/core/storage/storage.factory.ts` |
| Geocoding provider abstraction | `src/core/geocoding/` (factory, `getGeocodingProvider()`, Nominatim adapter) |
| GeoAddress value object (all address sites) | `src/core/types/geo-address.types.ts` |
| Transaction manager | `src/core/database/transaction.manager.ts` |
