# Phase D · 0 · 1 — customer app / storefront

Everything Phases D, 0 and 1 changed for the surface a shopper touches. Base URL
`http://localhost:8022/api` in development.

Phase 0 changed nothing on the wire. Phase D changed nothing on the wire *yet* — see
**§ 8**. **Phase 1 is the whole of the change**,
and it is concentrated in one place: mobile money is real now, so the payment screen has one
more branch, one more endpoint and one fewer reason to poll.

---

## 1 · Read this first — the four behaviours that change your payment screen

**1. A NotchPay charge often has no USSD code.** Verified against the live provider: a
`cm.mtn` direct charge answers with `action: "confirm"` and **no `ussd` field** — the operator
pushes an approval prompt to the handset and there is nothing to dial. `instructions.ussdCode`
is therefore optional in practice, not just in the type. Render `instructions.message`, which
is always present and is our copy, not the provider's.

**2. My-CoolPay Orange Money asks for an SMS code.** `initiate` answers `PENDING` with
`instructions.requiresOtp: true` and **no `ussdCode`**. Nothing is charged and no prompt is
sent until that code is relayed to `POST /payments/:transactionId/authorize`. A client that
renders "dial the code" on this branch shows the customer a prompt that will never arrive.

**3. The payment settles without you.** The gateway callback is the primary settlement path,
because a mobile-money confirmation lands minutes after the request that started it and the
customer has usually closed the page. Poll while the customer is watching; do not treat polling
as the thing that makes it settle. A callback that never arrives is closed by a background
sweep within 72 hours.

**4. A gateway failure is now a real failure.** Before Phase 1 an unconfigured gateway
fabricated a plausible `PENDING` response with a hard-coded USSD code, so a checkout *looked*
started while no money moved. That branch is deleted. An unreachable or misconfigured gateway
now returns `502`/`503` and the transaction is honestly `FAILED`.

---

## 2 · `POST /api/payments/initiate`

Start (or return) the payment for a checkout group, a single order, or — through the booking
routes in **§ 5** — a booking.

**Auth:** none, by design. Payment links are shareable and the person paying is often not the
person who ordered. **Idempotent:** a repeated call with the same reference returns the existing
transaction instead of charging twice.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `cartId` | string | one of | The checkout group. One payment settles every order sharing this `cart_id` |
| `orderId` | string | one of | A single-order payment |
| `gateway` | `"NOTCHPAY"` \| `"MYCOOLPAY"` \| `"STRIPE"` | ✅ | Any other value is `400 VALIDATION_ERROR` |
| `channel` | object | ✅ | The object itself is required; every field inside it is optional |
| `channel.phoneNumber` | string | required unless `gateway` is `STRIPE` | **E.164** — leading `+` and country code, e.g. `+237650123456`. Forwarded to the provider as typed |
| `channel.phoneOperator` | `"MTN"` \| `"ORANGE"` \| `"MOOV"` | optional | Send it when you know it. See **§ 2.1** |
| `channel.cardToken` | string | optional | Stripe only. Unused by the Payment Element flow |
| `channel.customerEmail` | string | optional | Must be a valid address. Stripe puts it on `receipt_email`; NotchPay receives it as `email` |
| `channel.customerName` | string | optional | Passed to My-CoolPay as `customer_name`; ignored by the others |

Exactly one of `cartId` / `orderId`. Sending neither is `400` with
`details.fields[].path = "cartId"`; sending both is accepted by the schema and **`cartId`
wins** — send one.

### Response `200`

```jsonc
{
  "success": true,
  "transactionId": "66c1f0a3e4b1d2c3a4b5c6d7",
  "status": "PENDING",
  "instructions": {
    "ussdCode": "*126#",
    "message": "Dial *126# on your phone to approve this payment."
  },
  "message": "Payment initiated successfully"
}
```

**Absent fields are omitted, not null.** `instructions` carries only the keys that apply to this
gateway and this branch, so test with `"requiresOtp" in instructions` or a truthiness check —
never `instructions.requiresOtp === false`. The same NotchPay charge on an operator that pushes a
prompt instead of a code returns `{ "message": "Approve the payment request on your phone to
complete this payment." }` and no `ussdCode` at all.

| Field | Type | Notes |
|---|---|---|
| `success` | boolean | `status !== "FAILED"`. **The HTTP status is `200` either way** — a refused charge is a successful request that reports a refusal |
| `transactionId` | string (24-hex) | The id every other endpoint on this page takes |
| `status` | string | `INITIATED` · `PENDING` · `SUCCEEDED` · `FAILED` · `CANCELLED` |
| `instructions` | object \| undefined | Absent when the gateway returned none. Branch on it — see **§ 2.2** |
| `message` | string | Human-readable. On a refusal this carries the gateway's reason |

When the transaction already exists, `message` is one of `"Payment already completed"` (status
`SUCCEEDED`, no `instructions`) or `"Payment already initiated. Complete the pending payment."`
(status `INITIATED`/`PENDING`, `instructions` replayed from the stored gateway response). A
`FAILED` or `CANCELLED` transaction is not replayed — a fresh one is created, so a retry after
a decline works with no extra call.

### 2.1 The operator rule

NotchPay's direct charge requires an explicit channel (`cm.mtn` / `cm.orange`) — it will not
work it out from the number. The resolution order is:

1. `channel.phoneOperator`, when it is `MTN` or `ORANGE`. A declared operator always wins.
2. Otherwise the Cameroon prefix table on the 9-digit national number:
   `650-654`, `670-679`, `680-684` → **MTN**; `655-659`, `685-689`, `690-699` → **ORANGE**.
3. Otherwise `422 PAYMENT_OPERATOR_UNDETERMINED`. **Ask the customer which network they are
   on** — do not retry with a guess; sending the wrong channel reaches them as "payment
   declined".

`+237650123456`, `237650123456` and `650123456` all resolve identically. `MOOV` is a valid
value of the field (the union is shared with other markets) but has **no Cameroon mobile-money
rail on either provider**, so it falls through to the prefix table; Nexttel (`66x`) and Camtel
(`62x`) numbers resolve to nothing and refuse. My-CoolPay derives the operator itself and needs
none of this — the asymmetry is real.

### 2.2 The `instructions` object

Every field is optional and which ones appear depends on the gateway and, for My-CoolPay, on
the customer's network.

| Field | Type | Present when | What you do |
|---|---|---|---|
| `ussdCode` | string | Mobile money, when the provider returned one | Show it; the customer dials it and approves on the handset |
| `requiresOtp` | boolean | **My-CoolPay Orange Money** — `true` | Collect the SMS code and POST it to `/payments/:transactionId/authorize`. There is **no** `ussdCode` on this branch |
| `message` | string | Always, on both mobile gateways | Render it. It is our copy, chosen from the provider's `action` — `confirm` → "Approve the payment request on your phone", `otp` → "Enter the confirmation code sent to your phone by SMS", a returned USSD code → "Dial `<code>` on your phone to approve this payment." |
| `clientSecret` | string | Stripe | Confirm with Stripe.js / the Payment Element |
| `chargedAmount` | number | Stripe | The amount actually charged, in `chargedCurrency` |
| `chargedCurrency` | string | Stripe | The presentment currency (`"usd"`). The order stays priced in XAF |
| `expiresAt` | ISO-8601 string | NotchPay, when the provider returned one | When the payment session lapses |

### 2.3 Errors

| `error.code` | Status | `category` | When |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | `validation` | Schema failure. `details.fields[]` carries `{ path, message, code }` per offending field |
| `PAYMENT_ORDER_NOT_FOUND` | 404 | `not_found` | No order for `orderId` |
| `PAYMENT_CART_NOT_FOUND` | 404 | `not_found` | No orders share that `cartId`. `details.cartId` |
| `PAYMENT_ORDER_IS_COD` | 422 | `business_rule` | Cash on delivery — there is nothing to charge |
| `PAYMENT_ORDER_ALREADY_PAID` | 409 | `conflict` | The order (or every order in the group) is already paid |
| `PAYMENT_CART_NO_PAYABLE_ORDERS` | 409 | `conflict` | Some orders exist but none is awaiting payment |
| `PAYMENT_INVALID_ORDER_STATUS` | 400 | `validation` | The order is not `AWAITING_PAYMENT`/`pending`. `details.status` |
| `PAYMENT_CART_MIXED_CURRENCY` | 400 | `validation` | The group spans more than one currency. `details.currencies` |
| `PAYMENT_OPERATOR_UNDETERMINED` | 422 | `business_rule` | Neither the declared operator nor the prefix could resolve MTN/Orange. `details.phoneOperator` |
| `PAYMENT_CURRENCY_NOT_SUPPORTED` | 422 | `business_rule` | A currency with a minor unit was sent to a mobile gateway. `details.currency` |
| `PAYMENT_GATEWAY_NOT_SUPPORTED` | 400 | `validation` | Unknown gateway name. `details.gateway` |
| `PAYMENT_GATEWAY_NOT_IMPLEMENTED` | 503 | `external_service` | **We** are not configured for that gateway. Message and `details` are replaced at the boundary |
| `PAYMENT_INITIATION_FAILED` | 502 | `external_service` | The gateway call threw. The transaction is left `FAILED` |
| `NOTCHPAY_REQUEST_FAILED` · `MYCOOLPAY_REQUEST_FAILED` | 502 | `external_service` | The provider answered non-2xx |
| `NOTCHPAY_UNREACHABLE` · `MYCOOLPAY_UNREACHABLE` | 503 | `external_service` | Timeout, DNS, refused connection. Default timeout is 15 s |
| `RATE_LIMIT_EXCEEDED` | 429 | `rate_limit` | 1200 requests/minute per IP. `details.retryAfterSeconds` |
| `SYSTEM_MAINTENANCE_ACTIVE` | 503 | `external_service` | A maintenance window. `initiate` is a write, so it is blocked in both `readonly` and `down` |

For `external_service` and `internal`, the `message` is replaced with a generic default and
`details` is dropped **in every environment**. Do not attempt to parse a provider's own error
text out of these — it is not there.

---

## 3 · `POST /api/payments/:transactionId/authorize` — **new endpoint**

Submit the one-time code for a charge whose `initiate` reported `instructions.requiresOtp`.
Only My-CoolPay has this step today (Orange Money).

**Auth:** none — it sits beside `initiate` and `verify` for the same shareable-link reason.
What bounds it is the per-IP rate limit plus a per-transaction attempt counter.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `code` | string | ✅ | **4–8 digits**, nothing else. `^\d{4,8}$`. Anything outside that is `400 VALIDATION_ERROR` and never reaches the provider |

### Response `200`

```jsonc
{
  "success": true,
  "transactionId": "66c1f0a3e4b1d2c3a4b5c6d7",
  "status": "PENDING",
  "instructions": {
    "ussdCode": "#150*50#",
    "message": "Confirm the payment prompt on your phone to complete this payment."
  },
  "message": "Code accepted. Confirm the payment prompt on your phone."
}
```

`success` is always `true` here — a wrong code is an error response, not `success: false`.

> **The payment is still `PENDING` after a correct code.** The code authorises the charge; the
> customer still confirms it on the handset, and the gateway callback settles it. Do not show a
> success screen on a `200` from this endpoint.

### Errors

| `error.code` | Status | `category` | When |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | `validation` | `code` is not 4–8 digits |
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | `not_found` | Unknown or malformed transaction id |
| `PAYMENT_OTP_INVALID` | 422 | `business_rule` | The provider refused the code. **`details.attemptsRemaining`** — render it |
| `PAYMENT_OTP_ATTEMPTS_EXCEEDED` | 422 | `business_rule` | The 6th wrong code (`PAYMENT_OTP_MAX_ATTEMPTS`, default 5). **The transaction is now `FAILED`** — start a new payment; waiting does not help, which is why this is 422 and not 429 |
| `PAYMENT_OTP_NOT_REQUIRED` | 422 | `business_rule` | This gateway has no OTP step (`details.gateway`), or the transaction is no longer `PENDING`/`INITIATED` (`details.status`) |

The attempt counter is incremented **before** the provider is called, so an aborted request
still spends an attempt. Count wrong codes in your UI from `details.attemptsRemaining` rather
than locally.

---

## 4 · Reading and re-checking a payment

### `POST /api/payments/verify`

Ask the gateway for the current state and apply it. **Auth:** none. Idempotent.

| Field | Type | Required |
|---|---|---|
| `transactionId` | string | ✅ |

```jsonc
{
  "success": true,
  "transactionId": "66c1f0a3e4b1d2c3a4b5c6d7",
  "status": "SUCCEEDED",
  "message": "Payment verified successfully"
}
```

`success` is `true` only when `status` is `SUCCEEDED`. A transaction already in a terminal state
(`SUCCEEDED`, `FAILED`, `CANCELLED`) returns immediately without calling the gateway, with
`message: "Payment succeeded"` / `"Payment failed"` / `"Payment cancelled"`.

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | `transactionId` missing or empty |
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | Unknown id |
| `PAYMENT_VERIFICATION_FAILED` | 502 | The gateway call threw. `category: external_service`, so `details` is dropped |

> A verification the provider could not answer resolves to **`PENDING`**, never `FAILED`. "We
> could not ask" is not "it failed".

### `GET /api/payments/:transactionId`

**Auth: required** (cookie or `Bearer`), and scoped to the payer. A transaction that is not
yours returns `404`, never `403` — a `403` would confirm the id exists. An id that is not a
valid ObjectId also `404`s. Admins are exempt from the ownership check.

```jsonc
{
  "success": true,
  "transaction": {
    "_id": "66c1f0a3e4b1d2c3a4b5c6d7",
    "cartId": "66c1efb1e4b1d2c3a4b5c6a0",
    "orderIds": ["66c1efb2e4b1d2c3a4b5c6a1", "66c1efb2e4b1d2c3a4b5c6a2"],
    "purpose": "primary",
    "userId": "66a0d1c2e4b1d2c3a4b5c100",
    "gateway": "NOTCHPAY",
    "method": "MOBILE",
    "gatewayRef": "trx.p8Kq2mFh3xR7",
    "merchantRef": "jm_pt_9f2c41ab77e0463d8a15c6be02d7f318",
    "status": "SUCCEEDED",
    "amountSnapshot": 45000,
    "currencySnapshot": "XAF",
    "idempotencyKey": "a3f9c1d0e8b7a6f5c4d3e2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1",
    "otpAttempts": 0,
    "gatewayPayloadHash": "7d2c9f4b1e0a3c6d5b8f2e1a4c7d0b3e6f9a2c5d8b1e4f7a0c3d6b9e2f5a8c1d",
    "totalRefunded": 0,
    "hasPartialRefund": false,
    "createdAt": "2026-08-18T09:00:00.000Z",
    "updatedAt": "2026-08-18T09:02:11.000Z",
    "__v": 0
  }
}
```

Every field of the stored record is returned **except `rawGatewayPayloads`**, which is stripped
because the raw provider conversation is internal.

The three source fields are **omitted, not null**, when they do not apply — the example above is
a cart-group payment, so it carries `cartId` and `orderIds` and has no `orderId` or `bookingId`
key at all. Treat all three as optional keys.

| Field | Type | Notes |
|---|---|---|
| `_id` | string | The transaction id |
| `orderId` | string \| absent | Set only on a single-order payment |
| `bookingId` | string \| absent | Set only on a booking payment |
| `cartId` | string \| absent | Set only on a cart-group payment. **Exactly one of these three is ever set** |
| `orderIds` | string[] \| absent | The group's orders. Present with `cartId`, and only then. A row whose `orderId` is absent is not incomplete |
| `purpose` | `"primary"` \| `"booking_balance"` | Which payment on the booking this is |
| `userId` | string | The payer — **not one kind of id**. Order and cart payments store the *customer* id; booking payments store the *user* id. Do not join on it without knowing which flow produced the row |
| `gateway` | string | `NOTCHPAY` · `MYCOOLPAY` · `STRIPE` |
| `method` | string | `MOBILE` · `CARD` · `CASH` |
| `gatewayRef` | string | The provider's own reference. Empty string until the provider answers |
| `merchantRef` | string \| null | **New in Phase 1.** Ours: `jm_pt_` + 32 hex characters, 128 random bits. Sent to the provider and echoed back on its callback. `null` on payments created before this field existed |
| `status` | string | See the shared status table |
| `amountSnapshot` | number | The amount **at payment time**, in whole XAF. Order totals can be edited afterwards; money history must not move with them |
| `currencySnapshot` | string | The currency at payment time, e.g. `"XAF"` |
| `idempotencyKey` | string | `sha256(sourceId:userId:amount)` — our initiate-dedup key. Deterministic by design, which is exactly why it is **not** the gateway-facing reference |
| `otpAttempts` | number | **New in Phase 1.** Wrong one-time codes submitted against this transaction. Compare with 5 (`PAYMENT_OTP_MAX_ATTEMPTS`) |
| `gatewayPayloadHash` | string \| absent | A hash of the last gateway payload. **A debugging aid only** — replay protection moved to a durable event store; do not gate anything on it |
| `totalRefunded` | number | Sum of completed refunds |
| `hasPartialRefund` | boolean | True when `0 < totalRefunded < amountSnapshot` |
| `createdAt` · `updatedAt` | ISO-8601 string | |
| `__v` | number | Mongoose's version key. Ignore it |

| `error.code` | Status | When |
|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | No token and no refresh cookie |
| `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | 401 | Bearer callers must re-login |
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | Unknown id, malformed id, **or not yours** |

---

## 5 · Booking payments

Same gateways, same `channel` object, same one-time-code endpoint — different mounts and a
different envelope (`{ success, data }`).

### `POST /api/bookings/:id/pay`

**Auth:** required, `customer` role, and the booking must be yours (`403 BOOKING_UNAUTHORIZED`
otherwise).

| Field | Type | Required |
|---|---|---|
| `gateway` | `"NOTCHPAY"` \| `"MYCOOLPAY"` \| `"STRIPE"` | ✅ |
| `channel` | object | ✅ — identical to **§ 2**, `phoneNumber` required unless Stripe |

```jsonc
{
  "success": true,
  "data": {
    "transactionId": "66c1f0a3e4b1d2c3a4b5c6d7",
    "status": "PENDING",
    "instructions": { "requiresOtp": true, "message": "Enter the confirmation code sent to your phone by SMS to complete this payment." },
    "message": "Payment initiated successfully"
  }
}
```

| `error.code` | Status | When |
|---|---|---|
| `BOOKING_NOT_FOUND` | 404 | No such booking |
| `BOOKING_UNAUTHORIZED` | 403 | Not your booking |
| `PAYMENT_BOOKING_NOT_FOUND` | 404 | The orchestrator could not load it |
| `PAYMENT_BOOKING_CANCELLED` | 400 | The booking is cancelled |
| `PAYMENT_BOOKING_NO_PAYMENT_REQUIRED` | 400 | A free booking |
| `PAYMENT_BOOKING_ALREADY_PAID` | 409 | Already paid |
| `PAYMENT_BOOKING_IN_PROGRESS` | 409 | A payment is already pending on it |

### `POST /api/customer/bookings/:id/pay-balance`

For a balance raised when the service ran over. Same body. The response `data` carries two extra
fields:

| Field | Type | Notes |
|---|---|---|
| `transactionId` | string | A **separate** transaction with `purpose: "booking_balance"` |
| `status` | string | As above |
| `amount` | number | The outstanding balance being charged |
| `currency` | string | |
| `instructions` | object \| undefined | Same branches as **§ 2.2** |
| `message` | string | |

| `error.code` | Status | When |
|---|---|---|
| `BOOKING_NOT_COMPLETED` | 409 | A balance only exists once the vendor settles the appointment. `details.status` |
| `BOOKING_NO_BALANCE_DUE` | 400 | Nothing outstanding |
| `BOOKING_BALANCE_ALREADY_SETTLED` | 409 | The balance is already paid |

### `GET /api/customer/bookings/:id/balance`

Cheap to poll while a balance payment settles.

| Field | Type | Notes |
|---|---|---|
| `bookingId` | string | |
| `currency` | string | |
| `quotedPrice` | number | What was quoted at booking time |
| `finalPrice` | number \| null | What the vendor settled at. `null` until settled |
| `balanceDue` | number | Raised by the vendor. `0` when none |
| `balancePaid` | number | How much of it has been paid |
| `outstanding` | number | `max(0, balanceDue − balancePaid)` |
| `balancePaymentMethod` | string \| null | How the balance was paid |
| `creditDue` | number | Overpayment. **Recorded, never auto-refunded** |
| `settledAt` | ISO-8601 string \| null | |

### `GET /api/bookings/:id/payment-status`

**Auth:** required, `customer` (owner) or `vendor` (owner of the booking).

| Field | Type | Notes |
|---|---|---|
| `bookingId` | string | |
| `paymentStatus` | string | The booking's own status, e.g. `paid`, `pending`, `refunded`, `refund_pending` |
| `paymentMethod` | string \| null | |
| `priceSnapshot` | number | |
| `currency` | string | |
| `requiresPayment` | boolean | |
| `transaction` | object \| null | `{ id, status, gateway, gatewayRef }` — a narrow projection, not the full record |

---

## 6 · Polling, settlement and what heals itself

**The order of events for a mobile-money payment:**

1. `initiate` → `PENDING`, plus instructions.
2. The customer approves on the handset (and, on Orange Money via My-CoolPay, submits the SMS
   code to `authorize` first).
3. The provider POSTs a **signature-verified** callback to `/api/webhooks/{notchpay,mycoolpay}`.
   That is what marks the payment `SUCCEEDED`, commits stock, fulfils the order and runs the
   earnings split.
4. If that callback never arrives, a background sweep re-verifies the transaction against the
   provider's own record every 10 minutes, for transactions between 10 minutes and **72 hours**
   old, and settles it on the same path.

**What that means for a client:**

- Poll `GET /api/payments/:transactionId` (or `POST /api/payments/verify` to force a gateway
  re-check) while the customer is watching. A sensible cadence is every 3–5 seconds for the
  first two minutes, then back off.
- **Do not require the app to stay open.** A customer who closes the page still gets their
  order.
- **Do not treat a long `PENDING` as a failure.** A USSD approval genuinely takes minutes.
- A duplicate callback is de-duplicated on the provider's own event id in a durable store
  (unique on `(gateway, eventId)`, kept 45 days), so a redelivery cannot double-fulfil an order
  or double-split earnings.
- A callback whose reported amount or currency disagrees with `amountSnapshot`/`currencySnapshot`
  is **refused and never marks the payment succeeded**, even though its signature passed.

---

## 7 · Refunds, as the customer experiences them

Refunds are not initiated from this surface — a customer asks, a vendor or an administrator
actions it. What changed in Phase 1 is what actually happens to the money:

| Gateway | What happens |
|---|---|
| `STRIPE` | A real API refund. The order/booking goes `refunded` when fully refunded |
| `NOTCHPAY` | The integration exists and is correct, but **refunds are disabled on the merchant account** (`POST /refunds` answers 403 while `GET /refunds` answers 200 with the same credentials, verified 2026-08-18). It behaves as My-CoolPay below until the provider enables them |
| `MYCOOLPAY` | **The provider has no refund endpoint at all.** The refund is made by hand |

In both manual cases the order or booking goes to **`refund_pending`**, the vendor's escrowed
earnings are reversed, and a HIGH-importance support ticket is raised for a manual payout. **The
cancellation or refund request itself still succeeds** — a refund problem never keeps an
appointment on the books or blocks a cancellation. Word your copy as "your refund is being
processed" rather than "refunded" when `paymentStatus` is `refund_pending`.

---

## 8 · Phase D decisions that will reach this app

All ten were answered on 2026-08-18. Two land here, and **neither is built yet** — do not ship
UI against them:

| Decision | Answer | Status |
|---|---|---|
| **Q-3 · Should a bearer session have an absolute cap?** | Yes — a **90-day absolute cap**, carried as a stateless `auth_time` claim, so a refresh token cannot be rotated forever | Decided (`jovi-mall/docs/ADR-A03-SESSION-CAP.md`). **Implemented in Phase 4.A.5.** When it lands, a session older than 90 days stops refreshing and the customer must sign in again — plan for a re-login path that does not lose the cart |
| **Q-2 · What does "delete my account" mean?** | **Anonymise-and-retain**: orders, COD balances and tax records are not the customer's to erase, so the person is anonymised and the records stay. Data export is optional, not required | Decided (`jovi-mall/docs/ADR-A02-ACCOUNT-CLOSURE.md`). **Implemented in Phase 6.D.** Nothing exists today — there is no account-deletion or export endpoint of any kind |

The other eight concern deployment, uploads, geocoding, tracking and the admin surface; they are
covered in the sibling documents.

---

## 9 · What Phase 0 means for you

Nothing on the wire. It is worth one line only because it is why the contract above can be
trusted: the payments module now has `npm run test:payments` — **92 DB-free assertions**
covering the signature arithmetic, the status-code table, the merchant-reference format, the
operator resolver and the money cross-check — and CI runs it, plus every other suite, on every
push. Before Phase 0 nothing ran automatically anywhere.
