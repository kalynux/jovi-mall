# Tracking — Agent Tracking Policy & the Internal API

## The ownership split

This is the contract between the two services, and it is the thing to preserve when changing
anything on this page:

| Service | Owns |
|---|---|
| **jovi-mall** (this repo) | Whether tracking is **allowed** — the business policy |
| **geo-tracker** | Tracking **execution** — connections, positions, fan-out, ETA |

jovi-mall decides; geo-tracker enforces. geo-tracker must never reimplement the policy, and
jovi-mall must never serve a live position. If an endpoint here starts answering *"where is this
agent?"*, the boundary has been broken.

Related: [live-tracking](./live-tracking.md) answers *who may watch whom*. This page answers
*may this agent be tracked at all*. [shipment-destination](./shipment-destination.md) answers
*where is the parcel going* — the other internal door on the same token. All three live in
jovi-mall for the same reason.

---

## The tracking-allow flag

`agent.tracking.allowed` is a **business flag** on the agent, set by an admin (or agency) — for a
privacy request, a dispute, a legal instruction. It is not derived from anything; it is a decision,
recorded with who made it and why.

It feeds two places:
1. **geo-tracker**, which refuses to stream an agent whose policy denies it.
2. **Assignment eligibility** — an agent who may not be tracked may not receive shipments (an
   untrackable delivery is not a delivery this platform will dispatch).

### Policy resolution

`trackingAllowed` is `true` only when **all** of:

| Condition | `denyReason` when it fails |
|---|---|
| `agent.tracking.allowed === true` | `tracking_disabled` |
| `agent.status === 'active'` | `agent_not_active` |
| the agent holds ≥1 **`active` contract** | `no_approved_agency` |
| the agent exists | `agent_not_found` |

The third one is deliberate: tracking exists to serve a delivery relationship. Nobody is entitled to
watch an unaffiliated person move around.

> **`no_approved_agency` and `approvedAgencyIds` are the real wire names**, but both are computed
> from contracts in status **`active`** (`listActiveAgencyIds`) — a `pending`, `paused` or
> `suspended` contract does not count. The "approved" wording predates the `approved` → `active`
> status rename; the names are kept because clients consume them. See
> [agency/agent-roster.md](../agency/agent-roster.md#status-lifecycle) for the status set.

---

# Admin endpoints

**Authorization**: Bearer token with `admin` role.

### PUT /api/internal/admin/agents/:agentId/tracking-allow

**Request Body**:
```json
{ "allowed": false, "reason": "Agent privacy request #4412" }
```

- `allowed` (required)
- `reason` (**required when `allowed` is `false`**) — a silent revocation is unauditable.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "allowed": false,
    "reason": "Agent privacy request #4412",
    "changedAt": "2026-07-15T10:00:00.000Z",
    "changedByRole": "admin"
  },
  "message": "Tracking disabled for this agent."
}
```

Emits the domain event `agent.tracking_allow_changed`, so revocation can be **pushed** to
geo-tracker rather than waiting for a cache to expire — revoking is time-critical in a way that
granting is not.

### GET /api/internal/admin/agents/:agentId/tracking-policy

Returns exactly what geo-tracker would see. Use it to answer "why isn't this agent streaming?"
without reproducing the logic.

---

# Internal API (geo-tracker → jovi-mall)

## Base Path

```
/api/internal/agents
```

## Authentication

**Shared service token**, not a user session — geo-tracker is a service, and making it impersonate a
user would corrupt the audit trail.

```
X-Service-Token: <token>
```
(or `Authorization: Bearer <token>`)

The token is `INTERNAL_SERVICE_TOKEN` here and **must equal** geo-tracker's `NODE_API_SERVICE_TOKEN`.

**Fails closed**: when `INTERNAL_SERVICE_TOKEN` is unset the whole internal API returns `503`
`AGENT_SERVICE_TOKEN_NOT_CONFIGURED`. An unconfigured deploy exposes nothing. Comparison is
timing-safe.

**Errors**:
- `401` – `AGENT_SERVICE_TOKEN_INVALID` – missing or wrong token.
- `503` – `AGENT_SERVICE_TOKEN_NOT_CONFIGURED` – the internal API is disabled.

---

### GET /api/internal/agents/:agentId/tracking-policy

**Description**: The single question geo-tracker asks before opening a stream.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "agentId": "507f1f77bcf86cd799439011",
    "trackingAllowed": true,
    "denyReason": null,
    "note": null,
    "agentStatus": "active",
    "approvedAgencyIds": ["507f1f77bcf86cd799439099"],
    "evaluatedAt": "2026-07-15T10:00:00.000Z"
  }
}
```

`evaluatedAt` lets geo-tracker cache with a TTL of its choosing rather than guess. `note` carries the
human reason from whoever flipped the flag.

---

### POST /api/internal/agents/tracking-policies

**Description**: Batch resolution — geo-tracker resolves a whole watch-set on connect, and N round
trips per viewer would put jovi-mall on its latency path.

**Request Body**:
```json
{ "agentIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"] }
```
1–200 ids.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "policies": [
      {
        "agentId": "507f1f77bcf86cd799439011",
        "trackingAllowed": true,
        "denyReason": null,
        "note": null,
        "agentStatus": "active",
        "approvedAgencyIds": ["507f1f77bcf86cd799439099"],
        "evaluatedAt": "2026-07-15T10:00:00.000Z"
      },
      {
        "agentId": "507f1f77bcf86cd799439012",
        "trackingAllowed": false,
        "denyReason": "tracking_disabled",
        "note": "Privacy request #4412",
        "agentStatus": "active",
        "approvedAgencyIds": ["507f1f77bcf86cd799439099"],
        "evaluatedAt": "2026-07-15T10:00:00.000Z"
      }
    ]
  }
}
```

Unknown ids are returned with `denyReason: "agent_not_found"` rather than omitted — geo-tracker
should never have to infer meaning from an absent key.

---

### POST /api/internal/agents/:agentId/tracking-state

**Description**: geo-tracker reports what it observed. Two distinct things travel together here:

1. **Stream liveness + last position** — stored as a *business mirror* only.
2. **Device location capability** — the signal assignment eligibility cannot otherwise obtain.

**Request Body**:
```json
{
  "status": "streaming",
  "position": { "type": "Point", "coordinates": [9.7679, 4.0511] },
  "reportedAt": "2026-07-15T10:00:00.000Z",
  "locationServicesEnabled": true,
  "backgroundLocationEnabled": true
}
```

| Field | Notes |
|---|---|
| `status` (required) | `unknown` \| `streaming` \| `stale` \| `disconnected` |
| `position` | GeoJSON `[longitude, latitude]`. Omit to leave unchanged, `null` to clear. |
| `reportedAt` | Defaults to now. |
| `locationServicesEnabled` | Tri-state. Omit = unchanged, `null` = unknown, `false` = disabled. |
| `backgroundLocationEnabled` | Tri-state, as above. |

Device fields are optional: a liveness ping need not re-report capabilities it has not re-checked.

**Success Response** (`200 OK`):
```json
{ "success": true, "message": "Tracking state recorded." }
```

> **`last_known_tracking_state` is a business reference, not a position store.**
> geo-tracker owns live position. This mirror exists so operational screens can say "last seen 3
> minutes ago" without a synchronous cross-service call, and so the information survives a
> geo-tracker outage. It is stale by construction: a stored `streaming` degrades to `stale` on read
> once older than `AGENT_TRACKING_STATE_STALE_AFTER_SECONDS` (default 120), because a value that
> stopped being written would otherwise keep claiming to be live forever. No assignment rule reads it.

---

### GET /api/internal/agents/:agentId/eligibility?agencyId=

**Description**: Diagnostics. "Why isn't this agent being dispatched?" is a question support asks
from either side of the boundary. Read-only — it decides nothing.

Response shape: see [../agency/agent-roster.md](../agency/agent-roster.md#get-apiagencyagentsagentideligibility).

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | *(empty)* | Shared secret. Empty **disables** the internal API. Must match geo-tracker's `NODE_API_SERVICE_TOKEN`. |
| `AGENT_TRACKING_ALLOWED_BY_DEFAULT` | `true` | Tracking-allow default for new agents. |
| `AGENT_TRACKING_STATE_STALE_AFTER_SECONDS` | `120` | Age past which the mirrored state reads as stale. |
| `AGENT_REQUIRE_DEVICE_LOCATION` | `false` | Whether device location is required for assignment. **Do not enable before geo-tracker reports device state** — every agent would become ineligible. |
| `AGENT_UNKNOWN_DEVICE_LOCATION_POLICY` | `allow` | How an unknown (`null`) device signal is treated when the above is on: `allow` (fail-open) or `deny` (fail-closed). |
