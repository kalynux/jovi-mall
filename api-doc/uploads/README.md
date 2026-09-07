# Files & Uploads (all roles)

**Verified against source on 2026-09-08** — every route, request shape, response shape, query
parameter and error code below, against `jovi-mall/src/api/routes/file-upload.routes.ts`,
`src/api/controllers/file-upload.controller.ts`,
`src/api/controllers/file-management.controller.ts`,
`src/api/validators/file-management.validator.ts`, `src/core/uploads/`,
`src/core/storage/storage-trees.ts`,
`src/modules/catalog/read-models/file-detail.resolver.ts` and `src/api/index.ts`.

The `/api/files` surface is **shared by every authenticated role** (customer, vendor, agency, agent),
with per-role size limits. Uploaded files are referenced elsewhere by their returned `id`
(product images, vendor/agency branding, KYC documents, ticket attachments, etc.).

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required on every route (`requireAuth`) — cookie or `Bearer`.
- **Permissions**: **no role guard at all.** Any authenticated role reaches every route on this
  router; ownership is enforced per record inside the handlers.
- **Response envelope**: standard `{ success, data, meta?, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

> This is the role-neutral contract. Vendor-specific storage/quota details are in
> [../vendor/storage.md](../vendor/storage.md) and [../vendor/file-management.md](../vendor/file-management.md).

## Endpoints

**Seven routes, and there is no admin half any more.**

| Method | Path | Purpose | Permissions |
|---|---|---|---|
| `POST` | `/files/upload` | Upload 1–10 files (multipart, field `files`) | any authenticated |
| `POST` | `/files/upload/video` | Upload videos (multipart, field `videos`) | any authenticated |
| `GET` | `/files` | List your own files (search / filter / paginate / sort) | any authenticated |
| `GET` | `/files/storage` | Storage usage + plan limit summary | any authenticated |
| `GET` | `/files/:id` | Single file metadata + where it is used | any authenticated (owner) |
| `PATCH` | `/files/:id` | Update file metadata (`originalName` only) | any authenticated (owner) |
| `DELETE` | `/files/:id` | Soft-delete (only if no live references) | any authenticated (owner) |
| `GET` | `/files/<tree>/<path>` | Static file serving — **the 11 public trees only** | (served by `express.static`) |

⚠ **`GET /files/orphans` and `DELETE /files/:id/permanent` are not on this router.** They were its
only two `requireRole(['admin'])` routes and Phase 5 Part B moved them to
`/api/internal/admin/files`, behind the internal service token — a surface no dashboard session can
reach. **A "permanently delete" button wired to `DELETE /api/files/:id/permanent` gets a 404.**
Soft-delete is the only delete a dashboard can perform. See
[../admin/internal-service-api.md](../admin/internal-service-api.md).

---

## POST `/files/upload`

**Purpose**: Upload 1–10 files in one multipart request.

**Content-Type**: `multipart/form-data` · **Form field**: `files` (repeatable, up to 10).

### Per-role size limit (per file)

A **coarse per-request ceiling only** — the per-MIME-type caps in the upload policy, and the
owner's plan storage quota, are stricter and are usually what actually binds.

| Role | Max size / file |
|---|---|
| Customer | 100 MB |
| Agency | 200 MB |
| Vendor | 500 MB |
| Agent | 1 GB |
| Admin | 2 GB |

An unrecognised role falls back to the **customer** limit (100 MB).

### Example success `201`

```json
{
  "success": true,
  "data": [
    {
      "id": "664file0000000000000001",
      "key": "images/2026/07/9f2c1a30-4d21-4a3e-bb70-1d5f0c2b7a44_product-front.jpg",
      "provider": "local",
      "mimeType": "image/jpeg",
      "size": 254013,
      "checksum": "9d5ed678fe57bcca610140957afab5238ac5da932b8c1f4d1e4f7c2f0a3f7b2c",
      "originalName": "product-front.jpg",
      "ownerType": "vendor",
      "ownerId": "664vendor00000000000001",
      "orphanedAt": null,
      "quotaBlockedAt": null,
      "createdAt": "2026-07-17T10:20:30.000Z",
      "updatedAt": "2026-07-17T10:20:30.000Z",
      "deletedAt": null,
      "purgeAt": null
    }
  ],
  "message": "Successfully uploaded 1 file(s)",
  "meta": { "count": 1, "roleLimit": "500 MB" }
}
```

⚠ **`data` is an array of file *records*, not `FileDetail` objects — they carry no `url` and no
`access` field.** The upload response goes out straight from the intake service and never passes
through the resolver, which is the only place on the platform where a URL is ever computed.

**So: upload, keep the `id`, attach the `id`, and render from whatever the owning entity gives you
back.** Do not build a display URL out of the upload response, and do not expect one there. See
[`FileDetail` vs the file record](#filedetail-vs-the-file-record) below.

⚠ `meta.roleLimit` is a **display string** (`"500 MB"`), not a byte count.

### Where a file is stored

This route is **general media intake**: you are not saying what the file is *for* (that is decided
later, when you attach the returned `id`), so each file is stored under the folder for **its own
detected media type** — `images/`, `videos/`, `audio/`, `documents/`, `archives/`, `other/`. The type
is taken from the file's actual bytes, not from the declared `Content-Type` or the extension, and
follows any conversion the pipeline applies (a `png` stored as `webp` still lands in `images/`).

⚠ Those folder names are **plural**, and they are *not* the values `?category=` takes on
`GET /files` — that filter is **singular** (`image`, `video`, …). The two taxonomies line up
one-to-one but the strings differ.

This is a storage-layout detail: always use the returned `id`, never a hand-built path.
Purpose-scoped folders (product media, digital assets, delivery proofs, system files) belong to their
own dedicated endpoints and carry their own role restrictions.

### Errors

Two different mechanisms answer here and they produce different codes. **Multer parses the multipart
before the handler runs**, so its own ceilings are hit first and answer without any `details`.

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | multer refused the multipart: a field name other than `files`, or more than 10 file parts. **No `details`.** |
| 413 | `CATALOG_FILE_TOO_LARGE` | a single part exceeded multer's hard **2 GB** ceiling. **No `details`.** |
| 413 | `UPLOAD_POLICY_VIOLATION` | the file is under 2 GB but over the **caller's role ceiling** — `details.violations[0].code` is `FILE_TOO_LARGE` |
| 400 | `UPLOAD_POLICY_VIOLATION` | every other refusal, including "no files attached" — `error.details.violations[]` lists each one with its own `code` |

⚠ **A vendor, agency or agent uploading an over-sized file gets `UPLOAD_POLICY_VIOLATION` at 413,
not `CATALOG_FILE_TOO_LARGE`** — their role ceilings are all below multer's 2 GB, so the handler
catches it first. Only an admin can reach the multer ceiling on this route.

⚠ **"No files attached" is `UPLOAD_POLICY_VIOLATION`, not `VALIDATION_ERROR`** —
`violations[0].code` is `NO_FILES_UPLOADED`. But a request that sent files under the *wrong field
name* is `VALIDATION_ERROR`, because multer rejected it before the handler could look. Two ways to
send nothing, two different answers.

The twelve per-file violation codes are `FILE_TOO_LARGE`, `MIME_NOT_ALLOWED`, `MIME_TYPE_MISMATCH`,
`UNDETECTABLE_TYPE`, `POLYGLOT_DETECTED`, `VIRUS_DETECTED`, `QUOTA_EXCEEDED`, `TOTAL_SIZE_EXCEEDED`,
`DUPLICATE_FILE`, `PERMISSION_DENIED`, `TOO_MANY_FILES` and `NO_FILES_UPLOADED`. Each entry is
`{ code, message, fileIndex?, metadata? }` — **drive your UI off `code`, never off `message`**, and
map `fileIndex` back to the file in your upload list so the reason shows inline. Full reference:
[../errors/README.md](../errors/README.md).

---

## POST `/files/upload/video`

**Purpose**: Upload video files on a dedicated route (`mp4`, `mov`, `webm`).

**Content-Type**: `multipart/form-data` · **Form field**: `videos`.

- **Per-file size limit**: 70 MB — **not** the role ceiling from the route above. A vendor's 500 MB
  allowance does not apply here.
- **Per-actor count limit**: customers max **1**, all other roles max **3**.
- `201` mirrors the shape above (file records, no `url`), with
  `meta: { count, perFileLimit: "70 MB" }`.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 413 | `CATALOG_FILE_TOO_LARGE` | a video exceeds 70 MB. Multer's ceiling is set to exactly the documented limit, so **this is the answer you actually get** — the handler's own size check is an unreachable backstop. **No `details`.** |
| 400 | `VALIDATION_ERROR` | a field name other than `videos`, or a **fourth** video part |
| 400 | `UPLOAD_POLICY_VIOLATION` | `NO_FILES_UPLOADED`; `TOO_MANY_FILES` (a **customer** sending 2 or 3); `MIME_NOT_ALLOWED` (anything that is not mp4/mov/webm) |

---

## GET `/files`

**Purpose**: List the caller's uploaded files with pagination, name search, characteristic filtering
and sorting. An unrecognised non-admin role is refused with `403 AUTH_FORBIDDEN` rather than falling
through to an unscoped listing.

### Example success `200`

```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "664file0000000000000001",
        "key": "images/2026/07/9f2c1a30-4d21-4a3e-bb70-1d5f0c2b7a44_logo.png",        "provider": "local",        "ownerType": "vendor",
        "provider": "local",
        "mimeType": "image/png",
        "size": 12044,
        "originalName": "logo.png",
        "ownerType": "vendor",
        "ownerId": "664vendor00000000000001",
        "orphanedAt": null,
        "quotaBlockedAt": null,
        "createdAt": "2026-07-17T10:20:30.000Z",
        "updatedAt": "2026-07-17T10:20:30.000Z",
        "deletedAt": null,
        "purgeAt": null
      }
    ],
    "storage": {
      "limitBytes": 1073741824,
      "usedBytes": 734003200,
      "remainingBytes": 339738624,
      "byCategory": { "image": { "bytes": 700000000, "count": 118 } }
    },
    "pagination": { "page": 1, "limit": 20, "total": 42, "pages": 3 }
  }
}
```

⚠ **Pagination lives inside `data`, not in `meta`.** This is one of the few list endpoints on the
platform that does not use the house `meta` envelope. Read `data.pagination`.

⚠ **This list includes soft-deleted rows.** The query is built from ownership plus your filters and
never excludes `deletedAt`; every id-scoped read on this router *does* exclude it. **Filter
`deletedAt === null` client-side**, or a file the user deleted reappears in a media browser. This is
a backend defect, recorded here rather than papered over.

### Query parameters (`ListFilesQuerySchema`)

| Param | Type | Notes |
|---|---|---|
| `page` | integer | ≥ 1, default `1` |
| `limit` | integer | **1–50**, default `20` |
| `search` | string | 1–255 chars; case-insensitive substring on `originalName` (escaped server-side) |
| `mimeType` | string | exact MIME string — **wins over `category`** |
| `category` | enum | `image` · `video` · `audio` · `document` · `archive` · `other` — **singular** |
| `provider` | enum | `local` · `s3` · `gcs` · `r2` · `firebase` · `cloudinary` |
| `ownerType` | enum | `vendor` · `admin` · `customer` · `agent` · `agency` · `system` |
| `minSize` / `maxSize` | integer | bytes; `minSize` above `maxSize` → `400 VALIDATION_ERROR` |
| `createdAfter` / `createdBefore` | date | upload-date range; out of order → `400 VALIDATION_ERROR` |
| `sortBy` | enum | `createdAt` (default) · `updatedAt` · `size` · `originalName` |
| `sortOrder` | enum | `asc` · `desc` (default `desc`) |

⚠ **There is no `sort` parameter, no `-` prefix convention, and no `startDate`/`endDate` here.**
Sorting is the `sortBy` + `sortOrder` pair. An unknown key is ignored by the schema, so
`?sort=-createdAt` silently does nothing rather than failing.

⚠ **`ownerType` does nothing for a dashboard caller.** Every non-admin is already scoped to their own
`ownerType`/`ownerId` before your filters apply. It exists for the admin caller who no longer
reaches this router.

⚠ **`provider` is effectively always `"local"`** — the intake service stamps that literal on every
new record regardless of `STORAGE_PROVIDER`. Filtering on any other value returns nothing.

---

## GET `/files/storage`

**Purpose**: Storage usage and plan-limit summary for the authenticated owner. The same `storage`
object that `GET /files` embeds, on its own.

```json
{
  "success": true,
  "data": {
    "limitBytes": 1073741824,
    "usedBytes": 734003200,
    "remainingBytes": 339738624,
    "byCategory": { "image": { "bytes": 700000000, "count": 118 } }
  }
}
```

- `limitBytes` and `remainingBytes` are **nullable**. `null` means *no cap applies*, which is the
  case for **customers** — they have no plan. Vendors, agencies and agents get their plan's cap.
- `byCategory` is keyed by the same six singular category names as `?category=` above, and only the
  categories the owner actually has appear.
- There is **no `fileCount` and no `plan` field.**
- A role with no owner scope (an admin) gets `403 AUTH_FORBIDDEN`.

Plan caps by role and tier: [../billing-plans-across-roles.md](../billing-plans-across-roles.md).

---

## GET `/files/:id` · PATCH `/files/:id` · DELETE `/files/:id`

**GET** — the file record, plus a `usage` object saying where it is referenced, so a UI can show what
would break before offering a delete:

```json
{
  "success": true,
  "data": {
    "id": "664file0000000000000001",
    "key": "images/2026/07/9f2c1a30-4d21-4a3e-bb70-1d5f0c2b7a44_logo.png",    "provider": "local",    "ownerType": "vendor",
    "mimeType": "image/png",
    "size": 12044,
    "usage": {
      "totalReferences": 2,
      "references": [
        { "entityType": "product", "entityId": "664prod00000000000001", "field": "fileIds", "label": "Blue kettle" },
        { "entityType": "store", "entityId": "664store0000000000001", "field": "logoFileId", "label": "Maison Kale" }
      ],
      "products": [ { "id": "664prod00000000000001", "title": "Blue kettle", "type": "physical", "status": "active" } ],
      "variants": [],
      "digitalAssets": []
    }
  }
}
```

`references[]` is the shape to build against — one entry per live reference, with a human-readable
`label`, covering **every** entity type (product, variant, digital asset, ticket, vendor, store,
agency, magazin, customer, agent, admin, shipment). An entity type with no label resolver still
appears, with a generic fallback label. The `products` / `variants` / `digitalAssets` arrays are
retained for older consumers only.

**PATCH** — update metadata; only `originalName` is editable (1–255 chars). Body:
`{ "originalName": "new-name.jpg" }`.

**DELETE** — soft-delete (marks for garbage collection). **Only succeeds if the file has no live
references** — a file still attached to a product, branding or a ticket cannot be deleted until it is
detached.

### Errors on all three

| Status | `error.code` | When |
|---|---|---|
| 404 | `CATALOG_FILE_NOT_FOUND` | no such file |
| 403 | `AUTH_FORBIDDEN` | the file exists but is not yours |
| 409 | `CATALOG_FILE_STILL_REFERENCED` | `DELETE` on a file that is still attached to something |

⚠ **404 and 403 are different answers.** "Not found or not owned" is not how this behaves — an
existing file you do not own tells you so.

---

## `FileDetail` vs the file record

These are two different shapes, and mixing them up is the most common mistake on this surface.

- **The file record** is what `/api/files/*` returns: `{ id, key, provider, mimeType, size,
  checksum?, originalName?, ownerType?, ownerId?, orphanedAt, quotaBlockedAt, createdAt, updatedAt,
  deletedAt, purgeAt }`. **No `url`, no `access`.**
- **`FileDetail`** is what every *other* entity returns when it references a file — a vendor avatar, a
  store logo or banner, product images, a delivery proof:
  `{ id, key, url, access, mimeType, size, originalName? }`. It is built in exactly one place on the
  platform, and that is the only place a URL is ever computed.

```json
{
  "id": "664file0000000000000001",
  "key": "images/2026/08/9f2c1a30-4d21-4a3e-bb70-1d5f0c2b7a44_front.jpg",
  "url": "http://localhost:8022/api/files/images/2026/08/9f2c1a30-4d21-4a3e-bb70-1d5f0c2b7a44_front.jpg",
  "access": "public",
  "mimeType": "image/jpeg",
  "size": 284119,
  "originalName": "front.jpg"
}
```

**`access` has three values, and `url` is `null` for two of them.** Branch on `access`; never assume
`url` is a string.

| `access` | `url` | What it means, and what to render |
|---|---|---|
| `"public"` | a real URL | Ordinary media. Render it. |
| `"authorized"` | **`null`** | The file is in a private tree. It is **not** on any static path — a hand-built URL 404s. The bytes come from the owning entity's own authorized route, keyed on `id`. |
| `"quota_blocked"` | **`null`** | The owner is over their plan's storage allowance and this file falls outside it. **Nothing was deleted, nothing is private, and it is not the owner's fault at upload time.** Render a placeholder and a link to the plan page — never a broken image, and never "file missing". It comes back unchanged the moment they upgrade or free room. |

⚠ **`quota_blocked` outranks `authorized`.** A blocked file inside a private tree reports
`quota_blocked`, not `authorized` — otherwise a client would go to the authorized route to find out
what was wrong and be told about permissions when the real answer is billing.

⚠ **`originalName` is optional and is omitted from the JSON entirely when absent** — it is not set to
`null`. Use optional chaining, not a null check.

⚠ Because the tree classifier fails closed (below), **your type must stay `string | null` even for
product imagery**. A storage tree added later is `url: null` until somebody classifies it.

---

## Rendering a `url` — do NOT set `crossOrigin`

A public file's `url` points at the API host, so every dashboard renders it cross-origin. Render it
with a plain tag:

```html
<img src={file.url} />          <!-- correct -->
<img src={file.url} crossOrigin="anonymous" />   <!-- do not -->
```

Public file responses carry `Cross-Origin-Resource-Policy: cross-origin`, which is what lets a
no-cors subresource load (a plain `<img>`, `<video>`, `<audio>`) paint from any origin — no CORS,
no `Origin` header, nothing that has to be allowlisted. Every other response in this service keeps
helmet's `same-origin`.

Adding `crossOrigin` turns the load into a CORS request instead, which then requires the API to name
your exact origin in `ALLOWED_ORIGINS` — a standing dependency on a backend env var for something as
ordinary as an avatar, and one that fails on any client whose origin is not in that list (a packaged
Capacitor build, a new subdomain, a preview deploy). The attribute buys only un-tainted canvas
readback; if you need that, fetch the bytes through the API.

> **This failure reads as a CORS problem and is not one.** `ALLOWED_ORIGINS` can name your origin,
> the response can carry a perfectly good `Access-Control-Allow-Origin`, and the image still does not
> paint — because a no-cors request never consults `Access-Control-Allow-Origin`.

**A bearer client (a Capacitor WebView) cannot use an `<img>` tag for anything behind an authorized
route.** Fetch those bytes with the `Authorization` header and turn the response into a blob URL; the
tag will not carry the header.

## Business rules & notes

- The active storage backend is selected by `STORAGE_PROVIDER` (`local` | `firebase` | `cloudinary`);
  `url` shape varies by provider. For `local`, files are additionally served under
  `/api/files/<tree>/<path>` — but **only for the eleven PUBLIC trees**, and the mount is per-tree,
  not a single static mount over `storage/` (derived from `PUBLIC_STORAGE_TREES`). Fourteen trees are
  classified in all:
  - **Public** (`access: "public"`, real `url`): `images`, `videos`, `audio`, `documents`,
    `archives`, `other`, `products`, `variants`, `vendor-policy-documents`,
    `agency-policy-documents`, `system`.
  - **Private** (`access: "authorized"`, `url: null`, **served by no static path at all**):
    `digital`, `shipments`, `ticket-attachments`.
  - **An unclassified tree is treated as private** — the classifier fails closed deliberately.
- **`quota_blocked` is reversible and lossless.** The row, the bytes, and the file's contribution to
  the owner's `usedBytes` all survive; blocking is what the owner gets *instead* of losing data. It
  is written only by the plan-quota sweep — oldest files survive, newest are blocked first — and
  lifted in the reverse order. See
  [../FRONTEND-CHANGELOG-plan-quota.md](../FRONTEND-CHANGELOG-plan-quota.md).
- Files are **soft-deleted**; a daily cleanup worker performs detach → delete → alert. A file
  uploaded and never attached becomes an orphan and is eventually swept — **attach the `id` in the
  same session you uploaded it**, not a day later.
- Upload a file first, then pass its returned `id` where a file is referenced (products, branding,
  KYC, ticket attachments). The backend authorises the id against the caller **before** the write, so
  an unauthorised or non-existent id fails the whole request with nothing persisted.

## Related
- [../vendor/storage.md](../vendor/storage.md) · [../vendor/file-management.md](../vendor/file-management.md)
- [../errors/README.md](../errors/README.md) · [../billing-plans-across-roles.md](../billing-plans-across-roles.md)
- [../auth/README.md](../auth/README.md)
