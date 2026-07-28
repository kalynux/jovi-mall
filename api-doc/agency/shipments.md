# Agency Shipments

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`GET /api/agency/shipments`](#list) — shipments assigned to this agency
- [`GET /api/agency/shipments/:id`](#detail) — full shipment detail
- [`PATCH /api/agency/shipments/:id/status`](#status) — advance a shipment (picked up, in transit, delivered by agent, failed/retry)
- [`POST /api/agency/shipments/:id/reject`](#reject) — decline an assigned shipment
- [`PATCH /api/agency/shipments/:id/assign-agent`](#assign-agent) — **offer** the shipment to one of this agency's agents (agent-acceptance workflow)
- [`PATCH /api/agency/shipments/:id/tracking-number`](#tracking-number) — record the carrier tracking number

> **Assignment is now an offer, not a push.** `assign-agent` creates an offer the agent must accept
> (accept / reject / ignore-timeout), and the shipment gains an `agent_id` only on acceptance. The
> full assignment surface — manual offer, auto-assignment, candidate preview, offer cancellation, and
> the auto-assignment toggle — is documented in [assignment.md](assignment.md); the agent's side is
> [agent/offers.md](../agent/offers.md).

Ownership is enforced at the query level on every endpoint below — an agency can only see/act on
shipments whose `agency_id` matches its own. A shipment outside the agency's scope is reported as
`404 SHIPMENT_NOT_FOUND` (existence of other agencies' shipments is never leaked).

> **Visibility gate.** A shipment is created (status `pending`) the moment the customer checks
> out — **before payment, before any vendor review.** Every endpoint here (list, detail, and every
> action) treats a `pending` shipment as if it doesn't exist yet. It only becomes visible once the
> vendor explicitly dispatches the paid order via
> [`POST /api/vendor/orders/:id/dispatch`](../vendor/orders.md#dispatch) (or the vendor has
> `auto_redirect_orders_to_agency` enabled, which does the same thing automatically on payment).
> This is the vendor's review/approval step before an order reaches the agency's dashboard.

---

## Shipment status lifecycle

```
pending → assigned → picked_up → in_transit → agent_delivered → delivered
                  ↘ rejected                ↘ failed → in_transit (retry)
                                                      ↘ returned
          ↘ pending_agency_reassignment (admin agency-deactivation cascade only)

  (agent → agent reassignment, POST .../reassign — see agency/assignment.md)
    assigned                        → assigned      (pre-pickup: back to queue)
    picked_up / in_transit / failed → handing_over → picked_up (new agent picks up)
                                                    ↘ returned  (handover abandoned)
```

| Status | Set by | Meaning |
|---|---|---|
| `pending` | System | Shipment created at checkout; not yet handed to the agency. **Invisible to the agency.** |
| `assigned` | **Vendor** (dispatch) or System (auto-redirect) | Order paid and dispatched; the agency now owns this shipment — first status the agency can see. |
| `handing_over` | System (`POST .../reassign`, post-pickup) | A picked-up parcel was reassigned off its agent and is being handed over to a replacement. Trackable (the replacement is tracked once they accept), non-terminal — resolves when the new agent sets `picked_up` (or `returned` if the handover is abandoned). See [agency/assignment.md](./assignment.md#reassign). |
| `picked_up` | **Agency** (`PATCH .../status`) | Agency has physically picked up / pulled from storage. |
| `in_transit` | **Agency** | Out for delivery. |
| `agent_delivered` | **Agency** | Agent reports delivered — **awaiting customer confirmation**. |
| `delivered` | **System** (customer confirms, or the 7-day sweep) | Terminal, and an agency can never set it directly. **Prepaid:** the customer confirms via [`POST …/confirm-delivery`](../customer/orders.md#confirm-shipment), or the sweep does it for them after 7 days at `agent_delivered`. **COD:** the agent submits the customer's delivery code, or — after 7 days at `agent_delivered` — the sweep records the cash as collected without one. COD never reaches `delivered` without a cash collection behind it. |
| `failed` | **Agency** | A delivery attempt failed (e.g. customer unreachable). |
| `returned` | **Agency** | Terminal. Goods returned after a failed attempt. |
| `rejected` | **Agency** (`POST .../reject`) | Terminal for this shipment. Agency declined the assignment; its items move to `pending_agency_reassignment` for the vendor to reroute. |
| `pending_agency_reassignment` | System | Awaiting a new agency (rejection, or admin deactivated this agency). |

Every status change is appended to `status_history` (`{ status, changedAt, changedByRole }`),
which feeds the merged multi-agency timeline returned on the [shipment detail](#detail) endpoint
and on the vendor's `GET /api/vendor/orders/:id` (`deliveryTimeline`).

Each status change also recomputes the parent order's `fulfillment_status` — see
[vendor/orders.md#fulfillment-lifecycle](../vendor/orders.md#fulfillment-lifecycle).

### Cash-on-delivery (COD) shipments — different rules

For shipments belonging to a `cash_on_delivery` order (`paymentMethod` on the
[detail](#detail) response; see [cod-cash-management.md](./cod-cash-management.md) for the whole
cash chain), three rules change:

1. **Visible before payment.** COD orders are unpaid until handoff by design, so the vendor
   dispatches them (or auto-redirect fires) at checkout — the shipment reaches your dashboard
   without any payment.
2. **An agent must have accepted before `picked_up`.** Under the agent-acceptance workflow this now
   holds for **every** shipment (not just COD): `picked_up` on a shipment no agent has accepted fails
   with `SHIPMENT_AGENT_NOT_ASSIGNED`. For COD the agent is also the cash-accountable party, and the
   COD cash-exposure/trust gate is enforced when the offer is made and re-checked on acceptance
   (see [assignment.md](assignment.md)). The customer's delivery code is issued **at acceptance**
   (not at pickup) — they hold it before the agent reaches the door.
3. **`agent_delivered` is rejected; `delivered` happens via the delivery code.** The agent submits
   the customer's code (`POST /api/agent/shipments/:id/cod/collect`), which atomically records the
   cash and marks the shipment `delivered`. There is no customer app confirmation step for COD.

The [detail](#detail) response carries a `cod` block for these shipments:
`{ expectedAmount, currency, status: "pending" | "collected" | "cancelled", collectedAt }`
(present once picked up; never contains the customer's code).

---

<a name="list"></a>
### GET /api/agency/shipments

**Description**: Shipments assigned to this agency, newest first.

**Query Parameters**:
- `status` (string, optional) — filter by shipment status (see lifecycle table above).
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 100)

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439100",
      "orderId": "507f1f77bcf86cd799439010",
      "agencyId": "507f1f77bcf86cd799439099",
      "agentId": null,
      "status": "assigned",
      "trackingNumber": null,
      "createdAt": "2026-07-05T09:00:00.000Z",
      "updatedAt": "2026-07-05T09:00:00.000Z",
      "orderNumber": "ORD-2026-000123",
      "vendor": { "id": "507f1f77bcf86cd799439aaa", "businessName": "Acme Store", "phone": "+237670000001" },
      "customer": { "id": "507f1f77bcf86cd799439ccc", "name": "Jane Doe", "phone": "+237670000002" },
      "itemCount": 2
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

---

<a name="detail"></a>
### GET /api/agency/shipments/:id

**Description**: Full detail for one of the agency's own shipments — items (each with its own
pickup location, #3), vendor (#4), customer + delivery address (#5), assigned agent, status
history, and the parent order's merged multi-agency timeline.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "orderNumber": "ORD-2026-000123",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "picked_up",
    "trackingNumber": "FS-1234567890",
    "items": [
      {
        "orderItemId": "507f1f77bcf86cd799439055",
        "productId": "507f1f77bcf86cd799439066",
        "quantity": 2,
        "title": "T-Shirt",
        "sku": "TSHIRT-RED-L",
        "variantTitle": "Size: Large, Color: Red",
        "pickupLocation": {
          "mode": "pickup_based",
          "alreadyInYourStorage": false,
          "address": { "label": "Main Shop", "addressLine1": "12 Rue du Marché", "addressLine2": null, "city": "Douala", "state": "Littoral" }
        }
      },
      {
        "orderItemId": "507f1f77bcf86cd799439056",
        "productId": "507f1f77bcf86cd799439067",
        "quantity": 1,
        "title": "Bulk Rice 25kg",
        "sku": "RICE-25KG",
        "variantTitle": null,
        "pickupLocation": {
          "mode": "storage_based",
          "alreadyInYourStorage": true,
          "address": { "label": "HQ Warehouse", "city": "Douala" }
        }
      }
    ],
    "vendor": { "id": "507f1f77bcf86cd799439aaa", "businessName": "Acme Store", "phone": "+237670000001", "email": "acme@example.com" },
    "customer": {
      "id": "507f1f77bcf86cd799439ccc",
      "name": "Jane Doe",
      "phone": "+237670000002",
      "email": "jane@example.com",
      "deliveryAddress": {
        "label": "Home",
        "addressLine1": "12 Rue de la Paix",
        "addressLine2": null,
        "city": "Douala",
        "state": "Littoral",
        "country": "CM"
      }
    },
    "agent": { "id": "507f1f77bcf86cd799439077", "name": "Paul Biya Jr.", "phone": "+237670000003", "avatar": null },
    "handover": null,
    "statusHistory": [
      { "status": "assigned", "changedAt": "2026-07-05T09:00:00.000Z", "changedByUserId": null, "changedByRole": "system" },
      { "status": "picked_up", "changedAt": "2026-07-05T14:00:00.000Z", "changedByUserId": "507f...", "changedByRole": "agency" }
    ],
    "rejection": null,
    "customerConfirmation": null,
    "orderTimeline": [
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Agency", "status": "assigned", "changedAt": "2026-07-05T09:00:00.000Z", "changedByRole": "system" },
      { "shipmentId": "507f1f77bcf86cd799439100", "agencyId": "507f1f77bcf86cd799439099", "agencyName": "FastShip Agency", "status": "picked_up", "changedAt": "2026-07-05T14:00:00.000Z", "changedByRole": "agency" }
    ]
  }
}
```

`handover` is non-null only for a **reassigned** shipment — the collection point the replacement agent
uses, and where it came from:

```json
"handover": {
  "pickup": {
    "source": "previous_agent_location",   // original_pickup | agency_business | manual
    "label": "Handover with Jean (last known location)",
    "address": { "line1": "Rue Joffre", "line2": null, "city": "Douala", "state": "Littoral", "country": null },
    "location": { "type": "Point", "coordinates": [9.7043, 4.0483] },
    "note": null,
    "is_fallback": false
  },
  "fromAgentId": "507f...", "fromStatus": "in_transit", "reassignedAt": "2026-07-06T08:00:00.000Z"
}
```

How the pickup is chosen (and how the agency overrides it) is documented under
[agency/assignment.md → reassign](./assignment.md#reassign).

> **`items[].pickupLocation`** — each product is individually configured by its vendor (subject to
> this agency's own policy — see [Delivery Agencies](../vendor/delivery-agencies.md) and
> [Vendor Products](../vendor/products.md#update-product)), so a single shipment can mix items with
> different pickup locations even though they're all the same vendor. `mode: "storage_based"` /
> `alreadyInYourStorage: true` means the item already sits in the agency's own warehouse — nothing
> to go collect (`address` is the agency's own HQ, resolved live, not vendor-specific). `mode:
> "pickup_based"` / `alreadyInYourStorage: false` means the agency must collect from the specific
> vendor business address the vendor chose for that product — `address` is a **snapshot** taken
> when the order was placed, so it stays accurate even if the vendor edits/removes that address
> later. `pickupLocation` is `null` only for shipments whose order predates this feature.
>
> **`orderTimeline`** — every shipment of the parent order (not just this one), so a multi-agency
> order shows the full cross-agency flow, not just this agency's slice.

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.

---

<a name="status"></a>
### PATCH /api/agency/shipments/:id/status

**Description**: Advance a shipment through the agency-triggerable states. Mirrors the new status
onto every order item riding this shipment and recomputes the order's `fulfillment_status`, all in
one transaction.

**Request Body**:
```json
{ "status": "picked_up" }
```
- `status` (string, required) — one of `picked_up`, `in_transit`, `agent_delivered`, `failed`,
  `returned`. Must be a valid transition from the shipment's current status (see lifecycle table
  above) — e.g. `picked_up` is only valid from `assigned`, `agent_delivered` only from
  `in_transit`. `agent_delivered` may also move to `failed`: a claim of arrival is not proof of
  one, and the customer may be out, refuse the parcel, or (COD) refuse to pay.

`agent_delivered` means **"the agent is at the door"**, not "this is delivered". What turns it into
`delivered` depends on how the order was paid, and neither is a status change:

| Paid | `agent_delivered` → `delivered` when | Auto-confirm? |
|---|---|---|
| Online | the **customer** confirms that shipment ([customer orders](../customer/orders.md)) | Yes — after a **7-day** dispute window |
| COD | the **agent submits the customer's delivery code** ([`collect`](../agent/cod-cash.md#collect)) | Yes — after **7 days** the cash is recorded as collected *without* a code |

> **COD:** `delivered` is rejected as a status change — a recorded cash collection is the only way
> there, so `delivered` and "cash collected" are always the same event. The normal route is the agent
> submitting the customer's code: the response to `agent_delivered` carries `requiresDeliveryCode:
> true`, the agent app's cue to ask for it.
>
> If the shipment sits at `agent_delivered` for **7 days** with no code, the auto-confirm sweep records
> the cash as **collected without a code** (`verification.method: "auto_no_code"`), marks the shipment
> `delivered`, and makes the **agent** liable for that cash — leaving a shipment at `agent_delivered`
> for the whole window is treated as an implicit assertion that the cash was taken. So an agent who was
> **not** paid must move the shipment `failed` → `returned` **within the window**, or they will be
> booked as holding cash they never collected. This auto-collect never releases anyone's earnings
> prematurely: COD earnings carry `requires_cash_settlement` and cannot release until the platform
> physically holds the remitted cash (see [cod-cash-management.md](./cod-cash-management.md)).
>
> `picked_up` additionally requires an assigned agent (`SHIPMENT_AGENT_NOT_ASSIGNED`). A `returned` COD
> shipment voids its pending cash collection.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "agent_delivered",
    "trackingNumber": "FS-1234567890",
    "requiresDeliveryCode": true,
    "nextAction": "Ask the customer for their delivery code and submit it to record the cash and complete the delivery.",
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T14:00:00.000Z"
  },
  "message": "Shipment status updated"
}
```

`requiresDeliveryCode` is `true` only for a COD shipment that just reached `agent_delivered`;
`nextAction` accompanies it. Both are absent/false otherwise.

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
- `400` – `SHIPMENT_INVALID_STATUS_TRANSITION` – Not a valid transition from the current status. `details` includes `{ from, to, allowed }`.

---

<a name="reject"></a>
### POST /api/agency/shipments/:id/reject

**Description**: Decline an assigned shipment before picking it up. Its items move to
`pending_agency_reassignment` so the vendor can route them to another agency via the existing
`PATCH /api/vendor/orders/:id/delivery-agency` endpoint — no separate reassignment flow needed.

Only allowed while the shipment is still `assigned` (not yet picked up).

**Request Body**:
```json
{ "reason": "other", "note": "Bike courier off sick today; no cover until Monday." }
```
- `reason` (string, required) — one of `out_of_coverage_area`, `capacity_exceeded`,
  `invalid_address`, `vendor_item_not_ready`, `other`. Fixed set, not free text.
- `note` (string, optional; **required when `reason` is `other`**) — free-text explanation,
  max **200** characters. The four concrete reasons are self-describing, so a note is optional
  for them; `other` is not, so it must be accompanied by a note. Persisted on the shipment's
  `rejection` and shown to the vendor on their order view.

The vendor whose order this is receives a `shipment.rejected` notification (in-app + push, with a
deep-link to the order) and sees the `reason` + `note` on the order's per-item delivery detail, so
they know why it was declined before rerouting.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": null,
    "status": "rejected",
    "trackingNumber": null,
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T09:30:00.000Z"
  },
  "message": "Shipment rejected"
}
```

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
- `422` – `SHIPMENT_REJECTION_NOT_ALLOWED` – Shipment has already been picked up (or otherwise isn't `assigned`). `details.status` shows the current status.
- `400` – validation error – `reason` missing/invalid, `note` longer than 200 chars, or `note` missing when `reason` is `other`.

---

<a name="assign-agent"></a>
### PATCH /api/agency/shipments/:id/assign-agent

**Description**: Offer this shipment to one of the agency's agents. **No longer a direct
assignment** — it creates an offer the agent must accept before the shipment is theirs (see the
[agent-acceptance workflow](assignment.md)). The shipment gains an `agent_id` only on acceptance.

**Request Body**: `{ "agentId": "507f1f77bcf86cd799439077" }`

**Success Response** (`200 OK`): returns the created offer + the shipment's assignment state. See
[assignment.md → manual pick](assignment.md#offer) for the full response and error set. In short:
the response's `data.offer.status` is `pending` (or the agent's `autoAccepted` flag is `true` when
they have auto-accept on), and `data.shipment.assignmentState` is `offered` (or `accepted`).

> **COD:** for cash-on-delivery shipments the offer is additionally gated on the agent's cash risk
> profile up front, and re-checked at acceptance — the agent will physically hold this shipment's cash.

**Key errors**: `SHIPMENT_NOT_OFFERABLE` (422), `SHIPMENT_ALREADY_HAS_AGENT` (409),
`SHIPMENT_ALREADY_HAS_PENDING_OFFER` (409), `AGENT_NOT_ELIGIBLE_FOR_ASSIGNMENT` (422),
`COD_AGENT_EXPOSURE_EXCEEDED` / `COD_AGENT_TRUST_TOO_LOW` (422, COD only). Full list in
[assignment.md](assignment.md#offer).

---

<a name="tracking-number"></a>
### PATCH /api/agency/shipments/:id/tracking-number

**Description**: Record or replace the carrier tracking number on a shipment this agency handles.

**Request Body**:
```json
{
  "trackingNumber": "FS-1234567890"
}
```
- `trackingNumber` (string, required, 1–120 chars).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": null,
    "status": "assigned",
    "trackingNumber": "FS-1234567890"
  },
  "message": "Tracking number updated successfully"
}
```

> Once set, the tracking number is surfaced on the vendor order detail
> (`items[].delivery.trackingNumber` and `deliveries[].trackingNumber`) and on the ticket
> reference lookups (`/reference/orders`).

**Error Responses**:
- `400` – `VALIDATION_ERROR` – Missing/invalid `trackingNumber`.

---

## Notifications

You receive an agency notification (in-app, always; plus your configured secondary channel) when
a vendor dispatches an order to you: `shipment.assigned` (`aggregateType: "shipment"`, `aggregateId`
= the `Shipment` id). Fires on both manual dispatch and payment-triggered auto-redirect — the
shipment's `status` has already moved `pending` → `assigned` by the time it's delivered, so it will
show up in `GET /api/agency/shipments` immediately.

Toggle via the `shipmentAssigned` flag on [notification preferences](./notifications.md) (default:
on).
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
