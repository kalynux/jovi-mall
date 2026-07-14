# Admin — Cash on Delivery (COD) Oversight

## Base Path

```
/api/admin/cod
```

## Authentication

**Authorization**: Admin access required. Bearer token with `admin` role.

## Endpoints

- [`GET /api/admin/cod/overview`](#overview) — platform-wide cash position
- [`GET /api/admin/cod/remittances`](#list-remittances) — all agencies' remittances
- [`POST /api/admin/cod/remittances/:id/confirm`](#confirm-remittance) — confirm cash receipt
- [`POST /api/admin/cod/remittances/:id/reject`](#reject-remittance) — reject a declaration
- [`GET /api/admin/cod/discrepancies`](#list-discrepancies) — all cash flags
- [`POST /api/admin/cod/discrepancies/:id/resolve`](#resolve-discrepancy) — close a flag
- [`GET /api/admin/cod/agents`](#list-agents) — agents currently holding cash
- [`POST /api/admin/cod/agents/:id/trust-adjustment`](#adjust-trust) — manual trust correction
- [`GET /api/admin/cod/agencies`](#list-agencies) — agencies owing the platform cash

---

## The cash chain, admin's view

COD cash physically travels **Customer → Agent → Agency → Platform**; the system tracks two
liability layers (agent → agency, agency → platform) with append-only ledgers, and every
delivery is verified by the customer's delivery code. The admin's responsibilities:

1. **Confirm remittances.** When an agency transfers collected cash to the platform, it declares
   the remittance; nothing settles until an admin confirms receipt here. Confirmation lowers the
   agency's liability and applies the amount to its collections **oldest first** — which is what
   unlocks the escrow release of the vendor/agency earnings those collections back.
2. **Resolve discrepancies.** Late-deposit flags (system-raised daily) and cash shortfalls
   (agency-raised). Open flags block the agency's rolling-reserve releases; open shortfalls also
   block new COD assignments to the flagged agent.
3. **Watch exposure.** The overview + agent/agency lists show where the platform's cash risk sits.

---

<a name="overview"></a>
### GET /api/admin/cod/overview

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
### GET /api/admin/cod/remittances

**Description**: All agencies' remittances. Query: `status?` (`declared` | `confirmed` | `rejected`),
`agencyId?`, `page?`, `limit?`.

**Success Response** (`200 OK`): paginated rows
`{ id, agencyId, amount, currency, reference, note, status, declaredAt, resolvedAt, rejectionReason }`.

---

<a name="confirm-remittance"></a>
### POST /api/admin/cod/remittances/:id/confirm

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
### POST /api/admin/cod/remittances/:id/reject

**Description**: Reject a declaration (nothing arrived / amount mismatch). No money moves.
Body: `{ "reason": "..." }` (required).

**Error Responses**: `404 COD_REMITTANCE_NOT_FOUND`, `409 COD_REMITTANCE_ALREADY_RESOLVED`.

---

<a name="list-discrepancies"></a>
### GET /api/admin/cod/discrepancies

**Description**: All cash flags. Query: `status?` (`open` | `resolved` | `written_off`),
`agencyId?`, `agentId?`, `page?`, `limit?`.

**Success Response** (`200 OK`): paginated rows
`{ id, agentId, agencyId, type, amount, currency, status, raisedBy, note, resolutionNote, openedAt, resolvedAt }`.

| `type` | Raised by | Meaning |
|---|---|---|
| `late_deposit` | system (daily sweep) | Agent sat on collected cash past the deposit deadline (default 2 days). Trust −5. |
| `cash_shortfall` | agency | Agent handed over less than they held. Trust −20; blocks new COD assignments to the agent. |
| `other` | agency/admin | Anything else worth an audit trail. |

---

<a name="resolve-discrepancy"></a>
### POST /api/admin/cod/discrepancies/:id/resolve

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
### GET /api/admin/cod/agents

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
      "agencyId": "507f1f77bcf86cd799439099",
      "status": "active",
      "cashHeld": 130000,
      "currency": "XAF",
      "trustScore": 95,
      "maxExposureOverride": null
    }
  ],
  "meta": { "total": 23, "page": 1, "limit": 20, "pages": 2 }
}
```

---

<a name="adjust-trust"></a>
### POST /api/admin/cod/agents/:id/trust-adjustment

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
### GET /api/admin/cod/agencies

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
