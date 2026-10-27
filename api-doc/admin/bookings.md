# Admin — service bookings (`/api/internal/admin/bookings`)

> **Caller: wi-admin only.** Service-to-service, behind `requireAdminCaller`
> (`INTERNAL_ADMIN_SERVICE_TOKEN` here === `JOVI_MALL_SERVICE_TOKEN` there). No public twin, and
> there must never be one. Headers, envelope and the read-a-record / delegate-a-verdict rule:
> [internal-service-api.md](./internal-service-api.md).
>
> Design record: `../PRODUCTION-READINESS/ADMIN-BOOKINGS-PLAN.md`. Built 2026-10-27, **not deployed**.

wi-admin **reads `bookings` directly** and delegates every **write** here. None of them is a
status column: a cancellation detaches the calendar event and opens the refund request, a
completion starts the earnings hold, recording cash re-colours the calendar, and the re-check
runs the payment success or failure path. A second writer would set the field and miss every
effect.

**Authorization is decided in wi-admin before the call** (`bookings.settle`, `bookings.intervene`,
`bookings.remind`). **Nothing is audited on this side.** wi-admin audits every write fail-closed,
where the human is known. `X-Actor-Id` is still **required** on the writes that record an actor
(cancel, complete, session cancel): it becomes `actorId` on the booking's status history.

## Every write answers a thin acknowledgement

Never the booking document, which carries the customer's address, the meeting link and the raw
metadata. wi-admin re-reads its own projection after each write.

```json
{ "success": true, "data": {
  "id": "671e…", "bookingNumber": "BKG-2026-000123",
  "status": "cancelled", "paymentStatus": "refund_pending", "rescheduleProposalStatus": null
}, "message": "Booking cancelled" }
```

Bodies are `.strict()`: an unknown field is a `400`. `reason` is 3–500 characters wherever it
appears.

## The writes

| Route | Body | What it does | Refusals |
|---|---|---|---|
| `POST /:bookingId/cancel` | `{ reason, fault: 'vendor' \| 'customer' }` | Cancels from `pending`, `confirmed` **or `no-show`**, and refunds through the ordinary cancellation refund. `fault: 'vendor'` → the vendor bears the fees (customer 100% back); `'customer'` → the customer bears them. The vendor's cancellation **policy is not applied**. Customer told "cancelled by Wi-Mall support" | `409 BOOKING_ALREADY_CANCELLED`, `409 BOOKING_TERMINAL_STATE` (completed — use the refund queue, which recovers the vendor's earnings) |
| `POST /:bookingId/complete` | `{ reason }` | `confirmed` or `no-show` → `completed` at the **booked price** (no settlement). Starts the earnings hold exactly as a vendor completion does. Customer gets the ordinary "completed" message | `409 BOOKING_ADMIN_COMPLETE_UNPAID` (not paid — record cash first), `409 BOOKING_NOT_STARTED`, `400 BOOKING_INVALID_STATUS_TRANSITION` |
| `POST /:bookingId/payment/cash` | `{ reason? }` | The vendor's own `markAsPaidByCash`, for them | the vendor's own: `BOOKING_PAYMENT_NOT_REQUIRED`, `BOOKING_ALREADY_PAID`, `BOOKING_INVALID_PAYMENT_METHOD` |
| `POST /:bookingId/payment/recheck` | `{ reason? }` | For a booking at `paymentStatus: 'pending'`. Asks the provider about the newest primary attempt (`verifyPayment`, the reconciliation sweep's call), or releases the booking to `failed` when every attempt is already dead | `409 BOOKING_PAYMENT_NOT_PENDING`, `409 BOOKING_PAYMENT_STATE_MISMATCH` (provider says SUCCEEDED, booking never heard — **an engineer's job**, nothing is replayed) |
| `POST /:bookingId/proposal/withdraw` | `{ reason? }` | Withdraws the open proposal of a new time, **whichever side made it**. The original time stands. Nobody is notified | `404 BOOKING_PROPOSAL_NOT_FOUND` |
| `POST /:bookingId/reminder` | `{ reason? }` | Sends the `booking.reminder` notification again under a fresh idempotency key. The reminder carries no link | `409 BOOKING_REMINDER_NOT_APPLICABLE` (not confirmed, or already started) |
| `POST /services/:productId/sessions/cancel` | `{ startAt, reason, fault }` | Every live seat of one class (same service, same start), one `cancel` per seat. A seat that fails is **reported, not fatal** | `404 BOOKING_SESSION_EMPTY` |

The re-check answers `{ outcome, paymentStatusBefore, paymentStatusAfter, transaction }`, where
`outcome` is `settled` (the booking now reads `paid` or `failed`), `still_pending` (nothing
changed) or `released` (the last attempt had failed and the booking was stuck). The session
cancel answers `{ productId, startAt, cancelled: [{bookingId, bookingNumber}], failed: [{…, code}] }`.

⚠ **The cancel refund has no second administrator**, the same as a customer's own cancellation.
The 2,000,000 four-eyes line lives on the refund queue, not here.

## The two verdict reads

| Route | Answers |
|---|---|
| `GET /:bookingId/access-state` | `computeAppointmentAccess` without the link and instructions: `{ state: open\|locked\|closed, reason: not_confirmed\|not_paid\|too_early\|ended\|null, opensAt, closesAt, hasInstructions, hasMeetingUrl, revealMinutesBefore }`, or `null` when the booking carries no access details |
| `GET /services/:productId/availability?from&to` | The storefront's slot list, unchanged: `{ productId, from, to, slots[] }`. At most 31 days. Answers the storefront's own `404` for a service that is not bookable |

## The status history

Since 2026-10-27 every booking keeps `statusHistory[]` — `{ from, to, at, actorRole:
customer|vendor|admin|system, actorId, reason }`, oldest first — written through one function
(`applyStatusChange`) by every path that changes a status. Bookings created before that day have
none ("not recorded", never "nothing happened").

⛔ It is an administrators' record: **never serialised** to a customer (`toCustomerBookingShape`
strips it) or a vendor (the booking model's `toJSON` drops it). No customer or vendor response
changed shape. The cancel `reason`, by contrast, becomes `cancelledReason`, which both parties read.

## A paid no-show (owner decision, 2026-10-27)

A vendor marking a **paid** booking `no-show` releases nothing: its earnings stay held with no
release date. An administrator decides, with `complete` (the vendor is paid after the hold) or
`cancel` (the customer is refunded). Only an administrator may move `no-show → completed`.
