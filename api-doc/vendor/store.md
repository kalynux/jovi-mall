# Store Profile Management API Documentation

## Overview

The Store Profile Management API allows vendors to manage their public storefront - the commercial surface of their business on the platform. Each vendor has exactly one store. Vendors can view and update store details, manage vacation mode, but cannot modify immutable fields like slug and country.

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
    "logoUrl": "https://cdn.example.com/logos/techsolutions.png",
    "bannerUrl": "https://cdn.example.com/banners/techsolutions.jpg",
    "description": "Your one-stop shop for premium tech solutions and gadgets",
    "address": "123 Innovation Street",
    "city": "Douala",
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
- `country`: ISO country code (READ-ONLY, immutable)
- `isOpen`: Vacation mode status (true = open, false = on vacation)
- `publicUrl`: Computed from slug, not editable directly
- `version`: Optimistic locking counter

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
> If this error occurs, it indicates a **system bug**. Every vendor must have exactly one store. Store creation happens only during onboarding.

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Store not found for vendor 507f191e810c19729de860ea. This is a system bug - vendors should always have a store."
  }
}
```

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
  "logoUrl": "https://cdn.example.com/logos/new-logo.png",
  "bannerUrl": "https://cdn.example.com/banners/new-banner.jpg",
  "description": "Updated description with new offerings",
  "address": "456 Tech Avenue",
  "city": "Yaoundé",
  "supportEmail": "hello@techsolutions.com",
  "supportPhone": "+237698765432",
  "supportWhatsapp": "+237698765432",
  "version": 5
}
```

**Fields** (all optional except `version`):

- `name` (string, 2-100 chars): Store display name
- `logoUrl` (string, valid URL): Store logo image URL
- `bannerUrl` (string, valid URL): Store banner/hero image URL
- `description` (string, max 1000 chars): Store description
- `address` (string, max 200 chars): Physical address
- `city` (string, max 100 chars): City
- `supportEmail` (string, valid email): Support contact email
- `supportPhone` (string, 8-20 chars): Support contact phone
- `supportWhatsapp` (string, 8-20 chars): WhatsApp support number
- `version` (**required**, number): Current store version for optimistic locking

> [!IMPORTANT]
> **Immutable Fields**: `slug` and `country` cannot be updated. Attempts to modify these fields will be rejected.

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
    "logoUrl": "https://cdn.example.com/logos/new-logo.png",
    "bannerUrl": "https://cdn.example.com/banners/new-banner.jpg",
    "description": "Updated description with new offerings",
    "address": "456 Tech Avenue",
    "city": "Yaoundé",
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
        "field": "logoUrl",
        "message": "Logo URL must be valid"
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

**Country Immutability (403)**:

> [!IMPORTANT]
> Country cannot be changed by vendors. This is locked for tax and shipping compliance.

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Country cannot be modified. This is locked for tax and shipping compliance."
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

**Status**: IMMUTABLE (enforced at all layers)

**Rationale**:
- Locked for tax compliance
- Locked for shipping calculation
- Changing country has legal implications

**Error if attempted**:
```json
{
  "code": "FORBIDDEN",
  "message": "Country cannot be modified. This is locked for tax and shipping compliance."
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

### Fail-Fast Philosophy

`getStore(vendorId)` throws `NotFoundError` if store missing. This is intentional:

> **Store missing = system bug, not business case.**

Every vendor must have a store. Store creation happens only during onboarding.
