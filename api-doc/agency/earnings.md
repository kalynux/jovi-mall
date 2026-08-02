# Agency Earnings

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`GET /api/agency/earnings`](#earnings) — this agency's held (pending) vs withdrawable (available) delivery-fee balance
- [`POST /api/agency/earnings/payout`](#requesting-a-payout) — request a payout of the entire available balance
- [`GET /api/agency/earnings/payout`](#requesting-a-payout) — your latest payout request

---

## How the delivery-fee balance is built

Every time one of this agency's shipments is part of a customer's **paid physical order**, the
agency's share of that order is computed from its own pricing policy (`policies.pricing`, set via
`PUT /api/agency/onboarding/policies` — see [profile-schema.md](./profile-schema.md)):

- If any item on the shipment is picked up from the **vendor's own address**
  (`pickupLocation.mode: "pickup_based"` in [shipment detail](./shipments.md#detail) terms), the
  agency is credited its `policies.pricing.pickup_based.base_rate_first_kg`, once per shipment.
- If any item on the shipment is already **in the agency's own storage**
  (`pickupLocation.mode: "storage_based"`), the agency is credited
  `policies.pricing.storage_based.local_delivery_fee + policies.pricing.storage_based.pick_pack_fee_per_order`,
  once per shipment.
- A shipment mixing both kinds of items (some collected from the vendor, some already warehoused)
  is credited **both** amounts — real, distinct fulfillment work happens for each.
- An order whose items are split across multiple shipments to the **same** agency earns **one entry
  per shipment** — each run is paid for separately.

> **Not yet charged (planned, in this order):** per-kg weight surcharges (`additional_per_kg`),
> out-of-region surcharges (`out_of_region_surcharge` / `out_of_region_delivery_fee`),
> peak-season surcharges, monthly per-SKU storage rent (`monthly_storage_fee_per_sku` — a
> recurring charge, not tied to a single order), and the failed-delivery fee
> (`failed_delivery_fee` — a delivery can fail and be retried, so it needs its own charge path
> rather than a slice of the delivery fee). `rto_fee` **is** now charged; see below. Do not build
> UI assuming the rest are already reflected in the balance below.

### When it lands, and why not sooner

The fee is **earned at delivery, not at payment**. When the shipment reaches `agent_delivered` the
fee is divided and held (`pending`); it moves to **available** (withdrawable) once the whole
**order** is completed and the hold window elapses.

It cannot be credited at payment time, because the fee is shared: the agent who makes the delivery
takes their contracted cut of it (`fee_split` on their contract with this agency — see
[agent-roster.md](./agent-roster.md)), and at payment nobody has been dispatched yet. So the
agency's entry is **the fee minus the agent's cut**, and the agent's own entry is the remainder.
The vendor pays the same total either way.

**If the shipment comes back** (`returned`), the run happened but the delivery did not: the agency
earns its `policies.pricing.additional_fees.rto_fee` instead of the full delivery fee (capped at
that fee), the agent takes their contracted share of *that*, and the unused remainder is returned
to the vendor.

---

## Cash-on-delivery earnings

For **COD** orders (see [cod-cash-management.md](./cod-cash-management.md)) the agency earns per
verified cash collection — one earnings entry per COD shipment at the moment the agent submits the
customer's delivery code:

- the same per-shipment delivery fee as above (pickup-based and/or storage-based components), plus
- your `policies.pricing.additional_fees.cod_handling_fee` — `percentage` of the collected amount
  (floored) or a `fixed` amount per collection.

The agent's cut is carved out of the delivery fee here too, exactly as on a prepaid order. The
`cod_handling_fee` is **not** shared — it stays whole with the agency, which is the party carrying
the cash accountability.

COD earnings differ from prepaid earnings in two ways:

1. **The trigger is the cash handoff**, not `agent_delivered` — the verified delivery code is what
   creates the entry. The hold window itself is the same: it starts when the **order** completes,
   not at collection, so every actor on an order matures together.
2. **Release is additionally gated on cash settlement**: a COD entry only moves to `available`
   once the physical cash covering it has been remitted to the platform and confirmed
   (remittances settle collections oldest-first). Held-up remittances = held-up earnings.

**Rolling reserve:** when a COD earnings entry releases, a percentage (default **10%**) parks in
the `reserve` balance for **30 days** and moves to `available` only while the agency has no open
cash discrepancies. This is the platform's security margin on cash handling.

---

<a name="earnings"></a>
### GET /api/agency/earnings

**Description**: This agency's current pending (held) and available (withdrawable) delivery-fee
balance.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "pending": 15000,
    "available": 42000,
    "reserve": 3500,
    "requested": 0,
    "currency": "XAF"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `pending` | `number` | Sum of fees from paid/collected-but-not-yet-released entries (still within the hold window, or COD cash not yet settled). Minor currency units. |
| `available` | `number` | Sum of fees whose hold window has elapsed (and, for COD, whose cash was settled). Withdrawable via a payout request (see below). Minor currency units. |
| `reserve` | `number` | COD rolling reserve: a slice of released COD earnings parked for 30 days, releasing only while the agency has no open cash discrepancies. Minor currency units. |
| `requested` | `number` | Earmarked for a pending payout request (see below). Minor currency units. |
| `currency` | `string` | Currency code for all balances. |

**Error Responses**:
- `401` – `UNAUTHORIZED` – Missing or invalid auth token.
- `403` – `FORBIDDEN` – Valid token but not an agency.

---

<a name="requesting-a-payout"></a>
## Requesting a payout

There is no self-service bank/mobile-money transfer yet. Instead, a payout request **atomically
sweeps your entire `available` balance into `requested`** and opens a `PAYOUT_REQUEST` support
ticket (visible under **Tickets**) assigned to the admin queue. An admin processes it out-of-band
(bank transfer / mobile money) and marks it paid or rejected; you're notified either way (in-app +
push — see [Notifications](./notifications.md)) and can always track progress via the linked
ticket.

- **Full balance only** — there's no partial-amount option; each request takes everything currently
  `available`.
- **Minimum 10,000 XAF** — `available` must be at least this much to request a payout
  (`EARNINGS_CONFIG.MIN_PAYOUT_AMOUNT`); below it you'll get `409 EARNINGS_PAYOUT_BELOW_MINIMUM`.
- **One request at a time** — you can't open a second request while one is still `pending`
  (`409 EARNINGS_PAYOUT_ALREADY_PENDING`).
- **A payout method must be configured first** — set one via
  `PUT /api/agency/onboarding/payout` (`payout_details`, see [profile-schema.md](./profile-schema.md))
  or you'll get `409 EARNINGS_PAYOUT_METHOD_MISSING`. The **first** payout method on file is the one
  used, and a snapshot of it is frozen onto the request at creation time — editing your payout
  details later never changes where an already-pending request is headed.
- **Rejections restore the balance** — a rejected request moves the full amount back to `available`
  immediately; the ticket records the reason.

### Automatic payout at 2,000,000 XAF

> **Show this to agencies in the UI** (e.g. near the balance/earnings screen): *"If your available
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

### POST /api/agency/earnings/payout

**Description**: Request a payout of the entire current `available` balance.

**Request Body**: none.

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "66f0a1...",
    "amount": 42000,
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
- `409` – `EARNINGS_PAYOUT_METHOD_MISSING` – No payout method configured yet.
- `409` – `EARNINGS_PAYOUT_NO_AVAILABLE_BALANCE` – `available` is `0` — nothing to request.
- `409` – `EARNINGS_PAYOUT_BELOW_MINIMUM` – `available` is below the 10,000 XAF minimum.

### GET /api/agency/earnings/payout

**Description**: Your most recent payout request (or `null` if none was ever made). This also
reflects requests the **platform** opened automatically at the balance threshold, not just ones
you requested yourself.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "id": "66f0a1...",
    "amount": 42000,
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
