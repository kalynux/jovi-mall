# Order administration

**Verified against source on 2026-09-08** — the six `/api/internal/admin/orders` routes and the absence of any `/api/admin/*` mount, the four request schemas (`outcome`, `page`/`limit`, cancel `reason` 3-500, refund `{amount?, reason, overridePolicy?, itemDefective?}` (re-verified for the refund-request rewiring 2026-10-05)), the refund-eligibility verdict fields and the `REFUND_POLICY_OVERRIDE_REQUIRED` details, against `jovi-mall/src/modules/orders/{admin-order.routes.ts,admin-order.controller.ts,admin-refund.service.ts}`; every error code named here is raised in `src/`.

> **ONE mount. There were two, and the legacy one was deleted at the Phase 5 cutover.**
>
> - `/api/internal/admin/orders` — called by the **wi-admin backend**, never by a browser.
>   All six capabilities: the two dispute endpoints plus the four Phase 10 added.
> - ~~`/api/admin/orders`~~ — the legacy dashboard mount, `requireAuth` +
>   `requireRole(['admin'])`, which served the two dispute endpoints only. **Deleted.**
>
> The dashboard talks to wi-admin's `/api/v1/orders`, which reads `jovi_mall` directly and
> delegates each write to one of the calls below. That has been true since Phase 10; what
> changed at cutover is that it is now the *only* way in.
>
> Design record: `../../../admin/docs/ADR-010-ORDERS-AND-SHIPMENTS.md`.

## Why the four newer endpoints were internal-only from the start

The deleted public mount's guard was `requireRole(['admin'])` on a platform `users` row — a
credential that predated wi-admin's permission catalog entirely and knew nothing about
`orders.refund` being a `financial` permission held by tier 2 alone. A refund moves money
through a payment gateway; it did not belong behind a role check that could not express who
may issue one.

**That argument is what the whole cutover generalised.** The other two endpoints were on the
weak guard as well, for no better reason than that they were older, and the reasoning above
applies to them identically. Phase 5 Part E finished the job: the surface is one mount, one
guard, and one authorization model — wi-admin's, where a tier and a permission set exist.

⚠ **The route headings below still say "both mounts" on the two dispute endpoints.** That now
means *the same two routes that used to be on both* — read every path in this document under
`/api/internal/admin/orders`. Left rather than rewritten because the distinction it draws
(these two are older than Phase 10, those four are not) is a real one worth keeping.

## Authentication (internal mount)

`requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`):

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` | yes | `INTERNAL_ADMIN_SERVICE_TOKEN`, compared in constant time. `Authorization: Bearer <token>` is accepted as an alternative |
| `X-Actor-Id` | yes | The acting administrator's `admin_accounts._id` from the **wi-admin** database. Must be a valid ObjectId |
| `X-Actor-Name` | no | Snapshotted onto every actor stamp this surface writes. Defaults to `Administrator` |
| `X-Request-Id` | no | Correlation id, echoed into logs |

The token is a **full-privilege credential**: authorization is resolved in wi-admin before
the call and re-checked nowhere here. Unset secret ⇒ `503`; bad token ⇒ `401`; missing or
malformed actor ⇒ `400`.

`X-Actor-Id` resolves to **nothing in this database**. On this surface it lands in
`order_timelines.actor_id` beside `actor_type: 'admin'`, which is what makes it legible.

---

## `GET /disputes` — both mounts

Query: `page` (default 1), `limit` (default 20, max 100).

Orders currently held by a payment dispute:
`{ $or: [{ 'dispute_hold.active': true }, { payment_status: 'disputed' }] }`, newest
updated first. The second branch catches rows predating `dispute_hold`.

---

## `POST /:orderId/dispute/resolve` — both mounts

Body: `{ "outcome": "won" | "lost" }`.

The manual override for when a Stripe event is missed or the case is settled out of band.

- `won` → lifts the hold and restores `payment_status: 'paid'`.
- `lost` → refunds internally, sets the order `returned` (if goods were in motion) or
  `cancelled`, marks the gateway transaction `REFUNDED`, reverses escrow and opens a ticket.
  It never calls Stripe's refund API: on a lost dispute the money is already gone and only
  internal state unwinds.

**A resolution that changed nothing is a `409 ORDER_DISPUTE_NOT_ACTIVE`, not a 200.** The
underlying service is idempotent because a Stripe webhook retries and a replay must be
harmless — but an operator is not a webhook, and "resolved as won" for an order that was
never disputed is a lie a support ticket gets closed on.

The timeline row records `actor_type: 'admin'` with the caller's id. Before Phase 10 it
recorded `system` / `null`, so the one admin-driven write on an order was anonymous.

| Status | Code |
|---|---|
| 404 | `ORDER_NOT_FOUND` |
| 409 | `ORDER_DISPUTE_NOT_ACTIVE` — nothing to resolve |

---

## `POST /:orderId/cancel` — internal only

Body: `{ "reason": string }` — required, 3–500 characters.

Runs `OrderService.assertCancellable`, **the same six guards the customer's own cancel
endpoint runs**, then `cancelOrder` with `actorType: 'admin'`.

Exactly one guard is waived for an administrator: the **vendor's cancellation policy**. A
return window is the vendor's commercial promise to their customer and the platform is not
party to it. Everything else binds an administrator identically:

| Refusal | Code | Status |
|---|---|---|
| already cancelled | `ORDER_ALREADY_CANCELLED` | 409 |
| past `processing` | `ORDER_NOT_CANCELLABLE` (`details.fulfillmentStatus`) | 422 |
| the order was paid | `ORDER_CANCEL_REQUIRES_REFUND` | 422 |
| payment neither `pending` nor `AWAITING_PAYMENT` | `ORDER_NOT_CANCELLABLE` (`details.paymentStatus`) | 422 |
| a COD parcel already left the agency | `ORDER_NOT_CANCELLABLE` (`details.reason`) | 422 |

A paid order is cancelled by refunding it first, then cancelling — deliberately two acts,
because the money and the fulfilment are two facts.

Side effects: an `order_timelines` row (`actor_type: 'admin'`) and an `order.cancelled`
event, which the vendor and customer notification stacks both consume.

---

## `POST /:orderId/dispatch` — internal only

Body: `{ "reason"?: string }`.

Hands a paid-but-undispatched physical order to its delivery agency — the unblock for an
order the vendor never dispatched and whose auto-redirect never fired.

Response: `{ "order": <order>, "shipmentsAssigned": number }`.

**`shipmentsAssigned: 0` is a no-op, not an error.** The usual cause is that auto-redirect
dispatched it a moment earlier.

| Refusal | Code | Status |
|---|---|---|
| digital order | `ORDER_WRONG_TYPE` | 400 |
| unpaid (and not COD awaiting cash) | `ORDER_PAYMENT_REQUIRED` | 422 |
| frozen by a dispute | `ORDER_DISPUTE_HOLD` | 423 |

The timeline records *"An administrator dispatched the order to its delivery agency"* — its
own wording, because describing an admin dispatch as "auto-dispatched" would misstate the
exact fact a delivery dispute asks about.

---

> ⚠ **Rewired 2026-10-05 (REFUND-FLOW-PLAN § 4).** These two routes are now the **legacy** door:
> the refund **queue** is `/api/internal/admin/refunds` ([refunds.md](./refunds.md)), which owns
> the four-eyes approval, typed numbers with proof, external settlement and retries. The legacy
> `POST` no longer calls a gateway's refund API: it **opens a refund request and approves it in
> the same call** (the administrator is the approver) when the money can be sent on its own, and
> otherwise leaves it **awaiting approval in the queue**. It **refuses 2,000,000 and above**
> (`422 REFUND_USE_REFUND_QUEUE`), because the queue is where a second administrator approves.

## `GET /:orderId/refund-eligibility` — internal only

Read-only. **Never throws on ineligibility** — it answers with a verdict. The money half is the
SAME ceiling `RefundRequestService.create` enforces.

```jsonc
{
  "eligible": true,                  // the MONEY verdict: is there a balance to refund (and none in progress)?
  "maxRefundable": 45000,            // remaining balance capped by the delivery rule (C-1) — NOT the vendor's fraction
  "remaining": 45000,                // un-refunded money on the order (online payments, or COD cash collected)
  "currency": "XAF",
  "gateway": "NOTCHPAY",             // the checkout payment's gateway; null for COD
  "gatewayRefundSupported": true,    // MEANING CHANGED: "will the money go back on its own once approved?"
                                     // card → true; mobile money with the payer's number → true (a payout);
                                     // COD / no number on record → false (the queue asks for a typed number)
  "isCod": false,
  "vendorPolicy": { /* what the VENDOR's own policy would allow — reported, not enforced */ },
  "overrides": ["return_window_expired"],  // which vendor gates a refund would cross
  "openRefundRequest": null,         // NEW: { id, status } when a refund of this order is in progress
  "legacyRouteCeiling": 2000000      // NEW: at or above this the POST refuses — use the refund queue
}
```

`reasonCode` (when `eligible: false`) may now also be **`REFUND_ALREADY_OPEN`**. A COD order is
no longer ineligible (`REFUND_ORDER_IS_COD` is not reported any more): it is refundable once its
cash was collected, through the queue.

**After delivery** the customer's delivery money is refundable only per the vendor's
return-shipping setting (`vendor` → yes, charged to the vendor; `customer` → no;
`customer_reimbursed_if_defect` → only with `itemDefective: true` on the POST). Before delivery
everything paid is refundable.

---

## `POST /:orderId/refund` — internal only (legacy)

Body: `{ "amount"?: integer, "reason": string, "overridePolicy"?: boolean, "itemDefective"?: boolean }`.

`amount` absent means **the most the money allows** (`maxRefundable`) — not the vendor's policy
cap. It must be a **whole number** now (XAF has no minor unit). `reason` is required where the
vendor's own endpoint makes it optional: an administrator overriding a vendor's terms has to say
why, and the request's `reason` is the only place this service stores it.

### What happens

| Payment | Result | `status` |
|---|---|---|
| Card | Stripe refunds it in the call, no fee | `completed` |
| Mobile money, payer's number on record | Approved by this administrator and sent: a payout to that number, minus the 2% refund fee | `sending` (or `failed` / `approved` + `transferFailureReason`) |
| COD, or no payer number on record | Opened **awaiting approval** in the refund queue: a number is typed there with its proof, and a **second** administrator approves (R-7). COD then waits for the agency's cash (`waiting_for_cash`) | `awaiting_approval` |

### What `overridePolicy` waives, and what it does not

| MAY be overridden — the vendor's commercial terms | NEVER overridden — the money invariants |
|---|---|
| `return_eligible === false` | more than the remaining refundable balance |
| `refund_type === 'none'` | more than the delivery rule allows (C-1, D-5) |
| the return window | an order with nothing paid |
| `refund_percentage` | a second open refund on the order |

Without the flag, a refund beyond the vendor's terms is refused so the operator confirms a
*specific* override rather than a general one:

```jsonc
// 422 REFUND_POLICY_OVERRIDE_REQUIRED
{ "overrides": ["return_window_expired"], "requested": 45000,
  "vendorMaxRefundable": 0, "vendorReasonCode": "REFUND_WINDOW_EXPIRED",
  "maxRefundable": 45000 }   // the PLATFORM ceiling — what the override would actually allow
```

| Refusal | Code | Status |
|---|---|---|
| **2,000,000 or more** — the four-eyes approval lives on the refund queue | **`REFUND_USE_REFUND_QUEUE`** (NEW; `details: { requested, ceiling, queue }`) | 422 |
| a refund of this order is already in progress | `REFUND_ALREADY_OPEN` (`details.refundRequestId`, `details.status`) | 409 |
| frozen by a dispute — resolve it `lost` instead | `ORDER_DISPUTE_HOLD` | 423 |
| beyond the vendor's terms, no flag | `REFUND_POLICY_OVERRIDE_REQUIRED` | 422 |
| above the allowed maximum | `REFUND_AMOUNT_EXCEEDS_MAX` | 400 |
| nothing left to refund | `REFUND_ALREADY_FULLY_REFUNDED` | 409 |
| no money ever paid / collected | `REFUND_PAYMENT_NOT_FOUND` (404) / `REFUND_ORDER_NOT_PAID` (409) | |

**No longer returned:** `REFUND_ORDER_IS_COD` and `REFUND_GATEWAY_NOT_SUPPORTED` — COD and mobile
money are refundable now.

### Response

```jsonc
{
  "refundId": "671...aa",          // DEPRECATED alias of refundRequestId (was a refund_transactions id)
  "refundRequestId": "671...aa",
  "status": "sending",             // the REQUEST's status
  "amount": 45000,                 // GROSS — what the order loses
  "grossAmount": 45000, "feeAmount": 900, "netAmount": 44100,
  "currency": "XAF",
  "paymentChannel": "mobile_money", "channel": "payout",
  "transferFailureReason": null,
  "totalRefunded": 0,              // Σ COMPLETED refunds on the order
  "fullyRefunded": false,          // true only once COMPLETED and the order is square
  "withinVendorPolicy": false,
  "overrides": ["return_window_expired"]
}
```

`withinVendorPolicy` and `overrides[]` still land in wi-admin's audit row's `after`. ⚠ wi-admin's
`PlatformRefundResult` types `status` as `'completed'`; it reads `refundId` as a string, which is
still true (now the request id).

---

## Refunds on cart-checkout orders

A cart checkout settles N orders (one per vendor) with **one** `PaymentTransaction`
carrying `cartId` + `orderIds[]` and no `orderId`. Two consequences, both handled in
`PaymentOrchestratorService` and therefore true of the **vendor's** refund path as well:

1. The payment lookup matches `orderIds` as well as `orderId`. Before Phase 10 it did not,
   so every cart-checkout order answered `REFUND_PAYMENT_NOT_FOUND`.
2. The refundable ceiling is **that order's own share**, not the cart's balance —
   otherwise one vendor's refund could be paid out of another vendor's customer's money.
   `fullyRefunded` is likewise computed per source, so refunding one order of a two-vendor
   cart unwinds that order and its earnings while leaving the payment open for the other.
