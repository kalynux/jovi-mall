# Agent — Availability, Working State & Device

**Verified against source on 2026-09-08** — the four state axes and their writers, both request
schemas, the `AGENT_NOT_ACTIVE` guard and the device-location eligibility rules, against
`src/modules/agents/{routes/agent.routes.ts, routes/admin-agent.routes.ts,
controllers/agent-self.controller.ts, validators/agent.validator.ts,
domain/services/{agent-availability.service.ts,agent-eligibility.service.ts},
config/agent.config.ts}`.

## Base Path

```
/api/agent
```

## Authentication

**Authorization**: Agent access required. Bearer token with `agent` role.

---

## Four state axes, deliberately separate

An agent carries four independent states. They answer different questions and are written by
different actors — collapsing any two makes it impossible to tell *why* an agent isn't getting work.

| Axis | Question | Written by | Values |
|---|---|---|---|
| `status` | May this account work at all? | admin | `pending_verification` `active` `inactive` `suspended` |
| `availability` | Does the agent *want* work now? | **the agent** | `online` `offline` `on_break` |
| `workingState` | How loaded is the agent? | system (derived) | `idle` `working` `at_capacity` |
| `tracking.allowed` | May this agent be tracked? | **admin only** | `true` `false` |

`workingState` is **derived from live shipment counts**, never set by hand — an agent is `at_capacity`
because they hold N shipments, not because someone said so.

---

### GET /api/agent/availability

**Description**: Your declared availability plus your derived load.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "availability": {
      "state": "online",
      "changed_at": "2026-07-15T08:00:00.000Z",
      "reason": null
    },
    "workingState": {
      "state": "working",
      "active_shipment_count": 3,
      "computed_at": "2026-07-15T09:12:00.000Z"
    }
  }
}
```

> **`workingState.active_shipment_count` is a derived label input, not the load figure to display.**
> It is recomputed periodically and can lag the counter the platform actually admits new offers
> against. For "how many can I still take?", read the **`capacity`** block on
> `GET /api/agent/profile` or `GET /api/agent/dispatch-settings` — it carries `maxActiveShipments`,
> the authoritative `activeShipmentCount`, and `remaining`. See
> [profile.md](./profile.md#capacity-is-read-only).
>
> `workingState.state` itself (`idle` / `working` / `at_capacity`) is reliable — it is derived from
> the ceiling, so `at_capacity` does mean no more work will be offered.

---

### PUT /api/agent/availability

**Description**: Declare whether you want new work.

**Request Body**:
```json
{ "state": "on_break", "reason": "lunch" }
```

- `state` (required) – `online` | `offline` | `on_break`
- `reason` (optional, max 200 chars) – free-text note; `null` or `""` = no reason (stored as `null`)

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": { "state": "on_break", "changed_at": "2026-07-15T12:00:00.000Z", "reason": "lunch" },
  "message": "You are now on_break."
}
```

**Errors**:
- `422` – `AGENT_NOT_ACTIVE` – only an `active` account may go online. `details: { status }`.

**Notes**:
- Going **offline with shipments in flight is allowed**. Offline stops *new* assignments; it does not
  abandon work you already hold.
- Only `online` makes you assignable — `on_break` and `offline` both block new shipments.

---

### GET /api/agent/device

**Description**: What the platform believes your device can do.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": {
    "platform": "android",
    "app_version": "1.4.2",
    "location_permission": "always",
    "location_services_enabled": true,
    "background_location_enabled": true,
    "battery_optimization_exempt": false,
    "push_enabled": true,
    "reported_at": "2026-07-15T08:00:00.000Z"
  }
}
```

---

### PUT /api/agent/device

**Description**: Report your device's capabilities. The app should call this at login and whenever a
permission changes.

**Request Body** (all fields optional; at least one required):
```json
{
  "platform": "android",
  "app_version": "1.4.2",
  "location_permission": "always",
  "location_services_enabled": true,
  "background_location_enabled": true,
  "battery_optimization_exempt": false,
  "push_enabled": true
}
```

| Field | Values |
|---|---|
| `platform` | `android` `ios` `web` `unknown` |
| `app_version` | free text, **≤ 50 chars**; `null` or `""` clears it |
| `location_permission` | `always` `while_in_use` `denied` `unknown` |
| `*_enabled`, `*_exempt` | `true` `false` `null` |

An empty body is `400 VALIDATION_ERROR` — *"At least one capability is required"*.

**Every capability is tri-state, and the difference matters:**

| Value | Meaning |
|---|---|
| *(key omitted)* | leave unchanged |
| `null` | reported as **unknown** |
| `false` | reported as **disabled** |

`null` is **not** `false`. Unknown means nobody has looked; disabled means somebody looked and it was
off. Assignment rules treat them differently — see below.

**Success Response** (`200 OK`): the stored capabilities.

---

## How device location affects assignment

Device location is one of the inputs to assignment eligibility, and it is the only one jovi-mall
cannot observe for itself — it comes from the agent's app today, and from the geo-tracker service
once that ships.

| Signal | Effect on eligibility |
|---|---|
| `false` (or `location_permission: "denied"`) | **Always blocks.** A phone with location off cannot be tracked. |
| `null` (never reported) | Blocks **only** when `AGENT_REQUIRE_DEVICE_LOCATION=true` **and** `AGENT_UNKNOWN_DEVICE_LOCATION_POLICY=deny`. Default config: does not block. |
| `true` | Passes. |

A `denied` OS permission overrides `location_services_enabled: true` — the app cannot read location
either way, so the toggle is irrelevant.

See [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md) for the
tracking-allow flag and the geo-tracker boundary.
