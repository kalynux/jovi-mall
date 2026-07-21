# Admin — Self Profile

Read and update the authenticated admin's own profile.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `admin` only (`requireRole(['admin'])`)
- **Headers**: `Content-Type: application/json` on `PATCH`.
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

Admins have **no onboarding** (`onboarding_step` is always `0`). The admin is resolved from the JWT —
there is no admin-id path parameter.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/admin/profile` | Get self-profile (includes `last_login_ip`) |
| `PATCH` | `/admin/profile` | Update self-profile fields |

> The admin router also mounts `POST /admin/products/bulk-vectorise`; that is documented in
> [admin/catalogue-vectorisation.md](./catalogue-vectorisation.md).

---

## GET `/admin/profile`

**Purpose**: Return the authenticated admin's profile, including the last login IP.

**Auth**: Required · **Permissions**: `admin`

### Example success `200`

```json
{
  "success": true,
  "data": {
    "_id": "664adm...",
    "user_id": "664usr...",
    "name": "Site Admin",
    "avatar_url": null,
    "job_title": "Operations Lead",
    "department": "Trust & Safety",
    "timezone": "Africa/Douala",
    "last_login_ip": "102.44.12.9",
    "onboarding_step": 0,
    "status": "active"
  }
}
```

---

## PATCH `/admin/profile`

**Purpose**: Update self-profile fields. All fields optional; only provided fields change.

**Auth**: Required · **Permissions**: `admin`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `name` | string | ❌ | 1–100 chars, trimmed |
| `avatar_url` | string \| null | ❌ | must be a valid URL |
| `job_title` | string \| null | ❌ | 1–100 chars |
| `department` | string \| null | ❌ | 1–100 chars |
| `timezone` | string | ❌ | non-empty (IANA timezone) |

### Example request

```json
{ "job_title": "Head of Operations", "timezone": "Africa/Douala" }
```

### Example success `200`

```json
{ "success": true, "data": { "_id": "664adm...", "job_title": "Head of Operations", "timezone": "Africa/Douala", "...": "..." }, "message": "Profile updated successfully" }
```

### Example error `400` (validation)

```json
{ "success": false, "requestId": "req_abc", "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "statusCode": 400, "details": { "fields": [{ "path": "avatar_url", "message": "avatar_url must be a valid URL", "code": "invalid_string" }] } } }
```

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body fails the Zod schema |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Authenticated as a non-admin role |

## Related

- [../auth/README.md](../auth/README.md) — session & role model
- [./catalogue-vectorisation.md](./catalogue-vectorisation.md) — admin bulk-vectorise
- Other admin surfaces: [./orders.md](./orders.md) · [./agents.md](./agents.md) · [./cod.md](./cod.md) · [./delivery-agencies.md](./delivery-agencies.md) · [./payout-requests.md](./payout-requests.md)
