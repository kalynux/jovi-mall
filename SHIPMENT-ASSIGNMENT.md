# Agent Acceptance Workflow (Shipment Assignment)

Replaces the old direct push — an agency wrote `shipment.agent_id` and issued the COD code with no
agent consent — with an **offer-based** funnel. Manual pick and auto-assignment both go through an
offer the agent must accept.

```
Agency picks an agent  ─┐
                        ├─►  Shipment Assignment Offer (pending, expires_at)  ─►  Agent
System auto-assigns  ───┘         │
   (agency opted in)              ├─ Accept  → agent bound · tracking opens · COD code issued
                                  ├─ Reject  → auto ⇒ next candidate; else back to agency queue
                                  └─ Ignore  → timeout expiry ⇒ same branch as Reject
```

## Where it lives

`src/modules/shipment-assignment/` — a standalone module (like `tracking-integration/`), one-way
deps into shipments / agents / orders / cod / delivery.

| Piece | Path |
|---|---|
| Offer model (the audit of record) | `models/shipment-assignment-offer.model.ts` |
| Ranking session (the broadcast state) | `models/shipment-assignment-session.model.ts` |
| State machine | `domain/services/shipment-assignment.service.ts` |
| Candidate ranking + pure scoring | `domain/services/assignment-candidate.service.ts` |
| Auto-assignment trigger | `services/assignment-event-subscriber.ts` (subscribes `shipment.assigned`) |
| Broadcast advance + manual-offer expiry sweep | `workers/offer-expiry.worker.ts` (`AssignmentSweepWorker`, `setInterval`, 30s; `OfferExpiryWorker` is a back-compat alias) |
| Config | `config/assignment.config.ts` |
| HTTP | `controllers/{agent-offer,agency-assignment}.controller.ts` → mounted in `delivery/{agent,agency}.routes.ts` |
| Barrel + boot | `index.ts` → `initializeShipmentAssignment()` in `server.ts` |

## Key design decision — NO new shipment status

The shipment `status` enum is a cross-service contract duplicated in geo-tracker
(`webhook/domain/entity.go`). Modelling "awaiting acceptance" as a status would ripple into
`TRACKABLE_SHIPMENT_STATUSES`, `ACTIVE_SHIPMENT_STATUSES`, validators, and the Go service.

Instead the offer is a **separate collection**. While an offer is pending the shipment stays
`assigned` (to the agency) with `agent_id = null`; **acceptance is the moment `agent_id` is written**
— the existing "assigned to an agent" event. Because `visible-agents.service.ts` filters
`agent_id != null`, the agent is invisible to customer/agency until they accept and becomes trackable
the instant they do (the status is already trackable). A lightweight `shipment.assignment`
sub-doc (`unassigned | offered | accepted`) mirrors the state for dashboards — it is **not** the
status and touches no contract.

## Auto-assignment: ranking + broadcast

`AssignmentCandidateService.buildRanking(shipment, order)` produces a **proximity-ordered** pool
(nearest first):
1. **Eligibility** — `agentEligibilityService.listEligibleAgentIds(agencyId)` (active · active
   contract · online · tracking-allowed · device-location · under-capacity).
2. **Location gate** — an agent with no resolvable position is dropped (can't be ranked by proximity).
   Live/last-known position or home base counts; `REQUIRE_LIVE_POSITION` (default off) tightens this to
   a fresh pushed fix within `POSITION_FRESHNESS_SECONDS`.
3. **Trust floor** — below `MIN_TRUST_SCORE` (default 0) an agent receives no auto offer.
4. **COD gate** — for COD orders, drop agents over their COD headroom (`assertCanTakeCodShipment`, run
   in parallel). Non-COD keeps every survivor ("assign to any").
5. **Cap + order** — pre-cut to the nearest `MAX_AUTO_CANDIDATES` (default 20) by local haversine, then
   order nearest-first via the **Geo Provider** road-network matrix (`GeoRoutingClient`), with a
   local-haversine fallback. The weighted `scoreCandidate` sum (distance/capacity/trust) is retained
   for the candidate **preview** and tie-breaking only — **proximity is the sort key**. Pure functions
   (`scoreCandidate`, `rankScored`, `distanceScore`, `haversineKm`) are unit-tested DB-free
   (`scripts/test/test-assignment.ts`).

The ranking is snapshotted onto a temporary **assignment session**
(`models/shipment-assignment-session.model.ts`), **not** onto an offer, and the session drives a
**broadcast**:
- **Round 1** offers the nearest candidate immediately, then the next-nearest every
  `OFFER_TIMEOUT_SECONDS` (the session "frontier") **while earlier offers still stand** — offers
  accumulate, so several agents can hold a pending offer at once. First to accept wins (a shipment-level
  bind CAS); a reject advances to the next candidate immediately; an ignore keeps an acceptable offer
  (**auto offers never expire**).
- **Round 2** (up to `MAX_ROUNDS`, default 2) re-nudges the still-standing ignored offers, never the
  rejected ones. After the last round with nobody accepting, `shipment.no_agent_available` →
  `shipment.assignment.unfilled` tells the agency to intervene.
- The session is disposed only when the shipment finishes (`delivered`/`returned`/`rejected`); `failed`
  keeps it so a recovery can resume, and an agent cancelling mid-delivery **resumes the broadcast from
  its cursor**.

Two jobs run every `OFFER_EXPIRY_SWEEP_INTERVAL_MS` (30s) in `AssignmentSweepWorker`:
`advanceDueSessions` (the broadcast) and `expireDueOffers` (**manual** offers only, matched on
`session_id: null`). Both are guarded compare-and-sets, so multiple server instances cannot
double-offer or double-expire.

## The critical transaction (accept)

Hard re-check eligibility + COD exposure (state may have drifted since the offer), then in one
transaction: **claim the offer** (guarded compare-and-set — the double-accept / accept-after-timeout
guard) → **reserve capacity atomically** (`tryReserve`, the admission control that was previously
inert) → **bind the agent** → **issue the COD code** (`ensureForShipmentInSession`). Post-commit,
fire-and-forget: notify the customer of a new code, emit `shipment.status_changed` (geo-tracker opens
the session), recompute working state, audit, and notify the agency.

## Capacity is now live

`capacity.active_shipment_count` (the admission counter) was never incremented before — assignment
didn't reserve. Now: **reserve on accept**, **release** when the shipment leaves the agent's active
set (`delivered` / `returned` / `rejected`, in `ShipmentService` + the two COD delivery paths), and a
**nightly reconcile** (`AgentCapacityReconcileWorker`) corrects any drift. Releases are guarded and
post-commit, so they never disturb the money paths.

## Reassignment (agent → agent)

`POST /api/agency/shipments/:id/reassign` **changes the agent** handling a shipment — the critical
case where the bound agent picked the parcel up but cannot deliver it, or (pre-pickup) simply needs
replacing. Body `{ agentId?, reason }`; `reason` is **required**.

Two paths, by whether the parcel has left the agency:

| From | Target | Auto? | Order items |
|---|---|---|---|
| `assigned` (accepted, not picked up) | `assigned` | auto or manual | unchanged |
| `picked_up` / `in_transit` / `failed` / `returned` | **`handing_over`** | **manual only** (`agentId` required) | mirrored → `handing_over` |

A settled order is never re-opened: reassigning a `returned`/`failed` shipment whose order already
completed is refused (`SHIPMENT_REASSIGNMENT_NOT_ALLOWED`).

`handing_over` is a **new, trackable, non-terminal** shipment status: the parcel is being handed to a
replacement, the order stays "shipped", and it resolves when the new agent sets `picked_up`
(`TRIGGERABLE_TRANSITIONS[handing_over] = ['picked_up', 'returned']`). Adding it was a
deliberate exception to the "no new status" rule above — but it stays **jovi-mall-only**: geo-tracker
consumes the `shipmentTrackable` verdict, never the status, so it needed no change. It is added to
`TRACKABLE_SHIPMENT_STATUSES`, `ACTIVE_SHIPMENT_STATUSES`, and the fulfillment `SHIPPED_OR_BEYOND` set.

**The replacement agent resolves it themselves.** `TRIGGERABLE_TRANSITIONS` is shared by the agency
and the agent (`POST /api/agent/shipments/:id/status`), so a handed-over shipment is driven exactly
like a first-assigned one — no desk in the loop. This works because acceptance binds `agent_id`
while the status is still `handing_over` (`bindAgentIfUnassigned` over `OFFERABLE_STATUSES`), which
is also what satisfies the `picked_up`-requires-`agent_id` guard.

**The mechanism** (`ShipmentAssignmentService.reassign` → `ShipmentService.reassignAgent`):

1. **Thorough pre-checks, before any detach** — shipment still has a bound agent and is reassignable;
   past pickup an `agentId` is mandatory; a named replacement differs from the current agent and passes
   the full eligibility + COD-exposure gate. A bad target fails fast and never strands the shipment.
2. **Detach (guarded CAS)** — `ShipmentRepository.claimForReassignment` matches ONLY the exact
   `(agent_id, status)` read, so a concurrent accept / pickup / collect / second reassign makes it miss
   and raise `SHIPMENT_REASSIGNMENT_CONFLICT` (409). This is the **race guard**. It clears `agent_id`,
   resets the status, and re-mirrors the order (post-pickup only).
3. **Old agent teardown** (post-commit, best-effort) — its tracking session is **released, not
   terminated** (a `shipment.agent_released` domain event → an outbox row with
   `shipmentTrackable=false, shipmentTerminal=null` → geo-tracker `ReleaseShipment`), its reserved
   capacity is returned (`release(..., 'reassigned')`), and working state recomputes.
4. **Re-offer** — the detached shipment is offerable again (`OFFERABLE_STATUSES = [assigned,
   handing_over]`), so the replacement offer reuses `offerToAgent` / `autoAssign` unchanged.

**No two agents are ever tracked for one shipment**: only one `agent_id` at a time, and the new
session opens only when the replacement *accepts* — after the old one was released. geo-tracker adds a
belt-and-suspenders backstop: `ActivateShipment` releases any session for the same shipment held by a
different agent, closing the lost-release-event gap.

Deliberately **not** audited to the geo-tracker `agent.action` spatial trail: a `cancel` action there
is *terminal* and would stamp the released session as ended — contradicting the release semantics. A
non-terminal "reassigned" action kind is a documented follow-up.

### Secure handover — the old agent's access

Detaching clears `agent_id`, and every agent-facing read/action is scoped by it
(`findByIdAndAgent → 404`). So the instant reassignment commits, the previous agent loses **customer
PII** (delivery address, phone — via the shipment detail), **live tracking** (the geo-tracker session
is released and their watcher dropped), and **all shipment actions** (pickup / status / COD
collect). What they keep is their **activity history**: their accepted `ShipmentAssignmentOffer`
row (which carries no customer PII), so "what did I work?" is still answerable. They are told with a
**`shipment.reassigned_away`** agent notification (in-app + push, gated on `assignmentOffers`), keyed
off the `shipment.reassigned` event enriched with `orderNumber`.

### Automatic pickup location + override (`HandoverPickupService`)

When a shipment is reassigned, the replacement needs to know **where to collect it**. The default is
derived from the status at reassignment, and the agency may override it:

| Status when reassigned | Pickup `source` | Resolves to |
|---|---|---|
| `picked_up` / `in_transit` | `previous_agent_location` | the old agent's `last_known_tracking_state.last_position` (the handover point) |
| `returned` | `original_pickup` | the order item's pickup snapshot — vendor address, or agency HQ for `agency_storage` |
| `failed` | `agency_business` | the agency's HQ (`headquarters_addresses[0]`) |
| `assigned` (pre-pickup) | *(null)* | none — the new agent uses the order's per-item pickups |

`resolve()` never throws for a missing input: an unresolvable source (e.g. the previous agent never
streamed) falls back to the agency location with `is_fallback: true`. A manual override
(`pickupLocation` in the request body — a coordinate and/or address) always wins (`source: 'manual'`).
The resolved pickup is stored on `shipment.handover.pickup` (atomically with the detach CAS) **and**
mirrored onto the replacement's offer (`pickup_location`), so it shows in the agent app before accept
(offer) and after (shipment detail), and on the agency dashboard.

**Re-delivering a `returned` shipment.** `returned` had already run its terminal side-effects, which
must be undone or the replacement can never finish:
- **COD code + payment status** — returning cancelled the delivery code (`cancelPendingByShipment`)
  and drove the order's COD payment status to a terminal `failed`. `reopenForRedeliveryInSession`
  (run inside the reassignment txn) revives the cancelled collection with a **fresh code** (sent to
  the customer) and clears `failed → pending`, so the replacement can collect and reach `delivered`.
  The replacement is re-pointed onto the pending collection on accept (no second code).
- **Capacity** — returning already released the old agent's slot, so the reassign detach **skips** the
  capacity give-back for `returned` (a double-release would only trip the drift warning).
- **Order fulfillment** — `recomputeFulfillmentStatus` only advances *forward* from an active state.
  A returned shipment leaves `fulfillment_status` at its last forward state (e.g. `shipped`), which the
  re-mirror to `handing_over` keeps, so final delivery recomputes to `delivered` normally.

The completed-order guard (`order.completion.confirmed_at`) still blocks reassigning a shipment whose
order already settled — that money question is closed and must not re-open.

## Events, notifications, audit

- **Domain events** (in-memory bus): `shipment.offer_created/accepted/rejected/expired/cancelled`,
  `shipment.no_agent_available`. `shipment.status_changed` still fires on acceptance (geo-tracker).
- **Notifications** — agent: `shipment.offer.received` / `.expired` (push-critical), gated by the
  `assignmentOffers` preference. Agency: `shipment.offer.accepted` / `shipment.assignment.unfilled`,
  gated by `shipmentAssigned`. Copy in en/fr/pt/es/ar (boot assert enforces completeness).
- **Audit** — the offer rows ARE the durable audit (one per (shipment, agent) attempt: origin, score
  breakdown, candidate pool, response + reason + timestamps). `assignment-audit.service.ts` also
  emits an `agent.assignment_action` business event. Accept/reject are deliberately **not** added to
  the geo-tracker `agent.action` spatial audit (fixed kinds pickup/delivery/return/cancel — a
  cross-service contract change), so the GPS-at-acceptance capture is a documented follow-up.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `SHIPMENT_OFFER_TIMEOUT_SECONDS` | 120 | Manual-offer timeout / auto-broadcast frontier window. Platform-wide; no per-agency knob. |
| `SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS` | 30000 | Sweep cadence (advance sessions + expire manual offers). |
| `SHIPMENT_ASSIGNMENT_MAX_CANDIDATES` | 20 | Auto pool size cap — the ceiling of agents one broadcast tries. |
| `SHIPMENT_ASSIGNMENT_MAX_ROUNDS` | 2 | Broadcast passes before giving up (round 2 re-nudges ignored offers). |
| `SHIPMENT_ASSIGNMENT_MIN_TRUST_SCORE` | 0 | Trust floor to receive any auto offer. |
| `SHIPMENT_ASSIGNMENT_REQUIRE_LIVE_POSITION` | false | If on, only a fresh pushed position counts as "located". |
| `SHIPMENT_ASSIGNMENT_POSITION_FRESHNESS_SECONDS` | 300 | How recent a live fix must be to count as fresh. |
| `SHIPMENT_ASSIGNMENT_WEIGHT_{DISTANCE,CAPACITY,TRUST}` | 50 / 20 / 30 | Scoring weights (preview/tie-break; live sort is proximity). |
| `SHIPMENT_ASSIGNMENT_DISTANCE_{FULL,ZERO}_KM` | 1 / 25 | Distance normalisation. |
| `SHIPMENT_ASSIGNMENT_GEO_MATRIX_PATH` / `_GEO_TIMEOUT_MS` | `/routing/matrix` / 3000 | Geo Provider proximity matrix (haversine fallback). |
| `AGENT_CAPACITY_RECONCILE_CRON` | `0 4 * * *` | Nightly capacity reconcile. |

## Geolocation

Agency HQ addresses now carry a required `location` (GeoPoint) + a `2dsphere` index — closing the one
gap (customer, vendor, and agent addresses were already geolocated). Required at onboarding via the
Zod validator; the Mongoose field stays lenient so legacy docs still hydrate. Pre-existing agencies
must re-save their HQ address with coordinates. Pickup coordinates for scoring are resolved live
(agency HQ for `agency_storage`, the vendor business address for `vendor_address`).

## Not done / follow-ups

- Mongo-backed integration tests for the accept/reject/expire transactions (the DB-free harness
  covers only the pure scoring).
- geo-tracker spatial audit for accept/reject (needs a coordinated `agent.action` contract change).
- WhatsApp templates `agent_shipment_offer_*` / `agency_shipment_*` need creating in Meta Business
  Manager before that one channel delivers (in-app / push / email / telegram work today).
