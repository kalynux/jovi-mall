# Agent Media Storage

**Verified against source on 2026-09-08** — the plan caps, the storage response shape, both upload
routes with their per-type and per-request ceilings, and the error codes, against
`src/core/uploads/upload-config.ts`, `src/api/controllers/file-upload.controller.ts`,
`src/api/controllers/file-management.controller.ts`,
`src/modules/billing/services/entitlement.service.ts` and
`scripts/seed/seed-pricing-plans.ts`.

How media storage works for a delivery agent: the per-plan limit, reading usage,
the upload quota gate, and storage alerts. Mirrors the vendor/agency model.

> Related docs: [Billing — agent](./billing.md) · [File Management](./file-management.md) ·
> [Delivery proof](./delivery-proof.md) · [Notifications](./notifications.md) ·
> [Uploads (role-neutral)](../uploads/README.md).

## Authentication
Bearer token / cookie session with the **agent** role. File endpoints are scoped
to the authenticated agent.

---

## 1. What counts toward agent storage

The limit caps the total bytes of media the **agent owns**:

- the agent's **avatar**
- any **images / documents** the agent uploads through `POST /api/files/upload`
- any **videos** the agent uploads through `POST /api/files/upload/video`

> **Delivery proofs do NOT count here.** When an agent attaches a proof-of-delivery
> photo to a shipment, that file is owned by the **agency** and charged to the
> agency's storage, not the agent's. See [Delivery proof](./delivery-proof.md).

### Per-plan limit (`max_storage_bytes`)
| Plan | Media storage limit |
|---|---|
| Agent Free | **1 GB** |
| Agent Plus | **3 GB** |
| Agent Pro | **10 GB** |

Always read the live value from `GET /api/files/storage` — an admin can change a
plan's cap at any time.

---

## 2. Reading storage usage & limit

### GET /api/files/storage
```json
{
  "success": true,
  "data": {
    "limitBytes": 1073741824,
    "usedBytes": 12582912,
    "remainingBytes": 1061158912,
    "byCategory": {
      "image": { "bytes": 12582912, "count": 3 },
      "video": { "bytes": 0, "count": 0 },
      "document": { "bytes": 0, "count": 0 },
      "audio": { "bytes": 0, "count": 0 },
      "archive": { "bytes": 0, "count": 0 },
      "other": { "bytes": 0, "count": 0 }
    }
  }
}
```
The same `storage` object is embedded in `GET /api/files` under `data.storage`.

---

## 3. Uploading (and the quota gate)

`POST /api/files/upload` (`multipart/form-data`, field **`files`**, 1–10 files),
or `POST /api/files/upload/video` (field **`videos`**, 1–3 files, mp4/mov/webm),
both owner-stamped `agent`. Before storing, the pipeline enforces **current usage +
this upload ≤ plan `max_storage_bytes`**; an over-quota request is rejected whole
with `UPLOAD_POLICY_VIOLATION` → a `QUOTA_EXCEEDED` entry in
`error.details.violations[]` (`metadata.ownerType: "agent"`). Free space by
deleting unreferenced files (`DELETE /api/files/:id`).

### Per-file caps (independent of the storage limit)
| Upload route | Per-file cap |
|---|---|
| `POST /api/files/upload` | image (jpeg/png/webp) **10 MB**, gif **5 MB**, pdf **25 MB**, zip **50 MB** |
| `POST /api/files/upload/video` | **70 MB** per video, max **3** per request |

Two request-level ceilings sit above those, and both are looser than the per-type caps, so the
table above is what you will actually hit:

- **100 MB total per request** across all files (`maxTotalSizeBytes` on the general upload policy);
- **1 GB per file** for the `agent` role specifically (`ROLE_UPLOAD_LIMITS` in
  `file-upload.controller.ts`) — this is the figure sometimes quoted for "the agent upload limit",
  and it governs **this** route, never the delivery-proof route, which is capped at 10 MB. See
  [delivery-proof.md](./delivery-proof.md#size-limits-and-the-1-gb-figure-that-is-not-this-route).

**Images are transformed on this route too**: resized to fit 2048 × 2048 and recompressed, with PNG
converted to WebP (GIF is resized to 1024 × 1024 and not converted). So the stored `mimeType` and
`size` may differ from what you sent.

---

## 4. Storage alerts (notifications)

A daily backend sweep raises a `storage.alert` notification when the agent's own
usage crosses **80 / 90 / 100%** of their plan cap (highest crossed band only,
de-duped once per month per band). Opt out via the `storageAlert` preference
(default **on**), `PATCH /api/agent/notification-preferences`. Read alerts via
`GET /api/agent/notifications`. See [Notifications](./notifications.md).

---

## 5. Error reference
| Code | HTTP | Meaning |
|---|---|---|
| `UPLOAD_POLICY_VIOLATION` | 400 / 413 | **The only top-level upload code.** The reason is a per-file `details.violations[].code` — `QUOTA_EXCEEDED` (storage limit), `FILE_TOO_LARGE` (per-file cap), `TOO_MANY_FILES`, `MIME_NOT_ALLOWED`, `NO_FILES_UPLOADED`, … |
| `CATALOG_FILE_TOO_LARGE` | 413 | The multer variant only (stream aborted mid-parse); carries no `details`. |
| `CATALOG_FILE_STILL_REFERENCED` | 409 | File is still attached; detach first. |
| `AUTH_FORBIDDEN` | 403 | `/api/files/storage` for a role without an owner scope. |
