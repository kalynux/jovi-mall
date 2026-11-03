# Frontend changelog: answering a vendor's proposed price (2026-11-03)

**For: the storefront's signed-in account pages.** Endpoint reference: [bookings.md](./bookings.md#a-vendors-proposed-price).

## What changes for the customer

On a service the vendor approves by hand, the vendor can propose a higher price than the customer booked at. The customer accepts or declines. Only the vendor ever proposes, so there is no price field for the customer.

- **Accepting confirms the booking at that price.**
- **Declining changes nothing.** The vendor may propose again, confirm at the current price, or cancel. The customer may cancel with a **full refund whatever the cancellation policy says**, so show that next to Decline.
- After approval, the price only changes if the vendor moves the appointment and the customer agrees to both.

## 1. The `pricing` block

Every customer booking read carries it: the list, the detail, cancel, reschedule and the routes below.

```json
"pricing": {
  "originalPrice": 5000,
  "currentPrice": 7000,
  "amountPaid": 5000,
  "proposal": { "status": "open", "amount": 7000, "previousAmount": 5000, "proposedAt": "…", "expiresAt": "…", "answeredAt": null },
  "topup": { "amount": 2000, "dueAt": "…" }
}
```

⚠ `priceSnapshot` is now the **agreed** price. Show `pricing.currentPrice`, and `originalPrice` beside it when they differ.

## 2. Answer a proposal

Show this when `pricing.proposal.status` is `open`: both prices, and the deadline `expiresAt`.

```http
POST /api/customer/bookings/:id/price-proposal/accept
POST /api/customer/bookings/:id/price-proposal/decline
```

Both answer with the booking, in the same shape as the detail. No body.

| Status and code | Meaning |
|---|---|
| `404 BOOKING_PRICE_PROPOSAL_NOT_FOUND` | Nothing open: withdrawn, lapsed, or answered in another tab. Redraw from `GET` |
| `409 PAYMENT_BOOKING_IN_PROGRESS` | A payment is still in flight. Ask them to wait and try again |

## 3. Pay what is owed

After accepting there are two cases:

| Case | How to tell | Pay with |
|---|---|---|
| Nothing paid yet | `paymentStatus` is `unpaid` or `failed` | The existing `POST /api/bookings/:id/pay`, which now charges the agreed price |
| Already paid part | `pricing.topup` is not null | `POST /api/customer/bookings/:id/pay-balance`, same body as today |

`GET /api/customer/bookings/:id/balance` now counts a difference in `outstanding`, with a new `topupDue`.

🔴 **Show `pricing.topup.dueAt` plainly.** If it is not paid by then, the booking is cancelled automatically and what was paid is refunded. An unpaid booking has the same 24 hours, counted from when it was confirmed.

The meeting link stays locked while a difference is owed: `access.reason` is `not_paid`.

## 4. A new time with a new price

When the vendor moves an appointment, `rescheduleProposal` may now carry a price:

```json
"rescheduleProposal": { "status": "open", "proposedBy": "vendor", "startAt": "…", "price": 6000, "previousPrice": 7000 }
```

When `price` is not null, the screen must show **both the new time and the new price**: the existing accept and decline routes answer for both. If the new price is below what was paid, the difference is refunded automatically and appears in the `refund` block.

## 5. New notifications

`booking.price_proposed`, `booking.reschedule_price_proposed` and `booking.price_topup_due`, all with `aggregateType: "booking"`. None can be muted. If the inbox maps types to icons or labels, add them.
