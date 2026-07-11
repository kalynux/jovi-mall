# Agency Vendors

## Base Path

```
/api/agency
```

## Authentication

**Authorization**: Agency access required. Bearer token with `agency` role.

> [!IMPORTANT]
> **Legacy endpoint.** `GET /api/agency/vendors` only shows vendors who set this agency as their
> **default**, which is narrower than "every vendor connected to me" — a vendor connected to this
> agency *only* via a per-product override never appears here. For the full, connection-truth-based
> "who's connected to me" view (with request/approve/reject actions), use
> [Agency Vendor Connections](./vendor-connections.md) (`GET /api/agency/vendor-connections?status=active`)
> instead. This endpoint still works and its narrower meaning is unchanged — kept for
> backward compatibility.

---

### GET /api/agency/vendors

**Description**: Vendors who have set this agency as their **default delivery agency**
(`vendor.default_delivery_agency_id`). Read-only — an agency cannot change this relationship; it
is configured on the vendor side (`PUT /api/vendor/profile/default-delivery-agency`), which now
requires an active connection with this agency — see [Agency Vendor Connections](./vendor-connections.md).

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
      "id": "507f1f77bcf86cd799439aaa",
      "businessName": "Acme Store",
      "displayName": "Acme",
      "email": "acme@example.com",
      "phone": "+237670000001",
      "status": "active",
      "businessAddress": { "label": "Main Shop", "city": "Douala", "state": "Littoral" }
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "pages": 1 }
}
```

> A vendor here means every **physical** product of theirs that has no product-level delivery
> override resolves to this agency at order time. See
> [agency/products.md](products.md) for the product-level view.

**Error Responses**:

| Status | Code | Reason |
|---|---|---|
| `401` | `UNAUTHORIZED` | Missing or invalid JWT token |
| `403` | `FORBIDDEN` | Authenticated user is not an agency |
| `500` | `INTERNAL_ERROR` | Unexpected server error |
