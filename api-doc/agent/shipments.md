# Agent Shipments

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

## Endpoints

- [`GET /api/agent/shipments`](#list) — shipments assigned to this agent (work queue)
- [`GET /api/agent/shipments/:id`](#detail) — full detail incl. pickup locations, customer address, COD amount
- [`PATCH /api/agent/shipments/:id/tracking-number`](#tracking) — set carrier tracking number
- `POST /api/agent/shipments/:id/cod/collect` — submit the customer's delivery code (see [cod-cash.md](./cod-cash.md#collect))
- `POST /api/agent/shipments/:id/cod/resend-code` — resend the delivery code (see [cod-cash.md](./cod-cash.md#resend))

> Shipment **status transitions** (`picked_up`, `in_transit`, `failed`, `returned`) are driven by
> your agency's dashboard, not by agents — with ONE exception: a cash-on-delivery shipment reaches
> `delivered` exclusively through the agent submitting the customer's delivery code.

---

<a name="list"></a>
### GET /api/agent/shipments

**Description**: Shipments assigned to this agent, newest first.

**Query Parameters**:
- `status` (string, optional) — one of `assigned`, `picked_up`, `in_transit`, `agent_delivered`, `delivered`, `failed`, `returned`.
- `page` (number, optional, default 1), `limit` (number, optional, default 20, max 100).

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
      "trackingNumber": null,
      "orderNumber": "ORD-2026-000123",
      "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376..." },
      "customer": { "id": "...", "name": "Jane D.", "phone": "+2376..." },
      "itemCount": 2,
      "createdAt": "2026-07-10T09:00:00.000Z",
      "updatedAt": "2026-07-11T08:30:00.000Z"
    }
  ],
  "meta": { "total": 5, "page": 1, "limit": 20, "pages": 1 }
}
```

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
    "items": [
      {
        "orderItemId": "...",
        "productId": "...",
        "quantity": 1,
        "title": "Wireless Headphones",
        "sku": "WH-BLK-01",
        "variantTitle": "Black",
        "pickupLocation": { "mode": "pickup_based", "alreadyInYourStorage": false, "address": { "label": "Main store", "address_line1": "...", "city": "Douala", "state": null } }
      }
    ],
    "vendor": { "id": "...", "businessName": "TechHub Douala", "phone": "+2376...", "email": "..." },
    "customer": {
      "id": "...",
      "name": "Jane D.",
      "phone": "+2376...",
      "deliveryAddress": { "label": "Home", "addressLine1": "...", "city": "Douala", "country": "CM" }
    },
    "statusHistory": [ { "status": "assigned", "changedAt": "...", "changedByRole": "system" } ],
    "orderTimeline": [ ]
  }
}
```

| COD field | Description |
|---|---|
| `paymentMethod` | `"online"` or `"cash_on_delivery"`. |
| `cod` | `null` for online orders, or before pickup. Once the shipment is `picked_up`: `expectedAmount` (the exact cash to collect), `status` (`pending` → `collected`/`cancelled`), `collectedAt`. **Never** contains the customer's delivery code. |

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.

---

<a name="tracking"></a>
### PATCH /api/agent/shipments/:id/tracking-number

**Description**: Record or replace the carrier tracking number on a shipment assigned to this agent.

Ownership is enforced at the query level — an agent can only update shipments whose `agent_id`
matches their own. A shipment outside the agent's scope is reported as not found.

**Path Parameters**:
- `id` (string, required) — Shipment ID.

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
    "agentId": "507f1f77bcf86cd799439101",
    "status": "in_transit",
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
- `404` – `SHIPMENT_NOT_FOUND` – Shipment does not exist or is not assigned to this agent.
