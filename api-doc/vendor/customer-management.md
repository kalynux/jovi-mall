# Vendor Customer Management API

API reference for the vendor dashboard **Customer Management** tab.

It covers four areas:

1. **Customer flags** — vendor-defined, customizable color-coded tags/groups.
2. **Customers** — the list of customers who have ordered from the vendor, with stats, name override, and flag assignment.
3. **Customer orders** — viewing a single customer's orders (reuses the existing orders endpoint).
4. **Refunds** — checking refund eligibility and actioning a refund on an order.

> **Data model note:** the customer list is backed by a first-class `vendor_customers`
> relation (the source of truth), not derived ad-hoc from orders. A relation row is
> created automatically the first time a customer orders, and order stats
> (`orderCount`, `totalSpent`, `lastOrderAt`) are denormalized onto it for sorting.
> The detail endpoint recomputes those stats live from the orders collection. Customer
> flags are stored under the vendor's settings document (`vendor_settings.customer_flags`).

---

## Conventions

- **Base path:** all routes are mounted under `/api/vendor`.
- **Auth:** every route requires a vendor session. Send the access token:
  `Authorization: Bearer <token>`
  The server derives the vendor from the token; you never pass a `vendorId`.
- **Roles:** the caller must have the `vendor` role (enforced by middleware).
- **Content type:** request bodies are JSON (`Content-Type: application/json`).
- **IDs:** all `:id` path params and id fields are 24-char hex MongoDB ObjectIds.
- **Money:** `totalSpent`, `amount`, `maxRefundable`, etc. are numbers in the order's
  currency (e.g. `XAF`). No implicit minor-units — values are whole currency units.
- **Dates:** ISO 8601 strings in responses.

### Success envelope

```jsonc
{
  "success": true,
  "data": { /* or [ ... ] */ },
  "meta": { /* present on paginated list endpoints */ },
  "message": "Optional human-readable message"
}
```

### Error envelope

Two slightly different shapes exist depending on the endpoint (see notes per
section). Both always include `success: false` and `error.code`:

```jsonc
// Customer + flag endpoints (global handler)
{
  "success": false,
  "requestId": "abc123",
  "error": { "code": "VENDOR_CUSTOMER_NOT_FOUND", "message": "...", "statusCode": 404, "details": { } }
}

// Refund + eligibility endpoints (order controller)
{
  "success": false,
  "error": { "code": "REFUND_WINDOW_EXPIRED", "message": "..." }
}
```

Always branch on `error.code` (stable machine-readable string), not on `message`.

Validation failures (Zod) return HTTP `400` with code `VALIDATION_ERROR` and a
`details` object/array describing the offending fields.

---

## 1. Customer Flags

Vendor-defined tags used to segment customers (e.g. "VIP", "Frequent Returner",
"New"). Each flag has a name, a hex color, and an optional description. Flags are
fully owned by the vendor and can be created/edited/deleted at any time.

Flags are stored as embedded entries on the vendor's settings document
(`vendor_settings.customer_flags`); the API shape below is unchanged. A flag `id`
is the embedded entry's ObjectId and is what you reference in `flagIds` when
assigning flags to a customer.

### Flag object

```jsonc
{
  "id": "665f0c1a2b3c4d5e6f701234",
  "name": "VIP",
  "color": "#FF8800",
  "description": "Top spenders",   // or null
  "createdAt": "2026-06-07T10:00:00.000Z",
  "updatedAt": "2026-06-07T10:00:00.000Z"
}
```

### GET `/api/vendor/customer-flags`

List all of the vendor's flags (oldest first).

**Response 200**
```jsonc
{ "success": true, "data": [ /* Flag objects */ ] }
```

### POST `/api/vendor/customer-flags`

Create a flag.

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | 1–60 chars. Must be unique among the vendor's active flags. |
| `color` | string | yes | Hex color, `#RGB` or `#RRGGBB`. |
| `description` | string \| null | no | ≤ 200 chars. *Clearable*: `null` or `""` clears (stored as `null`). |

**Response 201**
```jsonc
{ "success": true, "data": { /* Flag */ }, "message": "Flag created successfully" }
```

> Creating a second flag with a name that matches an existing active flag returns
> `409 VENDOR_CUSTOMER_FLAG_DUPLICATE`. The match is case-insensitive and trims
> surrounding whitespace.

### PATCH `/api/vendor/customer-flags/:id`

Update one or more fields of a flag. At least one field must be provided.

**Body** (all optional): `name`, `color`, `description` (same rules as create).

**Response 200** → `{ "success": true, "data": { /* Flag */ }, "message": "Flag updated successfully" }`
**Errors:** `404 VENDOR_CUSTOMER_FLAG_NOT_FOUND`; `409 VENDOR_CUSTOMER_FLAG_DUPLICATE` if `name` collides with another active flag.

### DELETE `/api/vendor/customer-flags/:id`

Soft-deletes the flag **and detaches it from every customer** that had it assigned.

**Response 200** → `{ "success": true, "message": "Flag deleted successfully" }`
**Errors:** `404 VENDOR_CUSTOMER_FLAG_NOT_FOUND`.

---

## 2. Customers

The customer list is backed by a first-class **`vendor_customers`** relation — the
source of truth for who a vendor's customers are. A relation row is created
automatically the first time a customer places an order with this vendor, so a
customer appears here from their first order onward. On top of that, the vendor can
override the displayed name (locally only) and assign flags.

> **Stats semantics**
> - `orderCount` = **all** orders with this vendor (any status).
> - `totalSpent` = sum of order totals for orders with `payment_status = "paid"` only.
>
> The **list** endpoint returns these stats from values denormalized onto the relation
> (so it can sort/paginate efficiently), maintained as orders are placed, paid, and
> fully refunded. The **detail** endpoint recomputes them live from the orders
> collection. The two can differ briefly under heavy churn; the detail figure is the
> live source of truth. Relations are not backfilled, so a customer whose only orders
> predate this feature appears once they place a new order.

### Customer list item

```jsonc
{
  "customerId": "665a...e1",
  "displayName": "Jane (VIP)",     // override if set, else realName
  "realName": "Jane Doe",          // the customer's actual profile name (read-only)
  "hasNameOverride": true,
  "email": "jane@example.com",      // or null
  "avatar": {                        // resolved file object (same shape as product media), or null
    "id": "665f0c1a2b3c4d5e6f705678",
    "key": "products/2026/07/jane-avatar.png",
    "url": "https://.../a.png",
    "mimeType": "image/png",
    "size": 15360,
    "originalName": "avatar.png"
  },
  "orderCount": 12,
  "totalSpent": 145000,
  "lastOrderAt": "2026-06-01T09:30:00.000Z",  // or null
  "flags": [ { /* Flag object */ } ]
}
```

### GET `/api/vendor/customers`

Paginated list of the vendor's customers.

**Query params**
| Param | Type | Default | Notes |
|---|---|---|---|
| `search` | string | — | Case-insensitive match on customer name OR email. |
| `flagId` | ObjectId | — | Only customers carrying this flag. |
| `page` | int ≥ 1 | 1 | |
| `limit` | int 1–100 | 20 | |
| `sortBy` | enum | `lastOrderAt` | `lastOrderAt` \| `totalSpent` \| `orderCount`. |
| `sortOrder` | enum | `desc` | `asc` \| `desc`. |

**Response 200**
```jsonc
{
  "success": true,
  "data": [ /* customer list items */ ],
  "meta": { "total": 87, "page": 1, "limit": 20, "pages": 5 }
}
```

### GET `/api/vendor/customers/:id`

Single customer detail (`:id` = customerId). Same fields as the list item, plus
`phone` and `shippingAddress`.

```jsonc
{
  "success": true,
  "data": {
    "customerId": "665a...e1",
    "displayName": "Jane (VIP)",
    "realName": "Jane Doe",
    "hasNameOverride": true,
    "email": "jane@example.com",
    "phone": "+237...",            // or null
    "avatar": null,
    "orderCount": 12,
    "totalSpent": 145000,
    "lastOrderAt": "2026-06-01T09:30:00.000Z",
    "flags": [ /* Flag objects */ ],
    "shippingAddress": {           // default address, or null
      "street": "12 Rue ...",
      "city": "Douala",
      "state": null,
      "country": "CM"
    }
  }
}
```

**Errors:** `404 VENDOR_CUSTOMER_NOT_FOUND` if no relation exists for this customer
(i.e. they have never ordered from this vendor) or the id is invalid.

### PATCH `/api/vendor/customers/:id/name`

Set or clear the **vendor-local** display name. This never modifies the customer's
real profile — only what this vendor sees.

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `displayName` | string \| null | yes | ≤ 120 chars. Send `null` or `""` to clear the override (falls back to `realName`). |

**Response 200** → the full updated customer detail object (as in GET detail), with `message`.
**Errors:** `404 VENDOR_CUSTOMER_NOT_FOUND`.

### PUT `/api/vendor/customers/:id/flags`

Replace the customer's full set of assigned flags (idempotent — send the complete
desired list each time).

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `flagIds` | string[] | yes | Up to 50 flag ObjectIds. Send `[]` to clear all. Every id must be one of the vendor's own flags. |

**Response 200** → the full updated customer detail object, with `message`.
**Errors:** `400 VENDOR_CUSTOMER_FLAG_NOT_FOUND` if any id is unknown/not owned;
`404 VENDOR_CUSTOMER_NOT_FOUND` if no relation exists for this customer (they
haven't ordered from this vendor).

> To add/remove a single flag, fetch the customer (or keep local state), modify the
> array, and PUT the whole array back.

---

## 3. A customer's orders ("View Orders")

There is **no new endpoint** for this — reuse the existing vendor orders list with
the new `customerId` filter.

### GET `/api/vendor/orders?customerId=:customerId`

**Relevant query params** (all optional, combine freely):
| Param | Type | Notes |
|---|---|---|
| `customerId` | ObjectId | Scope to one customer. |
| `status` | enum | `pending` \| `processing` \| `shipped` \| `delivered` \| `fulfilled` \| `cancelled`. |
| `paymentStatus` | enum | `pending` \| `AWAITING_PAYMENT` \| `paid` \| `failed` \| `refunded`. |
| `orderType` | enum | `physical` \| `digital`. |
| `dateFrom`, `dateTo` | ISO 8601 | Created-at range. |
| `q` | string | Order number search. |
| `page`, `limit` | int | `limit` max 100, default 20. |
| `sortBy` | enum | `created_at` \| `updated_at` \| `total_amount`. |
| `sortOrder` | enum | `asc` \| `desc`. |

Returns the standard paginated orders payload (`data` + `meta`). Order detail is
the existing `GET /api/vendor/orders/:id`.

---

## 4. Refunds

A vendor can refund a paid order if the vendor's return policy and the order's
state allow it. Always check eligibility first to drive the UI (show/hide the
refund button, prefill the amount).

> **Error shape note:** the two refund endpoints live on the orders controller and
> return the shorter error shape `{ success:false, error:{ code, message } }`.

### GET `/api/vendor/orders/:id/refund-eligibility`

Read-only. Never errors on ineligibility — it returns `eligible: false` plus a
`reasonCode` you can surface to the vendor.

**Response 200**
```jsonc
{
  "success": true,
  "data": {
    "eligible": true,
    "maxRefundable": 145000,   // most you may refund right now (policy + balance)
    "remaining": 145000,       // un-refunded balance of the payment
    "currency": "XAF",         // or null if no payment found
    "refundProcessingDays": 7, // policy: expected settle window (null if no policy)
    "returnShippingPayer": "customer", // policy: who pays return shipping (null if no policy)
    "reasonCode": "REFUND_WINDOW_EXPIRED"  // present only when eligible === false
  }
}
```

> `refundProcessingDays` and `returnShippingPayer` are echoed from the vendor's return
> policy for display only — they carry no money movement. `returnShippingPayer` is one of
> `vendor` | `customer` | `customer_reimbursed_if_defect`, or `null` when no policy is set.

**`reasonCode` values (when `eligible: false`)**
| Code | Meaning |
|---|---|
| `REFUND_POLICY_DISABLED` | Vendor has no return policy, returns are disabled, or `refund_type = none`. |
| `REFUND_ORDER_NOT_PAID` | Order `payment_status` is not `paid`. |
| `REFUND_PAYMENT_NOT_FOUND` | No successful payment transaction is linked to the order. |
| `REFUND_ALREADY_FULLY_REFUNDED` | The payment is already fully refunded. |
| `REFUND_WINDOW_EXPIRED` | Past `created_at + return_window_days`. |
| `REFUND_NOT_ELIGIBLE` | Policy resolves the allowed amount to 0 (e.g. partial policy with 0%). |

**Errors:** `404 ORDER_NOT_FOUND` if the order isn't found or isn't this vendor's.

### POST `/api/vendor/orders/:id/refund`

Action a refund. Calls the payment gateway live (Stripe is fully supported today).

**Body**
| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | number > 0 | no | Defaults to `maxRefundable`. If provided, must be ≤ `maxRefundable` (you can only refund the policy max or less). |
| `reason` | string | no | ≤ 500 chars. Stored on the refund + passed to the gateway. |

**Response 200**
```jsonc
{
  "success": true,
  "data": {
    "refundId": "666...aa",
    "status": "completed",
    "amount": 145000,
    "currency": "XAF",
    "totalRefunded": 145000,   // cumulative across all refunds on this payment
    "fullyRefunded": true,      // when true, order.payment_status becomes "refunded"
    "refundProcessingDays": 7,  // policy: expected settle window (null if no policy)
    "returnShippingPayer": "customer" // policy: who pays return shipping (null if no policy)
  },
  "message": "Order fully refunded"   // or "Partial refund processed"
}
```

**Errors**
| HTTP | Code | When |
|---|---|---|
| 404 | `ORDER_NOT_FOUND` | Order not found / not this vendor's. |
| 422 | `REFUND_POLICY_DISABLED` / `REFUND_WINDOW_EXPIRED` / `REFUND_NOT_ELIGIBLE` | Eligibility failed. |
| 409 | `REFUND_ORDER_NOT_PAID` / `REFUND_ALREADY_FULLY_REFUNDED` | Bad order/payment state. |
| 404 | `REFUND_PAYMENT_NOT_FOUND` | No successful payment to refund. |
| 400 | `REFUND_AMOUNT_EXCEEDS_MAX` | `amount` exceeds the allowed maximum. |
| 400 | `REFUND_GATEWAY_NOT_SUPPORTED` | Gateway has no refund support (NotchPay/MyCoolPay today). |
| 502 | `REFUND_GATEWAY_FAILED` | Gateway rejected the refund. |

**Recommended UI flow**
1. On order detail, call `GET …/refund-eligibility`.
2. If `eligible`, enable the refund control and prefill the amount with
   `maxRefundable` (allow the vendor to lower it, not raise it).
3. `POST …/refund` with `{ amount?, reason? }`.
4. On success, refresh the order (status may now be `refunded`) and re-fetch
   eligibility (subsequent partial refunds shrink `remaining`).

---

## Quick endpoint index

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vendor/customer-flags` | List flags |
| POST | `/api/vendor/customer-flags` | Create flag |
| PATCH | `/api/vendor/customer-flags/:id` | Update flag |
| DELETE | `/api/vendor/customer-flags/:id` | Delete flag (detaches from customers) |
| GET | `/api/vendor/customers` | List customers (search/flag/sort/paginate) |
| GET | `/api/vendor/customers/:id` | Customer detail + stats |
| PATCH | `/api/vendor/customers/:id/name` | Set/clear local name override |
| PUT | `/api/vendor/customers/:id/flags` | Replace assigned flags |
| GET | `/api/vendor/orders?customerId=:id` | A customer's orders |
| GET | `/api/vendor/orders/:id` | Order detail (existing) |
| GET | `/api/vendor/orders/:id/refund-eligibility` | Check refundability |
| POST | `/api/vendor/orders/:id/refund` | Action a refund |
