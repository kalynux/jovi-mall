# Agency Magazin Management API Documentation

## Overview

The **Magazin** is a delivery agency's business surface — the single source of truth for its **public business name, description, logo and support contacts**. It is the exact counterpart of a vendor's [Store](../vendor/store.md): the agency **profile** (`/api/agency/profile`) holds personal + logistics data (contact display name, avatar, coverage, HQ addresses, payout, policies, KYC), while the **magazin** holds the business identity.

Each agency has exactly one magazin, **auto-created on first access** (and provisioned at signup / when `POST /api/agency` sets the initial name).

> [!IMPORTANT]
> **The business name lives here, not on the profile.** `GET /api/agency/profile` no longer returns `agencyName` or a business `logo`; it returns the personal `displayName` + `avatar`. Read/patch the business name, description and logo through the magazin endpoints below.
>
> Unlike the vendor Store, the magazin has **no public slug/URL and no vacation mode** — an agency is not a public shopping storefront.

**Base URL**: `/api/agency`

**Authentication**: All endpoints require a valid JWT with the `agency` role.

---

## Endpoints

### GET /api/agency/magazin

Retrieve the authenticated agency's magazin.

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "6641abc123def456",
    "agencyId": "6641abc123def400",
    "name": "FastTrack Logistics",
    "logo": {
      "id": "507f1f77bcf86cd799439030",
      "key": "products/2026/07/fasttrack-logo.png",
      "url": "https://cdn.example.com/fasttrack-logo.png",
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "logo.png"
    },
    "description": "Nationwide last-mile delivery for online sellers.",
    "supportEmail": "support@fasttrack.cm",
    "supportPhone": "+237612345678",
    "supportWhatsapp": "+237612345678",
    "version": 3,
    "createdAt": "2024-05-18T10:00:00.000Z",
    "updatedAt": "2024-05-20T09:30:00.000Z"
  }
}
```

**Field notes**:
- `logo` is a resolved **file object** (`{ id, key, url, mimeType, size, originalName }`) or `null`, not a URL string — same shape as product media and the Store logo. Upload via `POST /api/files/upload`, then submit the returned id as `logoFileId`.
- `version` is the optimistic-locking counter.

**Auto-provisioning**: if the agency has no magazin row yet (accounts created before magazins existed), this endpoint creates it on the fly — name seeded from the agency's initial name or its display name.

---

### PATCH /api/agency/magazin

Update the authenticated agency's magazin.

#### Request Body

```json
{
  "name": "FastTrack Logistics SARL",
  "logoFileId": "507f1f77bcf86cd799439030",
  "description": "Nationwide last-mile delivery for online sellers.",
  "supportEmail": "hello@fasttrack.cm",
  "supportPhone": "+237698765432",
  "supportWhatsapp": "+237698765432",
  "version": 3
}
```

**Fields** (all optional except `version`):

- `name` (string, 2–100 chars): Business/display name — **not clearable** (required in the model).
- `logoFileId` (string, MongoDB ObjectId, *clearable*): Id of a logo file uploaded via `POST /api/files/upload`. The response returns the resolved `logo` file object. Registers a `file_references` row so the file is not garbage-collected while set.
- `description` (string, max 1000 chars, *clearable*).
- `supportEmail` (string, valid email, *clearable*).
- `supportPhone` (string, 8–20 chars, *clearable*).
- `supportWhatsapp` (string, 8–20 chars, *clearable*).
- `version` (**required**, number): current magazin version for optimistic locking.

**Clearing a field**: every *clearable* field accepts `null` **or `""`** (stored/returned as `null`); omit a key to leave it unchanged. See [Conventions](../README.md#conventions).

#### Response

**Success (200 OK)**: the updated magazin (same shape as `GET`), with `version` incremented, and `message: "Magazin profile updated successfully"`.

#### Error Responses

| Code | HTTP | Description |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Wrong role |
| `MAGAZIN_CONFLICT` | 409 | Optimistic-locking version mismatch — refresh and retry |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Optimistic Locking

Reads return `version`; send it back on `PATCH`. On a match the update succeeds and `version` increments; on a mismatch the server returns `409 MAGAZIN_CONFLICT` and the client should refresh and retry.
