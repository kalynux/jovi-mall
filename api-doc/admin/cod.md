# Admin — Cash on Delivery (COD) Oversight

> ## ⚠️ This surface moved at the Phase 5 cutover — read this before the routes below
>
> **The public mount `/api/admin/cod` is DELETED.** It was served to any platform session
> whose `users` row carried `roles: ['admin']` — jovi-mall's second authorization model, which
> carried no tier, no permission set and no audit identity. That model is retired.
>
> **The routes themselves are unchanged and still live, at `/api/internal/admin/cod`**, behind
> `requireAdminCaller` (a service token plus `X-Actor-*` headers, never a user session). One
> factory always served both mounts, so every path, payload and response below is still exact —
> only the prefix and the guard changed. **Every path in this document has been rewritten to
> the internal prefix**, so what you read here is what the service answers.
>
> **If you are building a dashboard, this is not your document.** Call wi-admin's `/api/v1/cod` instead — it resolves the
> administrator's tier and permissions, writes the audit row, and calls this surface on your
> behalf. See [internal-service-api.md](./internal-service-api.md) for the door itself, and
> `admin/docs/api/` in the wi-admin repository for the dashboard contract.

---

## Base Path

```
/api/internal/admin/cod
```

## Authentication

**Authorization**: Admin access required. Bearer token with `admin` role.

## Endpoints

- [`GET /api/internal/admin/cod/overview`](#overview) — platform-wide cash position
- [`GET /api/internal/admin/cod/remittances`](#list-remittances) — all agencies' remittances
- [`POST /api/internal/admin/cod/remittances/:id/confirm`](#confirm-remittance) — confirm cash receipt
- [`POST /api/internal/admin/cod/remittances/:id/reject`](#reject-remittance) — reject a declaration
- [`GET /api/internal/admin/cod/deposits`](#list-deposits) — every agent hand-over; the direct-payment queue
- [`POST /api/internal/admin/cod/deposits`](#record-direct-deposit) — record cash an agent paid the platform directly
- [`POST /api/internal/admin/cod/deposits/:id/confirm`](#confirm-deposit) — confirm a declared direct payment
- [`POST /api/internal/admin/cod/deposits/:id/reject`](#reject-deposit) — reject one
- [`GET /api/internal/admin/cod/discrepancies`](#list-discrepancies) — all cash flags
- [`POST /api/internal/admin/cod/discrepancies/:id/resolve`](#resolve-discrepancy) — close a flag
- [`GET /api/internal/admin/cod/agents`](#list-agents) — agents currently holding cash
- [`POST /api/internal/admin/cod/agents/:id/trust-adjustment`](#adjust-trust) — manual trust correction
- [`GET /api/internal/admin/cod/agencies`](#list-agencies) — agencies owing the platform cash

---

## The cash chain, admin's view

COD cash normally travels **Customer → Agent → Agency → Platform**; the system tracks two
liability layers (agent → agency, agency → platform) with append-only ledgers, and every
delivery is verified by the customer's delivery code. The admin's responsibilities:

1. **Confirm remittances.** When an agency transfers collected cash to the platform, it declares
   the remittance; nothing settles until an admin confirms receipt here. Confirmation lowers the
   agency's liability and applies the amount to its collections **oldest first** — which is what
   unlocks the escrow release of the vendor/agency earnings those collections back.
2. **Confirm direct agent payments.** An agent may bypass their agency and pay the platform
   directly. [Those declarations](#list-deposits) are yours to answer — nothing sweeps them, so
   `?status=declared&recipient=platform` is a real queue that needs watching. Confirming one settles
   **both** legs at once (see below).
3. **Resolve discrepancies.** Late-deposit flags (agent sat on cash), `deposit_not_confirmed` flags
   (agency ignored an agent's declaration) and cash shortfalls (agency-raised) — plus reports raised
   by **agents**, which appear as `raisedBy: "agent"`. Open flags block the agency's rolling-reserve
   releases; open shortfalls also block new COD assignments to the flagged agent.
4. **Watch exposure.** The overview + agent/agency lists show where the platform's cash risk sits.

### The direct-payment shortcut, and why it settles two legs

A normal deposit only lowers the agent's liability; the agency's debt to the platform falls
separately, when you confirm its remittance. A **direct** payment collapses those into one event:
the cash physically skipped the agency, so confirming it lowers the agent's liability, draws down
their contract, **and** lowers the agency's liability, FIFO-settling that agency's collections
exactly as a confirmed remittance would. Both routes end in the same place — agent 0, agency 0,
platform holding the cash — which is why one record serves both.

A direct payment is refused when the agency has already remitted that cash from its own pocket
(`COD_DEPOSIT_AGENCY_ALREADY_SETTLED`). At that point the platform is square and the agent genuinely
owes the *agency*; taking the money again would leave the platform holding it twice and owing the
agency a refund.

---

<a name="overview"></a>
### GET /api/internal/admin/cod/overview

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "cashHeldByAgents": { "total": 4250000, "agentsHoldingCash": 23 },
    "agencyLiabilities": { "total": 6120000, "agenciesOwing": 9 },
    "unsettledCollections": { "count": 118, "amount": 6120000 }
  }
}
```

| Field | Meaning |
|---|---|
| `cashHeldByAgents` | Cash collected but not yet deposited with agencies. |
| `agencyLiabilities` | Cash the agency chains owe the platform (falls on confirmed remittances). |
| `unsettledCollections` | Collections not yet covered by confirmed remittances (what's blocking earnings releases). |

---

<a name="list-remittances"></a>
### GET /api/internal/admin/cod/remittances

**Description**: All agencies' remittances. Query: `status?` (`declared` | `confirmed` | `rejected`),
`agencyId?`, `page?`, `limit?`.

**Success Response** (`200 OK`): paginated rows
`{ id, agencyId, amount, currency, reference, note, status, declaredAt, resolvedAt, rejectionReason }`.

---

<a name="confirm-remittance"></a>
### POST /api/internal/admin/cod/remittances/:id/confirm

**Description**: Confirm the platform physically received the declared cash. In one transaction:
the remittance is resolved, the agency's liability falls by the amount, and the amount is applied
FIFO to the agency's collected-but-unsettled collections — each fully covered collection unlocks
the escrow release of the earnings it backs.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "remittance": { "id": "...", "status": "confirmed", "amount": 300000 },
    "settledCollectionIds": ["665f...", "665e..."]
  },
  "message": "Remittance confirmed — 2 collection(s) fully settled."
}
```

**Error Responses**:
- `404` – `COD_REMITTANCE_NOT_FOUND`
- `409` – `COD_REMITTANCE_ALREADY_RESOLVED` – Already confirmed/rejected.

---

<a name="reject-remittance"></a>
### POST /api/internal/admin/cod/remittances/:id/reject

**Description**: Reject a declaration (nothing arrived / amount mismatch). No money moves.
Body: `{ "reason": "..." }` (required).

**Error Responses**: `404 COD_REMITTANCE_NOT_FOUND`, `409 COD_REMITTANCE_ALREADY_RESOLVED`.

---

<a name="list-deposits"></a>
### GET /api/internal/admin/cod/deposits

**Description**: Every agent cash hand-over, both routes. Query: `status?` (`declared` |
`confirmed` | `rejected`), `recipient?` (`agency` | `platform`), `agencyId?`, `page?`, `limit?`.

**`?status=declared&recipient=platform` is the platform's confirmation queue.** Nothing sweeps it —
an agency's silence gets flagged automatically, but the platform's own backlog is an ops queue, not
a cash-chain fault, so it needs watching.

**Success Response** (`200 OK`): paginated rows
`{ id, agentId, agencyId, amount, currency, note, recipient, status, reference, declaredAt, resolvedAt, rejectionReason, recordedAt }`.

---

<a name="record-direct-deposit"></a>
### POST /api/internal/admin/cod/deposits

**Description**: Record cash an agent paid the **platform** directly — one step, since the platform
is the receiving party. Settles both legs: the agent, their contract, **and** the agency (whose
collections are FIFO-settled, unlocking the earnings they back).

**Request Body**:
```json
{
  "agentId": "507f1f77bcf86cd799439101",
  "agencyId": "507f1f77bcf86cd799439099",
  "amount": 78000,
  "reference": "MOMO-4471902",
  "note": "Agent paid the cash desk directly — agency unresponsive"
}
```
- `agencyId` (required) — whose cash this was. The contract it settles; never optional.
- `reference` (required) — the transfer/receipt id.

**Success Response** (`201 Created`): the deposit, `status: "confirmed"`, `recipient: "platform"`.

**Error Responses**:
- `404` – `AGENT_MEMBERSHIP_NOT_FOUND` – No live contract between that agent and agency.
- `422` – `COD_DEPOSIT_EXCEEDS_BALANCE` – More than the agent holds.
- `422` – `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` – More than the agent owes **that** agency.
- `422` – `COD_DEPOSIT_AGENCY_ALREADY_SETTLED` – The agency has already remitted this cash;
  `details.agencyOwesPlatform` is the most that can still be taken directly. See the note above.

---

<a name="confirm-deposit"></a>
### POST /api/internal/admin/cod/deposits/:id/confirm

**Description**: Confirm a direct-to-platform hand-over an agent declared. Same effect as recording
one: both legs settle.

**Error Responses**:
- `404` – `COD_DEPOSIT_NOT_FOUND`.
- `409` – `COD_DEPOSIT_ALREADY_RESOLVED`.
- `403` – `COD_DEPOSIT_WRONG_RECIPIENT` – The deposit was declared as paid to the **agency**; it is
  theirs to answer, not the platform's.
- `422` – as [record](#record-direct-deposit) — re-validated against live balances at confirmation.

---

<a name="reject-deposit"></a>
### POST /api/internal/admin/cod/deposits/:id/reject

**Description**: Reject a declared direct payment (nothing arrived / the reference doesn't match).
No money moves. Body: `{ "reason": "..." }` (required).

---

<a name="list-discrepancies"></a>
### GET /api/internal/admin/cod/discrepancies

**Description**: All cash flags. Query: `status?` (`open` | `resolved` | `written_off`),
`type?`, `agencyId?`, `agentId?`, `page?`, `limit?`.

**Success Response** (`200 OK`): paginated rows
`{ id, agentId, agencyId, type, amount, currency, status, raisedBy, depositId, note, resolutionNote, openedAt, resolvedAt }`.

| `type` | Raised by | Meaning |
|---|---|---|
| `late_deposit` | system (daily sweep) | Agent sat on **undeclared** collected cash past the deposit deadline (default 2 days). Trust −5. Cash the agent has declared is excluded — that becomes the agency's problem, below. |
| `deposit_not_confirmed` | system (daily sweep) | An agent declared a hand-over and the agency neither confirmed nor rejected it within 2 days. **No trust penalty** — the agency is at fault, not the agent. `depositId` is the declaration. Blocks the agency's reserve releases, which is the lever that makes them answer. |
| `cash_shortfall` | agency | Agent handed over less than they held. Trust −20; blocks new COD assignments to the agent. |
| `other` | agency/admin/**agent** | Anything else worth an audit trail. `raisedBy: "agent"` is an agent reporting their agency — typically an under-recorded hand-over. No trust penalty. |

> **Reading a `deposit_not_confirmed` or `raisedBy: "agent"` flag:** these are the two ways the agent
> side of a dispute reaches you. Before they existed, an agency's record of a hand-over was
> unfalsifiable and the agent silently wore the late-deposit penalty for it. Check the agent's
> declaration (`depositId`) against the agency's own deposit history.

---

<a name="resolve-discrepancy"></a>
### POST /api/internal/admin/cod/discrepancies/:id/resolve

**Description**: Close a flag. `resolved` = recovered/explained; `written_off` = the platform ate
the loss. Resolving unblocks the agency's rolling-reserve releases (and, for shortfalls, the
agent's COD assignments). Trust restoration is a separate, deliberate act — see
[trust-adjustment](#adjust-trust).

**Request Body**:
```json
{ "resolution": "resolved", "note": "Agent repaid the 10,000 XAF difference on 2026-07-12" }
```

**Error Responses**: `404 COD_DISCREPANCY_NOT_FOUND`, `409 COD_DISCREPANCY_ALREADY_RESOLVED`.

---

<a name="list-agents"></a>
### GET /api/internal/admin/cod/agents

**Description**: Agents currently holding cash, largest holders first. Query: `page?`, `limit?`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "agentId": "507f1f77bcf86cd799439101",
      "name": "Paul N.",
      "email": "agent@example.com",
      "phone": "+2376...",
      "agencyIds": ["507f1f77bcf86cd799439099", "507f1f77bcf86cd799439100"],
      "status": "active",
      "cashHeld": 130000,
      "currency": "XAF",
      "trustScore": 95,
      "codMaxThreshold": 500000
    }
  ],
  "meta": { "total": 23, "page": 1, "limit": 20, "pages": 2 }
}
```

`agencyIds` is a list, not a single id: an agent may hold contracts with several agencies at once, and
every active one is reported.

`codMaxThreshold` is the agent's **own global COD pool** — the total cash they may hold across every
agency combined. It is the figure that bounds `cashHeld` platform-wide. Each contract's threshold is a
slice of this pool, and binds only that agency's dispatches, so no per-contract figure appears here.

---

<a name="adjust-trust"></a>
### POST /api/internal/admin/cod/agents/:id/trust-adjustment

**Description**: Manual trust-score correction (e.g. restore points after a resolved discrepancy,
or hard-drop a fraudulent agent to 0, which blocks all COD work). The movement is clamped to keep
the score in [0, 100] and appended to the agent's immutable trust history.

**Request Body**:
```json
{ "delta": 20, "note": "Shortfall repaid in full; restoring standing" }
```

**Success Response** (`200 OK`):
```json
{ "success": true, "data": { "agentId": "507f...", "trustScore": 95 }, "message": "Trust score adjusted." }
```

**Error Responses**: `404 DELIVERY_AGENT_NOT_FOUND`.

---

<a name="list-agencies"></a>
### GET /api/internal/admin/cod/agencies

**Description**: Agencies currently owing the platform cash, largest first. Query: `page?`, `limit?`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "agencyId": "507f1f77bcf86cd799439099",
      "agencyName": "Douala Express Logistics",
      "email": "ops@dxl.cm",
      "phone": "+2376...",
      "status": "active",
      "liability": 1250000,
      "currency": "XAF"
    }
  ],
  "meta": { "total": 9, "page": 1, "limit": 20, "pages": 1 }
}
```
