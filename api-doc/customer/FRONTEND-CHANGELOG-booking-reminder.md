# Frontend changelog: remind the vendor about an appointment (2026-11-03)

**For: the storefront's signed-in account pages.** Endpoint reference: [bookings.md](./bookings.md).

## What to add

A **Remind the provider** button on a booking.

```http
POST /api/customer/bookings/:id/reminder
```

No body. The platform writes the message, so there is no text box.

```json
{
  "success": true,
  "data": { "reminder": { "canSend": false, "sentAt": "2026-11-03T14:00:00.000Z", "receivedAt": null } },
  "message": "Reminder sent to the vendor"
}
```

## When to show it

Every customer booking read now carries this block. Use `canSend` rather than working the rule out on the client.

```json
"reminder": { "canSend": true, "sentAt": null, "receivedAt": null }
```

| Field | Meaning | What to draw |
|---|---|---|
| `canSend` | Confirmed, not started, and the customer has not used theirs | The button, enabled |
| `sentAt` | When the customer sent theirs | "Reminder sent" with the date, in place of the button |
| `receivedAt` | When the vendor sent theirs | Optional: "The provider sent you a reminder" |

Each booking allows one reminder, and it cannot be taken back, so the button should say so ("You can send one reminder").

## Refusals

| Status and code | Meaning |
|---|---|
| `409 BOOKING_REMINDER_ALREADY_SENT` | Already sent, perhaps in another tab. `details.sentAt` has when. Redraw from `GET` |
| `409 BOOKING_REMINDER_NOT_APPLICABLE` | The booking changed since the page loaded. Redraw from `GET` |
| `404 BOOKING_NOT_FOUND` | Not this customer's booking |

## Also changed

Reminders now read correctly. They used to print the time as a raw system date in UTC, and an appointment days away could read "tomorrow". No client change is needed.

A vendor's reminder reaches a customer even with the `bookingReminders` preference off. If the settings screen describes that switch, it controls the **automatic** reminder.
