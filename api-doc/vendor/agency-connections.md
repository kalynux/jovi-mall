# Agency Connections (Vendor-Facing)

## Base Path

```
/api/vendor/agency-connections
```

## Authentication

**Authorization**: Vendor access required.

```
Authorization: Bearer <access_token>
```

## Overview

A vendor may only assign a delivery agency (as their default, or as a per-product override)
once that agency has **accepted** a connection request — either sent by the vendor or by the
agency. This module replaces the old fully-open assignment: browsing an agency's public listing
(`GET /api/vendor/delivery-agencies`) no longer implies you can use it — you need an `active`
connection first.

**Status lifecycle**: `pending` → `active` / `rejected` / `withdrawn`. An `active` connection can
later flip to `paused_reapproval` — automatically, by the system — whenever **either side** edits
their policies (`Vendor.policies` or `DeliveryAgency.policies`); the side that did **not** just
change is the one who must reapprove (`POST .../:id/approve` again). While paused, any of your
products depending on that agency (as default or override) are auto-suspended, and are
auto-restored the moment the connection goes back to `active`. From `active` or
`paused_reapproval`, either side may also `terminate` the connection outright.

A rejected/withdrawn/terminated connection can be re-requested — this reuses the same
underlying record (there is only ever one connection document per vendor↔agency pair), resetting
it back to `pending`.

---

## Endpoints

### GET /api/vendor/agency-connections/browse

**Description**: Search delivery agencies to request a connection with. Same underlying agency
listing/filters as `GET /api/vendor/delivery-agencies`, but each result is annotated with your
current connection state to that agency (if any), so the UI can render the right button
(Request / Pending / Connected / Reapproval Needed).

**Authorization**: Vendor access required.

**Query Parameters**: same as [`GET /api/vendor/delivery-agencies`](./delivery-agencies.md) —
`search`, `region`, `hq_city`, `storage_based`, `pickup_based`, `returns_payer`,
`min_claim_deadline_days`, `page`, `limit`.

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [
    {
      "id": "683abc1234567890abcdef01",
      "agencyName": "Swift Deliveries Cameroon",
      "logoUrl": "https://cdn.example.com/logos/swift-deliveries.png",
      "kycVerified": true,
      "headquartersAddress": { "region": "Littoral", "city": "Douala", "address_description": "4th Floor, Immeuble Ndokotti, Akwa" },
      "coverageAreas": ["littoral", "centre", "west"],
      "rating": null,
      "policies": { "pricing": { "storage_based_enabled": true, "pickup_based_enabled": true, "notes": null }, "returns": { "payer": "vendor", "return_window_days": 7, "notes": null }, "damage": { "claim_deadline_days": 5, "max_refund_per_item": 50000, "notes": null } },
      "connection": { "id": "665f0000000000000000aa11", "status": "pending" }
    },
    {
      "id": "683abc1234567890abcdef02",
      "agencyName": "Rapid Cargo",
      "logoUrl": null,
      "kycVerified": false,
      "headquartersAddress": null,
      "coverageAreas": ["centre"],
      "rating": null,
      "policies": null,
      "connection": null
    }
  ],
  "meta": { "total": 2, "page": 1, "limit": 20, "totalPages": 1 }
}
```

`connection` is `null` when you've never requested a connection with that agency. Otherwise it's
`{ id, status }` — use `id` to drive `approve`/`reject`/`withdraw`/`terminate` calls.

---

### POST /api/vendor/agency-connections

**Description**: Send a connection request to an agency.

**Request Body**:
```json
{ "counterpartyId": "683abc1234567890abcdef01" }
```
`counterpartyId` is the agency's ObjectId.

**Success Response** (`201 Created`): a `ConnectionDto` (see below), `status: "pending"`,
`requesterRole: "vendor"`.

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| `404` | `CONNECTION_VENDOR_NOT_FOUND` | Your vendor profile could not be resolved (should not normally happen — you're authenticated as this vendor) |
| `404` | `DELIVERY_AGENCY_NOT_FOUND` | `counterpartyId` does not resolve to an agency |
| `409` | `CONNECTION_ALREADY_EXISTS` | A connection with this agency already exists and is `pending`, `active`, or `paused_reapproval` |
| `400` | `VALIDATION_ERROR` | `counterpartyId` missing or not a valid ObjectId |

---

### GET /api/vendor/agency-connections

**Description**: List your own connections, any status, newest-updated first.

**Query Parameters**: `status` (optional, one of the statuses below), `page` (default 1), `limit` (default 20, max 100).

**Success Response** (`200 OK`):
```json
{
  "success": true,
  "data": [ { "...ConnectionDto..." } ],
  "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

### GET /api/vendor/agency-connections/:id

**Description**: Full detail for one of your own connections. 404s (not 403) if the connection
belongs to a different vendor — existence is never leaked.

**Success Response** (`200 OK`): a `ConnectionDto`.

**Error Responses**: `404 CONNECTION_NOT_FOUND`

---

### POST /api/vendor/agency-connections/:id/approve

**Description**: Approve a request the agency sent you (`pending → active`), or reapprove a
connection paused because the agency changed its policies (`paused_reapproval → active`). The
same endpoint handles both — the current status decides which happens.

- If `pending`: you must be the **approver**, i.e. the agency was the requester
  (`403 CONNECTION_NOT_APPROVER` if you sent this request yourself).
- If `paused_reapproval`: you must be the party currently owed reapproval
  (`403 CONNECTION_WRONG_REAPPROVAL_PARTY` if the agency is the one who needs to act, not you).
- Any other status: `400 CONNECTION_INVALID_STATUS_TRANSITION`.

Reapproving restores any of your products that were auto-suspended while this connection was
paused (see Overview).

> [!IMPORTANT]
> **Your first-ever approved connection automatically becomes your default delivery agency** — if
> you don't have one set yet (`vendor.default_delivery_agency_id` is null), approving this
> connection (whether you sent the request or an agency did) sets it for you, with no extra call
> needed. This does **not** happen again for any later connection — once you have a default, you
> switch it explicitly via
> [`PUT /api/vendor/profile/default-delivery-agency`](./profile.md#put-apivendorprofiledefault-delivery-agency),
> e.g. once you have several active contracts to choose from. Reapproving an already-once-active
> connection never triggers this (you'd already have a default by then).

**Success Response** (`200 OK`): the updated `ConnectionDto`, `status: "active"`.

---

### POST /api/vendor/agency-connections/:id/reject

**Description**: Reject a `pending` request the agency sent you. Only valid from `pending`, and
only by the approver (you can't reject your own outgoing request — use `withdraw` instead).

**Request Body** (optional):
```json
{ "reason": "We don't currently ship to that region" }
```

**Error Responses**: `422 CONNECTION_NOT_PENDING`, `403 CONNECTION_NOT_APPROVER`

---

### POST /api/vendor/agency-connections/:id/withdraw

**Description**: Withdraw a `pending` request you sent. Only the requester may withdraw.

**Error Responses**: `422 CONNECTION_NOT_PENDING`, `403 CONNECTION_NOT_REQUESTER`

---

### POST /api/vendor/agency-connections/:id/terminate

**Description**: End an `active` or `paused_reapproval` connection outright. Either party may
terminate at any time — no approval needed. Triggers the same product-suspension cascade as a
pause (see Overview).

**Request Body** (optional):
```json
{ "note": "Switching to a different regional partner" }
```

**Error Responses**: `400 CONNECTION_INVALID_STATUS_TRANSITION` — not currently `active` or `paused_reapproval`

---

## Response Field Reference

### `ConnectionDto`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Connection ObjectId. |
| `vendorId` / `agencyId` | `string` | The two parties. |
| `status` | `"pending" \| "active" \| "rejected" \| "withdrawn" \| "paused_reapproval" \| "terminated"` | Current state — see Overview. |
| `requesterRole` | `"vendor" \| "agency"` | Who sent the request that's currently active/pending. |
| `requestedByUserId` / `requestedAt` | | Who and when the (re-)request was sent. |
| `respondedByUserId` / `respondedAt` | | Who and when it was last approved/reapproved. `null` before first approval. |
| `reapprovalRequiredFrom` | `"vendor" \| "agency" \| null` | Set only while `paused_reapproval` — the side that must act. |
| `pausedAt` / `pausedReason` | | When and why it was paused (`"vendor_policy_changed"` \| `"agency_policy_changed"`). |
| `rejection` | `{ reason, rejectedByRole, rejectedAt } \| null` | Set only if currently/previously `rejected`. |
| `withdrawal` | `{ withdrawnByRole, withdrawnAt } \| null` | Set only if currently/previously `withdrawn`. |
| `termination` | `{ terminatedByRole, terminatedAt, reason, note } \| null` | `reason` is `"unilateral"` or `"reapproval_declined"` (terminated instead of reapproving). |
| `createdAt` / `updatedAt` | | Standard timestamps. |

---

## TypeScript Reference

```typescript
type ConnectionStatus = 'pending' | 'active' | 'rejected' | 'withdrawn' | 'paused_reapproval' | 'terminated';
type ConnectionParty = 'vendor' | 'agency';

interface ConnectionDto {
  id: string;
  vendorId: string;
  agencyId: string;
  status: ConnectionStatus;
  requesterRole: ConnectionParty;
  requestedByUserId: string;
  requestedAt: string;
  respondedByUserId: string | null;
  respondedAt: string | null;
  reapprovalRequiredFrom: ConnectionParty | null;
  pausedAt: string | null;
  pausedReason: 'vendor_policy_changed' | 'agency_policy_changed' | null;
  rejection: { reason: string | null; rejectedByRole: ConnectionParty; rejectedAt: string } | null;
  withdrawal: { withdrawnByRole: ConnectionParty; withdrawnAt: string } | null;
  termination: { terminatedByRole: ConnectionParty; terminatedAt: string; reason: 'unilateral' | 'reapproval_declined'; note: string | null } | null;
  createdAt: string;
  updatedAt: string;
}
```

---

## Usage Examples

```
GET  /api/vendor/agency-connections/browse?search=swift
POST /api/vendor/agency-connections               { "counterpartyId": "683abc1234567890abcdef01" }
GET  /api/vendor/agency-connections?status=pending
POST /api/vendor/agency-connections/665f.../approve
POST /api/vendor/agency-connections/665f.../reject   { "reason": "Not a fit right now" }
POST /api/vendor/agency-connections/665f.../withdraw
POST /api/vendor/agency-connections/665f.../terminate { "note": "Switching partners" }
```

Your first `active` connection is automatically set as your default — nothing else to call. For
any connection after that, set it as your default via
[`PUT /api/vendor/profile/default-delivery-agency`](./profile.md#put-apivendorprofiledefault-delivery-agency),
or as a per-product override via [`PATCH /api/vendor/products/:id`](./products.md).

---

## Notifications

You receive a vendor notification (in-app, always; plus your configured secondary channel) for:
- `connection.request_received` — an agency sent you a request
- `connection.approved` — an agency approved or reapproved a connection
- `connection.rejected` — an agency rejected your request
- `connection.reapproval_needed` — an agency changed its policies and you need to reapprove

Toggle these as a group via the `connectionUpdated` flag on
[notification preferences](./notifications.md) (default: on). Agency-side notifications for these
same events (e.g. "a vendor sent you a request") are not yet implemented — agencies should poll
`GET /api/agency/vendor-connections?status=pending` / `?status=paused_reapproval`.
