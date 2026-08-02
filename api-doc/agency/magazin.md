# Agency Magazin Management API Documentation

## Overview

The **Magazin** is a delivery agency's business surface — the single source of truth for its **public business identity and its logistics footprint**: business name, description, logo, support contacts, the **regions it serves** (`coverageAreas`) and its physical **headquarters / pickup locations** (`headquartersAddresses`). It is the counterpart of a vendor's [Store](../vendor/store.md): the agency **profile** (`/api/agency/profile`) holds only personal + account data (contact display name, avatar, payout, policies, KYC) plus the set-once `country` that anchors coverage/HQ, while the **magazin** holds everything business/operational.

Each agency has exactly one magazin, **auto-created on first access** (and provisioned at signup / when `POST /api/agency` sets the initial name).

> [!IMPORTANT]
> **Business name, coverage areas and HQ addresses all live here, not on the profile.** `GET /api/agency/profile` no longer returns `agencyName`, a business `logo`, `coverageAreas`, or `headquartersAddresses`; it returns the personal `displayName` + `avatar` + `country`. Read/patch all of those through the magazin endpoints below.
>
> **Coverage + HQ are anchored to the agency's `country`** (set-once on the profile during onboarding). `coverageAreas` must be **region keys of that country** (from `locations.json`, e.g. `"littoral"`); each `headquartersAddresses` entry must carry a geocoded `geo` (a selected `/api/geo/search` result) resolving **inside** that country — exactly like a vendor's `business_addresses`.
>
> Unlike the vendor Store, the magazin has **no public slug/URL and no vacation mode** — an agency is not a public shopping storefront.

**Base URL**: `/api/agency`

**Authentication**: All endpoints require a valid JWT with the `agency` role.

---

## Endpoints

### GET /api/agency/magazin

Retrieve the authenticated agency's magazin.

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "6641abc123def456",
    "agencyId": "6641abc123def400",
    "name": "FastTrack Logistics",
    "logo": {
      "id": "507f1f77bcf86cd799439030",
      "key": "images/2026/07/fasttrack-logo.png",
      "url": "https://cdn.example.com/fasttrack-logo.png",
      "mimeType": "image/png",
      "size": 24576,
      "originalName": "logo.png"
    },
    "description": "Nationwide last-mile delivery for online sellers.",
    "supportEmail": "support@fasttrack.cm",
    "supportPhone": "+237612345678",
    "supportWhatsapp": "+237612345678",
    "coverageAreas": ["littoral", "centre"],
    "headquartersAddresses": [
      {
        "_id": "6641abc123def457",
        "label": "Douala HQ",
        "region": "Littoral",
        "city": "Douala",
        "address_description": "Akwa, Rue Sylvani, immeuble ABC",
        "support_contact": { "phone": "+237612345678", "email": "douala@fasttrack.cm" },
        "location": { "type": "Point", "coordinates": [9.7043, 4.0511] },
        "geo": { "formatted_address": "Akwa, Douala, Cameroon", "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0511] }, "provider": "nominatim", "components": { "city": "Douala", "region": "Littoral", "country": "Cameroon", "country_code": "CM" } }
      }
    ],
    "version": 3,
    "createdAt": "2024-05-18T10:00:00.000Z",
    "updatedAt": "2024-05-20T09:30:00.000Z"
  }
}
```

**Field notes**:
- `logo` is a resolved **file object** (`{ id, key, url, mimeType, size, originalName }`) or `null`, not a URL string — same shape as product media and the Store logo. Upload via `POST /api/files/upload`, then submit the returned id as `logoFileId`.
- `coverageAreas` are region keys of the agency's `country`.
- `headquartersAddresses[]` are the agency's physical / pickup locations (index 0 = primary). Each carries a geocoded `geo`; `location`, `region` and `city` are all **derived from it** on write — `location` is the GeoJSON point kept for map/proximity use. `_id` identifies each entry.
- `headquartersAddresses[].label`, `.region` and `.city` are **`string | null` on read**. Entries saved before labels existed have `label: null` — fall back to `"Primary Headquarters"` for index 0 and `"Branch N"` after it. `region`/`city` are null when the entry's geocode resolves none (common for rural/landmark results); use `geo.formatted_address` when you need something to show.
- `version` is the optimistic-locking counter.

**Auto-provisioning**: if the agency has no magazin row yet (accounts created before magazins existed), this endpoint creates it on the fly — name seeded from the agency's initial name or its display name.

---

### PATCH /api/agency/magazin

Update the authenticated agency's magazin.

#### Request Body

```json
{
  "name": "FastTrack Logistics SARL",
  "logoFileId": "507f1f77bcf86cd799439030",
  "description": "Nationwide last-mile delivery for online sellers.",
  "supportEmail": "hello@fasttrack.cm",
  "supportPhone": "+237698765432",
  "supportWhatsapp": "+237698765432",
  "coverage_areas": ["littoral", "centre", "ouest"],
  "headquarters_addresses": [
    {
      "label": "Douala HQ",
      "address_description": "Akwa, Rue Sylvani, immeuble ABC",
      "support_contact": { "phone": "+237612345678", "email": "douala@fasttrack.cm" },
      "geo": { "formatted_address": "Akwa, Douala, Cameroon", "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0511] }, "provider": "nominatim", "components": { "city": "Douala", "region": "Littoral", "country_code": "CM" } }
    }
  ],
  "version": 3
}
```

**Fields** (all optional except `version`):

- `name` (string, 2–100 chars): Business/display name — **not clearable** (required in the model).
- `logoFileId` (string, MongoDB ObjectId, *clearable*): Id of a logo file uploaded via `POST /api/files/upload`. The response returns the resolved `logo` file object. Registers a `file_references` row so the file is not garbage-collected while set.
- `description` (string, max 1000 chars, *clearable*).
- `supportEmail` (string, valid email, *clearable*).
- `supportPhone` (string, 8–20 chars, *clearable*).
- `supportWhatsapp` (string, 8–20 chars, *clearable*).
- `coverage_areas` (`string[]`, min 1): **Full replace.** Region keys of the agency's `country` (from `locations.json`). Entries that aren't regions of that country → `400 AGENCY_COVERAGE_AREA_INVALID`.
- `headquarters_addresses` (`object[]`, min 1): **Full replace**; index 0 = primary. Each entry is `{ label, address_description, support_contact:{ phone, email? }, geo }`. Every **new or edited** entry must carry a geocoded `geo` (a selected `/api/geo/search` result) resolving inside the agency's `country` — else `400 ADDRESS_GEO_REQUIRED` / `400 ADDRESS_COUNTRY_MISMATCH`. `location`, `region` and `city` are all derived from `geo` on write. Same flow as a vendor `business_addresses` entry.
  - `label` (string, 1–50 chars) is **required on every entry you write** — the agency's own name for the location, the one field the map result can't supply.
  - `region` / `city` are **optional and derived** from `geo.components`. Send them only to name a place whose geocode has neither; whenever `geo` carries one, `geo` wins. Both persist as `null` when neither source has a value.
  - "Unchanged" (grandfathered, geo not required) means **same `address_description` and same geocoded place**. Adding or renaming a `label`, and omitting `region`/`city`, are therefore not "edits" — re-saving the list never forces a re-geocode of legacy rows.
- `version` (**required**, number): current magazin version for optimistic locking.

**Clearing a field**: every *clearable* field accepts `null` **or `""`** (stored/returned as `null`); omit a key to leave it unchanged. `name`, `coverage_areas`, and `headquarters_addresses` are full-replace, not clearable. See [Conventions](../README.md#conventions).

#### Response

**Success (200 OK)**: the updated magazin (same shape as `GET`), with `version` incremented, and `message: "Magazin profile updated successfully"`.

#### Error Responses

| Code | HTTP | Description |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `AGENCY_COVERAGE_AREA_INVALID` | 400 | A coverage area is not a region of the agency's country |
| `ADDRESS_GEO_REQUIRED` | 400 | A new/edited HQ address is missing its geocoded `geo` |
| `ADDRESS_COUNTRY_MISMATCH` | 400 | An HQ address resolves outside the agency's country |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Wrong role |
| `MAGAZIN_CONFLICT` | 409 | Optimistic-locking version mismatch — refresh and retry |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Optimistic Locking

Reads return `version`; send it back on `PATCH`. On a match the update succeeds and `version` increments; on a mismatch the server returns `409 MAGAZIN_CONFLICT` and the client should refresh and retry.
