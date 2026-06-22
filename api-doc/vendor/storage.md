# Vendor Media Storage

How product-media storage works for vendors: the per-plan limit, how to read
usage/analytics, how uploads are gated, the storage-alert notifications, and the
automated storage lifecycle (cleanup) that can detach/delete unused media.

> Related docs: [Billing — vendor](./billing.md) (plans, limits, upgrades) ·
> [File Management](./file-management.md) (full file CRUD) ·
> [Notifications](./notifications.md) (storage alerts).

## Base Path
```
/api
```
File endpoints live under `/api/files`; the plan endpoint under `/api/vendor`.

## Authentication
All requests require a Bearer token with the **vendor** role:
```
Authorization: Bearer <access_token>
```
Every endpoint is automatically scoped to the authenticated vendor.

---

## 1. Concepts

### What counts toward storage
The storage limit caps the **total bytes of product media** a vendor stores:

- product & variant **images**
- product **videos**
- any **documents / audio / archives** uploaded through the file endpoints

These are all the files uploaded via `POST /api/files/upload` and
`POST /api/files/upload/video` (owner = the vendor).

### What does NOT count
**Digital-product assets are excluded.** A digital product's downloadable asset
has its own fixed cap of **500 MB per asset on every plan** and never counts
against the media storage limit. (Implementation note: digital-asset files are
also vendor-owned, but the usage calculation subtracts them out, so they never
inflate your `usedBytes`.)

### Per-plan limit (`max_storage_bytes`)
| Plan | Media storage limit |
|---|---|
| Starter | **1 GB** |
| Growth | **10 GB** |
| Business | **100 GB** |

The limit is a per-plan field an admin can change at any time, so **always read
the live value** from the API (below) rather than hardcoding. A vendor's limit is
the `max_storage_bytes` of their currently **active** plan.

### Per-file caps (independent of the storage limit)
Even with storage available, each file must satisfy the upload pipeline's
per-file caps:

| Upload route | Per-file cap | Notes |
|---|---|---|
| `POST /api/files/upload` (images/docs/audio) | image (jpeg/png/webp) **10 MB**, gif **5 MB**, pdf **25 MB**, zip **50 MB**, audio **10–25 MB** | hard vendor ceiling of 500 MB/file, but the per-type cap applies first |
| `POST /api/files/upload/video` | **70 MB** per video, **max 3** per request | mp4 / mov / webm |

---

## 2. Reading storage usage & limit

### GET /api/files/storage
**The primary endpoint for a storage widget.** Returns the owner's usage
breakdown, limit and remaining — without listing files.

**Authorization**: vendor (also customer/agent for their own files). Admins get `403`.

**Request Headers**: `Authorization: Bearer <token>`

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "limitBytes": 10737418240,
    "usedBytes": 2147483648,
    "remainingBytes": 8589934592,
    "byCategory": {
      "image":    { "bytes": 1048576000, "count": 320 },
      "video":    { "bytes": 1090519040, "count": 12 },
      "document": { "bytes": 8388608,    "count": 5 },
      "audio":    { "bytes": 0, "count": 0 },
      "archive":  { "bytes": 0, "count": 0 },
      "other":    { "bytes": 0, "count": 0 }
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `limitBytes` | number | Active plan's `max_storage_bytes` (vendors). `null` for customer/agent. |
| `usedBytes` | number | Total media bytes in use (digital assets excluded). Equals the sum of `byCategory[*].bytes`. |
| `remainingBytes` | number\|null | `max(0, limitBytes − usedBytes)`. `null` when there is no limit. |
| `byCategory` | object | Per-category `bytes` + file `count`. Categories: `image, video, document, audio, archive, other`. |

**Errors**: `401 UNAUTHORIZED`, `403 FORBIDDEN` (admin or unsupported role).

**Frontend tips:**
- Render a usage bar from `usedBytes / limitBytes`; show the per-category split from `byCategory`.
- All values are **bytes** — format client-side (e.g. `2.0 GB`).
- Poll/refresh after each successful upload or file delete.

### GET /api/files  (storage embedded in the listing)
The file listing returns the **same `storage` object** under `data.storage`
(alongside `files` and `pagination`), so a media library screen can show usage
without a second call. `storage` is `null` for admins (their listing is global).
See [File Management → GET /api/files](./file-management.md) for the full listing
contract, filters and the `category` query param.

### GET /api/vendor/plan  (limit + used summary)
The plan endpoint includes a compact `storage` summary so the billing screen can
show usage next to the plan:
```json
"storage": { "limitBytes": 10737418240, "usedBytes": 2147483648, "remainingBytes": 8589934592 }
```
For the full plan response see [Billing — GET /api/vendor/plan](./billing.md).

---

## 3. Uploading media (and the quota gate)

Product media is uploaded through the file endpoints, then attached to a product
/ variant. Two routes:

- `POST /api/files/upload` — `multipart/form-data`, field **`files`** (1–10 files).
- `POST /api/files/upload/video` — `multipart/form-data`, field **`videos`** (1–3 videos, 70 MB each).

On success each returns the created `File` record(s) (`id`, `key`, `mimeType`,
`size`, …) which you then reference when creating/updating a product.

### Quota enforcement
Before storing, the pipeline checks: **current media usage + this upload’s size ≤
plan `max_storage_bytes`**. If it would exceed the limit, the **entire request is
rejected** and nothing is stored.

**Over-quota response** — `400 Bad Request`:
```json
{
  "success": false,
  "error": {
    "code": "UPLOAD_POLICY_VIOLATION",
    "message": "Upload policy violations found",
    "details": {
      "violations": [
        {
          "code": "QUOTA_EXCEEDED",
          "message": "Storage quota exceeded. Maximum: 10.00 GB, Current: 9.80 GB, Requested: 0.30 GB",
          "metadata": {
            "currentTotalSize": 10522669056,
            "newTotalSize": 10844766208,
            "maxStorageBytes": 10737418240,
            "ownerType": "vendor"
          }
        }
      ]
    }
  }
}
```

**How the frontend should handle it:**
- Detect a `QUOTA_EXCEEDED` entry inside `error.details.violations[]` (the top-level `code` is `UPLOAD_POLICY_VIOLATION`; other violations like `FILE_TOO_LARGE`, `MIME_NOT_ALLOWED`, `VIRUS_DETECTED` can appear the same way).
- Show "Storage full" with the `metadata` numbers, and a CTA to **delete unused media** or **upgrade the plan** (`POST /api/vendor/plans/:planId/purchase`, see [Billing](./billing.md)).
- Proactively: call `GET /api/files/storage` before large uploads and block the picker when `remainingBytes` is too small.

Other upload errors (per-file): `413 FILE_TOO_LARGE` (exceeds the per-file/role cap), `400 TOO_MANY_FILES`, `400 FILE_TYPE_INVALID` / `MIME_NOT_ALLOWED`.

### Freeing space
Delete unreferenced files via `DELETE /api/files/:id` (only allowed when the file
has no live references — detach it from products/variants first; see
[File Management](./file-management.md)). Deleting media reduces `usedBytes`.

---

## 4. Storage alerts (notifications)

A daily backend sweep checks each vendor's usage against their plan limit and
raises an in-app notification (plus email/telegram if enabled) when usage crosses
a threshold.

- **Thresholds:** **80%, 90%, 100%** of the plan limit.
- Only the **highest crossed** threshold is sent (a vendor at 95% gets one "90%" alert, not two).
- **De-duped per month per band:** staying above a band re-alerts at most once per calendar month; crossing a higher band alerts immediately.
- **Notification type:** `storage.alert` (`aggregateType: "storage"`, `aggregateId` = vendorId).
  - Title: e.g. `Storage 92% full`
  - Message: e.g. `Your media storage is at 92% of your plan limit (9.2 GB of 10.0 GB). Remove unused product media or upgrade your plan to free up space.`
- **Opt-out:** controlled by the `storageAlert` notification preference (default **on**).

Read alerts via `GET /api/vendor/notifications` and toggle the preference via
`PATCH /api/vendor/notification-preferences`. See [Notifications](./notifications.md)
for the full notification + preferences contract. There is **no separate API** to
fetch alerts — they are normal vendor notifications.

---

## 5. Automated storage lifecycle (what can happen to media)

A scheduled backend job ("file-cleanup") keeps storage tidy. There is **no API**
to call here — but the frontend should understand and communicate these behaviors
because they affect a vendor's product media:

| Stage | What happens | Default timing |
|---|---|---|
| **Product-media detach** | Media on a product with **no paid order** for a long time is detached from the product (it stops occupying the product but is not immediately deleted). | after **45 days** of inactivity |
| **Lonely-file delete** | A file with **no remaining references** (detached / never attached) is permanently deleted, freeing its bytes. | after **15 days** lonely |
| **Storage alert** | Threshold notification (section 4). | daily check |

Protections:
- Files backing a **live customer download entitlement** (digital products a
  customer bought) are **never** detached or deleted.
- The activity clock resets whenever the product receives a **paid order**.

> Operational note: the lifecycle ships in **dry-run by default** (it logs what it
> *would* do without deleting) until an operator enables it; timings are
> environment-configurable. Treat the numbers above as defaults, not contractual.

**Frontend guidance:** surface "unused media may be removed after a period of
inactivity" in storage/help UI, and rely on `GET /api/files/storage` /
`GET /api/files` as the source of truth for what currently exists and counts.

---

## 6. Error reference

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `UPLOAD_POLICY_VIOLATION` | 400 | upload | Wrapper; inspect `details.violations[]`. |
| `QUOTA_EXCEEDED` (violation) | — | upload | Storage limit would be exceeded (in `violations[]`). |
| `FILE_TOO_LARGE` | 413 | upload | A file exceeds the per-file / role cap. |
| `TOO_MANY_FILES` | 400 | upload | More files than the per-request limit (10 / 3). |
| `FILE_TYPE_INVALID` / `MIME_NOT_ALLOWED` | 400 | upload | Unsupported type. |
| `CATALOG_FILE_STILL_REFERENCED` | 409 | delete | File is still attached; detach first. |
| `AUTH_FORBIDDEN` | 403 | `/api/files/storage` | Role without an owner scope (e.g. admin). |
| `UNAUTHORIZED` | 401 | all | Missing/invalid token. |

All errors use the standard envelope:
```json
{ "success": false, "error": { "code": "ERROR_CODE", "message": "…", "details": { } } }
```
