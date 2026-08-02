# Payments — gateway checkout (role-neutral)

One payment surface, shared by every flow that takes money from a **customer**: a single-order
payment, a whole multi-vendor cart in one charge, or a service booking.

- **Base URL**: `http://localhost:8022/api`
- **Response envelope**: standard `{ success, ... }` — see [../README.md](../README.md#the-response-envelope-read-this-first).
- **Gateways**: `NOTCHPAY` and `MYCOOLPAY` (mobile money), `STRIPE` (cards).

> **⚠️ Breaking change (2026-07-29): `GET /api/payments/:transactionId` now requires
> authentication and returns only the caller's own transaction.** It previously accepted no
> credentials at all, so any transaction was readable by id. A client polling it must now send the
> session cookie or a Bearer token. See [Reading a transaction](#get-paymentstransactionid).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/payments/initiate` | **none** | Start a payment for a `cartId`, `orderId` or booking |
| `POST` | `/payments/verify` | **none** | Re-check a transaction against the gateway (idempotent) |
| `GET` | `/payments/:transactionId` | **required, owner-scoped** | Read a transaction |

Related surfaces that do **not** live here:

| Flow | Where |
|---|---|
| Booking payment + its own status poll | `POST /api/bookings/:id/pay`, `GET /api/bookings/:id/payment-status` — [../customer/bookings.md](../customer/bookings.md) |
| Gateway webhooks (server-to-server) | `POST /api/webhooks/*` — not client-callable |
| **Plan purchases & credit top-ups** | `/{vendor,agency,agent}/plans/...`, `.../credits/topups` — a **separate** path that creates **no** `PaymentTransaction`. See [../billing-plans-across-roles.md](../billing-plans-across-roles.md) |
| Saved cards / mobile-money instruments | `/api/me/payment-methods` — [../customer/payment-methods.md](../customer/payment-methods.md) |

## Who can read a payment

| Role | Access |
|---|---|
| Anonymous | — (was: any transaction by id, until 2026-07-29) |
| Customer | ✅ their own payments only |
| Vendor | — on this endpoint. A vendor sees a *booking's* payment state via `GET /api/bookings/:id/payment-status` for bookings they own |
| Agency · Agent | — nothing here concerns them; their plan/credit purchases are a different surface (see above) |
| Admin | ✅ any transaction (disputes, refunds, support) |

---

## POST `/payments/initiate`

**Purpose**: Create (or return) the payment for a checkout group, a single order, or a booking.

**Auth**: None. **Idempotent** — repeated calls with the same reference return the existing
transaction rather than charging twice.

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `cartId` | string | one of | Preferred for cart checkout: one payment settles every order in the group |
| `orderId` | string | one of | Single-order payment (legacy path) |
| `gateway` | string | ✅ | `NOTCHPAY` \| `MYCOOLPAY` \| `STRIPE` |
| `channel` | object | ✅ | `{ phoneNumber?, phoneOperator?, cardToken?, customerEmail?, customerName? }` |

`channel.phoneNumber` is **required** unless `gateway` is `STRIPE`.

Exactly one of `cartId` / `orderId` must be sent — send both and the request is rejected.

### Example request

```json
{
  "cartId": "664crt...",
  "gateway": "NOTCHPAY",
  "channel": { "phoneNumber": "+237670000001", "phoneOperator": "MTN" }
}
```

### Example success `200`

```json
{
  "success": true,
  "transactionId": "664txn...",
  "status": "PENDING",
  "instructions": { "ussdCode": "*126#", "message": "Dial to approve" },
  "message": "Payment initiated"
}
```

`success` is `false` when `status` is `FAILED`; the HTTP status is still `200`.

---

## POST `/payments/verify`

**Purpose**: Ask the gateway for the current state of a transaction and apply it. Safe to call
repeatedly — settlement is idempotent.

**Auth**: None.

### Request body

| Field | Type | Required |
|---|---|---|
| `transactionId` | string | ✅ |

### Example success `200`

```json
{
  "success": true,
  "transactionId": "664txn...",
  "status": "SUCCEEDED",
  "message": "Payment verified"
}
```

`success` is `true` only when `status` is `SUCCEEDED`.

> Verification is also driven by **webhooks**, so a client that does nothing still sees the order
> settle. Poll this when you want the answer now, not to make settlement happen.

---

## GET `/payments/:transactionId`

**Purpose**: Read a transaction's stored details.

**Auth**: **Required** (cookie or `Bearer`) · **Permissions**: the payer, or `admin`.

> **A transaction that is not yours returns `404`, not `403`.** A `403` would confirm the id exists,
> which is the thing the ownership check is there to stop — transaction ids were previously the only
> protection on this data. An invalid (non-ObjectId) id also `404`s.

### Example success `200`

```json
{
  "success": true,
  "transaction": {
    "_id": "664txn...",
    "cartId": "664crt...",
    "orderIds": ["664ord...", "664ord..."],
    "userId": "664cus...",
    "gateway": "NOTCHPAY",
    "method": "MOBILE",
    "gatewayRef": "notch_ref_8891",
    "status": "SUCCEEDED",
    "amountSnapshot": 4500000,
    "currencySnapshot": "XAF",
    "idempotencyKey": "a3f9...",
    "totalRefunded": 0,
    "hasPartialRefund": false,
    "createdAt": "2026-07-29T09:00:00.000Z",
    "updatedAt": "2026-07-29T09:02:11.000Z"
  }
}
```

`rawGatewayPayloads` is always stripped — the raw gateway conversation is internal.

### Fields worth explaining

| Field | Notes |
|---|---|
| `amountSnapshot` / `currencySnapshot` | The amount **at payment time**, stored here on purpose: order totals can be edited afterwards, and money history must not move with them. |
| `cartId` + `orderIds` | Set together for a cart-group payment — one charge settling N per-vendor orders. Mutually exclusive with `orderId` and `bookingId`. |
| `totalRefunded` / `hasPartialRefund` | Refunds live in their own collection; these are the rolled-up view. |
| `userId` | The payer — but **not one kind of id**. Order and cart payments store the *customer* id; booking payments store the *user* id. Both are accepted by the ownership check, so either payer reads their own payment normally. Do not use this field to join across collections without knowing which flow produced the row. |

### Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | No token and no refresh cookie |
| `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | 401 | Expired, refresh unavailable — Bearer callers must re-login |
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | Unknown id, malformed id, **or the transaction is not yours** |

---

## Notes for integrators

- **`initiate` and `verify` are still unauthenticated.** They take a reference and talk to the
  gateway rather than returning stored records, so they leak far less than the read did — but treat
  `initiate` as capable of starting a payment for any order id supplied to it.
- **COD orders never touch this surface.** Cash on delivery is settled by the agent submitting the
  customer's delivery code; there is no gateway call. See [../agent/cod-cash.md](../agent/cod-cash.md)
  and [../customer/orders.md](../customer/orders.md).
- **Polling cadence**: after `initiate` returns `PENDING`, poll `GET /payments/:transactionId` (or
  `POST /payments/verify` to force a gateway re-check). Webhooks settle it regardless.

## Related

- [../customer/orders.md](../customer/orders.md) — checkout, cart groups, and where `initiate` fits
- [../customer/bookings.md](../customer/bookings.md) — booking payment and its own status endpoint
- [../customer/payment-methods.md](../customer/payment-methods.md) — saved instruments
- [../billing-plans-across-roles.md](../billing-plans-across-roles.md) — plans/credit, a separate payment path
- [../errors/README.md](../errors/README.md) — error catalog
