# Availability Rules

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/products
```

Availability rule management endpoints use both product-scoped and rule-scoped paths.

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### POST /api/vendor/products/:id/availability-rules

**Description**: Create a new availability rule for a service product. Rules start as drafts (`isActive: false`) by default.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**:
```json
{
  "dayOfWeek": "number (required, integer, 0-6) - 0=Sunday, 6=Saturday",
  "startTime": "string (required, format: HH:mm) - Start time in 24-hour format",
  "endTime": "string (required, format: HH:mm) - End time in 24-hour format",
  "timezone": "string (optional, default: UTC) - IANA timezone identifier",
  "bufferBefore": "number (optional, integer, >= 0, default: 0) - Minutes before slot",
  "bufferAfter": "number (optional, integer, >= 0, default: 0) - Minutes after slot",
  "isActive": "boolean (optional, default: false) - Whether rule is active"
}
```

**Success Response**:

Status: `201 Created`

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
    "bufferBefore": 0,
    "bufferAfter": 0,
    "isActive": false,
    "deletedAt": null,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Availability rule created"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `INVALID_PRODUCT_TYPE` – Only service products can have availability rules
- `400` – `INVALID_TIME_RANGE` – Start time must be before end time
- `400` – `VALIDATION_ERROR` – Invalid input (e.g., invalid time format, invalid day of week)
- `409` – `TIME_OVERLAP` – Time range overlaps with existing rule for same day

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
      "bufferBefore": 0,
      "bufferAfter": 0,
      "isActive": true,
      "createdAt": "2026-02-09T23:54:00.000Z",
      "updatedAt": "2026-02-09T23:54:00.000Z"
    }
  ]
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor

---

### PATCH /api/vendor/availability-rules/:ruleId

**Description**: Update an availability rule. All fields are optional.

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
  "timezone": "string (optional)",
  "bufferBefore": "number (optional, integer, >= 0)",
  "bufferAfter": "number (optional, integer, >= 0)",
  "isActive": "boolean (optional)"
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
    "bufferBefore": 15,
    "bufferAfter": 15,
    "isActive": true,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Availability rule updated"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Availability rule not found
- `403` – `FORBIDDEN` – Rule does not belong to vendor
- `400` – `INVALID_TIME_RANGE` – Start time must be before end time (when both are provided)
- `400` – `VALIDATION_ERROR` – Invalid input

---

### PATCH /api/vendor/availability-rules/:ruleId/activate

**Description**: Activate (publish) an availability rule by setting `isActive` to `true`.

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
  "data": {
    "_id": "string",
    "productId": "string",
    "vendorId": "string",
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "timezone": "UTC",
    "bufferBefore": 0,
    "bufferAfter": 0,
    "isActive": true,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Availability rule activated"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Availability rule not found
- `403` – `FORBIDDEN` – Rule does not belong to vendor

---

### DELETE /api/vendor/availability-rules/:ruleId

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
- `404` – `NOT_FOUND` – Availability rule not found
- `403` – `FORBIDDEN` – Rule does not belong to vendor

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

For validation errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [
      {
        "path": ["startTime"],
        "message": "Invalid time format (HH:mm)"
      }
    ]
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
    "code": "INVALID_PRODUCT_TYPE",
    "message": "Only service products can have availability rules"
  }
}
```

### Time Format

All time fields must use 24-hour format with leading zeros:
- **Valid**: `09:00`, `14:30`, `23:59`
- **Invalid**: `9:00`, `2:30 PM`, `25:00`

### Timezone Expectations

- Default timezone is `UTC`
- Use IANA timezone identifiers (e.g., `America/New_York`, `Europe/Paris`)
- Invalid timezone values will cause validation errors

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

Example of overlap:
- Existing rule: Monday 09:00-17:00
- New rule: Monday 15:00-20:00 ❌ (overlaps)
- New rule: Monday 17:00-20:00 ✅ (no overlap, assuming end time is exclusive)

### Draft/Active Workflow

- Rules are created with `isActive: false` by default
- Inactive rules are not used for booking slot generation
- Use `PATCH /activate` endpoint to publish rules
- Use `PATCH` endpoint with `isActive: false` to deactivate

### Buffer Time

- `bufferBefore`: Minutes to block before each time slot
- `bufferAfter`: Minutes to block after each time slot
- Buffers prevent back-to-back bookings and allow for setup/cleanup time

### Soft Delete Behavior

Deleted rules have `deletedAt` timestamp set and are excluded from list operations. There is no restore endpoint.
