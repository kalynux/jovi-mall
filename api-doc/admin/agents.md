# Admin — Agent Administration

Platform-level administration of delivery agents: view an agent's full record, change account status,
control the tracking-allow flag, transfer an agent between agencies, and inspect eligibility/history.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> **Model note.** An agent is a **platform identity**, not an agency-owned record — they may serve
> several agencies at once via `AgentAgencyMembership` rows. Four state axes are kept separate:
> `status` (may the account work — admin-written), `availability` (does the agent want work — agent-written),
> `working_state` (how loaded — system-derived), and `tracking.allowed` (may they be tracked —
> admin/agency-written). See [../agent/agency-membership.md](../agent/agency-membership.md) and
> [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/agents/transfer` | Move an agent from one agency to another |
| `GET` | `/admin/agents/:agentId` | Agent profile + every membership |
| `PATCH` | `/admin/agents/:agentId/status` | Set account status (activate/suspend/…) |
| `PUT` | `/admin/agents/:agentId/tracking-allow` | Enable/disable tracking-allow |
| `GET` | `/admin/agents/:agentId/tracking-policy` | The tracking policy geo-tracker would see |
| `GET` | `/admin/agents/:agentId/history` | Membership/lifecycle history |
| `GET` | `/admin/agents/:agentId/eligibility?agencyId=` | Assignment-eligibility check for an agency |

> Route order matters: `/transfer` is declared **before** `/:agentId` so it is not read as an agent id.

---

## POST `/admin/agents/transfer`

**Purpose**: Move an agent from one agency's roster to another. **Admin-only** — an agency must not be
able to pull an agent off a rival's roster.

**Auth**: Required · **Permissions**: `admin`

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `agentId` | string (ObjectId) | ✅ | Agent to transfer |
| `fromAgencyId` | string (ObjectId) | ✅ | Source agency |
| `toAgencyId` | string (ObjectId) | ✅ | Destination agency |
| `reason` | string | ❌ | Audit note |

### Example request

```json
{ "agentId": "664agt...", "fromAgencyId": "664agyA...", "toAgencyId": "664agyB...", "reason": "Agent relocated" }
```

### Example success `200`

```json
{ "success": true, "data": { "agentId": "664agt...", "fromAgencyId": "664agyA...", "toAgencyId": "664agyB..." }, "message": "Agent transferred" }
```

> The transfer moves both membership sides as one unit; the source is deactivated before the destination
> threshold is checked against pooled COD headroom, and COD/wage settlement gates still apply.

---

## GET `/admin/agents/:agentId`

**Purpose**: Return the agent's profile and **every** membership (across all agencies).

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Example success `200` (representative shape)

```json
{
  "success": true,
  "data": {
    "agent": {
      "_id": "664agt...",
      "name": "Sam Rider",
      "status": "active",
      "availability": "online",
      "working_state": "available",
      "tracking": { "allowed": true },
      "capacity": { "active_shipment_count": 1, "max_concurrent_shipments": 5 },
      "cod": { "max_threshold": 500000, "trust_score": 82 },
      "vehicle_info": { "vehicle_type": "bike", "color": "red" }
    },
    "memberships": [
      { "_id": "664mem...", "agency_id": "664agy...", "status": "active", "cod": { "threshold": 200000 } }
    ]
  }
}
```

> Exact field set is defined by the agent domain (`src/modules/agents/`). Treat unknown fields as additive.

---

## PATCH `/admin/agents/:agentId/status`

**Purpose**: Set the agent's account status. Memberships are intentionally left intact so reinstatement
restores them.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `status` | string | ✅ | New account status (e.g. `active`, `suspended`) |
| `reason` | string | conditionally | **Required when suspending** |

### Example request

```json
{ "status": "suspended", "reason": "KYC re-check pending" }
```

### Example success `200`

```json
{ "success": true, "data": { "_id": "664agt...", "status": "suspended" }, "message": "Status updated" }
```

---

## PUT `/admin/agents/:agentId/tracking-allow`

**Purpose**: Enable or disable the **tracking-allow** flag. jovi-mall owns this flag; geo-tracker
enforces it — flipping it here revokes/permits live tracking downstream.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Request body

| Field | Type | Required | Notes |
|---|---|---|---|
| `allowed` | boolean | ✅ | `true` permits tracking, `false` disables it |
| `reason` | string | conditionally | **Required when disabling** (`allowed: false`) |

### Example request

```json
{ "allowed": false, "reason": "Privacy complaint under review" }
```

---

## GET `/admin/agents/:agentId/tracking-policy`

**Purpose**: Return the tracking policy geo-tracker would resolve for this agent (what the tracking
service sees). Read-only.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

---

## GET `/admin/agents/:agentId/history`

**Purpose**: Return the agent's append-only membership/lifecycle history.

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

---

## GET `/admin/agents/:agentId/eligibility`

**Purpose**: Evaluate whether the agent is eligible for assignment **for a given agency**, reporting
**every** failed rule at once (active · approved with the dispatching agency · online · tracking allowed
· device location not disabled · under capacity).

**Auth**: Required · **Permissions**: `admin` · **Path param**: `agentId` (ObjectId)

### Query parameters

| Param | Type | Required | Notes |
|---|---|---|---|
| `agencyId` | string (ObjectId) | ✅ | The dispatching agency to evaluate against |

### Example success `200` (representative shape)

```json
{
  "success": true,
  "data": {
    "eligible": false,
    "failedRules": ["tracking_not_allowed", "over_capacity"]
  }
}
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing/invalid body or query (e.g. `reason` required to suspend/disable) |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Non-admin caller |
| `NOT_FOUND` | 404 | Agent / agency / membership not found |

## Related

- [../agency/agent-roster.md](../agency/agent-roster.md) — agency-side roster management
- [../agent/agency-membership.md](../agent/agency-membership.md) · [../agent/availability-and-device.md](../agent/availability-and-device.md)
- [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md)

> **Refactor in flight.** A shared-pool COD / contract-status refactor is part-applied in the agent
> domain; some newer agent/contract admin surfaces (threshold, contract terms, settlements, KYC/ban,
> status-request inbox) are **not yet mounted**. The endpoints in this doc are the currently-reachable
> admin agent surface. See `../../AGENT-CONTRACT-REFACTOR.md`.
