# Vendor API Overview

## Base Path

All vendor endpoints share this base path:

```
/api/vendor
```

## Authentication

**Mechanism**: Bearer token authentication

**Required Header**:
```
Authorization: Bearer <access_token>
```

**Role Requirement**: All vendor endpoints require the user to have the `vendor` role. Requests without valid vendor credentials will receive a `401` or `403` error.

**Vendor Scope**: All operations are automatically scoped to the authenticated vendor. Vendor ID is extracted from the access token and used to enforce data isolation.

## Common Response Envelope

All successful responses follow this format:

```json
{
  "success": true,
  "data": <object | array>,
  "message": "<optional success message>"
}
```

For list operations with pagination, the response includes a `meta` field:

```json
{
  "success": true,
  "data": [...],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5
  }
}
```

## Pagination Format

List endpoints support pagination via query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (1-indexed) |
| `limit` | integer | 20 | Items per page (max: 100) |

## Standard Error Object

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  }
}
```

For validation errors, an additional `details` field is included:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "fieldName",
        "message": "Validation error message"
      }
    ]
  }
}
```

## Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Valid token but insufficient permissions |
| `NOT_FOUND` | 404 | Resource does not exist or does not belong to vendor |
| `VALIDATION_ERROR` | 400 | Request body or query parameters failed validation |
| `INVALID_PRODUCT_TYPE` | 400 | Operation not applicable to product type (e.g., variants on service products) |
| `SKU_ALREADY_EXISTS` | 409 | SKU must be unique across all variants |
| `TIME_OVERLAP` | 409 | Availability rule conflicts with existing rule |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Rate Limiting

**Note**: Rate limiting headers are not currently implemented. This section will be updated when rate limiting is added.

## Notes & Constraints

### Resource Ownership

All vendor operations enforce strict ownership:
- Vendors can only access and modify their own resources
- Attempting to access another vendor's resources returns `404 NOT_FOUND` (not `403`) to prevent information disclosure

### Timestamps

All timestamp fields are returned in ISO 8601 format:
```
2026-02-09T23:54:00.000Z
```

### Product Type Constraints

Certain endpoints are only applicable to specific product types:
- **Variants**: Physical and digital products (digital: 1–5 format variants, each with its own asset)
- **Options**: Physical products only
- **Shipping**: Physical products only
- **Availability Rules**: Service products only
- **Digital Assets**: Digital products only — managed **per variant** (`/products/:productId/variants/:variantId/digital/*`)

Attempting to use type-specific endpoints on incompatible product types returns `INVALID_PRODUCT_TYPE` error.

### Soft Deletes

Most resources use soft deletion:
- Deleted items have `status: 'archived'` or a `deletedAt` timestamp
- Archived items are excluded from list operations unless explicitly filtered
- Archived items cannot be restored via API

## API Modules

The vendor API is organized into the following modules:

- [**Onboarding**](./onboarding.md) - Step-by-step vendor onboarding flow (basic setup, delivery linking, branding)
- [**Delivery Agencies**](./delivery-agencies.md) - Browse and select a default delivery agency
- [**Products**](./products.md) - Product CRUD, status, duplication
- [**Variants**](./variants.md) - Manage product variants (physical and digital products)
- [**Digital Products**](./digital-products.md) - Multi-variant digital products: per-variant assets (1–5 formats), upload/replace/remove, download limits, activation rules, UI guidance
- [**Product Upload Flow**](./product-upload-flow.md) - End-to-end create-to-publish flow per product type
- [**Shipping**](./shipping.md) - Configure shipping for physical products
- [**Availability Rules**](./availability-rules.md) - Define service availability schedules
- [**Orders**](./orders.md) - View and manage vendor orders
- [**Notifications**](./notifications.md) - View notifications and configure preferences
