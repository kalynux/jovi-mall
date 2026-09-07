# Agent Shipments

**Verified against source on 2026-09-08** — every route, query parameter, transition, enum
value, response field and error code below, against `src/modules/delivery/agent.routes.ts`,
`src/modules/shipments/{shipment.service.ts, shipment.validator.ts, shipment.model.ts,
shipment.repository.ts}`,
`src/modules/shipment-assignment/domain/services/shipment-assignment.service.ts`,
`src/modules/agents/config/agent.config.ts` and
`src/modules/tracking-integration/services/visible-agents.service.ts`.
The transition table was re-derived from `TRIGGERABLE_TRANSITIONS` (not copied).

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

## Endpoints

- [`GET /api/agent/shipments`](#list) — shipments assigned to this agent (work queue), searchable
- [`GET /api/agent/shipments/:id`](#detail) — full detail incl. pickup locations, customer address, COD amount, your earning
- [`GET /api/agent/shipments/:id/route`](#route) — the pickup → drop-off line, for drawing on a map
- [`POST /api/agent/shipments/:id/status`](#status) — advance the shipment (pickup, in transit, delivered, failed, returned)
- [`POST /api/agent/shipments/:id/cancel`](#cancel) — cancel a shipment mid-delivery (with reason)
- `POST /api/agent/shipments/:id/cod/collect` — submit the customer's delivery code (see [cod-cash.md](./cod-cash.md#collect))
- `POST /api/agent/shipments/:id/cod/resend-code` — resend the delivery code (see [cod-cash.md](./cod-cash.md#resend))
- `POST /api/agent/shipments/:id/delivery-proof` — attach the proof photograph (see [delivery-proof.md](./delivery-proof.md#post-apiagentshipmentsiddelivery-proof))
- `GET /api/agent/shipments/:id/delivery-proof` — the proof's **metadata**, or `null` (see [delivery-proof.md](./delivery-proof.md#get-apiagentshipmentsiddelivery-proof))
- `GET /api/agent/shipments/:id/delivery-proof/file` — the image **bytes** (see [delivery-proof.md](./delivery-proof.md#get-apiagentshipmentsiddelivery-prooffile))
- `DELETE /api/agent/shipments/:id/delivery-proof` — remove it (see [delivery-proof.md](./delivery-proof.md#delete-apiagentshipmentsiddelivery-proof))

> ⚠ **The four delivery-proof rows were added 2026-09-06** (DOC-PROGRAM F-17 class 6). They are
> served under `/api/agent/shipments` and this page did not contain the string `delivery-proof`
> **once**, nor a link to the page that specifies them — while the two COD routes beside them
> had carried exactly this treatment all along.

> You drive your own shipment's **status transitions** — see
> [`POST /shipments/:id/status`](#status) — with exactly the same rights as your agency's dashboard,
> on **every** shipment you hold, whether it was assigned to you first or handed over to you by a
> reassignment. Either of you may move a shipment; if you both act at once, one request wins and the
> other gets `409 SHIPMENT_STATUS_CONFLICT` (reload and retry).
>
> The one status that is **not** yours to set is `delivered`, and it is nobody's: it is never a
> status change. On a cash-on-delivery shipment it happens only when you submit the customer's
> delivery code; on a prepaid one only when the customer confirms (or the 7-day window lapses).

---

<a name="list"></a>
### GET /api/agent/shipments

**Description**: Shipments assigned to this agent, newest first. Every row carries the pickup and
drop-off addresses (with coordinates) and this agent's estimated earning, so the list view alone is
enough to navigate by and to judge a job.

"Newest first" is the shipment's **own** `createdAt` descending — when the order was dispatched, not
when it was assigned to you. There is no assigned-at timestamp on a shipment, so a job you accepted
this morning off a three-day-old order sorts below one accepted yesterday off an order created today.

**Query Parameters**:
- `status` (string, optional) — one of `assigned`, `handing_over`, `picked_up`, `in_transit`, `agent_delivered`, `delivered`, `failed`, `returned`, `rejected`, `pending_agency_reassignment`.
- `scope` (string, optional) — `active` or `past`, the coarse "still mine to finish" / "over and done with" divide. **`active` is `assigned`, `handing_over`, `picked_up`, `in_transit`, `agent_delivered` and `failed`** — the same set that counts against your `capacity`, and `failed` is in it because the parcel is still in your van and `failed → in_transit|returned` is a legal move, so the job is not over. `past` is everything else (`delivered`, `returned`, `rejected`, `pending_agency_reassignment`). It exists because this divide cannot be expressed with `status`, which takes exactly one value — and since the list is paginated, narrowing a page client-side would under-report everything past it.
- `q` (string, optional, **min 2 chars**, max 100) — free-text search. See below.

Sending `scope` and `status` together is allowed, and **`status` wins** — it is the more specific of
the two. Because every status belongs to exactly one scope, a status filter can never widen the scope
it was chosen inside, so there is nothing to intersect.
- `page` (number, optional, default 1), `limit` (number, optional, default 20, max 100).

**What `q` searches** — one term against all of:

| Matched against | Example |
|---|---|
| Customer **name** | `?q=marie` |
| Customer **phone** (substring) | `?q=670123` |
| **Product** title on this shipment | `?q=samsung` |
| **Order number** | `?q=ORD-2026-000123` |
| **Tracking number** | `?q=FDO-260730` |

There is no separate "shipment number" — a shipment is identified by its `trackingNumber` (always
present; see [Tracking number](#tracking)) or its parent `orderNumber`. Because the tracking number
starts with the agency acronym and the date, a partial term like `FDO-2607` matches a whole month of
that agency's shipments. Product matching is scoped to the products **on this shipment**, so a
sibling shipment of the same order that does not carry the searched product will not match. The term
is escaped, so regex characters are matched literally. A term matching an unusually large number of
customers or products is capped at the first 500 of each.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439100",
      "orderId": "507f1f77bcf86cd799439010",
      "agencyId": "507f1f77bcf86cd799439099",
      "agentId": "507f1f77bcf86cd799439101",
      "status": "picked_up",
      "trackingNumber": "FDO-260705-090000-K7Q2M",
      "orderNumber": "ORD-2026-000123",
      "paymentMethod": "cash_on_delivery",
      "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376..." },
      "customer": { "id": "...", "name": "Jane D.", "phone": "+2376..." },
      "itemCount": 2,
      "itemImages": [
        { "id": "...", "key": "products/abc.jpg", "url": "https://…/products/abc.jpg", "access": "public", "mimeType": "image/jpeg", "size": 84213, "originalName": "headphones.jpg" }
      ],
      "pickup": {
        "address": {
          "label": "Main store",
          "formattedAddress": "Rue 1234, Akwa, Douala",
          "addressLine1": "Rue 1234", "addressLine2": null,
          "city": "Douala", "state": "Littoral", "country": "Cameroon",
          "coordinates": { "lat": 4.0511, "lng": 9.7043 }
        },
        "mode": "pickup_based",
        "count": 1
      },
      "deliveryAddress": {
        "label": "Home",
        "formattedAddress": "Rue 500, Bonapriso, Douala",
        "addressLine1": "Rue 500", "addressLine2": null,
        "city": "Douala", "state": "Littoral", "country": "Cameroon",
        "coordinates": { "lat": 4.0333, "lng": 9.7000 }
      },
      "earning": {
        "amount": 1200, "currency": "XAF", "estimated": true,
        "deliveryFee": 2000, "basis": "contract_percentage"
      },
      "earningUnavailable": null,
      "createdAt": "2026-07-10T09:00:00.000Z",
      "updatedAt": "2026-07-11T08:30:00.000Z"
    }
  ],
  "meta": { "total": 5, "page": 1, "limit": 20, "pages": 1 }
}
```

<a name="itemimages"></a>
**`itemImages`** is what is in the parcel, so a queue can be scanned by sight: **one thumbnail per
item**, deduplicated (two variants of the same product share a cover shot) and capped at **3**. The
row still reports `itemCount` for the true number of items — a 10-item shipment shows 3 pictures.
Each entry is the standard file shape `{ id, key, url, access, mimeType, size, originalName }`; always an
array, `[]` when nothing on the shipment has a picture. The full per-item gallery is on the
[detail](#detail).

The picture is the **variant's** own image where the variant has one, otherwise the product's first
image — the variant is what is actually in the box, so a red T-shirt does not show the blue one.
Images are read **live**, not snapshotted onto the order: a vendor who replaces their photo changes
what you see, and one who removes it leaves the item without a picture.

<a name="address"></a>
**The `AddressDetail` shape** is the same everywhere an address appears in this API:

| Field | Notes |
|---|---|
| `formattedAddress` | The geocoder's one-line rendering; composed from the stored fields when the address was never geocoded. |
| `coordinates` | `{ lat, lng }`, or **`null`** on a legacy address that was never geocoded. Always handle the null. |
| `label`, `addressLine1`, `addressLine2`, `city`, `state`, `country` | Any may be `null`. |

**`pickup`** describes where the parcel is collected:

| Field | Notes |
|---|---|
| `mode` | `pickup_based` (collect from the vendor), `storage_based` (already in the agency's warehouse), `mixed` (both, on one shipment), or `null` when no pickup could be resolved. |
| `count` | Distinct pickup points. Usually 1; a shipment carrying products from two vendor addresses, or a mix of vendor-collected and agency-stored items, has more. The per-item breakdown is in the [detail](#detail). |
| `address` | On a **reassigned** shipment this is the handover point (where the previous agent, or the agency, is holding the parcel) — **not** the original vendor address. |

<a name="earning"></a>
**`earning`** is what this delivery pays *you*:

| Field | Notes |
|---|---|
| `amount` | Your cut, in minor units. **`0` is a real answer** — it means your contract's `fee_split` pays nothing for this job (commonly, a contract whose split was never configured). |
| `estimated` | Always `true`. Your agency's pricing and your contract's split are re-read when the money is actually divided, so a change in between changes what you are paid. |
| `deliveryFee` | The whole fee your cut comes out of. |
| `basis` | `contract_percentage` or `contract_flat`. |
| `earningUnavailable` | Non-null **instead of** `earning` when no quote is possible: `no_contract` (no live contract with the dispatching agency) or `no_agency_policy` (the agency has no pricing configured). |

Both COD and online-paid shipments quote an earning — they pay at different moments (COD off the cash
handoff, online at `agent_delivered`) but from the same contracted share of the same delivery fee.

---

<a name="detail"></a>
### GET /api/agent/shipments/:id

**Description**: Full detail for one of this agent's shipments: line items with per-item pickup
location, vendor contact, customer contact + delivery address, status history, the order's merged
multi-agency timeline — and, for cash-on-delivery orders, the **cash to collect**.

**Success Response** (`200 OK`) — abridged to the shape; same as the agency's shipment detail:
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "orderNumber": "ORD-2026-000123",
    "status": "picked_up",
    "paymentMethod": "cash_on_delivery",
    "cod": {
      "expectedAmount": 52000,
      "currency": "XAF",
      "status": "pending",
      "collectedAt": null
    },
    "orderValue": { "total": 52000, "currency": "XAF" },
    "earning": {
      "amount": 1200, "currency": "XAF", "estimated": true,
      "deliveryFee": 2000, "basis": "contract_percentage"
    },
    "earningUnavailable": null,
    "items": [
      {
        "orderItemId": "...",
        "productId": "...",
        "quantity": 1,
        "title": "Wireless Headphones",
        "sku": "WH-BLK-01",
        "variantTitle": "Black",
        "images": [
          { "id": "...", "key": "products/abc.jpg", "url": "https://…/products/abc.jpg", "access": "public", "mimeType": "image/jpeg", "size": 84213, "originalName": "headphones.jpg" },
          { "id": "...", "key": "products/def.jpg", "url": "https://…/products/def.jpg", "access": "public", "mimeType": "image/jpeg", "size": 91002, "originalName": "headphones-side.jpg" }
        ],
        "pickupLocation": {
          "mode": "pickup_based",
          "alreadyInYourStorage": false,
          "address": { "label": "Main store", "formattedAddress": "Rue 1234, Akwa, Douala", "addressLine1": "Rue 1234", "city": "Douala", "state": "Littoral", "country": "Cameroon", "coordinates": { "lat": 4.0511, "lng": 9.7043 } }
        }
      }
    ],
    "pickup": { "address": { "...": "as in the list" }, "mode": "pickup_based", "count": 1 },
    "agency": {
      "id": "507f1f77bcf86cd799439099",
      "name": "Douala Express Logistics",
      "logo": { "id": "...", "key": "images/2026/07/logo.png", "url": "https://…/logo.png", "access": "public", "mimeType": "image/png", "size": 8213, "originalName": "logo.png" },
      "supportPhone": "+2376...",
      "supportEmail": "support@douala-express.cm",
      "supportWhatsapp": "+2376..."
    },
    "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376...", "email": "..." },
    "customer": {
      "id": "...",
      "name": "Jane D.",
      "phone": "+2376...",
      "deliveryAddress": { "label": "Home", "formattedAddress": "Rue 500, Bonapriso, Douala", "addressLine1": "Rue 500", "city": "Douala", "state": "Littoral", "country": "Cameroon", "coordinates": { "lat": 4.0333, "lng": 9.7000 } }
    },
    "handover": {
      "pickup": { "source": "previous_agent_location", "address": { "...": "AddressDetail" }, "note": null, "isFallback": false },
      "fromAgentId": "...", "fromStatus": "picked_up", "reassignedAt": "..."
    },
    "statusHistory": [ { "status": "assigned", "changedAt": "...", "changedByRole": "system" } ],
    "orderTimeline": [ ]
  }
}
```

**`agency`** is the agency that dispatched this shipment — its business name, logo and support
contacts, resolved from that agency's magazin. You serve several agencies at once, so `agencyId`
alone does not tell you who to call; this is the block that does. `logo` is a `FileDetail` (never a
bare URL), and the whole object is `null` only for an agency whose magazin has not been provisioned.

**`items[].images`** is **every** picture of that item, thumbnail first — this is the screen you are
on while matching a parcel on a counter to the job, and one angle is often not enough to tell two
boxes apart. `images[0]` is exactly the picture the list and the [offer](./offers.md) show for the
same item, so the same thumbnail component works on all three. Always an array, `[]` when the item
has no picture. Same selection and freshness rules as [`itemImages`](#itemimages) above.

| Money field | Description |
|---|---|
| `paymentMethod` | `"online"` or `"cash_on_delivery"` — whether you have to take money at the door. Also on every **list** row. |
| `cod` | `null` for online orders. Otherwise `expectedAmount` (the exact cash to collect **for this shipment**), `status`, `collectedAt`. **Never** contains the customer's delivery code. `status` runs `pending` → `collected`/`cancelled`, and is **`null`** in the window before any agent has accepted — there is no collection record yet, so `expectedAmount` is a projection of the same Σ (item price × quantity) the record will snapshot. On your own shipment you have accepted, so you will not normally see `null`. |
| `orderValue` | The value of the **whole order**. ⚠️ Not the same number as `cod.expectedAmount`: an order can split into several shipments across different agencies, and you only carry cash for yours. |
| `earning` / `earningUnavailable` | Your estimated cut — see [the earning table above](#earning). |

Other fields:

- `customer.deliveryAddress` is the address geocoded and **snapshotted at checkout** — the address
  the customer actually ordered to. It does not change if they later edit their saved addresses.
  Only orders predating that snapshot fall back to the customer's current default address.
- `pickup` summarises `items[].pickupLocation` into the single place you go; the per-item breakdown
  stays in `items` for a shipment with more than one pickup.
- `handover` is non-null only on a **reassigned** shipment, and its `pickup.address` is where you
  collect — it overrides the vendor address in `items[].pickupLocation`.
- All addresses use the [`AddressDetail` shape](#address), so `coordinates` may be `null`.

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.

---

<a name="route"></a>
### GET /api/agent/shipments/:id/route

**Description**: The pickup → drop-off line for one of this agent's shipments, ready to draw on a
map. Returns the **road-network** polyline when the live-tracking service is reachable, and the
straight line between the endpoints otherwise. A shipment with more than one pickup point routes
through the extras as waypoints.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "origin":      { "label": "Main store", "formattedAddress": "Rue 1234, Akwa, Douala", "coordinates": { "lat": 4.0511, "lng": 9.7043 }, "...": "AddressDetail" },
    "destination": { "label": "Home", "formattedAddress": "Rue 500, Bonapriso, Douala", "coordinates": { "lat": 4.0333, "lng": 9.7000 }, "...": "AddressDetail" },
    "waypoints": [],
    "source": "road",
    "reason": null,
    "distanceMeters": 2300.4,
    "durationSeconds": 540.2,
    "geometry": [
      { "lat": 4.0511, "lng": 9.7043 },
      { "lat": 4.0480, "lng": 9.7020 },
      { "lat": 4.0333, "lng": 9.7000 }
    ]
  }
}
```

| `source` | Meaning |
|---|---|
| `road` | Real road-following geometry. `distanceMeters` and `durationSeconds` are road values. |
| `straight` | The tracking service was unreachable or is not configured. `geometry` is just the endpoints in order, `distanceMeters` is great-circle, and **`durationSeconds` is `null`** — a straight-line ETA would be a guess. |
| `unavailable` | The line cannot be drawn: `geometry` is `[]` and `reason` says which end is missing. |

| `reason` (only when `source` is `unavailable`) | Meaning |
|---|---|
| `missing_pickup_coordinates` | The pickup address was never geocoded. |
| `missing_delivery_coordinates` | The drop-off address was never geocoded (a legacy order). |

> This endpoint **never fails because of the tracking service** — an outage degrades it to a straight
> line, never an error. Since the [detail](#detail) response already carries `coordinates` on both
> addresses, a client that only wants a straight line can draw one without calling this at all.

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.
- `404` – `ORDER_NOT_FOUND` – The parent order no longer exists.

---

<a name="tracking"></a>
### Tracking number (read-only — no endpoint)

`PATCH /api/agent/shipments/:id/tracking-number` **has been removed.** A shipment's tracking number
is generated by the platform the moment the shipment is created, so it is always present and nothing
can change it — not you, not your agency. Read it as `trackingNumber` on the
[list](#list) and [detail](#detail) responses; it is what you read out to a customer who asks, and
what [`?q=`](#list) searches.

**Format** — `ACR-YYMMDD-HHMMSS-XXXXX`, e.g. `FDO-260730-142309-K7Q2M`: the **agency's** acronym
(`FDO`), the UTC creation **date** (`260730`) and **time** (`142309`), then 5 random characters. The
random part deliberately excludes `I`, `L`, `O` and `U`, so nothing on a parcel label is ambiguous —
if you think you see an `O`, it is a zero.

Note the prefix is the **agency's**, not yours: a shipment handed over to you by a reassignment keeps
the number it was born with, so the customer's reference never changes mid-delivery.

---

<a name="status"></a>
### POST /api/agent/shipments/:id/status

**Description**: Advance one of your own shipments. You are the one physically collecting, driving
and knocking on the door, so these are yours to report — your agency can drive the same transitions
from its dashboard, but does not have to. Ownership is enforced: a shipment that is not yours reads
as not-found.

Every change appends to the shipment's `statusHistory` with `changedByRole: "agent"`, mirrors onto
the order's items, recomputes the order's `fulfillmentStatus`, and (where relevant) opens or closes
your live-tracking session.

**Allowed transitions**

| From | To |
|---|---|
| `assigned` | `picked_up` |
| `handing_over` | `picked_up`, `returned` |
| `picked_up` | `in_transit` |
| `in_transit` | `agent_delivered`, `failed` |
| `agent_delivered` | `failed` |
| `failed` | `in_transit` (retry), `returned` |

Anything else is `400 SHIPMENT_INVALID_STATUS_TRANSITION`, whose `details` carry `{from, to, allowed}`
so your app can render the buttons that actually apply.

This is the **same** table your agency works from — a shipment you took over from another agent
behaves exactly like one assigned to you from the start.

Notes on the edges:

- **`agent_delivered` means "I am at the door", not "this is delivered."** On a **prepaid** order it
  is the end of your run — it is what triggers your earnings — and the customer confirms afterwards.
  On a **cash-on-delivery** order the response comes back with `requiresDeliveryCode: true` and a
  `nextAction`: ask the customer for their code and submit it to
  [`/cod/collect`](./cod-cash.md#collect). That code is the only route to `delivered`.
- **`agent_delivered → failed` is deliberate.** A customer who is out, refuses the parcel, or (COD)
  will not pay would otherwise strand the shipment.
- **`failed` is not the end.** The parcel is still with you: retry with `in_transit`, or close the
  run with `returned`. Two consequences of leaving one parked at `failed` — it keeps holding one of
  your active-shipment capacity slots, and on a COD order it keeps the cash obligation open against
  your COD headroom. **Return the parcel to clear both.**
- **`handing_over` is where a shipment you took over from another agent starts.** Accepting the
  offer binds it to you but leaves the status at `handing_over`; you collect the parcel from the
  handover point (`handover.pickup` on the [shipment detail](#detail)) and record `picked_up`
  yourself. `returned` is the way out if the handover is abandoned.
- **You cannot cancel via this endpoint.** Walking away from a job is
  [`POST /shipments/:id/cancel`](#cancel), which releases you and re-offers the shipment. Use
  `failed` when *this delivery attempt* did not land but the parcel is still yours.

**Path Parameters**:
- `id` (string, required) — Shipment ID.

**Request Body**:
```json
{
  "status": "failed",
  "reason": "customer_unreachable",
  "note": "Called three times, no answer at the gate"
}
```
- `status` (string, required) — one of `picked_up`, `in_transit`, `agent_delivered`, `failed`, `returned`.
- `reason` (string, optional) — **only on `failed` and `returned`**. One of `customer_unreachable`,
  `customer_absent`, `customer_refused`, `address_not_found`, `address_inaccessible`,
  `payment_refused` (COD: the customer will not pay), `package_damaged`,
  `rescheduled_by_customer`, `other`.
- `note` (string, optional, ≤ 200 chars) — **only on `failed`/`returned`**, and **required when
  `reason` is `other`**.

Sending `reason` or `note` on any other status is rejected rather than ignored.

> These reasons are **not** the cancellation reasons. They describe why *this delivery attempt* did
> not land, with the parcel staying with you. If you cannot continue at all (breakdown, emergency),
> that is a [cancellation](#cancel) — using `failed` there strands the parcel on you.

Each `failed`/`returned` report is **appended** to the shipment's `deliveryFailures` log (visible on
[`GET /shipments/:id`](#detail)), never overwritten — so two failed attempts then a return read as
three entries, which is exactly the story an agency or a dispute needs.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439101",
    "status": "failed",
    "trackingNumber": "FDO-260705-090000-K7Q2M",
    "requiresDeliveryCode": false,
    "recordedFailure": {
      "status": "failed",
      "reason": "customer_unreachable",
      "note": "Called three times, no answer at the gate",
      "fromStatus": "in_transit",
      "reportedAt": "2026-07-30T14:22:05.000Z"
    }
  },
  "message": "Shipment status updated"
}
```
- `requiresDeliveryCode` — `true` only on a COD shipment you have just moved to `agent_delivered`;
  a `nextAction` string comes with it.
- `recordedFailure` — the entry appended to `deliveryFailures`, or `null` when the status records none.

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Unknown `status`/`reason`, `note` too long, `note` missing when `reason` is `other`, or `reason`/`note` sent on a status that takes none.
- `400` – `SHIPMENT_INVALID_STATUS_TRANSITION` – Not a legal move from the current status. `details: { from, to, allowed }`.
- `400` – `SHIPMENT_INVALID_STATUS_TRANSITION` – On COD, an attempt to reach `delivered` by status change; submit the delivery code instead.
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.
- `409` – `SHIPMENT_STATUS_CONFLICT` – Your agency (or another request) moved the shipment between your read and your write. `details: { expectedStatus, to }`. **Reload the shipment and retry** — do not blind-retry the same body.
- `422` – `SHIPMENT_AGENT_NOT_ASSIGNED` – No agent has accepted this shipment yet.

> Your agency is notified when you set `picked_up`, `agent_delivered`, `failed` or `returned` (with
> your reason, when you gave one). `in_transit` is not pushed at them.

---

<a name="cancel"></a>
### POST /api/agent/shipments/:id/cancel

**Description**: The assigned agent cancels a shipment they can no longer complete (mid-delivery).
This **releases** the agent — their capacity slot is returned and their live tracking session is
closed (a *release*, not a shipment termination) — records the cancellation reason, and **resumes
the automatic assignment** of this shipment from where it had reached, re-offering it to the next
ranked candidate without any agency intervention. Ownership is enforced (an agent can only cancel a
shipment whose `agent_id` is their own).

Cancellable from: `assigned`, `handing_over`, `picked_up`, `in_transit`, `failed`. Pre-pickup the
shipment returns to `assigned`; once the parcel is with the agent it enters `handing_over` (an
offerable, non-terminal state) and a handover collection point is recorded for the replacement.

**Path Parameters**:
- `id` (string, required) — Shipment ID.

**Request Body**:
```json
{
  "reason": "vehicle_breakdown",
  "note": "Flat tyre on the ring road, cannot continue today"
}
```
- `reason` (string, required) — one of: `vehicle_breakdown`, `personal_emergency`,
  `customer_unreachable`, `address_not_found`, `package_issue`, `safety_concern`, `too_far`, `other`.
- `note` (string, optional, ≤ 200 chars) — **required when `reason` is `other`**.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "shipmentId": "507f1f77bcf86cd799439100",
    "previousStatus": "in_transit",
    "reason": "vehicle_breakdown",
    "resumed": true,
    "shipment": {
      "id": "507f1f77bcf86cd799439100",
      "orderId": "507f1f77bcf86cd799439010",
      "agencyId": "507f1f77bcf86cd799439099",
      "agentId": null,
      "status": "handing_over",
      "assignmentState": "unassigned"
    }
  },
  "message": "Shipment cancelled"
}
```
- `resumed` — `true` when an automatic-assignment ranking existed and the broadcast was resumed from
  its cursor; `false` when the shipment had no auto-assignment session (it simply returns to the
  agency queue).

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Missing/invalid `reason`, `note` too long, or `note` missing when `reason` is `other`.
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.
- `422` – `SHIPMENT_CANCEL_NOT_ALLOWED` – The shipment's status is not agent-cancellable (e.g. already `delivered`/`returned`), or its order is already completed.
- `409` – `SHIPMENT_CANCEL_CONFLICT` – The shipment moved (a concurrent reassignment/status change) between read and write. `details: { expectedAgentId, expectedStatus }`. Retry from a fresh read.

---

## Three status subsets, and why they must not be derived from each other

`ShipmentStatus` has **eleven** members, and three different subsets of it drive three different
decisions. They overlap without agreeing, and each is defined in a different file.

| Set | Members | Decides | Defined in |
|---|:--:|---|---|
| `ACTIVE_SHIPMENT_STATUSES` | 6 | the agent's capacity, and `?scope=active` | `src/modules/agents/config/agent.config.ts` |
| `TRACKABLE_SHIPMENT_STATUSES` | 5 | whether geo-tracker will stream a position | `src/modules/tracking-integration/services/visible-agents.service.ts` |
| `UNTERMINATED_SHIPMENT_STATUSES` | 7 | the agency's plan cap | `src/modules/shipments/shipment.model.ts` |

🔴 **`failed` is the row that breaks clients.** It is **active** (the parcel is still in the van,
`failed → in_transit | returned` are both legal, it still holds a capacity slot and a COD cash
obligation) but **not trackable** (geo-tracker never opens a session for it). A client that gates
its live map on the *active* set — the natural move, since `?scope=active` is right there in the
list query — renders a map for a `failed` shipment and waits forever for a broadcast that will
never arrive. No error; the map is simply blank. **Gate the map on the trackable set and the work
queue on the active set.**

Two more in the same family: `handing_over` **is** trackable (a reassigned post-pickup delivery is
the one most in need of watching), and a trackable *status* is not trackability *in fact* — the
visibility rule also requires `agent_id != null`, so a shipment offered but not yet accepted has
nobody to track.
