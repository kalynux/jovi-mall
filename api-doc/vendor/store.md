# Store Profile Management API Documentation

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
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "logo.png"
    },
    "banner": {
      "id": "507f1f77bcf86cd799439031",
      "key": "images/2026/07/banner-techsolutions.jpg",
      "url": "https://cdn.example.com/banners/techsolutions.jpg",
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
    "publicUrl": "https://yourdomain.com/store/techsolutions",
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

**Unauthorized (401)**:

```json
{
  "error": "Unauthorized: Missing token"
}
```

**Forbidden (403)**:

```json
{
  "error": "Forbidden: Insufficient permissions"
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
- `logoFileId` (string, MongoDB ObjectId, *clearable*): Id of a logo file previously uploaded via `POST /api/files/upload`. The response returns the resolved `logo` file object (`{ id, key, url, mimeType, size, originalName }` | null). Registers a `file_references` row so the file is not garbage-collected while set.
- `bannerFileId` (string, MongoDB ObjectId, *clearable*): Id of a banner/hero file uploaded via `POST /api/files/upload`. The response returns the resolved `banner` file object (same shape as `logo`).
- `description` (string, max 1000 chars, *clearable*): Store description
- `supportEmail` (string, valid email, *clearable*): Support contact email
- `supportPhone` (string, 8-20 chars, *clearable*): Support contact phone
- `supportWhatsapp` (string, 8-20 chars, *clearable*): WhatsApp support number
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
> **Immutable Fields**: `slug` cannot be updated, and `country` is not stored on the store at all (it lives on the vendor profile, set-once). Attempts to send either are rejected.

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
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "new-logo.png"
    },
    "banner": {
      "id": "507f1f77bcf86cd799439031",
      "key": "images/2026/07/new-banner.jpg",
      "url": "https://cdn.example.com/banners/new-banner.jpg",
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
    "publicUrl": "https://yourdomain.com/store/techsolutions",
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
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "name",
        "message": "Name must be at least 2 characters"
      },
      {
        "field": "logoFileId",
        "message": "logoFileId must be a valid file id"
      }
    ]
  }
}
```

**Slug Immutability (403)**:

> [!IMPORTANT]
> Slug is READ-ONLY in vendor API. Only admin can change slugs (future feature with URL redirects). This prevents SEO disasters and support nightmares.

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Slug cannot be modified. Contact support if you need to change your store URL."
  }
}
```

**Country Not Stored Here (403)**:

> [!IMPORTANT]
> The store has no country field. The country lives on the vendor profile — set once during onboarding, immutable afterwards.

```json
{
  "success": false,
  "error": {
    "code": "PROFILE_COUNTRY_IMMUTABLE",
    "message": "Country is not stored on the store. It lives on your vendor profile and is set once during onboarding."
  }
}
```

**Optimistic Locking Conflict (409)**:

> [!IMPORTANT]
> This error occurs when the store was modified by another request between when you loaded it and when you tried to save it. The client should refresh the store profile and retry the update.

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Store was modified by another request. Please refresh and try again."
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
    "publicUrl": "https://yourdomain.com/store/techsolutions",
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
    "publicUrl": "https://yourdomain.com/store/techsolutions",
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
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "isOpen",
        "message": "isOpen must be a boolean"
      }
    ]
  }
}
```

**Optimistic Locking Conflict (409)**:

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Store was modified by another request. Please refresh and try again."
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
  "code": "FORBIDDEN",
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
STORE_PUBLIC_URL_BASE=https://yourdomain.com/store
```

**Example**:
- Slug: `techsolutions`
- Public URL: `https://yourdomain.com/store/techsolutions`

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
    redirectUrl: 'https://yourdomain.com/store/new-store'
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
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Business rule violation (immutable field modification) |
| `NOT_FOUND` | 404 | Store not found (system bug) |
| `CONFLICT` | 409 | Optimistic locking version mismatch |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

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
