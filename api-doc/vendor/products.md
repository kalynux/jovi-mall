# Vendor Product Management API

Complete API reference for managing products in the multi-vendor ecommerce platform.

> [!IMPORTANT]
> **Authentication Required**
> All endpoints require:
> - Bearer token in `Authorization` header
> - Vendor role
> - Vendor can only access/modify their own products

---

## Table of Contents

- [Product CRUD](#product-crud)
- [**Product Creation Workflows**](./product-update.md) (Step-by-Step Guides for Physical/Digital/Service)
- [Bulk Operations](#bulk-operations)
- [Digital Product Management](#digital-product-management)
- [Service Product Management](#service-product-management)
- [Error Codes](#error-codes)
- [Type-Specific Fields](#type-specific-fields)

---

## Product CRUD

### List Products

```http
GET /api/vendor/products
```

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | string | No | Filter by product type: `physical`, `digital`, `service` |
| `status` | string | No | Filter by status: `draft`, `active`, `archived` |
| `q` | string | No | Search query (searches title and description) |
| `sortBy` | string | No | Sort field: `createdAt`, `updatedAt`, `title` (default: `createdAt`) |
| `sortOrder` | string | No | Sort order: `asc`, `desc` (default: `desc`) |
| `page` | number | No | Page number (default: `1`) |
| `limit` | number | No | Items per page (default: `20`, max: `100`) |

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439011",
      "vendorId": "507f1f77bcf86cd799439012",
      "type": "physical",
      "status": "draft",
      "title": "Blue T-Shirt",
      "description": "Comfortable cotton t-shirt",
      "slug": "blue-t-shirt",
      "seo": {
        "title": "Buy Blue T-Shirt Online",
        "description": "High quality cotton t-shirt in blue"
      },
      "hasVariants": false,
      "createdAt": "2026-01-29T10:00:00Z",
      "updatedAt": "2026-01-29T10:00:00Z"
    }
  ],
  "meta": {
    "total": 120,
    "page": 1,
    "limit": 20,
    "pages": 6
  }
}
```

---

### Get Product

```http
GET /api/vendor/products/:id
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "vendorId": "507f1f77bcf86cd799439012",
    "type": "digital",
    "status": "active",
    "title": "eBook: Node.js Guide",
    "description": "Complete guide to Node.js development",
    "slug": "ebook-nodejs-guide",
    "digitalConfig": {
      "assetId": "507f1f77bcf86cd799439013",
      "maxDownloads": 5,
      "expiresAfterDays": 30,
      "isActive": true
    },
    "createdAt": "2026-01-29T10:00:00Z",
    "updatedAt": "2026-01-29T10:00:00Z"
  }
}
```

**Error Responses:**

- `404 NOT_FOUND`: Product not found
- `403 FORBIDDEN`: Product not owned by vendor

---

### Create Product

```http
POST /api/vendor/products
```

**Request Body:**

```json
{
  "type": "physical",
  "title": "Blue T-Shirt",
  "description": "Comfortable cotton t-shirt",
  "seoTitle": "Buy Blue T-Shirt Online",
  "seoDescription": "High quality cotton t-shirt",
  
  // For digital products:
  "digitalConfig": {
    "maxDownloads": 5,
    "expiresAfterDays": 30
  },
  
  // For service products:
  "serviceConfig": {
    "durationMinutes": 60,
    "bufferBeforeMinutes": 10,
    "bufferAfterMinutes": 10,
    "bookingMode": "calendar"
  }
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "status": "draft",
    "title": "Blue T-Shirt",
    "slug": "blue-t-shirt",
    ...
  },
  "message": "Product created successfully"
}
```

> [!NOTE]
> Products are created in `draft` status by default

---

### Update Product

```http
PATCH /api/vendor/products/:id
```

**Request Body:**

```json
{
  "title": "Updated Title",
  "description": "Updated description",
  "seoTitle": "New SEO title",
  "seoDescription": "New SEO description",
  
  // For digital products:
  "digitalConfig": {
    "maxDownloads": 10,
    "expiresAfterDays": 60
  },
  
  // For service products:
  "serviceConfig": {
    "durationMinutes": 90
  }
}
```

> [!IMPORTANT]
> **Image Management Semantics**
> Images are managed through the separate ProductMedia model. This endpoint does not handle images.

**Response:**

```json
{
  "success": true,
  "data": { ...updated product },
  "message": "Product updated successfully"
}
```

**Business Rules:**

- Cannot update `type`, `slug`, or `vendorId`
- Type-specific configs are merged with existing values

---

### Change Product Status

```http
PATCH /api/vendor/products/:id/status
```

**Request Body:**

```json
{
  "status": "active"
}
```

**Valid Statuses:**

- `draft`: Work in progress
- `active`: Live and visible to customers
- `archived`: Hidden from customers
- `pending_review`: Awaiting moderation
- `suspended`: Temporarily disabled

**Response:**

```json
{
  "success": true,
  "data": { ...updated product },
  "message": "Product status changed to active"
}
```

**Validation Rules:**

> [!WARNING]
> **Activation Requirements**
>
> Cannot activate product if:
> - **Digital product**: No `digitalConfig.assetId` (must upload asset first)
> - **Service product**: No `serviceConfig.durationMinutes` (must set duration)

**Error Response (422 UNPROCESSABLE_ENTITY):**

```json
{
  "success": false,
  "error": {
    "code": "UNPROCESSABLE_ENTITY",
    "message": "Cannot activate digital product without uploading a digital asset"
  }
}
```

---

### Duplicate Product

```http
POST /api/vendor/products/:id/duplicate
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439014",
    "status": "draft",
    "title": "Blue T-Shirt (copy)",
    "slug": "blue-t-shirt-copy",
    ...
  },
  "message": "Product duplicated successfully"
}
```

**Duplication Behavior:**

- New product has `status = draft`
- Title: `{original title} (copy)`
- Slug: Intelligent collision prevention
  - First copy: `original-slug-copy`
  - Subsequent: `original-slug-copy-2`, `original-slug-copy-3`, etc.
- **Digital products**: `assetId` is NOT copied (must re-upload)
- **Service products**: All config is copied

---

### Archive Product

```http
DELETE /api/vendor/products/:id
```

**Response:**

```json
{
  "success": true,
  "message": "Product archived successfully"
}
```

> [!NOTE]
> **Soft Delete**
> This is a soft delete. Product status becomes `archived`, but data is not removed.

---

## Bulk Operations

### Bulk Archive

```http
POST /api/vendor/products/bulk/archive
```

**Request Body:**

```json
{
  "productIds": [
    "507f1f77bcf86cd799439011",
    "507f1f77bcf86cd799439012",
    "507f1f77bcf86cd799439013"
  ]
}
```

**Limits:**

- Max 50 products per request

**Response:**

```json
{
  "success": true,
  "data": {
    "success": 3,
    "failed": 0,
    "total": 3
  },
  "message": "Archived 3 of 3 products"
}
```

---

### Bulk Status Change

```http
POST /api/vendor/products/bulk/status
```

**Request Body:**

```json
{
  "productIds": [
    "507f1f77bcf86cd799439011",
    "507f1f77bcf86cd799439012"
  ],
  "status": "active"
}
```

**Limits:**

- Max 50 products per request

**Response:**

```json
{
  "success": true,
  "data": {
    "success": 1,
    "failed": 1,
    "total": 2,
    "errors": [
      {
        "productId": "507f1f77bcf86cd799439012",
        "reason": "Cannot activate digital product without uploading a digital asset"
      }
    ]
  },
  "message": "Updated 1 of 2 products"
}
```

> [!IMPORTANT]
> **Validation on Activation**
> When changing status to `active`, each product is validated individually. Products failing validation are reported in the `errors` array.

---

## Digital Product Management

### Upload Digital Asset

```http
POST /api/vendor/products/:id/digital/asset
```

> [!TIP]
> **Workflow Requirement**
> 1. Create Product (Draft) -> Get ID
> 2. **Upload Asset (Here)** -> Backend links asset to Product
> 3. Create Variant (Price) -> Backend links to Product
> 4. Activate Product
>
> See [Product Creation Workflows](./product-update.md) for the full guide.

**Request Body:** `multipart/form-data`
- `file`: The digital file (max 500MB)

**Response:**

```json
{
  "success": true,
  "data": {
    "assetId": "507f1f77bcf86cd799439013",
    "filename": "guide.pdf",
    "size": 102400,
    "mimeType": "application/pdf"
  },
  "message": "Digital asset uploaded successfully"
}
```

---

### Replace Digital Asset

```http
PUT /api/vendor/products/:id/digital/asset
```

> [!WARNING]
> **Not Yet Implemented**

---

### Remove Digital Asset

```http
DELETE /api/vendor/products/:id/digital/asset
```

> [!WARNING]
> **Not Yet Implemented**

---

## Service Product Management

### Get Calendar Status

```http
GET  /api/vendor/products/:id/service/calendar-status
```

**Response (STUB):**

```json
{
  "success": true,
  "data": {
    "connected": false,
    "lastSyncAt": null,
    "syncStatus": "not_configured",
    "note": "Google Calendar integration not yet implemented. This is a placeholder for future integration."
  }
}
```

> [!WARNING]
> **Stub Only - Future Integration Point**
>
> This endpoint currently returns placeholder data.
> Real Google Calendar integration is not yet implemented.
> This prevents tech debt confusion.

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request validation failed (Zod schema) |
| `NOT_FOUND` | 404 | Product not found |
| `FORBIDDEN` | 403 | Product not owned by vendor |
| `UNPROCESSABLE_ENTITY` | 422 | Invalid state transition (e.g., activating invalid product) |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

**Error Response Format:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "title",
        "message": "Title must be at least 3 characters"
      }
    ]
  }
}
```

---

## Type-Specific Fields

### Physical Product

Physical products use the variant system for pricing and inventory:

```json
{
  "type": "physical",
  "hasVariants": true
}
```

> [!NOTE]
> Physical product pricing is managed through ProductVariant records (separate API).

---

### Digital Product

Digital products require:

```json
{
  "type": "digital",
  "digitalConfig": {
    "assetId": "507f...",        // Required for activation
    "maxDownloads": 5,             // null = unlimited
    "expiresAfterDays": 30,       // null = never expires
    "isActive": true
  }
}
```

**Delivery Rules:**

- `maxDownloads`: Max times customer can download (null = unlimited)
- `expiresAfterDays`: Days until download link expires (null = never)
- `isActive`: Toggles delivery without deleting asset

---

### Service Product

Service products require booking configuration:

```json
{
  "type": "service",
  "serviceConfig": {
    "durationMinutes": 60,          // Required for activation
    "bufferBeforeMinutes": 10,      // Optional
    "bufferAfterMinutes": 10,       // Optional
    "bookingMode": "calendar"       // "calendar" | "manual" | "capacity"
  }
}
```

**Booking Modes:**

- `calendar`: Google Calendar integration
- `manual`: Vendor manages availability manually
- `capacity`: Concurrent booking support

---

## Implementation Notes

1. **Vendor Ownership**: All operations enforce vendor ownership via `vendorId` from auth token
2. **Soft Delete**: DELETE endpoint sets `status = 'archived'`, does not remove from database
3. **Draft Status**: New products default to `draft` status
4. **Slug Uniqueness**: Duplication uses `-copy`, `-copy-2`, etc. for collision prevention
5. **Sorting**: Default sort is `createdAt desc` (newest first)
6. **Bulk Operations**: All bulk operations validate vendor ownership for all IDs
7. **Type Safety**: TypeScript interfaces enforce type-specific configs
8. **Image Management**: Images are managed through ProductMedia model (separate API)
