# Payments — checkout (role-neutral)

> ### ⚠ Changed 2026-09-30: the client chooses a **provider**, never an aggregator
>
> A client now sends **`provider`** (`MTN` · `ORANGE` · `CARD`), read from
> [`GET /payments/options`](#get-paymentsoptions--what-the-customer-can-pay-with). It no longer sends `gateway`. The backend picks the
> company that moves the money (the **aggregator**: NotchPay, My-CoolPay, Stripe…) at runtime,
> and an administrator can switch it with no app release. `gateway` is still **accepted and
> ignored**, so old builds keep working. The full contract is [routing.md](./routing.md). What
> each frontend has to change is in
> [../FRONTEND-CHANGELOG-payment-providers.md](../FRONTEND-CHANGELOG-payment-providers.md).

**Provider routing verified against source on 2026-09-30, at jovi-mall `39254e2` (after C1)** —
`/options` and its CARD-key drop (`payments/services/payment-options.service.ts`), the request
schemas (`payments/validators/payment.validators.ts`), the derivation order (`deriveProvider` in
`payments/domain/payment-routing.ts`), the three refusals and their messages
(`payments/services/payment-routing.service.ts`), `provider` on the initiate result, the
transaction, the booking payment-status and the pay-link session, the stored-gateway check on the
pay-link mint (`pay-link.service.ts`), and `PAYMENT_OPERATOR_UNDETERMINED` surviving only on the
server-picked doors. The line below is the earlier pass; its route and auth claims still hold, and
the census is now **seven** routes with `GET /payments/options`.

**Verified against source on 2026-09-08** — the six-route census and their auth, the `initiate` /
`verify` / `authorize` request shapes, the pay-link mint and session projection, the OTP attempt
ceiling and the per-gateway refund verdict, against
`jovi-mall/src/modules/payments/routes/payment.routes.ts`,
`src/modules/payments/validators/payment.validators.ts`,
`src/modules/payments/domain/pay-link.ts`, `src/modules/payments/services/pay-link.service.ts`,
`src/modules/payments/gateways/registry.ts` and `src/modules/payments/config/payments.config.ts`.

One payment surface, shared by every flow that takes money from a **customer**: a single-order
payment, a whole multi-vendor cart in one charge, or a service booking.

- **Base URL**: `http://localhost:8022/api`
- **Response envelope**: standard `{ success, ... }` — see [../README.md](../README.md#the-response-envelope-read-this-first).
- **Providers** (what the customer pays with): `MTN` and `ORANGE` today; `CARD` and `MOOV` exist
  and are **off**. Only what [`GET /payments/options`](#get-paymentsoptions--what-the-customer-can-pay-with) lists can start a payment.
- **Aggregators** (who the backend calls): `NOTCHPAY`, `MYCOOLPAY`, `STRIPE`, `CAMPAY`. Chosen by the
  server. A client never picks one, and must never branch on one.

> ### Two behaviours change with the active aggregator, and a client handles both without knowing which is active
>
> - **An OTP step can appear.** Today that means Orange Money when My-CoolPay is active.
>   `initiate` then answers `PENDING` with `instructions.requiresOtp: true` and **no USSD code**.
>   Nothing happens until the customer's SMS code is relayed to
>   [`POST /payments/:transactionId/authorize`](#post-paymentstransactionidauthorize). Rendering
>   "dial the USSD code" here shows a prompt that will never arrive. `/options` warns ahead of
>   time (`flow: "OTP"`, `mayRequireOtp: true`), but **the `initiate` response is the truth**:
>   always honour `instructions.requiresOtp`, whatever `/options` said. An administrator may have
>   switched aggregators between the two calls.
> - **Refunds depend on the aggregator that took the money** (see
>   [Refunds](#refunds-differ-by-gateway)). That is a server-side and admin concern; a customer
>   client does nothing different.

> **⚠️ Breaking change (2026-07-29): `GET /api/payments/:transactionId` now requires
> authentication and returns only the caller's own transaction.** It previously accepted no
> credentials at all, so any transaction was readable by id. A client polling it must now send the
> session cookie or a Bearer token. See [Reading a transaction](#get-paymentstransactionid).

## `GET /payments/options` — what the customer can pay with

**Auth**: none. **`Cache-Control: no-store`**: do not cache the answer beyond the screen that
shows it. Call it when the payment screen opens; the server recomputes it at most every
5 seconds. Standard `{ success, data }` envelope (unlike `initiate` / `verify` / `authorize`,
which are flat). Contract: [routing.md § GET /api/payments/options](./routing.md#get-apipaymentsoptions).

```jsonc
// 200 — today's production answer
{
  "success": true,
  "data": {
    "providers": [
      { "provider": "MTN",    "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false },
      { "provider": "ORANGE", "kind": "MOBILE_MONEY", "flow": "PUSH", "fields": ["phoneNumber"], "mayRequireOtp": false }
    ]
  }
}
```

| Field | What the client does with it |
|---|---|
| `provider` | Render one choice per entry, in the order given. Send it back unchanged as `provider` |
| `kind` | `MOBILE_MONEY` (ask for a number) or `CARD` |
| `flow` | Which screen to **prepare**: `PUSH` (approve on the handset), `OTP` (an SMS code may be asked for), `CARD_ELEMENT` (Stripe Payment Element), `REDIRECT` (open a page; reserved, not used today) |
| `fields` | The `channel` fields the charge requires, e.g. `["phoneNumber"]`. `[]` for a card |
| `mayRequireOtp` | `true` exactly when `flow` is `OTP` |
| `publishableKey` | Only on a `CARD` entry with `flow: "CARD_ELEMENT"`: the Stripe publishable key to load Stripe.js with. Use it **instead of** a key baked into the build (`VITE_STRIPE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) |

Rules a client must follow:

- **Show only what is listed.** Do not hard-code "MTN / Orange / Card". A build that shows a
  choice the server refuses offers a button that can only fail.
- **An empty `providers` array is a valid answer.** An administrator can switch all online
  payment off. Render *"Online payment is unavailable right now"*, and offer cash on delivery
  where that checkout allows it. It is not an error, so do not show a retry spinner.
- **`flow` is a hint, never a promise.** Always branch on the `initiate` response's
  `instructions` (`requiresOtp`, `redirectUrl`, `clientSecret`), whatever `/options` said.
- **The body never names an aggregator** and holds nothing secret. There is nothing in it to
  branch on except the fields above.
- **Every listed provider is payable.** If CARD routes through Stripe but no valid publishable
  key is configured, CARD is not listed, so a `CARD` entry always carries a usable
  `publishableKey`.

Cards are **off** today (owner decision: mobile money only), so no `CARD` entry appears. When an
administrator turns them on, the entry appears here with no client release.

### What a charge can be refused for, before anything is written

Every charging door (`initiate`, the booking pay routes, plan purchase, credit top-up) runs these
checks **first**. Nothing is charged, no row is written, and the customer can correct the choice
and press Pay again.

| `error.code` | Status | `details` | What happened, and what to show |
|---|---|---|---|
| `PAYMENT_PROVIDER_UNAVAILABLE` | 422 | `{ provider, offered }` | The chosen provider is switched off, or nothing can route it right now. `offered` is the **fresh** provider list: re-render the choices from it (or re-fetch `/options`). Do not retry the same provider. An empty `offered` means online payment is unavailable |
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | 422 | `{ provider, detected, spent: false }` | The number belongs to another network, e.g. `provider: "ORANGE"` with an MTN number (`+23767…`). Say so: *"This is an MTN number. Choose MTN, or enter an Orange number."* `detected` is `MTN` or `ORANGE` |
| `PAYMENT_PROVIDER_REQUIRED` | 400 | none | No `provider`, and the server could not derive one from an old-style body. A current client always sends `provider` and never sees this |
| `VALIDATION_ERROR` | 400 | `fields[]` | A field listed in `fields` is missing, e.g. no `channel.phoneNumber` for `MTN` (unchanged) |

```jsonc
{ "success": false, "requestId": "req_…", "error": { "code": "PAYMENT_PROVIDER_PHONE_MISMATCH",
  "statusCode": 422, "category": "business_rule",
  "message": "This number is on MTN, not ORANGE. Please check the number or choose MTN.",
  "details": { "provider": "ORANGE", "detected": "MTN", "spent": false } } }
```

The `message` each charging door sends (`payments/services/payment-routing.service.ts`):

| Code | `message` |
|---|---|
| `PAYMENT_PROVIDER_UNAVAILABLE` | *Card payments are not available right now. Please choose another payment method.* — or, for a mobile provider, *{provider} payments are not available right now. Please choose another payment method.* |
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | *This number is on {detected}, not {provider}. Please check the number or choose {detected}.* |
| `PAYMENT_PROVIDER_REQUIRED` | *Please choose a payment method (provider: MTN, ORANGE or CARD)* |

They are English, and they name the raw provider codes (`MTN`, `ORANGE`). A client that localises
should key its own copy on `code` and fill the networks in from `details.provider` /
`details.detected`. (`core/errors.ts` also holds shorter registry defaults for these codes; the
doors above always pass their own.)

The mismatch check reads the number's **prefix** only. A number whose prefix is neither MTN's nor
Orange's (Nexttel, Camtel, a ported or foreign number) is **not** refused: the provider the
customer chose wins. A `CARD` charge does not look at the number.

⚠ **What this replaced.** Until 2026-09-30 the client named the aggregator (`gateway`), and a
switched-off one answered `400 PAYMENT_GATEWAY_NOT_SUPPORTED` with aggregator names in
`details.offered`. That code is **no longer raised for a charge**; it survives only on pay-link
minting (see [The hosted card page](#the-hosted-card-page-gap-008)). Before 2026-09-22 a
switched-off Stripe was accepted anyway, opened a row, and saved it `FAILED`. That is how a
customer met a Stripe error on ORD-2026-000002.

Payments **already opened** keep the aggregator that opened them: they verify, settle by webhook,
reconcile and refund through it even after an administrator switches. A customer who presses Pay
again while a prompt is still live gets **that** payment back, not a second charge on the new
aggregator.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/payments/options` | **none** | Which providers the customer can pay with right now, and how each one flows |
| `POST` | `/payments/initiate` | **none** | Start a payment for a `cartId`, `orderId` or booking |
| `POST` | `/payments/verify` | **none** | Re-check a transaction against the aggregator that holds it (idempotent) |
| `POST` | `/payments/:transactionId/authorize` | **none** | Submit the one-time code when `initiate` returned `requiresOtp` |
| `GET` | `/payments/session/:token` | **none** | What a hosted **card** page needs to confirm a payment. Takes a link handle, never a transaction id |
| `POST` | `/payments/:transactionId/pay-link` | **required, owner-scoped** | Mint (or replace) that link handle |
| `GET` | `/payments/:transactionId` | **required, owner-scoped** | Read a transaction |

Related surfaces that do **not** live here:

| Flow | Where |
|---|---|
| Booking payment + its own status poll | `POST /api/bookings/:id/pay`, `GET /api/bookings/:id/payment-status` — [../customer/bookings.md](../customer/bookings.md) |
| Gateway webhooks (server-to-server) | `POST /api/webhooks/*` — not client-callable |
| **Plan purchases & credit top-ups** | `/{vendor,agency,agent}/plans/...`, `.../credits/topups` — a **separate** path that creates **no** `PaymentTransaction`. See [../billing-plans-across-roles.md](../billing-plans-across-roles.md) |
| Saved mobile-money wallets (no card is saved since 2026-09-30) | `/api/me/payment-methods` — [../customer/payment-methods.md](../customer/payment-methods.md) |
| **Checkout in the chat** (the assistant places the order and sends the prompt) | `POST /api/internal/bot/checkout/chat/{review,place}` — see [Checkout in the chat](#checkout-in-the-chat-bot-surface-2026-09-22) below |

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
| `provider` | string | ✅ (see below) | `MTN` \| `ORANGE` \| `MOOV` \| `CARD` — one of the providers [`/payments/options`](#get-paymentsoptions--what-the-customer-can-pay-with) lists, or `422 PAYMENT_PROVIDER_UNAVAILABLE` |
| `channel` | object | ❌ (defaults `{}`) | `{ phoneNumber?, customerEmail?, customerName? }`. Send the fields the provider's `/options` entry lists in `fields`. `phoneOperator` and `cardToken` are still accepted and are legacy: do not send them |
| `gateway` | string | ❌ | **Deprecated. Accepted and ignored.** Any value, including a switched-off aggregator, is not refused; the active aggregator is used. Stop sending it; it will be removed |

`provider` must be one of those four exact uppercase strings; anything else is `400
VALIDATION_ERROR` on `provider`. `channel.phoneNumber` is **required** for a mobile-money provider
(`MTN`, `ORANGE`, `MOOV`) — missing, it is `400 VALIDATION_ERROR` on `channel.phoneNumber`, as
before — and not read for `CARD`. It must belong to the chosen network, or `422 PAYMENT_PROVIDER_PHONE_MISMATCH`
(see [What a charge can be refused for](#what-a-charge-can-be-refused-for-before-anything-is-written)).

**`provider` is required of every current client.** It is optional on the wire only so that builds
released before 2026-09-30 keep working. When it is missing, the server derives it in this order:
`gateway: "STRIPE"` → `CARD` (refused with `422 PAYMENT_PROVIDER_UNAVAILABLE` while cards are
off, and **never** pushed to a phone), then `channel.phoneOperator`, then the number's prefix. If
none gives an answer: `400 PAYMENT_PROVIDER_REQUIRED`. An explicit `provider` always wins.

`channel.phoneNumber` must be **E.164** (leading `+` and country code, e.g. `+237670000001`) and
`channel.customerEmail` must be a valid email. Both are forwarded to the aggregator, so a malformed
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
  "provider": "MTN",
  "channel": { "phoneNumber": "+237670000001" }
}
```

### Example success `200`

```json
{
  "success": true,
  "transactionId": "664txn...",
  "status": "PENDING",
  "provider": "MTN",
  "instructions": { "ussdCode": "*126#", "message": "Confirm the prompt on your phone" },
  "message": "Payment initiated"
}
```

`provider` is the provider this attempt is charged on: the resolved one on a new attempt, or the
**stored** one on a live attempt that was reused (or an already-settled one), which is `null` on
an attempt opened before 2026-09-30. It can therefore differ from what you just sent, when an
earlier attempt is still live. The response never names the aggregator (no `gateway`).

`success` is `false` when `status` is `FAILED`; the HTTP status is still `200`.

⚠ **`status` is the thing to branch on, not the HTTP code.** An aggregator that *refuses* the
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
| `ussdCode` | Mobile money, ordinary (`PUSH`) flow | Show the code; the customer approves on the handset |
| `requiresOtp: true` | An `OTP` flow (today: Orange Money when My-CoolPay is active) | Collect the SMS code and POST it to `/payments/:transactionId/authorize`. There is **no** `ussdCode` on this branch. Honour it even when `/options` said `PUSH` |
| `redirectUrl` | A `REDIRECT` flow (reserved; no aggregator uses it today) | Open the URL, then poll `verify` when the customer returns |
| `clientSecret` | A `CARD` charge (`CARD_ELEMENT`) | Confirm with Stripe.js / Payment Element, loaded with the `/options` `publishableKey`. **A browser is required**. See [The hosted card page](#the-hosted-card-page-gap-008) if you are not in one |
| `chargedAmount` / `chargedCurrency` | A `CARD` charge | The amount actually charged, in the presentment currency (the order stays priced in XAF) |
| `message` | Always | Human-readable copy, already localised for the customer |
| `expiresAt` | Sometimes | When the payment session lapses |

Branch on **which fields are present**, never on the aggregator. The same `provider` can come back
with a different shape after an administrator switches aggregators.

**The provider is the operator.** Sending `provider` settles which network is charged, so
`channel.phoneOperator` is no longer needed. The customer's choice is checked against the
number's prefix before anything is written (the mismatch refusal above), and an unrecognised
prefix is charged on the network the customer chose.

`422 PAYMENT_OPERATOR_UNDETERMINED` (which used to answer an unclassifiable number on this door) no
longer fires here once `provider` is present: the chosen provider is handed to the aggregator as
the operator. It survives only on the doors where the server picks everything and no `provider`
is sent (chat checkout, the mini-app, WhatsApp Flows): there, a number it cannot classify is
refused with `spent: false`. See [Checkout in the chat](#checkout-in-the-chat-bot-surface-2026-09-22).

⚠ **Deciding the operator yourself still helps the customer.** Pre-selecting the provider from
the number's prefix is fine, but let the customer change it, and show the mismatch message rather
than silently flipping their choice.

---

## POST `/payments/verify`

**Purpose**: Ask the aggregator that holds the transaction (the stored `gateway`, never the
current setting) for its current state, and apply it. Safe to call
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
    "provider": "MTN",
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
| `provider` | `MTN` · `ORANGE` · `MOOV` · `CARD`, or **`null`**: a transaction opened before 2026-09-30 (not backfilled), or opened from an old-style body whose provider could not be derived. What the customer paid with. Safe to display; handle `null` |
| `gateway` | **Informational only**: which aggregator carried this money. It is kept for support and receipts. **Never branch on it**: branch on `status` and `instructions` |
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

**One route per aggregator, generated.** `webhook.routes.ts` registers `POST /api/webhooks/<name>`
for every entry of `PAYMENT_GATEWAY_NAMES`, and `app.ts` mounts `express.raw` on the same list of
exact paths before `express.json()` — not on the `/api/webhooks` prefix, which also carries the
messaging-bot routers. So a new aggregator gets its route and its raw-body mount by construction.
**Every route is signature-verified and raw-parsed**, through the same sequence.

| Path | Signature | Register it as |
|---|---|---|
| `POST /api/webhooks/stripe` | `stripe-signature` verified against `STRIPE_WEBHOOK_SECRET` | Dashboard → Developers → Webhooks |
| `POST /api/webhooks/notchpay` | `x-notch-signature` — HMAC-SHA256 hex over the raw body, keyed by the dashboard's **Hash Key** (`hsk_…`, not the private key) | Settings → Webhooks |
| `POST /api/webhooks/mycoolpay` | body field `signature` — MD5 of `transaction_ref + transaction_type + transaction_amount + transaction_currency + transaction_operator + PRIVATE_KEY`, plus `application` matched against our public key | the application's Callback URL |
| `POST /api/webhooks/campay` | body field `signature` — an HS256 JWT keyed by `CAMPAY_WEBHOOK_KEY`, whose claims are only timestamps | the Campay application's callback, set to **POST** (a GET callback carries its fields in the query string, where this route does not read them) |

The mobile providers reject a callback URL that is not HTTPS with a valid certificate, so local
development needs a tunnel. Payout (transfer) callbacks arrive on the same route as collection
callbacks.

### ⛔ When the signature does not cover the body, the aggregator is asked again

A valid signature only proves the sender. For **My-CoolPay** the MD5 covers the reference, type,
amount, currency and operator, but **not the status**; for **Campay** the JWT covers nothing in
the body at all. So a genuinely signed callback for a failed charge, replayed with its status
changed to success, would pass verification.

For both, the callback is treated as a **doorbell**: before anything settles, the adapter's
`confirmWebhookEvent` re-reads the transaction from the aggregator (`/checkStatus/{ref}` on
My-CoolPay, `GET /transaction/{ref}/` on Campay) and the status acted on is the aggregator's
answer, never the body's. If that re-read cannot reach the aggregator, the webhook answers `5xx`
so the aggregator retries, and the reconciliation sweeps backstop it. NotchPay and Stripe sign the
whole raw body and need no re-read. A new aggregator whose signature does not cover the body must
implement the same step.

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

### Payouts whose callback never arrives

A payout in `processing` used to settle only through its transfer callback or an administrator,
so a lost or refused callback (an IP allowlist, a re-read that threw) left it processing forever
with the owner's hold intact. My-CoolPay sends each callback once, so this is not an edge case.

The **payout reconciliation sweep** (`payout-reconciliation` worker, jovi-mall `9ab91fa`) closes
that gap:

- It picks `processing` payouts that have a provider transfer id, have been quiet for at least
  `PAYOUT_RECONCILE_MIN_AGE_MINUTES` (default 15) and are younger than
  `PAYOUT_RECONCILE_MAX_AGE_HOURS` (default 168), `PAYOUT_RECONCILE_BATCH_SIZE` (50) at a time,
  every `PAYOUT_RECONCILE_CRON` (`*/15 * * * *`). It shares the worker lock, pauses in
  maintenance, and can be triggered from developer tools.
- It asks the aggregator **stored on the payout** (`transfer_gateway`; `null` means NotchPay),
  never the current setting, through the adapter's `verifyPayout` (NotchPay: `GET /transfers/{id}`;
  Campay: `/transaction/{ref}/`, acted on only when the record is a withdrawal carrying our
  `jm_po_` reference; My-CoolPay: `checkStatus` on **its** reference, acted on only when the
  record is a `PAYOUT` naming our `app_transaction_ref`, from `83e8535`). For My-CoolPay, which
  sends each callback once, the sweep is the only recovery for a lost payout callback. It never falls back to `verifyPayment`, which asks the wrong question.
- Only a definite `SUCCEEDED`, `FAILED` or `CANCELLED` moves anything, through the same transition
  the callback uses (compare-and-set on `processing`, so exactly once). `PENDING` or an
  inconclusive answer leaves the row alone for the next pass.

What the sweep cannot settle still needs an administrator. The typical case is a transfer request
that timed out or gave no readable answer: the payout stays `processing` with a
`transfer_failure_reason` beginning "Outcome unknown", and **no provider transfer id**, so the
sweep has nothing to ask about (and `mark-paid` / `reject` refuse a `processing` row).

**The manual exit is `resolve-unknown`** (jovi-mall `d9f4dcf`):
`POST /api/internal/admin/payout-requests/:id/resolve-unknown` with
`{ outcome: "paid" | "failed", reason, evidence? }`, reached from wi-admin as
`POST /api/v1/money/payouts/:payoutId/resolve-unknown`. An administrator checks the provider's own
dashboard for the `jm_po_…` reference, then records what it shows.

- **`processing` only**, and refused until the sweep's quiet period
  (`PAYOUT_RECONCILE_MIN_AGE_MINUTES`, default 15) has passed since the transfer was sent:
  `409 EARNINGS_PAYOUT_TRANSFER_IN_FLIGHT` with `details.settleAfter`, because a callback may still
  arrive.
- Both outcomes settle through the same compare-and-set transition as the callback and the sweep,
  so whichever lands first wins and the others get `409 EARNINGS_PAYOUT_NOT_PROCESSING`.
- **`paid`** records the administrator as the one who resolved it. **`failed` keeps the owner's
  hold** (ADR-024 D-7); retrying or rejecting the payout is a separate act.

Full contract: [../admin/payout-requests.md](../admin/payout-requests.md#post-apiinternaladminpayout-requestsidresolve-unknown).

---

## `POST /payments/:transactionId/authorize`

Only reached when `initiate` answered `instructions.requiresOtp: true` (an `OTP` flow; today,
Orange Money when My-CoolPay is the active aggregator). The code goes to the aggregator stored on
the transaction, so a switch in between does not strand it.

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
| `PAYMENT_OTP_NOT_REQUIRED` | 422 | The aggregator holding this transaction has no OTP step, or the transaction is no longer pending. |

Unauthenticated, like `initiate` and `verify`. What bounds it is the IP rate limit plus the
per-transaction attempt counter, not a session.

> ⚠ **This is for order, cart and booking payments only.** A credit top-up or a plan purchase
> creates **no `PaymentTransaction`** (that is why `merchantRef` carries a `jm_ct_` / `jm_pp_`
> routing prefix), so passing a top-up or purchase id here answers
> `404 PAYMENT_TRANSACTION_NOT_FOUND`. Billing has its own owner-scoped OTP routes beside the
> `/verify` it already polls —
> [`/plan-purchases/:id/authorize`](../vendor/billing.md#post-apivendorplan-purchasesidauthorize)
> and [`/credits/topups/:id/authorize`](../vendor/billing.md#post-apivendorcreditstopupsidauthorize),
> under `/api/vendor`, `/api/agency` and `/api/agent`. They are authenticated, because the
> shareable-link reasoning above does not reach a purchase the owner started while signed in.

---

## The hosted card page (GAP-008)

**Mobile money completes where the customer is** — a USSD prompt or an OTP typed back into the
chat — and needs nothing here. **A card cannot.** `initiate` with `provider: "CARD"` (routed to
Stripe) answers a `clientSecret`, and only Stripe.js running in a browser can confirm one. These two endpoints are
the door a standalone payment page reads through.

⚠ **The page itself is frontend work and is not in this repository.** The backend mints the
handle, serves the session, and does not care which page renders it.

### `POST /payments/:transactionId/pay-link` — mint the handle

**Authenticated and owner-scoped**, unlike its neighbours, and the asymmetry is the design:
*reading* a link requires already holding one, while *creating* one turns a transaction id into a
live payment page and must be attributable. The bot surface reaches the same operation as
`payment_create_pay_link`, scoped to the resolved messaging identity instead.

```jsonc
// 200
{ "success": true, "data": {
    "token": "pl_9f3c…",                              // 64 hex characters
    "url": "https://shop.example.com/pay/pl_9f3c…",   // null when STOREFRONT_URL is unset
    "expiresAt": "2026-08-26T21:42:00.000Z" } }
```

| Code | Status | When |
|---|---|---|
| `PAYMENT_TRANSACTION_NOT_FOUND` | 404 | Unknown, malformed, or not the caller's — indistinguishable on purpose |
| `PAYMENT_LINK_NOT_APPLICABLE` | 422 | A mobile-money transaction. It completes on the handset and needs no page |
| `PAYMENT_GATEWAY_NOT_SUPPORTED` | 400 | The transaction's stored aggregator is not configured on this deployment any more. The one door that still raises this code. Checked after `PAYMENT_LINK_NOT_APPLICABLE`, before any token is minted |
| `PAYMENT_LINK_NOT_PAYABLE` | 422 | Already settled, failed or cancelled |

⚠ **While cards are off, a pay link cannot be minted at all**: every pay link is a card page, and
`initiate` refuses to open a new `CARD` transaction (`422 PAYMENT_PROVIDER_UNAVAILABLE`). The bot tool `payment_create_pay_link` is
`flow_only` for the same reason (2026-09-22).

⚠ **A second mint REVOKES the first**, and that is the only revocation there is. At most one link
per transaction is live, which is what makes "the customer lost the message, send it again" safe —
and what stops a forwarded link outliving its purpose. Do not mint one per page load.

⚠ **`url: null` is a real deployment state, not an error.** It means `STOREFRONT_URL` is unset, so
this deployment has no payment page. Offer mobile money; do not send a message with a missing link
in it.

### `GET /payments/session/:token` — what the page reads

**Unauthenticated**, by the same design that makes `initiate`, `verify` and `authorize`
unauthenticated: a payment link is shareable and the person paying is often not the person who
ordered.

⚠ **This is deliberately not `GET /payments/:transactionId` opened up.** Transaction ids are the
only thing between one customer and another's payment record, so an unauthenticated read on them
is a record any caller can walk by incrementing. This route takes a 256-bit handle that exists
only where somebody deliberately minted one, expires, and is superseded by the next mint.

```jsonc
// 200
{ "success": true, "data": {
    "transactionId": "68af…",       // poll POST /payments/verify with this
    "state": "payable",             // payable | settled | closed | expired
    "provider": "CARD",             // null on a transaction opened before 2026-09-30
    "gateway": "STRIPE",            // informational only; never branch on it
    "amount": 24000, "currency": "XAF",          // what the customer agreed to
    "chargedAmount": 40, "chargedCurrency": "usd", // what Stripe actually charges
    "clientSecret": "pi_…_secret_…",  // ⚠ only while state is `payable`
    "publishableKey": "pk_live_…",    // ⚠ only while state is `payable`; null if unconfigured
    "expiresAt": "2026-08-26T21:42:00.000Z",
    "paidFor": {                      // what the money is for — never null
      "kind": "order",                // order | booking
      "reference": "ORD-2026-000046", // the handle the payer can match; null on a legacy row
      "orderCount": 1,                // >1 when one payment settles a multi-vendor basket
      "itemCount": 3,                 // null for a booking
      "sellers": ["Boutique Ndogbong"] // always [] for a booking — see below
    } } }
```


**Both amounts are sent, and a page must show both.** The Stripe account settles in USD while the
catalogue is priced in XAF, so the number the Payment Element renders is not `amount`. Showing XAF
alone contradicts the card statement; showing USD alone contradicts the order.

#### `paidFor` — and why it is fields rather than a sentence

Added 2026-09-07, at the storefront's request. The page read, in full, *"Amount due —
24 000 FCFA."* The payer is **by design** often not the person who ordered, which makes this the
one payment screen where they have no other way to know what they are paying for — and the one
screen where they are about to type card details, so a page naming no merchant is shaped exactly
like a phishing page.

⚠ **The storefront asked for a rendered `description: "3 items from Boutique Ndogbong"` and it
was declined.** This is the one reader this API cannot localise for: every other page is served
to somebody with an account and a `preferred_language`, while the holder of a pay link has
neither and may not exist in the database at all. A sentence composed server-side would be
English on a page otherwise translated into five languages — English in the very line that says
what the money is for. **The page composes; this endpoint sends facts.**

⚠ **`sellers` is always empty for a booking, and that asymmetry is deliberate.** A shop's name is
already a public storefront page, so naming it tells a stranger only that somebody bought
something. A *service provider's* name is frequently the sensitive fact itself — a clinic, a
lawyer — and the platform cannot tell which vendors are which. A booking travels as its reference
and its amount.

**Never in this object, and none of it an oversight:** the buyer (no name, email, phone or
delivery address), the line items (no titles, SKUs or per-item prices — a count is a fact about
the basket, a title is a fact about the person who filled it), and the service on a booking.
`test:payments` asserts each by source scan, because the failure mode is a field *appearing*.

| `state` | What the page does |
|---|---|
| `payable` | Mount the Payment Element with `publishableKey` + `clientSecret` and confirm |
| `settled` | Show a receipt. **Never offer a second payment** |
| `closed` | Failed, cancelled or refunded. Nothing to confirm |
| `expired` | The link lapsed. Tell the customer to ask for a new one |

⚠ **Status is decided BEFORE expiry.** A customer who paid and comes back an hour later reads
`settled`, never `expired` — the second reading invites them to pay twice.

⚠ **`state: "expired"` is a 200, not a 404.** The page's whole job at that point is to say the link
lapsed and offer a fresh one. Everything else — a malformed token, an unknown one, one superseded
by a re-mint — is the **same** `404 PAYMENT_LINK_NOT_FOUND`, indistinguishable on purpose: any
difference is an oracle telling an anonymous caller whether their guess had the right shape.

`publishableKey` comes from `STRIPE_PUBLISHABLE_KEY`. A value starting `sk_` or `rk_` is **refused
and logged**, never published — cards then report as unconfigured until it is corrected.
`PAYMENT_LINK_TTL_MINUTES` (default 30) sets the window, matched to the checkout stock hold.

---

## Checkout in the chat (bot surface, 2026-09-22)

**Verified against source on 2026-09-22** (`bot-surface/controllers/bot-checkout.controller.ts`
`reviewInChat` / `placeInChat`, `bot-surface/miniapp/surfaces/checkout.controller.ts`
`readChatCheckout` / `placeCheckout`, `…/checkout-destination.ts`). Caller: the automation layer
only — service token + messaging identity, `Idempotency-Key` required. Catalogue rows
`checkout_review` and `checkout_place` ([../n8n/tools/catalog.json](../n8n/tools/catalog.json)).

The owner's rule: the assistant can complete a purchase **with tools**, without asking the customer
for anything the account already has. The address is **chosen** from the customer's saved
addresses; the mobile-money number is the **account's** (saved mobile-money method first, then the
profile phone). Both routes are thin wrappers over the checkout screen's own core, so every rule the
screen has holds here too: the aggregator is chosen server-side, by the same routing as every other
door (mobile money only; no request can name one), prices are re-resolved and a bargained price lock is redeemed inside order creation, and
the order-placing credential is **single-use**.

| Step | Route | Body | Answers (`data`) |
|---|---|---|---|
| 1 · review | `POST /checkout/chat/review` | `{ deliveryAddressId? }` — omit for the default | `ready`, `blocker`, `checkoutRef` (only when ready; 10 minutes, single use), `lines[]`, `totalText`, `delivery` (`{kind:'address', address}` \| `{kind:'digital', to}` \| null), `addresses[]` (default first, each with `deliverable`), `payment.phoneMasked`, `addAddressUrl` |
| 2 · place | `POST /checkout/chat/place` | `{ checkoutRef, deliveryAddressId, phone? }` — the address id the review named (**required** for physical goods); `phone` only if the customer typed another number | `transactionId`, `state` (`waiting` \| `failed` \| `settled`), `orderCount`, `orderNumbers[]`, `amountText`, `payerMasked`, `instructions` |

`blocker` is one of `no_saved_address`, `address_not_deliverable` (no mapped location — an
unmapped default is **refused**, never swapped for another address), `address_not_found`. With the
first two, `addAddressUrl` is the website's address page (addresses are added on the website, never
captured in the chat).

⚠ **`details.spent` is on every place refusal, and absent means spent.** `false` — the address, the
wallet or the number was refused before the credential was used: correct it and call `place` again
with the same `checkoutRef`. Anything else: orders may exist — ask `checkout_payment_status`, never
place again.

⚠ **`state: "failed"` is an outcome, not an error.** The gateway refused the charge as it was
opened: the orders exist and await payment, and **no prompt is coming** to the handset. The
notification catalogue announces nothing for a refusal the customer was present for, so say it and
offer `checkout_retry_payment`. The same rule on the checkout **screen**: its `place` answers `200`
with `status: "FAILED"` in that case, and the page now shows its "go back to the chat" message
instead of "approve the payment on your phone".

The result of an approved or declined prompt still arrives in the chat as today —
`order.payment.received` / `order.payment_failed`, with **Check status** and **Try again**.

## Refunds differ by gateway

Refunds are not initiated from this surface (see the admin and vendor order docs), but which
aggregator took the money decides what happens. That is the `gateway` **stored on the
transaction**, never the currently active aggregator: a payment taken on My-CoolPay is refunded
(or not) as a My-CoolPay payment after an administrator has switched to NotchPay.

| Gateway | Refund |
|---|---|
| `STRIPE` | Real API refund |
| `NOTCHPAY` | Implemented, but **disabled on the merchant account** — `POST /refunds` answers 403 while `GET /refunds` answers 200 with the same credentials (verified against the live sandbox, 2026-08-18). Behaves as `MYCOOLPAY` below until NotchPay enables it and `NOTCHPAY_REFUNDS_ENABLED=true` is set. |
| `MYCOOLPAY` | **`REFUND_GATEWAY_NOT_SUPPORTED`** — the provider has no refund endpoint at all. |
| `CAMPAY` | **`REFUND_GATEWAY_NOT_SUPPORTED`** — Campay has no refund endpoint either; the manual path takes over, as for My-CoolPay. |

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

- [routing.md](./routing.md) — the provider/aggregator contract: capability matrix, routing rules, settings, error codes
- [../FRONTEND-CHANGELOG-payment-providers.md](../FRONTEND-CHANGELOG-payment-providers.md) — what each frontend changes for providers
- [../customer/orders.md](../customer/orders.md) — checkout, cart groups, and where `initiate` fits
- [../customer/bookings.md](../customer/bookings.md) — booking payment and its own status endpoint
- [../customer/payment-methods.md](../customer/payment-methods.md) — saved instruments
- [../billing-plans-across-roles.md](../billing-plans-across-roles.md) — plans/credit, a separate payment path
- [../errors/README.md](../errors/README.md) — error catalog
