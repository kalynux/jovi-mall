# Variant Management

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/products
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### POST /api/vendor/products/:id/variants

**Description**: Create a new variant for a physical product.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**:
```json
{
  "sku": "string (required, max 100 chars)",
  "price": "number (required, >= 0)",
  "compareAtPrice": "number (optional, >= 0)",
  "stock": "number (optional, integer, >= 0, default: 0)",
  "isInfiniteStock": "boolean (optional, default: false)",
  "weight": "number (optional, >= 0)",
  "length": "number (optional, >= 0)",
  "width": "number (optional, >= 0)",
  "height": "number (optional, >= 0)",
  "optionValueIds": "string[] (optional, default: [])"
}
```

**Success Response**:

Status: `201 Created`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "productId": "string",
    "sku": "string",
    "status": "active",
    "price": 0,
    "compareAtPrice": 0,
    "stock": 0,
    "isInfiniteStock": false,
    "weight": 0,
    "length": 0,
    "width": 0,
    "height": 0,
    "optionSignature": "string",
    "optionValueIds": [],
    "mediaIds": [],
    "deletedAt": null,
    "purgeAt": null
  },
  "message": "Variant created successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `INVALID_PRODUCT_TYPE` – Only physical products can have variants
- `400` – `VALIDATION_ERROR` – Invalid request body (e.g., negative price, invalid SKU)
- `409` – `SKU_ALREADY_EXISTS` – SKU is already in use by another variant

---

### GET /api/vendor/products/:id/variants

**Description**: List all variants for a product with optional filtering and pagination.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**:
- `status` (string, optional) - Filter by status. Enum: `active`, `archived`
- `page` (integer, optional, default: 1) - Page number (1-indexed)
- `limit` (integer, optional, default: 20, max: 100) - Items per page

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": [
    {
      "_id": "string",
      "productId": "string",
      "sku": "string",
      "status": "active",
      "price": 0,
      "compareAtPrice": 0,
      "stock": 0,
      "isInfiniteStock": false,
      "weight": 0,
      "length": 0,
      "width": 0,
      "height": 0,
      "optionSignature": "string",
      "optionValueIds": [],
      "mediaIds": []
    }
  ],
  "meta": {
    "total": 100,
    "page": 1,
    "limit": 20,
    "totalPages": 5
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid query parameters

---

### GET /api/vendor/products/:productId/variants/:variantId

**Description**: Retrieve a single variant by ID.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `productId` (string, required) - Product ID
- `variantId` (string, required) - Variant ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "productId": "string",
    "sku": "string",
    "status": "active",
    "price": 0,
    "compareAtPrice": 0,
    "stock": 0,
    "isInfiniteStock": false,
    "weight": 0,
    "length": 0,
    "width": 0,
    "height": 0,
    "optionSignature": "string",
    "optionValueIds": [],
    "mediaIds": []
  }
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product or variant not found, or does not belong to vendor

---

### PATCH /api/vendor/products/:productId/variants/:variantId

**Description**: Update a variant. All fields are optional.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Path Parameters**:
- `productId` (string, required) - Product ID
- `variantId` (string, required) - Variant ID

**Query Parameters**: None

**Request Body**:
```json
{
  "sku": "string (optional, max 100 chars)",
  "price": "number (optional, >= 0)",
  "compareAtPrice": "number (optional, >= 0)",
  "stock": "number (optional, integer, >= 0)",
  "isInfiniteStock": "boolean (optional)",
  "weight": "number (optional, >= 0)",
  "length": "number (optional, >= 0)",
  "width": "number (optional, >= 0)",
  "height": "number (optional, >= 0)",
  "optionValueIds": "string[] (optional)"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "_id": "string",
    "productId": "string",
    "sku": "string",
    "status": "active",
    "price": 0,
    "stock": 0,
    "isInfiniteStock": false
  },
  "message": "Variant updated successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product or variant not found or does not belong to vendor
- `400` – `VALIDATION_ERROR` – Invalid request body
- `409` – `SKU_ALREADY_EXISTS` – New SKU is already in use

---

### DELETE /api/vendor/products/:productId/variants/:variantId

**Description**: Archive a variant (soft delete). Sets status to `archived`.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `productId` (string, required) - Product ID
- `variantId` (string, required) - Variant ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Variant archived successfully"
}
```

**Error Responses**:
- `404` – `NOT_FOUND` – Product or variant not found or does not belong to vendor

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description"
  }
}
```

For validation errors, a `details` array is included:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "price",
        "message": "Price must be positive"
      }
    ]
  }
}
```

## Notes & Constraints

### Product Type Restriction

Only **physical products** can have variants. Attempting to create variants for `digital` or `service` products returns:
```json
{
  "success": false,
  "error": {
    "code": "INVALID_PRODUCT_TYPE",
    "message": "Only physical products can have variants"
  }
}
```

### SKU Uniqueness

SKU values must be unique across **all variants** (not just variants of the same product). Duplicate SKU attempts return `409` with `SKU_ALREADY_EXISTS` error code.

### Status Field

Variants have a `status` field with possible values:
- `active` - Variant is available for sale
- `archived` - Variant is soft-deleted and excluded from listings

### Stock Management

- `isInfiniteStock: true` - Stock is unlimited, `stock` field is ignored
- `isInfiniteStock: false` - Stock is tracked, `stock` field is decremented on orders

### Option Signature

The `optionSignature` field is a system-generated string used to prevent duplicate option combinations for the same product. Frontend should not send this field.

### Immutable Fields

The following fields cannot be modified after creation:
- `productId`
- `optionSignature`
- `_id`
