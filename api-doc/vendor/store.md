# Store Profile Management API Documentation

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–26). Corrections are marked inline with ⚠ and a source citation.

## Overview

The Store Profile Management API allows vendors to manage their public storefront - the commercial surface of their business on the platform. Each vendor has exactly one store, **auto-created on first access** (and provisioned during onboarding Step 1). Vendors can view and update store details and manage vacation mode, but cannot modify the immutable `slug`.

> [!IMPORTANT]
> **The store carries no address, city, or country of its own.**
> - Physical locations (which are also pickup locations) are the vendor profile's
>   **`business_addresses`** — geocoded, mappable, and validated against the
>   vendor's registered country. Manage them via
>   [`PATCH /api/vendor/profile`](./profile.md#patch-apivendorprofile).
> - **`country`** lives on the vendor profile (set once during onboarding,
>   immutable afterwards) and is served **read-only** in store responses.

**Base URL**: `/api/vendor`

**Authentication**: All endpoints require a valid JWT token in the `Authorization` header with vendor role.

**Standard**: Shopify/Etsy/Amazon Storefront service quality.

---

## Endpoints

### GET /api/vendor/store

Retrieve the authenticated vendor's store profile.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
```

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "name": "TechSolutions Store",
    "slug": "techsolutions",
    "logo": {
      "id": "507f1f77bcf86cd799439030",
      "key": "images/2026/07/logo-techsolutions.png",
      "url": "https://cdn.example.com/logos/techsolutions.png",
      "access": "public",
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "logo.png"
    },
    "banner": {
      "id": "507f1f77bcf86cd799439031",
      "key": "images/2026/07/banner-techsolutions.jpg",
      "url": "https://cdn.example.com/banners/techsolutions.jpg",
      "access": "public",
      "mimeType": "image/jpeg",
      "size": 184320,
      "originalName": "banner.jpg"
    },
    "description": "Your one-stop shop for premium tech solutions and gadgets",
    "country": "CM",
    "supportEmail": "support@techsolutions.com",
    "supportPhone": "+237612345678",
    "supportWhatsapp": "+237612345678",
    "isOpen": true,
    "publicUrl": "https://yourdomain.com/shop/stores/techsolutions",
    "version": 5,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-28T14:22:00.000Z"
  }
}
```

**Field Descriptions**:
- `slug`: URL-safe store identifier (READ-ONLY, immutable in vendor API)
- `country`: ISO country code (READ-ONLY) — **sourced from the vendor profile**, not stored on the store. `null` until onboarding Step 1 sets it.
- `isOpen`: Vacation mode status (true = open, false = on vacation)
- `publicUrl`: Computed from slug, not editable directly
- `version`: Optimistic locking counter

**Auto-provisioning**: if the vendor has no store row yet (accounts created before
store provisioning existed), this endpoint creates it on the fly — name derived
from the business name given at signup (else the vendor's display name), slug auto-generated and unique.

#### Error Responses

**Unauthorized (401)** — no credential presented (`auth.middleware.ts:126`):

```json
{
  "success": false,
  "requestId": "req_01J…",
  "error": {
    "code": "AUTH_MISSING_TOKEN",
    "message": "Authentication token required",
    "statusCode": 401,
    "category": "authentication"
  }
}
```

**Forbidden (403)** — signed in as the wrong role (`requireRole`, `auth.middleware.ts:365`):

```json
{
  "success": false,
  "requestId": "req_01J…",
  "error": {
    "code": "AUTH_ROLE_NOT_FOUND",
    "message": "Insufficient permissions",
    "statusCode": 403,
    "category": "authorization",
    "details": { "required": ["vendor"], "actual": "customer" }
  }
}
```

**Not Found (404)**:

> [!WARNING]
> Should not occur in practice: the store is **auto-created on first access**
> (get-or-create) and provisioned during onboarding Step 1. A 404 here means the
> vendor profile itself is missing — a system bug.

---

### PATCH /api/vendor/store

Update the authenticated vendor's store profile.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### Request Body

```json
{
  "name": "TechSolutions Premium",
  "logoFileId": "507f1f77bcf86cd799439030",
  "bannerFileId": "507f1f77bcf86cd799439031",
  "description": "Updated description with new offerings",
  "supportEmail": "hello@techsolutions.com",
  "supportPhone": "+237698765432",
  "supportWhatsapp": "+237698765432",
  "version": 5
}
```

**Fields** (all optional except `version`):

- `name` (string, 2-100 chars): Store display name — **not clearable** (required field)
- `logoFileId` (string, MongoDB ObjectId, *clearable*): Id of a logo file previously uploaded via `POST /api/files/upload`. The response returns the resolved `logo` file object (`{ id, key, url, access, mimeType, size, originalName }` | null). Registers a `file_references` row so the file is not garbage-collected while set.
- `bannerFileId` (string, MongoDB ObjectId, *clearable*): Id of a banner/hero file uploaded via `POST /api/files/upload`. The response returns the resolved `banner` file object (same shape as `logo`).
- `description` (string, max 1000 chars, *clearable*): Store description
- `supportEmail` (string, valid email, lowercased, *clearable*): Support contact email
- `supportPhone` (string, **E.164** e.g. `+237612345678`, *clearable*): Support contact phone
- `supportWhatsapp` (string, **E.164**, *clearable*): WhatsApp support number

> Phone and email formats are platform-wide — see [Contact formats](../README.md#contact-formats-phone--email).
- `version` (**required**, number): Current store version for optimistic locking

> **No `address` / `city` / `country` here.** Physical store locations are the
> vendor profile's `business_addresses` (with geocoded coordinates for maps);
> the country is set once during onboarding and served read-only. See
> [Vendor Profile](./profile.md#patch-apivendorprofile).

**Clearing a field**: every field marked *clearable* accepts three states:

| You send | Effect |
|---|---|
| key omitted | field left unchanged |
| `null` or `""` (or whitespace-only) | field **cleared** — stored and returned as `null` |
| a value | must satisfy the field's constraint (URL, email, length…) |

```json
{ "version": 5, "logoFileId": null }
```
and
```json
{ "version": 5, "logoFileId": "" }
```
are equivalent: both remove the logo. A non-empty invalid value (e.g. `"logoFileId": "not-an-id"`) is still rejected with `VALIDATION_ERROR`.

> [!IMPORTANT]
> **Immutable Fields**: `slug` cannot be updated, and `country` is not stored on the store at all (it lives on the vendor profile, set-once).
>
> ⚠ **Sending either is SILENTLY STRIPPED — it is not rejected, and you get a `200`.** `UpdateStoreProfileSchema` is a plain `z.object` (not `.strict()`), so Zod removes both keys before the controller passes the parsed value on (`store.controller.ts:57`). The service's two guards read `rawInput.slug` / `rawInput.country` on that already-stripped object (`store-profile.service.ts:147-153`), so they are **dead code and neither 403 can be raised.** A client that sends a new slug is told the save succeeded and the slug is unchanged.

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "name": "TechSolutions Premium",
    "slug": "techsolutions",
    "logo": {
      "id": "507f1f77bcf86cd799439030",
      "key": "images/2026/07/new-logo.png",
      "url": "https://cdn.example.com/logos/new-logo.png",
      "access": "public",
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "new-logo.png"
    },
    "banner": {
      "id": "507f1f77bcf86cd799439031",
      "key": "images/2026/07/new-banner.jpg",
      "url": "https://cdn.example.com/banners/new-banner.jpg",
      "access": "public",
      "mimeType": "image/jpeg",
      "size": 184320,
      "originalName": "new-banner.jpg"
    },
    "description": "Updated description with new offerings",
    "country": "CM",
    "supportEmail": "hello@techsolutions.com",
    "supportPhone": "+237698765432",
    "supportWhatsapp": "+237698765432",
    "isOpen": true,
    "publicUrl": "https://yourdomain.com/shop/stores/techsolutions",
    "version": 6,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-29T09:15:00.000Z"
  },
  "message": "Store profile updated successfully"
}
```

#### Error Responses

**Validation Error (400)**:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [
        {
          "path": "name",
          "message": "Name must be at least 2 characters",
          "code": "too_small"
        },
        {
          "path": "logoFileId",
          "message": "logoFileId must be a valid file id",
          "code": "invalid_string"
        }
      ]
    }
  }
}
```

**~~Slug Immutability (403)~~ — UNREACHABLE**:

> [!IMPORTANT]
> Slug is READ-ONLY in the vendor API. Only an admin can change slugs (a future feature, with URL redirects). ⚠ **The body below is never sent** — the key is stripped before the check that would produce it (see the note under "Immutable Fields" above). It is kept here, struck through in the heading, because a shipped client may still branch on `AUTH_FORBIDDEN` here; that branch is dead.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "AUTH_FORBIDDEN",
    "message": "Slug cannot be modified. Contact support if you need to change your store URL.",
    "statusCode": 403,
    "category": "authorization"
  }
}
```

**~~Country Not Stored Here (403)~~ — UNREACHABLE**:

> [!IMPORTANT]
> The store has no country field. The country lives on the vendor profile — set once during onboarding, immutable afterwards. ⚠ **The body below is never sent**, for the same reason as the slug case above: `country` is stripped by the schema before the guard reads it.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "PROFILE_COUNTRY_IMMUTABLE",
    "message": "Country is not stored on the store. It lives on your vendor profile and is set once during onboarding.",
    "statusCode": 403,
    "category": "authorization"
  }
}
```

**Optimistic Locking Conflict (409)**:

> [!IMPORTANT]
> This error occurs when the store was modified by another request between when you loaded it and when you tried to save it. The client should refresh the store profile and retry the update.

> [!WARNING]
> **Do not branch on the `code` here.** The version check raises `STORE_SLUG_TAKEN`
> (`store-profile.service.ts:175,247`) — the code is **misnamed on the wire** and says nothing
> about a slug; no slug was involved. Branch on `statusCode === 409 && category === 'conflict'`
> instead. Same defect class as `VENDOR_FISCAL_CALENDAR_INVALID` on the vendor profile
> ([`profile.md`](./profile.md)); renaming either is a breaking wire change and has not been made.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "STORE_SLUG_TAKEN",
    "message": "Store was modified by another request. Please refresh and try again.",
    "statusCode": 409,
    "category": "conflict"
  }
}
```

---

### PATCH /api/vendor/store/status

Toggle store vacation mode (open/close store temporarily).

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### Request Body

```json
{
  "isOpen": false,
  "version": 6
}
```

**Fields**:

- `isOpen` (**required**, boolean):
  - `true` = Open for business
  - `false` = On vacation (store temporarily closed)
- `version` (**required**, number): Current store version for optimistic locking

#### Response

**Success (200 OK)** - Store Opened:

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "name": "TechSolutions Premium",
    "slug": "techsolutions",
    "isOpen": true,
    "publicUrl": "https://yourdomain.com/shop/stores/techsolutions",
    "version": 7,
    ...
  },
  "message": "Store opened successfully"
}
```

**Success (200 OK)** - Vacation Mode Enabled:

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f191e810c19729de860ea",
    "name": "TechSolutions Premium",
    "slug": "techsolutions",
    "isOpen": false,
    "publicUrl": "https://yourdomain.com/shop/stores/techsolutions",
    "version": 7,
    ...
  },
  "message": "Store closed (vacation mode enabled)"
}
```

#### Error Responses

**Validation Error (400)**:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [
        {
          "path": "isOpen",
          "message": "isOpen must be a boolean",
          "code": "invalid_type"
        }
      ]
    }
  }
}
```

**Optimistic Locking Conflict (409)**:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "STORE_SLUG_TAKEN",
    "message": "Store was modified by another request. Please refresh and try again.",
    "statusCode": 409,
    "category": "conflict"
  }
}
```

#### Notes

**Vacation Mode Behavior**:
- When `isOpen: false`, the store is marked as "on vacation"
- Customers may see a notice on the storefront
- New orders may be disabled (implementation-dependent)
- Future implementation may add admin suspension (`is_suspended`), with effective state: `isOperational = isOpen && !isSuspended`

---

## Optimistic Locking

All store updates use **optimistic locking** to prevent data loss from concurrent modifications.

### How It Works

1. Client fetches store: `GET /api/vendor/store` → receives `version: 5`
2. Client modifies fields locally
3. Client sends update: `PATCH /api/vendor/store` with `version: 5`
4. Server checks if current version is still `5`
   - **Match**: Update succeeds, version incremented to `6`
   - **Mismatch**: Returns 409 Conflict error
5. On conflict, client refreshes store and retries

### Best Practices

- Always include the `version` field in update requests
- Handle 409 Conflict errors by refreshing data and prompting user to retry
- Display clear message: "Store was updated elsewhere. Please refresh and try again."

---

## Immutable Fields

### Slug

**Status**: READ-ONLY in vendor API

**Rationale**:
- Changing slugs breaks SEO rankings
- Breaks marketing campaigns, social shares, external links
- Creates support nightmares

**Future**: Admin-only slug changes with automatic URL redirects

**Error if attempted**:
```json
{
  "code": "AUTH_FORBIDDEN",
  "message": "Slug cannot be modified. Contact support if you need to change your store URL."
}
```

### Country

**Status**: NOT STORED ON THE STORE — read-only mirror of the vendor profile's country

**Rationale**:
- One canonical country per vendor (set once during onboarding Step 1, immutable after)
- Locked for tax compliance and shipping calculation
- Anchors the business-address policy: every geocoded business address must resolve inside it

**Error if attempted here**:
```json
{
  "code": "PROFILE_COUNTRY_IMMUTABLE",
  "message": "Country is not stored on the store. It lives on your vendor profile and is set once during onboarding."
}
```

---

## Public URL

The `publicUrl` field is **computed, not stored**:

```typescript
publicUrl = `${STORE_PUBLIC_URL_BASE}/${encodeURIComponent(slug)}`
```

**Configuration**:
```env
STORE_PUBLIC_URL_BASE=https://yourdomain.com/shop/stores
```

**Example**:
- Slug: `techsolutions`
- Public URL: `https://yourdomain.com/shop/stores/techsolutions`

**Future enhancements**:
- Custom domains (`https://store.techsolutions.com`)
- Custom subdomains (`https://techsolutions.yourdomain.com`)

---

## Domain Events & Audit Logging

### Events Emitted

**Store Profile Updated**:
```javascript
eventBus.publish('store.profile.updated', {
  eventType: 'store.profile.updated',
  aggregateId: storeId,
  payload: {
    vendorId,
    storeId,
    changes: {
      name: { from: 'Old Name', to: 'New Name' },
      description: { from: 'Old Desc', to: 'New Desc' }
    }
  },
  occurredAt: new Date()
});
```

**Store Status Changed**:
```javascript
eventBus.publish('store.status.changed', {
  eventType: 'store.status.changed',
  aggregateId: storeId,
  payload: {
    vendorId,
    storeId,
    isOpen: false,
    reason: 'vacation_mode'
  },
  occurredAt: new Date()
});
```

**Store Slug Changed** (Admin-only, future):
```javascript
eventBus.publish('store.slug.changed', {
  eventType: 'store.slug.changed',
  aggregateId: storeId,
  payload: {
    vendorId,
    oldSlug: 'old-store',
    newSlug: 'new-store',
    redirectUrl: 'https://yourdomain.com/shop/stores/new-store'
  },
  occurredAt: new Date()
});
```

### Audit Logs

All store updates and status changes are logged for compliance:

```javascript
auditLogger.log({
  actor: { userId: vendorId, role: 'vendor' },
  action: 'STORE_PROFILE_UPDATED',
  resource: { type: 'Store', id: storeId },
  changes: { name: { from: 'Old', to: 'New' } },
  timestamp: new Date()
});
```

---

## Future Enhancements

### Multiple Stores Per Vendor

The system is designed for future multi-store support:

- Remove `vendor_id` unique constraint
- Add store selection UI
- Filter by `vendorId` in queries
- Introduce `is_primary: boolean` flag

### Custom Domains

```typescript
{
  custom_domain: "store.vendor.com",
  dns_verified: true,
  ssl_enabled: true
}
```

### Store Themes

```typescript
{
  theme_id: "minimal-dark",
  primary_color: "#2a9d8f",
  secondary_color: "#e76f51"
}
```

### SEO Settings

```typescript
{
  meta_title: "Premium Tech Solutions | TechSol",
  meta_description: "Shop the latest gadgets...",
  og_image: "https://cdn.example.com/og/store.jpg"
}
```

### Admin Suspension

```typescript
{
  is_open: true,        // Vendor-controlled
  is_suspended: false,  // Admin-controlled
  // Effective state: isOperational = is_open && !is_suspended
}
```

---

## Error Codes Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` / `AUTH_TOKEN_INVALID` | 401 | Missing, expired or malformed token. ⚠ There is no `UNAUTHORIZED` code in the registry |
| `AUTH_ROLE_NOT_FOUND` / `AUTH_VENDOR_SUSPENDED` | 403 | Not signed in as an active vendor. ⚠ There is no `FORBIDDEN` code in the registry, and the immutable-field 403s above are unreachable |
| ~~`NOT_FOUND`~~ | ~~404~~ | **Not raised here.** The store is created on demand (`ensureStoreForVendor`), so there is no missing-store path. `NOT_FOUND` is reserved for unmatched routes |
| `STORE_SLUG_TAKEN` | 409 | Optimistic-locking version mismatch. ⚠ The code really is `STORE_SLUG_TAKEN` — see the warning above; there is no `CONFLICT` in the registry |
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error. ⚠ Not `INTERNAL_ERROR` |

---

## Security Best Practices

1. **Always use HTTPS** in production
2. **Store JWT tokens securely** (httpOnly cookies or secure storage)
3. **Never expose storeId** in vendor-facing routes (vendor-ID-only access)
4. **Implement rate limiting** on update endpoints
5. **Monitor for suspicious patterns** (rapid updates, abuse)
6. **Validate file uploads** for logo/banner (prevent malicious content)
7. **Sanitize HTML** in description field (prevent XSS)

---

## Example Workflows

### Update Store Name and Description

```bash
# 1. Get current store
curl -X GET https://api.example.com/api/vendor/store \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response: { "data": { "version": 5, ... } }

# 2. Update store
curl -X PATCH https://api.example.com/api/vendor/store \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Awesome Store",
    "description": "We sell amazing products",
    "version": 5
  }'
```

### Enable Vacation Mode

```bash
curl -X PATCH https://api.example.com/api/vendor/store/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "isOpen": false,
    "version": 6
  }'
```

### Re-open Store After Vacation

```bash
curl -X PATCH https://api.example.com/api/vendor/store/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "isOpen": true,
    "version": 7
  }'
```

---

## Architectural Notes

### Vendor-ID-Only Access

Vendors **never** operate by storeId. Identity flow:

```
JWT Token → User → Vendor → Store
```

Repository methods:
- `findByVendorId(vendorId)` ← Vendor-facing
- `findById(storeId)` ← Internal/Admin-only

This enforces strong tenant isolation.

### One Store Per Vendor

**Current architecture**: `vendor_id` unique constraint.

**Future**: Multi-store support by removing unique constraint and adding store management UI.

### Provisioning (get-or-create)

Every vendor must have a store. It is created by `StoreProvisioningService` from
two paths: a best-effort hook when onboarding Step 1 completes, and get-or-create
on first access to any `/api/vendor/store` endpoint (which also heals accounts
that predate provisioning). Creation is race-safe via the unique `vendor_id`
index. A 404 can therefore only mean the **vendor profile** is missing — a
system bug.
