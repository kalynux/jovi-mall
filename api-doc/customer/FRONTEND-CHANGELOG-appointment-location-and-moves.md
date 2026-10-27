# Shop (signed-in customer) — where an appointment happens, its link, and moving it

**2026-10-26 · not deployed yet · additive, no migration.** Plan and owner decisions:
`PRODUCTION-READINESS/APPOINTMENT-LOCATION-AND-ACCESS-PLAN.md`. Contract:
[bookings.md](./bookings.md).

---

## 1. The product page says where

`GET /api/public/stores/:storeSlug/products/:productSlug` → `variants[].service.locationKind`:
`vendor_address` ("At the shop") · `customer_address` ("They come to you") · `online` · `null`
(not specified). Show it near the price. No address is public.

## 2. Booking a service the vendor travels to

When `locationKind` is `customer_address`, the booking step must ask **which saved address**, and
send it:

```http
POST /api/products/:productId/book
{ "slotId": "…", "addressId": "<saved_addresses[]._id>" }
```

Do not pre-select the default: the vendor will go there. No saved address → send the customer
to add one first. Missing → `422 BOOKING_ADDRESS_REQUIRED`; not theirs → `404
BOOKING_ADDRESS_NOT_FOUND`; the vendor removed their own address → `422
BOOKING_LOCATION_UNAVAILABLE` ("can't be booked right now").

⚠ The `/book` response's `booking` is now the same customer shape as `GET /api/customer/bookings/:id`
(it used to be the raw document).

## 3. The booking page: place and access

Every booking read carries `location`, `access` and `rescheduleProposal` (full shapes in
[bookings.md](./bookings.md#managing-your-bookings)).

- **Place.** `location.addressVisible` → show the address (with a map link from `coordinates`).
  When it is `false` on a `vendor_address` booking, say "The address appears once the vendor
  confirms". `online` → "Online session".
- **Access.** Only an `access.state === "open"` block contains `meetingUrl` / `instructions`.
  Render the link as a big **Join** button.
  - `locked` + `too_early` → "Your link will appear at {opensAt}" with a countdown, then re-fetch
    the booking. Nothing is pushed: the server decides on each read.
  - `locked` + `not_paid` → "Pay to unlock the link and instructions". The customer sees this
    even near the start time.
  - `locked` + `not_confirmed` → "Available once the vendor confirms".
  - `closed` → hide the block (the appointment ended or was cancelled).
  - `hasMeetingUrl` / `hasInstructions` let you say what is coming before it is open.

## 4. 🔴 Moving an appointment (fixes "no time available" too)

- ⚠ **Bug to fix first:** the reschedule page builds the availability URL from
  `booking.productId`, which this read returns **populated** (`{ id, title, type }`). The URL
  became `/api/products/[object Object]/availability`, the 404 was swallowed, and every customer
  saw "no time available". Use `booking.productId.id` when it is an object.
- The vendor's moves are now **proposals**: `rescheduleProposal` `{ status: "open", proposedBy:
  "vendor", startAt, endAt, previousStartAt, expiresAt }`. Show both times with **Accept** and
  **Decline**:

```http
POST /api/customer/bookings/:id/reschedule-proposal/accept
POST /api/customer/bookings/:id/reschedule-proposal/decline
```

  Next to Decline, tell the customer that declining lets them **cancel with a full refund**.
  After a decline, the normal cancel (`POST …/cancel`) skips the vendor's cancellation policy and
  refunds 100%. With no answer by `expiresAt` the original time stays (`status: "lapsed"`).
- The customer's own move on a service the vendor approves by hand (`manual`) is now a
  **request**: `PATCH …/reschedule` returns the booking with its time **unchanged** and
  `rescheduleProposal.proposedBy: "customer"`, with message `"New time requested — the vendor will
  accept or decline it"`. Show "Waiting for the vendor" and a **Withdraw** button
  (`DELETE /api/customer/bookings/:id/reschedule-proposal`). On other services the move applies
  at once, as before.
- While a proposal is open, another move → `409 BOOKING_PROPOSAL_PENDING`.

## 5. Notifications

Two new customer types (in the notification list and the `bookingUpdates` preference):
`booking.reschedule_proposed` (the vendor asks to move it) and `booking.reschedule_declined`
(the vendor declined the customer's request). An accepted move arrives as the existing
`booking.rescheduled`. Both new ones link to the booking.
