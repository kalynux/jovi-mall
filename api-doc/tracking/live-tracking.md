# Live Tracking

Live agent tracking is served by a **separate service** — `geo-tracker`
("Project B", Go) — not by this backend. This backend remains the source of
truth: it owns the authorization policy and tells geo-tracker when a shipment
finishes.

Frontends do **not** implement tracking against this API. They open a
WebSocket to geo-tracker using the **same access token** they use here. See
geo-tracker's own `api-doc/` for the socket protocol.

## Who can see what

| Role | Sees |
|---|---|
| **admin** | every agent, always |
| **agent** | only himself |
| **agency** | agents on its currently approved + active shipments (`assigned`, `picked_up`, `in_transit`, `agent_delivered`) |
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
