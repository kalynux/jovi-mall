# Vendor dashboard — appointment place, access link, and moving appointments

**2026-10-26 · not deployed yet · no migration.** Plan and owner decisions:
`PRODUCTION-READINESS/APPOINTMENT-LOCATION-AND-ACCESS-PLAN.md`.

> ⚠ **One behaviour change you must handle:** `PATCH /api/vendor/bookings/:id/reschedule` now
> **proposes** a time to the customer instead of moving the booking (§ 3). Everything else is
> additive.

---

## 1. A service says where it happens, and carries its access details

On the service form, add a **Where** section and an **Access details** section. Both go inside
`serviceConfig` on create, on `PATCH /api/vendor/products/:productId/variants/:variantId` and on
`PATCH …/variants/:variantId/service/config`:

```json
"location": { "kind": "vendor_address", "vendorAddressId": "<one of the profile's business_addresses[]._id>" },
"access": {
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "instructions": "Ring the second bell. Bring your ID.",
  "revealMinutesBefore": 30
}
```

| Field | Rule |
|---|---|
| `location.kind` | `vendor_address` · `customer_address` · `online`, one per service. With `vendor_address` you must send `vendorAddressId`, a picker over the profile's business addresses. `customer_address` means you go to the customer, who picks their address when booking. |
| `access.meetingUrl` | `https://` only, max 500. `null`/`""` clears it. Typical for `online`, allowed for any kind. |
| `access.instructions` | Plain text, max 2 000. `null`/`""` clears it. Rendered as text, never HTML. |
| `access.revealMinutesBefore` | 0–1440 (default 30): how long before the start the customer may see the link and instructions. |

- `location` is replaced whole when sent and kept when omitted. `access` fields are merged one by one.
- An address not on the profile → `422 CATALOG_PRODUCT_SERVICE_LOCATION_ADDRESS_MISSING`. The same
  code blocks **publishing** if that address is later deleted from the profile. Surface it next to
  the Where section.
- Services created before this change have no `location` and keep selling. Prompt the vendor to
  set one.
- The access details are **private**: they never appear on the public product page, which shows
  only `service.locationKind`.

## 2. One booking's link can differ

```http
PATCH /api/vendor/bookings/:id/access
{ "meetingUrl": "https://zoom.us/j/123", "instructions": null, "revealMinutesBefore": 15 }
```

Changes this booking only (meeting tools that make a link per session). Same field rules as
above, at least one field. `409 BOOKING_ACCESS_NOT_EDITABLE` once the booking is cancelled,
completed or a no-show.

Your booking reads (`GET /api/vendor/bookings`, `…/:id`) now carry the booking's own copy:
`location` (`{ kind, label, addressLine1, addressLine2, city, state, country, formattedAddress,
coordinates, sourceAddressId }` or `null`) and `access` (`{ instructions, meetingUrl,
revealMinutesBefore }` or `null`) — in full, always. Show the customer's address prominently on a
`customer_address` booking: that is where you are going.

What the **customer** sees: the address once you confirm; the link and instructions only from
`revealMinutesBefore` before the start until one hour after the end, and only when the booking is
confirmed **and paid** (online, or cash you marked as paid). Worth one line of help text on the
form, because "the customer can't see my link" will otherwise be reported as a bug.

## 3. 🔴 Moving an appointment is a proposal now

`PATCH /api/vendor/bookings/:id/reschedule` (same request, same hold) **no longer moves the
booking**. The response is the booking with its time unchanged and:

```json
"rescheduleProposal": {
  "status": "open", "proposedBy": "vendor",
  "startAt": "…", "endAt": "…", "previousStartAt": "…", "previousEndAt": "…",
  "proposedAt": "…", "expiresAt": "…", "answeredAt": null
}
```

- Show **"Waiting for the customer to accept"** with the proposed time, and a **Withdraw** button:
  `DELETE /api/vendor/bookings/:id/reschedule-proposal`.
- The customer accepts (the booking moves) or declines (the original time stays, and they may
  cancel with a **full refund regardless of your cancellation policy**, refund fees on you). You
  get `booking.reschedule_accepted` / `booking.reschedule_declined`.
- No answer by `expiresAt` → it lapses and the original time stands. `status` then reads
  `lapsed`; no notification is sent.
- While one is open: a second move → `409 BOOKING_PROPOSAL_PENDING`.
- The success toast must not say "moved". The response `message` is now
  `"New time proposed — the customer will accept or decline it"`.

### 3b. 🆕 2026-10-27 — moving an appointment that spans several slots

Customers can now book several consecutive slots as one appointment (2 × 1 h = 2 h). No single
slot from `GET /availability` has that length, so moving one used to fail
`400 BOOKING_INVALID_SLOT_ID` / `length_changed`. Both move routes now take a run:

```http
POST  /api/vendor/bookings/:id/slot-hold     { "slotIds":    ["slot_…", "slot_…"] }
PATCH /api/vendor/bookings/:id/reschedule    { "newSlotIds": ["slot_…", "slot_…"] }
```

- **Slots needed** = `(booking.endAt − booking.startAt) ÷ (slot.end − slot.start)` of any slot
  `GET /availability` returns (each is one `durationMinutes` long). One → the old
  `slotId` / `newSlotId` (unchanged). More → let the vendor pick a **start**, then take that many
  consecutive slots from the grid and send them in time order. Off-hours times: build each id as
  today (`slot_{startMs}_{endMs}_shop`).
- Hold first (one `slot-hold` call holds the whole run, or the storefront lock route once per
  slot), then move with **the same list**.
- New refusals: `400 BOOKING_INVALID_SLOT_ID` with `details.reason` `not_contiguous` (gap or
  wrong order) or `slot_count` (more than 8 slots); `422 BOOKING_MULTI_SLOT_NOT_SUPPORTED` (a class
  service, always one slot). `409 BOOKING_SLOT_LOCKED` on a run names the busy slot in
  `details.slotId`, and nothing of the run stays held.
- The hold response gains `slotIds`. The move is still a proposal (§ 3); `rescheduleProposal`
  covers the whole run.

## 4. Customers moving appointments

- **`calendar` / `capacity` services:** a customer's move applies at once (unchanged), and you are
  **now notified**: `booking.rescheduled`, with both times.
- **`manual` services** (you approve each booking): a customer's move is a **request**:
  `rescheduleProposal.proposedBy: "customer"`, `status: "open"`, notification
  `booking.reschedule_requested`. Answer with:

```http
POST /api/vendor/bookings/:id/reschedule-proposal/accept    → the booking moves
POST /api/vendor/bookings/:id/reschedule-proposal/decline   → the original time stays
```

Errors: `404 BOOKING_PROPOSAL_NOT_FOUND` (nothing open / lapsed), `403 BOOKING_PROPOSAL_NOT_YOURS`.

## 5. Notifications

Four new types on `GET /api/vendor/notifications` (`type`), all `aggregateType: "booking"`, each
with a "View booking" action to `bookings/{bookingId}`: `booking.rescheduled` ·
`booking.reschedule_requested` · `booking.reschedule_accepted` · `booking.reschedule_declined`.

One new preference toggle covers all four: `preferences.bookingRescheduled` (default on), on
`GET`/`PATCH` of the notification preferences. ⚠ They are delivered in-app, by push, email and
Telegram. On WhatsApp they go out only inside the 24-hour conversation window until their message
templates are approved by Meta.

## 6. Your 2026-10-26 request (services list, amounts, notes, calendar)

- **Services list:** `GET /api/vendor/products?type=service` rows carry
  `service: { price, currency, durationMinutes, bookingMode, maxBookings }`, exactly the shape you
  asked for. It is `null` on a draft with no default variant, and absent on physical/digital rows.
  One batched read per page. See [products.md](./products.md) § List.
- **Amounts are whole XAF.** `priceSnapshot`, `settlement.finalPrice` / `balanceDue` /
  `balancePaid` / `creditDue` and the `fixedPrice` you send are all whole XAF (5000 = 5 000 XAF).
  Nothing on the server converts them. The docs that said "smallest unit" are corrected.
- **Customer note:** `metadata.notes` on the detail read, trimmed, at most 500 characters. It is
  now validated on `POST /api/products/:id/book` (`400 VALIDATION_ERROR` above 500), and it
  appears in the Google Calendar event on a new booking, on confirm, on a reschedule and on a
  payment change. A capacity class's shared event lists every customer with their booking
  number and note, and a payment change on one seat no longer rewrites the class event.
- **Old calendar events** are rewritten once by `npm run calendar:rewrite-booking-events -- --apply`
  (run by the owner after deploy; upcoming pending/confirmed bookings only).
- **Unchanged, as you asked:** `id` (not `_id`), `productId { id, title, type }`,
  `userId { _id, login_email }` (+ `login_phone` on the detail), `bookingNumber`, `metadata`, the
  money and status fields, and the calendar view shape. Documented in [bookings.md](./bookings.md).

## Contract pages

[bookings.md](./bookings.md) (§ Hold Any Time, § Reschedule, § Answer or withdraw, § Edit access) ·
[variants.md](./variants.md) (`serviceConfig.location` / `access`).
