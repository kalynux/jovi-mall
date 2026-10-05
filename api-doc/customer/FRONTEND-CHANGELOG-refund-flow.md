# Customer app & storefront — refunds you can follow

**Backend change: 2026-10-05 · Not deployed yet.** Additive for this app: one new key on orders and
bookings, new notifications on existing deep links. Nothing is removed or renamed. Design record:
`../../../PRODUCTION-READINESS/REFUND-FLOW-PLAN.md` (§ 8). Model and fee rules:
[../payments/README.md § Refunds](../payments/README.md#refunds--payouts-for-mobile-money-the-card-api-for-cards-2026-10-05).

---

## What changed, in one paragraph

A mobile-money or cash-on-delivery order **could not be refunded** before today — only card
payments could. Now every refund is a **refund request** that the platform tracks to the end: a card
is refunded in full through the card; mobile money is **sent back by transfer to the number that
paid, minus a 2% transfer fee** (5,000 XAF → the customer receives **4,900 XAF**); a cash-on-delivery
refund waits until the cash the customer paid has reached the platform from the delivery company,
then is sent to a number the team confirms with the customer. The customer cannot start a refund
from the app (they open a support request, as today); they **see** it on the order or booking and
are **told** at each step.

## 1 · Orders and bookings gain a `refund` block

Every order object (`GET /api/customer/orders/groups/:cartId`, `GET /api/customer/orders/:id`) and
every booking (`GET /api/customer/bookings`, `GET /api/customer/bookings/:id`,
`POST /api/customer/bookings/:id/cancel`) now carries **`refund`** — the latest refund request, or
`null`. Full contract: [orders.md § The `refund` block](./orders.md#the-refund-block).

```jsonc
"refund": {
  "status": "sending",          // requested | waiting_for_cash | sending | in_progress | completed | declined
  "grossAmount": 5000,
  "feeAmount": 100,             // 0 for a card refund
  "feePercent": 2,              // 0 for a card refund
  "netAmount": 4900,            // ⭐ what the customer receives
  "currency": "XAF",
  "channel": "payout",          // card_refund | payout | external | null
  "destinationMasked": "+•••••••••512",   // null for a card refund
  "waitingForCash": false,      // COD only
  "completedAt": null
}
```

**What the UI should do**

1. **Show a refund panel when `refund !== null`** on the order and booking pages (and a small badge
   on the list row): status label, **`netAmount`** as the amount, and the destination when present
   ("to +•••512").
2. **Fee line when `feeAmount > 0`:** *"You receive 4,900 XAF (5,000 minus a 2% transfer fee)."* /
   *"Vous recevez 4 900 XAF (5 000 moins des frais de transfert de 2 %)."* Take every number from
   the block — **never compute the fee in the app.**
3. **Card refunds (`channel: "card_refund"`) show the full amount and no fee line** — "Refunded to
   your card".
4. **Status copy** (EN / FR):

   | `status` | EN | FR |
   |---|---|---|
   | `requested` | Refund requested — we'll tell you when it's sent | Remboursement demandé — nous vous préviendrons à l'envoi |
   | `waiting_for_cash` | Refund approved — waiting for the delivery company to hand over your cash | Remboursement approuvé — en attente de l'argent remis par la société de livraison |
   | `sending` | Refund on its way to +•••512 | Remboursement en route vers le +•••512 |
   | `in_progress` | Refund in progress | Remboursement en cours |
   | `completed` | Refunded (`completedAt`) | Remboursé (`completedAt`) |
   | `declined` | Refund declined — contact support if you think this is a mistake | Remboursement refusé — contactez l'assistance si vous pensez qu'il s'agit d'une erreur |

5. ⛔ **Never show "failed".** The backend has no customer status for it: a failed transfer reads
   `in_progress` because the team retries it or pays it by hand, and the customer is still owed
   the money.
6. **`declined` carries no reason.** The administrator's note is internal; offer the support entry
   point instead.
7. Keep `paymentStatus` as it is. It still becomes `refunded` only when the **whole** order is
   refunded — an order can be `paid` with a completed **partial** refund, so read `refund`, not
   `paymentStatus`, for the refund panel. A booking's `refund_pending` now means "a refund request is
   waiting for the team".
8. `deliveryFeeRefund` (`{ owed, returned }`, the delivery-fee ledger) is **unchanged** and
   independent. If both are present, show both.

## 2 · Booking cancellation now says where the money is

`POST /api/customer/bookings/:id/cancel` returns the booking **with its `refund`**: usually
`sending` (mobile money) or `completed` (card) straight away, or `requested` when no paying number is
on record. Replace any "a support ticket was raised for a manual payout" copy with the block's
status.

## 3 · New notifications (all on existing deep links)

All are money situations — they **cannot be muted** — and every button opens the existing order page
(`shop/account/orders/detail/{orderId}`) or booking page (`shop/account/bookings/{bookingId}`). No new
route is needed.

| Type | When |
|---|---|
| `order.refund.requested` / `booking.refund.requested` | a refund was requested and is under review |
| `order.refund.waiting_for_cash` | COD: approved, waiting for the cash to reach the platform |
| `order.refund.sending` / `booking.refund.sending` | the transfer is on its way (net + fee line) |
| `order.refund.completed` / `booking.refund.completed` | the transfer arrived (net + fee line) |
| `order.refund.paid_externally` / `booking.refund.paid_externally` | the team paid it outside the app |
| `order.refund.declined` / `booking.refund.declined` | the request was declined |
| `order.refunded` / `booking.refunded` | **unchanged** — a **card** refund completed, full amount |

The inbox (`GET /api/customer/notifications`) renders them like every other row; if the app maps
`type` to an icon, add the eleven new types (a refund icon). See [notifications.md](./notifications.md).
The new WhatsApp templates still need Meta's approval; until then those customers get the in-app row,
push and email/Telegram — nothing for the app to do.

## 4 · Errors

None new for this app. The customer starts no refund; `POST /api/customer/orders/:id/cancel` still
refuses a paid order with `422 ORDER_CANCEL_REQUIRES_REFUND` — point the customer to support.

## Done when

The order and booking pages show the refund panel from `refund` alone, the net amount and the fee
line match the API exactly, a card refund shows no fee, "failed" appears nowhere, and the eleven
notification types open the right page.
