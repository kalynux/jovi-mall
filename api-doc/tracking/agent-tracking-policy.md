# Tracking — Agent Tracking Policy & the Internal API

**Verified against source on 2026-09-08** — the four `denyReason` values, the admin and internal
route paths, both request/response shapes, the service-token failure codes and all five
configuration defaults, against `jovi-mall/src/modules/agents/`
(`routes/internal-agent.routes.ts`, `routes/admin-agent.routes.ts`,
`middlewares/service-token.middleware.ts`, the tracking-policy service) and, for the caller
claims, an exhaustive scan of `geo-tracker/internal/**` for outbound jovi-mall paths. **Four
defects fixed**: this page said geo-tracker calls `tracking-policy`, `tracking-policies` and
`tracking-state`, and consults the flag before opening a stream. It calls none of them — the flag
is pushed by webhook, and geo-tracker's only four jovi-mall calls are listed above.

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
1. **geo-tracker**, which suppresses the live position of an agent whose policy denies it.
2. **Assignment eligibility** — an agent who may not be tracked may not receive shipments (an
   untrackable delivery is not a delivery this platform will dispatch).

> ### ⚠ How the flag actually reaches geo-tracker: it is PUSHED, never asked for
>
> **Corrected 2026-09-08.** This page presented the internal API below as the
> route the flag travels — "the single question geo-tracker asks before opening a
> stream". **geo-tracker asks no such question.** Verified against the Go source:
> it calls exactly **four** jovi-mall paths, and none of them is under
> `/api/internal/agents`:
>
> | Path | Caller |
> |---|---|
> | `GET /api/tracking/visible-agents` | `authz/repository/nodeclient_repository.go:17` |
> | `GET /api/internal/shipments/{id}/destination` | `session/repository/nodeclient_destination_repository.go:24` |
> | `POST /api/tracking/agent-state` (outbound) | `TRACKING_STATE_NOTIFY_PATH`, `config.go:325` |
> | `GET /api/health` (readiness probe) | `NODE_API_HEALTH_PATH`, `config.go:267` |
>
> The real path is **Phase 9's push**: an admin write emits an
> `agent.tracking_allow_changed` outbox row, the dispatcher POSTs it to
> geo-tracker's `/webhooks/node`, and geo-tracker's `SetTrackingAllow` writes the
> device state. See [live-tracking.md](./live-tracking.md#how-the-event-push-works)
> and `geo-tracker/api-doc/webhooks.md`.
>
> Two consequences that matter:
>
> - **The flag is not consulted at connect.** geo-tracker holds its own copy,
>   updated only when a webhook arrives. A push that never lands leaves it stale,
>   and nothing re-asks.
> - **It suppresses the live position; it opens and closes nothing.** Revoking
>   Tracking Allow drives open sessions to `tracking_disabled` and ends none of
>   them, and it revokes no watcher — `visible-agents` derives visibility from
>   shipments and never reads this flag, so an agency stays subscribed and simply
>   receives nothing.

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

> ### ⚠ That heading is historical — geo-tracker calls none of these
>
> *(The heading is kept verbatim because four pages link to its anchor. Read it
> as the name of a family of service-token routes, not as a claim about traffic.)*
>
> **These four routes exist, are mounted, and work** — verified against
> `src/modules/agents/routes/internal-agent.routes.ts:24,27,36,39`. What is not
> true, and was stated on each of them, is that **geo-tracker calls them**. It
> calls none of them (see the four-path table above), and a repository-wide search
> finds **no caller at all** for the first three, in any of the three services.
>
> Read them as *available* service-token endpoints — useful to a diagnostic tool
> or to wi-admin — not as a description of live traffic. Each carries its own
> corrected note below. The one that would surprise you most is
> `POST /:agentId/tracking-state`: it is a **built receiver the notifier has never
> called**, and its counterpart `POST /api/tracking/agent-state` is the address
> geo-tracker actually posts to.

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

**Description**: The resolved tracking policy for one agent — everything the
platform's "may this agent be tracked" rule concludes, in one read.

> ⚠ **Not called by geo-tracker, and not called by anything else** (corrected
> 2026-09-08). It was described here as "the single question geo-tracker asks
> before opening a stream"; geo-tracker asks nothing and receives the flag by
> webhook. The endpoint is live and correct — it is a diagnostic read, and
> `GET /api/internal/admin/agents/:agentId/tracking-policy` above is the same
> answer for an admin caller.

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

**Description**: Batch resolution of the same policy for many agents at once.

> ⚠ **No caller** (corrected 2026-09-08). This was described as what geo-tracker
> does "on connect"; geo-tracker resolves a watch-set through
> `GET /api/tracking/visible-agents` instead, which answers a different question
> (*who may this viewer watch*) and never consults the tracking-allow flag.

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

**Description**: A receiver for observed tracking state. Two distinct things travel together here:

> ⚠ **Built, mounted, and never called** (corrected 2026-09-08). This was
> described as the route "geo-tracker reports what it observed" on. geo-tracker's
> notifier posts to **`POST /api/tracking/agent-state`** — its
> `TRACKING_STATE_NOTIFY_PATH` has defaulted to that address since the tracking
> lifecycle shipped, and it has never pointed here. Because delivery is
> best-effort and a non-2xx is logged and dropped, neither side raised anything,
> and `DeliveryAgent.last_known_tracking_state` was the schema default on every
> agent in the database until that path was served.
>
> **The two receivers take different bodies.** The advertised one is documented in
> [`geo-tracker/api-doc/tracking-notifications.md`](../../../geo-tracker/api-doc/tracking-notifications.md)
> and carries `previousState`/`state`/`trigger` plus a **named-field**
> `position { latitude, longitude, recordedAt }`. This one takes the
> `status` + GeoJSON shape below. Do not send one body to the other endpoint.

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
