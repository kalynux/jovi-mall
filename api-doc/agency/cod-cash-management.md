# Agency — COD Cash Management

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

## Endpoints

- [`GET /api/agency/cod/summary`](#summary) — the agency's cash position
- [`POST /api/agency/cod/deposits`](#record-deposit) — record cash received from an agent
- [`GET /api/agency/cod/deposits`](#list-deposits) — deposit history, and the declarations inbox
- [`POST /api/agency/cod/deposits/:id/confirm`](#confirm-deposit) — confirm a hand-over an agent declared
- [`POST /api/agency/cod/deposits/:id/reject`](#reject-deposit) — reject one
- [`POST /api/agency/cod/remittances`](#declare-remittance) — declare a cash transfer to the platform
- [`GET /api/agency/cod/remittances`](#list-remittances) — remittance history
- [`POST /api/agency/cod/discrepancies`](#raise-discrepancy) — flag an agent cash problem
- [`GET /api/agency/cod/discrepancies`](#list-discrepancies) — discrepancy history

---

## How the cash chain works

For cash-on-delivery orders the money physically travels **Customer → Agent → Agency → Platform**,
and the system mirrors that with two liability balances:

1. **Agent liability (to you).** The moment one of your agents submits a verified delivery code,
   the collected amount is added to that agent's cash balance — cash they hold and owe you. When
   they physically hand it over, you [record a deposit](#record-deposit) and their balance falls.
2. **Agency liability (to the platform).** The same collection also raises YOUR balance — your
   chain is accountable to the platform for that cash immediately, whether or not the agent has
   deposited it yet. It falls only when the platform **confirms** one of your
   [remittances](#declare-remittance).

Every movement is recorded in an append-only ledger — balances are never edited, only moved.

**Why remit promptly:** your earnings from COD orders (delivery fee + COD handling fee, held in
escrow — see [earnings.md](./earnings.md)) only become releasable once the cash covering them has
been remitted and confirmed. Confirmed remittances are applied to your collections **oldest
first** (FIFO).

### Two things about the agent leg that are not obvious

**Agents can declare hand-overs, and you must answer them.** Recording a deposit yourself is still
the normal flow — you are the receiving party, so your record stands on its own. But an agent can
also *declare* a hand-over, which lands in your [declarations inbox](#list-deposits)
(`?status=declared`). You have **2 days** to [confirm](#confirm-deposit) or [reject](#reject-deposit)
it. Do neither and the platform opens a `deposit_not_confirmed` flag against you — which, like any
open discrepancy, **freezes your rolling-reserve releases** until an admin clears it. Both answers
are one call; there is no cost to rejecting a claim you dispute.

While a declaration is open it also suspends that agent's late-deposit penalty. That is deliberate:
an agent who says on the record that they paid should not be penalised for your silence.

**Agents can pay the platform directly.** An agent may bypass you entirely and remit their cash to
the platform (`recipient: "platform"`). When the platform confirms it, **your liability falls too**
and your collections are FIFO-settled — exactly as if you had remitted it yourself. You keep your
delivery and COD handling fees; nothing about your earnings changes. You are notified when it
happens.

One consequence worth knowing: if you have already remitted that cash out of your own pocket, the
platform is square and refuses the agent's direct payment — it sends them back to you, because at
that point they genuinely owe **you**, not the platform.

Opting into COD, and the fee you charge per collection, are configured in your policies —
`policies.cod.enabled`, `policies.cod.max_order_amount` and
`policies.pricing.additional_fees.cod_handling_fee` (see [profile-schema.md](./profile-schema.md)).
Delivery rules specific to COD shipments (agent required before pickup, delivered-by-code only)
are in [shipments.md](./shipments.md).

---

<a name="summary"></a>
### GET /api/agency/cod/summary

**Description**: The agency's cash position at a glance.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "liability": { "balance": 325000, "currency": "XAF" },
    "agents": [
      { "id": "507f1f77bcf86cd799439101", "name": "Paul N.", "cashHeld": 130000 },
      { "id": "507f1f77bcf86cd799439102", "name": "Marie K.", "cashHeld": 0 }
    ],
    "unsettledCollections": { "count": 7, "amount": 325000 }
  }
}
```

| Field | Description |
|---|---|
| `liability.balance` | What your agency still owes the platform (falls on confirmed remittances). |
| `agents[].cashHeld` | Cash each agent holds and hasn't deposited with you yet. |
| `unsettledCollections` | Collected cash not yet covered by a confirmed remittance (what's blocking your COD earnings from releasing). |

---

<a name="record-deposit"></a>
### POST /api/agency/cod/deposits

**Description**: Record cash physically received from one of your agents. Single-step — recording
IS the confirmation (you are the receiving party). Lowers the agent's balance; your own liability
to the platform is untouched.

If the agent hands over **less** than they hold, record what you actually received and
[raise a `cash_shortfall` discrepancy](#raise-discrepancy) for the difference.

**Request Body**:
```json
{ "agentId": "507f1f77bcf86cd799439101", "amount": 130000, "note": "Evening cash desk" }
```

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "665f1f77bcf86cd799439400",
    "agentId": "507f1f77bcf86cd799439101",
    "amount": 130000,
    "currency": "XAF",
    "note": "Evening cash desk",
    "recordedAt": "2026-07-11T18:00:00.000Z"
  },
  "message": "Deposit recorded — the agent's outstanding cash was reduced."
}
```

**This also settles the contract.** A deposit is the agent returning cash under exactly one
contract, so it draws down that contract's outstanding COD balance in the same transaction. That
balance is what blocks the contract from being terminated with your money still in the agent's
pocket, and what caps how low its COD threshold can be set — so recording deposits promptly is what
frees the agent's COD headroom to keep working.

**You can only bank what the agent owes *you*.** An agent may serve several agencies but holds one
pot of cash, so the amount is bounded by this contract's outstanding balance, not by the pot. If the
agent is holding 300,000 of which only 100,000 was collected for you, you can record at most
100,000 — the rest is another agency's to receive.

**Error Responses**:
- `404` – `DELIVERY_AGENT_NOT_IN_AGENCY` – Agent isn't on this roster.
- `422` – `COD_DEPOSIT_INVALID_AMOUNT` – Not a positive integer.
- `422` – `COD_DEPOSIT_EXCEEDS_BALANCE` – More than the agent physically holds across all agencies
  (`details.outstanding`).
- `422` – `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` – More than the agent owes **this** agency.
  `details: { amount, outstanding, agentCashHeld, hint }`.
- `409` – `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` – The contract balance changed mid-write (two
  admins recording the same handover). Retry; only one will apply.

---

<a name="list-deposits"></a>
### GET /api/agency/cod/deposits

**Description**: Deposit history. Query: `agentId?`, `status?` (`declared` | `confirmed` |
`rejected`), `page?`, `limit?`.

**`?status=declared` is your inbox** — hand-overs your agents say they made and you have not
answered. Anything sitting there past **2 days** gets flagged against you and freezes your reserve
releases.

**Success Response** (`200 OK`): paginated deposit rows.

| Field | Description |
|---|---|
| `recipient` | `agency` (yours to answer) or `platform` (the agent paid the platform directly — the admin answers those). |
| `status` | `declared` = awaiting your answer; `confirmed` = money moved; `rejected` = you said it didn't happen. |
| `declaredAt` | When the agent declared it. `null` when you recorded it yourself at the desk. |
| `reference` | The agent's transfer reference, for direct platform payments. |

---

<a name="confirm-deposit"></a>
### POST /api/agency/cod/deposits/:id/confirm

**Description**: Confirm you received cash one of your agents declared. **This is where the money
moves** — the agent's balance falls and their COD headroom with you is freed.

Re-validated against live balances at confirmation, not at declaration: a claim may be days old and
the agent may have settled elsewhere since.

**Success Response** (`200 OK`): the deposit, `status: "confirmed"`.

**Error Responses**:
- `404` – `COD_DEPOSIT_NOT_FOUND` – Unknown, or not one of your agents' deposits.
- `409` – `COD_DEPOSIT_ALREADY_RESOLVED` – Already confirmed or rejected (`details.status`).
- `403` – `COD_DEPOSIT_WRONG_RECIPIENT` – The agent declared this as paid to the **platform**; only
  an admin can resolve it. Confirming it yourself would drop your liability against cash you never saw.
- `422` – `COD_DEPOSIT_EXCEEDS_BALANCE` / `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` – The agent no
  longer holds that much, or does not owe it to you.

---

<a name="reject-deposit"></a>
### POST /api/agency/cod/deposits/:id/reject

**Description**: Reject a declared hand-over — nothing arrived, or not that much. **No money moves.**
The agent's late-deposit clock resumes and an admin can see both sides.

Rejecting is a normal, cheap action. It is what you do when a claim is wrong; the thing that gets
flagged is silence, not disagreement.

**Request Body**:
```json
{ "reason": "Nothing was handed over at the desk on the 10th; our till reconciles." }
```
- `reason` (string, required, ≤500 chars).

**Success Response** (`200 OK`): the deposit, `status: "rejected"`.

**Error Responses**: as [confirm](#confirm-deposit).

---

<a name="declare-remittance"></a>
### POST /api/agency/cod/remittances

**Description**: Declare a cash transfer to the platform (bank transfer, mobile money, cash desk —
identified by `reference`). An admin confirms receipt; only then does your liability fall and your
collections settle (oldest first).

You cannot declare more than you currently owe (open declarations count against the same
liability).

**Request Body**:
```json
{ "amount": 300000, "reference": "BANKTX-88231", "note": "Weekly settlement" }
```

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": {
    "id": "665f1f77bcf86cd799439500",
    "amount": 300000,
    "currency": "XAF",
    "reference": "BANKTX-88231",
    "status": "declared",
    "declaredAt": "2026-07-11T19:00:00.000Z"
  },
  "message": "Remittance declared — awaiting platform confirmation."
}
```

**Error Responses**:
- `422` – `COD_REMITTANCE_INVALID_AMOUNT` – Not a positive integer.
- `422` – `COD_REMITTANCE_EXCEEDS_LIABILITY` – Amount (plus open declarations,
  `details.pendingDeclared`) exceeds what you owe (`details.outstanding`).

---

<a name="list-remittances"></a>
### GET /api/agency/cod/remittances

**Description**: Remittance history. Query: `status?` (`declared` | `confirmed` | `rejected`),
`page?`, `limit?`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "665f1f77bcf86cd799439500",
      "agencyId": "507f1f77bcf86cd799439099",
      "amount": 300000,
      "currency": "XAF",
      "reference": "BANKTX-88231",
      "note": "Weekly settlement",
      "status": "confirmed",
      "declaredAt": "2026-07-11T19:00:00.000Z",
      "resolvedAt": "2026-07-12T09:00:00.000Z",
      "rejectionReason": null
    }
  ],
  "meta": { "total": 3, "page": 1, "limit": 20, "pages": 1 }
}
```

---

<a name="raise-discrepancy"></a>
### POST /api/agency/cod/discrepancies

**Description**: Flag a cash problem with one of your agents. A `cash_shortfall` applies an
immediate trust penalty (−20) and blocks new COD assignments to that agent until an admin
resolves the flag.

**Request Body**:
```json
{
  "agentId": "507f1f77bcf86cd799439101",
  "type": "cash_shortfall",
  "amount": 10000,
  "note": "Deposited 120,000 of the 130,000 held"
}
```
- `type` — `cash_shortfall` | `other`.
- `amount` — money at stake (minor units); optional for `other`.

**Success Response** (`201 Created`):
```json
{
  "success": true,
  "data": { "id": "665f...", "agentId": "507f...", "type": "cash_shortfall", "amount": 10000, "status": "open", "openedAt": "..." },
  "message": "Discrepancy raised — an admin will review and resolve it."
}
```

**Error Responses**:
- `404` – `DELIVERY_AGENT_NOT_IN_AGENCY`.

---

<a name="list-discrepancies"></a>
### GET /api/agency/cod/discrepancies

**Description**: This agency's discrepancy flags — including system-raised `late_deposit` flags
(agents holding cash past the deposit deadline, default 2 days). Query: `status?`
(`open` | `resolved` | `written_off`), `agentId?`, `page?`, `limit?`.

**Success Response** (`200 OK`): paginated rows
`{ id, agentId, agencyId, type, amount, currency, status, raisedBy, note, resolutionNote, openedAt, resolvedAt }`.

---

<a name="risk"></a>
## Risk controls affecting your operation

- **Agent exposure limits** — assignment of a COD shipment fails
  (`COD_AGENT_EXPOSURE_EXCEEDED`) when the agent's held + expected cash would exceed their
  effective limit. Configure per-agent caps via
  [`PATCH /agents/:id/cod-limit`](./agents.md#cod-limit).
- **Trust tiers** — an agent's effective limit is scaled by their trust score
  (≥80 full, 50–79 halved, <50 blocked: `COD_AGENT_TRUST_TOO_LOW`).
- **Rolling reserve** — a percentage (default 10%) of your released COD earnings parks in a
  `reserve` balance for 30 days and only releases while you have **no open discrepancies**
  (see [earnings.md](./earnings.md)).
- **Deposit deadline** — agents holding cash beyond the deadline (default 2 days) are flagged
  automatically each day.
