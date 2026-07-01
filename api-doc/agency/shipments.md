# Agency Shipments

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

---

### PATCH /api/agency/shipments/:id/tracking-number

**Description**: Record or replace the carrier tracking number on a shipment this agency handles.

Ownership is enforced at the query level — an agency can only update shipments whose `agency_id`
matches its own. A shipment outside the agency's scope is reported as not found (existence of
other agencies' shipments is never leaked).

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
