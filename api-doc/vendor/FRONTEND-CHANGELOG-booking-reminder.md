# Frontend changelog: remind the customer about an appointment (2026-11-03)

**For: the vendor dashboard.** Endpoint reference: [bookings.md](./bookings.md#send-a-reminder).

## What to add

A **Remind the customer** button on a booking.

```http
POST /api/vendor/bookings/:id/reminder
```

No body. The platform writes the message, so there is no text box.

```json
{
  "success": true,
  "data": { "reminder": { "canSend": false, "sentAt": "2026-11-03T14:00:00.000Z", "receivedAt": null } },
  "message": "Reminder sent to the customer"
}
```

## When to show it

`GET /api/vendor/bookings` and `GET /api/vendor/bookings/:id` now carry this block. Use `canSend` rather than working the rule out on the client. The other vendor booking responses do not carry it, so read it from those two.

```json
"reminder": { "canSend": true, "sentAt": null, "receivedAt": null }
```

| Field | Meaning | What to draw |
|---|---|---|
| `canSend` | Confirmed, not started, and the shop has not used theirs | The button, enabled |
| `sentAt` | When the shop sent theirs | "Reminder sent" with the date, in place of the button |
| `receivedAt` | When the customer sent theirs | Optional: "The customer sent you a reminder" |

Each booking allows one reminder, and it cannot be taken back, so the button should say so ("You can send one reminder").

## Refusals

| Status and code | Meaning |
|---|---|
| `409 BOOKING_REMINDER_ALREADY_SENT` | Already sent, perhaps in another tab. `details.sentAt` has when. Redraw from `GET` |
| `409 BOOKING_REMINDER_NOT_APPLICABLE` | Not confirmed, already started, or the booking has no customer account to notify |
| `404 BOOKING_NOT_FOUND` | Not this shop's booking |

## A new notification

A customer's reminder arrives as type **`booking.reminder`** with `aggregateType: "booking"`, and opens `bookings/:id`. There is no preference switch for it. If the inbox maps types to icons or labels, add this one.
