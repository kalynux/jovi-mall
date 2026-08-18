# Order administration

> **Two mounts, and they are not the same surface.**
>
> - `/api/admin/orders` — the LEGACY dashboard mount, `requireAuth` + `requireRole(['admin'])`.
>   Serves the two dispute endpoints only. Alive until cutover.
> - `/api/internal/admin/orders` — called by the **wi-admin backend**, never by a browser.
>   Serves those two *plus* the four capabilities Phase 10 added.
>
> The dashboard talks to wi-admin's `/api/v1/orders`, which reads `jovi_mall` directly and
> delegates each write to one of the calls below.
>
> Design record: `../../../admin/docs/ADR-010-ORDERS-AND-SHIPMENTS.md`.

## Why the four new endpoints are internal-only

The public mount's guard is `requireRole(['admin'])` on a platform `users` row — a
credential that predates wi-admin's permission catalog entirely and knows nothing about
`orders.refund` being a `financial` permission held by tier 2 alone. A refund moves money
through a payment gateway; it does not belong behind a role check that cannot express who
may issue one.

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

## `GET /:orderId/refund-eligibility` — internal only

Read-only. **Never throws on ineligibility** — it answers with a verdict.

```jsonc
{
  "eligible": true,                  // the MONEY verdict: is there a balance to refund?
  "maxRefundable": 45000,            // the FULL remaining balance, not the vendor's fraction
  "remaining": 45000,
  "currency": "XAF",
  "gateway": "STRIPE",
  "gatewayRefundSupported": true,    // Stripe and NotchPay do; My-CoolPay has no refund API
  "isCod": false,
  "vendorPolicy": { /* what the VENDOR's own policy would allow — reported, not enforced */ },
  "overrides": ["return_window_expired"]   // which vendor gates a refund would cross
}
```

`gatewayRefundSupported` is reported **up front** on purpose: My-CoolPay has no refund endpoint
at all, and discovering that after the button is pressed leaves a `pending` `RefundTransaction`
behind and an operator who believes money moved. It is **derived from the gateway registry**
(does the adapter implement `refundPayment`?) rather than from a list kept beside it, so this
verdict and the guard that enforces it cannot drift apart.

---

## `POST /:orderId/refund` — internal only

Body: `{ "amount"?: number, "reason": string, "overridePolicy"?: boolean }`.

`amount` absent means **the full remaining refundable balance** — not the vendor's policy
cap. `reason` is required where the vendor's own endpoint makes it optional: an
administrator overriding a vendor's terms has to say why, the vendor will ask, and
`RefundTransaction.reason` is the only place this service can store it (wi-admin's audit
trail is in a database jovi-mall cannot read).

### What `overridePolicy` waives, and what it does not

| MAY be overridden — the vendor's commercial terms | NEVER overridden — the money invariants |
|---|---|
| `return_eligible === false` | more than the remaining refundable balance |
| `refund_type === 'none'` | an order with no `SUCCEEDED` payment |
| the return window | a gateway with no refund API |
| `refund_percentage` | an already fully-refunded payment |

Without the flag, a refund beyond the vendor's terms is refused so the operator confirms a
*specific* override rather than a general one:

```jsonc
// 422 REFUND_POLICY_OVERRIDE_REQUIRED
{ "overrides": ["return_window_expired"], "requested": 45000,
  "vendorMaxRefundable": 0, "vendorReasonCode": "REFUND_WINDOW_EXPIRED" }
```

| Refusal | Code | Status |
|---|---|---|
| COD order — the cash never went through a gateway | `REFUND_ORDER_IS_COD` | 422 |
| frozen by a dispute — resolve it `lost` instead | `ORDER_DISPUTE_HOLD` | 423 |
| beyond the vendor's terms, no flag | `REFUND_POLICY_OVERRIDE_REQUIRED` | 422 |
| above the remaining balance | `REFUND_AMOUNT_EXCEEDS_MAX` | 400 |
| nothing left to refund | `REFUND_ALREADY_FULLY_REFUNDED` | 409 |
| NotchPay / MyCoolPay | `REFUND_GATEWAY_NOT_SUPPORTED` | 400 |

The last is an **expected outcome**, not a bug — callers must handle it.

Response carries `withinVendorPolicy` and `overrides[]`, which wi-admin lands in the audit
row's `after`. That row is the only place the platform will ever record *which* of a
vendor's gates was crossed, because the policy it was evaluated against is one the vendor
may edit tomorrow.

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
