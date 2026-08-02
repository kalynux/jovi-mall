# Agency Media Storage

How media storage works for a delivery agency: the per-plan limit, how to read
usage, how uploads are gated, and the storage-alert notifications. Mirrors the
vendor storage model — an agency just stores different media.

> Related docs: [Billing — agency](./billing.md) (plans, credit) ·
> [File Management](./file-management.md) (full file CRUD) ·
> [Notifications](./notifications.md) (storage alerts) ·
> [Uploads (role-neutral)](../uploads/README.md).

## Base Path
```
/api
```
File endpoints live under `/api/files` and are shared by every role, scoped to
the caller. This page covers the **agency** view.

## Authentication
All requests require a Bearer token (or cookie session) with the **agency** role:
```
Authorization: Bearer <access_token>
```
Every file endpoint is automatically scoped to the authenticated agency.

---

## 1. What counts toward agency storage

The limit caps the **total bytes of media the agency owns**:

- the agency's **avatar** and its **magazin (business) logo**
- any **images / documents** uploaded through `POST /api/files/upload`
- any **videos** uploaded through `POST /api/files/upload/video`
- **agent delivery proofs** — an agent's optional proof-of-delivery photo is
  uploaded on the **agency's** storage (see [Agent → Delivery proof](../agent/delivery-proof.md)),
  so it counts here, not against the agent.

There is no digital-asset class for agencies, so nothing is subtracted — an
agency's `usedBytes` is simply the sum of every non-deleted file it owns.

### Per-plan limit (`max_storage_bytes`)
| Plan | Media storage limit |
|---|---|
| Agency Free | **5 GB** |
| Agency Growth | **25 GB** |
| Agency Scale | **100 GB** |

The limit is a per-plan field an admin can change at any time — **always read the
live value** from `GET /api/files/storage` rather than hardcoding. An agency's
limit is the `max_storage_bytes` of its currently **active** plan.

### Per-file caps (independent of the storage limit)
| Upload route | Per-file cap | Notes |
|---|---|---|
| `POST /api/files/upload` (images/docs) | image (jpeg/png/webp) **10 MB**, gif **5 MB**, pdf **25 MB**, zip **50 MB** | per-type cap applies first |
| `POST /api/files/upload/video` | **70 MB** per video, max **3** per request (mp4/mov/webm, field `videos`) | metered against this page's limit like any other file |
| `POST /api/agent/shipments/:id/delivery-proof` | **10 MB**, exactly **1** image (jpeg/png/webp) | agent-only; charged to the agency (this page's limit) |

A coarse per-role request ceiling of **200 MB per file** also applies to
`POST /api/files/upload` for agencies, but the per-type caps above are stricter
and are what you will actually hit.

---

## 2. Reading storage usage & limit

### GET /api/files/storage
The primary endpoint for a storage widget. Returns usage breakdown, limit and
remaining — without listing files.

**Success Response** — `200 OK`:
```json
{
  "success": true,
  "data": {
    "limitBytes": 5368709120,
    "usedBytes": 524288000,
    "remainingBytes": 4844421120,
    "byCategory": {
      "image":    { "bytes": 524288000, "count": 42 },
      "video":    { "bytes": 0, "count": 0 },
      "document": { "bytes": 0, "count": 0 },
      "audio":    { "bytes": 0, "count": 0 },
      "archive":  { "bytes": 0, "count": 0 },
      "other":    { "bytes": 0, "count": 0 }
    }
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `limitBytes` | number | Active plan's `max_storage_bytes`. |
| `usedBytes` | number | Total agency-owned media bytes in use. Equals the sum of `byCategory[*].bytes`. |
| `remainingBytes` | number\|null | `max(0, limitBytes − usedBytes)`. |
| `byCategory` | object | Per-category `bytes` + file `count`. |

The same `storage` object is embedded in `GET /api/files` under `data.storage`,
so a media library screen can show usage without a second call.

---

## 3. Uploading media (and the quota gate)

Media is uploaded through `POST /api/files/upload` (`multipart/form-data`, field
**`files`**, 1–10 files), or `POST /api/files/upload/video` for video
(field **`videos`**, 1–3 files). On success each returns the created `File` record
(`id`, `key`, `url`, `mimeType`, `size`, …). See [File Management](./file-management.md).

### Quota enforcement
Before storing, the pipeline checks **current usage + this upload's size ≤ plan
`max_storage_bytes`**. If it would exceed, the **entire request is rejected** and
nothing is stored:

```json
{
  "success": false,
  "error": {
    "code": "UPLOAD_POLICY_VIOLATION",
    "message": "Upload policy violations found",
    "details": { "violations": [
      { "code": "QUOTA_EXCEEDED",
        "message": "Storage quota exceeded. Maximum: 5.00 GB, Current: 4.90 GB, Requested: 0.30 GB",
        "metadata": { "maxStorageBytes": 5368709120, "ownerType": "agency" } }
    ] }
  }
}
```

Detect a `QUOTA_EXCEEDED` entry inside `error.details.violations[]`. Free space by
deleting unreferenced files (`DELETE /api/files/:id`) or upgrade the plan.

---

## 4. Storage alerts (notifications)

A daily backend sweep checks each active agency's usage against its plan limit and
raises a notification when usage crosses a threshold.

- **Thresholds:** **80%, 90%, 100%**. Only the **highest crossed** is sent.
- **De-duped per month per band:** staying above a band re-alerts at most once per
  calendar month; crossing a higher band alerts immediately.
- **Notification type:** `storage.alert` (`aggregateType: "storage"`, `aggregateId` = agencyId).
- **Opt-out:** the `storageAlert` notification preference (default **on**), via
  `PATCH /api/agency/notification-preferences`.

Read alerts via `GET /api/agency/notifications`. There is no separate API — they
are normal agency notifications. See [Notifications](./notifications.md).

---

## 5. Error reference

| Code | HTTP | Where | Meaning |
|---|---|---|---|
| `UPLOAD_POLICY_VIOLATION` | 400 | upload | Wrapper; inspect `details.violations[]`. |
| `QUOTA_EXCEEDED` (violation) | — | upload | Storage limit would be exceeded. |
| `FILE_TOO_LARGE` | 413 | upload | A file exceeds the per-file cap. |
| `CATALOG_FILE_STILL_REFERENCED` | 409 | delete | File is still attached; detach first. |
| `AUTH_FORBIDDEN` | 403 | `/api/files/storage` | Role without an owner scope (admin). |
