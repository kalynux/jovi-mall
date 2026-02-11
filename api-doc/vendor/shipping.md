# Shipping Configuration

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
  "weight": "number (required, >= 0) - Weight in kilograms",
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
    "_id": "string",
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
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor
- `400` – `INVALID_PRODUCT_TYPE` – Only physical products can have shipping configuration
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
    "_id": "string",
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
- `404` – `NOT_FOUND` – Product not found or shipping configuration does not exist

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
- `404` – `NOT_FOUND` – Product not found or does not belong to vendor

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

For validation errors:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "weight",
        "message": "Weight must be positive"
      }
    ]
  }
}
```

## Notes & Constraints

### Product Type Restriction

Only **physical products** can have shipping configuration. Attempting to configure shipping for `digital` or `service` products returns:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PRODUCT_TYPE",
    "message": "Only physical products can have shipping configuration"
  }
}
```

### Units

- **Weight**: Kilograms (kg)
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
| `weight` | Must be positive (> 0) |
| `length` | Must be positive (> 0) |
| `width` | Must be positive (> 0) |
| `height` | Must be positive (> 0) |
| `originZipCode` | Required, 1-20 characters |
| `handlingDays` | Non-negative integer |

### Shipping Enabled Flag

The `shippingEnabled` flag allows vendors to temporarily disable shipping without deleting the configuration. When `false`, the product cannot be shipped but configuration is preserved.

### Shipping Deletion

Deleting shipping configuration does **not** archive or deactivate the product. The product remains in its current status, but shipping is no longer available.
