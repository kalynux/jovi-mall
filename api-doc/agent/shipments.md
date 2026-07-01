# Agent Shipments

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

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
