# Phase D · 0 · 1 — vendor and agency dashboards

Everything Phases D, 0 and 1 changed for the two self-serve dashboards. Base URL
`http://localhost:8022/api` in development; every route here needs a session
(cookie or `Bearer`) and the matching role.

Two surfaces changed, and one of them changed silently in your favour:

1. **Billing** — plan purchases and credit top-ups on mobile money **now settle from the
   gateway callback**. They were poll-only, and a vendor who closed the tab after paying never
   got their plan.
2. **Refunds** — `gatewayRefundSupported` is now derived from the gateway registry instead of a
   hardcoded list, and it answers two questions at once.

Phase 0 changed nothing on the wire. Phase D changed nothing on the wire yet — see
**§ 6**.

---

## 1 · Billing — what actually changed

Both dashboards mount the same controller factory, so the vendor, agency and agent surfaces are
identical in shape:

| Purpose | Vendor | Agency |
|---|---|---|
| List purchasable plans | `GET /api/vendor/plans` | `GET /api/agency/plans` |
| Current plan + entitlements | `GET /api/vendor/plan` | `GET /api/agency/plan` |
| **Buy a plan** | `POST /api/vendor/plans/:planId/purchase` | `POST /api/agency/plans/:planId/purchase` |
| Re-check a purchase | `POST /api/vendor/plan-purchases/:id/verify` | `POST /api/agency/plan-purchases/:id/verify` |
| Credit balance | `GET /api/vendor/credits` | `GET /api/agency/credits` |
| Credit packs | `GET /api/vendor/credits/packs` | `GET /api/agency/credits/packs` |
| **Buy credits** | `POST /api/vendor/credits/topups` | `POST /api/agency/credits/topups` |
| Re-check a top-up | `POST /api/vendor/credits/topups/:id/verify` | `POST /api/agency/credits/topups/:id/verify` |
| Expiry-notice setting | `GET`/`PATCH /api/vendor/settings` | `GET`/`PATCH /api/agency/settings` |

**The change, in one sentence:** a plan purchase and a credit top-up now each carry a *merchant
reference* (`jm_pp_…` / `jm_ct_…`) that the mobile-money provider echoes back on its callback,
so the callback can find the row and settle it. Neither creates a `PaymentTransaction`, which is
exactly why the callback used to find nothing, log "unknown transaction" and answer success.

Consequences for the dashboard:

- **Polling `/verify` is now optional.** Keep doing it while the user is watching, because it
  gives them an answer now. Do not require it for correctness.
- **A user who closes the tab still gets what they paid for.** The callback settles it, and if
  the callback is lost, a background sweep re-verifies pending purchases and top-ups against the
  provider's own record every 10 minutes for up to 72 hours.
- **Both settlement paths are idempotent and race-safe.** `completePurchase` claims
  `pending → paid` atomically, so a callback racing your poll applies the plan exactly once.

---

## 2 · `POST /{vendor|agency}/plans/:planId/purchase`

**Auth:** required, matching role. **Response:** `201`.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `gateway` | `"NOTCHPAY"` \| `"MYCOOLPAY"` \| `"STRIPE"` | ✅ | |
| `channel` | object | optional — **defaults to `{}`** | Every field inside is optional |
| `channel.phoneNumber` | string | required in practice for mobile money | **E.164**, e.g. `+237650123456`. The mobile gateways cannot charge without it |
| `channel.phoneOperator` | `"MTN"` \| `"ORANGE"` \| `"MOOV"` | optional | NotchPay needs MTN/Orange resolved; if omitted it is derived from the number's prefix, and refused with `PAYMENT_OPERATOR_UNDETERMINED` when it cannot be |
| `channel.cardToken` | string | optional | Stripe |
| `channel.customerEmail` | string | optional | Must be a valid address |
| `channel.customerName` | string | optional | |

> The `channel` object is **optional here** (it defaults to `{}`) and **required** on
> `/api/payments/initiate`. That asymmetry predates Phase 1 and is unchanged.

### Response `201`

```jsonc
{
  "success": true,
  "data": {
    "purchase": {
      "_id": "66c2a1b3e4b1d2c3a4b5c700",
      "owner_type": "vendor",
      "owner_id": "66a0d1c2e4b1d2c3a4b5c101",
      "plan_id": "66909aa1e4b1d2c3a4b5c001",
      "plan_code": "vendor_growth",
      "price": 15000,
      "currency": "XAF",
      "status": "pending",
      "gateway": "NOTCHPAY",
      "gateway_ref": "trx.p8Kq2mFh3xR7",
      "merchant_ref": "jm_pp_5b1e7c92a0d34f6688ac21be40739f5d",
      "subscriber_plan_id": null,
      "created_at": "2026-08-18T09:00:00.000Z",
      "updated_at": "2026-08-18T09:00:02.000Z"
    },
    "instructions": {
      "requiresOtp": true,
      "message": "Enter the confirmation code sent to your phone by SMS to complete this payment."
    }
  },
  "message": "Plan purchase initiated"
}
```

**`data.purchase` — every field:**

| Field | Type | Notes |
|---|---|---|
| `_id` | string | The purchase id — the `:id` in the verify route |
| `owner_type` | `"vendor"` \| `"agency"` \| `"agent"` | Fixed per mount |
| `owner_id` | string | The role entity, not the user |
| `plan_id` | string | The pricing plan bought |
| `plan_code` | string | Stable code, e.g. `vendor_growth` |
| `price` | number | Whole XAF |
| `currency` | string | `"XAF"` |
| `status` | `"pending"` \| `"paid"` \| `"failed"` \| `"reversed"` | `paid` is the only one that applies the plan |
| `gateway` | string \| null | |
| `gateway_ref` | string \| null | The provider's reference, written once it answers |
| `merchant_ref` | string \| null | **New in Phase 1.** `jm_pp_` + 32 hex characters. This is what lets the callback settle the purchase. `null` on rows created before Phase 1 |
| `subscriber_plan_id` | string \| null | The `SubscriberPlan` created when the purchase was applied. `null` until paid **and** applied |
| `created_at` · `updated_at` | ISO-8601 string | |

**`data.instructions`** is gateway-specific and may be `null`:

| Field | Present when | What you do |
|---|---|---|
| `ussdCode` | Mobile money, when the provider returned one | Show it. **Often absent on NotchPay** — a direct MTN charge pushes an approval prompt to the handset and returns no code |
| `requiresOtp: true` | **My-CoolPay Orange Money** | Collect the SMS code and POST it to `/api/payments/:transactionId/authorize` — see **§ 4** |
| `message` | Always, on mobile money | Render it |
| `expiresAt` | NotchPay, sometimes | Session expiry |
| `clientSecret` | Stripe | Confirm with Stripe.js / the Payment Element |
| `chargedAmount` · `chargedCurrency` | Stripe | Stripe charges in **USD** while `price`/`currency` stay XAF |

If the gateway confirms at initiation (rare on mobile money, normal on a zero-latency rail), the
plan is applied immediately and `purchase.status` is already `paid`.

### Errors

| `error.code` | Status | `category` | When |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | `validation` | Bad `gateway` or `channel`. `details.fields[]` names the path |
| `BILLING_PLAN_NOT_FOUND` | 404 | `not_found` | No such plan |
| `BILLING_PLAN_INACTIVE` | 409 | `conflict` | The plan is not active |
| `BILLING_PLAN_ROLE_MISMATCH` | 409 | `conflict` | The plan belongs to another role |
| `BILLING_PLAN_NOT_PURCHASABLE` | 409 | `conflict` | A free plan — it is the default tier and cannot be bought |
| `BILLING_PENDING_PLAN_EXISTS` | 409 | `conflict` | One plan is already queued to activate at expiry. **Money is deliberately not taken for a plan that cannot be applied** |
| `PAYMENT_OPERATOR_UNDETERMINED` | 422 | `business_rule` | MTN/Orange could not be resolved from the number. Ask which network |
| `PAYMENT_CURRENCY_NOT_SUPPORTED` | 422 | `business_rule` | A minor-unit currency on a mobile rail |
| `PAYMENT_INITIATION_FAILED` | 502 | `external_service` | The gateway refused or threw. The purchase is marked `failed` |
| `PAYMENT_GATEWAY_NOT_IMPLEMENTED` | 503 | `external_service` | That gateway is not configured on this deployment |
| `NOTCHPAY_REQUEST_FAILED` · `MYCOOLPAY_REQUEST_FAILED` | 502 | `external_service` | Provider answered non-2xx |
| `NOTCHPAY_UNREACHABLE` · `MYCOOLPAY_UNREACHABLE` | 503 | `external_service` | Timeout, DNS, refused connection |

### `POST /{vendor|agency}/plan-purchases/:id/verify`

No body. Polls the provider and applies the result.

```jsonc
{
  "success": true,
  "data": {
    "purchase": { "...the same shape as above, with status now paid | failed | pending" },
    "subscriberPlan": {
      "_id": "66c2a1b3e4b1d2c3a4b5c780",
      "owner_type": "vendor",
      "owner_id": "66a0d1c2e4b1d2c3a4b5c101",
      "plan_id": "66909aa1e4b1d2c3a4b5c001",
      "status": "active",
      "starts_at": "2026-08-18T09:03:00.000Z",
      "expires_at": "2026-09-17T09:03:00.000Z"
    }
  }
}
```

`data.subscriberPlan` is `null` in three situations, and none of them is an error: the purchase
is still `pending`; the purchase `failed`; or the purchase was **already** `paid` when you
called (the endpoint is idempotent and returns the row without re-applying the plan). Read
`GET /{vendor|agency}/plan` for the authoritative current plan.

| `error.code` | Status | When |
|---|---|---|
| `BILLING_PLAN_PURCHASE_NOT_FOUND` | 404 | Unknown id, or it belongs to another owner |
| `BILLING_PURCHASE_INVALID_STATE` | 409 | The purchase has no `gateway_ref` yet — the charge never opened |

---

## 3 · `POST /{vendor|agency}/credits/topups`

**Auth:** required, matching role. **Response:** `201`.

### Request body

| Field | Type | Required | Rules |
|---|---|---|---|
| `packCode` | string | ✅ | One of the codes from `GET /credits/packs` |
| `gateway` | `"NOTCHPAY"` \| `"MYCOOLPAY"` \| `"STRIPE"` | ✅ | |
| `channel` | object | optional — defaults to `{}` | Identical to **§ 2** |

The pack catalogue (`GET /credits/packs`, unchanged by Phase 1) is four fixed packs, each
`{ code, credits, price, currency }`:

| `code` | `credits` | `price` | `currency` |
|---|---|---|---|
| `pack_100` | 100 | 600 | XAF |
| `pack_320` | 320 | 1800 | XAF |
| `pack_1100` | 1100 | 6000 | XAF |
| `pack_2250` | 2250 | 12000 | XAF |

### Response `201`

```jsonc
{
  "success": true,
  "data": {
    "topup": {
      "_id": "66c2a2c4e4b1d2c3a4b5c800",
      "owner_type": "vendor",
      "owner_id": "66a0d1c2e4b1d2c3a4b5c101",
      "pack_code": "pack_320",
      "credits": 320,
      "price": 1800,
      "currency": "XAF",
      "status": "pending",
      "gateway": "MYCOOLPAY",
      "gateway_ref": "3f7c1b9a-2e44-4f10-9a01-77bd2c5e8a13",
      "merchant_ref": "jm_ct_c40f7a1de29b46c1935e08fa27d6b3e5",
      "payment_transaction_id": null,
      "created_at": "2026-08-18T09:10:00.000Z",
      "updated_at": "2026-08-18T09:10:03.000Z"
    },
    "instructions": { "ussdCode": "*126#", "message": "Confirm the payment prompt on your phone to complete this payment." }
  },
  "message": "Top-up initiated"
}
```

| Field | Type | Notes |
|---|---|---|
| `_id` | string | The top-up id — the `:id` in the verify route |
| `owner_type` | `"vendor"` \| `"agency"` \| `"agent"` | |
| `owner_id` | string | |
| `pack_code` | string | The pack bought |
| `credits` | number | Credits the wallet receives on `paid` |
| `price` | number | Whole XAF |
| `currency` | string | |
| `status` | `"pending"` \| `"paid"` \| `"failed"` \| `"reversed"` | The wallet is credited exactly once, on the transition to `paid` |
| `gateway` | string \| null | |
| `gateway_ref` | string \| null | |
| `merchant_ref` | string \| null | **New in Phase 1.** `jm_ct_` + 32 hex characters |
| `payment_transaction_id` | string \| null | Always `null` on this path — a top-up creates **no** `PaymentTransaction`. The field exists for a future linkage |
| `created_at` · `updated_at` | ISO-8601 string | |

`data.instructions` is the same object as **§ 2**,
including the `requiresOtp` branch.

### Errors

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing `packCode`, bad `gateway`, malformed `channel` |
| `BILLING_TOPUP_PACK_NOT_FOUND` | 404 | Unknown `packCode` |
| `PAYMENT_INITIATION_FAILED` | 502 | The gateway refused. The top-up is marked `failed` |
| Every gateway error from **§ 2** | | Identical |

### `POST /{vendor|agency}/credits/topups/:id/verify`

No body. Returns `{ success: true, data: <the top-up row above> }` with `status` updated. A
`paid` top-up returns unchanged — it is idempotent.

| `error.code` | Status | When |
|---|---|---|
| `BILLING_TOPUP_NOT_FOUND` | 404 | Unknown id, or another owner's |
| `BILLING_TOPUP_INVALID_STATE` | 409 | No `gateway_ref` yet |

---

## 4 · The one-time-code step

**New in Phase 1**, and it is on the shared payments surface rather than the billing one:

```
POST /api/payments/:transactionId/authorize
```

> ⚠ **Read this carefully — the id is the sticking point.** That route takes a
> **`PaymentTransaction` id**, and a plan purchase or credit top-up **does not create one**. On
> the billing path, `gateway_ref` on the purchase/top-up row **is** the provider's transaction
> reference, but the authorize route resolves its `:transactionId` against
> `payment_transaction` and will answer `404 PAYMENT_TRANSACTION_NOT_FOUND` for a billing row's
> id.
>
> So today, a **billing** purchase that answers `requiresOtp: true` has no first-party endpoint
> to submit the code to. In practice this branch is Orange Money on My-CoolPay only; MTN
> numbers take the USSD/push path and are unaffected. If your dashboard offers My-CoolPay to
> Orange numbers for plans or credits, treat this as an open gap and raise it — do not build a
> workaround against `gateway_ref`.

For a **checkout** payment (customer-side, orders and bookings), the endpoint works exactly as
documented in [customer-app.md § 3](./customer-app.md):
body `{ "code": "123456" }`, 4–8 digits, 5 attempts (`PAYMENT_OTP_MAX_ATTEMPTS`), and the sixth
wrong code fails the transaction.

---

## 5 · Refunds (vendor)

The endpoints are unchanged. What changed is the **verdict** and what happens to the money.

| Purpose | Endpoint |
|---|---|
| What may be refunded, under the vendor's own return policy | `GET /api/vendor/orders/:id/refund-eligibility` |
| Action a refund | `POST /api/vendor/orders/:id/refund` |

`GET /refund-eligibility` returns, unchanged by Phase 1:

| Field | Type | Notes |
|---|---|---|
| `eligible` | boolean | Policy **and** money verdict combined |
| `maxRefundable` | number | The most this vendor may refund right now |
| `remaining` | number | The payment's remaining un-refunded balance |
| `currency` | string \| null | |
| `reasonCode` | string \| undefined | Why not, when `eligible` is `false` |
| `refundProcessingDays` | number \| null | From the vendor return policy — copy for the customer |
| `returnShippingPayer` | string \| null | From the vendor return policy |

`POST /refund` returns `refundId`, `status: "completed"`, `amount`, `currency`, `totalRefunded`,
`fullyRefunded`, `refundProcessingDays` and `returnShippingPayer`.

### What Phase 1 changed underneath

| Gateway | Behaviour |
|---|---|
| `STRIPE` | A real API refund, as before |
| `NOTCHPAY` | A **real refund integration now exists** — but refunds are **disabled on the merchant account** (`POST /refunds` answers 403 while `GET /refunds` answers 200 with the same credentials, verified 2026-08-18). Until the provider enables them, it behaves as `MYCOOLPAY` below |
| `MYCOOLPAY` | **The provider has no refund endpoint at all.** The method is deliberately absent from the adapter rather than stubbed |

When a gateway cannot refund, the call raises **`REFUND_GATEWAY_NOT_SUPPORTED` (400,
`business_rule`)** with `details.gateway`, and the platform routes the money through the manual
path: the order goes `refund_pending`, the vendor's escrowed earnings are reversed, and a
HIGH-importance support ticket is raised for a manual payout.

> **This is the distinction to render correctly.** `REFUND_GATEWAY_NOT_SUPPORTED` is an
> *answer*, not an outage — the refund is happening, by hand. `REFUND_GATEWAY_FAILED` (502,
> `external_service`) is a genuine failure and is worth a retry. Before Phase 1 both mobile
> gateways defined a `refundPayment` that always failed, so the code actually raised was the
> second one while the documentation promised the first.

### Refund error codes

| `error.code` | Status | `category` | When |
|---|---|---|---|
| `REFUND_PAYMENT_NOT_FOUND` | 404 | `not_found` | No `SUCCEEDED` payment for this order |
| `REFUND_ORDER_NOT_FOUND` | 404 | `not_found` | A group payment named an order that cannot be loaded |
| `REFUND_ORDER_IS_COD` | 400 | `validation` | Cash on delivery never went through a gateway |
| `REFUND_ORDER_NOT_PAID` | 400 | `validation` | The order is not paid |
| `REFUND_ALREADY_FULLY_REFUNDED` | 409 | `conflict` | Nothing left to refund |
| `REFUND_AMOUNT_EXCEEDS_MAX` | 400 | `validation` | `details.requested`, `details.remaining`, and on a cart-group payment `details.scope: "order"` plus `details.groupPaymentId` |
| `REFUND_NOT_ELIGIBLE` · `REFUND_WINDOW_EXPIRED` · `REFUND_POLICY_DISABLED` | 400 / 422 | `validation` / `business_rule` | The vendor's own return policy refused it |
| `REFUND_GATEWAY_NOT_SUPPORTED` | 400 | `business_rule` | See above — **expected, not an outage** |
| `REFUND_GATEWAY_FAILED` | 502 | `external_service` | The gateway call failed. `details` is dropped at the boundary |

> **A cart-group refund is capped per order, not per payment.** One payment settles N orders; the
> ceiling for a refund is that order's own share (`total_amount` minus the completed refunds
> already carrying its id), never the group balance. That is why `REFUND_AMOUNT_EXCEEDS_MAX` can
> fire on an amount well below the payment's remaining balance.

### Bookings

`POST /api/vendor/bookings/:id/cancel` on a **paid** booking refunds the customer. Where the
gateway supports it the money returns automatically and `paymentStatus` becomes `refunded`.
Otherwise — cash, and My-CoolPay, whose API has no refund endpoint — `paymentStatus` becomes
`refund_pending` and a HIGH-importance ticket is raised. **Your escrowed earnings are reversed
in both cases**, and a refund problem never blocks the cancellation.

---

## 6 · Phase D decisions that will reach these dashboards

All ten were answered on 2026-08-18. Four touch these dashboards, and **none is built yet**:

| Decision | Answer | Status |
|---|---|---|
| **Q-5 · Who can download whose uploads?** | Scan on ingest **and** move the three private upload trees behind auth. The whole upload tree is currently served by an unauthenticated static mount | Decided (`jovi-mall/docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`). **Implemented in Phase 4.A.4.** When it lands, a direct URL to a private file stops working without a session — do not hard-code storage URLs into a dashboard |
| **Q-3 · Bearer session cap** | A **90-day absolute cap**, stateless `auth_time` claim | Decided (`ADR-A03-SESSION-CAP.md`). **Phase 4.A.5.** A 90-day-old session will stop refreshing |
| **Q-4 · Is the bargain range buyer-facing?** | **Neither** — it stays configuration-only. **No negotiation product is planned** | Decided (`ADR-A05-BARGAIN.md`). **Closed as not planned.** `bargain: { minPrice, maxPrice }` is validated and persisted, is never published to a buyer, and nothing downstream reads it. Do not build an offer/counter-offer UI |
| **Q-8 · Own the geocoding or rent it?** | **Cache first**, then rent one adapter. Both call sites (`GET /api/geo/search`, `GET /api/geo/reverse`) already sit behind `requireAuth`, so no anonymous traffic reaches the provider | Decided (`ADR-A04-GEOCODING.md`). **Phase 6.H.** Address search behaviour is unchanged today; expect it to get faster, not different |

---

## 7 · What did not change

- No billing endpoint was added, removed, renamed or re-shaped. The three new fields
  (`merchant_ref` on both rows, and the `requiresOtp` branch on `instructions`) are additive.
- Credit pack prices, plan pricing, entitlements and the expiry-notice setting are untouched.
- Agency shipment caps, agent capacity, COD and tracking are untouched — Phase 1 was a
  one-sided change inside jovi-mall's payments module, and neither geo-tracker nor wi-admin was
  modified.

## 8 · What Phase 0 means for you

Nothing on the wire. It is the reason the contract above can be trusted: all three backends are
now in Git with remotes, `scripts/` (27 test suites, 15 migrations, the seeds, the
`.env.example`, the deployment contract) is tracked and type-checked, and CI runs every suite on every push
— including the new `npm run test:payments`, 92 DB-free assertions over the payment module.
