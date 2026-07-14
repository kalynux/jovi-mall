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
   limit, or if your trust score is too low — see [Risk controls](#risk-controls)).
2. The agency marks the shipment `picked_up`. At that moment the platform creates the shipment's
   **cash collection** (the exact amount to collect, shown as `cod.expectedAmount` on
   [shipment detail](./shipments.md#detail)) and sends the customer a 6-digit delivery code
   (WhatsApp + their app).
3. At the door: hand over the package, **collect the cash**, then ask the customer for their code.
   The customer is instructed to give it only after receiving and paying.
4. Submit the code via [`POST /shipments/:id/cod/collect`](#collect). One atomic operation records
   the cash, marks the shipment **delivered**, and adds the amount to your cash balance
   (you now owe it to your agency).
5. Hand the cash to your agency. They record the deposit, which reduces
   [your balance](#balance) — aim to settle within the deposit deadline (default **2 days**) or a
   late-deposit flag lowers your trust score.

There is no separate customer delivery confirmation for COD — the verified code **is** the
confirmation. `agent_delivered` claims are rejected for COD shipments.

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

**Description**: Your recorded cash hand-overs to the agency (recorded agency-side when they
physically receive the cash). Query: `page?`, `limit?`.

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
      "recordedAt": "2026-07-10T18:00:00.000Z"
    }
  ],
  "meta": { "total": 4, "page": 1, "limit": 20, "pages": 1 }
}
```

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
- **Open cash-shortfall discrepancy** — blocks new COD assignments until an admin resolves it.
- **GPS/device evidence** — captured at code submission; used in fraud investigations.
