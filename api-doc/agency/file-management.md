# Agency File Management

The delivery agency's media library. File upload, listing, view, rename and
delete run through the **shared** `/api/files` surface (the same endpoints every
role uses), automatically scoped to the authenticated agency.

> This page is the agency-scoped summary. For the complete, role-neutral request/
> response contract (filters, sorting, `File` shape, deletion semantics) see
> [Uploads (role-neutral)](../uploads/README.md) and
> [Vendor → File Management](../vendor/file-management.md) — the contract is
> identical, only the owner scope differs. For the storage cap + usage widget see
> [Storage](./storage.md).

## Authentication
Bearer token / cookie session with the **agency** role. Every endpoint below is
scoped to the caller — an agency only ever sees and manages **files it owns**
(`ownerType: "agency"`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/files/upload` | Upload 1–10 files (`multipart/form-data`, field `files`). Owner-stamped `agency`. |
| `POST` | `/api/files/upload/video` | Upload 1–3 videos (field `videos`; mp4/mov/webm, ≤70 MB each). Owner-stamped `agency`. |
| `GET` | `/api/files` | List the agency's own files (paginated, filterable by `category`, `mimeType`, name `search`, size/date ranges). Includes the `storage` summary. |
| `GET` | `/api/files/storage` | Usage + plan limit summary (see [Storage](./storage.md)). |
| `GET` | `/api/files/:id` | One file's metadata + where it is referenced (`usage`). |
| `PATCH` | `/api/files/:id` | Rename (`originalName` only). |
| `DELETE` | `/api/files/:id` | Soft-delete. Blocked with `409 CATALOG_FILE_STILL_REFERENCED` while the file is still attached (e.g. to the magazin logo) — detach first. |

Notes specific to the agency:
- Uploaded files are referenced elsewhere by their returned `id` — e.g. the
  agency avatar (`PATCH /api/agency/profile`) and the magazin logo
  (`PATCH /api/agency/magazin`, field `logoFileId`).
- `POST /api/files/upload` is open to the agency for **every** allowed type
  (images, documents, archives, audio; videos on the dedicated route). Each file
  is stored under the folder for its own detected type — `images/`, `documents/`
  … — so the returned `key` is not a purpose, just a storage path: reference the
  file by `id` and display it by `url`.
- **Agent delivery proofs** are agency-owned files but are **not** uploaded or
  deleted here — the agent manages them through
  `/api/agent/shipments/:id/delivery-proof` (see [Agent → Delivery proof](../agent/delivery-proof.md)).
  They do appear in the agency's storage usage and, when referenced, block a raw
  delete the same way any referenced file does.
- Every referenced file is returned as a `FileDetail`
  (`{ id, key, url, mimeType, size, originalName }`), never a bare URL string.

## Response envelope
Standard `{ success, data, meta? }` on success; `{ success:false, error:{ code, message, details? } }`
on failure. See the [API index](../README.md).
