# Admin — Order Dispute Controls

Admin oversight of orders **frozen by a payment dispute** (e.g. a Stripe chargeback). Lets an admin
see held orders and manually resolve them when a gateway event is missed or the case is handled out of band.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Response envelope**: standard `{ success, data, meta?, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/orders/disputes` | List orders currently held by a payment dispute |
| `POST` | `/admin/orders/:id/dispute/resolve` | Manually resolve a held order's dispute |

---

## GET `/admin/orders/disputes`

**Purpose**: List orders with an active dispute hold (`dispute_hold.active = true`) **or**
`payment_status = "disputed"`, newest-updated first.

**Auth**: Required · **Permissions**: `admin`

### Query parameters

| Param | Type | Required | Validation |
|---|---|---|---|
| `page` | integer | ❌ | ≥ 1, default `1` |
| `limit` | integer | ❌ | 1–100, default `20` |

### Example success `200`

```json
{
  "success": true,
  "data": [
    {
      "_id": "664ord...",
      "payment_status": "disputed",
      "dispute_hold": { "active": true, "reason": "chargeback", "opened_at": "2026-07-15T09:00:00.000Z" },
      "fulfillment_status": "shipped",
      "total": 24500,
      "updated_at": "2026-07-16T12:00:00.000Z"
    }
  ],
  "meta": { "total": 3, "page": 1, "limit": 20, "pages": 1 }
}
```

---

## POST `/admin/orders/:id/dispute/resolve`

**Purpose**: Manually resolve an order's dispute.

- `won` — lift the hold and restore `payment_status: "paid"`.
- `lost` — refund, return/cancel the order, and reverse escrow.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `id` = order id (ObjectId)

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `outcome` | enum | ✅ | `won` \| `lost` |

### Example request

```json
{ "outcome": "won" }
```

### Example success `200`

```json
{ "success": true, "data": { "_id": "664ord...", "payment_status": "paid", "dispute_hold": { "active": false } }, "message": "Dispute resolved as won" }
```

### Example error `404`

```json
{ "success": false, "requestId": "req_abc", "error": { "code": "ORDER_NOT_FOUND", "message": "Order not found", "statusCode": 404 } }
```

## Business rules & notes

- This is an **override** path — the normal resolution is automatic from the payment gateway's dispute
  webhook. Use these endpoints when the automatic event is missed or the case is settled off-platform.
- `lost` is destructive (refund + return/cancel + escrow reversal); confirm the gateway outcome before calling.

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `outcome` missing/invalid, or bad `page`/`limit` |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-admin caller |
| `ORDER_NOT_FOUND` | 404 | No order with that id |

## Related

- [./cod.md](./cod.md) — COD oversight · [./payout-requests.md](./payout-requests.md)
- [../customer/orders.md](../customer/orders.md) · [../vendor/orders.md](../vendor/orders.md)
- [../vendor/stripe-payments.md](../vendor/stripe-payments.md) — payment/dispute lifecycle
