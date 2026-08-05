# Agent Assignment Offers

The agent's side of the **agent-acceptance workflow**. An offer is the agency (or the system)
asking this agent to take a shipment. The shipment becomes the agent's **only when they accept** —
until then it carries no `agent_id`. A **manual** offer expires on a timeout if ignored; an **auto**
(system) offer stays open and is one of several in a broadcast (see the lifecycle below).

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
pending ─┬─ accept          → accepted    (agent bound to the shipment; tracking opens; COD code issued)
         ├─ reject          → rejected    (auto ⇒ next candidate offered; manual ⇒ back to the agency queue)
         ├─ timeout         → expired     (MANUAL offers only — the sweep reaps an ignored manual pick)
         ├─ another accepts → superseded  (an auto offer where a different agent was bound first)
         └─ agency          → cancelled   (agency withdrew, or a reassignment superseded the shipment)
```

**`origin` tells you which kind of offer you hold, and the two behave differently on timeout:**

- **`origin: "agency"` (manual pick)** — one-shot. If ignored it **expires** at `expiresAt`
  (`SHIPMENT_OFFER_TIMEOUT_SECONDS`, default **120s**) and the shipment returns to the agency queue.
  Here `expiresAt` is a real deadline — count down to it.
- **`origin: "auto"` (system auto-assignment)** — one candidate in a **broadcast**. It does **NOT**
  expire when `expiresAt` passes; it stays acceptable until you answer, a different agent is bound
  (⇒ your offer becomes `superseded`), the agency withdraws, or the shipment finishes. `expiresAt` here
  marks when the system offers the *next* nearest agent — so **several agents can hold a live offer for
  the same shipment at once, and the first to accept wins**. Your accept can therefore return
  `SHIPMENT_ALREADY_HAS_AGENT` even though your offer still showed `pending`. Do **not** hide the accept
  button or count down to a hard expiry for an auto offer; if you ignore it you may receive a **second
  push** (round 2) as a reminder before it is finally dropped.

- An agent with **auto-accept** enabled (`settings.auto_accept_assignments`) never sees a pending
  offer — it is accepted the instant it is created.
- A **reassignment** (another agent could not complete the delivery) arrives as an ordinary offer.
  The only visible difference is the shipment's status: a post-pickup reassignment is `handing_over`
  rather than `assigned`, meaning you must **collect the parcel** (from the agency or the previous
  agent) and then set `picked_up`. Accepting binds you and opens your tracking exactly as usual.

<a name="list"></a>
## GET /api/agent/offers

Query: `status?` (`pending|accepted|rejected|expired|cancelled|superseded`),
`q?` (free-text, min 2 chars — same fields as the [shipment list search](./shipments.md#list),
resolved to the offers on the shipments that match), `page?` (default 1), `limit?` (default 20,
max 100). Results lead with `pending`, then newest first.

Each offer carries everything needed to decide **before** accepting — what the job is, where it goes,
and what it pays — because the shipment itself is not readable until you accept.

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
      "createdAt": "2026-07-17T10:30:00.000Z",

      "orderNumber": "ORD-2026-000123",
      "shipmentStatus": "assigned",
      "itemCount": 2,
      "items": [
        {
          "productId": "...", "quantity": 1, "title": "Wireless Headphones", "variantTitle": "Black",
          "image": { "id": "...", "key": "products/abc.jpg", "url": "https://…/products/abc.jpg", "mimeType": "image/jpeg", "size": 84213, "originalName": "headphones.jpg" }
        }
      ],
      "agency": {
        "id": "6640...",
        "name": "Douala Express Logistics",
        "logo": { "id": "...", "key": "images/2026/07/logo.png", "url": "https://…/logo.png", "mimeType": "image/png", "size": 8213, "originalName": "logo.png" },
        "supportPhone": "+2376...",
        "supportEmail": "support@douala-express.cm",
        "supportWhatsapp": "+2376..."
      },
      "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376..." },
      "customer": { "name": "Marie", "phone": null, "redacted": true },
      "pickup": {
        "address": { "formattedAddress": "Rue 1234, Akwa, Douala", "coordinates": { "lat": 4.0511, "lng": 9.7043 }, "...": "AddressDetail" },
        "mode": "pickup_based",
        "count": 1
      },
      "deliveryAddress": {
        "formattedAddress": "Douala, Littoral, Cameroon",
        "addressLine1": null,
        "city": "Douala", "state": "Littoral", "country": "Cameroon",
        "coordinates": { "lat": 4.0333, "lng": 9.7000 }
      },
      "orderValue": { "total": 25000, "currency": "XAF" },
      "earning": { "amount": 1200, "currency": "XAF", "estimated": true, "deliveryFee": 2000, "basis": "contract_percentage" },
      "earningUnavailable": null
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

Addresses use the [`AddressDetail` shape](./shipments.md#address); `earning` is documented
[here](./shipments.md#earning).

**`agency`** is who is offering the job — the same block the [shipment detail](./shipments.md#detail)
carries. You hold contracts with several agencies at once and their terms differ, so *who is asking*
is part of the decision, not an after-the-fact detail. It is **not** redacted before acceptance: the
agency is your own contracted counterparty, not a third party whose privacy the offer protects.

**`items[].image`** is what the thing looks like — the **thumbnail only**, `{ id, key, url, mimeType,
size, originalName }` or `null` when the item has no picture. You cannot open the shipment until you
accept, so this is part of what makes the decision an informed one: an offer is judged on whether the
parcel fits your vehicle as much as on distance and pay. It is the **variant's** own image where the
variant has one, else the product's first — the variant is what is actually in the box. The full
gallery arrives on the [shipment detail](./shipments.md#detail) once you have accepted.

Images are **never redacted**: unlike the customer's name and street, what is being shipped is exactly
what you are being asked to decide about.

### Customer privacy on a pending offer

While an offer is `pending` the job is still a **proposal** — auto-assignment broadcasts the same
shipment to several agents at once, and the ones who decline never handle the parcel. So a pending
offer shows only what a delivery decision needs:

| | `pending` (and every non-accepted status) | `accepted` |
|---|---|---|
| `customer.name` | **first name only** (`"Marie"`) | full name |
| `customer.phone` | `null` | full number |
| `customer.redacted` | `true` | `false` |
| `deliveryAddress` | city, region, country + **coordinates** — enough to judge the distance | full street address |
| `pickup`, `items` (images included), `orderValue`, `earning`, `agency` | full | full |

Accepting reveals the rest immediately, and the shipment detail endpoints open up at the same moment.
(Deployments that prefer full visibility on pending offers can set
`SHIPMENT_ASSIGNMENT_OFFER_PII_REVEAL=on_offer`; the default is `on_accept`.)

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

Returns the single offer object (same enriched shape as a list entry, including the same
pending-offer redaction). `404 SHIPMENT_OFFER_NOT_FOUND` if it isn't this agent's.

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
| `CONTRACT_COVERAGE_REGION_NOT_COVERED` | 422 | This delivery is outside the regions your contract with that agency covers. `details: { deliveryRegion, coveredRegions }`. |
| `CONTRACT_SHIPMENT_VALUE_EXCEEDED` | 422 | The parcel is worth more than your contract's per-shipment ceiling. `details: { shipmentValue, ceiling }`. **Not COD-specific** — the risk is the goods. |
| `COD_AGENT_EXPOSURE_EXCEEDED` / `COD_AGENT_TRUST_TOO_LOW` | 422 | COD headroom/trust gate (COD orders only). |

> **The contract-term gates are re-checked here, not only when the offer was made.** An offer can
> sit while the agency and agent renegotiate coverage or the value ceiling, so an offer that was
> valid when it arrived can legitimately fail on accept. Checked in the order coverage → value →
> COD, which is why a shipment outside your regions reports that rather than a cash limit.
>
> Both gates **fail open on missing data**: a contract with no declared regions covers everywhere, an
> order with no delivery region is never gated, and a null ceiling caps nothing. You will not be
> refused a job because a field was never filled in.

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
- **`shipment.offer.expired`** — a **manual** offer you didn't answer in time lapsed. (Auto offers
  don't expire this way — an ignored one stays open until another agent is bound or the search ends.)
- **`shipment.reassigned_away`** — a shipment you were handling was reassigned to another agent. You
  are no longer responsible for it and its customer/tracking details are no longer available to you;
  it stays in your activity history. No action button — there is nothing left to do on it.

Gated by the `assignmentOffers` preference (default on) under
[`/api/agent/notification-preferences`](notifications.md). Accept/reject confirmations are
deliberately **not** notified — you took the action.
