# Customer — Digital Products (library & downloads)

Customers view the digital products they've purchased and download them through secure, single-use,
short-lived links. **Entitlements are granted automatically** when a digital order is paid — there is
no manual "grant" step for the customer.

- **Base URL**: `http://localhost:8022/api`
- **Mount**: `/api/digital` (the execute route lives here because generated download URLs are
  `/api/digital/download/<token>`).
- **Response envelope**: standard `{ success, data }` — see [../README.md](../README.md#the-response-envelope-read-this-first).
  (The download-execute route is the exception: it returns a **binary file stream**, not JSON.)

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/digital/my-products` | `customer` | List purchased digital products + entitlement status |
| `POST` | `/digital/download-links` | `customer` | Mint a single-use, 15-min download link |
| `GET` | `/digital/download/:token` | **public** (token is the auth) | Execute a download (streams the file) |

### End-to-end flow (frontend)

```
1. GET  /api/digital/my-products              → show library; enable download where canDownload === true
2. POST /api/digital/download-links           → { entitlementId }  ⇒  { url, expiresAt, downloadsRemaining }
3. Navigate the browser to `url`              → GET /api/digital/download/:token streams the file
```

The token in step 3 is **single-use** and expires in **15 minutes**. Each successful execute increments
`downloadsUsed`; to download again, mint a new link (which counts against `maxDownloads`).

---

## GET `/digital/my-products`

**Purpose**: List every digital entitlement owned by the authenticated customer, newest first, with
computed status.

**Auth**: Required · **Permissions**: `customer`

### Example success `200`

```json
{
  "success": true,
  "data": [
    {
      "id": "664ent...",
      "productId": "664prd...",
      "productTitle": "Advanced Excel Course",
      "variantId": "664var...",
      "variantName": "Full Bundle",
      "assetId": "664ast...",
      "originalName": "excel-course.zip",
      "downloadsUsed": 1,
      "maxDownloads": 5,
      "expiresAt": "2026-09-01T00:00:00.000Z",
      "revokedAt": null,
      "isExpired": false,
      "isRevoked": false,
      "canDownload": true
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `maxDownloads` | `null` = unlimited |
| `expiresAt` | `null` = never expires |
| `canDownload` | `!isExpired && !isRevoked && (maxDownloads === null || downloadsUsed < maxDownloads)` — use this to enable/disable the button |

---

## POST `/digital/download-links`

**Purpose**: Generate a secure, single-use download link for one of the caller's entitlements. Validates
ownership, revocation, expiry and remaining downloads **before** issuing the token.

**Auth**: Required · **Permissions**: `customer`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `entitlementId` | string (ObjectId) | ✅ | must be one of the caller's entitlements |

### Example request

```json
{ "entitlementId": "664ent..." }
```

### Example success `201`

```json
{
  "success": true,
  "data": {
    "url": "/api/digital/download/eyJ0b2tlbiI6...",
    "expiresAt": "2026-07-17T10:35:00.000Z",
    "downloadsRemaining": 4
  }
}
```

> `downloadsRemaining` is `null` for unlimited entitlements. `url` is relative — prefix with the API base.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `entitlementId` missing |
| 400 | `DIGITAL_INVALID_ENTITLEMENT_ID` | `entitlementId` is not a valid id |
| 404 | `DIGITAL_ENTITLEMENT_NOT_FOUND` | No such entitlement |
| 403 | `DIGITAL_ENTITLEMENT_UNAUTHORIZED` | Entitlement belongs to another customer |
| 403 | `DIGITAL_ENTITLEMENT_REVOKED` | Entitlement was revoked |
| 403 | `DIGITAL_ENTITLEMENT_EXPIRED` | Past `expiresAt` |
| 403 | `DIGITAL_DOWNLOAD_LIMIT_EXCEEDED` | No downloads remaining |

---

## GET `/digital/download/:token`

**Purpose**: Execute a download. **Public** — the single-use token *is* the authentication (so the link
works from an email or a plain browser navigation). Streams the file with
`Content-Disposition: attachment`.

**Auth**: None (token-authenticated) · **Path param**: `token` (from a prior download-link)

### Behaviour
- The token is consumed atomically (Redis `GETDEL`) — a second use of the same token fails.
- The entitlement's `downloadsUsed` is incremented with an atomic guard — it is **impossible** to
  exceed `maxDownloads` even under concurrent requests.
- On success: `200` with headers `Content-Type`, `Content-Disposition: attachment; filename="…"`,
  `Content-Length`, and the file bytes as the body.

### Errors (JSON envelope, thrown before any bytes are streamed)

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing token |
| 400 | `DIGITAL_TOKEN_INVALID` | Token unknown, already used, or expired |
| 404 | `DIGITAL_ENTITLEMENT_NOT_FOUND` | Entitlement/asset/file gone |
| 403 | `DIGITAL_ENTITLEMENT_REVOKED` / `DIGITAL_ENTITLEMENT_EXPIRED` / `DIGITAL_DOWNLOAD_LIMIT_EXCEEDED` | Status check failed at execute time |

## Business rules & notes

- **Automatic granting**: when a digital order reaches `paid`, `OrderService` calls the digital
  fulfillment helper, which grants one idempotent entitlement per digital order item (snapshotting the
  variant's `maxDownloads` / `expiresAfterDays` at grant time). Webhook retries are safe (unique index).
- **No customer grant/revoke endpoints** — granting is post-payment only; revocation is a vendor/admin action.
- Links are single-use with a **15-minute** TTL; the counter moves on **execute**, not on link creation,
  so an unused link costs nothing.
- Vendors manage the underlying digital **assets** per variant under
  `/api/vendor/products/:productId/variants/:variantId/digital/*` — see [../vendor/digital-products.md](../vendor/digital-products.md).

## Related

- [../vendor/digital-products.md](../vendor/digital-products.md) — vendor-side asset & variant config
- [./orders.md](./orders.md) — where the purchase happens
- [../auth/README.md](../auth/README.md)
