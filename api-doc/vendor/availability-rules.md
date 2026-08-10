# Availability Rules

> **Booking system docs:** [Implementation guide](../booking-implementation-guide.md) · [Service product setup](./products.md#service-products) · **Availability rules** (this doc) · [Google Calendar](./calendar.md) · [Customer booking flow](../customer/bookings.md) · [Vendor booking management](./bookings.md)

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/products
```

All availability-rule endpoints live under `/api/vendor/products`. They come in two shapes:
- **Product-scoped** (create / list): `/api/vendor/products/:id/availability-rules`
- **Rule-scoped** (update / toggle / delete): `/api/vendor/products/availability-rules/:ruleId`

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### POST /api/vendor/products/:id/availability-rules

**Description**: Create one or more availability rules for a service product in a single request. Rules start as drafts (`isActive: false`) by default.

A whole weekly schedule can be submitted at once by sending an **array** of rules — there is no need to fire one request per day. The endpoint also still accepts a single rule object for backward compatibility.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**:

Each rule has the following shape:
```json
{
  "dayOfWeek": "number (required, integer, 0-6) - 0=Sunday, 6=Saturday",
  "startTime": "string (required, format: HH:mm) - Start time in 24-hour format",
  "endTime": "string (required, format: HH:mm) - End time in 24-hour format",
  "timezone": "string (optional) - IANA zone; omit to inherit your vendor profile's timezone",
  "isActive": "boolean (optional, default: false) - Whether rule is active"
}
```

The body may be sent in any of these three forms:

1. **Array of rules** (recommended — define the full week in one call):
```json
[
  { "dayOfWeek": 1, "startTime": "09:00", "endTime": "18:00", "timezone": "Africa/Douala" },
  { "dayOfWeek": 2, "startTime": "09:00", "endTime": "18:00", "timezone": "Africa/Douala" },
  { "dayOfWeek": 3, "startTime": "09:00", "endTime": "18:00", "timezone": "Africa/Douala" }
]
```

2. **Wrapped array** (`rules` key):
```json
{
  "rules": [
    { "dayOfWeek": 1, "startTime": "09:00", "endTime": "18:00" },
    { "dayOfWeek": 2, "startTime": "09:00", "endTime": "18:00" }
  ]
}
```

3. **Single rule object** (backward compatible):
```json
{ "dayOfWeek": 1, "startTime": "09:00", "endTime": "17:00", "timezone": "UTC" }
```

> **Atomic validation**: every rule in the request is validated before anything is persisted. If any rule has an invalid time range, or overlaps an existing rule **or another rule in the same request** (same `dayOfWeek`, overlapping hours), the entire request is rejected with a `400`/`409` and **no** rules are created.

**Success Response**:

Status: `201 Created`

`data` is always an **array** of the created rules (even when a single rule object was sent):
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "productId": "string",
      "vendorId": "string",
      "dayOfWeek": 1,
      "startTime": "09:00",
      "endTime": "18:00",
      "timezone": "Africa/Douala",
      "isActive": false,
      "deletedAt": null,
      "createdAt": "2026-02-09T23:54:00.000Z",
      "updatedAt": "2026-02-09T23:54:00.000Z"
    },
    {
      "_id": "string",
      "productId": "string",
      "vendorId": "string",
      "dayOfWeek": 2,
      "startTime": "09:00",
      "endTime": "18:00",
      "timezone": "Africa/Douala",
      "isActive": false,
      "deletedAt": null,
      "createdAt": "2026-02-09T23:54:00.000Z",
      "updatedAt": "2026-02-09T23:54:00.000Z"
    }
  ],
  "message": "2 availability rules created"
}
```

**Error Responses**:
- `404` – `AVAILABILITY_PRODUCT_NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `AVAILABILITY_INVALID_PRODUCT_TYPE` – Only service products can have availability rules
- `400` – `AVAILABILITY_INVALID_TIME_RANGE` – A rule's start time is not before its end time (message names the `dayOfWeek`)
- `400` – `VALIDATION_ERROR` – Invalid input (e.g., empty array, invalid time format, invalid day of week)
- `409` – `AVAILABILITY_TIME_OVERLAP` – A rule overlaps an existing rule, or two rules in the request overlap, for the same day

---

### GET /api/vendor/products/:id/availability-rules

**Description**: List all availability rules for a service product, sorted by day and time.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "productId": "string",
      "vendorId": "string",
      "dayOfWeek": 1,
      "startTime": "09:00",
      "endTime": "17:00",
      "timezone": "UTC",
      "isActive": true,
      "createdAt": "2026-02-09T23:54:00.000Z",
      "updatedAt": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `AVAILABILITY_PRODUCT_NOT_FOUND` – Product not found or does not belong to vendor

---

### PATCH /api/vendor/products/availability-rules/:ruleId

**Description**: Update an availability rule. All fields are optional. Note: `isActive` cannot be changed here — use the `/toggle` endpoint instead.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `ruleId` (string, required) - Availability rule ID

**Query Parameters**: None

**Request Body**:
```json
{
  "dayOfWeek": "number (optional, integer, 0-6)",
  "startTime": "string (optional, format: HH:mm)",
  "endTime": "string (optional, format: HH:mm)",
  "timezone": "string (optional)"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "productId": "string",
    "vendorId": "string",
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "timezone": "UTC",
    "isActive": true,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Availability rule updated"
}
```

**Error Responses**:
- `404` – `AVAILABILITY_RULE_NOT_FOUND` – Availability rule not found
- `403` – `AVAILABILITY_FORBIDDEN` – Rule does not belong to vendor
- `400` – `AVAILABILITY_INVALID_TIME_RANGE` – Start time must be before end time (when both are provided)
- `400` – `VALIDATION_ERROR` – Invalid input

---

### PATCH /api/vendor/products/availability-rules/:ruleId/toggle

**Description**: Set the active state of an availability rule explicitly from the `isActive` flag in the request body. Pass `true` to activate (publish) the rule or `false` to deactivate it (return to draft). This does **not** flip the current state — the resulting state always matches the value sent.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `ruleId` (string, required) - Availability rule ID

**Query Parameters**: None

**Request Body**:
```json
{
  "isActive": "boolean (required) - true to activate the rule, false to deactivate it"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "productId": "string",
    "vendorId": "string",
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "timezone": "UTC",
    "isActive": false,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Availability rule deactivated"
}
```

> The `message` is `"Availability rule activated"` or `"Availability rule deactivated"` depending on the `isActive` value sent.

**Error Responses**:
- `404` – `AVAILABILITY_RULE_NOT_FOUND` – Availability rule not found
- `403` – `AVAILABILITY_FORBIDDEN` – Rule does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid input (e.g., missing or non-boolean `isActive`)

---

### DELETE /api/vendor/products/availability-rules/:ruleId

**Description**: Delete an availability rule (soft delete). Sets `deletedAt` timestamp.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `ruleId` (string, required) - Availability rule ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Availability rule deleted"
}
```

**Error Responses**:
- `404` – `AVAILABILITY_RULE_NOT_FOUND` – Availability rule not found
- `403` – `AVAILABILITY_FORBIDDEN` – Rule does not belong to vendor

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "requestId": "f3a1...",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description",
    "statusCode": 400
  }
}
```

For validation errors (`VALIDATION_ERROR`), `details.fields` lists each offending field:

```json
{
  "success": false,
  "requestId": "f3a1...",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 400,
    "details": {
      "fields": [
        { "path": "startTime", "message": "Invalid time format (HH:mm)", "code": "invalid_string" }
      ]
    }
  }
}
```

## Notes & Constraints

### Product Type Restriction

Only **service products** can have availability rules. Attempting to create rules for `physical` or `digital` products returns:

```json
{
  "success": false,
  "error": {
    "code": "AVAILABILITY_INVALID_PRODUCT_TYPE",
    "message": "Only service products can have availability rules"
  }
}
```

### Time Format

All time fields must use 24-hour format with leading zeros:
- **Valid**: `09:00`, `14:30`, `23:59`
- **Invalid**: `9:00`, `2:30 PM`, `25:00`

### Timezone Expectations

`startTime` and `endTime` are **wall-clock** times — "09:00" means nine o'clock *somewhere*, and `timezone` is what says where.

- **`timezone` is optional. Omit it and the rule uses your vendor profile's `timezone`** (set during onboarding, e.g. `Africa/Douala`). That is the normal case — set it only to give one rule a different zone from the rest of your schedule.
- Use IANA identifiers (`Africa/Douala`, `America/New_York`, `Europe/Paris`). Abbreviations like `WAT` or `EST` are not accepted.
- An unrecognised zone is rejected with `400 VALIDATION_ERROR`.
- Daylight-saving transitions are handled for you: a rule reading `09:00` stays at nine o'clock local across the change.

> **Changed:** `timezone` used to default to the literal `'UTC'`, was never validated, and — more importantly — **was never read**. Rule hours were resolved against the *server's* clock, so a vendor's working day shifted whenever the server moved. Rules are now resolved in the zone above. Existing rows carrying the old `'UTC'` default are cleared to "inherit the vendor's timezone" by `npm run migrate:booking-rule-timezones` (run it with `--dry-run` first — it reports every rule whose effective hours move).

### Day of Week Values

| Value | Day |
|-------|-----|
| 0 | Sunday |
| 1 | Monday |
| 2 | Tuesday |
| 3 | Wednesday |
| 4 | Thursday |
| 5 | Friday |
| 6 | Saturday |

### Time Overlap Validation

The system prevents creating overlapping rules for the same day. Overlapping is determined by:
- Same `dayOfWeek`
- Overlapping time ranges (`startTime` to `endTime`)

> Overlap is checked against **all non-deleted rules** for the product on that day, including inactive (draft) rules — not just active ones. A draft rule will still block creation of an overlapping rule.
>
> When submitting an array of rules, the rules in the request are also checked against **each other** — two rules in the same batch that overlap on the same day are rejected before anything is saved.

Example of overlap:
- Existing rule: Monday 09:00-17:00
- New rule: Monday 15:00-20:00 ❌ (overlaps)
- New rule: Monday 17:00-20:00 ✅ (no overlap, assuming end time is exclusive)

### Draft/Active Workflow

- Rules are created with `isActive: false` by default (draft)
- Inactive rules are not used for booking slot generation
- Use the `PATCH .../toggle` endpoint with `{ "isActive": true }` to publish a rule or `{ "isActive": false }` to return it to draft
- The plain `PATCH .../:ruleId` update endpoint ignores `isActive` — change activation only via `/toggle`

### Buffer Time

- Buffer time is **not** configured on availability rules. It lives on the service variant's
  `serviceConfig` (`bufferBeforeMinutes` / `bufferAfterMinutes`) — see [variants.md](./variants.md#service-config).
- Those buffers pad each busy slot when computing availability, preventing back-to-back bookings
  and allowing setup/cleanup time across the whole service.

### Soft Delete Behavior

Deleted rules have `deletedAt` timestamp set and are excluded from list operations. There is no restore endpoint.
