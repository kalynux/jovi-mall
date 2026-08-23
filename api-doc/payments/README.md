# Payments — gateway checkout (role-neutral)

One payment surface, shared by every flow that takes money from a **customer**: a single-order
payment, a whole multi-vendor cart in one charge, or a service booking.

- **Base URL**: `http://localhost:8022/api`
- **Response envelope**: standard `{ success, ... }` — see [../README.md](../README.md#the-response-envelope-read-this-first).
- **Gateways**: `NOTCHPAY` and `MYCOOLPAY` (mobile money), `STRIPE` (cards).

> ### All three gateways are live
>
> NotchPay and My-CoolPay were placeholders until Phase 1 — they made no HTTP call at all, and
> unkeyed they fabricated a `PENDING` response with a hard-coded USSD code so a checkout *looked*
> like it had started while no money moved. Both are now real, both verify their webhook
> signatures, and `GET /api/internal/admin/system/integrations` reports each honestly.
>
> Two behaviours differ per gateway and a client has to handle both:
>
> - **My-CoolPay Orange Money asks for a one-time code.** `initiate` answers `PENDING` with
>   `instructions.requiresOtp: true` and **no USSD code** — nothing happens until the customer's
>   SMS code is relayed to [`POST /payments/:transactionId/authorize`](#post-paymentstransactionidauthorize).
>   Rendering "dial the USSD code" here shows a prompt that will never arrive.
> - **My-CoolPay cannot refund.** Its API has no refund endpoint, so a refund on a My-CoolPay
>   payment answers `REFUND_GATEWAY_NOT_SUPPORTED` and is settled by hand — see
>   [Refunds](#refunds-differ-by-gateway).

> **⚠️ Breaking change (2026-07-29): `GET /api/payments/:transactionId` now requires
> authentication and returns only the caller's own transaction.** It previously accepted no
> credentials at all, so any transaction was readable by id. A client polling it must now send the
> session cookie or a Bearer token. See [Reading a transaction](#get-paymentstransactionid).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/payments/initiate` | **none** | Start a payment for a `cartId`, `orderId` or booking |
| `POST` | `/payments/verify` | **none** | Re-check a transaction against the gateway (idempotent) |
| `POST` | `/payments/:transactionId/authorize` | **none** | Submit the one-time code when `initiate` returned `requiresOtp` |
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

`channel.phoneNumber` must be **E.164** (leading `+` and country code, e.g. `+237670000001`) and
`channel.customerEmail` must be a valid email — both are forwarded to the gateway, so a malformed
value would otherwise surface as an opaque gateway failure or a receipt nobody receives. Both stay
**optional**; the rule applies only when the field is sent. See
[Contact formats](../README.md#contact-formats-phone--email).

**At least one** of `cartId` / `orderId` is required — sending neither is a `400` naming
`cartId`. Sending *both* is not rejected: `cartId` wins and `orderId` is ignored, so send the
one you mean.

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
  "instructions": { "ussdCode": "*126#", "message": "Confirm the prompt on your phone" },
  "message": "Payment initiated"
}
```

`success` is `false` when `status` is `FAILED`; the HTTP status is still `200`.

⚠ **`status` is the thing to branch on, not the HTTP code.** A gateway that *refuses* the
charge — wrong credentials, an operator it will not route, a provider 4xx — comes back as a
`200` carrying `status: "FAILED"` and the provider's reason in `message`. Nothing was sent to
the customer's handset and nothing is coming; a client that only checks the HTTP status shows
"waiting for your payment" forever. Only a transport-level failure (the provider unreachable,
an unhandled error) is a `502 PAYMENT_INITIATION_FAILED`.

**A refused initiation leaves the order at `pending`, not `AWAITING_PAYMENT`** (changed
2026-08-23). It used to advance regardless, which stated as fact that a gateway was waiting
when none was. `pending` is equally payable — both `cartId` and `orderId` initiation accept it
— so **retry is unaffected**; it just stops the order claiming a payment is in flight. The
order is never written `failed` by this path: only `cancelOrder` does that, and a declined
attempt that poisoned the order would make every retry impossible.

### The `instructions` object — branch on it, do not assume

| Field | Present when | What the client must do |
|---|---|---|
| `ussdCode` | Mobile money, ordinary flow | Show the code; the customer approves on the handset |
| `requiresOtp: true` | **My-CoolPay Orange Money** | Collect the SMS code and POST it to `/payments/:transactionId/authorize`. There is **no** `ussdCode` on this branch. |
| `clientSecret` | Stripe | Confirm with Stripe.js / Payment Element |
| `chargedAmount` / `chargedCurrency` | Stripe | The amount actually charged, in the presentment currency (the order stays priced in XAF) |
| `message` | Always | Human-readable copy, already localised for the customer |
| `expiresAt` | Sometimes | When the payment session lapses |

**Mobile money needs the operator.** NotchPay's direct charge takes an explicit channel, so send
`channel.phoneOperator` (`MTN` or `ORANGE`) when you know it. If you omit it the server derives it
from the number's prefix, and refuses with `PAYMENT_OPERATOR_UNDETERMINED` (422) when it cannot —
a Nexttel or Camtel number, or a typo. Ask the customer rather than guessing; sending the wrong
channel reaches them as "payment declined".

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

## Gateway webhooks (server-to-server — not client-callable)

Documented here because they are what actually settles a payment; a frontend never calls them.

**All three are signature-verified, and all three are raw-parsed.** `express.raw` is mounted on
each of the three exact paths before `express.json()` — not on the `/api/webhooks` prefix, which
also carries the messaging-bot routers.

| Path | Signature | Register it as |
|---|---|---|
| `POST /api/webhooks/stripe` | `stripe-signature` verified against `STRIPE_WEBHOOK_SECRET` | Dashboard → Developers → Webhooks |
| `POST /api/webhooks/notchpay` | `x-notch-signature` — HMAC-SHA256 hex over the raw body, keyed by the dashboard's **Hash Key** (`hsk_…`, not the private key) | Settings → Webhooks |
| `POST /api/webhooks/mycoolpay` | body field `signature` — MD5 of `transaction_ref + transaction_type + transaction_amount + transaction_currency + transaction_operator + PRIVATE_KEY`, plus `application` matched against our public key | the application's Callback URL |

Both providers reject a callback URL that is not HTTPS with a valid certificate, so local
development needs a tunnel.

### What each status code tells the gateway

The status code is the contract: it decides whether a dropped confirmation is retried or lost.
Every branch of both mobile routes used to answer `200`, including the catch — so a confirmation
lost to a restart was acknowledged as delivered and never resent.

| Situation | Status |
|---|---|
| Processed, or a genuine duplicate, or a transaction we do not hold | `200` |
| Malformed body | `400` |
| Missing or invalid signature (and a wrong `application`, which is deliberately indistinguishable) | `401` |
| Callback from an unexpected source address (My-CoolPay, when IP pinning is on) | `403` |
| **We** are not configured to verify — no secret set | `503` |
| Permanent processing failure (authentic but unprocessable) | `200` |
| **Transient processing failure** — the gateway must retry | `500` |

Other properties worth knowing:

- **The whole `/api/webhooks` prefix is exempt from rate limiting**, and stays reachable during a
  maintenance window unless the operator set `blockWebhooks` on it. A 429 or a 503 to a gateway
  loses a payment notification. See [../rate-limits.md](../rate-limits.md).
- **Replay protection is a durable event store**, `payment_webhook_events`, unique on
  `(gateway, eventId)`, TTL 45 days. Stripe's own event id is used where one exists; My-CoolPay
  mints none, so the id is derived from the fields that define the event. The old
  `gatewayPayloadHash` remembered only the *last* payload and is no longer a dedup control.
- **A verified callback is cross-checked against the recorded amount and currency** before
  anything settles. A mismatch is refused and logged; it never marks a payment succeeded.
- **These bodies are provider-shaped, not the platform envelope.** They answer the gateway, not
  your frontend.
- Stripe routes by `metadata.purpose`; the mobile gateways route by the **merchant reference** we
  mint and they echo back (`reference` / `app_transaction_ref`), which is what lets a mobile-money
  plan purchase or credit top-up settle from a callback at all — those create no
  `PaymentTransaction`. `charge.dispute.created`, `charge.dispute.closed` and `charge.refunded`
  are handled separately — freeze on open, resume on `won`, unwind on `lost` or a **full** refund
  (a partial `charge.refunded` is deliberately not unwound).

---

## `POST /payments/:transactionId/authorize`

Only reached when `initiate` answered `instructions.requiresOtp: true` (My-CoolPay Orange Money).

```jsonc
// Request
{ "code": "123456" }          // 4–8 digits

// 200
{
  "success": true,
  "transactionId": "...",
  "status": "PENDING",
  "instructions": { "ussdCode": "#150*50#", "message": "Confirm the payment prompt on your phone." },
  "message": "Code accepted. Confirm the payment prompt on your phone."
}
```

The payment is still `PENDING` afterwards — the code authorises the charge, the customer still
confirms it on the handset, and the webhook settles it.

| Code | Status | When |
|---|---|---|
| `PAYMENT_OTP_INVALID` | 422 | Wrong code. `details.attemptsRemaining` says how many are left. |
| `PAYMENT_OTP_ATTEMPTS_EXCEEDED` | 422 | Too many wrong codes — **the transaction is now `FAILED`**. Start a new payment. |
| `PAYMENT_OTP_NOT_REQUIRED` | 422 | This gateway has no OTP step, or the transaction is no longer pending. |

Unauthenticated, like `initiate` and `verify`. What bounds it is the IP rate limit plus the
per-transaction attempt counter, not a session.

---

## Refunds differ by gateway

Refunds are not initiated from this surface (see the admin and vendor order docs), but which
gateway took the money decides what happens:

| Gateway | Refund |
|---|---|
| `STRIPE` | Real API refund |
| `NOTCHPAY` | Implemented, but **disabled on the merchant account** — `POST /refunds` answers 403 while `GET /refunds` answers 200 with the same credentials (verified against the live sandbox, 2026-08-18). Behaves as `MYCOOLPAY` below until NotchPay enables it and `NOTCHPAY_REFUNDS_ENABLED=true` is set. |
| `MYCOOLPAY` | **`REFUND_GATEWAY_NOT_SUPPORTED`** — the provider has no refund endpoint at all. |

In the unsupported cases the booking or order goes to `refund_pending`, earnings are reversed,
and a HIGH support ticket is raised for a manual payout. **The cancellation or refund request
itself still succeeds** — a refund problem never keeps an appointment on the books.

`GET /api/internal/admin/orders/:id/refund-eligibility` reports `gatewayRefundSupported` **up
front** so the button is never offered for a refund that cannot happen. It answers two questions
at once — does this provider have a refund API, and may *our account* use it — because both
produce the same outcome for the operator and only one of them is fixable by an email.

---

## When a callback never arrives

Mobile-money confirmations land minutes after the request that opened them, by which time the
customer has usually closed the page — so the callback is the settlement path, not a bonus on top
of polling. A background sweep re-verifies mobile-money transactions (and pending plan purchases
and credit top-ups) against the gateway's own record, so a dropped callback self-heals without
anyone polling. Clients should still poll while the customer is watching; they do not have to keep
the page open for the payment to settle.

---

## Notes for integrators

- **`initiate` and `verify` are still unauthenticated.** They take a reference and talk to the
  gateway rather than returning stored records, so they leak far less than the read did — but treat
  `initiate` as capable of starting a payment for any order id supplied to it.
- **COD orders never touch this surface.** Cash on delivery is settled by the agent submitting the
  customer's delivery code; there is no gateway call. See [../agent/cod-cash.md](../agent/cod-cash.md)
  and [../customer/orders.md](../customer/orders.md).
- **Polling cadence**: after `initiate` returns `PENDING`, poll `GET /payments/:transactionId` (or
  `POST /payments/verify` to force a gateway re-check). Webhooks settle it regardless, and a
  background sweep re-verifies anything whose callback never arrived — so a customer who closes
  the page still gets their order.
- **Never treat `PENDING` as failed.** An unrecognised gateway status, and a verification the
  gateway could not answer, both resolve to `PENDING` rather than `FAILED` on purpose: calling a
  live payment dead strands the customer's money, and only a `PENDING` row is swept again.

## Related

- [../customer/orders.md](../customer/orders.md) — checkout, cart groups, and where `initiate` fits
- [../customer/bookings.md](../customer/bookings.md) — booking payment and its own status endpoint
- [../customer/payment-methods.md](../customer/payment-methods.md) — saved instruments
- [../billing-plans-across-roles.md](../billing-plans-across-roles.md) — plans/credit, a separate payment path
- [../errors/README.md](../errors/README.md) — error catalog
