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
      "access": "public",
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
- `logo` is a resolved **file object** (`{ id, key, url, access, mimeType, size, originalName }`) or `null`, not a URL string — same shape as product media and the Store logo. Upload via `POST /api/files/upload`, then submit the returned id as `logoFileId`.
- `coverageAreas` are region keys of the agency's `country`.
- `headquartersAddresses[]` are the agency's physical / pickup locations (index 0 = primary). Each carries a geocoded `geo`; `location`, `region` and `city` are all **derived from it** on write — `location` is the GeoJSON point kept for map/proximity use. `_id` identifies each entry.
- ⚠️ **`_id` is a durable reference — echo it back on PATCH.** A vendor can point a product at a specific depot (`delivery.pickupLocation.agencyAddressId`), and orders carry that id through to the agent's pickup address. The PATCH below is a full-array replace, so **every entry you keep must be sent back with its `id`**; an entry sent without one is treated as a brand-new location and gets a new `_id`, silently re-pointing every product that named the old one at the primary depot instead. See the `headquarters_addresses` notes there.
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
      "id": "6641abc123def457",
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
- `supportEmail` (string, valid email, lowercased, *clearable*).
- `supportPhone` (string, **E.164** e.g. `+237612345678`, *clearable*).
- `supportWhatsapp` (string, **E.164**, *clearable*).

> Phone and email formats are platform-wide — see [Contact formats](../README.md#contact-formats-phone--email).
- `coverage_areas` (`string[]`, min 1): **Full replace.** Region keys of the agency's `country` (from `locations.json`). Entries that aren't regions of that country → `400 AGENCY_COVERAGE_AREA_INVALID`.
  - The **same catalogue** now backs the coverage picker on an agent contract's terms (`coverage.regions`) — see [Coverage regions are picked, not typed](./agent-roster.md#coverage-regions-are-picked-not-typed). A contract may name any region of the country, not only the ones listed here; these are shown alongside as "regions this agency serves".
- `headquarters_addresses` (`object[]`, min 1): **Full replace**; index 0 = primary. Each entry is `{ id?, label, address_description, support_contact:{ phone, email? }, geo }`. Every **new or edited** entry must carry a geocoded `geo` (a selected `/api/geo/search` result) resolving inside the agency's `country` — else `400 ADDRESS_GEO_REQUIRED` / `400 ADDRESS_COUNTRY_MISMATCH`. `location`, `region` and `city` are all derived from `geo` on write. Same flow as a vendor `business_addresses` entry.
  - **`id`** (string, ObjectId, optional): the `_id` of an entry that already exists, from a prior `GET`. **Send it for every entry you are keeping.** Omit it only for a genuinely new location. Two entries carrying the same `id` → `400`. An `id` that isn't on your magazin → `409 MAGAZIN_CONFLICT` (your view of the list is stale — refetch).
  - **Removing an entry is guarded.** Dropping a location that still holds stored products → `409 MAGAZIN_LOCATION_IN_USE` with `details.locations[]`. Note this is judged against what would actually be *persisted*, so an entry you kept via the content-match net does **not** count as removed.
    - *Why it matters*: products reference a depot by `_id` (`pickupLocation.agencyAddressId`). An entry saved without its `id` is a new row with a new `_id`, and every product naming the old one quietly falls back to your primary depot. There is a safety net — an entry whose `address_description` **and** geocoded place both match an existing one inherits its `_id` even without an `id` — but it does not survive editing the address text, so do not rely on it.
  - `label` (string, 1–50 chars) is **required on every entry you write** — the agency's own name for the location, the one field the map result can't supply.
  - `region` / `city` are **optional and derived** from `geo.components`. Send them only to name a place whose geocode has neither; whenever `geo` carries one, `geo` wins. Both persist as `null` when neither source has a value.
  - "Unchanged" (grandfathered, geo not required) means the **same geocoded place**, plus *either* the same `address_description` *or* a matching `id`. Adding or renaming a `label`, omitting `region`/`city`, and (when you send `id`) correcting the address text are therefore not "edits" — re-saving the list never forces a re-geocode of legacy rows. Moving the pin always is an edit, `id` or not.
- `version` (**required**, number): current magazin version for optimistic locking.

**Clearing a field**: every *clearable* field accepts `null` **or `""`** (stored/returned as `null`); omit a key to leave it unchanged. `name`, `coverage_areas`, and `headquarters_addresses` are full-replace, not clearable. See [Conventions](../README.md#conventions).

#### Response

**Success (200 OK)**: the updated magazin (same shape as `GET`), with `version` incremented, and `message: "Magazin profile updated successfully"`.

#### Error Responses

| Code | HTTP | Description |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation — including two HQ entries sharing one `id` |
| `AGENCY_COVERAGE_AREA_INVALID` | 400 | A coverage area is not a region of the agency's country |
| `ADDRESS_GEO_REQUIRED` | 400 | A new/edited HQ address is missing its geocoded `geo` |
| `ADDRESS_COUNTRY_MISMATCH` | 400 | An HQ address resolves outside the agency's country |
| `AUTH_MISSING_TOKEN` · `AUTH_TOKEN_EXPIRED` · `AUTH_TOKEN_INVALID` | 401 | Missing or invalid JWT token |
| `AUTH_ROLE_NOT_FOUND` | 403 | Wrong role |
| `MAGAZIN_CONFLICT` | 409 | Optimistic-locking version mismatch, **or** an HQ entry carries an `id` not on this magazin (`details.unknownIds`) — refresh and retry in both cases |
| `MAGAZIN_LOCATION_IN_USE` | 409 | A removed HQ entry still holds stored products (`details.locations[] = { id, label, skuCount }`). **Retrying will not help** — re-point or clear those products first. See [Inventory](./inventory.md) |

> **You can now clear a blocking depot yourself.** `PATCH /api/agency/inventory/products/:productId/depot`
> moves a stored product to another of your depots (or to your primary, with
> `locationId: null`) without waiting on the vendor — the depot is your record, not
> theirs. Find the products holding a depot open by filtering the inventory list on that
> `locationId`, re-point each, then retry this save. Note that a product **you have
> storage-suspended** still holds its depot open, which is correct: the goods are still in
> the building. See [Inventory §4–5](./inventory.md#4-move-a-product-to-another-depot).
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |

---

## Optimistic Locking

Reads return `version`; send it back on `PATCH`. On a match the update succeeds and `version` increments; on a mismatch the server returns `409 MAGAZIN_CONFLICT` and the client should refresh and retry.
