# Agency Products

**Verified against source on 2026-09-08** — `GET /api/agency/products` and the error catalogue, against `jovi-mall/src/modules/delivery/agency.routes.ts` and `src/core/error-codes.ts`.

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

---

### GET /api/agency/products

**Description**: Physical products this agency is set up to deliver once ordered. Combined view —
a product appears here if **either**:
1. its own `delivery.agencyId` override points at this agency (`source: "own_override"`), **or**
2. it has no override and belongs to a vendor whose `default_delivery_agency_id` is this agency
   (`source: "vendor_default"`).

Read-only — an agency cannot change either relationship; both are configured on the vendor side
(product edit form / `PUT /api/vendor/profile/default-delivery-agency`).

**Request Headers**:
```http
Authorization: Bearer <token>
```

**Query Parameters**:
- `page` (integer, optional, default 1)
- `limit` (integer, optional, default 20, max 100)

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439066",
      "vendorId": "507f1f77bcf86cd799439aaa",
      "title": "T-Shirt",
      "status": "active",
      "category": "apparel",
      "source": "own_override"
    },
    {
      "id": "507f1f77bcf86cd799439067",
      "vendorId": "507f1f77bcf86cd799439aaa",
      "title": "Sneakers",
      "status": "active",
      "category": "footwear",
      "source": "vendor_default"
    }
  ],
  "meta": { "total": 2, "page": 1, "limit": 20, "pages": 1 }
}
```

> See [agency/vendors.md](vendors.md) for the vendor-level "who set me as default" view.

**Error Responses**:

| Status | Code | Reason |
|---|---|---|
| `401` | `AUTH_MISSING_TOKEN` · `AUTH_TOKEN_EXPIRED` · `AUTH_TOKEN_INVALID` | No token, an expired one, or a malformed one. ⚠ **There is no bare `UNAUTHORIZED` code** |
| `403` | `AUTH_ROLE_NOT_FOUND` | Authenticated user is not an agency. ⚠ **There is no bare `FORBIDDEN` code** |
| `500` | `INTERNAL_SERVER_ERROR` | Unexpected server error. ⚠ **Not `INTERNAL_ERROR`** |
