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
    "avatar": null,
    "job_title": "Operations Lead",
    "department": "Trust & Safety",
    "timezone": "Africa/Douala",
    "preferredLanguage": "en",
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
| `avatar_file_id` | string \| null | ❌ | MongoDB ObjectId of a file uploaded via `POST /api/files/upload` — *clearable*. The **write** field for the avatar; reads return the resolved `avatar` file object. |
| `avatar_url` | string \| null | ❌ | *(deprecated, no effect on reads)* still accepted for backward compatibility but no longer surfaced — use `avatar_file_id`. |
| `job_title` | string \| null | ❌ | 1–100 chars — *clearable* |
| `department` | string \| null | ❌ | 1–100 chars — *clearable* |
| `timezone` | string | ❌ | non-empty (IANA timezone) |
| `preferred_language` | string | ❌ | one of `en`, `fr`, `pt`, `es`, `ar` — the admin's language, used for notifications/messaging (no separate notification-language setting) |

> **Clearable fields**: send `null` **or `""`** to clear (stored and returned as `null`); omit the
> key to leave the value unchanged. See [Conventions](../README.md#conventions).

> **Profile avatar is a file reference.** Upload the image via `POST /api/files/upload`, then send the
> returned file `id` as `avatar_file_id`. Reads return `avatar` as a **resolved file object** — the same
> `{ id, key, url, mimeType, size, originalName }` shape product images use — or `null` when unset; never
> a bare URL string. While set, that file counts as *in use* — it appears under `usage.references` on
> `GET /api/files/:id` with `entityType: "admin", field: "avatar"`, and cannot be deleted until you detach
> it (`avatar_file_id: null`). See [File Management — the `usage` object](../vendor/file-management.md#get-apifilesid).

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
{ "success": false, "requestId": "req_abc", "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "statusCode": 400, "details": { "fields": [{ "path": "avatar_file_id", "message": "avatar_file_id must be a valid file id", "code": "invalid_string" }] } } }
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
