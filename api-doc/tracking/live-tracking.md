# Live Tracking

Live agent tracking is served by a **separate service** — `geo-tracker`
("Project B", Go) — not by this backend. This backend remains the source of
truth: it owns the authorization policy and tells geo-tracker when a shipment
finishes.

Frontends do **not** implement tracking against this API. They open a
WebSocket to geo-tracker using the **same access token** they use here. See
geo-tracker's own `api-doc/` for the socket protocol.

> **Agencies:** the map's *data* load — which agents you may watch, and each of
> their active shipments with pickup and drop-off pins — is
> [`GET /api/agency/tracking/board`](../agency/live-tracking.md). That is the
> frontend-facing endpoint; everything on this page is the service-to-service
> seam geo-tracker calls.

## Who can see what

| Role | Sees |
|---|---|
| **admin** | every agent, always |
| **agent** | only himself |
| **agency** | agents on its currently approved + active shipments (`assigned`, `handing_over`, `picked_up`, `in_transit`, `agent_delivered`) |
| **customer** | agents on their active orders (fulfillment not yet terminal) |
| **vendor** | nothing — rejected when opening a tracking socket |

### Access ends when the shipment finishes

- **Digital (prepaid) orders** — the shipment reaches `delivered` (customer
  confirms). Payment happened at checkout, so delivery confirmation is the finish.
- **Cash on delivery** — the agent records the cash (`delivered` via the
  delivery code).

At that moment this backend emits an event to geo-tracker, which immediately
drops the agency's and customer's tracking and pushes them a
`permission_revoked` frame. An agency that still has **another** active
shipment with the same agent keeps its access (an agent may serve several
agencies at once).

### `permission_revoked` does not always mean the delivery ended

A dropped subscription has three possible causes, and geo-tracker distinguishes
them in the frame's `reason`. It is a **closed set of three values**, mirrored
here from geo-tracker's `api-doc/tracking-websocket.md` because this is the page
a dashboard or app author reads first:

| `reason` | What actually happened | What the client should do |
|---|---|---|
| `shipment_completed` | This backend was asked and answered: the viewer is no longer entitled to that agent. | Stop watching. **The only value from which you may report a delivery outcome.** |
| `authorization_expired` | This backend **rejected the access token** the socket was opened with (401/403). Nothing is known about the shipment. | Get a fresh access token, reconnect, re-subscribe. Show nothing about the delivery. |
| `authorization_unavailable` | This backend **could not be asked** — unreachable, 5xx, or the check timed out. Nothing is known about the shipment or the entitlement. | Retry with backoff. Report no outcome. |

**Treat any unrecognised value as `authorization_expired`**: re-authorize, and
tell the user nothing. That is what makes a future fourth value safe to add.

> Until 2026-08-19 all three were sent as `shipment_completed`, so a client acting
> on that string told a user their delivery was complete because an access token
> had aged out. `shipment_completed` keeps its exact value and meaning; the other
> two are new.

#### ⚠ Reconnect on a cadence shorter than the access-token TTL

geo-tracker validates the access token **at the WebSocket handshake and never
again on a timer** — but when a revocation check fires it re-asks this backend
*using that same handshake token*. Past the 15-minute access TTL the token is
expired, the check fails, and the subscription is dropped as
`authorization_expired`.

There is no refresh path over the socket. A browser client renews its access
token inside an ordinary API call (the refresh cookie); a native or WebView
client renews via
[`POST /api/auth/mobile/refresh`](../auth/FRONTEND-CHANGELOG-mobile-auth.md). Either
way the socket must then be **reconnected** with the new token — geo-tracker
forwards a bearer token and never sees the refresh cookie.

---

## GET /api/tracking/visible-agents

**Auth**: `Authorization: Bearer <jwt>` — any authenticated role.

Returns the agents the **caller** may currently track. This exists for
geo-tracker, which calls it *as the caller* (forwarding their token) and caches
the result. Frontends have no reason to call it directly.

### Response

**Success (200)**
```json
{
  "success": true,
  "data": {
    "all": false,
    "agents": ["507f1f77bcf86cd799439101", "507f1f77bcf86cd799439102"]
  }
}
```

| Field | Description |
|---|---|
| `all` | `true` only for `admin` — the wildcard "sees everyone". `agents` is then empty and irrelevant. |
| `agents` | Delivery-agent ids (`DeliveryAgent._id`) the caller may track. Empty for vendors, and for anyone with no active shipments/orders. |

---

## Configuration

| Env var | Purpose |
|---|---|
| `GEO_TRACKER_BASE_URL` | geo-tracker's URL. **Empty disables the integration** — outbox rows are still written, the dispatcher no-ops. |
| `GEO_TRACKER_WEBHOOK_SECRET` | Shared secret; must equal geo-tracker's `WEBHOOK_HMAC_SECRET`. |
| `JWT_SECRET` | geo-tracker must be configured with the **identical** value — it verifies these same HS256 access tokens. |

## How the event push works

1. A shipment status changes (`ShipmentService`) or COD cash is recorded
   (`CashCollectionService`) → a domain event is published.
2. `tracking-integration`'s subscriber writes a row to the **`tracking_outbox`**
   collection (durable: a crash never loses a pending revocation — the
   in-process event bus alone would).
3. `TrackingDispatchWorker` drains the outbox every ~2s and POSTs each event to
   geo-tracker's `/webhooks/node`, HMAC-SHA256 signed, retrying with a bounded
   attempt count before parking the row as `failed`.
4. geo-tracker dedups on `eventId` and re-checks every watcher of that agent.

Emitting on *every* status transition is safe: geo-tracker only drops watchers
who fail a fresh authorization check, so non-terminal transitions simply keep
caches fresh.
