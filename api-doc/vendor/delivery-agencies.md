# Delivery Agencies (Vendor-Facing)

## Base Path

```
/api/vendor/delivery-agencies
```

## Authentication

**Authorization**: Vendor access required.

All requests must include a valid Bearer token:

```
Authorization: Bearer <access_token>
```

---

## Endpoints

### GET /api/vendor/delivery-agencies

**Description**: List delivery agencies available for selection. Use this endpoint during onboarding (Step 2) or any time the vendor wants to browse or change their default delivery agency.

Only agencies that meet **both** of the following conditions are returned:
- `status` is NOT `"inactive"` (i.e., `"active"` or `"pending_verification"`)
- `onboardingStep` is `0` (onboarding fully completed — all 4 steps done)

**Authorization**: Vendor access required.

**Request Headers**:
- `Authorization: Bearer <token>`

---

#### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | `1` | Page number (1-indexed) |
| `limit` | integer | `20` | Items per page (max: 50) |
| `search` | string | — | Free-text search. Matches against: agency name, coverage areas, headquarters city, headquarters region, headquarters address description. Case-insensitive. |
| `region` | string | — | Filter by coverage area. Case-insensitive partial match on the region key (e.g. `"littoral"`, `"centre"`). Only agencies that serve this region are returned. |
| `hq_city` | string | — | Filter by primary headquarters city. Case-insensitive partial match (e.g. `"Douala"`, `"Yaoundé"`). |
| `storage_based` | `"true"` | — | When set to `"true"`, only return agencies that have **storage-based** pricing enabled (agency warehouses vendor stock). |
| `pickup_based` | `"true"` | — | When set to `"true"`, only return agencies that have **pickup-based** pricing enabled (agency picks up from vendor location). |
| `returns_payer` | `"vendor"` \| `"agency"` \| `"customer"` | — | Filter by who bears the cost of return shipping. |
| `min_claim_deadline_days` | integer | — | Filter for agencies whose damage claim window is **at least** this many days (e.g. `7` filters out agencies with a 3-day window). |

> **Note on combined filters**: All provided query params are applied as AND conditions. `search` and `region` can be used together — for example, search for `"swift"` within region `"littoral"`.

---

#### Success Response

**Status**: `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": "683abc1234567890abcdef01",
      "agencyName": "Swift Deliveries Cameroon",
      "logoUrl": "https://cdn.example.com/logos/swift-deliveries.png",
      "kycVerified": true,
      "headquartersAddress": {
        "region": "Littoral",
        "city": "Douala",
        "address_description": "4th Floor, Immeuble Ndokotti, Akwa"
      },
      "coverageAreas": ["littoral", "centre", "west"],
      "rating": null,
      "policies": {
        "pricing": {
          "storage_based_enabled": true,
          "pickup_based_enabled": true,
          "notes": null
        },
        "returns": {
          "payer": "vendor",
          "return_window_days": 7,
          "notes": "Returns must include original packaging."
        },
        "damage": {
          "claim_deadline_days": 5,
          "max_refund_per_item": 50000,
          "notes": null
        }
      }
    }
  ],
  "meta": {
    "total": 1,
    "page": 1,
    "limit": 20,
    "totalPages": 1
  }
}
```

#### Error Responses

| Status | Code | Description |
|--------|------|-------------|
| `401` | `UNAUTHORIZED` | Missing or invalid auth token |
| `403` | `FORBIDDEN` | Valid token but not a vendor |
| `500` | `INTERNAL_ERROR` | Unexpected server error |

---

## Response Field Reference

### `VendorAgencyListItemDto`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Agency MongoDB ObjectId as string. Use this as `default_delivery_agency_id` in Step 2 of onboarding. |
| `agencyName` | `string` | Registered agency name. |
| `logoUrl` | `string \| null` | Absolute URL to the agency logo. `null` if not set. |
| `kycVerified` | `boolean` | Whether admin has verified the agency's business documents (KYC). `true` = verified. |
| `headquartersAddress` | `object \| null` | Primary headquarters address (always index 0). See below. |
| `coverageAreas` | `string[]` | Region keys this agency serves (e.g. `["littoral", "centre"]`). |
| `rating` | `number \| null` | Average rating (0–5). Always `null` until the rating system is implemented. |
| `policies` | `object \| null` | Policy summary. See below. Always present for agencies with `onboardingStep = 0`. |

### `headquartersAddress`

| Field | Type | Description |
|-------|------|-------------|
| `region` | `string` | State/region name (display label, e.g. `"Littoral"`). |
| `city` | `string` | City name (e.g. `"Douala"`). |
| `address_description` | `string` | Full street address, building, or landmark. |

> **Note**: Only the primary HQ address is returned. Branch addresses and per-location support contacts are intentionally omitted from this listing endpoint.

### `policies`

#### `policies.pricing`

| Field | Type | Description |
|-------|------|-------------|
| `storage_based_enabled` | `boolean` | `true` = agency can warehouse vendor stock and ship from its facility. |
| `pickup_based_enabled` | `boolean` | `true` = agency can collect from vendor's location and deliver to customer. |
| `notes` | `string \| null` | Free-text pricing terms (bulk discounts, minimums, etc.). |

#### `pickup_based` / `storage_based` and pickup locations

These two flags gate which `delivery.pickupLocation.source` values are valid for a **physical
product** assigned to this agency (as the vendor's default or as a product-level override) — see
[Vendor Products — Update Product](./products.md#update-product):

| Product's `pickupLocation.source` | Requires on this agency |
|---|---|
| `vendor_address` (collect from one of the vendor's `business_addresses`) | `pickup_based_enabled: true` |
| `agency_storage` (agency already warehouses this vendor's stock) | `storage_based_enabled: true` |

An agency can offer both (a vendor might warehouse fast-moving SKUs here while doing pickup for
others), either, or — if both are `false` — neither, in which case no physical product can be
activated against it. Before presenting the pickup-location picker to a vendor, fetch this agency
(or the vendor's resolved default/override) and only offer the source(s) whose flag is `true`.

#### `policies.returns`

| Field | Type | Description |
|-------|------|-------------|
| `payer` | `"vendor" \| "agency" \| "customer"` | Who bears the cost of return shipping. |
| `return_window_days` | `number` | Days after delivery within which a return may be initiated. `0` = no returns accepted. |
| `notes` | `string \| null` | Additional return conditions or eligibility criteria. |

#### `policies.damage`

| Field | Type | Description |
|-------|------|-------------|
| `claim_deadline_days` | `number` | Days after delivery within which a damage claim must be filed. |
| `max_refund_per_item` | `number` | Maximum compensation per damaged item (XAF). |
| `notes` | `string \| null` | Additional damage policy conditions. |

### `meta` (Pagination)

| Field | Type | Description |
|-------|------|-------------|
| `total` | `number` | Total matching agencies across all pages. |
| `page` | `number` | Current page number. |
| `limit` | `number` | Items per page used for this response. |
| `totalPages` | `number` | Total number of pages. |

---

## TypeScript Reference

```typescript
// ─── Agency Listing ───────────────────────────────────────────────────────────

export interface VendorAgencyHQAddressDto {
  region: string;
  city: string;
  address_description: string;
}

export interface VendorAgencyPolicySummaryDto {
  pricing: {
    storage_based_enabled: boolean;
    pickup_based_enabled: boolean;
    notes: string | null;
  };
  returns: {
    payer: 'vendor' | 'agency' | 'customer';
    return_window_days: number;
    notes: string | null;
  };
  damage: {
    claim_deadline_days: number;
    max_refund_per_item: number;
    notes: string | null;
  };
}

export interface VendorAgencyListItemDto {
  id: string;
  agencyName: string;
  logoUrl: string | null;
  kycVerified: boolean;
  headquartersAddress: VendorAgencyHQAddressDto | null;
  coverageAreas: string[];
  /** Always null until the rating system is implemented. */
  rating: number | null;
  policies: VendorAgencyPolicySummaryDto | null;
}

export interface AgencyListMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─── API response shape ───────────────────────────────────────────────────────

export interface GetDeliveryAgenciesResponse {
  success: true;
  data: VendorAgencyListItemDto[];
  meta: AgencyListMeta;
}
```

---

## Usage Examples

### Basic: Get all available agencies

```
GET /api/vendor/delivery-agencies
```

### Search by name or location

```
GET /api/vendor/delivery-agencies?search=swift
GET /api/vendor/delivery-agencies?search=douala
GET /api/vendor/delivery-agencies?search=Akwa
```

### Filter by region

```
GET /api/vendor/delivery-agencies?region=littoral
```

### Combined: search within a region

```
GET /api/vendor/delivery-agencies?search=swift&region=littoral
```

### Filter by pricing model

```
GET /api/vendor/delivery-agencies?storage_based=true
GET /api/vendor/delivery-agencies?pickup_based=true
GET /api/vendor/delivery-agencies?storage_based=true&pickup_based=true
```

### Filter by returns payer

```
GET /api/vendor/delivery-agencies?returns_payer=agency
```

### Filter by damage claim window

```
GET /api/vendor/delivery-agencies?min_claim_deadline_days=7
```

### Complex: pickup-capable agencies in Centre region with at least 5-day claim window

```
GET /api/vendor/delivery-agencies?pickup_based=true&region=centre&min_claim_deadline_days=5
```

### Paginate

```
GET /api/vendor/delivery-agencies?page=2&limit=10
```

---

## Using the Selected Agency in Onboarding Step 2

Once the vendor selects an agency from this list, pass its `id` as `default_delivery_agency_id` to the delivery-linking endpoint:

```json
PUT /api/vendor/onboarding/delivery-linking
{
  "default_delivery_agency_id": "683abc1234567890abcdef01"
}
```

Or skip Step 2 entirely (for service-only vendors):

```json
PUT /api/vendor/onboarding/delivery-linking
{
  "skip": true
}
```

> **Validation**: The backend validates that the selected agency ID exists, is not inactive, and has completed onboarding. If any check fails, a `404` or `400` error is returned with a descriptive message.

See [Vendor Onboarding](./onboarding.md) for the full onboarding flow specification.

> [!IMPORTANT]
> **This endpoint is browse-only — it does not require a connection.** Any agency meeting the hard filters above shows up here so you can view its policies before deciding. But actually **assigning** an agency (as your default via `PUT /api/vendor/profile/default-delivery-agency`, or as a per-product override via `PATCH /api/vendor/products/:id`) requires an `active` connection with that agency first. See [Agency Connections](./agency-connections.md) for how to search, request, and get approved.
