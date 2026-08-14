# Files & Uploads (all roles)

The `/api/files` surface is **shared by every authenticated role** (customer, vendor, agency, agent,
admin), with per-role size limits. Uploaded files are referenced elsewhere by their returned `id`
(product images, vendor/agency branding, KYC documents, ticket attachments, etc.).

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required on every route (`requireAuth`) — cookie or `Bearer`.
- **Permissions**: any authenticated role; a few management routes are `admin`-only (noted below).
- **Response envelope**: standard `{ success, data, meta?, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> This is the role-neutral contract. Vendor-specific storage/quota details are in
> [../vendor/storage.md](../vendor/storage.md) and [../vendor/file-management.md](../vendor/file-management.md).

## Endpoints

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| `POST` | `/files/upload` | Upload 1–10 files (multipart) | any authenticated |
| `POST` | `/files/upload/video` | Upload video files (dedicated route) | any authenticated |
| `GET` | `/files` | List your files (search / filter / paginate / sort) | any authenticated |
| `GET` | `/files/storage` | Storage usage + plan limit summary | any authenticated |
| `GET` | `/files/orphans` | List orphaned files (GC candidates) | **admin** |
| `GET` | `/files/:id` | Get single file metadata | any authenticated |
| `PATCH` | `/files/:id` | Update file metadata (`originalName` only) | any authenticated (owner) |
| `DELETE` | `/files/:id` | Soft-delete (only if no live references) | any authenticated (owner) |
| `DELETE` | `/files/:id/permanent` | Permanently delete | **admin** |
| `GET` | `/files/<path>` | Static file serving (local storage provider) | (served by `express.static`) |

---

## POST `/files/upload`

**Purpose**: Upload 1–10 files in one multipart request.

**Content-Type**: `multipart/form-data` · **Form field**: `files` (repeatable, up to 10).

### Per-role size limit (per file)

| Role | Max size / file |
|---|---|
| Customer | 100 MB |
| Agency | 200 MB |
| Vendor | 500 MB |
| Agent | 1 GB |
| Admin | 2 GB |

An unrecognised role falls back to the **customer** limit (100 MB).

### Example success `201` (representative shape)

```json
{
  "success": true,
  "data": [
    {
      "id": "664file...",
      "originalName": "product-front.jpg",
      "mimeType": "image/jpeg",
      "size": 254013,
      "url": "http://localhost:8022/api/files/images/2026/07/664file....jpg",
      "provider": "local",
      "ownerType": "vendor",
      "createdAt": "2026-07-17T10:20:30.000Z"
    }
  ]
}
```

> Exact metadata fields are owned by the file model — see [../vendor/file-management.md](../vendor/file-management.md).

### Where a file is stored

This route is **general media intake**: you are not saying what the file is *for* (that is decided
later, when you attach the returned `id`), so each file is stored under the folder for **its own
detected media type** — `images/`, `videos/`, `audio/`, `documents/`, `archives/`, `other/` — the same
taxonomy as `?category=` on `GET /files`. The type is taken from the file's actual bytes, not from the
declared `Content-Type` or the extension, and follows any conversion the pipeline applies (a `png`
stored as `webp` still lands in `images/`).

This is a storage-layout detail: always use the returned `id`/`url`, never a hand-built path.
Purpose-scoped folders (product media, digital assets, delivery proofs, system files) belong to their
own dedicated endpoints and carry their own role restrictions.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | No files, or an unexpected/too-many-files field |
| 400 | `UPLOAD_POLICY_VIOLATION` | A file failed the upload policy — `error.details.violations[]` lists each one with its own `code` (`MIME_NOT_ALLOWED`, `MIME_TYPE_MISMATCH`, `UNDETECTABLE_TYPE`, `QUOTA_EXCEEDED`, `VIRUS_DETECTED`, …) |
| 413 | `CATALOG_FILE_TOO_LARGE` | A file exceeds the caller's role size limit |

---

## POST `/files/upload/video`

**Purpose**: Upload video files on a dedicated route (`mp4`, `mov`, `webm`).

**Content-Type**: `multipart/form-data` · **Form field**: `videos`.

- **Per-file size limit**: 70 MB.
- **Per-actor count limit**: customers max **1**, all other roles max **3**.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | No files, too many files, or unsupported type |
| 413 | `CATALOG_FILE_TOO_LARGE` | A video exceeds 70 MB |

---

## GET `/files`

**Purpose**: List the caller's uploaded files with pagination, name search, characteristic filtering
and sorting.

### Query parameters (see `ListFilesQuerySchema`)

| Param | Type | Notes |
|---|---|---|
| `page` | integer | ≥ 1, default `1` |
| `limit` | integer | 1–100 |
| `search` | string | name substring |
| `mimeType` / `category` | string | filter by content type / category |
| `provider` | string | `local` \| `firebase` \| `cloudinary` |
| `ownerType` | string | owner role/type |
| `minSize` / `maxSize` | integer | byte range |
| `startDate` / `endDate` | date | upload-date range |
| `sort` | string | field; prefix `-` for descending |

### Example success `200`

```json
{ "success": true, "data": [ { "id": "664file...", "originalName": "logo.png", "size": 12044, "...": "..." } ], "meta": { "total": 42, "page": 1, "limit": 20, "pages": 3 } }
```

---

## GET `/files/storage`

**Purpose**: Storage usage and plan-limit summary for the authenticated owner.

```json
{ "success": true, "data": { "usedBytes": 734003200, "limitBytes": 2147483648, "fileCount": 42, "plan": "pro" } }
```

---

## GET `/files/:id` · PATCH `/files/:id` · DELETE `/files/:id`

- **GET** — single file metadata. `404 NOT_FOUND` if not found / not owned.
- **PATCH** — update metadata; only `originalName` is editable. Body: `{ "originalName": "new-name.jpg" }`.
- **DELETE** — soft-delete (marks for garbage collection). **Only succeeds if the file has no live
  references** — a file still attached to a product/branding/ticket cannot be deleted until detached.

---

## Admin-only management

- `GET /files/orphans` — list files with no live references (older than a threshold), GC candidates.
- `DELETE /files/:id/permanent` — hard-delete. Best-effort storage delete: a storage failure is logged
  but does not roll back the DB delete.

## Business rules & notes

- The active storage backend is selected by `STORAGE_PROVIDER` (`local` | `firebase` | `cloudinary`);
  `url` shape varies by provider. For `local`, files are additionally served under `/api/files/<path>`.
- Files are **soft-deleted**; a daily cleanup worker performs detach → delete → alert.
- Upload a file first, then pass its returned `id` where a file is referenced (products, branding,
  KYC, ticket attachments).

## Related
- [../vendor/storage.md](../vendor/storage.md) · [../vendor/file-management.md](../vendor/file-management.md)
- [../auth/README.md](../auth/README.md)
