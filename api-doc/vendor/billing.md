# Vendor Billing API

**Verified against source on 2026-09-08** — R7 re-read the eight routes and both lazily-creating GETs (`modules/billing/routes/vendor-billing.routes.ts:16-28`, `services/subscriber-plan.service.ts:66-85`, `services/credit-wallet.service.ts:106-109`). **One defect fixed:** this header sentence had been split in half by a later insertion.

**Verified against source on 2026-09-07** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–28). Corrections are marked inline with ⚠ and a source citation.

**Re-verified in part on 2026-09-08** — the `BILLING_LIMIT_EXCEEDED` `details` shape only (`services/entitlement.service.ts:100-113`).

Vendor-facing endpoints for pricing plans, the credit wallet, top-up purchases
and billing settings. Read [billing-overview.md](./billing-overview.md) first for
concepts and shared data shapes.

> **Now one engine across roles.** The billing engine was generalized so
> **agencies** and **agents** have the identical surface under `/api/agency` and
> `/api/agent` (see [agency/billing.md](../agency/billing.md),
> [agent/billing.md](../agent/billing.md), and the cross-role
> [overview](../billing-plans-across-roles.md)). Two response-shape changes landed
> here as a result: the plan-assignment object is now keyed **`subscriberPlan`**
> (was `vendorPlan`) and carries `owner_type`/`owner_id` (was `vendor_id`), and the
> purchase field is **`subscriber_plan_id`** (was `vendor_plan_id`). Update any
> code reading the old names.

## Base Path
```
/api/vendor
```

## Authentication
All requests require a valid Bearer token with the **vendor** role:
```
Authorization: Bearer <access_token>
```
Every endpoint is automatically scoped to the authenticated vendor.

---

## Endpoints summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vendor/plans` | List purchasable plans (catalog) |
| GET | `/api/vendor/plan` | The vendor's current active + pending plan |
| POST | `/api/vendor/plans/:planId/purchase` | Buy a plan (self-serve; auto-activates/queues on payment) |
| POST | `/api/vendor/plan-purchases/:id/authorize` | Relay the Orange Money SMS code for a plan purchase |
| POST | `/api/vendor/plan-purchases/:id/verify` | Verify & apply a plan purchase after payment |
| GET | `/api/vendor/credits` | Current credit balance |
| GET | `/api/vendor/credits/packs` | List buyable credit top-up packs |
| POST | `/api/vendor/credits/topups` | Start a credit top-up purchase |
| POST | `/api/vendor/credits/topups/:id/authorize` | Relay the Orange Money SMS code for a top-up |
| POST | `/api/vendor/credits/topups/:id/verify` | Verify/complete a top-up after payment |
| GET | `/api/vendor/settings` | Read billing settings (expiry-notice window) |
| PATCH | `/api/vendor/settings` | Update billing settings |

> **History endpoints moved.** Plan-purchase, credit-ledger and top-up histories are now served
> by the unified **[transactions feed](./transactions.md)** (`GET /api/vendor/transactions`).
> `GET /plan-purchases`, `GET /credits/ledger` and `GET /credits/topups` have been **removed**.

---

### GET /api/vendor/plans

**Description**: List the **active** vendor pricing plans (the catalog the vendor can buy). Sorted by `sort_order`, then `price`. Inactive/archived plans are excluded.

**Request Headers**: `Authorization: Bearer <token>`

**Query Parameters**: None

**Request Body**: None

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    {
      "_id": "665f0001",
      "role": "vendor",
      "code": "starter",
      "name": "Starter",
      "price": 0,
      "currency": "XAF",
      "term_days": null,
      "credit_allowance": 50,
      "max_active_products": 15,
      "commission_percent": 7,
      "is_active": true,
      "sort_order": 1,
      "created_at": "2026-06-19T10:00:00.000Z",
      "updated_at": "2026-06-19T10:00:00.000Z"
    },
    { "code": "growth", "price": 5000, "credit_allowance": 850, "max_active_products": 150, "commission_percent": 5, "term_days": 30, "... ": "..." },
    { "code": "business", "price": 25000, "credit_allowance": 4500, "max_active_products": null, "commission_percent": 3, "term_days": 30, "... ": "..." }
  ]
}
```

**Error Responses**: `401` — `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID`
(`auth.middleware.ts:126`) · `403 AUTH_ROLE_NOT_FOUND` on a non-vendor token
(`auth.middleware.ts:366`). ⚠ **Neither `UNAUTHORIZED` nor `FORBIDDEN` is in the registry** — this
line named both until 2026-09-08.

---

### GET /api/vendor/plan

**Description**: Return the vendor's current plan situation: the `active` plan and the `pending_activation` plan (if any), each with its resolved catalog `plan`. If the vendor has never had a plan, the free Starter is created on the fly and returned as `active` (and the 50-credit signup allowance is granted).

**Request Headers**: `Authorization: Bearer <token>`

**Query Parameters**: None

**Request Body**: None

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "active": {
      "plan": {
        "_id": "665f0002", "code": "growth", "name": "Growth", "price": 5000,
        "currency": "XAF", "term_days": 30, "credit_allowance": 850,
        "max_active_products": 150, "commission_percent": 5, "is_active": true
      },
      "subscriberPlan": {
        "_id": "667a0001", "owner_type": "vendor", "owner_id": "6601", "plan_id": "665f0002",
        "plan_code": "growth", "status": "active",
        "started_at": "2026-06-19T10:00:00.000Z",
        "expires_at": "2026-07-19T10:00:00.000Z",
        "assigned_by": "60a1", "payment_reference": "notch_tx_abc123",
        "allowance_granted": true
      }
    },
    "pending": {
      "plan": { "_id": "665f0003", "code": "business", "name": "Business", "price": 25000, "term_days": 30, "credit_allowance": 4500, "max_active_products": null, "commission_percent": 3 },
      "subscriberPlan": {
        "_id": "667a0002", "owner_type": "vendor", "plan_code": "business", "status": "pending_activation",
        "started_at": "2026-07-19T10:00:00.000Z",
        "expires_at": "2026-08-18T10:00:00.000Z",
        "allowance_granted": false
      }
    },
    "storage": {
      "limitBytes": 10737418240,
      "usedBytes": 2147483648,
      "remainingBytes": 8589934592
    }
  }
}
```
`pending` is `null` when nothing is queued. For the free tier, `active.subscriberPlan.expires_at` is `null`.

`storage` reflects the active plan's media storage limit and the vendor's current product-media usage (bytes). `limitBytes` = the active plan's `max_storage_bytes`; `usedBytes` excludes digital-product assets; `remainingBytes` is clamped at 0. For a full per-category breakdown use the media endpoints (`GET /api/files` / `GET /api/files/storage`).

**Error Responses**: `401`, `403`. `404 BILLING_PLAN_NOT_FOUND` only if the `starter` plan has not been seeded (run `npm run seed:plans`).

---

### POST /api/vendor/plans/:planId/purchase

**Description**: Vendor **self-serve** purchase of a paid plan. Creates a `pending` purchase and starts a gateway payment, returning the gateway `instructions`. After the vendor pays, call the **verify** endpoint — on confirmation the plan is **assigned/activated automatically** (no admin step), applying the two-plan rule:
- if the current active plan is **free / never-expiring** (or none) → the bought plan **activates immediately** and its credit allowance is granted;
- if a **paid** plan is still running → the bought plan is **queued** as `pending_activation`, starting exactly when the current one expires (allowance granted on activation).

Free plans (`price = 0`) cannot be purchased — they are the default tier.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Path Parameters**:
- `planId` (string, **required**) — `_id` of an active vendor plan from `GET /vendor/plans`.

**Request Body**:
```json
{
  "gateway": "NOTCHPAY",
  "channel": {
    "phoneNumber": "+237650000000",
    "phoneOperator": "MTN",
    "customerEmail": "vendor@example.com",
    "customerName": "Jane's Store"
  }
}
```
- `gateway` (string, **required**) — one of `NOTCHPAY`, `MYCOOLPAY`, `STRIPE`.
- `channel` (object, optional, defaults `{}`) — same shape as the top-up channel: `phoneNumber` (**E.164**) + `phoneOperator` (`MTN`|`ORANGE`|`MOOV`) for mobile money; for **Stripe** send only optional `customerEmail`/`customerName` (do **not** send `cardToken` — cards are collected client-side with the returned `clientSecret`). See [stripe-payments.md](./stripe-payments.md) and [Contact formats](../README.md#contact-formats-phone--email).

**Success Response** — `201 Created`:
```json
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66cc01", "plan_code": "growth", "price": 5000, "currency": "XAF",
      "status": "pending", "gateway": "NOTCHPAY", "gateway_ref": "notch_tx_p1",
      "subscriber_plan_id": null,
      "created_at": "2026-06-19T14:00:00.000Z", "updated_at": "2026-06-19T14:00:00.000Z"
    },
    "instructions": { "ussdCode": "*126#", "message": "Dial to approve", "expiresAt": "2026-06-19T14:15:00.000Z" }
  },
  "message": "Plan purchase initiated"
}
```
`instructions` is gateway-specific and may be `null` (mobile money: `{ ussdCode?, requiresOtp?, message?, expiresAt? }`; **Stripe**: `{ clientSecret?, chargedAmount?, chargedCurrency?, message? }` — note Stripe charges in **USD** while `price`/`currency` stay XAF; see [stripe-payments.md](./stripe-payments.md)).

> **My-CoolPay Orange Money answers `requiresOtp: true` and no `ussdCode`.** The buyer receives an SMS code, and **nothing is charged until it is relayed back**. Send it to [`POST /plan-purchases/:id/authorize`](#post-apivendorplan-purchasesidauthorize) — or, for a top-up, [`POST /credits/topups/:id/authorize`](#post-apivendorcreditstopupsidauthorize).
>
> ⚠ **Corrected 2026-09-13.** This paragraph used to send you to `POST /payments/:transactionId/authorize`. That endpoint resolves its argument with `PaymentTransactionModel.findById`, and **a billing purchase deliberately creates no `PaymentTransaction`** — so the only id you hold is a purchase id and the call answered `404 PAYMENT_TRANSACTION_NOT_FOUND`. Every Orange Money plan purchase and top-up, for all three owner roles, was reachable and could not complete. The routes above are the fix: owner-scoped, beside the `/verify` you already poll.

> **A mobile-money purchase now settles from the gateway callback**, not only from your `/verify` poll. It used to be poll-only: these rows create no `PaymentTransaction`, so a NotchPay or My-CoolPay callback found nothing and answered success, and a vendor who closed the tab after paying never got their plan. Keep polling while the customer is watching; you no longer have to. If the gateway confirms at initiation, the plan is applied immediately and `purchase.status` is `paid`.

**Error Responses**:
- `400 VALIDATION_ERROR` — bad `gateway`/`channel`.
- `404 BILLING_PLAN_NOT_FOUND` — `planId` unknown.
- `409 BILLING_PLAN_INACTIVE` — plan archived/inactive.
- `409 BILLING_PLAN_ROLE_MISMATCH` — not a vendor plan.
- `409 BILLING_PLAN_NOT_PURCHASABLE` — plan is free (price 0).
- `409 BILLING_PENDING_PLAN_EXISTS` — a plan is already queued (can't buy a second in advance).
- `400 PAYMENT_GATEWAY_NOT_SUPPORTED` / `502 PAYMENT_INITIATION_FAILED` — gateway issues.
- `401`, `403`.

---

### POST /api/vendor/plan-purchases/:id/authorize

**Description**: Relay the one-time SMS code for a plan purchase, so the gateway will open the payment prompt.

**Only reached when the initiating call answered `instructions.requiresOtp: true`** — today that
means **My-CoolPay + Orange Money**, the one gateway/operator pair with an OTP step. On that
branch there is no `ussdCode` and **no money has moved**: My-CoolPay SMSes a code and does
nothing at all until it comes back here.

> **This is not `POST /payments/:transactionId/authorize`.** That endpoint is for order, cart and
> booking payments, it is unauthenticated because a payment link is shareable, and it only knows
> `PaymentTransaction` rows — which billing purchases deliberately never create. Billing has no
> third party to accommodate (you started the purchase while signed in, and the SMS went to the
> number you just typed), so its OTP step is owner-scoped like the rest of this surface.

**Request Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, **required**) — the plan-purchase `_id` returned by `POST /plans/:planId/purchase`.

**Request Body**:
```json
{ "code": "123456" }
```
- `code` (string, **required**) — the 4–8 digit code from the SMS.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66cc01", "plan_code": "growth", "price": 5000, "currency": "XAF",
      "status": "pending", "gateway": "MYCOOLPAY", "gateway_ref": "mcp_tx_p1",
      "subscriber_plan_id": null,
      "created_at": "2026-06-19T14:00:00.000Z", "updated_at": "2026-06-19T14:01:00.000Z"
    },
    "instructions": { "ussdCode": "#150*50#", "message": "Confirm the payment prompt on your phone to complete this payment." }
  },
  "message": "Code accepted. Confirm the payment prompt on your phone."
}
```

⚠ **`status` is still `pending`, and that is correct.** The code only authorises the charge — the buyer still confirms it on the handset, and the purchase is applied by the gateway callback or by your `/verify` poll, exactly as for a NotchPay purchase. **Do not** treat a 200 here as "paid": carry straight on to the polling loop below.

**Error Responses**:
- `400 VALIDATION_ERROR` — `code` is not 4–8 digits.
- `404 BILLING_PLAN_PURCHASE_NOT_FOUND` — id unknown or not owned by this vendor.
- `409 BILLING_PURCHASE_INVALID_STATE` — already `paid`/`failed`/`reversed`, or no gateway reference yet. A settled row refuses a second code: accepting one would be a second charge.
- `422 PAYMENT_OTP_INVALID` — wrong code. `details.attemptsRemaining` says how many are left.
- `422 PAYMENT_OTP_ATTEMPTS_EXCEEDED` — too many wrong codes. **The row is now `failed`** — start a new purchase rather than retrying.
- `422 PAYMENT_OTP_NOT_REQUIRED` — this gateway has no OTP step (NotchPay, Stripe).
- `401`, `403`.

---

### POST /api/vendor/plan-purchases/:id/verify

**Description**: Verify a plan purchase against the gateway and apply it. **Idempotent** — safe to poll. On confirmed success the purchase becomes `paid` and the plan is assigned/activated (or queued); the resulting `SubscriberPlan` (`subscriberPlan`) is returned. On gateway failure/cancellation it becomes `failed`; while processing it stays `pending`.

**Request Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, **required**) — the plan-purchase `_id`.

**Request Body**: None

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66cc01", "plan_code": "growth", "price": 5000, "currency": "XAF",
      "status": "paid", "gateway": "NOTCHPAY", "gateway_ref": "notch_tx_p1",
      "subscriber_plan_id": "667a0005",
      "created_at": "2026-06-19T14:00:00.000Z", "updated_at": "2026-06-19T14:03:00.000Z"
    },
    "subscriberPlan": {
      "_id": "667a0005", "owner_type": "vendor", "plan_code": "growth", "status": "active",
      "started_at": "2026-06-19T14:03:00.000Z", "expires_at": "2026-07-19T14:03:00.000Z",
      "allowance_granted": true, "payment_reference": "notch_tx_p1"
    }
  }
}
```
- `purchase.status`: `paid` → applied (read `subscriberPlan` / refresh `GET /vendor/plan`); `pending` → keep polling (`subscriberPlan` is `null`); `failed` → show retry; **`reversed` → the card payment was charged back/refunded after the fact and the plan was undone — the vendor was dropped to the free tier (see "Payment disputes" below).**
- `subscriberPlan.status` is `active` (activated now) or `pending_activation` (queued behind the current paid plan). On an idempotent re-call after it was already paid, `subscriberPlan` may be `null` — read `GET /vendor/plan` for the current state.

**Error Responses**:
- `404 BILLING_PLAN_PURCHASE_NOT_FOUND` — id unknown / not owned by this vendor.
- `409 BILLING_PURCHASE_INVALID_STATE` — no gateway reference yet.
- `409 BILLING_PENDING_PLAN_EXISTS` — could not queue the plan (a pending plan appeared after purchase); resolve and retry.
- `401`, `403`.

**Polling guidance**: after `POST /plans/:planId/purchase` returns `pending`, poll this endpoint every 3–5s until `purchase.status` is `paid` or `failed` (timeout ~2–3 min for mobile money).

---

### GET /api/vendor/credits

**Description**: Current credit balance. Creates an empty wallet (balance 0) on first read if none exists.

**Request Headers**: `Authorization: Bearer <token>`

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "balance": 849 } }
```

> **The balance can be negative.** If a credit top-up is charged back/refunded after the
> credits were already spent, the claw-back drives the wallet below zero. Render negative
> balances (and block credit-spending actions until the vendor tops back up).

**Error Responses**: `401`, `403`.

---

### GET /api/vendor/credits/packs

**Description**: List the credit packs available for purchase. Use this to render the top-up options (don't hardcode prices).

**Request Headers**: `Authorization: Bearer <token>`

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": [
    { "code": "pack_100", "credits": 100, "price": 600, "currency": "XAF" },
    { "code": "pack_320", "credits": 320, "price": 1800, "currency": "XAF" },
    { "code": "pack_1100", "credits": 1100, "price": 6000, "currency": "XAF" },
    { "code": "pack_2250", "credits": 2250, "price": 12000, "currency": "XAF" }
  ]
}
```

**Error Responses**: `401`, `403`.

---

### POST /api/vendor/credits/topups

**Description**: Start a credit top-up purchase. Creates a `pending` top-up and initiates a payment with the chosen gateway. Returns the top-up and the gateway `instructions` (USSD prompt for mobile money, or a client secret for cards) the frontend should act on. After the user pays, call the **verify** endpoint to credit the wallet.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body**:
```json
{
  "packCode": "pack_100",
  "gateway": "NOTCHPAY",
  "channel": {
    "phoneNumber": "+237650000000",
    "phoneOperator": "MTN",
    "customerEmail": "vendor@example.com",
    "customerName": "Jane's Store"
  }
}
```

Field rules:
- `packCode` (string, **required**) — must match a `code` from `GET /credits/packs`.
- `gateway` (string, **required**) — one of `NOTCHPAY`, `MYCOOLPAY`, `STRIPE`.
- `channel` (object, optional, defaults `{}`) — payment channel details:
  - `phoneNumber` (string, **E.164** — leading `+` and country code) and `phoneOperator` (`MTN` | `ORANGE` | `MOOV`) — for mobile money (NotchPay/MyCoolPay).
  - For **Stripe**, do **not** send `cardToken` — the card is collected client-side via the returned `clientSecret`. See [stripe-payments.md](./stripe-payments.md).
  - `customerEmail` (string, valid email), `customerName` (string) — optional, passed to the gateway.
  - Still optional; the format rule applies only when the field is sent. See [Contact formats](../README.md#contact-formats-phone--email).

**Success Response** — `201 Created`:
```json
{
  "success": true,
  "data": {
    "topup": {
      "_id": "66bb02", "pack_code": "pack_100", "credits": 100, "price": 600,
      "currency": "XAF", "status": "pending", "gateway": "NOTCHPAY",
      "gateway_ref": "notch_tx_def456", "payment_transaction_id": null,
      "created_at": "2026-06-19T12:00:00.000Z", "updated_at": "2026-06-19T12:00:00.000Z"
    },
    "instructions": {
      "ussdCode": "*126#",
      "message": "Dial the USSD code to approve the payment",
      "expiresAt": "2026-06-19T12:15:00.000Z"
    }
  },
  "message": "Top-up initiated"
}
```
`instructions` shape varies by gateway and may be `null`:
- Mobile money: `{ ussdCode?, message?, expiresAt? }`
- Card (Stripe): `{ clientSecret?, chargedAmount?, chargedCurrency?, message? }` — Stripe charges the converted **USD** amount (`chargedAmount`/`chargedCurrency`) while `price`/`currency` stay XAF. See [stripe-payments.md](./stripe-payments.md).

> If the gateway reports the payment already succeeded at initiation (rare for mobile money), the wallet is credited immediately and the returned `topup.status` is `paid`.

**Error Responses**:
- `400 VALIDATION_ERROR` — missing/invalid `packCode`, `gateway`, or `channel`.
- `404 BILLING_TOPUP_PACK_NOT_FOUND` — unknown `packCode`.
- `400 PAYMENT_GATEWAY_NOT_SUPPORTED` — unsupported `gateway`.
- `502 PAYMENT_INITIATION_FAILED` — gateway rejected the initiation.
- `401`, `403`.

---

### POST /api/vendor/credits/topups/:id/authorize

**Description**: Relay the one-time SMS code for a credit top-up. Identical in every respect to the plan-purchase authorize above, on the top-up row.

**Only reached when the initiating call answered `instructions.requiresOtp: true`** — today that
means **My-CoolPay + Orange Money**, the one gateway/operator pair with an OTP step. On that
branch there is no `ussdCode` and **no money has moved**: My-CoolPay SMSes a code and does
nothing at all until it comes back here.

> **This is not `POST /payments/:transactionId/authorize`.** That endpoint is for order, cart and
> booking payments, it is unauthenticated because a payment link is shareable, and it only knows
> `PaymentTransaction` rows — which billing purchases deliberately never create. Billing has no
> third party to accommodate (you started the purchase while signed in, and the SMS went to the
> number you just typed), so its OTP step is owner-scoped like the rest of this surface.

**Request Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, **required**) — the top-up `_id` returned by `POST /credits/topups`.

**Request Body**:
```json
{ "code": "123456" }
```

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "topup": {
      "_id": "66bb02", "pack_code": "pack_100", "credits": 100, "price": 600,
      "currency": "XAF", "status": "pending", "gateway": "MYCOOLPAY",
      "gateway_ref": "mcp_tx_def456",
      "created_at": "2026-06-19T12:00:00.000Z", "updated_at": "2026-06-19T12:01:00.000Z"
    },
    "instructions": { "ussdCode": "#150*50#", "message": "Confirm the payment prompt on your phone to complete this payment." }
  },
  "message": "Code accepted. Confirm the payment prompt on your phone."
}
```

⚠ **`status` is still `pending`.** The wallet is credited by the callback or by `/verify`, never by this call.

**Error Responses**:
- `400 VALIDATION_ERROR` — `code` is not 4–8 digits.
- `404 BILLING_TOPUP_NOT_FOUND` — id unknown or not owned by this vendor.
- `409 BILLING_TOPUP_INVALID_STATE` — already `paid`/`failed`/`reversed`, or no gateway reference yet. A settled row refuses a second code: accepting one would be a second charge.
- `422 PAYMENT_OTP_INVALID` — wrong code. `details.attemptsRemaining` says how many are left.
- `422 PAYMENT_OTP_ATTEMPTS_EXCEEDED` — too many wrong codes. **The row is now `failed`** — start a new purchase rather than retrying.
- `422 PAYMENT_OTP_NOT_REQUIRED` — this gateway has no OTP step (NotchPay, Stripe).
- `401`, `403`.

---

### POST /api/vendor/credits/topups/:id/verify

**Description**: Verify a top-up against the gateway and finalize it. **Idempotent** — safe to call repeatedly (e.g. while polling). On a confirmed success the wallet is credited and the top-up becomes `paid`; on gateway failure/cancellation it becomes `failed`; while still processing it stays `pending`.

**Request Headers**: `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, **required**) — the top-up `_id` (24-char hex).

**Request Body**: None

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "_id": "66bb02", "pack_code": "pack_100", "credits": 100, "price": 600,
    "currency": "XAF", "status": "paid", "gateway": "NOTCHPAY",
    "gateway_ref": "notch_tx_def456",
    "created_at": "2026-06-19T12:00:00.000Z", "updated_at": "2026-06-19T12:03:00.000Z"
  }
}
```
Read `data.status` to decide UI: `paid` → credited (refresh balance), `pending` → keep polling, `failed` → show retry. A top-up may later become **`reversed`** if its card payment is charged back/refunded — the credits are clawed back (see "Payment disputes" below).

**Error Responses**:
- `404 BILLING_TOPUP_NOT_FOUND` — id unknown or not owned by this vendor.
- `409 BILLING_TOPUP_INVALID_STATE` — top-up has no gateway reference yet.
- `401`, `403`.

**Polling guidance**: after `POST /topups` returns `pending`, poll this endpoint every few seconds (e.g. 3–5s) until `status` becomes `paid` or `failed`, with a sensible timeout (~2–3 min for mobile money).

---

### GET /api/vendor/settings

**Description**: Read the vendor's billing settings. Currently exposes the plan-expiry notification window. Defaults to `7` if never set.

**Request Headers**: `Authorization: Bearer <token>`

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "notifyDaysBeforeExpiry": 7 } }
```

**Error Responses**: `401`, `403`.

---

### PATCH /api/vendor/settings

**Description**: Update billing settings. How many days before plan expiry the vendor wants to be notified.

**Request Headers**: `Authorization: Bearer <token>`, `Content-Type: application/json`

**Request Body**:
```json
{ "notifyDaysBeforeExpiry": 14 }
```
- `notifyDaysBeforeExpiry` (integer, **required**) — `0`–`90`.

**Success Response** — `200 OK`:
```json
{ "success": true, "data": { "notifyDaysBeforeExpiry": 14 }, "message": "Settings updated" }
```

**Error Responses**: `400 VALIDATION_ERROR` (out of range / wrong type), `401`, `403`.

---

## Related: how credits get spent (no direct endpoint)

Credits are consumed as a side effect of other vendor actions — there is no
"spend credits" endpoint:

- **Vectorisation (1 cr / product)** happens when a vendor creates/updates a product, enables vectorisation, or retries it (see the catalog product docs). If credits are insufficient the product still saves but its `vectorisationStatus` is `skipped_no_credits` — surface a "top up to enable AI search" hint when you see that status.
- **WhatsApp template (1 cr / message)** is charged when a billable vendor→customer template is sent. If the balance is too low the send is rejected with `402 BILLING_INSUFFICIENT_CREDITS`.

## Related: plan product limit

Creating a product is blocked with `403 BILLING_LIMIT_EXCEEDED` once the vendor
reaches their plan's `max_active_products` cap (response
`details: { limit, current, requested, available }`).
Use `GET /vendor/plan` + the product count to show remaining slots and prompt an
upgrade. Vendors **upgrade themselves** via `POST /vendor/plans/:planId/purchase`
(auto-activates on payment). Admins can also assign a plan manually for
comps/overrides (see the admin billing doc).

## Payment disputes / chargebacks (dashboard changes)

Card payments (Stripe) can be disputed/refunded after the fact. When a billing charge is
**lost/refunded**, the backend automatically unwinds it — the dashboard just needs to render
the new states:

- **Plan purchase** → `status` becomes `reversed` and the vendor is **downgraded to the free
  `starter` tier**. After a chargeback, `GET /vendor/plan` will show the free plan as active.
  Surface a notice ("your plan was reversed due to a payment dispute — re-purchase or contact
  support") and let them buy again. An admin can restore the paid plan manually if the dispute
  is resolved in the vendor's favour.
- **Credit top-up** → `status` becomes `reversed` and the granted credits are **clawed back**
  via a `refund` ledger entry (`reason_code: topup_reversal`). The wallet **balance can go
  negative**; show it and gate credit-spending until they top back up.

These transitions are driven by Stripe webhooks — there is no vendor action/endpoint. Just add
the `reversed` status to plan-purchase and top-up history views, handle negative balances, and
show the `topup_reversal` ledger rows.
