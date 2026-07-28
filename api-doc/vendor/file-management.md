# File Management Service API Documentation

**Version:** 1.2  
**Last Updated:** 2026-06-11  
**Audience:** Frontend Developers, Backend Engineers, Platform Documentation

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture & Concepts](#architecture--concepts)
3. [API Endpoints](#api-endpoints)
4. [File Lifecycle](#file-lifecycle)
5. [Data Models](#data-models)
6. [Ownership & Linking Rules](#ownership--linking-rules)
7. [Storage Provider Abstraction](#storage-provider-abstraction)
8. [Deletion Semantics](#deletion-semantics)
9. [Security & Access Control](#security--access-control)
10. [Error Handling](#error-handling)
11. [Frontend Integration Guide](#frontend-integration-guide)

---

## Overview

The **File Management Service** is an enterprise-grade, multi-tenant file storage and management system designed for the Jovi Mall marketplace platform. It provides:

- **Provider-agnostic storage** (local, S3, GCS, R2, Firebase, Cloudinary)
- **Role-based upload limits** (100MB - 2GB per file)
- **Dedicated video upload route** (`/api/files/upload/video`, mp4/mov/webm, 70MB per video)
- **Reference-counted file lifecycle** with safe garbage collection
- **Multi-tenant isolation** with ownership tracking
- **File sharing** across products, variants, and digital assets
- **Soft & hard deletion** with best-effort cleanup

### Key Design Principles

1. **Database is Source of Truth**: All file metadata lives in the database; storage is best-effort
2. **Storage Independence**: Business logic never depends on specific storage providers
3. **Safe File Reuse**: Multiple entities can reference the same file via `usageCount`
4. **Ownership Immutability**: File owner is set on upload and never changes
5. **Authorization First**: Strict access control prevents cross-tenant file access

---

## Architecture & Concepts

### Core Entities

#### File (Media)
First-class database entity representing a stored file with provider-agnostic metadata.

**Key Properties:**
- [id](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#74-80): Unique identifier
- `key`: Provider-specific storage key (path or object ID)
- `provider`: Storage backend type
- `usageCount`: Reference count for safe cleanup
- `ownerType` + `ownerId`: Original uploader (immutable)

#### Owner vs Reference
- **Owner**: The actor (vendor, customer, admin) who uploaded the file
- **Reference**: The entity (product, variant) that links to the file

**Critical Distinction**: Files do NOT belong to products or variants. They belong to actors (vendors, admins, etc.). Products and variants **reference** files via `fileIds` arrays.

### Upload Flow
```
Client Request
    ↓
File Upload Controller (auth + role-based limits)
    ↓
UploadIntakeService (main entry point)
    ↓
├─ UploadPolicyEngine (validation + security)
│   ├─ File sniffing (detect real MIME type)
│   ├─ Fingerprinting (checksum + duplicate detection)
│   └─ Virus scanning (optional)
├─ Image Processors (resize, convert, compress)
├─ Storage Provider (put file)
└─ File Repository (create DB record)
    ↓
Return File entities
```

### Reference Counting
Files track how many entities reference them via `usageCount`:
- **Increment**: When file is attached to product/variant (or a digital asset is created)
- **Decrement**: When file is detached from product/variant (or a digital asset is deleted)
- **Atomic**: Uses MongoDB `$inc` operator to prevent race conditions
- **Deletion Rule**: Files can only be soft-deleted when `usageCount === 0`

**How counts are maintained:** The catalog write endpoints treat `fileIds` as a
full-array replacement and reconcile the difference against `usageCount`:

| Endpoint                                                  | Effect on counts                                              |
|-----------------------------------------------------------|--------------------------------------------------------------|
| `POST /api/vendor/products` (with `fileIds`)              | Increments each attached file.                               |
| `PATCH /api/vendor/products/:id` (`fileIds`)              | Increments newly-added, decrements removed.                  |
| `PATCH /api/vendor/products/:pid/variants/:vid` (`fileIds`)| Increments newly-added, decrements removed.                 |
| `POST /api/vendor/products/:id/duplicate`                 | Increments each file the clone inherits.                     |
| Digital asset upload / delete                             | Increments on upload, decrements on delete.                  |

Newly-attached files are authorized before they are persisted: a file must be
owned by the acting vendor (or be a `system` file), otherwise the request is
rejected with `403`.

> **Legacy data note:** attachments created before reference-counting was
> enforced have `usageCount: 0`. The first detach of such a file is tolerated
> (the decrement is skipped rather than erroring), so existing products remain
> editable. A one-off backfill is required to make historical counts exact.

---

## API Endpoints

All file endpoints require authentication. Base path: `/api/files`

### File Upload

#### POST /api/files/upload

Upload 1-10 files with role-based size limits.

**Authentication:** Required (all authenticated users)

**Request Headers:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Request Body (FormData):**
```
files: File[] (max 10 files)
```

**Role-Based Size Limits:**
| Role     | Max File Size |
|----------|---------------|
| Vendor   | 500 MB        |
| Agent    | 1 GB          |
| Admin    | 2 GB          |
| Customer | 100 MB        |

**Success Response (201):**
```json
{
  "success": true,
  "data": [
    {
      "id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "key": "products/2026/02/13/550e8400-e29b-41d4-a716-446655440000.jpg",
      "provider": "local",
      "mimeType": "image/jpeg",
      "size": 2048576,
      "checksum": "d41d8cd98f00b204e9800998ecf8427e",
      "originalName": "product-photo.jpg",
      "usageCount": 0,
      "ownerType": "vendor",
      "ownerId": "65e1a2b3c4d5e6f7a8b9c0d1",
      "createdAt": "2026-02-13T06:13:51Z",
      "updatedAt": "2026-02-13T06:13:51Z"
    }
  ],
  "message": "Successfully uploaded 1 file(s)",
  "meta": {
    "count": 1,
    "roleLimit": "500 MB"
  }
}
```

**Error Responses:**

**400 - No Files Uploaded:**
```json
{
  "success": false,
  "error": {
    "code": "NO_FILES_UPLOADED",
    "message": "At least one file is required"
  }
}
```

**400 - Too Many Files:**
```json
{
  "success": false,
  "error": {
    "code": "TOO_MANY_FILES",
    "message": "Maximum 10 files per request"
  }
}
```

**413 - File Too Large:**
```json
{
  "success": false,
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "File \"large-photo.jpg\" exceeds vendor limit of 500 MB"
  }
}
```

**400 - Upload Policy Violation:**

Unlike the three errors above (which are returned directly by the controller with a
minimal `{ code, message }` body), the policy-violation error flows through the
**global error handler**, so it follows the [standard error envelope](../errors/README.md)
— it includes `requestId`, `statusCode`, and a `details.violations` array that
explains, **per file**, exactly what failed. Use `details.violations` to drive
per-file UI messaging rather than the generic top-level `message`.

```json
{
  "success": false,
  "requestId": "req-7f3c9a2b",
  "error": {
    "code": "UPLOAD_POLICY_VIOLATION",
    "message": "Upload policy violations found",
    "statusCode": 400,
    "details": {
      "violations": [
        {
          "code": "MIME_NOT_ALLOWED",
          "message": "File type not allowed: application/x-executable",
          "fileIndex": 0,
          "metadata": { "detectedMimeType": "application/x-executable" }
        },
        {
          "code": "DUPLICATE_FILE",
          "message": "This file has already been uploaded",
          "fileIndex": 2
        }
      ]
    }
  }
}
```

**`details.violations[]` shape:**

| Field        | Type     | Description                                                                                  |
|--------------|----------|----------------------------------------------------------------------------------------------|
| `code`       | string   | Machine-readable violation reason (see table below). Drive UI/i18n off this, not `message`.  |
| `message`    | string   | Human-readable fallback message for this specific violation.                                 |
| `fileIndex`  | number?  | 0-based index into the uploaded `files` array this violation applies to. Absent for request-wide violations (e.g. `TOTAL_SIZE_EXCEEDED`, `QUOTA_EXCEEDED`). |
| `metadata`   | object?  | Optional extra context (e.g. detected MIME type, size, limit) for richer messaging.          |

**Violation `code` values:**

| Code                  | Meaning                                                                 |
|-----------------------|-------------------------------------------------------------------------|
| `FILE_TOO_LARGE`      | A file exceeds the configured size limit.                               |
| `MIME_NOT_ALLOWED`    | The detected MIME type is not in the allow-list.                        |
| `TOO_MANY_FILES`      | More files than the per-request limit.                                  |
| `QUOTA_EXCEEDED`      | The actor's storage quota would be exceeded. For vendors this is the plan's `max_storage_bytes` (digital-product assets excluded). |
| `VIRUS_DETECTED`      | Virus scanner flagged the file.                                         |
| `PERMISSION_DENIED`   | The actor is not permitted to upload this file.                         |
| `TOTAL_SIZE_EXCEEDED` | Combined size of all files in the request exceeds the limit.            |
| `DUPLICATE_FILE`      | The file (by checksum) was already uploaded.                            |
| `MIME_TYPE_MISMATCH`  | Declared MIME type does not match the sniffed content.                  |
| `POLYGLOT_DETECTED`   | File is a polyglot (valid as multiple types) — rejected as unsafe.      |
| `UNDETECTABLE_TYPE`   | The real file type could not be determined.                             |

> Because multiple files are validated together, a single request can return
> several violations across different `fileIndex` values. Show each file's own
> error next to its preview using `fileIndex`.

**Side Effects:**
1. File uploaded to storage provider
2. File metadata record created in database
3. `usageCount` initialized to 0
4. `ownerType` and `ownerId` set based on authenticated user
5. Upload security pipeline executed (sniffing, fingerprinting, virus scan)

> **Videos are NOT accepted here.** The general `/api/files/upload` allowlist
> only covers images, documents, archives, and audio. Upload videos through the
> dedicated [`POST /api/files/upload/video`](#post-apifilesuploadvideo) route
> below. Everything *after* upload (reading, updating, deleting, attaching to a
> ticket/product) is identical — a video produces a normal `File` with a `fileId`.

---

#### POST /api/files/upload/video

Upload **video** files on a dedicated route. Kept separate from
`POST /api/files/upload` so enabling video never loosens the general image/doc
allowlist. A successful upload returns the same `File` objects as the general
endpoint, so the resulting `fileId`(s) are read, updated, deleted, and attached
to tickets/products through the exact same endpoints documented elsewhere in
this file.

**Authentication:** Required (all authenticated users)

**Request Headers:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Request Body (FormData):**
```
videos: File[]   (field name MUST be "videos")
```

**Accepted formats** (validated by magic-byte sniffing, not the filename or the
client `Content-Type`):

| Format | MIME type         | Extension |
|--------|-------------------|-----------|
| MP4    | `video/mp4`       | `.mp4`    |
| QuickTime | `video/quicktime` | `.mov` |
| WebM   | `video/webm`      | `.webm`   |

**Limits:**

| Constraint            | Value                                            |
|-----------------------|--------------------------------------------------|
| Max size **per video**| **70 MB**                                        |
| Videos per request    | **Customers: 1**, all other actors (vendor, agent, agency, admin): **3** |

**Success Response (201):**
```json
{
  "success": true,
  "data": [
    {
      "id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "key": "videos/2026/06/13/550e8400-e29b-41d4-a716-446655440000.mp4",
      "provider": "local",
      "mimeType": "video/mp4",
      "size": 51457280,
      "checksum": "d41d8cd98f00b204e9800998ecf8427e",
      "originalName": "demo-clip.mp4",
      "usageCount": 0,
      "ownerType": "vendor",
      "ownerId": "65e1a2b3c4d5e6f7a8b9c0d1",
      "createdAt": "2026-06-13T06:13:51Z",
      "updatedAt": "2026-06-13T06:13:51Z"
    }
  ],
  "message": "Successfully uploaded 1 video(s)",
  "meta": {
    "count": 1,
    "perFileLimit": "70 MB"
  }
}
```

**Error Responses:**

**400 - No Files Uploaded:**
```json
{
  "success": false,
  "error": {
    "code": "NO_FILES_UPLOADED",
    "message": "At least one video file is required (field name \"videos\")"
  }
}
```

**400 - Too Many Files** (exceeds the per-actor count):
```json
{
  "success": false,
  "error": {
    "code": "TOO_MANY_FILES",
    "message": "Maximum 1 video(s) per request for customer"
  }
}
```

**400 - Unsupported Type** (claimed type is not mp4/mov/webm):
```json
{
  "success": false,
  "error": {
    "code": "FILE_TYPE_INVALID",
    "message": "File \"notes.pdf\" (application/pdf) is not a supported video. Allowed: mp4, mov, webm"
  }
}
```

**413 - File Too Large** (a video exceeds 70 MB). Returned either directly by the
controller or, when the stream is aborted mid-parse, normalised from a multer
`LIMIT_FILE_SIZE` error by the global error handler (so this variant carries the
standard `requestId`/`statusCode` envelope):
```json
{
  "success": false,
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "Video \"big.mp4\" exceeds the 70 MB limit"
  }
}
```

**400 - Upload Policy Violation:** Identical shape and `details.violations[]`
semantics as `POST /api/files/upload` — see that section above. A file that
**claims** a video MIME type but **sniffs** to something else (e.g. an `.exe`
renamed `.mp4`) is rejected here with `MIME_NOT_ALLOWED` / `MIME_TYPE_MISMATCH`.

**Side Effects:** Same as `POST /api/files/upload` — the file is stored under the
`videos/` folder, a `File` record is created with the **detected** MIME type, and
the full security pipeline (sniffing, fingerprinting, virus scan, quota, dedup)
runs. Videos count against the same per-user storage quota as other media.

---

### File Retrieval

#### GET /api/files

List files uploaded by the authenticated user (admins see all files). Supports
**name search**, **characteristic filtering**, and **sorting**. All parameters
are optional and combine with AND semantics (a file must match every supplied
filter). Filters always apply *on top of* the ownership scope, so non-admins can
only ever search/filter within their own files.

**Authentication:** Required

**Query Parameters:**
| Parameter      | Type   | Required | Default     | Description                                                                                 |
|----------------|--------|----------|-------------|---------------------------------------------------------------------------------------------|
| page           | number | No       | 1           | Page number (min: 1)                                                                         |
| limit          | number | No       | 20          | Items per page (1-50)                                                                        |
| search         | string | No       | -           | Case-insensitive substring match on `originalName` (1-255 chars). Special chars are escaped. |
| mimeType       | string | No       | -           | Filter by exact MIME type (e.g. `image/jpeg`). Takes precedence over `category`.            |
| category       | enum   | No       | -           | Broad media category: `image`, `video`, `audio`, `document`, `archive`, `other`. Ignored if `mimeType` is set. |
| provider       | enum   | No       | -           | Filter by storage provider (`local`, `s3`, `gcs`, `r2`, `firebase`, `cloudinary`).          |
| ownerType      | enum   | No       | -           | Filter by uploader type (`vendor`, `admin`, `customer`, `agent`, `agency`, `system`). Mainly useful for admins. |
| minSize        | number | No       | -           | Minimum file size in **bytes** (inclusive).                                                  |
| maxSize        | number | No       | -           | Maximum file size in **bytes** (inclusive).                                                  |
| createdAfter   | date   | No       | -           | Only files uploaded on/after this ISO-8601 date.                                             |
| createdBefore  | date   | No       | -           | Only files uploaded on/before this ISO-8601 date.                                            |
| sortBy         | enum   | No       | `createdAt` | Sort field: `createdAt`, `updatedAt`, `size`, `originalName`.                                |
| sortOrder      | enum   | No       | `desc`      | Sort direction: `asc` or `desc`.                                                             |

**Media category → MIME mapping (`category`):**

| Category   | Matches                                                                                                   |
|------------|-----------------------------------------------------------------------------------------------------------|
| `image`    | Any `image/*` MIME type.                                                                                   |
| `video`    | Any `video/*` MIME type.                                                                                   |
| `audio`    | Any `audio/*` MIME type.                                                                                   |
| `document` | PDF, Word, Excel, PowerPoint (legacy + OOXML), RTF, plain text, CSV.                                       |
| `archive`  | ZIP, RAR, 7z, TAR, GZIP.                                                                                   |
| `other`    | Anything not matched by the categories above (negation of all known image/video/audio/document/archive types). |

**Validation:**
- `minSize` must be ≤ `maxSize` when both are provided (`400 VALIDATION_ERROR` otherwise).
- `createdAfter` must be on/before `createdBefore` when both are provided (`400 VALIDATION_ERROR` otherwise).

**Example Requests:**
```http
# Search owned files by name
GET /api/files?search=invoice

# All images larger than 1 MB, newest first
GET /api/files?category=image&minSize=1048576&sortBy=createdAt&sortOrder=desc

# PDFs uploaded in May 2026, sorted by name
GET /api/files?category=document&createdAfter=2026-05-01&createdBefore=2026-05-31&sortBy=originalName&sortOrder=asc

# Admin: every vendor-owned file on Cloudinary
GET /api/files?ownerType=vendor&provider=cloudinary
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "65f1a2b3c4d5e6f7a8b9c0d1",
        "key": "products/2026/02/13/file.jpg",
        "provider": "local",
        "mimeType": "image/jpeg",
        "size": 2048576,
        "originalName": "product-photo.jpg",
        "usageCount": 2,
        "ownerType": "vendor",
        "ownerId": "65e1a2b3c4d5e6f7a8b9c0d1",
        "createdAt": "2026-02-13T06:00:00Z",
        "updatedAt": "2026-02-13T06:00:00Z"
      }
    ],
    "storage": {
      "limitBytes": 10737418240,
      "usedBytes": 2147483648,
      "remainingBytes": 8589934592,
      "byCategory": {
        "image":    { "bytes": 1048576000, "count": 320 },
        "video":    { "bytes": 1090519040, "count": 12 },
        "document": { "bytes": 8388608,    "count": 5 },
        "audio":    { "bytes": 0,          "count": 0 },
        "archive":  { "bytes": 0,          "count": 0 },
        "other":    { "bytes": 0,          "count": 0 }
      }
    },
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "pages": 3
    }
  }
}
```

**`storage` block:** owner-scoped media usage analytics, returned for **vendor / customer / agent** callers (and **omitted — `null` — for admins**, whose listing is global). See the **[Vendor Media Storage guide](./storage.md)** for the full storage feature (limits, alerts, quota errors, lifecycle). `usedBytes` is the total of `byCategory` bytes. For **vendors**, `limitBytes` is the active plan's media storage limit (`max_storage_bytes`) and `remainingBytes = max(0, limitBytes − usedBytes)`; for other roles `limitBytes`/`remainingBytes` are `null`. **Digital-product asset files are excluded** from these figures (they have their own 500 MB/asset cap, independent of plan). Categories follow the same `category` mapping used for filtering.

**Authorization Rules:**
- **Vendors**: See only files where `ownerType === 'vendor'` and `ownerId === vendorId`
- **Customers**: See only files where `ownerType === 'customer'` and `ownerId === userId`
- **Agents**: See only files where `ownerType === 'agent'` and `ownerId === agentId`
- **Admins**: See ALL files (no ownership filter)

---

#### GET /api/files/storage

Lightweight storage usage + plan limit summary for the authenticated owner — the same `storage` object embedded in `GET /api/files`, without the file list. Use it for a storage usage widget.

**Authentication:** Required (vendor / customer / agent). Admins receive `403 FORBIDDEN` (no owner scope).

**Success Response (200):**
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

For vendors, `limitBytes` is the plan's `max_storage_bytes`; for customer/agent it is `null`. When a vendor's media upload would exceed `limitBytes`, the upload is rejected with a `QUOTA_EXCEEDED` policy violation.

---

#### GET /api/files/:id

Retrieve metadata for a single file by ID.

**Authentication:** Required

**Path Parameters:**
- [id](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#74-80): File ID (MongoDB ObjectId)

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "key": "products/2026/02/13/file.jpg",
    "provider": "local",
    "mimeType": "image/jpeg",
    "size": 2048576,
    "checksum": "d41d8cd98f00b204e9800998ecf8427e",
    "originalName": "product-photo.jpg",
    "usageCount": 2,
    "ownerType": "vendor",
    "ownerId": "65e1a2b3c4d5e6f7a8b9c0d1",
    "createdAt": "2026-02-13T06:00:00Z",
    "updatedAt": "2026-02-13T06:00:00Z",
    "usage": {
      "totalReferences": 2,
      "references": [
        { "entityType": "product", "entityId": "65e1a2b3c4d5e6f7a8b9c0d2", "field": "media", "label": "Premium Cotton T-Shirt" },
        { "entityType": "store", "entityId": "65e1a2b3c4d5e6f7a8b9c0d9", "field": "logo", "label": "TechSolutions Store" }
      ],
      "products": [
        { "id": "65e1a2b3c4d5e6f7a8b9c0d2", "title": "Premium Cotton T-Shirt", "type": "physical", "status": "active" }
      ],
      "variants": [
        { "id": "65e1a2b3c4d5e6f7a8b9c0d3", "productId": "65e1a2b3c4d5e6f7a8b9c0d2", "sku": "TSHIRT-RED-M", "status": "active" }
      ],
      "digitalAssets": []
    }
  }
}
```

**The `usage` object** resolves *where* the file is referenced so a client can show what would break before deleting it:

| Field             | Description                                                            |
|-------------------|------------------------------------------------------------------------|
| `totalReferences` | Count of **every** live reference to this file, across all entity types. |
| `references`      | **Preferred, future-proof shape.** One entry per live reference: `{ entityType, entityId, field, label }`, where `label` is a human-readable name (product title, ticket subject, store/agency/vendor/customer/agent/admin name…). Covers **any** referencing entity — `product`, `variant`, `digital_asset`, `ticket`, `vendor`, `store`, `agency`, `customer`, `agent`, `admin`, and any type added later (which falls back to a generic label). `field` names the slot (`media`, `logo`, `banner`, `cover`, `avatar`, `attachment`). A profile avatar shows up here as `{ entityType: "<role>", field: "avatar" }` — which is why a file backing someone's avatar can't be deleted until they detach it. |
| `products`        | *(Legacy)* Products whose `fileIds` contain this file — kept for backward compatibility; prefer `references`. |
| `variants`        | *(Legacy)* Variants whose `fileIds` contain this file.                |
| `digitalAssets`   | *(Legacy)* Digital assets (downloadable goods) backed by this file.  |

> `totalReferences` is derived from the live `file_references` collection. `DELETE /api/files/:id` is rejected (409 `CATALOG_FILE_STILL_REFERENCED`) while `totalReferences > 0`.

**Error Responses:**

**404 - File Not Found:**
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "File not found"
  }
}
```

**403 - Access Denied:**
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have access to this file"
  }
}
```

**Authorization:**
- Non-admins can only view files they own
- Admins can view any file

---

### File Management

#### PATCH /api/files/:id

Update file metadata (only `originalName` is editable).

**Authentication:** Required  
**Authorization:** Owner or admin only

**Path Parameters:**
- [id](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#74-80): File ID

**Request Body:**
```json
{
  "originalName": "updated-filename.jpg"
}
```

**Validation:**
- `originalName`: 1-255 characters

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "65f1a2b3c4d5e6f7a8b9c0d1",
    "originalName": "updated-filename.jpg",
    "updatedAt": "2026-02-13T07:00:00Z"
  },
  "message": "File updated successfully"
}
```

**Error Responses:**
- **404**: File not found
- **403**: Access denied (not owner)
- **400**: Validation error

**Side Effects:**
1. `originalName` updated in database
2. `updatedAt` timestamp refreshed
3. No changes to storage provider

**Design Decision:** Only `originalName` is editable to prevent metadata corruption. Storage keys, checksums, and ownership are immutable.

---

#### DELETE /api/files/:id

Soft delete a file (mark for garbage collection).

**Authentication:** Required  
**Authorization:** Owner or admin only

**Path Parameters:**
- [id](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#74-80): File ID

**Success Response (200):**
```json
{
  "success": true,
  "message": "File deleted successfully"
}
```

**Error Responses:**

**404 - File Not Found:**
```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "File not found"
  }
}
```

**403 - Access Denied:**
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have access to this file"
  }
}
```

**409 - File In Use:**
```json
{
  "success": false,
  "error": {
    "code": "FILE_IN_USE",
    "message": "Cannot delete file that is still in use (usageCount: 3)"
  }
}
```

**Side Effects:**
1. `deletedAt` timestamp set in database
2. File marked for garbage collection
3. File remains in storage (cleanup handled by background job)

**Safety Rules:**
- Only files with `usageCount === 0` can be soft-deleted
- Prevents accidental deletion of files still referenced by products/variants
- Storage cleanup happens asynchronously

---

#### DELETE /api/files/:id/permanent

Permanently delete a file (admin only).

**Authentication:** Required  
**Authorization:** Admin only

**Path Parameters:**
- [id](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#74-80): File ID

**Success Response (200):**
```json
{
  "success": true,
  "message": "File permanently deleted"
}
```

**Error Responses:**
- **403**: Admin access required
- **404**: File not found

**Side Effects (Critical Order):**
1. **Database record deleted FIRST** (source of truth)
2. **Storage deletion attempted** (best-effort)
3. Logs error if storage delete fails but **DOES NOT ROLLBACK**

**Design Decision:** Database is the source of truth. If storage deletion fails (provider unavailable, network error), the database deletion is NOT rolled back. This prevents orphaned database records. Orphaned storage objects are handled by separate cleanup jobs.

**Retry Strategy:**
- No automatic retry on storage deletion failure
- Manual cleanup via storage provider console or scheduled jobs
- Logged for monitoring and alerting

---

### Admin Endpoints

#### GET /api/files/orphans

List orphaned files for garbage collection (admin only).

**Authentication:** Required  
**Authorization:** Admin only

**Query Parameters:**
| Parameter | Type | Required | Default   | Description                          |
|-----------|------|----------|-----------|--------------------------------------|
| olderThan | date | No       | 7 days ago| Files created before this date      |

**Validation:**
- `olderThan` must be at least 24 hours in the past (safety guardrail)

**Success Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "65f1a2b3c4d5e6f7a8b9c0d1",
      "key": "products/2026/02/06/old-file.jpg",
      "provider": "local",
      "usageCount": 0,
      "createdAt": "2026-02-06T10:00:00Z"
    }
  ],
  "meta": {
    "count": 12,
    "olderThan": "2026-02-06T07:13:51Z"
  }
}
```

**Orphan Criteria:**
- `usageCount === 0`
- Created before `olderThan` date
- Not soft-deleted (or include soft-deleted based on query)

**Error Responses:**
- **403**: Admin access required
- **400**: `olderThan` less than 24 hours ago

**Use Case:** Identify files uploaded but never attached to products/variants for manual or automated cleanup.

---

## File Lifecycle

### 1. File Initialization (Upload)

**Trigger:** `POST /api/files/upload`

**Process:**
1. **Authentication**: Verify user identity and role
2. **Role-based size check**: Validate file size against role limit
3. **Security pipeline**:
   - File sniffing (detect actual MIME type, ignore client-provided)
   - Fingerprinting (compute checksum, detect duplicates)
   - Virus scanning (optional, configurable)
4. **Image processing** (if applicable):
   - Resize (within max dimensions)
   - Format conversion (e.g., HEIC → JPEG)
   - Compression (optimize file size)
5. **Storage upload**: Write file to storage provider
6. **Database write**: Create file metadata record

**Database State:**
```json
{
  "usageCount": 0,
  "ownerType": "vendor",
  "ownerId": "65e1a2b3...",
  "deletedAt": null,
  "purgeAt": null
}
```

**What Happens on Partial Failure:**
- **Validation fails**: No storage write, no DB record → Safe
- **Storage upload fails**: No DB record created → Safe
- **DB write fails**: Storage object created but not tracked → Becomes orphaned storage (cleanup handled separately)

**Synchronous vs Asynchronous:**
- **Synchronous**: Authentication, validation, storage upload, DB write
- **Asynchronous**: Virus scan results (if configured for async), garbage collection

---

### 2. Metadata Persistence

**When:** Immediately after successful storage upload

**Fields Stored:**
- `key`: Storage provider key (e.g., `products/2026/02/13/uuid.jpg`)
- `provider`: Storage backend type (`local`, `s3`, etc.)
- `mimeType`: **Detected** MIME type (NOT client-provided)
- `size`: File size in bytes
- `checksum`: MD5/SHA256 hash for integrity
- `originalName`: Client-provided filename
- `usageCount`: Initialized to 0
- `ownerType` + `ownerId`: Set based on authenticated user

**Immutable Fields:** `key`, `provider`, `ownerType`, `ownerId`, `checksum`  
**Mutable Fields:** `originalName`, `usageCount`, `deletedAt`, `purgeAt`

---

### 3. Linking File to Domain Entities

**Domain Services:**
- [FileAttachService](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/catalog/domain/services/media/FileAttachService.ts#27-149): Attach file to product or variant
- `FileDetachService`: Detach file from product or variant (not shown in docs, but inferred)

#### Attach Flow

**Trigger:** Vendor/admin attaches file to product or variant via domain service (not direct API).

**Example ServiceCall (Internal):**
```typescript
await fileAttachService.execute({
  fileId: "65f1a2b3c4d5e6f7a8b9c0d1",
  ownerType: "product",
  ownerId: "65e1a2b3c4d5e6f7a8b9c0d2",
  actorId: "65e1a2b3c4d5e6f7a8b9c0d1",
  actorType: "vendor"
});
```

**Authorization Rules:**
1. **Admin**: Can attach any file
2. **System files**: Can be attached by anyone
3. **User files**: Only owner can attach

**Process:**
1. Validate file exists
2. **Authorization check**: Ensure actor can attach this file
3. Validate target entity (product/variant) exists
4. Check actor owns target entity (for vendors)
5. Check file not already attached (prevent duplicates)
6. Add `fileId` to target's `fileIds` array
7. **Atomically increment** `usageCount` on file

**Database Changes:**
```
File:
  usageCount: 0 → 1

Product (or Variant):
  fileIds: [] → ["65f1a2b3c4d5e6f7a8b9c0d1"]
```

**Critical:** `usageCount` increment uses MongoDB `$inc` operator for atomic updates, preventing race conditions.

---

### 4. Accessing File URLs

**Public URLs:**
```typescript
const publicUrl = storageProvider.getPublicUrl(file.key);
// Example: http://localhost:3000/uploads/products/2026/02/13/file.jpg
```

**Signed URLs (Private Files):**
```typescript
const signedUrl = await storageProvider.getSignedUrl(file.key, 3600); // 1 hour
// Example: https://s3.amazonaws.com/bucket/file.jpg?X-Amz-Algorithm=...
```

**Download Streams (Digital Products):**
```typescript
const stream = await storageProvider.getDownloadStream(file.key);
// Used for secure streaming delivery
```

**Frontend Access:**
- Files are NOT served directly via API endpoints
- Frontend uses storage provider URLs (public or signed)
- File metadata (including keys) retrieved via API, URLs constructed client-side or server-side

**Visibility Control:**
- Public files: Accessible via public URL
- Private files: Require signed URL with expiration
- Access control enforced at storage provider level

---

### 5. Soft Deletion Flow

**Trigger:** `DELETE /api/files/:id`

**Preconditions:**
- User is owner or admin
- `usageCount === 0` (file not referenced by any entity)

**Process:**
1. Validate ownership
2. Check `usageCount === 0`
3. Set `deletedAt` timestamp
4. Optionally set `purgeAt` (for automatic hard delete after X days)

**Database State:**
```json
{
  "id": "65f1a2b3c4d5e6f7a8b9c0d1",
  "usageCount": 0,
  "deletedAt": "2026-02-13T07:00:00Z",
  "purgeAt": "2026-03-13T07:00:00Z"  // 30 days later
}
```

**Effect:**
- File metadata remains in database
- Storage object remains untouched
- File excluded from normal queries (soft delete filter)
- Can be restored by clearing `deletedAt`

**Garbage Collection:**
- Background job scans for files with `deletedAt < now - 30 days`
- Deletes storage object
- Hard deletes database record

---

### 6. Hard Deletion Flow

**Trigger:** `DELETE /api/files/:id/permanent` (admin only)

**Process:**
1. **Database delete FIRST** (source of truth)
2. **Storage delete** (best-effort)

**Critical Order:**
```
1. DELETE FROM files WHERE id = '...'  ✅ (committed)
2. storageProvider.delete(file.key)     ⚠️ (best-effort)
   ├─ Success → File fully deleted
   └─ Failure → Database deleted, storage orphaned (logged but NOT rolled back)
```

**Rationale for No Rollback:**
- Database is authoritative record of file existence
- Storage failures should NOT prevent database cleanup
- Orphaned storage objects are less harmful than orphaned DB records
- Separate cleanup jobs handle orphaned storage

**Error Handling:**
```typescript
try {
  await fileRepository.hardDelete(id); // COMMITTED
  await storageProvider.delete(file.key);
} catch (storageError) {
  // Log error, do NOT rollback DB delete
  console.error('Storage delete failed:', storageError);
  // Continue - file considered deleted
}
```

---

### 7. Storage Cleanup & Retry Strategy

**Orphaned Storage Objects:**
- Created when storage upload succeeds but DB write fails
- Created when hard delete DB succeeds but storage delete fails

**Cleanup Approaches:**

**1. Scheduled Storage Scan:**
- List all objects in storage
- Cross-reference with database records
- Delete objects not in database
- Run weekly or monthly

**2. Dead Letter Queue:**
- Failed storage deletes pushed to queue
- Retry with exponential backoff
- Manual intervention after N retries

**3. Manual Cleanup:**
- Admin reviews logs for failed deletes
- Uses storage provider console to remove orphans

**No Automatic Retry in Hard Delete:**
- Design decision: Fail fast, log, move on
- Prevents blocking API responses on storage issues
- Shifts cleanup to async jobs

---

## Data Models

### File Model

**MongoDB Collection:** `files`

**TypeScript Interface:**
```typescript
interface IFile {
  // Identity
  id: string;                    // MongoDB ObjectId
  key: string;                   // Storage provider key
  provider: StorageProvider;     // 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary'

  // Metadata
  mimeType: string;              // MIME type (detected, not client-provided)
  size: number;                  // File size in bytes
  checksum?: string;             // MD5/SHA256 hash
  originalName?: string;         // Original filename from client

  // Lifecycle
  usageCount: number;            // Reference count (min: 0)

  // Ownership (immutable after creation)
  ownerType?: FileOwnerType;     // 'vendor' | 'admin' | 'customer' | 'agent' | 'agency' | 'system'
  ownerId?: string;              // Actor ID (null for 'system' owner)

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;       // Soft delete timestamp
  purgeAt?: Date | null;         // Scheduled hard delete
}

type StorageProvider = 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary';
type FileOwnerType = 'vendor' | 'admin' | 'customer' | 'agent' | 'agency' | 'system';
```

**Field Details:**

| Field        | Type              | Required | Default | Description                                       |
|--------------|-------------------|----------|---------|---------------------------------------------------|
| id           | ObjectId          | ✅        | Auto    | Unique identifier                                 |
| key          | string            | ✅        | -       | Provider-specific storage key                     |
| provider     | StorageProvider   | ✅        | local   | Storage backend type                              |
| mimeType     | string            | ✅        | -       | Detected MIME type                                |
| size         | number            | ✅        | -       | File size in bytes                                |
| checksum     | string            | ❌        | -       | File hash (MD5/SHA256)                            |
| originalName | string            | ❌        | -       | Client-provided filename                          |
| usageCount   | number            | ✅        | 0       | Reference count (atomic updates only)             |
| ownerType    | FileOwnerType     | ❌        | -       | Type of original uploader                         |
| ownerId      | ObjectId          | ❌        | -       | ID of original uploader                           |
| createdAt    | Date              | ✅        | Auto    | Creation timestamp                                |
| updatedAt    | Date              | ✅        | Auto    | Last update timestamp                             |
| deletedAt    | Date              | ❌        | null    | Soft delete timestamp                             |
| purgeAt      | Date              | ❌        | null    | Scheduled hard delete                             |

**Indexes:**
```typescript
// Unique file per provider (prevent duplicate uploads)
{ key: 1, provider: 1 } (unique)

// Garbage collection queries
{ usageCount: 1 }

// Soft delete queries
{ deletedAt: 1 }
```

**Constraints:**
- `usageCount >= 0` (enforced at repository level)
- `key` + `provider` must be unique
- `ownerType` and `ownerId` must be set together (or both null for system files)

**Business Meaning:**

**`usageCount`**: Number of products, variants, or other entities referencing this file. Incremented atomically on attach, decremented on detach. Prevents deletion while in use.

**`ownerType` + `ownerId`**: Represents the **original uploader**, not the current user of the file. Once set, these fields NEVER change. A vendor-uploaded file remains owned by that vendor even if attached to multiple products.

**`key`**: The storage provider's identifier for the file. Format varies by provider:
- Local: `products/2026/02/13/uuid.jpg`
- S3: `bucket-name/path/to/file.jpg`
- Cloudinary: `public_id` or URL-safe identifier

---

## Ownership & Linking Rules

### Owner Types

**`ownerType`** represents the **actor** who uploaded the file, NOT the entity using the file.

**Allowed Owner Types:**
| Owner Type | Description                     | Example ownerId        |
|------------|---------------------------------|------------------------|
| vendor     | File uploaded by vendor         | Vendor ObjectId        |
| admin      | File uploaded by admin          | Admin ObjectId         |
| customer   | File uploaded by customer       | Customer ObjectId      |
| agent      | File uploaded by agent          | Agent ObjectId         |
| agency     | File uploaded by agency         | Agency ObjectId        |
| system     | System-generated file (no owner)| null or system ObjectId|

### Why Files Are NOT Owned by Products/Variants

**Design Decision:** Files are first-class entities owned by actors, not domain entities.

**Rationale:**
1. **File Reuse**: Multiple products can share the same image (e.g., brand logo)
2. **Lifecycle Independence**: Deleting a product shouldn't delete files used elsewhere
3. **Access Control**: Authorization based on uploader, not file usage
4. **Audit Trail**: Track who uploaded what, regardless of current usage

### How Products/Variants Reference Files

**Product Model:**
```typescript
interface Product {
  id: string;
  fileIds: string[];  // Array of File IDs
  // ... other fields
}
```

**Variant Model:**
```typescript
interface Variant {
  id: string;
  fileIds: string[];  // Array of File IDs
  // ... other fields
}
```

**Linking Process:**
1. Vendor uploads file → [File](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/modules/catalog/models/file.model.ts#21-35) created with `ownerType: 'vendor'`, `usageCount: 0`
2. Vendor attaches file to product → `product.fileIds.push(fileId)`, `file.usageCount++`
3. Vendor detaches file → `product.fileIds.remove(fileId)`, `file.usageCount--`

### Safe File Reuse Example

**Scenario:** Vendor uploads brand logo once, uses it on 10 products.

**Flow:**
```
1. Upload logo.png → File A created (usageCount: 0)
2. Attach to Product 1 → Product 1.fileIds = [A], File A.usageCount = 1
3. Attach to Product 2 → Product 2.fileIds = [A], File A.usageCount = 2
...
10. Attach to Product 10 → Product 10.fileIds = [A], File A.usageCount = 10
```

**Benefits:**
- Single storage object (saves space)
- Single database record (simpler cleanup)
- Update logo name → affects all products
- Delete Product 5 → `usageCount` decrements to 9, file remains

**Deletion Safety:**
- Vendor tries to delete File A → **BLOCKED** (`usageCount > 0`)
- Vendor must detach from all products first
- Once `usageCount === 0`, soft delete allowed

---

## Storage Provider Abstraction

### Architecture

**Goal:** Business logic NEVER depends on specific storage provider.

**Interface:**
```typescript
interface IStorageProvider {
  put(buffer: Buffer, options: StoragePutOptions): Promise<StoragePutResult>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
  getSignedUrl?(key: string, expiresInSeconds: number): Promise<string>;
  getDownloadStream(key: string): Promise<NodeJS.ReadableStream>;
  getBuffer(key: string): Promise<Buffer>;
  getProviderType(): 'local' | 's3' | 'gcs' | 'r2' | 'firebase' | 'cloudinary';
}
```

### Centralized Storage Configuration

**Singleton Instance:**
```typescript
// src/core/storage/storage.instance.ts
import { getStorageProvider } from './storage.factory';

const storageProvider = getStorageProvider();
export { storageProvider };
```

**Usage:**
```typescript
import { storageProvider } from '@/core/storage';

const result = await storageProvider.put(buffer, options);
```

**Factory Pattern:**
```typescript
// src/core/storage/storage.factory.ts
export function getStorageProvider(): IStorageProvider {
  const config = loadStorageConfig();
  
  switch (config.provider) {
    case 'local':
      return new LocalStorageProvider(config);
    case 's3':
      return new S3StorageProvider(config);
    // ... other providers
    default:
      return new LocalStorageProvider(config);
  }
}
```

### Default Provider

**Environment Variable:**
```bash
STORAGE_PROVIDER=local  # local, s3, gcs, r2, firebase, cloudinary
```

**Default:** `local` (file system storage)

**Configuration:**
```typescript
// Local storage
{
  provider: 'local',
  basePath: './uploads',
  baseUrl: 'http://localhost:3000/uploads'
}

// S3 storage
{
  provider: 's3',
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: '...',
  secretAccessKey: '...'
}
```

### Provider Switching

**Zero Code Changes:** Business logic uses [IStorageProvider](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#28-81) interface.

**Steps to Switch:**
1. Update environment variable: `STORAGE_PROVIDER=s3`
2. Add S3 configuration (bucket, credentials)
3. Restart application
4. All new uploads go to S3

**Existing Files:**
- Remain on original provider (tracked via `file.provider`)
- Gradual migration possible via background jobs
- Mixed providers supported

### What the API Guarantees

Regardless of storage provider:

1. **Files are accessible** via public URLs or signed URLs
2. **Files can be deleted** (best-effort)
3. **Files can be streamed** for digital product delivery
4. **MIME types are detected** (not client-provided)
5. **Checksums are computed** for integrity
6. **Duplicate detection** works across all providers

**Provider-Specific Behavior:**
- URL format varies (local: `/uploads/...`, S3: `https://s3...`)
- Signed URL support varies (S3: yes, local: no)
- Performance varies (local: fast, S3: network latency)

---

## Deletion Semantics

### Soft Delete

**Trigger:** `DELETE /api/files/:id`

**What Gets Set:**
```json
{
  "deletedAt": "2026-02-13T07:00:00Z",
  "purgeAt": "2026-03-13T07:00:00Z"  // Optional: auto-purge after 30 days
}
```

**What Remains Accessible:**
- Database record (with `deletedAt` filter)
- Storage object (unchanged)
- File metadata (via admin queries)

**Who Can See:**
- Admins: Can query soft-deleted files
- Owners: Soft-deleted files excluded from normal queries
- Frontend: Should treat as deleted (no longer in listing)

**Restoration:**
```typescript
await fileRepository.update(fileId, { deletedAt: null, purgeAt: null });
```

**Garbage Collection:**
- Background job runs daily/weekly
- Queries: `deletedAt < now - 30 days`
- Performs hard delete on matches

---

### Hard Delete

**Trigger:** 
- `DELETE /api/files/:id/permanent` (admin manual)
- Garbage collection job (automatic)

**What Happens:**

**1. Database Deletion First (Committed):**
```sql
DELETE FROM files WHERE id = '65f1a2b3c4d5e6f7a8b9c0d1';
```

**2. Storage Deletion (Best-Effort):**
```typescript
await storageProvider.delete(file.key);
```

**Critical:** Database delete is NEVER rolled back, even if storage delete fails.

**Failure Handling:**
```typescript
try {
  await fileRepository.hardDelete(id); // ✅ COMMITTED
  await storageProvider.delete(file.key);
} catch (storageError) {
  // ❌ Storage delete failed
  console.error('Storage delete failed (DB already deleted):', storageError);
  // CONTINUE - file considered deleted
}
```

### Why DB is Source of Truth

**Scenario:** Hard delete called, storage provider is down.

**Without "DB first" rule:**
- Storage delete fails → API returns error → DB record remains
- File appears in listings → Frontend confused (storage file gone but DB says it exists)
- Requires manual intervention to sync

**With "DB first" rule:**
- DB delete succeeds → File gone from API responses
- Storage delete fails → Logged but doesn't block API
- Storage cleanup handled by scheduled jobs
- API remains responsive

**Orphaned Storage Objects:**
- Detected by storage scan jobs (compare storage vs DB)
- Manually cleaned via provider console
- Acceptable tradeoff for API reliability

### Retry / Cleanup Strategy

**No Automatic Retry on Hard Delete:**
- Prevents blocking API responses on transient storage failures
- Shifts retry logic to async background jobs

**Cleanup Approaches:**

**1. Storage Reconciliation Job:**
```typescript
// Pseudo-code
async function reconcileStorage() {
  const storageKeys = await storageProvider.listAll();
  const dbKeys = await fileRepository.getAllKeys();
  
  const orphaned = storageKeys.filter(key => !dbKeys.includes(key));
  
  for (const key of orphaned) {
    try {
      await storageProvider.delete(key);
      console.log(`Deleted orphaned storage: ${key}`);
    } catch (error) {
      console.error(`Failed to delete orphaned storage: ${key}`, error);
    }
  }
}
```

**Run:** Weekly via cron job

**2. Dead Letter Queue:**
- Failed storage deletes → Push to queue
- Retry worker processes queue with exponential backoff
- Manual intervention after max retries

**3. Monitoring & Alerting:**
- Log all storage delete failures
- Alert on high failure rate
- Dashboard showing orphaned storage count

---

## Security & Access Control

### Who Can Upload Files

**All authenticated users can upload:**
- Vendors
- Customers
- Agents
- Admins

**Role-Based Limits:**
| Role     | Max File Size | Use Case                          |
|----------|---------------|-----------------------------------|
| Vendor   | 500 MB        | Product images, digital downloads |
| Agent    | 1 GB          | Support attachments               |
| Admin    | 2 GB          | System assets, bulk imports       |
| Customer | 100 MB        | Profile pictures, ticket attachments |

**Enforcement:** Pre-upload validation in [FileUploadController](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/api/controllers/file-upload.controller.ts#48-165)

### Who Can Read Files

**Ownership-Based Access:**
- **Vendors**: Only files where `ownerType === 'vendor'` AND `ownerId === vendorId`
- **Customers**: Only files where `ownerType === 'customer'` AND `ownerId === customerId`
- **Agents**: Only files where `ownerType === 'agent'` AND `ownerId === agentId`
- **Admins**: ALL files (no restriction)

**Implementation:**
```typescript
if (userRole !== 'admin') {
  ownerFilter = {
    ownerType: userRole,  // e.g., 'vendor'
    ownerId: roleEntityId // e.g., vendor._id
  };
}
```

### Who Can Delete Files

**Soft Delete (`DELETE /api/files/:id`):**
- Owner of the file
- Admins

**Hard Delete (`DELETE /api/files/:id/permanent`):**
- **Admins ONLY**

**Additional Constraint:**
- Soft delete only if `usageCount === 0`
- Hard delete bypasses usage check (admin responsibility)

### Cross-Tenant Isolation Rules

**Strict Enforcement:**
1. Vendors CANNOT see files uploaded by other vendors
2. Customers CANNOT see files uploaded by other customers
3. Agents CANNOT see files uploaded by other agents/agencies

**Exception:** System files (`ownerType: 'system'`) are accessible to all.

**Example Attack Prevention:**
```
Vendor A tries: GET /api/files/65f1a2b3c4d5e6f7a8b9c0d1
  → File owned by Vendor B
  → Response: 403 Forbidden
```

**Implementation:**
```typescript
const file = await fileRepository.findById(id);
if (userRole !== 'admin' && file.ownerId !== userActorId) {
  throw new ForbiddenError('Access denied');
}
```

### How Private Files Are Protected

**Storage-Level Protection:**

**Local Storage:**
- Files stored outside public directory
- Served via authenticated endpoints (if implemented)
- OR rely on obscure file paths (security through obscurity, not recommended)

**S3/GCS/R2:**
- Bucket set to private (no public read access)
- Signed URLs generated on-demand with expiration
- CloudFront/CDN for signed URL distribution (if needed)

**Signed URL Flow:**
```typescript
// Backend
const signedUrl = await storageProvider.getSignedUrl(file.key, 3600); // 1 hour
// signedUrl: https://s3.amazonaws.com/bucket/file.jpg?X-Amz-Signature=...

// Frontend receives signed URL
// URL expires after 1 hour → Must request new signed URL
```

**Digital Product Protection:**
- Files streamed via backend (not direct URLs)
- Access control enforced on stream endpoint
- Prevents unauthorized downloads

### How Signed URLs Are Generated & Expired

**S3 Example:**
```typescript
const s3 = new S3Client({ region: 'us-east-1' });
const command = new GetObjectCommand({ Bucket: 'bucket', Key: file.key });
const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
```

**Expiration:**
- Embedded in URL signature
- Not stored in database
- Validated by storage provider on access
- After expiration, URL returns 403

**Frontend Handling:**
```typescript
// Initial load
const { data } = await api.getFile(fileId);
const signedUrl = await api.getSignedUrl(fileId); // Short-lived

// Display image
<img src={signedUrl} />

// After expiration
// User refreshes page → Request new signed URL
```

**Best Practices:**
- Short expiration (15 min - 1 hour)
- Regenerate on page load
- Don't cache signed URLs client-side (cache original file metadata instead)

---

## Error Handling & Edge Cases

### Comprehensive Error Reference

| Scenario                              | HTTP Status | Error Code                  | Message                                                    | Resolution                                |
|---------------------------------------|-------------|-----------------------------|-------------------------------------------------------------|-------------------------------------------|
| No files in upload request            | 400         | NO_FILES_UPLOADED           | At least one file is required                               | Include files in FormData                 |
| More than 10 files uploaded           | 400         | TOO_MANY_FILES              | Maximum 10 files per request                                | Upload in batches                         |
| File exceeds role limit               | 413         | FILE_TOO_LARGE              | File "X" exceeds ROLE limit of Y MB                         | Reduce file size or contact admin         |
| Too many videos (`/upload/video`)     | 400         | TOO_MANY_FILES              | Maximum N video(s) per request for ROLE                    | Customers: 1 video; other actors: 3       |
| Unsupported video type (`/upload/video`) | 400      | FILE_TYPE_INVALID           | File "X" is not a supported video. Allowed: mp4, mov, webm | Use mp4/mov/webm                          |
| Video exceeds 70 MB (`/upload/video`) | 413         | FILE_TOO_LARGE              | Video "X" exceeds the 70 MB limit                          | Reduce video size                         |
| Upload policy violation               | 400         | UPLOAD_POLICY_VIOLATION     | Upload policy violations found (see `details.violations[]`) | Read per-file `violations`; fix flagged file(s) |
| File not found (GET)                  | 404         | NOT_FOUND                   | File not found                                              | Verify file ID is correct                 |
| Access denied (non-owner)             | 403         | FORBIDDEN                   | You do not have access to this file                        | Request owner or admin to share           |
| Update validation failed              | 400         | VALIDATION_ERROR            | Invalid input                                               | Check request body against schema         |
| Delete file still in use              | 409         | FILE_IN_USE                 | Cannot delete file that is still in use (usageCount: X)    | Detach from all products/variants first   |
| Hard delete (non-admin)               | 403         | FORBIDDEN                   | Admin access required                                       | Request admin assistance                  |
| List orphans (non-admin)              | 403         | FORBIDDEN                   | Admin access required                                       | Request admin assistance                  |
| Orphans query (olderThan < 24h)       | 400         | VALIDATION_ERROR            | olderThan must be at least 24 hours in the past            | Adjust olderThan parameter                |
| Internal server error                 | 500         | INTERNAL_SERVER_ERROR       | An unexpected error occurred                                | Check logs (cite `requestId`), contact support |

### Edge Cases

#### Upload Interrupted

**Scenario:** Network drops during file upload.

**Behavior:**
- Multer middleware handles partial uploads
- If request incomplete → 400 error (no storage write)
- If storage upload interrupted → Storage provider error → 500 response
- No database record created (safe)

**Frontend Action:**
- Retry upload from beginning
- Show "Upload failed, please retry" message

---

#### Storage Provider Unavailable

**Scenario:** S3 is down, upload requested.

**Behavior:**
- Storage provider throws error during [put()](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/storage/storage-provider.interface.ts#29-36)
- Error caught in [UploadIntakeService](file:///c:/Users/Fante/Desktop/projects/jovi-mall/src/core/uploads/upload-intake.service.ts#28-138)
- No database record created
- 500 response to client

**Retry:**
- Automatic retry at HTTP client level (if configured)
- OR manual retry by user

**Fallback:**
- No automatic provider failover (design decision)
- Admin can switch provider via config and restart

---

#### DB Write Failure

**Scenario:** MongoDB connection lost after storage upload succeeds.

**Behavior:**
- File written to storage successfully
- Database insert fails
- 500 response to client
- **Orphaned storage object** created

**Detection:**
- Storage reconciliation job identifies object without DB record

**Cleanup:**
- Scheduled job deletes orphaned storage objects

**Why Not Rollback Storage:**
- Storage providers may not support transactions
- Better to have orphaned storage than orphaned DB records

---

#### Invalid File Type

**Scenario:** Client uploads `malicious.exe` disguised as `image.jpg`.

**Behavior:**
- File sniffing detects real MIME type: `application/x-executable`
- Policy engine rejects file
- 400 response with `UPLOAD_POLICY_VIOLATION`
- No storage write

**Detection:**
```typescript
// File sniffing processor
const detectedMimeType = await detectMimeTypeFromBuffer(buffer);
if (!isAllowedMimeType(detectedMimeType)) {
  throw new UploadPolicyViolationError('File type not allowed');
}
```

---

#### File Too Large (After Upload Started)

**Scenario:** Client sends 600MB file, vendor limit is 500MB.

**Behavior:**
- **Multer limit**: 2GB (global max)
- File buffered in memory
- Controller checks role-specific limit
- 413 response if exceeds role limit
- No storage write

**Prevention:**
- Frontend should validate file size BEFORE upload
- Backend validates again (defense in depth)

---

#### Orphaned Storage Objects

**Scenario:** Storage upload succeeds, DB write fails.

**Created When:**
- Network error during DB write
- MongoDB crash after storage upload
- Application crash between storage and DB

**Detection:**
```typescript
const storageKeys = await storageProvider.listAll();
const dbKeys = await fileRepository.getAllKeys();
const orphaned = storageKeys.filter(key => !dbKeys.includes(key));
```

**Cleanup:**
- Scheduled reconciliation job (weekly)
- Manual deletion via storage console

**Prevention:**
- Impossible to fully prevent (distributed system reality)
- Acceptable tradeoff for reliability

---

#### Concurrent Deletion Attempts

**Scenario:** Two admins try to hard-delete the same file simultaneously.

**Behavior:**
```
Admin 1: DELETE /api/files/:id/permanent → 200 OK (file deleted)
Admin 2: DELETE /api/files/:id/permanent → 404 NOT FOUND (file already gone)
```

**MongoDB Handling:**
- First delete succeeds (record removed)
- Second delete finds no record → 404 response

**Storage Layer:**
- First delete → Storage object removed (or logged as failed)
- Second delete → Provider returns "not found" (or succeeds idempotently)

**Idempotency:**
- DELETE is idempotent (multiple calls = same result)
- S3/GCS delete operations are idempotent

---

## Frontend Integration Guide

### Recommended Upload Flow

**Step 1: File Selection**
```typescript
<input
  type="file"
  multiple
  accept="image/*,application/pdf"
  onChange={handleFileSelect}
/>
```

**Step 2: Client-Side Validation**
```typescript
function handleFileSelect(event: ChangeEvent<HTMLInputElement>) {
  const files = Array.from(event.target.files || []);
  
  // Validate count
  if (files.length > 10) {
    alert('Maximum 10 files allowed');
    return;
  }
  
  // Validate size (based on user role)
  const maxSize = getMaxSizeForRole(userRole); // 500MB for vendor
  for (const file of files) {
    if (file.size > maxSize) {
      alert(`File "${file.name}" exceeds ${maxSize / 1e6} MB limit`);
      return;
    }
  }
  
  // Validate type (optional, backend validates again)
  const allowedTypes = ['image/jpeg', 'image/png', 'application/pdf'];
  for (const file of files) {
    if (!allowedTypes.includes(file.type)) {
      alert(`File type "${file.type}" not allowed`);
      return;
    }
  }
  
  // Proceed to upload
  uploadFiles(files);
}
```

**Step 3: Upload with Progress Tracking**
```typescript
async function uploadFiles(files: File[]) {
  const formData = new FormData();
  files.forEach(file => formData.append('files', file));
  
  try {
    setUploading(true);
    setProgress(0);
    
    const response = await axios.post('/api/files/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (progressEvent) => {
        const percentage = (progressEvent.loaded / progressEvent.total) * 100;
        setProgress(percentage);
      }
    });
    
    const uploadedFiles = response.data.data; // Array of File objects
    console.log('Uploaded files:', uploadedFiles);
    
    // Store file IDs for later attachment
    setFileIds(uploadedFiles.map(f => f.id));
    
  } catch (error) {
    const err = error.response?.data?.error;

    if (err?.code === 'UPLOAD_POLICY_VIOLATION') {
      // Per-file failures — map each violation back to its file via fileIndex
      const violations = err.details?.violations ?? [];
      for (const v of violations) {
        const fileName = v.fileIndex != null ? files[v.fileIndex]?.name : undefined;
        // Prefer mapping v.code → an i18n key; fall back to v.message
        setFileError(v.fileIndex, fileName ? `${fileName}: ${v.message}` : v.message);
      }
    } else if (error.response?.status === 413) {
      alert('One or more files exceed size limit');
    } else if (error.response?.status === 400) {
      alert(err?.message ?? 'Upload rejected');
    } else {
      // Unexpected error — surface requestId for support tracing
      alert(`Upload failed. Please try again. (Ref: ${err?.requestId ?? error.response?.data?.requestId ?? 'n/a'})`);
    }
  } finally {
    setUploading(false);
  }
}
```

**Step 4: Attach File IDs to Product/Variant**
```typescript
// After upload, when creating/updating product
const productData = {
  name: 'My Product',
  description: '...',
  fileIds: fileIds,  // From upload response
  // ... other fields
};

await axios.post('/api/vendor/products', productData);
```

### Uploading Videos

Videos go to a **separate endpoint** with the field name `videos` (not `files`).
The response shape is identical to `/api/files/upload`, so the returned `fileId`s
are attached to tickets/products and read/deleted exactly the same way.

```typescript
const VIDEO_MAX_BYTES = 70 * 1024 * 1024;            // 70 MB per video
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const maxVideos = userRole === 'customer' ? 1 : 3;   // customers: 1, others: 3

async function uploadVideos(videos: File[]) {
  // Client-side guards (server re-validates by sniffing the bytes)
  if (videos.length > maxVideos) {
    throw new Error(`Maximum ${maxVideos} video(s) per upload`);
  }
  for (const v of videos) {
    if (v.size > VIDEO_MAX_BYTES) throw new Error(`"${v.name}" exceeds 70 MB`);
    if (v.type && !VIDEO_TYPES.includes(v.type)) {
      throw new Error(`"${v.name}" is not an mp4/mov/webm video`);
    }
  }

  const formData = new FormData();
  videos.forEach(v => formData.append('videos', v)); // field name: "videos"

  const { data } = await axios.post('/api/files/upload/video', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: e => setProgress((e.loaded / (e.total ?? 1)) * 100),
  });

  return data.data;            // File[] — keep data[i].id to attach later
}

// Attaching an uploaded video to a ticket (same flow as any other file):
async function attachVideoToTicket(ticketId: string, fileId: string) {
  await axios.post(`/api/vendor/tickets/${ticketId}/attachments`, {
    fileId,                    // id from the upload response above
    visibility: 'PUBLIC',
  });
}
```

> Error handling is the same as the image/doc flow: a `413` means a video
> exceeded 70 MB, a `400 TOO_MANY_FILES` / `FILE_TYPE_INVALID` is a count/type
> rejection, and a `400 UPLOAD_POLICY_VIOLATION` carries per-file
> `details.violations[]` (use `fileIndex` to map each back to its video).

### Progress Tracking

**Using Axios:**
```typescript
axios.post('/api/files/upload', formData, {
  onUploadProgress: (progressEvent) => {
    const percent = Math.round((progressEvent.loaded * 100) / progressEvent.total);
    setUploadProgress(percent);
  }
});
```

**Using Fetch (more complex):**
```typescript
// Fetch doesn't natively support upload progress
// Use XMLHttpRequest or third-party library
```

**UI Feedback:**
```tsx
{uploading && (
  <div className="upload-progress">
    <progress value={progress} max="100" />
    <span>{progress}%</span>
  </div>
)}
```

### Retry Behavior

**Automatic Retry (Network Errors):**
```typescript
async function uploadWithRetry(files: File[], maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await uploadFiles(files);
    } catch (error) {
      if (attempt === maxRetries) throw error;
      
      // Retry on network errors, not validation errors
      if (error.response?.status < 500) {
        throw error; // Client error, don't retry
      }
      
      // Exponential backoff
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
}
```

**Manual Retry (User Action):**
```tsx
{uploadError && (
  <button onClick={() => uploadFiles(files)}>
    Retry Upload
  </button>
)}
```

### When to Attach fileIds to Products/Variants

**Option 1: Upload First, Then Attach**
```typescript
// 1. Upload files
const uploadedFiles = await uploadFiles(files);

// 2. Create product with file IDs
await createProduct({
  ...productData,
  fileIds: uploadedFiles.map(f => f.id)
});
```

**Option 2: Upload and Attach in Single Flow**
```typescript
// Same as Option 1, but in single function
async function createProductWithFiles(productData, files) {
  const uploadedFiles = await uploadFiles(files);
  productData.fileIds = uploadedFiles.map(f => f.id);
  return await createProduct(productData);
}
```

**Option 3: Save Draft First, Attach Later**
```typescript
// 1. Create product draft (no files)
const product = await createProduct({ ...productData, status: 'draft' });

// 2. Upload files
const uploadedFiles = await uploadFiles(files);

// 3. Update product with file IDs
await updateProduct(product.id, {
  fileIds: uploadedFiles.map(f => f.id)
});
```

**Recommendation:** Option 1 or 2 for simplicity. Option 3 if files are large and user may abandon upload.

### How to Safely Delete Files from UI

**Check Usage Count First:**
```typescript
async function deleteFile(fileId: string) {
  try {
    // 1. Get file metadata
    const file = await api.getFile(fileId);
    
    // 2. Check if in use
    if (file.usageCount > 0) {
      alert(`File is used by ${file.usageCount} product(s). Detach first.`);
      return;
    }
    
    // 3. Confirm deletion
    if (!confirm('Delete this file permanently?')) {
      return;
    }
    
    // 4. Delete
    await api.deleteFile(fileId);
    
    toast.success('File deleted successfully');
  } catch (error) {
    if (error.response?.status === 409) {
      alert('File is still in use. Detach from all products first.');
    } else {
      toast.error('Failed to delete file');
    }
  }
}
```

**Detach Flow:**
```typescript
async function detachFileFromProduct(productId: string, fileId: string) {
  // Remove fileId from product.fileIds array
  const product = await api.getProduct(productId);
  const updatedFileIds = product.fileIds.filter(id => id !== fileId);
  
  await api.updateProduct(productId, { fileIds: updatedFileIds });
  
  // Now usageCount decremented, safe to delete file
}
```

### UX Considerations

**Loading States:**
```tsx
{uploading && <Spinner />}
{uploading && <p>Uploading {files.length} file(s)...</p>}
{uploading && <ProgressBar value={progress} />}
```

**Error States:**
```tsx
{uploadError && (
  <Alert variant="danger">
    {uploadError.message}
    <button onClick={retryUpload}>Retry</button>
  </Alert>
)}
```

**Success States:**
```tsx
{uploadSuccess && (
  <Alert variant="success">
    Uploaded {uploadedFiles.length} file(s)
    <button onClick={viewFiles}>View Files</button>
  </Alert>
)}
```

**File Preview:**
```tsx
<div className="file-preview">
  {uploadedFiles.map(file => (
    <div key={file.id}>
      <img src={`/api/files/${file.id}/url`} alt={file.originalName} />
      <span>{file.originalName}</span>
      <button onClick={() => removeFile(file.id)}>Remove</button>
    </div>
  ))}
</div>
```

**Drag & Drop (Optional):**
```tsx
<div
  onDrop={handleDrop}
  onDragOver={(e) => e.preventDefault()}
  className="dropzone"
>
  Drag files here or click to select
  <input type="file" multiple onChange={handleFileSelect} />
</div>
```

**Accessibility:**
```tsx
<input
  type="file"
  multiple
  aria-label="Upload files"
  aria-describedby="upload-help"
/>
<span id="upload-help">
  Maximum 10 files, {maxSize} MB each
</span>
```

---

## Summary

This File Management Service provides a robust, enterprise-grade solution for handling file uploads, storage, and lifecycle management in a multi-tenant marketplace environment.

**Key Takeaways:**

1. **All uploads go through a single endpoint** with role-based limits
2. **Files are first-class entities** owned by actors, not products
3. **Reference counting prevents accidental deletion** of files in use
4. **Storage providers are abstracted** for seamless switching
5. **Database is source of truth** for file existence
6. **Hard delete prioritizes API availability** over storage consistency
7. **Security is multi-layered** (auth, ownership, file sniffing, virus scan)

**For Frontend Developers:**
- Upload files first, get IDs, attach to products
- Validate file size/type client-side (UX) and rely on server validation (security)
- Track upload progress for better UX
- Handle errors gracefully with retry logic

**For Backend Engineers:**
- Storage provider changes require zero business logic changes
- Atomic `usageCount` operations prevent race conditions
- Best-effort cleanup accepts orphaned storage as acceptable tradeoff
- Admin endpoints bypass some safety checks (with great power...)

**For Platform Audits:**
- Cross-tenant isolation enforced at ownership level
- All deletions logged and traceable
- Orphaned files identifiable via admin endpoints
- Storage reconciliation detects inconsistencies

---

**Document Version:** 1.2  
**Last Updated:** 2026-06-11  
**Maintained By:** Backend Architecture Team
