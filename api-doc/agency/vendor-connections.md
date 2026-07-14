# Vendor Connections (Agency-Facing)

## Base Path

```
/api/agency/vendor-connections
```

## Authentication

**Authorization**: Agency access required.

```
Authorization: Bearer <access_token>
```

## Overview

Symmetric counterpart to [Vendor: Agency Connections](../vendor/agency-connections.md) — read
that doc first for the full status lifecycle (`pending → active/rejected/withdrawn`,
`active ⇄ paused_reapproval`, `→ terminated`, re-request reuses the same record). This doc covers
the agency side: searching vendors, sending/receiving requests, and approving/rejecting.

This is the **primary** "who's connected to me" view — it supersedes the legacy,
narrower `GET /api/agency/vendors` (see [Agency Vendors](./vendors.md)), which only showed
vendors using this agency as their **default**. `GET /api/agency/vendor-connections?status=active`
includes every connected vendor, including ones connected only via a per-product override.

---

## Endpoints

### GET /api/agency/vendor-connections/browse

**Description**: Search vendors to request a connection with. Each result is annotated with your
current connection state to that vendor (if any).

**Authorization**: Agency access required.

**Query Parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number |
| `limit` | integer | `20` | Items per page (max 100) |
| `search` | string | — | Free-text search across business name, display name, and business address city/state/line1 |
| `city` | string | — | Filter by business address city (case-insensitive partial match) |
| `state` | string | — | Filter by business address state/region (case-insensitive partial match) |
| `return_eligible` | `"true"` | — | Only vendors whose return policy accepts returns |
| `cancellable` | `"true"` | — | Only vendors whose cancellation policy allows cancellation |

Only vendors with `status ≠ "inactive"` and completed onboarding (`onboardingStep = 0`) are returned.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439aaa",
      "businessName": "Acme Store",
      "displayName": "Acme",
      "logoUrl": "https://cdn.example.com/logos/acme.png",
      "kycVerified": true,
      "primaryAddress": { "label": "Main Shop", "addressLine1": "12 Rue de la Paix", "city": "Douala", "state": "Littoral" },
      "policies": {
        "returnPolicy": { "returnEligible": true, "returnWindowDays": 14, "refundType": "full" },
        "cancellationPolicy": { "cancellable": true, "cancellationDeadline": "within_24_hours" },
        "supportPolicy": { "availability": "business_hours", "languages": ["en", "fr"] }
      },
      "connection": null
    }
  ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

> Support-channel contact values (email/phone/WhatsApp handles), KYC numbers, and payout details
> are never included in this listing — same privacy scoping as the vendor-facing agency browse.

---

### POST /api/agency/vendor-connections

**Description**: Send a connection request to a vendor.

**Request Body**:
```json
{ "counterpartyId": "507f1f77bcf86cd799439aaa" }
```
`counterpartyId` is the vendor's ObjectId.

**Success Response** (`201 Created`): a `ConnectionDto`, `status: "pending"`, `requesterRole: "agency"`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONNECTION_VENDOR_NOT_FOUND` | `counterpartyId` does not resolve to a vendor |
| `409` | `CONNECTION_ALREADY_EXISTS` | A connection with this vendor already exists and is `pending`, `active`, or `paused_reapproval` |
| `400` | `VALIDATION_ERROR` | `counterpartyId` missing or not a valid ObjectId |

---

### GET /api/agency/vendor-connections

**Description**: List your own connections, any status, newest-updated first.

**Query Parameters**: `status` (optional), `page` (default 1), `limit` (default 20, max 100).

---

### GET /api/agency/vendor-connections/:id

**Description**: Full detail for one of your own connections. 404s if it belongs to a different agency.

---

### POST /api/agency/vendor-connections/:id/approve

**Description**: Approve a request the vendor sent you (`pending → active`), or reapprove a
connection paused because the vendor changed its policies (`paused_reapproval → active`).

- If `pending`: you must be the approver (`403 CONNECTION_NOT_APPROVER` if you sent this request).
- If `paused_reapproval`: you must be the party owed reapproval (`403 CONNECTION_WRONG_REAPPROVAL_PARTY` otherwise).
- Any other status: `400 CONNECTION_INVALID_STATUS_TRANSITION`.

---

### POST /api/agency/vendor-connections/:id/reject

**Description**: Reject a `pending` request the vendor sent you.

**Request Body** (optional): `{ "reason": "Out of our coverage area" }`

**Error Responses**: `422 CONNECTION_NOT_PENDING`, `403 CONNECTION_NOT_APPROVER`

---

### POST /api/agency/vendor-connections/:id/withdraw

**Description**: Withdraw a `pending` request you sent.

**Error Responses**: `422 CONNECTION_NOT_PENDING`, `403 CONNECTION_NOT_REQUESTER`

---

### POST /api/agency/vendor-connections/:id/terminate

**Description**: End an `active` or `paused_reapproval` connection outright.

**Request Body** (optional): `{ "note": "..." }`

**Error Responses**: `400 CONNECTION_INVALID_STATUS_TRANSITION`

---

## Response Field Reference & TypeScript Reference

Identical `ConnectionDto` shape and `AgencyVendorListItemDto`/`AgencyVendorPolicySummaryDto` browse
shape (mirroring `VendorAgencyListItemDto` on the vendor side) — see
[Vendor: Agency Connections](../vendor/agency-connections.md#response-field-reference) for the
full `ConnectionDto` reference.

```typescript
interface AgencyVendorListItemDto {
  id: string;
  businessName: string;
  displayName: string | null;
  logoUrl: string | null;
  kycVerified: boolean;
  primaryAddress: { label: string; addressLine1: string; city: string; state: string | null } | null;
  policies: {
    returnPolicy: { returnEligible: boolean; returnWindowDays: number; refundType: 'full' | 'partial' | 'none' } | null;
    cancellationPolicy: { cancellable: boolean; cancellationDeadline: string | null } | null;
    supportPolicy: { availability: '24_7' | 'business_hours' | 'limited' | null; languages: string[] } | null;
  } | null;
}
```

---

## Usage Examples

```
GET  /api/agency/vendor-connections/browse?search=acme&city=douala
POST /api/agency/vendor-connections               { "counterpartyId": "507f1f77bcf86cd799439aaa" }
GET  /api/agency/vendor-connections?status=active
POST /api/agency/vendor-connections/665f.../approve
```

---

## Notifications

You receive an agency notification (in-app, always; plus your configured secondary channel) for:
- `connection.request_received` — a vendor sent you a request
- `connection.approved` — a vendor approved or reapproved a connection
- `connection.rejected` — a vendor rejected your request
- `connection.reapproval_needed` — a vendor changed its policies and you need to reapprove

Toggle these as a group via the `connectionUpdated` flag on
[notification preferences](./notifications.md) (default: on). Vendors receive the symmetric
notification when you (the agency) are the actor — see
[Vendor Notifications — Events](../vendor/notifications.md#events).
