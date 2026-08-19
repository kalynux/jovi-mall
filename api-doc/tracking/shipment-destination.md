# Tracking — the shipment destination (geo-tracker → jovi-mall)

The second internal door in this family, beside
[agent-tracking-policy](./agent-tracking-policy.md#internal-api-geo-tracker--jovi-mall). Same
caller, same token, same fail-closed rule — a different question.

| Service | Answers |
|---|---|
| **jovi-mall** (this repo) | *Where is this parcel **going**?* — the geocoded drop-off |
| **geo-tracker** | *Where is the agent **now**, and how long to get there?* — position, road network, ETA |

An address is order data, so jovi-mall owns it; a road network is geo-tracker's, so the routing
is theirs. This endpoint is the whole of the seam between the two.

## Why it exists

geo-tracker enriches a broadcast with `etaSeconds` / `distanceMeters` only when the **watcher**
has a destination, and a watcher's only source for one was the optional `destination` field on
its own `subscribe` frame. In practice that meant customers with a purpose-built client got an
ETA and **agency and admin viewers got nothing** — for deliveries whose drop-off jovi-mall had
been snapshotting onto the order at checkout the whole time.

geo-tracker now **pulls** the drop-off once per tracking session (at activation, and again at
subscribe if it is still unresolved) and hands it to every watcher of that agent.

**Nothing about the outbox changed for this.** No event shape, no HMAC body, no webhook field —
the pull is a separate call on a separate credential, which is also what keeps it clear of the
forwarded-viewer-token expiry problem that affects `/api/tracking/visible-agents`.

---

## Base path

```
/api/internal/shipments
```

## Authentication

**Shared service token**, not a user session — identical to `/api/internal/agents`, and the same
secret:

```
X-Service-Token: <token>
```
(or `Authorization: Bearer <token>`)

`INTERNAL_SERVICE_TOKEN` here **must equal** geo-tracker's `NODE_API_SERVICE_TOKEN`.

**Fails closed**: when `INTERNAL_SERVICE_TOKEN` is unset every route under this prefix answers
`503 AGENT_SERVICE_TOKEN_NOT_CONFIGURED`. Comparison is timing-safe.

**Errors**:

| Status | Code | When |
|---|---|---|
| `401` | `AGENT_SERVICE_TOKEN_INVALID` | missing or wrong token |
| `503` | `AGENT_SERVICE_TOKEN_NOT_CONFIGURED` | the internal API is disabled |

---

### GET /api/internal/shipments/:shipmentId/destination

The geocoded drop-off for one shipment.

**Success response** (`200 OK`):

```json
{
  "success": true,
  "data": {
    "shipmentId": "68a1f4c9b2e1a4d3c5f60a11",
    "destination": { "latitude": 4.0511, "longitude": 9.7679 },
    "formattedAddress": "Rue Njo-Njo, Bonapriso, Douala, Cameroon",
    "resolvedAt": "2026-08-14T09:31:22.104Z",
    "source": "order_snapshot"
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `shipmentId` | `string` | Echoed back, so a batched caller can key on it |
| `destination` | `{ latitude, longitude } \| null` | **Named fields, never a `[lng, lat]` pair** — see below |
| `formattedAddress` | `string \| null` | Human-readable. May be set while `destination` is `null` |
| `resolvedAt` | `ISO-8601 \| null` | When the address was geocoded. `null` on the legacy fallback |
| `source` | `"order_snapshot" \| "customer_saved_address" \| null` | Which rule produced the answer |

**Errors**:

| Status | Code | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | `shipmentId` is not a 24-hex id |
| `404` | `SHIPMENT_NOT_FOUND` | no such shipment |

---

## `destination: null` is an answer, not a failure

Three ordinary situations produce it:

- a **legacy order** created before `order.delivery_address` existed, whose customer's saved
  fallback address was never geocoded;
- an order row that has gone missing under its shipment;
- a digital order, which has no drop-off at all.

geo-tracker stores `null`, retries on the next activation and on every subscribe (it never
caches a failure — see ADR/plan D-11), and in the meantime simply broadcasts without an ETA,
which is what every non-customer watcher got before this endpoint existed.

A `404` degrades the same way: geo-tracker's client treats any status `>= 300` as an error and
leaves the destination unresolved.

## ⚠ Coordinates are named fields, in that order, once

`order.delivery_address.coordinates` is GeoJSON — `[longitude, latitude]`. The flip to
`{ lat, lng }` happens in **exactly one place** in this codebase,
`core/read-models/address-detail.resolver.ts`, and this endpoint renames that result onto
geo-tracker's `geo.Coordinate` JSON. It does not flip anything a second time.

Never put the bare pair on this wire. `[9.7679, 4.0511]` gets read latitude-first by the first
person who looks at it, and the pin lands in the Gulf of Guinea — the same rule geo-tracker's
`node_notifier.go` already states for the reverse direction.

## Which address, and why that one

The rule is `ShipmentService._resolveDeliveryAddress`, shared unchanged with the agency
live-tracking board and the agent's route drawing:

1. **`order.delivery_address`** — the geocoded snapshot taken at checkout (`source:
   "order_snapshot"`). This **must** win: it is the address the customer actually ordered to,
   and their saved default can be edited afterwards, so reading it live would silently re-route
   an in-flight delivery.
2. **the customer's current default saved address** (`source: "customer_saved_address"`) — the
   legacy fallback, for orders created before the snapshot field existed.

Sharing the resolver is the point. A fourth surface answering a different address for the same
shipment would show a plausible ETA to the wrong place — invisible until somebody arrives.

## Operational notes

- **Read-only, and it stays that way.** `/api/internal/agents` carries a write because
  geo-tracker observes device state jovi-mall cannot; there is no shipment equivalent. A verb
  here would be geo-tracker writing into the model it deliberately does not have.
- **No status, ever.** geo-tracker holds a shipment's **id** and jovi-mall's trackable/terminal
  **verdicts**, never its status. Adding one here would hand it a copy of the shipment model.
- **Exempt from maintenance mode and from rate limiting**, listed with a written reason in
  `system/domain/maintenance-mode.ts` and `api/rate-limit/exempt-paths.ts`. Blocking it drops no
  watcher — it silently removes the ETA from every session that *opens* during the window, and
  geo-tracker does not re-ask until the next activation or subscribe.
- **Not on any hot path.** It is called once per tracking session, not per position fix.
  geo-tracker's fan-out does not touch it.
