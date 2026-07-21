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
`AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422, `details.reasons`), COD gates
(`COD_AGENT_EXPOSURE_EXCEEDED`, `COD_AGENT_TRUST_TOO_LOW`).

<a name="auto"></a>
## POST /api/agency/shipments/:id/auto-assign

Rank eligible agents and offer the top one now, on demand (even if the agency's standing auto-assign
toggle is off). No body. `422 SHIPMENT_NO_ELIGIBLE_AGENTS` when no agent qualifies.

The ranking is: eligible agents (active · active contract with this agency · online · tracking
allowed · device location · under capacity), filtered for COD orders to those under their COD
headroom, then scored by **distance to pickup + free capacity + trust**. The full ranked pool is
snapshotted onto the offer so a decline/timeout walks to the next agent without recomputing.

<a name="candidates"></a>
## GET /api/agency/shipments/:id/assignment-candidates

Preview the ranked pool without offering. Returns each candidate with a score breakdown
(`distance_km`, `distance_score`, `free_capacity`, `capacity_score`, `trust_score`, `weighted`).

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
   tracking, and every shipment action (pickup / COD collect / tracking-number) now return
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
a concurrent action — retry), `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422, `details.reasons`), COD gates,
and `SHIPMENT_NO_ELIGIBLE_AGENTS` (422, released but no replacement available now).

<a name="settings"></a>
## PATCH /api/agency/assignment-settings

Toggle auto-assignment. Body `{ "autoAssignEnabled": boolean }`. When **on**, a shipment handed to
this agency (on dispatch) is automatically offered to the top-ranked agent — no manual pick needed.
The offer timeout is a platform default and is **not** configurable per agency.

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
- **`shipment.assignment.unfilled`** — nobody accepted (declined / timed out / pool exhausted);
  assign manually.

Both gated by the agency's `shipmentAssigned` notification preference.
