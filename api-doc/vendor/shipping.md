# Shipping Configuration

**Verified against source on 2026-09-08** — the request schema, the units and the serialised key,
against `src/modules/catalog/controllers/vendor-shipping.controller.ts:13-21`,
`src/modules/catalog/models/shipping-config.model.ts:21` and `src/core/base.schema.ts:17-26`.
**Two live defects fixed:** `weight` is in **grams**, not kilograms (stated wrongly in two
places), and all four measurements accept **`0`** — the "must be positive (> 0)" table was reading
the Zod *message*, not the constraint.

## Base Path

All endpoints in this document share this base path:

```
/api/vendor/products/:id/shipping
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token with vendor role:

```
Authorization: Bearer <access_token>
```

## Endpoints

### POST /api/vendor/products/:id/shipping

**Description**: Create or update shipping configuration for a physical product. This endpoint performs an upsert operation.

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
  "weight": "number (required, >= 0) - Weight in GRAMS (not kilograms)",
  "length": "number (required, >= 0) - Length in centimeters",
  "width": "number (required, >= 0) - Width in centimeters",
  "height": "number (required, >= 0) - Height in centimeters",
  "originZipCode": "string (required, min 1, max 20) - Origin postal code",
  "handlingDays": "number (optional, integer, >= 0, default: 1) - Processing time in days",
  "shippingEnabled": "boolean (optional, default: true) - Whether shipping is enabled"
}
```

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "productId": "string",
    "weight": 5.5,
    "length": 30,
    "width": 20,
    "height": 10,
    "originZipCode": "12345",
    "handlingDays": 1,
    "shippingEnabled": true,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  },
  "message": "Shipping configuration saved successfully"
}
```

**Error Responses**:
- `404` – `CATALOG_PRODUCT_NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `CATALOG_PRODUCT_INVALID_TYPE` – Only physical products can have shipping configuration
- `400` – `VALIDATION_ERROR` – Invalid request body (e.g., negative dimensions, invalid zip code)

---

### GET /api/vendor/products/:id/shipping

**Description**: Retrieve the shipping configuration for a product.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "data": {
    "id": "string",
    "productId": "string",
    "weight": 5.5,
    "length": 30,
    "width": 20,
    "height": 10,
    "originZipCode": "12345",
    "handlingDays": 1,
    "shippingEnabled": true,
    "createdAt": "2026-02-09T23:54:00.000Z",
    "updatedAt": "2026-02-09T23:54:00.000Z"
  }
}
```

**Error Responses**:
- `404` – `CATALOG_PRODUCT_NOT_FOUND` – Product not found or does not belong to vendor
- `404` – `CATALOG_SHIPPING_NOT_FOUND` – No shipping configuration exists for this product

---

### DELETE /api/vendor/products/:id/shipping

**Description**: Delete the shipping configuration for a product.

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

**Path Parameters**:
- `id` (string, required) - Product ID

**Query Parameters**: None

**Request Body**: None

**Success Response**:

Status: `200 OK`

Body:
```json
{
  "success": true,
  "message": "Shipping configuration deleted successfully"
}
```

**Error Responses**:
- `404` – `CATALOG_PRODUCT_NOT_FOUND` – Product not found or does not belong to vendor

---

## Error Responses

All error responses follow this format. `category` is one of the nine values listed in
[`errors/README.md`](../errors/README.md) and is **always present**; `details` is omitted
entirely when absent.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "CATALOG_PRODUCT_NOT_FOUND",
    "message": "Product not found",
    "statusCode": 404,
    "category": "not_found"
  }
}
```

For validation errors:

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
          "path": "weight",
          "message": "Weight must be positive",
          "code": "too_small"
        }
      ]
    }
  }
}
```

## Notes & Constraints

### Product Type Restriction

Only **physical products** can have shipping configuration. Attempting to configure shipping for `digital` or `service` products returns:

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "CATALOG_PRODUCT_INVALID_TYPE",
    "message": "Only physical products can have shipping configuration",
    "statusCode": 400,
    "category": "validation"
  }
}
```

### Units

- 🔴 **Weight: GRAMS (g).** This page said *kilograms* in two places until 2026-09-08 and was
  wrong in both. `shipping-config.model.ts:21` reads *"Default weight in grams"*, and the variant
  documentation has always agreed with the model. **Label the input "g"** — a vendor typing `2`
  for a 2 kg parcel otherwise records a 2 g one.
- **Dimensions**: Centimeters (cm)
- **Handling Days**: Integer representing business days

### Upsert Behavior

The `POST` endpoint performs an upsert:
- If no shipping configuration exists, it creates one
- If shipping configuration already exists, it updates the existing record

There is no separate `PUT` or `PATCH` endpoint for updates.

### Validation Constraints

| Field | Constraint |
|-------|------------|
| `weight` | `>= 0` — **`0` is accepted** |
| `length` | `>= 0` — **`0` is accepted** |
| `width` | `>= 0` — **`0` is accepted** |
| `height` | `>= 0` — **`0` is accepted** |

> ⚠ These four rows said *"Must be positive (> 0)"* until 2026-09-08. The schema is
> `z.number().min(0, 'Weight must be positive')` (`vendor-shipping.controller.ts:14-17`) — the
> **message** says "positive", the **constraint** is `>= 0`, and that message is where the wrong
> claim came from. Do not add a client-side `> 0` rule the server does not have.
| `originZipCode` | Required, 1-20 characters |
| `handlingDays` | Non-negative integer |

### Shipping Enabled Flag

The `shippingEnabled` flag allows vendors to temporarily disable shipping without deleting the configuration. When `false`, the product cannot be shipped but configuration is preserved.

### Shipping Deletion

Deleting shipping configuration does **not** archive or deactivate the product. The product remains in its current status, but shipping is no longer available.
