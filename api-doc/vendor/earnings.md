# Vendor Earnings

## Base Path

```
/api/vendor
```

## Authentication

**Authorization**: Vendor access required. Bearer token with `vendor` role.

## Endpoints

- [`GET /api/vendor/earnings`](#earnings) — this vendor's held (pending) vs withdrawable (available) balance
- [`POST /api/vendor/earnings/payout`](#requesting-a-payout) — request a payout of the entire available balance
- [`GET /api/vendor/earnings/payout`](#requesting-a-payout) — your latest payout request

For the itemized history behind these numbers (per-order/per-collection hold and release rows),
see the unified feed: [**Vendor Transactions API**](./transactions.md) with `?category=earning`.
This page covers the balance endpoints and how the numbers are computed.

---

## How the balance is built

Every **paid physical order**, **paid digital order**, **booking**, and **COD cash collection** is
split at the moment it's confirmed paid/collected into your **net** share, held in escrow
immediately:

- **Orders**: `net = gross − platform commission − agency delivery fee(s)`. The commission percent
  is a snapshot of your **current pricing plan**'s `commission_percent` at the moment of the split
  (see [billing-overview.md](./billing-overview.md) for plan rates) — a later plan change never
  retroactively changes an already-split order. Physical orders also subtract each fulfilling
  agency's delivery fee for its shipment(s) on that order (see
  [agency/earnings.md](../agency/earnings.md) for how that fee is computed); digital orders and
  bookings have no delivery agency, so only commission is subtracted.
- **COD collections**: same formula, but per **verified cash collection** (one per COD shipment),
  and additionally subtracts the fulfilling agency's `cod_handling_fee` for that collection. See
  [orders.md — Cash-on-delivery orders](./orders.md).

If the order/booking is refunded/cancelled while the allocation is still `pending` (never
released), the held amount is reversed and never counted — cleanly removed from `pending`, no
impact on `available`. **A refund issued after the money has already moved to `available` is not
automatically clawed back** — that reversal is a manual/admin operation.

### Hold timing (prepaid orders & bookings)

1. Money is held (`pending`) the instant the order/booking is paid.
2. It becomes eligible to start the withdrawal countdown once the order is **completed** — the
   customer confirms delivery/satisfaction, or, failing that, the platform **auto-confirms** it
   **7 days** after it reaches `delivered`/`fulfilled` (`EARNINGS_AUTO_CONFIRM_DAYS`, default 7).
3. From that completion moment, a further **7-day hold window** runs (`EARNINGS_HOLD_DAYS`,
   default 7). A daily sweep moves matured holds from `pending` to `available`.

### Hold timing (COD collections)

The verified delivery code **is** the completion event, so there's no separate customer
confirmation step — the 7-day hold window starts immediately at collection. However, release is
**additionally gated on cash settlement**: your net only becomes `available` once the agency has
remitted and the platform has confirmed the physical cash for that collection (remittances settle
oldest-first). A slow remittance chain delays your `available` balance the same way it delays the
agency's.

### `reserve`

Always `0` for vendors today — the rolling-reserve mechanism (a security margin held back after
release) applies only to **agencies**, against COD cash-handling risk. The field is present in the
response for shape-parity with the agency endpoint; don't build vendor UI around it changing.

### `requested`

Money earmarked for an in-flight payout request (see [Requesting a payout](#requesting-a-payout)
below). Moves out of `available` the instant a request is created and either leaves for good once
an admin marks it paid, or returns to `available` if the admin rejects it.

---

<a name="earnings"></a>
### GET /api/vendor/earnings

**Description**: This vendor's current pending (held) and available (withdrawable) balance.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "pending": 32000,
    "available": 118500,
    "reserve": 0,
    "requested": 0,
    "currency": "XAF"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `pending` | `number` | Sum of net shares from paid/collected-but-not-yet-released sources (still within the completion/hold window, or COD cash not yet settled). Minor currency units. |
| `available` | `number` | Sum of net shares whose hold window has elapsed (and, for COD, whose cash was settled). Withdrawable via a payout request (see below). Minor currency units. |
| `reserve` | `number` | Always `0` for vendors (see above). Minor currency units. |
| `requested` | `number` | Earmarked for a pending payout request (see below). Minor currency units. |
| `currency` | `string` | Currency code for all balances. |

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid auth token.
- `403` – `FORBIDDEN` – Valid token but not a vendor.

---

<a name="requesting-a-payout"></a>
## Requesting a payout

There is no self-service bank/mobile-money transfer yet. Instead, a payout request **atomically
sweeps your entire `available` balance into `requested`** and opens a `PAYOUT_REQUEST` support
ticket (visible under **Tickets**) assigned to the admin queue. An admin processes it out-of-band
(bank transfer / mobile money) and marks it paid or rejected; you're notified either way (in-app +
your configured secondary channel — see [Notifications](./notifications.md), event
`payoutUpdates`) and can always track progress via the linked ticket.

- **Full balance only** — there's no partial-amount option; each request takes everything currently
  `available`.
- **Minimum 10,000 XAF** — `available` must be at least this much to request a payout
  (`EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT`); below it you'll get `409 EARNINGS_PAYOUT_BELOW_MINIMUM`.
- **One request at a time** — you can't open a second request while one is still `pending`
  (`409 EARNINGS_PAYOUT_ALREADY_PENDING`).
- **A payout method must be configured first** — add one via
  `PUT /api/vendor/profile` (`payout_details`, see [Profile](./profile.md)) or you'll get
  `409 EARNINGS_PAYOUT_METHOD_MISSING`. The **first** payout method on file is the one used, and a
  snapshot of it is frozen onto the request at creation time — editing your payout details later
  never changes where an already-pending request is headed.
- **Rejections restore the balance** — a rejected request moves the full amount back to `available`
  immediately; the ticket records the reason.

### Automatic payout at 2,000,000 XAF

> **Show this to vendors in the UI** (e.g. near the balance/earnings screen): *"If your available
> balance reaches XAF 2,000,000, we automatically request a payout on your behalf so your funds
> don't sit unclaimed. Make sure you have a payout method saved — otherwise the automatic request
> can't be created and your balance will keep growing past the threshold until you add one."*

You do **not** need to call `POST .../earnings/payout` yourself once `available` reaches
`EARNINGS_CONFIG.AUTO_PAYOUT_THRESHOLD` (default **2,000,000 XAF**) — a daily platform sweep opens
the request for you automatically, using the exact same ticket + notification flow as a manual
request (including the "one request at a time" rule: if one is already pending, the sweep just
waits). The only failure mode is having **no payout method configured** — the sweep logs it and
tries again the next day, so your balance can keep climbing past the threshold until you add one.
Check `origin` on the request (see below) to tell manual (`"manual"`) from automatic
(`"auto_threshold"`) requests apart.

<a name="post-payout"></a>
### POST /api/vendor/earnings/payout

**Description**: Request a payout of the entire current `available` balance.

**Request Body**: none.

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "66f0a1...",
    "amount": 118500,
    "currency": "XAF",
    "status": "pending",
    "origin": "manual",
    "ticketId": "66f0a2...",
    "createdAt": "2026-07-14T10:00:00.000Z"
  },
  "message": "Payout request created. Track its progress under Tickets."
}
```

**Error Responses**:
- `401` – `UNAUTHORIZED` / `403` – `FORBIDDEN`
- `409` – `EARNINGS_PAYOUT_ALREADY_PENDING` – A request is already pending.
- `409` – `EARNINGS_PAYOUT_METHOD_MISSING` – No payout method configured on the profile yet.
- `409` – `EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE` – `available` is `0` — nothing to request.
- `409` – `EARNINGS_PAYOUT_BELOW_MINIMUM` – `available` is below the 10,000 XAF minimum.

<a name="get-payout"></a>
### GET /api/vendor/earnings/payout

**Description**: Your most recent payout request (or `null` if none was ever made). This also
reflects requests the **platform** opened automatically at the balance threshold, not just ones
you requested yourself.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "66f0a1...",
    "amount": 118500,
    "currency": "XAF",
    "status": "paid",
    "origin": "auto_threshold",
    "ticketId": "66f0a2...",
    "rejectionReason": null,
    "createdAt": "2026-07-14T10:00:00.000Z",
    "resolvedAt": "2026-07-15T09:00:00.000Z"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `string` | `pending` \| `paid` \| `rejected`. |
| `origin` | `string` | `manual` (you requested it) or `auto_threshold` (the platform opened it automatically because `available` reached the threshold). |
| `ticketId` | `string` | The linked `PAYOUT_REQUEST` ticket — open it under Tickets for the full conversation/history. |
| `rejectionReason` | `string \| null` | Set when `status` is `rejected`. |
| `resolvedAt` | `string \| null` | When an admin marked it paid/rejected; `null` while `pending`. |
