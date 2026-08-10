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
      "logo": { "id": "507f1f77bcf86cd799439030", "key": "images/2026/07/swift-logo.png", "url": "https://cdn.example.com/logos/swift-deliveries.png", "mimeType": "image/png", "size": 24576, "originalName": "logo.png" },
      "kycVerified": true,
      "headquartersAddress": {
        "region": "Littoral",
        "city": "Douala",
        "address_description": "4th Floor, Immeuble Ndokotti, Akwa"
      },
      "country": "CM",
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
| `logo` | `FileDetail \| null` | Agency logo as a resolved file object (`{ id, key, url, mimeType, size, originalName }`). `null` if not set. |
| `kycVerified` | `boolean` | Whether admin has verified the agency's business documents (KYC). `true` = verified. |
| `headquartersAddress` | `object \| null` | Primary headquarters address (always index 0). See below. |
| `country` | `string \| null` | 🆕 ISO-2 country the agency operates in (e.g. `"CM"`), set once at their onboarding. What scopes `coverageAreas` to a region catalogue. `null` on legacy agencies. |
| `coverageAreas` | `string[]` | Region keys this agency serves (e.g. `["littoral", "centre"]`), from `locations.json`, always within `country`. |
| `rating` | `number \| null` | Average rating (0–5). Always `null` until the rating system is implemented. |
| `policies` | `object \| null` | Policy summary. See below. Always present for agencies with `onboardingStep = 0`. |

### `headquartersAddress`

| Field | Type | Description |
|-------|------|-------------|
| `region` | `string \| null` | State/region name (e.g. `"Littoral"`), derived from the entry's geocode. `null` when it resolves none. |
| `city` | `string \| null` | City name (e.g. `"Douala"`), derived from the entry's geocode. `null` when it resolves none (rural / landmark addresses). |
| `address_description` | `string` | Full street address, building, or landmark. Always present — use it when `region`/`city` are null. |

> **Note**: Only the primary HQ address is returned **by this listing endpoint**. Per-location support contacts are never returned anywhere. To list an agency's *other* locations — which you need when a vendor picks the depot that warehouses a product — use [GET /api/vendor/delivery-agencies/:agencyId/locations](#list-an-agencys-pickup-locations), which requires an active connection.

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

When the vendor chooses `agency_storage`, follow up with the locations endpoint below so they can
also say **which** depot — an agency commonly has several.

---

## List an agency's pickup locations

`GET /api/vendor/delivery-agencies/:agencyId/locations`

Every physical location (depot / warehouse) the agency operates, so a vendor can name the one that
warehouses a product — the value that goes into `delivery.pickupLocation.agencyAddressId` (see
[Vendor Products — Update Product](./products.md#update-product)).

Unpaginated: an agency has a handful of locations, and a picker that hides options behind a page
boundary is worse than no picker.

**This is the one vendor-facing endpoint that goes past the primary HQ.** It is gated on an
**active connection** with the agency, matching the gate on setting a default agency and on a
product-level agency override: a vendor cannot point a product at an agency they aren't connected
to, so listing that agency's warehouses would only render a picker whose every option is unusable.
Browsing agencies stays open — it is *choosing* one that requires a contract. Per-location
`support_contact` is still withheld.

### Response

```json
{
  "success": true,
  "data": [
    {
      "id": "6641abc123def457",
      "label": "Douala HQ",
      "region": "Littoral",
      "city": "Douala",
      "addressDescription": "Akwa, Rue Sylvani, immeuble ABC",
      "isPrimary": true
    },
    {
      "id": "6641abc123def458",
      "label": "Bonabéri branch",
      "region": "Littoral",
      "city": "Douala",
      "addressDescription": "Bonabéri, Rue des Palmiers",
      "isPrimary": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | The depot's id — send this as `agencyAddressId` when configuring a product. |
| `label` | `string \| null` | The agency's own name for the location. `null` on entries saved before labels existed — fall back to `"Primary Headquarters"` / `"Branch N"`. |
| `region` | `string \| null` | Derived from the entry's geocode; `null` when it resolves none. |
| `city` | `string \| null` | Derived from the entry's geocode; `null` when it resolves none. |
| `addressDescription` | `string` | Street address / building / landmark. Always present — use it when `region`/`city` are null. |
| `isPrimary` | `boolean` | `true` for the agency's primary depot (the first entry). |

Returned in the agency's own order; the first entry is the primary.

> **The primary is the default.** A product that names no `agencyAddressId` is collected from the
> primary depot, and keeps tracking it if the agency reorders its list. Mark the `isPrimary` option
> as the default in the picker rather than pre-selecting its id — storing `null` and storing the
> primary's id are *not* the same thing.

> **An empty array is a valid answer**, not an error: the agency has no location on file yet.

### Error Responses

| Code | HTTP | Description |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | `agencyId` is not a valid ObjectId |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Wrong role |
| `DELIVERY_AGENCY_NOT_FOUND` | 404 | No such agency |
| `CONNECTION_NOT_ACTIVE` | 422 | No active, approved connection with this agency |

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
  region: string | null;
  city: string | null;
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
  logo: FileDetail | null;
  kycVerified: boolean;
  headquartersAddress: VendorAgencyHQAddressDto | null;
  /** ISO-2, e.g. "CM". Scopes `coverageAreas`. null on legacy agencies. */
  country: string | null;
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
