# Frontend changelog: proposing a price on a manual appointment (2026-11-03)

**For: the vendor dashboard.** Endpoint reference: [bookings.md](./bookings.md#propose-a-price).

## What changes for the vendor

On a service whose mode is `manual`, the vendor can ask for a different price before approving an appointment.

- Booked at 5,000: they may propose 7,000, then 6,000, then 5,500, in any order. **Nothing at or below 5,000 is accepted**, since confirming already gets them 5,000.
- The customer accepts or declines. **Accepting confirms the appointment at once**, with nothing more for the vendor to press.
- After approval the price is fixed. It can only change together with a new time.
- Free services (price 0) cannot be proposed on.

## 1. Propose a price

Show this on a pending manual booking, when `pricing.canPropose` is true.

```http
POST /api/vendor/bookings/:id/price-proposal
{ "price": 7000 }

DELETE /api/vendor/bookings/:id/price-proposal
```

`price` is a whole number. Use `pricing.originalPrice` to tell the vendor the minimum, and validate against it before sending.

**While a proposal is `open`, hide Confirm.** The server refuses it with `409 BOOKING_PRICE_PROPOSAL_OPEN`. Offer **Withdraw** instead. After a decline, withdraw or lapse, the vendor may propose again, confirm at the current price, or cancel.

## 2. The `pricing` block

`GET /api/vendor/bookings`, `GET /api/vendor/bookings/:id` and the two routes above carry it. The other vendor booking responses do not, so re-read after them.

```json
"pricing": {
  "originalPrice": 5000,
  "currentPrice": 7000,
  "amountPaid": 5000,
  "proposal": { "status": "accepted", "amount": 7000, "previousAmount": 5000, "proposedAt": "…", "expiresAt": "…", "answeredAt": "…" },
  "topup": { "amount": 2000, "dueAt": "…" },
  "canPropose": false
}
```

| Field | What to draw |
|---|---|
| `originalPrice`, `currentPrice` | Show both when they differ. ⚠ `priceSnapshot` is now the **agreed** price, not the first quote |
| `proposal.status` | `open` "waiting for the customer" · `declined` "declined" · `accepted` · `withdrawn` · `lapsed`. Null when none was made |
| `topup` | "Customer owes 2,000 by …". The booking is cancelled automatically after that, and what was paid is refunded |
| `amountPaid` | What has really been received |

## 3. A price with a new time

Manual services only. The customer answers the time and the price together. If they decline, both stay as they were.

```http
PATCH /api/vendor/bookings/:id/reschedule
{ "newSlotId": "…", "price": 6000 }
```

`price` is optional and may go down to `originalPrice`. If the customer has already paid more, the difference is **refunded automatically with the fees charged to the vendor**, so say that on the screen before they send a lower price.

Answering a customer's request for a new time can also name a price:

```http
POST /api/vendor/bookings/:id/reschedule-proposal/accept
{ "price": 6000 }
```

With a different `price` nothing moves yet: the request becomes the vendor's proposal, and `rescheduleProposal.proposedBy` turns to `vendor`. Without one it works as before. `rescheduleProposal` now carries `price` and `previousPrice`, both null when the price is untouched.

## 4. Completing an appointment

🔴 **On a manual service, `fixedPrice` is refused** with `422 BOOKING_PRICE_LOCKED`. Hide the final-price field for these bookings. `additionalMinutes` and `actualEndAt` still work, and add only the cost of the extra time on top of the agreed price. Finishing early never lowers it.

## 5. A difference paid in cash

```http
POST /api/vendor/bookings/:id/settle-balance
```

The same route as a cash balance also records a difference. It must cover all of `pricing.topup.amount`, or it answers `400 VALIDATION_ERROR`.

## 6. Refusals

| Status and code | Meaning |
|---|---|
| `422 BOOKING_PRICE_BELOW_FLOOR` | Too low. `details.minimum` is the floor |
| `409 BOOKING_PRICE_NOT_PROPOSABLE` | `details.reason`: `not_manual` · `free` · `not_pending` · `started` · `proposal_open` · `payment_state` |
| `404 BOOKING_PRICE_PROPOSAL_NOT_FOUND` | Nothing open to withdraw |
| `409 BOOKING_PRICE_PROPOSAL_OPEN` | Withdraw the proposal before confirming |
| `422 BOOKING_PRICE_LOCKED` | A typed price at completion on a manual service |

## 7. New notifications

`booking.price_accepted` and `booking.price_declined`, both with `aggregateType: "booking"`, opening `bookings/:id`. No preference switch silences them. If the inbox maps types to icons or labels, add both.
