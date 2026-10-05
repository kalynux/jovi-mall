# FRONTEND CHANGELOG — refunds become refund requests (2026-10-05)

**Audience:** the vendor dashboard. Plan: `../PRODUCTION-READINESS/REFUND-FLOW-PLAN.md` § 4 (owner
decisions R-1…R-9, C-1…C-7). Contract: [customer-management.md § 4](./customer-management.md#4-refunds).

⚠ **ONE BREAKING RESPONSE CHANGE** — `POST /api/vendor/orders/:id/refund`. Everything else is
additive.

## 1 · Why

Until now a refund was a call to the payment gateway's refund API, and only cards have one. A
mobile-money order (every NotchPay / My-CoolPay / Campay / Fapshi / CinetPay payment) answered
`400 REFUND_GATEWAY_NOT_SUPPORTED`, and a cash-on-delivery order `404 REFUND_PAYMENT_NOT_FOUND`:
the vendor could not refund most orders at all.

Now the refund button opens a **refund request** and the platform sends the money:

| Payment | What happens | `status` you get back |
|---|---|---|
| Card | Refunded to the card at once, no fee | `completed` |
| Mobile money, the paying number is on record | A **transfer to the number that paid**, minus the **2% refund fee** (5000 → the customer receives 4900) | `sending`, later `completed` (or `failed`) |
| Cash on delivery | Our team approves it and types the customer's number; it is sent once the agency's cash for that parcel has reached the platform | `awaiting_approval` |
| No paying number on record (older payments), or automatic transfers switched off | Our team decides | `awaiting_approval` (or `approved`, with `transferFailureReason`) |

Your earnings for the order are **paused** while a refund is in progress and the refunded share is
**taken back when the money reaches the customer** (from pending, or from your available balance;
if neither covers it, it becomes an amount you owe, recovered from your next earnings). A refund
that is rejected releases the pause.

## 2 · ⚠ BREAKING — `POST /api/vendor/orders/:id/refund` answers the REQUEST

| Field | Before | Now |
|---|---|---|
| `status` | always `"completed"` | `completed` \| `sending` \| `approved` \| `awaiting_approval` \| `failed` |
| `refundId` | a `refund_transactions` id | **deprecated alias of `refundRequestId`** |
| `refundRequestId` | — | NEW: the refund request |
| `amount` | the refund | unchanged meaning: the **gross** the order loses |
| `grossAmount`, `feeAmount`, `netAmount` | — | NEW: gross, the 2% fee (0 for a card), what the customer receives |
| `paymentChannel`, `channel` | — | NEW: `card`/`mobile_money`/`cod`; `card_refund`/`payout`/`external`/`null` |
| `destinationMasked` | — | NEW: the number the transfer goes to, masked (`+•••••••••001`); null for a card |
| `transferFailureReason` | — | NEW: why it did not send yet (`payout_unavailable`, `insufficient_gateway_balance`, the gateway's refusal) |
| `totalRefunded` | Σ refunds on the payment | Σ **completed** refunds on the order |
| `fullyRefunded` | true after a full refund | true only once the request **completed** and the order is square |
| `message` | "Order fully refunded" / "Partial refund processed" | one sentence per `status` |

**Do:** stop treating a 200 as "refunded". Render by `status`:

- `completed` → *Refunded.*
- `sending` / `approved` → *The refund is on its way to the customer.* Refresh the order later.
- `awaiting_approval` → *Our team will approve this refund* (COD: *once the courier's cash has
  reached us*).
- `failed` → *We could not send the refund yet — our team will retry or pay it another way.*

Show `netAmount` as *"the customer receives"* and `feeAmount` as *"refund fee"* when it is non-zero.

**Errors that changed:**

- NEW `409 REFUND_ALREADY_OPEN` — a refund of this order is already in progress (yours, our
  team's, or the one opened when you cancelled a paid order). `details.refundRequestId`,
  `details.status`.
- `REFUND_GATEWAY_NOT_SUPPORTED` (400) and `REFUND_GATEWAY_FAILED` (502) are **no longer
  returned** by this endpoint.
- `amount` must be a **whole number** now (`400 VALIDATION_ERROR` otherwise). XAF has no minor unit.

## 3 · Additive — the request body

`itemDefective?: boolean` — read only when your return policy's shipping rule is
`customer_reimbursed_if_defect`. `true` returns the customer's delivery money as well, charged to
you. Offer it as a checkbox on the refund form under that policy only.

## 4 · Additive — `GET /api/vendor/orders/:id/refund-eligibility`

- NEW `paymentChannel` (`card` | `mobile_money` | `cod` | null) and `autoSend` (true → sent at
  once; false → our team approves). Use `autoSend` for the button's helper text.
- NEW `openRefundRequest: { id, status } | null`, and a new `reasonCode` **`REFUND_ALREADY_OPEN`**
  while one is in progress — disable the button and say a refund is already under way.
- `maxRefundable` is now a **whole number** (a partial policy rounds **down**) and, **after
  delivery**, follows your return-shipping setting: delivery money is refundable only when you pay
  return shipping (or tick *item defective* under the "reimbursed if defective" rule). Before
  delivery everything paid is refundable.
- COD orders are now eligible once the cash was collected (they used to answer
  `REFUND_PAYMENT_NOT_FOUND`); `autoSend` is always false for them.

## 5 · Unchanged

- The return window still runs from **delivery** (see
  [FRONTEND-CHANGELOG-earnings-hold-and-pauses.md](./FRONTEND-CHANGELOG-earnings-hold-and-pauses.md)).
- Cancelling a paid order still does not refund automatically — it now also opens a refund
  request **awaiting approval** for our team, so the order's eligibility reads `REFUND_ALREADY_OPEN`
  until they decide.
