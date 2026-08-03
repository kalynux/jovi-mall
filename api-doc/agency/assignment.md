# Agency — Agent Assignment (Acceptance Workflow)

How an agency places a shipment with an agent under the **agent-acceptance workflow**. Assignment is
no longer a direct push: the agency (or the system) creates an **offer**, and the shipment becomes
the agent's only once they accept. See [agent offers](../agent/offers.md) for the agent's side.

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role. Every endpoint is scoped
to the agency's own shipments; a shipment outside scope is `404 SHIPMENT_NOT_FOUND`.

## Endpoints

- [`PATCH /api/agency/shipments/:id/assign-agent`](#offer) — offer a specific agent (manual pick)
- [`POST /api/agency/shipments/:id/auto-assign`](#auto) — let the system pick the best agent now
- [`GET /api/agency/shipments/:id/assignment-candidates`](#candidates) — preview the ranked agents
- [`POST /api/agency/shipments/:id/offer/cancel`](#cancel) — withdraw the live offer
- [`POST /api/agency/shipments/:id/reassign`](#reassign) — change agents (release the current agent, offer a replacement)
- [`PATCH /api/agency/assignment-settings`](#settings) — toggle auto-assignment participation

---

<a name="offer"></a>
## PATCH /api/agency/shipments/:id/assign-agent

**Repurposed** from the old direct assignment. Body `{ "agentId": "<24-hex>" }`. Creates a pending
offer to that agent (unless the agent has auto-accept on, in which case they're bound immediately).
Eligibility and — for COD — the exposure limit are checked up front so the dispatcher gets an
immediate answer.

```json
{
  "success": true,
  "message": "Offer sent to agent",
  "data": {
    "offer": { "id": "665f...", "status": "pending", "expiresAt": "...", "...": "..." },
    "shipment": { "id": "665a...", "status": "assigned", "assignmentState": "offered" },
    "autoAccepted": false
  }
}
```

**Errors**: `SHIPMENT_NOT_OFFERABLE` (422, shipment isn't in `assigned` state),
`SHIPMENT_ALREADY_HAS_AGENT` (409), `SHIPMENT_ALREADY_HAS_PENDING_OFFER` (409),
`AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422, `details.reasons`), the **contract-term gates**
(`CONTRACT_COVERAGE_REGION_NOT_COVERED` with `details: { deliveryRegion, coveredRegions }`,
`CONTRACT_SHIPMENT_VALUE_EXCEEDED` with `details: { shipmentValue, ceiling }`), and COD gates
(`COD_AGENT_EXPOSURE_EXCEEDED`, `COD_AGENT_TRUST_TOO_LOW`).

> **A manual assign is gated exactly like the auto pool.** The same coverage and value-ceiling
> checks that filter auto-assignment candidates run here, on `/accept`, and on `/reassign` — gating
> only the ranking would let a manual assign silently bypass a term the auto path enforces, which is
> worse than not enforcing it, because the rule would appear to work.
>
> Both fail **open** on missing data: a contract with no declared `coverage.regions` covers
> everywhere (that is the default on every contract ever created), an order with no delivery region
> is never gated, and a null `shipmentValueCeiling` caps nothing.

<a name="auto"></a>
## POST /api/agency/shipments/:id/auto-assign

Rank eligible agents and start an auto-assignment **broadcast** now, on demand (even if the agency's
standing auto-assign toggle is off). No body. `422 SHIPMENT_NO_ELIGIBLE_AGENTS` when no agent
qualifies.

**How the ranking is built** (nearest-first):
- **Eligible agents** — active · active contract with this agency · online · tracking allowed · device
  location on · under capacity.
- **Location gate** — an agent with no resolvable position is dropped (they can't be ranked by
  proximity). A live/last-known position, or the agent's declared home base, counts; a deployment can
  require a *fresh* live fix (`REQUIRE_LIVE_POSITION`).
- **Trust floor** — below `MIN_TRUST_SCORE` (platform default `0`, so inert until raised) an agent
  gets no auto offer.
- **COD gate** (COD orders only) — agents over their COD headroom on this agency's contract are removed
  entirely.
- **Order** — survivors are capped to the nearest `MAX_AUTO_CANDIDATES` (default **20**) and ordered
  nearest-first via the road-network distance matrix (haversine fallback when the geo provider is
  unavailable). The weighted `score`/`breakdown` on the [candidate preview](#candidates) is for
  explainability and tie-breaking, **not** the primary sort — proximity is.

**The broadcast — the key behaviour for the UI.** The full ranking is snapshotted onto a temporary
**assignment session** (not onto an offer). The nearest agent is offered immediately; then each
`SHIPMENT_OFFER_TIMEOUT_SECONDS` (120s) window the next-nearest is offered **while earlier offers still
stand**. So **multiple agents can hold a pending offer for the same shipment at once, and the first to
accept wins** — the losers' offers become `superseded`. An agent who **rejects** is dropped and the
next candidate is offered immediately; an agent who **ignores** keeps an acceptable offer (auto offers
do not expire).

**Two rounds, then unfilled.** Round 1 offers every candidate once; round 2 re-nudges the agents who
ignored (never those who rejected). After the last round (`MAX_ROUNDS`, default **2**) with nobody
accepting, the agency gets `shipment.assignment.unfilled` — assign manually. Because a fully-ignored
pool is walked one candidate per window across two rounds, "unfilled" can take a while, so show the
shipment as **searching** until an agent binds or you are told it is unfilled.

<a name="candidates"></a>
## GET /api/agency/shipments/:id/assignment-candidates

Preview the ranked pool without offering — the same nearest-first order auto-assignment would use.
Returns each candidate with `rank` (0 = nearest) and a score breakdown (`distance_km`,
`distance_score`, `free_capacity`, `capacity_score`, `trust_score`, `weighted`). The `weighted` score
is explanatory/tie-break context; the list order is proximity.

```json
{
  "success": true,
  "data": [
    { "agentId": "6612...", "rank": 0, "score": 0.87, "breakdown": { "distance_km": 1.2, "...": "..." } }
  ]
}
```

<a name="cancel"></a>
## POST /api/agency/shipments/:id/offer/cancel

Withdraw the shipment's live offer, returning it to the agency queue. No body.
Returns `{ "cancelled": <count> }`.

<a name="reassign"></a>
## POST /api/agency/shipments/:id/reassign

**Change the agent handling a shipment** — the critical-case path for when the bound agent picked the
parcel up but cannot deliver it (broke down, unreachable, went dark), or, pre-pickup, simply needs
replacing. It detaches the current agent, computes where the replacement should collect the parcel,
and offers the shipment to that replacement — in one call.

**Body** `{ "agentId"?: "<24-hex>", "reason": "<why>", "pickupLocation"?: { … } }`:
- **`reason` is required** — reassignment is a deliberate, audited action.
- **`agentId` is required once the parcel has left the agency** (`picked_up` / `in_transit` / `failed`
  / `returned`): the parcel is with the old agent (or back at the agency), so there is **no
  auto-reassignment** — the agency must name the replacement. Omit `agentId` only pre-pickup
  (`assigned`) to auto-assign the best candidate.
- **`pickupLocation`** (optional) overrides the automatic handover point (see below).

### Secure handover — what happens, in order

1. The replacement is **thoroughly re-checked** (eligibility + COD exposure) **before** anything is
   detached, so a bad target fails fast and never strands the shipment.
2. The **old agent is released**: their tracking session is closed (a *release*, not a terminal — the
   shipment isn't over), their reserved capacity is returned, and — the moment `agent_id` is cleared —
   they **lose all access to the shipment**: customer personal data (delivery address, phone), live
   tracking, and every shipment action (pickup / status / COD collect) now return
   `404 SHIPMENT_NOT_FOUND` for them. They keep only their **activity history** (their accepted offer
   row, which carries no customer PII). The old agent also receives a **`shipment.reassigned_away`**
   notification telling them they are no longer responsible for it.
3. The shipment's status resets: **pre-pickup → `assigned`** (back to the agency queue); **post-pickup
   → `handing_over`** (the parcel is being handed over and the order stays "shipped") until the new
   agent picks it up.
4. A **fresh offer** is sent to the replacement, **carrying the pickup location** so they see where to
   collect *before* accepting. Their tracking session opens **only when they accept** — so at no point
   are two agents tracked for one shipment. The customer's tracking switches to the new agent through
   the same grant path as first assignment.

### Automatic pickup location (by status at reassignment)

The default collection point is derived from the shipment's status **when it is reassigned**:

| Status when reassigned | Default pickup (`source`) | Meaning |
|---|---|---|
| `picked_up` / `in_transit` | `previous_agent_location` | the old agent's **last known GPS** — the expected handover point between the two agents |
| `returned` | `original_pickup` | the shipment's **original pickup** — the vendor business address (snapshot) or the agency warehouse it shipped from |
| `failed` | `agency_business` | the **responsible agency's HQ** location |
| `assigned` (pre-pickup) | *(none)* | the parcel never left the agency; the new agent uses the order's normal per-item pickups |

If the automatic source can't be resolved (e.g. the previous agent never streamed a position), it
falls back to the agency business location with `is_fallback: true` and a note — never an error.

**Re-delivering a `returned` shipment** re-opens it for a fresh attempt: for **COD** it revives the
cancelled delivery code — the customer is sent a **new code** — and clears the terminal `failed`
payment status so the re-delivery can settle. A `returned`/`failed` shipment whose **order already
completed** cannot be reassigned (`SHIPMENT_REASSIGNMENT_NOT_ALLOWED`).

### Manual override (Part 3)

Pass `pickupLocation` to override the automatic default. Any subset is accepted (a coordinate needs
**both** `latitude` and `longitude`):

```json
{
  "agentId": "6612...",
  "reason": "Agent A's bike broke down on Rue Joffre",
  "pickupLocation": {
    "label": "Total station, Rue Joffre",
    "addressLine1": "Rue Joffre", "city": "Douala", "state": "Littoral", "country": "CM",
    "latitude": 4.0483, "longitude": 9.7043,
    "note": "Agent A waits by the forecourt"
  }
}
```

The resolved pickup is stored on the shipment (`handover.pickup`) and mirrored onto the replacement's
offer (`pickupLocation`), so both the agent app (offer + shipment detail) and the agency dashboard can
show it.

### Response

```json
{
  "success": true,
  "message": "Shipment released from its agent and offered to the replacement",
  "data": {
    "reassignedFrom": "6612...",
    "previousStatus": "in_transit",
    "pickupLocation": {
      "source": "previous_agent_location",
      "label": "Handover with Jean (last known location)",
      "address": null,
      "location": { "type": "Point", "coordinates": [9.7043, 4.0483] },
      "note": null,
      "is_fallback": false
    },
    "offer": { "id": "665f...", "status": "pending", "expiresAt": "...", "pickupLocation": { "…": "…" } },
    "shipment": { "id": "665a...", "status": "handing_over", "assignmentState": "offered" },
    "autoAccepted": false
  }
}
```

**Errors**: `SHIPMENT_NOT_REASSIGNABLE` (422, no agent bound to reassign from),
`SHIPMENT_REASSIGNMENT_NOT_ALLOWED` (422, `details.status` — status not reassignable, **or the order
already completed**), `SHIPMENT_REASSIGN_REQUIRES_MANUAL_AGENT` (422, past-pickup with no `agentId`),
`SHIPMENT_REASSIGN_SAME_AGENT` (422), `SHIPMENT_REASSIGNMENT_CONFLICT` (409, the shipment moved under
a concurrent action — retry), `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422, `details.reasons`), the
contract-term gates (`CONTRACT_COVERAGE_REGION_NOT_COVERED`, `CONTRACT_SHIPMENT_VALUE_EXCEEDED` —
only when you name an `agentId`), COD gates, and `SHIPMENT_NO_ELIGIBLE_AGENTS` (422, released but no
replacement available now).

<a name="settings"></a>
## PATCH /api/agency/assignment-settings

Toggle auto-assignment. Body `{ "autoAssignEnabled": boolean }`. When **on**, a shipment handed to
this agency (on dispatch) automatically starts the [auto-assignment broadcast](#auto) — no manual pick
needed. When **off**, shipments wait for a manual pick (you can still trigger auto-assignment
per-shipment via [`POST .../auto-assign`](#auto)). The offer timeout and broadcast rounds are platform
defaults and are **not** configurable per agency. Stored on `assignment_settings.auto_assign_enabled`
(default **off**).

```json
{ "success": true, "message": "Assignment settings updated", "data": { "autoAssignEnabled": true } }
```

---

## What acceptance changes

On accept the shipment gains an `agent_id` (`assignmentState: "accepted"`) — the trackable binding.
Before that, `assignmentState` is `unassigned` (no offer out) or `offered` (a pending offer is out);
the shipment `status` stays `assigned` throughout. **A shipment cannot be picked up
(`PATCH .../status → picked_up`) until an agent has accepted** (`SHIPMENT_AGENT_NOT_ASSIGNED`).

## Notifications

- **`shipment.offer.accepted`** — an agent took the delivery.
- **`shipment.assignment.unfilled`** — nobody accepted across the **full broadcast** (every candidate
  declined or ignored over both rounds, or no eligible agent existed); assign manually. For an
  auto-assigned shipment this fires only after the last round, so treat the shipment as *searching*
  until then.

Both gated by the agency's `shipmentAssigned` notification preference.
