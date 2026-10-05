# Customer Notifications API

**Verified against source on 2026-09-08** — all six routes, the list query schema (including the `ticket` aggregate type) and the notification document shape, against `src/modules/notifications/` (routes, controller, `models/customer-notification.model.ts`).

The customer's notification inbox and channel preferences. This is the **fourth** multi-channel notification stack on the platform, alongside vendor, agency and agent — customers previously received nothing at all except the COD delivery code.

> [!NOTE]
> Bookings are covered in [bookings.md](./bookings.md); orders in [orders.md](./orders.md).

---

## How delivery works

Every notification produces an **in-app record** — that is the durable one, and it is always written. On top of that:

| Channel | When it is used |
|---|---|
| **In-app** | Always. Never configurable. |
| **Push (FCM)** | Always, to every device the customer has registered. Best-effort. |
| **Email / Telegram / WhatsApp** | **At most one**, chosen by the customer, and only once that channel is verified. |

Enabling one secondary channel automatically disables the other two. Priority when resolving: telegram → email → whatsapp.

**One exception: a checkout placed from a chat is answered in that chat.** `order.payment.received` and `order.payment_failed` for a basket checked out on WhatsApp or Telegram (the chat checkout, its screen or its form) go to **that** chat, in place of the channel chosen above — while the account is still linked there. The payment's result is the answer to something the customer did in that conversation, and the chat has just told them it will arrive there. The channel's own on/off switch does not apply to it; muting a notification group still does (and money situations have none). In-app and push are unchanged. *(2026-09-22: a WhatsApp order's "payment received" had gone to the customer's Telegram.)*

Copy is rendered in the customer's language (`customer.preferences.language`), in **en · fr · pt · es · ar**. Times are formatted in the customer's own `timezone`.

---

## What can and cannot be switched off

Preferences gate **progress reporting only**. Two groups always send, and no setting will silence them:

- **Money** — payment received, refund issued, refund pending, balance due.
- **Cancellations** — a vendor calling off an appointment or an order.

The reasoning: a customer is the *counterparty* to someone else's action here, not the owner of a dashboard. A silent refund is indistinguishable from a stolen payment, and a balance nobody was told about cannot fairly be chased.

| Preference key | Gates | Default |
|---|---|---|
| `bookingUpdates` | booking created · confirmed · rescheduled · completed | `true` |
| `bookingReminders` | the pre-appointment reminder | `true` |
| `cartReminders` | the abandoned-basket reminder (`cart.abandoned`) — added 2026-09-27; a preference document written before then has no value and reads as `true` | `true` |
| `orderUpdates` | order created · shipped · out for delivery · delivered · delivery failed | `true` |
| `marketing` | nothing yet — reserved so a future campaign cannot be bolted onto `orderUpdates` | **`false`** |

---

## Endpoints

All require a Bearer token with the **customer** role, and are scoped to the caller.

### List notifications

```http
GET /api/customer/notifications
```

| Query | Type | Description |
|---|---|---|
| `page` | number | Default `1` |
| `limit` | number | Default `20`, max `100` |
| `unreadOnly` | `'true'` \| `'false'` | Only unread rows |
| `aggregateType` | `booking` \| `order` \| `shipment` \| `payment` \| `ticket` | Narrow to one subject area. **`ticket` was added by GAP-012** and this row omitted it — a customer receiving ticket notifications had no way to filter to them. |

**Response:** `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "_id": "507f1f77bcf86cd799439011",
      "type": "booking.reminder",
      "title": "Reminder: Haircut tomorrow",
      "message": "Your Haircut booking with Salon A is tomorrow (2026-08-10 14:00). If you cannot make it, please cancel so the slot can go to someone else.",
      "aggregateType": "booking",
      "aggregateId": "507f1f77bcf86cd799439022",
      "action": { "label": "View booking", "path": "bookings/507f...", "url": "https://shop.example/bookings/507f..." },
      "deliveredVia": ["in-app", "push", "email"],
      "isRead": false,
      "readAt": null,
      "createdAt": "2026-08-09T13:00:00.000Z"
    }
  ],
  "meta": { "total": 42, "page": 1, "limit": 20, "pages": 3, "unreadCount": 5 }
}
```

### Unread count

```http
GET /api/customer/notifications/unread-count
```

Returns `{ "success": true, "data": { "unreadCount": 5 } }`. Use this for a badge rather than fetching a page of rows to render one integer.

> ⚠ **`action` is OMITTED, not `null`, when a notification has nowhere to go**
> (`default: undefined` on the sub-schema). Test for the key before reading `action.label`.
> When present, `label` and `path` are always set; `url` is optional.

### Get preferences

```http
GET /api/customer/notifications/preferences
```

Creates defaults on first read. The `emailVerified` / `telegramVerified` / `whatsappVerified` flags are computed **live** from the customer record and telegram link — the stored values are a cache and are not authoritative.

### Update preferences

```http
PATCH /api/customer/notifications/preferences
```

```json
{
  "emailEnabled": true,
  "preferences": { "bookingReminders": false }
}
```

Enabling an **unverified** channel returns `400 CUSTOMER_NOTIFICATION_CHANNEL_NOT_VERIFIED` rather than silently accepting it — an enabled channel that delivers nothing reads as the platform being broken.

### Mark read

```http
PATCH /api/customer/notifications/:id/read
PATCH /api/customer/notifications/read-all
```

---

## Situations

### Bookings

| Type | Sent when | Mutable |
|---|---|---|
| `booking.created` | The booking is placed. Says whether it is confirmed or awaiting the vendor. | `bookingUpdates` |
| `booking.confirmed` | The vendor accepted a `manual` booking. | `bookingUpdates` |
| `booking.rescheduled` | Moved to a new time. Carries **both** the old and new times. | `bookingUpdates` |
| `booking.cancelled` | Called off. Names who did it and where the money went, in one message. | **No** |
| `booking.completed` | The appointment happened and was settled. | `bookingUpdates` |
| `booking.reminder` | ~24h before `startAt`, from the reminder sweep. | `bookingReminders` |
| `booking.payment.received` | Payment succeeded. | **No** |
| `booking.balance.due` | The service cost more than quoted and a balance is payable. | **No** |
| `booking.refunded` | A **card** refund completed — the full amount, back to the card, no fee. Raised from `payment.refunded` (🆕 2026-10-05: nothing raised it before). | **No** |
| `booking.refund.pending` | Legacy — no longer raised (2026-10-05). A booking awaiting a refund now gets `booking.refund.requested`. Kept for existing inbox rows. | **No** |
| `booking.refund.requested` | 🆕 A refund was requested and is under review (started by the vendor, the platform or an administrator — not by Support answering the customer's own ticket). | **No** |
| `booking.refund.sending` | 🆕 A mobile-money transfer is on its way to the masked number, with the fee line (*"You receive 4,900 XAF (5,000 minus a 2% transfer fee)."*). | **No** |
| `booking.refund.completed` | 🆕 The transfer arrived — net amount + fee line. | **No** |
| `booking.refund.paid_externally` | 🆕 The team paid it outside the app (proof on file) — net amount + fee line. | **No** |
| `booking.refund.declined` | 🆕 The request was declined after review. The administrator's reason is never quoted. | **No** |

### Orders

| Type | Sent when | Mutable |
|---|---|---|
| `order.created` | The order is placed. | `orderUpdates` |
| `order.payment.received` | Payment succeeded. | **No** |
| `order.shipped` | The parcel left the vendor/depot (`picked_up`). | `orderUpdates` |
| `order.out_for_delivery` | An agent is carrying it (`in_transit`). | `orderUpdates` |
| `order.delivered` | Delivered. | `orderUpdates` |
| `order.delivery_failed` | An attempt failed. | `orderUpdates` |
| `order.cancelled` | Cancelled. | **No** |
| `order.refunded` | A **card** refund completed (or a legacy event with no channel) — once per completed refund, so two partial refunds are two messages, each naming its own amount; full amount, **no fee**. Raised from `payment.refunded` (it had no trigger before 2026-09-27). | **No** |
| `order.refund.requested` | 🆕 2026-10-05 · A refund was requested and is under review (vendor-, platform- or admin-started; not Support answering the customer's own ticket). | **No** |
| `order.refund.waiting_for_cash` | 🆕 **COD** · Approved; the cash the customer paid has not reached the platform from the delivery company yet — it sends by itself when it does. | **No** |
| `order.refund.sending` | 🆕 A mobile-money transfer is on its way to the masked number, with the fee line (*"You receive 4,900 XAF (5,000 minus a 2% transfer fee)."*). | **No** |
| `order.refund.completed` | 🆕 The transfer arrived — net amount + fee line. | **No** |
| `order.refund.paid_externally` | 🆕 The team paid it outside the app (proof on file) — net amount + fee line. | **No** |
| `order.refund.declined` | 🆕 The request was declined after review. The administrator's reason is never quoted. | **No** |

> **Refund messages (2026-10-05).** One message per refund request per step, keyed on the request, so a retried transfer does not tell the customer twice. A transfer that **fails** is never announced — the team retries it or pays it by hand, and the customer is still owed the money. The new WhatsApp templates (`customer_order_refund_*`, `customer_booking_refund_*`) are generated but **not yet approved by Meta**: until they are, an out-of-window WhatsApp send fails and the customer still gets the in-app row, push, and email/Telegram. All deep links are the existing order / booking pages.

### The basket

| Type | Sent when | Mutable |
|---|---|---|
| `cart.abandoned` | A basket with at least one buyable line, belonging to a customer with a chat connection, untouched for `CART_REMINDER_LEAD_MINUTES` (12 h). Swept, once per basket **state**: adding to it and leaving again reminds again. Names what is in it — **never a price**. `aggregateType: "cart"`. ⚠ **Off by default** (`CART_REMINDER_ENABLED`). ⚠ **No WhatsApp template exists for it, by decision**: outside the customer's 24-hour window it sends no WhatsApp message at all; the in-app row and Telegram still go. | `cartReminders` |

> Only **four** shipment statuses reach the customer. `assigned`, `handing_over` and the rest are internal logistics; forwarding them would train people to ignore the channel that matters.

**Delivery messages carry the detail that makes them useful:**

- `order.shipped` prints the real tracking number.
- `order.out_for_delivery` tells COD customers to have the cash ready, with the amount still owed — a partially-paid COD order quotes what remains, not the full total. Prepaid orders get no cash sentence at all.
- `order.delivery_failed` explains why, in the customer's language. The agent's operational reason is rephrased for the person who was waiting in, and never accuses them: `customer_refused` reads "the delivery was declined at the door", not "you refused it". A reason-less report still gets a complete sentence. The agent's free-text `note` is internal and is **never** shown.

---

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `STOREFRONT_URL` | Base URL for deep links in notifications. Unset ⇒ actions carry a relative `path` and no `url`. | — |
| `BOOKING_REMINDER_ENABLED` | Set `false` to stop the reminder sweep. | `true` |
| `BOOKING_REMINDER_LEAD_MINUTES` | How far ahead of `startAt` to remind. | `1440` (24h) |
| `BOOKING_REMINDER_INTERVAL_MS` | Sweep cadence — also the reminder's timing granularity. | `900000` (15 min) |

WhatsApp sends use the approved templates named `customer_*` (see `template-registry.ts`). Inside Meta's 24-hour service window a free-form message is sent instead.
