# Agent — Cash on Delivery (COD)

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

## The COD workflow, agent's view

For a cash-on-delivery order, **the agent is the payment collector**. The platform trusts events,
not claims — a COD shipment can ONLY be marked delivered by submitting the customer's **delivery
code**:

1. The agency assigns you to a COD shipment (blocked if it would push you over your cash exposure
   limit, or if your trust score is too low — see [Risk controls](#risk-controls)). **At that moment**
   the platform creates the shipment's **cash collection** (the exact amount to collect, shown as
   `cod.expectedAmount` on [shipment detail](./shipments.md#detail)) and sends the customer a 6-digit
   delivery code (WhatsApp + their app) — so the customer is holding it long before you arrive.
2. The agency marks the shipment `picked_up`, then `in_transit`. No new code is issued; the customer
   keeps the one they were sent at assignment.

   > If the agency swaps the assigned agent, the code is **not** re-issued — the customer keeps it,
   > and the collection is simply re-pointed at whoever is now delivering. If the customer has lost
   > their code, [resend it](#resend) rather than waiting.
3. On arrival, mark the shipment `agent_delivered`. For a COD shipment the response comes back with
   `requiresDeliveryCode: true` — that is the signal to ask for the code. The shipment is **not**
   delivered yet.
4. At the door: hand over the package, **collect the cash**, then ask the customer for their code.
   The customer is instructed to give it only after receiving and paying. They have had the code
   since pickup, so they can read it out the moment you arrive.
5. Submit the code via [`POST /shipments/:id/cod/collect`](#collect). One atomic operation records
   the cash, marks the shipment **delivered**, and adds the amount to your cash balance
   (you now owe it to your agency).
6. Hand the cash back — to your agency, or [straight to the platform](#declare-deposit). Either way
   [your balance](#balance) falls once the receiving party confirms. Aim to settle within the deposit
   deadline (default **2 days**) or a late-deposit flag lowers your trust score.

**There is no separate customer delivery confirmation for COD — the verified code IS the
confirmation.** So for COD:

- `agent_delivered` means "I am at the door", not "this is delivered". It is a dead end except
  through the code: a COD shipment can never be moved to `delivered` by a status change. The
  customer's own confirm-delivery endpoint **rejects COD** for the same reason.
- The one other way out is `failed` (customer absent, refuses the parcel, or will not pay).

> ### ⚠️ Leaving a shipment at `agent_delivered` means "I was paid"
>
> After **7 days** at `agent_delivered`, the platform records the cash as collected anyway — without
> a code — and the shipment becomes `delivered`. **The amount lands on your cash balance and you owe
> it**, exactly as if you had submitted a code.
>
> This exists because a customer can pay and still never produce the code (phone not to hand, or
> simply unwilling), and that should not strand everyone's money. The other half of it is your duty:
> **if you were NOT paid, move the shipment to `failed` → `returned`.** Leaving it sitting there for
> a week is treated as an assertion that you took the cash.

---

<a name="collect"></a>
### POST /api/agent/shipments/:id/cod/collect

**Description**: Submit the customer's delivery code at handoff. Atomically: records the cash
collected, marks the shipment `delivered`, updates the order's payment status
(`partially_paid`/`paid`), and raises your cash balance.

**Path Parameters**:
- `id` (string, required) — Shipment ID (must be assigned to this agent, status `picked_up` or `in_transit`).

**Request Body**:
```json
{
  "code": "847392",
  "location": { "lat": 4.0511, "lng": 9.7679 },
  "deviceInfo": "Pixel 7; app 2.4.1"
}
```
- `code` (string, required) — the 6-digit code the customer gives you.
- `location` (object, optional) — GPS fix at submission. Send it whenever available; it is stored
  as fraud-investigation evidence.
- `deviceInfo` (string, optional, ≤300 chars) — device identifier of the agent app.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "collectionId": "665f1f77bcf86cd799439300",
    "shipmentId": "507f1f77bcf86cd799439100",
    "orderId": "507f1f77bcf86cd799439010",
    "amount": 52000,
    "currency": "XAF",
    "status": "collected",
    "collectedAt": "2026-07-11T14:03:00.000Z",
    "orderPaymentStatus": "paid"
  },
  "message": "Cash collected and shipment delivered."
}
```

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` – Shipment doesn't exist or isn't assigned to this agent.
- `404` – `COD_COLLECTION_NOT_FOUND` – No collection for this shipment (not a COD shipment / not picked up).
- `409` – `COD_COLLECTION_ALREADY_COLLECTED` – Cash was already recorded for this shipment.
- `422` – `COD_COLLECTION_NOT_COLLECTIBLE` – Shipment status doesn't allow collection (e.g. already returned).
- `422` – `COD_INVALID_CODE` – Wrong code. `details.attemptsRemaining` says how many tries are left.
- `423` – `COD_CODE_ATTEMPTS_EXCEEDED` – Code locked after 5 wrong attempts — use
  [resend-code](#resend) to issue a fresh one to the customer.

---

<a name="resend"></a>
### POST /api/agent/shipments/:id/cod/resend-code

**Description**: Send the customer a **fresh** delivery code (lost code, or locked after wrong
attempts). Resets the attempt counter. Rate-limited (min 60s between sends).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": { "shipmentId": "507f1f77bcf86cd799439100", "resentAt": "2026-07-11T14:05:00.000Z" },
  "message": "A new delivery code was sent to the customer."
}
```

**Error Responses**:
- `404` – `SHIPMENT_NOT_FOUND` / `COD_COLLECTION_NOT_FOUND`.
- `429` – `COD_CODE_RESEND_TOO_SOON` – Wait `details.retryInSeconds` before retrying.

> The code is never returned to the agent — only the customer receives it (WhatsApp + their app).

---

<a name="balance"></a>
### GET /api/agent/cod/balance

**Description**: Your full COD cash position.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "cashHeld": 130000,
    "currency": "XAF",
    "currentExposure": 182000,
    "effectiveExposureLimit": 300000,
    "trustScore": 100
  }
}
```

| Field | Type | Description |
|---|---|---|
| `cashHeld` | `number` | Cash you have collected and not yet deposited with your agency. Minor units. |
| `currentExposure` | `number` | `cashHeld` + expected cash of your assigned, not-yet-collected COD shipments. |
| `effectiveExposureLimit` | `number` | Your cap after trust scaling. New COD assignments are blocked when exceeded. |
| `trustScore` | `number` | 0–100. See [Risk controls](#risk-controls). |

---

### GET /api/agent/cod/ledger

**Description**: Append-only history of your cash movements (collections up, deposits down).
Query: `page?`, `limit?`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f...",
      "entryType": "collection",
      "amount": 52000,
      "balanceAfter": 130000,
      "refType": "cash_collection",
      "refId": "665f1f77bcf86cd799439300",
      "createdAt": "2026-07-11T14:03:00.000Z"
    },
    {
      "id": "665e...",
      "entryType": "deposit",
      "amount": -78000,
      "balanceAfter": 78000,
      "refType": "agent_deposit",
      "refId": "665f1f77bcf86cd799439400",
      "createdAt": "2026-07-10T18:00:00.000Z"
    }
  ],
  "meta": { "total": 12, "page": 1, "limit": 20, "pages": 1 }
}
```

---

### GET /api/agent/cod/deposits

**Description**: Your cash hand-overs. Query: `status?` (`declared` | `confirmed` | `rejected`),
`page?`, `limit?`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439400",
      "agentId": "507f1f77bcf86cd799439101",
      "agencyId": "507f1f77bcf86cd799439099",
      "amount": 78000,
      "currency": "XAF",
      "note": "Evening cash-desk deposit",
      "recipient": "agency",
      "status": "confirmed",
      "reference": null,
      "declaredAt": "2026-07-10T17:40:00.000Z",
      "resolvedAt": "2026-07-10T18:00:00.000Z",
      "rejectionReason": null,
      "recordedAt": "2026-07-10T18:00:00.000Z"
    }
  ],
  "meta": { "total": 4, "page": 1, "limit": 20, "pages": 1 }
}
```

| Field | Description |
|---|---|
| `recipient` | `agency` (the normal route) or `platform` (you paid the platform directly). |
| `status` | `declared` = waiting on the receiver; `confirmed` = money moved; `rejected` = they say it didn't happen (see `rejectionReason`). |
| `reference` | Your transfer/receipt reference. Required for `platform` deposits. |
| `declaredAt` | When YOU declared it. `null` if the agency recorded it themselves at the desk. |

---

<a name="declare-deposit"></a>
### POST /api/agent/cod/deposits

**Description**: Declare cash you have handed back. **This moves no money by itself** — it is a
timestamped claim the receiving party has to answer. Your balance falls when they confirm.

Declaring matters even when your agency records deposits reliably: it is your evidence. While a
declaration is open it also **suspends your late-deposit penalty** for that amount — you have said,
on the record, that you handed the cash over, and the clock is now on them. If they reject it, the
clock resumes.

**Request Body**:
```json
{
  "agencyId": "507f1f77bcf86cd799439099",
  "amount": 78000,
  "recipient": "agency",
  "reference": null,
  "note": "Evening cash-desk deposit"
}
```
- `agencyId` (string, required) — the agency whose cash this is. Required even when paying the
  platform: the cash was always collected under one contract, and that is the contract it settles.
- `amount` (number, required) — minor units. Bounded by what you actually owe **this** agency.
- `recipient` (string, optional, default `agency`) — `agency`, or `platform` to bypass the agency.
- `reference` (string, required for `platform`) — bank/mobile-money/receipt id. The platform isn't
  standing there, so this is the only thing tying your claim to real money. `""` is treated as
  absent — a `platform` deposit with an empty reference still fails with
  `COD_DEPOSIT_REFERENCE_REQUIRED`.
- `note` (string, optional, ≤500 chars). `null` or `""` = no note.

**Success Response** (`201 Created`): the deposit, `status: "declared"`.

**Error Responses**:
- `404` – `AGENT_MEMBERSHIP_NOT_FOUND` – No live contract with that agency.
- `422` – `COD_DEPOSIT_INVALID_AMOUNT` – Not a positive integer.
- `422` – `COD_DEPOSIT_EXCEEDS_BALANCE` – More than the cash you hold across all agencies.
- `422` – `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` – More than you owe **this** agency.
  `details.hint` says whether the rest belongs to another agency.
- `422` – `COD_DEPOSIT_REFERENCE_REQUIRED` – `recipient: "platform"` without a `reference`.
- `422` – `COD_DEPOSIT_AGENCY_ALREADY_SETTLED` – **Direct payments only.** Your agency has already
  passed this cash to the platform out of its own pocket, so the platform is square and you owe the
  **agency**, not the platform. `details.agencyOwesPlatform` is the most the platform can still take
  directly; pay that much and the rest to your agency.

> ### Paying the platform directly
>
> `recipient: "platform"` settles both legs at once — your balance AND your agency's debt to the
> platform. Use it when your agency is unresponsive, disputes your hand-overs, or you simply can't
> reach their cash desk. It needs no permission from the agency, but they are notified, and the
> cash still settles against their contract with you.

> **You'll be notified when a deposit is confirmed or rejected** — in-app, push, and your chosen
> secondary channel. A `recorded` notification you did not declare yourself is worth reading closely:
> it is how you catch an agency recording less than you handed over. See
> [Agent Notifications](./notifications.md).

---

### POST /api/agent/cod/discrepancies

**Description**: Report a cash problem with an agency — most usefully, that they recorded **less
than you handed over**, or nothing at all. An admin reviews it.

**Request Body**:
```json
{
  "agencyId": "507f1f77bcf86cd799439099",
  "amount": 40000,
  "depositId": "665f1f77bcf86cd799439400",
  "note": "Handed over 78,000 at the desk on the 10th; only 38,000 was recorded."
}
```
- `agencyId` (string, required).
- `amount` (number, optional) — the money in dispute, if it is a specific figure.
- `depositId` (string, optional) — the deposit record you are disputing, if there is one.
- `note` (string, required, ≤500 chars) — what happened.

**Success Response** (`201 Created`): the raised report.

**Error Responses**:
- `404` – `AGENT_MEMBERSHIP_NOT_FOUND` – No live contract with that agency. (An agency that has
  **suspended** you can still be reported — that is often exactly when this is needed.)

---

<a name="risk-controls"></a>
## Risk controls (what limits your COD work)

- **Exposure limit** — you can never be exposed to more cash than your limit:
  `exposure = cash held + expected cash of assigned uncollected COD shipments`. The limit is the
  platform default (or an agency-set override), scaled by your trust tier. Assignments that would
  exceed it fail with `COD_AGENT_EXPOSURE_EXCEEDED`.
- **Trust score** — starts at 100.
  - ≥ 80: full exposure limit.
  - 50–79: limit halved.
  - < 50: no COD assignments (`COD_AGENT_TRUST_TOO_LOW`).
  Penalties: holding cash past the deposit deadline (−5, once per open flag), a cash shortfall
  reported by your agency (−20). Admins can adjust the score (e.g. restore it after a resolved
  discrepancy).

  > **A deposit you have [declared](#declare-deposit) does not count against you.** The late-deposit
  > check only looks at cash you have *not* declared — if you have said you handed it over and nobody
  > has answered, that is on them, and the platform flags the agency instead. A rejected declaration
  > stops covering you the moment it is rejected.
- **Open cash-shortfall discrepancy** — blocks new COD assignments until an admin resolves it.
- **GPS/device evidence** — captured at code submission; used in fraud investigations. An
  auto-collected shipment (7 days at `agent_delivered`, no code) carries none — it is recorded with
  `verification.method: "auto_no_code"`, and a dispute turns on exactly that difference.
