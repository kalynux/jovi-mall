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
- [`PATCH /api/agency/shipments/:id/assign-agent`](#assign-agent) — assign one of this agency's own agents
- [`PATCH /api/agency/shipments/:id/tracking-number`](#tracking-number) — record the carrier tracking number

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
```

| Status | Set by | Meaning |
|---|---|---|
| `pending` | System | Shipment created at checkout; not yet handed to the agency. **Invisible to the agency.** |
| `assigned` | **Vendor** (dispatch) or System (auto-redirect) | Order paid and dispatched; the agency now owns this shipment — first status the agency can see. |
| `picked_up` | **Agency** (`PATCH .../status`) | Agency has physically picked up / pulled from storage. |
| `in_transit` | **Agency** | Out for delivery. |
| `agent_delivered` | **Agency** | Agent reports delivered — **awaiting customer confirmation**. |
| `delivered` | **System** (customer confirms) | Terminal. Customer confirmed via [`POST /api/customer/orders/:orderId/shipments/:shipmentId/confirm-delivery`](../customer/orders.md#confirm-shipment) — an agency can never set this directly. |
| `failed` | **Agency** | A delivery attempt failed (e.g. customer unreachable). |
| `returned` | **Agency** | Terminal. Goods returned after a failed attempt. |
| `rejected` | **Agency** (`POST .../reject`) | Terminal for this shipment. Agency declined the assignment; its items move to `pending_agency_reassignment` for the vendor to reroute. |
| `pending_agency_reassignment` | System | Awaiting a new agency (rejection, or admin deactivated this agency). |

Every status change is appended to `status_history` (`{ status, changedAt, changedByRole }`),
which feeds the merged multi-agency timeline returned on the [shipment detail](#detail) endpoint
and on the vendor's `GET /api/vendor/orders/:id` (`deliveryTimeline`).

Each status change also recomputes the parent order's `fulfillment_status` — see
[vendor/orders.md#fulfillment-lifecycle](../vendor/orders.md#fulfillment-lifecycle).

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
    "agent": { "id": "507f1f77bcf86cd799439077", "name": "Paul Biya Jr.", "phone": "+237670000003", "avatarUrl": null },
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
  `in_transit`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "picked_up",
    "trackingNumber": "FS-1234567890",
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T14:00:00.000Z"
  },
  "message": "Shipment status updated"
}
```

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
{ "reason": "out_of_coverage_area" }
```
- `reason` (string, required) — one of `out_of_coverage_area`, `capacity_exceeded`,
  `invalid_address`, `vendor_item_not_ready`, `other`. Fixed set, not free text.

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

---

<a name="assign-agent"></a>
### PATCH /api/agency/shipments/:id/assign-agent

**Description**: Assign one of this agency's own agents to handle a shipment.

**Request Body**:
```json
{ "agentId": "507f1f77bcf86cd799439077" }
```

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "agencyId": "507f1f77bcf86cd799439099",
    "agentId": "507f1f77bcf86cd799439077",
    "status": "assigned",
    "trackingNumber": null,
    "createdAt": "2026-07-05T09:00:00.000Z",
    "updatedAt": "2026-07-05T09:15:00.000Z"
  },
  "message": "Agent assigned"
}
```

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
- `422` – `SHIPMENT_AGENT_NOT_IN_AGENCY` – The agent does not exist or belongs to a different agency.

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
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not handled by this agency.
