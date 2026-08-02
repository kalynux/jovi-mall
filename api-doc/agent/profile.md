# Agent — Profile, Preferences & Dispatch Settings

Read and update the authenticated agent's own record: identity, vehicle, contacts, the
navigation preference, and the one dispatch flag the agent controls.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `agent` only (`requireRole(['agent'])`)
- **Headers**: `Content-Type: application/json` on `PATCH`.
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

The agent is resolved from the JWT — there is **no agent-id path parameter** anywhere in this
document. An agent can only ever act on their own record.

> **⚠️ Breaking change (2026-07-29):** three things moved or went away.
>
> | Was | Now |
> |---|---|
> | `PATCH /api/agent/settings` (agent-domain) | **`PATCH /api/agent/dispatch-settings`** — `/agent/settings` is billing's, and always was in practice: the billing router is mounted first, so this call had never reached the agent domain and returned `400` on a required `notifyDaysBeforeExpiry`. `auto_accept_assignments` is settable for the first time. |
> | `settings.max_concurrent_shipments` (accepted on write) | **Gone.** No such field existed — it was accepted, then silently dropped before it reached the database. The real ceiling is the read-only `capacity` block, set by your plan. |
> | `preferences.notify_on_assignment`, `preferences.notify_on_shipment_update` | **Removed from reads and writes.** Neither gated anything; switching them off returned `200` and changed nothing. Real notification control is [notifications.md](./notifications.md). |
>
> If your client sent `max_concurrent_shipments`, drop it — it now fails validation instead of being
> ignored. If it read either `notify_*` flag, it will find them absent.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agent/profile` | The full profile |
| `PATCH` | `/agent/profile` | Update identity, vehicle and contact fields |
| `GET` | `/agent/profile/completion-status` | Onboarding progress — see [onboarding.md](./onboarding.md) |
| `PATCH` | `/agent/preferences` | Client-side choices (navigation app) |
| `GET` | `/agent/dispatch-settings` | Auto-accept flag + read-only capacity |
| `PATCH` | `/agent/dispatch-settings` | Update the auto-accept flag |

> **`/agent/dispatch-settings` is not `/agent/settings`.** `/agent/settings` belongs to the
> **billing** router (the plan-expiry notice window) and is documented in
> [billing.md](./billing.md#patch-agentsettings). The two are different resources that happened
> to want the same name; the agent-domain one moved rather than shadow billing's.

> **`/agent/preferences` is not `/agent/notification-preferences`.** This endpoint does not control
> notifications at all — that is [notifications.md](./notifications.md). See
> [Preferences](#patch-agentpreferences) below.

---

## GET `/agent/profile`

**Purpose**: Return the agent's full own record.

**Auth**: Required · **Permissions**: `agent`

### Example success `200`

```json
{
  "success": true,
  "data": {
    "id": "664agt...",
    "name": "Bob Driver",
    "email": "bob@example.com",
    "emailVerified": true,
    "phone": "+237670000001",
    "phoneVerified": true,
    "avatar": {
      "id": "664fil...",
      "key": "agents/664agt.../avatar.jpg",
      "url": "http://localhost:8022/api/files/agents/664agt.../avatar.jpg",
      "mimeType": "image/jpeg",
      "size": 84213,
      "originalName": "me.jpg"
    },
    "vehicleInfo": { "vehicle_type": "bike", "plate_number": "CE-1234", "color": "Red" },
    "emergencyContact": { "name": "Ada", "phone": "+237670000002" },
    "availability": { "state": "online", "changed_at": "2026-07-29T08:00:00.000Z", "reason": null },
    "workingState": { "state": "working", "active_shipment_count": 3, "computed_at": "2026-07-29T09:12:00.000Z" },
    "tracking": {
      "allowed": true,
      "reason": null,
      "changedAt": "2026-07-01T10:00:00.000Z",
      "changedByRole": "admin"
    },
    "device": {
      "platform": "android",
      "app_version": "1.4.2",
      "location_permission": "always",
      "location_services_enabled": true,
      "background_location_enabled": true,
      "battery_optimization_exempt": null,
      "push_enabled": true,
      "reported_at": "2026-07-29T08:00:05.000Z"
    },
    "lastKnownTrackingState": {
      "status": "streaming",
      "lastPosition": { "type": "Point", "coordinates": [9.7101, 4.0521] },
      "lastReportedAt": "2026-07-29T09:11:40.000Z",
      "source": "geo-tracker",
      "isStale": false
    },
    "preferences": { "navigation_app": "google_maps" },
    "settings": { "auto_accept_assignments": false },
    "capacity": { "maxActiveShipments": 20, "activeShipmentCount": 3, "remaining": 17 },
    "wa": { "verified": false },
    "timezone": "Africa/Douala",
    "preferredLanguage": "fr",
    "status": "active",
    "statusReason": null,
    "onboardingStep": 0,
    "createdAt": "2026-05-02T11:00:00.000Z",
    "updatedAt": "2026-07-29T09:12:00.000Z"
  }
}
```

### Fields worth explaining

| Field | Notes |
|---|---|
| `avatar` | A resolved file object `{ id, key, url, mimeType, size, originalName }`, or `null` — **never a bare URL string**. Written as `avatar_file_id`. |
| `capacity` | **Read-only.** `maxActiveShipments` comes from the agent's billing plan, not from any profile write. `remaining` is `max - active`, floored at 0. See [Capacity](#capacity-is-read-only). |
| `workingState.active_shipment_count` | A derived label input. For the count the dispatcher actually admits against, use `capacity.activeShipmentCount` — the two can drift, and only `capacity` is compare-and-set on accept. |
| `tracking.allowed` | **Read-only here.** Whether the platform permits live tracking of this agent; written by an admin. See [Not settable here](#not-settable-here). |
| `lastKnownTrackingState` | A **business mirror**, stale by construction — it is geo-tracker's last report, not a live position. `isStale` is computed on read, so a stored `streaming` degrades honestly to `stale` on its own. Never render it as a live location. |
| `legal_identity` | **Never returned.** Driver's licence and national-id numbers are write-only on this endpoint; only admin endpoints can read them back. |

---

## PATCH `/agent/profile`

**Purpose**: Update identity, vehicle and contact fields. All fields optional; only provided fields change.

**Auth**: Required · **Permissions**: `agent`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `name` | string | ❌ | 1–100 chars, trimmed |
| `avatar_file_id` | string \| null | ❌ | ObjectId of a file uploaded via `POST /api/files/upload` — *clearable*. The **write** field for the avatar; reads return the resolved `avatar` object. |
| `avatar_url` | string \| null | ❌ | *Deprecated* — accepted for backward compatibility. Prefer `avatar_file_id`. |
| `timezone` | string | ❌ | non-empty (IANA timezone) |
| `preferred_language` | string | ❌ | one of `en`, `fr`, `pt`, `es`, `ar` |
| `vehicle_info` | object | ❌ | `{ vehicle_type: 'bike'\|'car'\|'van'\|'truck', color, plate_number? }` — `vehicle_type` and `color` required when the object is sent |
| `legal_identity` | object | ❌ | `{ drivers_license_number?, national_id_number? }` — write-only, never echoed |
| `emergency_contact` | object \| null | ❌ | `{ name, phone }`, both required when the object is sent; `null` clears it |

> **Clearable fields**: send `null` **or `""`** to clear (stored and returned as `null`); omit the
> key to leave the value unchanged. See [Conventions](../README.md#conventions).

> **Profile avatar is a file reference.** Upload the image via `POST /api/files/upload`, then send the
> returned file `id` as `avatar_file_id`. Reads return `avatar` as a **resolved file object** — the same
> `{ id, key, url, mimeType, size, originalName }` shape product images use — or `null` when unset; never
> a bare URL string.

> Updating `vehicle_info` may advance or complete onboarding — the step is recalculated on every
> profile write. See [onboarding.md](./onboarding.md).

### Example request

```json
{
  "name": "Bob Driver",
  "vehicle_info": { "vehicle_type": "bike", "color": "Red", "plate_number": "CE-1234" },
  "emergency_contact": { "name": "Ada", "phone": "+237670000002" },
  "preferred_language": "fr"
}
```

### Example success `200`

Returns the same shape as `GET /agent/profile`.

### Example error `400` (validation)

```json
{
  "success": false,
  "requestId": "req_abc",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 400,
    "details": [{ "path": "vehicle_info.vehicle_type", "message": "Invalid enum value" }]
  }
}
```

---

## PATCH `/agent/preferences`

**Purpose**: Client-side choices. **Nothing on the server branches on these** — the agent app reads
them back from `GET /agent/profile` and acts on them itself.

**Auth**: Required · **Permissions**: `agent`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `navigation_app` | string | ❌ | one of `google_maps`, `waze`, `apple_maps`, `none` — the deep-link target the app opens for turn-by-turn |

At least one field must be present, or the request `400`s.

> **This endpoint does not control notifications.** It once carried
> `notify_on_assignment` and `notify_on_shipment_update`; both were removed because nothing read
> them — an agent who switched them off got a `200` and kept receiving everything. Notification
> delivery is gated by `assignmentOffers`, `codDepositUpdates`, `planUpdates` and friends on
> `PATCH /agent/notification-preferences` — see [notifications.md](./notifications.md).

### Example request

```json
{ "navigation_app": "waze" }
```

### Example success `200`

```json
{
  "success": true,
  "data": { "navigation_app": "waze" },
  "message": "Preferences updated."
}
```

---

## GET `/agent/dispatch-settings`

**Purpose**: The dispatch flag the agent controls, alongside the read-only capacity block — so the
app can render the auto-accept toggle and "3 of 20" from one call.

**Auth**: Required · **Permissions**: `agent`

### Example success `200`

```json
{
  "success": true,
  "data": {
    "settings": { "auto_accept_assignments": false },
    "capacity": { "maxActiveShipments": 20, "activeShipmentCount": 3, "remaining": 17 }
  }
}
```

---

## PATCH `/agent/dispatch-settings`

**Purpose**: Update dispatch behaviour.

**Auth**: Required · **Permissions**: `agent`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `auto_accept_assignments` | boolean | ❌ | When `true`, offers addressed to this agent are accepted immediately instead of waiting for a tap |

At least one field must be present, or the request `400`s.

> **Auto-accept does not skip the offer.** The offer row is still created and recorded, then
> accepted in the same breath — so the agent's offer history is identical either way, and every
> eligibility, COD-exposure and capacity check on the accept path still runs. If any of them
> refuses, the offer is simply left pending for the agent to handle manually.

> **Capacity is not settable here.** See below.

### Example request

```json
{ "auto_accept_assignments": true }
```

### Example success `200`

```json
{
  "success": true,
  "data": {
    "settings": { "auto_accept_assignments": true },
    "capacity": { "maxActiveShipments": 20, "activeShipmentCount": 3, "remaining": 17 }
  },
  "message": "Dispatch settings updated."
}
```

---

## Capacity is read-only

`capacity.maxActiveShipments` is the most shipments this agent may hold **across every agency at
once** — one agent, one vehicle, so there is no per-agency allocation of it.

It is written from the agent's **billing plan** (`max_unterminated_shipments`), so it changes when
the plan changes and at no other time. There is deliberately no agent-facing write: a value set
here would be overwritten the next time the plan renewed, which is the "slider that resets" this
endpoint exists to avoid. To raise it, change plan — see [billing.md](./billing.md).

`activeShipmentCount` is the authoritative in-flight count: it is the counter the platform
atomically checks-and-increments when an offer is accepted, which is what stops two simultaneous
assignments both seeing room. When it equals the maximum, further accepts fail with
`AGENT_AT_CAPACITY` (`422`).

## Not settable here

These appear on the profile but no agent endpoint writes them. A frontend should render them as
state, not as controls:

| Field | Written by | Where |
|---|---|---|
| `capacity.maxActiveShipments` | the agent's billing plan | [billing.md](./billing.md) |
| `tracking.allowed` | admin | `PUT /api/admin/agents/:agentId/tracking-allow` — see [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md) |
| `status` / `statusReason` | admin | `PATCH /api/admin/agents/:agentId/status` |
| `kyc` | admin | `PUT /api/admin/agents/:agentId/kyc`. Not returned on this endpoint, but note that dispatch requires `verified` — an agent whose offers all fail eligibility is usually waiting on this |
| `cod.max_threshold` | admin | `PUT /api/admin/agents/:agentId/cod-threshold`; the agent's read is `GET /agent/cod/allocation` — see [cod-cash.md](./cod-cash.md) |
| `workingState` | the system | derived from shipment counts |
| `lastKnownTrackingState` | geo-tracker | pushed over the internal API |

Availability, device capabilities and payout methods **are** agent-settable, but live on their own
endpoints — see [availability-and-device.md](./availability-and-device.md) and
[earnings.md](./earnings.md).

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body failed schema validation, or no field was provided |
| `AUTH_UNAUTHORIZED` | 401 | Missing or expired token |
| `AUTH_FORBIDDEN` | 403 | Caller is not an `agent` |
| `AGENT_NOT_FOUND` | 404 | No agent record for this user |

## Related

- [onboarding.md](./onboarding.md) — completion status and the step submit
- [availability-and-device.md](./availability-and-device.md) — online/offline and device capabilities
- [notifications.md](./notifications.md) — the real notification preferences
- [billing.md](./billing.md) — plans, credit, and the `/agent/settings` expiry-notice window
- [agency-membership.md](./agency-membership.md) — browsing agencies, contract requests and the memberships you hold
- [../uploads/README.md](../uploads/README.md) — uploading the avatar file
