# Agent Assignment Offers

The agent's side of the **agent-acceptance workflow**. An offer is the agency (or the system)
asking this agent to take a shipment. The shipment becomes the agent's **only when they accept** —
until then it carries no `agent_id`, and the offer expires on a timeout if ignored.

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

Every endpoint is scoped to the authenticated agent. An offer that is not this agent's is reported
as `404 SHIPMENT_OFFER_NOT_FOUND` — other agents' offers are never leaked.

## Endpoints

- [`GET /api/agent/offers`](#list) — this agent's offers (pending first)
- [`GET /api/agent/offers/:id`](#detail) — one offer's detail
- [`POST /api/agent/offers/:id/accept`](#accept) — take the job
- [`POST /api/agent/offers/:id/reject`](#reject) — decline the job

---

## Offer lifecycle

```
pending ─┬─ accept  → accepted   (agent bound to the shipment; tracking opens; COD code issued)
         ├─ reject  → rejected   (auto ⇒ next candidate; manual ⇒ back to the agency queue)
         ├─ timeout → expired    (the "ignore" branch — the expiry sweep reaps it)
         └─ agency  → cancelled  (agency withdrew, or a reassignment superseded the shipment)
```

- **Timeout** is a platform default (`SHIPMENT_OFFER_TIMEOUT_SECONDS`, default **120s**), returned as
  `expiresAt` on every offer so the app can count down.
- At most **one** pending offer exists per shipment at a time (offers are sequential).
- An agent with **auto-accept** enabled (`settings.auto_accept_assignments`) never sees a pending
  offer — it is accepted the instant it is created.
- A **reassignment** (another agent could not complete the delivery) arrives as an ordinary offer.
  The only visible difference is the shipment's status: a post-pickup reassignment is `handing_over`
  rather than `assigned`, meaning you must **collect the parcel** (from the agency or the previous
  agent) and then set `picked_up`. Accepting binds you and opens your tracking exactly as usual.

<a name="list"></a>
## GET /api/agent/offers

Query: `status?` (`pending|accepted|rejected|expired|cancelled|superseded`), `page?` (default 1),
`limit?` (default 20, max 100). Results lead with `pending`, then newest first.

```json
{
  "success": true,
  "data": [
    {
      "id": "665f...",
      "shipmentId": "665a...",
      "orderId": "6659...",
      "agencyId": "6640...",
      "agentId": "6612...",
      "status": "pending",
      "origin": "auto",
      "expiresAt": "2026-07-17T10:32:00.000Z",
      "respondedAt": null,
      "rejectionReason": null,
      "isCod": true,
      "expectedCodAmount": 25000,
      "currency": "XAF",
      "pickupLocation": null,
      "score": 0.87,
      "createdAt": "2026-07-17T10:30:00.000Z"
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

`pickupLocation` is **null for a first-assignment offer** (use the shipment's per-item pickups). For a
**reassignment** offer it is the handover collection point, so you know where to pick the parcel up
before accepting:

```json
"pickupLocation": {
  "source": "previous_agent_location",   // or original_pickup | agency_business | manual
  "label": "Handover with Jean (last known location)",
  "address": { "line1": "Rue Joffre", "line2": null, "city": "Douala", "state": "Littoral", "country": null },
  "location": { "type": "Point", "coordinates": [9.7043, 4.0483] },
  "note": null,
  "is_fallback": false
}
```

`location` (GeoJSON `[lng, lat]`) and/or `address` is populated; `is_fallback: true` means the exact
point couldn't be resolved and a sensible default (the agency) was used. After you accept, the same
data is on the shipment detail under `handover`.

<a name="detail"></a>
## GET /api/agent/offers/:id

Returns the single offer object (same shape as a list entry).
`404 SHIPMENT_OFFER_NOT_FOUND` if it isn't this agent's.

<a name="accept"></a>
## POST /api/agent/offers/:id/accept

Take the job. On success the shipment gains this `agent_id` (the real binding), live tracking opens
for the customer/agency, and — for COD — the customer's delivery code is issued. Eligibility and (for
COD) the exposure limit are re-checked at this moment, and a capacity slot is reserved atomically.

**Response** `200`:

```json
{
  "success": true,
  "message": "Offer accepted",
  "data": {
    "offer": { "id": "665f...", "status": "accepted", "...": "..." },
    "shipment": { "id": "665a...", "agentId": "6612...", "status": "assigned", "assignmentState": "accepted" }
  }
}
```

**Errors**

| Code | HTTP | When |
|---|---|---|
| `SHIPMENT_OFFER_NOT_FOUND` | 404 | Not this agent's offer, or no such offer. |
| `SHIPMENT_OFFER_EXPIRED` | 409 | The timeout elapsed before acceptance. |
| `SHIPMENT_OFFER_NOT_PENDING` | 409 | Already accepted/rejected/expired/cancelled. |
| `SHIPMENT_ALREADY_HAS_AGENT` | 409 | Another agent was bound first. |
| `SHIPMENT_NOT_OFFERABLE` | 409 | The agency withdrew or reassigned the shipment. |
| `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` | 422 | Failed a re-check (offline, tracking off, …). `details.reasons` lists each. |
| `AGENT_AT_CAPACITY` | 422 | The agent is already carrying their maximum shipments. |
| `COD_AGENT_EXPOSURE_EXCEEDED` / `COD_AGENT_TRUST_TOO_LOW` | 422 | COD headroom/trust gate (COD orders only). |

<a name="reject"></a>
## POST /api/agent/offers/:id/reject

Decline the job. Body: `{ "reason"?: string }` (optional, ≤ 500 chars).

- If the offer was an **auto** assignment, the system immediately offers the next ranked candidate.
- If it was a **manual** pick (or the auto pool is exhausted), the shipment returns to the agency
  queue and the agency is notified to assign manually.

```json
{ "success": true, "message": "Offer rejected", "data": { "offer": { "id": "665f...", "status": "rejected" } } }
```

`409 SHIPMENT_OFFER_NOT_PENDING` if it was already answered or expired.

---

## Notifications

- **`shipment.offer.received`** — a new offer to answer (push is the load-bearing channel; it's
  time-sensitive). Deep-links to the offer.
- **`shipment.offer.expired`** — an offer you didn't answer in time lapsed.
- **`shipment.reassigned_away`** — a shipment you were handling was reassigned to another agent. You
  are no longer responsible for it and its customer/tracking details are no longer available to you;
  it stays in your activity history. No action button — there is nothing left to do on it.

Gated by the `assignmentOffers` preference (default on) under
[`/api/agent/notification-preferences`](notifications.md). Accept/reject confirmations are
deliberately **not** notified — you took the action.
