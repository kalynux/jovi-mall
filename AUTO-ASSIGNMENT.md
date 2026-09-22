# Delivery Auto-Assignment

Production design + operations reference for the auto-assignment workflow that lives in
`src/modules/shipment-assignment/`. It builds on the offer-based acceptance workflow described in
[SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md); read that first for the manual-offer / reassignment
machinery this reuses.

## What it does

When a shipment lands with an agency that has auto-assignment enabled, the system:

1. finds up to **20 eligible agents** (eligibility is decided *before* any geo call);
2. sends those agents + the pickup to the **Geo Provider** (geo-tracker's road-network matrix) and
   ranks them **nearest → farthest** (local haversine fallback if geo-tracker is unavailable);
3. stores that ranking as a **temporary session** (deleted when the shipment finishes);
4. offers the shipment down the ranking, one candidate per **2-minute** window, across up to **two
   rounds**, until someone accepts or the ranking is exhausted;
5. is **concurrency-safe** — only one agent can ever be bound, even under simultaneous accepts;
6. **resumes from where it reached** if an assigned agent cancels mid-delivery.

## The moving parts

| Concern | File |
|---|---|
| Eligibility (before geo) | `../agents/domain/services/agent-eligibility.service.ts` |
| Candidate ranking (geo + fallback) | `domain/services/assignment-candidate.service.ts` |
| Geo Provider client | `services/geo-routing.client.ts` |
| The state machine | `domain/services/shipment-assignment.service.ts` |
| Temporary ranking | `models/shipment-assignment-session.model.ts` + `repositories/…session.repository.ts` |
| Per-agent offer/acceptance record | `models/shipment-assignment-offer.model.ts` + its repository |
| The sweep (advance + expire) | `workers/offer-expiry.worker.ts` (`AssignmentSweepWorker`) |
| Auto-trigger + ranking disposal | `services/assignment-event-subscriber.ts` |
| Config | `config/assignment.config.ts` |
| Agent cancel detach | `../shipments/shipment.service.ts` → `releaseForAgentCancel` |

## Eligibility (STEP 1) — *before* the geo provider

An agent is a candidate only if **all** hold (`assignment-candidate.service.ts`):

- **Tracking permission** enabled, **online**, **active + approved contract**, **device-location** not
  disabled, **under capacity** — the existing `AgentEligibilityService` gate.
- **Current location** — a requirement **only** with `REQUIRE_LIVE_POSITION=true`, where a live
  position pushed within `POSITION_FRESHNESS_SECONDS` is needed. Otherwise (the default) a stale mirror
  or the declared home base ranks the agent, and an agent with **no position at all** is kept and
  ranked after every located one. Since 2026-09-22 — they used to be dropped, and a new agent has no
  position by construction (nothing writes `home_base`; geo-tracker pushes one only during a tracked
  shipment), so a new agent could never receive a first shipment.
- **Trust threshold** — `trust_score ≥ MIN_TRUST_SCORE` (applies to every order; default `0` = inert).
- **COD threshold** — *only for COD orders* (`order.payment_method === 'cash_on_delivery'`): the agent
  must be under their COD headroom. Prepaid orders skip this gate entirely. Checked in **parallel**
  across candidates (not a sequential N+1).

The eligible set is pre-cut to the nearest `MAX_AUTO_CANDIDATES` (20) by local haversine before the
geo call.

## Proximity ranking (STEP 2)

`GeoRoutingClient.rankByProximity(pickup, agents)` POSTs to geo-tracker `POST /routing/matrix`
(agent positions as *sources*, pickup as the single *target*), authed with a short-lived HS256
service JWT on the shared `JWT_SECRET`. Results are ordered by road **duration**, then distance. On
any failure (timeout, non-200, or `GEO_TRACKER_BASE_URL` unset) it returns `null` and the caller
falls back to the local haversine order — **geo-tracker is never on the critical path**. The chosen
order is recorded on the session as `ranking_source: 'geo_matrix' | 'haversine'`.

## The temporary ranking — `ShipmentAssignmentSession` (STEP 3, 9)

One document per shipment holds the ordered `ranking`, the broadcast `cursor` (high-water mark), the
`round`, the `renudge_index`, the COD snapshot, and `frontier_at` (when the next candidate is due).
It is **hard-deleted** when the shipment reaches `delivered` / `returned` / `rejected` (the
`shipment.status_changed` subscriber), or on an agency withdrawal/reassignment. The durable audit of
who was offered what lives on the **offer rows**, not here.

## The broadcast (STEP 4–6)

- **Offer** the candidate at `cursor`, arm `frontier_at = now + OFFER_TIMEOUT_SECONDS`, `cursor++`.
- **Accept** → bound (see concurrency below); the broadcast stops (`status: assigned`) but the
  session is kept for a possible resume.
- **Reject** → the offer becomes `rejected` and the broadcast advances to the next candidate
  **immediately** (does not wait for the frontier).
- **Ignore / timeout** → the offer stays **`pending` and acceptable**; the sweep just offers the next
  candidate. An ignored agent keeps their notification and can still accept while unassigned.
- **Round 2** re-nudges the still-standing (ignored) offers, one per window — never the rejected ones.
- After `MAX_ROUNDS` (2) with nobody bound → `status: exhausted` and a
  `shipment.no_agent_available` event → the agency is notified that auto-assignment failed. Standing
  offers remain acceptable.

## "First valid approval wins" (STEP 7, 11) — the concurrency model

Several agents can hold an acceptable (`pending`) offer at once. The single serialisation point is a
**shipment-level compare-and-set**, not offer uniqueness:

```
ShipmentRepository.bindAgentIfUnassigned(shipmentId, agentId, OFFERABLE_STATUSES, session)
   → findOneAndUpdate({ _id, agent_id: null, status: {$in: offerable} }, { $set: { agent_id } })
```

Only one concurrent accept matches `agent_id: null`; the loser gets `null` → `409
SHIPMENT_ALREADY_HAS_AGENT` ("another agent already accepted"). The accept transaction runs under
`transactionManager.runInTransactionWithRetry` (driver-level retry on transient write-conflicts), so
a genuine race re-evaluates cleanly instead of surfacing a spurious failure. The winning accept also
claims the offer (`claimForAccept`), reserves capacity atomically (`tryReserve`), issues the COD code
(if any), marks the session `assigned`, and — post-commit, best-effort — supersedes the other standing
offers so the losers' apps stop showing an accept button.

## Cancel + resume (STEP 8, 10)

`POST /api/agent/shipments/:id/cancel` (`AgentOfferController.cancelShipment`) →
`ShipmentAssignmentService.cancelByAgent`:

- validates the reason (`AgentCancellationReason` enum + ≤200-char note, note required for `other`);
- resolves a handover pickup for post-pickup cancels (`HandoverPickupService`);
- `ShipmentService.releaseForAgentCancel` detaches the agent (guarded CAS on `agent_id: thisAgent`),
  records `shipment.agent_cancellation`, returns capacity, and releases the tracking session;
- **resumes the session from its stored `cursor`** — the broadcast continues to the next candidate,
  never restarting from rank 1.

The cancellation is durably recorded on the shipment (`agent_cancellation`) and emitted as
`shipment.agent_cancelled`.

## State transitions

**Session (`status`):** `active` → `assigned` (accept) → back to `active` (agent cancel, resumed) ;
`active` → `exhausted` (both rounds failed) ; any → *deleted* (shipment terminal / withdrawal).

**Shipment (unchanged enum; the cross-service contract):** an offer never changes the shipment
status — it stays `assigned`/`handing_over` with `agent_id = null` until acceptance writes `agent_id`.
Agent cancel resets `assigned → assigned` (pre-pickup) or `{picked_up,in_transit,failed,handing_over}
→ handing_over` (post-pickup), both offerable.

## Events

| Event | When | Consumed by |
|---|---|---|
| `shipment.offer_created` | an offer is placed | agent notification (push + in-app) |
| `shipment.offer_reminder` | round-2 re-nudge of a standing offer | agent notification (reminder) |
| `shipment.offer_accepted` / `_rejected` / `_expired` / `_cancelled` | agent/agency action | audit |
| `shipment.no_agent_available` | pool exhausted / both rounds failed | **agency notification** (auto-assign failed) |
| `shipment.agent_released` | agent cancel / reassignment detach | tracking-integration → geo-tracker (session release) |
| `shipment.agent_cancelled` | agent cancels mid-delivery | audit (available for an agency notification) |
| `shipment.status_changed` | accept + every transition | tracking outbox + **session disposal** |

## Background worker

`AssignmentSweepWorker` (`workers/offer-expiry.worker.ts`), started by `initializeShipmentAssignment()`
in `server.ts`, on a `setInterval` (`OFFER_EXPIRY_SWEEP_INTERVAL_MS`, default 30 s). Each tick:
(1) **advances** due sessions — offer next candidate / re-nudge / give up; (2) **expires** due
*manual* offers. Auto offers never expire on timeout. **Multi-instance safe**: session advancement is
a guarded compare-and-set on `(status, round, cursor, renudge_index, frontier_at)` and manual expiry a
guarded transition, so several instances sweeping at once cannot double-offer or double-expire.

## Configuration (`config/assignment.config.ts`)

| Env var | Default | Meaning |
|---|---|---|
| `SHIPMENT_OFFER_TIMEOUT_SECONDS` | `120` | Per-candidate response window (STEP 4). |
| `SHIPMENT_OFFER_EXPIRY_SWEEP_INTERVAL_MS` | `30000` | Sweep cadence. |
| `SHIPMENT_OFFER_EXPIRY_SWEEP_BATCH` | `100` | Max sessions/offers processed per tick. |
| `SHIPMENT_ASSIGNMENT_MAX_CANDIDATES` | `20` | Ranking cap (STEP 1). |
| `SHIPMENT_ASSIGNMENT_MAX_ROUNDS` | `2` | Broadcast rounds before giving up (STEP 6). |
| `SHIPMENT_ASSIGNMENT_MIN_TRUST_SCORE` | `0` | Trust floor to receive any order (STEP 1). |
| `SHIPMENT_ASSIGNMENT_REQUIRE_LIVE_POSITION` | `false` | Require a fresh live position to be a candidate — which excludes every never-tracked agent. Off, a positionless agent is ranked last. |
| `SHIPMENT_ASSIGNMENT_POSITION_FRESHNESS_SECONDS` | `300` | How recent a live position must be. |
| `SHIPMENT_ASSIGNMENT_GEO_MATRIX_PATH` | `/routing/matrix` | geo-tracker matrix endpoint. |
| `SHIPMENT_ASSIGNMENT_GEO_TIMEOUT_MS` | `3000` | Matrix call timeout (falls back fast). |
| `SHIPMENT_ASSIGNMENT_GEO_TOKEN_{SUBJECT,ROLE,TTL_SECONDS}` | `jovi-mall-assignment` / `admin` / `60` | Service-JWT claims for the matrix call. |
| `SHIPMENT_ASSIGNMENT_WEIGHT_{DISTANCE,CAPACITY,TRUST}` | `50/20/30` | Retained explainability score weights. |
| `GEO_TRACKER_BASE_URL` | *(unset)* | geo-tracker base URL. Unset ⇒ ranking uses haversine only. |

## Endpoints

- Agent: `GET/POST /api/agent/offers…` (list/accept/reject — see [api-doc/agent/offers.md](./api-doc/agent/offers.md)),
  **`POST /api/agent/shipments/:id/cancel`** (see [api-doc/agent/shipments.md](./api-doc/agent/shipments.md#cancel)).
- Agency: `POST /api/agency/shipments/:id/auto-assign`, `GET …/assignment-candidates`,
  `POST …/offer/cancel`, `POST …/reassign`, `PATCH /api/agency/assignment-settings`
  (see [api-doc/agency/assignment.md](./api-doc/agency/assignment.md)).

## Verifying end-to-end

No test framework is configured — verify by booting the server (`npm run dev`) and by the DB-free
pure-function tests:

```bash
npx tsc --noEmit                       # type-check (must be clean)
npm run lint                           # ESLint, zero warnings
npx ts-node scripts/test/test-assignment.ts   # ranking/scoring/catalog asserts
```

For the concurrency guarantee (STEP 11), exercise `accept()` on one shipment from N clients against a
**replica-set** Mongo and assert exactly one bind succeeds (others `409`). The geo path is exercised
against a running geo-tracker; unset `GEO_TRACKER_BASE_URL` to confirm the haversine fallback still
assigns.
