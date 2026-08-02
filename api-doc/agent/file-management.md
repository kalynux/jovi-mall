# Agent File Management

The agent's personal media library, on the shared `/api/files` surface, scoped to
the authenticated agent (`ownerType: "agent"`).

> Role-neutral contract (filters, `File` shape, deletion semantics):
> [Uploads](../uploads/README.md) and [Vendor → File Management](../vendor/file-management.md).
> Storage cap + usage widget: [Storage](./storage.md).
> The optional **delivery-proof** photo is a separate, shipment-scoped surface
> (charged to the agency): [Delivery proof](./delivery-proof.md).

## Authentication
Bearer token / cookie session with the **agent** role.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/files/upload` | Upload 1–10 files (field `files`). Owner-stamped `agent`. |
| `POST` | `/api/files/upload/video` | Upload 1–3 videos (field `videos`; mp4/mov/webm, ≤70 MB each). Owner-stamped `agent`. |
| `GET` | `/api/files` | List the agent's own files (paginated, filterable). Includes the `storage` summary. |
| `GET` | `/api/files/storage` | Usage + plan limit summary ([Storage](./storage.md)). |
| `GET` | `/api/files/:id` | One file's metadata + `usage`. |
| `PATCH` | `/api/files/:id` | Rename (`originalName`). |
| `DELETE` | `/api/files/:id` | Soft-delete (blocked while still referenced). |

Files are referenced elsewhere by their returned `id` (e.g. the agent avatar).
Every referenced file is returned as a `FileDetail`
(`{ id, key, url, mimeType, size, originalName }`).

`POST /api/files/upload` accepts every allowed type (images, documents, archives,
audio; videos on the dedicated route) and stores each file under the folder for
its own detected type — `images/`, `documents/` … The `key` is a storage path,
not a purpose: reference a file by `id`, display it by `url`.

A file the agent does **not** own (e.g. a delivery proof, which is agency-owned)
returns `403` from `GET/PATCH/DELETE /api/files/:id` — manage those through the
delivery-proof endpoints instead.
