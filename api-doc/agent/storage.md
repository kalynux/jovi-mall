# Agent Media Storage

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
owner-stamped `agent`. Before storing, the pipeline enforces **current usage +
this upload ≤ plan `max_storage_bytes`**; an over-quota request is rejected whole
with `UPLOAD_POLICY_VIOLATION` → a `QUOTA_EXCEEDED` entry in
`error.details.violations[]` (`metadata.ownerType: "agent"`). Free space by
deleting unreferenced files (`DELETE /api/files/:id`).

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
| `UPLOAD_POLICY_VIOLATION` / `QUOTA_EXCEEDED` | 400 | Storage limit would be exceeded. |
| `FILE_TOO_LARGE` | 413 | A file exceeds its per-file cap. |
| `CATALOG_FILE_STILL_REFERENCED` | 409 | File is still attached; detach first. |
| `AUTH_FORBIDDEN` | 403 | `/api/files/storage` for a role without an owner scope. |
