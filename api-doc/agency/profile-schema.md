# Delivery Agency Profile Schema & Data Dictionary

This document is the authoritative reference for the Delivery Agency profile data structure. Use it to build TypeScript interfaces, form schemas, and validation logic in the frontend.

> [!TIP]
> This is a **data dictionary**, not an endpoint reference. For the actual `GET`/`PATCH`
> requests, responses, and error codes, see [profile.md](./profile.md).

All monetary values are integers (smallest currency unit, e.g. XAF francs). All fields marked **Required** must be present for onboarding to reach `onboarding_step: 0` (complete).

---

## 1. Core Profile Fields

Root-level fields on the agency profile response object.

| Field | Type | In Response? | Sendable? | Validation | Description |
|-------|------|-------------|-----------|------------|-------------|
| `id` | `string` | Yes | No (read-only) | — | MongoDB ObjectId as a string. |
| `agencyName` | `string` | Yes | Yes | Min 1, Max 200 chars | The registered name of the agency. |
| `email` | `string \| null` | Yes | Yes | Valid email, lowercased ([Contact formats](../README.md#contact-formats-phone--email)) | Main agency contact email. Distinct from per-location `support_contact.email`. |
| `emailVerified` | `boolean` | Yes | No | — | Whether the main email has been verified. |
| `phone` | `string \| null` | Yes | Yes | **E.164**, e.g. `+237670000000` ([Contact formats](../README.md#contact-formats-phone--email)) | Main agency phone number. |
| `phoneVerified` | `boolean` | Yes | No | — | Whether the main phone has been verified. |
| `logoFileId` | `string \| null` | Yes | Yes (as `logo_file_id`) | Valid MongoDB ObjectId of a file uploaded via `POST /api/files/upload` | File id of the agency logo. On update send `logo_file_id`; the response returns both this and the derived `logoUrl`. |
| `logoUrl` | `string \| null` | Yes | No (derived) | — | Public URL of the logo, derived server-side from `logoFileId`. Read-only. |
| `timezone` | `string` | Yes | Yes | IANA timezone string | Operating timezone. Default: `"Africa/Douala"`. |
| `coverageAreas` | `string[]` | Yes | Yes | Min 1 item. Values are region keys from `locations.json`. | Regions this agency can serve. |
| `kycVerified` | `boolean` | Yes | No (admin-only) | — | Whether admin has approved the agency's KYC documents. |
| `status` | `string` | Yes | No | Enum: `"active"`, `"pending_verification"`, `"inactive"` | Account lifecycle status set by admin. |
| `onboardingStep` | `number` | Yes | No | `0`–`4` | Current onboarding progress. `0` = complete. |
| `policies` | `object \| null` | Yes | Yes | See Section 5 | The agency's full pricing, returns, and damage policy. `null` until Step 4 is submitted. |
| `createdAt` | `string (ISO 8601)` | Yes | No | — | Profile creation timestamp. |
| `updatedAt` | `string (ISO 8601)` | Yes | No | — | Last modification timestamp. Use this value as `updated_at` in write requests for optimistic concurrency. |

---

## 2. Headquarters Addresses

`headquartersAddresses` is an **ordered array of objects**.

- **Minimum**: 1 entry required to complete onboarding.
- **Index 0** is always treated as the **primary headquarters**. Additional entries are branch offices.
- Each entry gets its own `_id` from the backend (you do not send it).

### `HeadquartersAddress` Object

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `_id` | `string` | Response only | — | Auto-assigned by the backend. |
| `label` | `string` | Yes on write, `string \| null` on read | Min 1, Max 50 chars | The agency's own name for this location. E.g. `"Douala HQ"`. `null` on entries saved before labels existed — display `"Primary Headquarters"` / `"Branch N"` instead. |
| `region` | `string \| null` | No — **derived** | Max 100 chars | State/region name, taken from `geo.components.region`. E.g. `"Littoral"`. A sent value is a fallback only, used when the geocode has none. |
| `city` | `string \| null` | No — **derived** | Max 100 chars | City name, taken from `geo.components.city`. E.g. `"Douala"`. `null` when the geocode resolves no city (rural / landmark results). |
| `address_description` | `string` | Yes | Min 1, Max 200 chars | Full street address, building name, or landmark. |
| `support_contact` | `object` | Yes | See below | Dedicated support contact for this specific location. |

### `support_contact` Object

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `phone` | `string` | Yes | **E.164** — leading `+` and country code required, e.g. `+237670000000` ([Contact formats](../README.md#contact-formats-phone--email)) | Phone number for location-level customer support. |
| `email` | `string \| null` | No | Valid email, lowercased ([Contact formats](../README.md#contact-formats-phone--email)) | Email for location-level support. `null` if not provided. |

---

## 3. Payout Details

`payoutDetails` is an **ordered array** of payout method objects.

- **Minimum**: 1 entry required to complete onboarding.
- **Maximum**: 2 entries (one `mobile_money` and one `bank` — no duplicates of the same type).
- **Index 0** is always the **preferred / default** payout method.
- Sensitive values (`phone_number`, `account_number`) are **masked in all API responses**. The raw values are never returned.

### `PayoutMethod` Object

| Field | Type | In Response? | Sendable? | Validation | Description |
|-------|------|-------------|-----------|------------|-------------|
| `method` | `string` | Yes | Yes | Enum: `"mobile_money"` or `"bank"` | Determines which sub-object is active. |
| `is_preferred` | `boolean` | Yes | No (read-only) | — | `true` only for index 0. Set by the backend. Do not send this field. |
| `mobile_money` | `object \| null` | Yes | Yes | Required if `method === "mobile_money"`, else `null` | Mobile money details. |
| `bank` | `object \| null` | Yes | Yes | Required if `method === "bank"`, else `null` | Bank account details. |

### `mobile_money` Object

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `provider` | `string` | Yes | Min 1 char | Telecom operator name. E.g. `"MTN Mobile Money"`, `"Orange Money"`. |
| `phone_number` | `string` | Yes | **E.164** — leading `+` and country code required ([Contact formats](../README.md#contact-formats-phone--email)) | Momo phone number. **Masked in responses** as `phone_number_masked`. |
| `account_name` | `string` | Yes | Min 1 char | Name registered on the Momo account. |

### `bank` Object

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `bank_name` | `string` | Yes | Min 1 char | Name of the banking institution. E.g. `"UBA Cameroon"`. |
| `account_number` | `string` | Yes | Min 1 char | Full bank account number. **Masked in responses** as `account_number_masked`. |
| `account_name` | `string` | Yes | Min 1 char | Name on the bank account. |
| `country` | `string` | Yes | Min 1 char | Country where the bank operates. ISO code recommended (e.g. `"CM"`). |

---

## 4. KYC Details

`kyc_details` is submitted separately and reviewed by an admin. It does not block the standard onboarding flow, but `kycVerified: false` will produce a warning in the onboarding status and may restrict some functionality.

### `KycDetails` Object

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `registration_number` | `string \| null` | No | Min 1 char | Business registration number or tax ID. |
| `transport_license_id` | `string \| null` | No | Min 1 char | Relevant transport/logistics license ID. |
| `legit_verified` | `boolean` | Response only | Admin-only | Whether admin has approved KYC. **Never send this field**; it will be ignored (or rejected). |

---

## 5. Policies

`policies` is submitted at Step 4 and is the most complex field on the profile. It is `null` until Step 4 is completed.

It has five top-level keys: `pricing`, `returns`, `damage`, `cod`, and `documents`.

### 5.1 `pricing`

Defines the agency's fee structure. It covers two fulfilment models (`storage_based` and `pickup_based`) plus shared `additional_fees`. Each model has an `enabled` flag — an agency that only warehouses stock can disable `pickup_based`, and vice versa.

**Business rule:** At least one of `storage_based.enabled` or `pickup_based.enabled` must be `true`. Submitting both as `false` is rejected with `400 VALIDATION_ERROR`. All fee fields must still be supplied even when `enabled` is `false`, so the values are preserved for when the agency re-enables a model later.

#### `pricing.storage_based`

Applies when the **agency warehouses the vendor's stock** and ships from its own facility.

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `enabled` | `boolean` | Yes | At least one model must be `true` | Whether this pricing model is currently active. When `false`, the fee fields are stored but vendors cannot select this delivery model. |
| `monthly_storage_fee_per_sku` | `number` | Yes | ≥ 0 | Monthly fee charged to the vendor for each unique SKU stored in the warehouse. |
| `pick_pack_fee_per_order` | `number` | Yes | ≥ 0 | Fee charged each time an order is picked from the shelf and packed for dispatch. |
| `local_delivery_fee` | `number` | Yes | ≥ 0 | Flat delivery fee for shipments within the same region as the warehouse. |
| `out_of_region_delivery_fee` | `number` | Yes | ≥ 0 | Flat delivery fee for shipments to a different region. |

#### `pricing.pickup_based`

Applies when the **agency collects goods from the vendor's location** and then delivers to the customer.

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `enabled` | `boolean` | Yes | At least one model must be `true` | Whether this pricing model is currently active. When `false`, the fee fields are stored but vendors cannot select this delivery model. |
| `base_rate_first_kg` | `number` | Yes | ≥ 0 | All-in fee for pickup and delivery covering the first 1 kg of the shipment. |
| `additional_per_kg` | `number` | Yes | ≥ 0 | Extra charge per kg beyond the first 1 kg. |
| `out_of_region_surcharge` | `number` | Yes | ≥ 0 | Extra charge added when the delivery destination is outside the vendor's region. Applied on top of the base rate. |

#### `pricing.additional_fees`

These fees are applied on top of either `storage_based` or `pickup_based` when the relevant conditions apply.

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `cod_handling_fee` | `object` | Yes | See below | Fee charged to the vendor for collecting payment on delivery (Cash-on-Delivery orders). |
| `cod_handling_fee.type` | `string` | Yes | Enum: `"percentage"` \| `"fixed"` | `"percentage"`: the `value` is a percentage of the order total (e.g. `2` = 2%). `"fixed"`: the `value` is a flat amount. |
| `cod_handling_fee.value` | `number` | Yes | ≥ 0 | The numeric magnitude of the COD fee. Interpret based on `type`. |
| `failed_delivery_fee` | `number` | Yes | ≥ 0 | Fee charged to the vendor per failed delivery attempt (customer unreachable, wrong address, refused, etc.). |
| `rto_fee` | `number` | Yes | ≥ 0 | Return-to-Origin fee. Charged when a shipment cannot be delivered and the package must be returned to the vendor. |
| `peak_season_surcharge` | `number` | No | ≥ 0, default `0` | Optional surcharge applied during high-demand periods (e.g. end-of-year holidays). Set to `0` if not applicable. |

#### `pricing.notes`

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `notes` | `string \| null` | No | Max 700 chars | Free-text field for pricing terms not covered by structured fields. E.g. bulk discounts, minimum order values, promotional rates. `null` if not provided. |

---

### 5.2 `returns`

Governs how returned goods are handled between the agency and vendors.

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `payer` | `string` | Yes | Enum: `"vendor"` \| `"agency"` \| `"customer"` | Who bears the cost of return shipping. |
| `handling_fee` | `number` | Yes | ≥ 0 | Fee the agency charges to physically process, inspect, and restock (or dispose of) a return. |
| `return_window_days` | `number` | Yes | ≥ 0 | Number of days from the delivery date within which a return may be initiated. `0` means returns are not accepted. |
| `notes` | `string \| null` | No | Max 700 chars | Additional conditions, eligibility criteria, or required proof (e.g. unboxing video). `null` if not provided. |

> **Note:** `free_returns` is not an agency-level policy. Whether a customer receives a free return is determined by the **vendor's** own return settings, not the agency's.

---

### 5.3 `damage`

Governs damage claim resolution.

| Field | Type | Sendable by frontend? | Validation | Description |
|-------|------|----------------------|------------|-------------|
| `claim_deadline_days` | `number` | Yes | ≥ 0 | Number of days from delivery within which a damage claim must be filed. Claims after this window are rejected. |
| `max_refund_per_item` | `number` | Yes | ≥ 0 | Maximum compensation the agency will pay per damaged item, regardless of item value. |
| `notes` | `string \| null` | Yes | Max 700 chars | Additional conditions or rejection criteria (e.g. packaging requirements). `null` if not provided. |
| `inspector` | `string` | **No — admin only** | Enum: `"agency"` \| `"vendor"` \| `"third_party"` | Who conducts the damage inspection. Preset by admin. Defaults to `"agency"`. Always present in the API response. |
| `investigation_fee` | `number` | **No — admin only** | ≥ 0 | Fee charged to open a damage investigation. Preset by admin. Defaults to `1000`. Always present in the API response. |

> **Important:** `inspector` and `investigation_fee` are platform-level presets controlled exclusively by an admin. The frontend must never send these fields — they will be ignored if sent. They will always appear in the `policies.damage` block of the profile response.

### 5.4 `cod`

Cash-on-delivery participation. The per-collection **fee** the agency charges is configured in
`pricing.additional_fees.cod_handling_fee` (above); this block only gates **eligibility**. When
disabled, customers cannot place COD orders whose shipments this agency would carry. See
[cod-cash-management.md](./cod-cash-management.md) for the full COD cash workflow.

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `enabled` | `boolean` | Yes | — | Whether this agency handles cash-on-delivery orders. Defaults to `false` (opt-in). |
| `max_order_amount` | `number \| null` | No | ≥ 0, default `null` | Optional cap on a single COD order's total (minor units). Checkout rejects COD orders above it. `null` = no per-order cap. |

> **Policy-version note:** like every other policy change, editing `cod` bumps `policy_version`
> and pauses active vendor connections for reapproval.

### 5.5 `documents`

Supporting document(s) for terms that don't fit the structured fields above (e.g. a signed PDF addendum).

| Field | Type | Sendable by frontend? | Validation | Description |
|-------|------|----------------------|------------|-------------|
| `documents` | `string[]` | Yes | Max 2 items, each a valid URL | Upload via `POST /api/agency/profile/policy-documents` (standalone route, PDF only, max 5MB each — see [onboarding.md](./onboarding.md#uploading-policy-documents)) first, then submit the resulting URL(s) here. Defaults to `[]`. |

> **Full replace:** Like the rest of `policies`, `documents` is overwritten wholesale on every submit — resend existing URLs to keep them.

---

## TypeScript Reference

Use this as the base for your frontend interface file. All interfaces match the shape returned by the API.

```typescript
// ─── Core ─────────────────────────────────────────────────────────────────────

export interface SupportContact {
  phone: string;
  email: string | null;
}

export interface HeadquartersAddress {
  _id: string;           // Assigned by backend — do not send on create
  label: string | null;  // Required when writing; null on pre-label entries
  region: string | null; // Derived from geo.components.region
  city: string | null;   // Derived from geo.components.city
  address_description: string;
  support_contact: SupportContact;
}

// ─── Payout ───────────────────────────────────────────────────────────────────

export interface MobileMoneyPayout {
  provider: string;
  /** Raw value — only present in request payloads. */
  phone_number?: string;
  /** Masked value — only present in API responses. */
  phone_number_masked?: string;
  account_name: string;
}

export interface BankPayout {
  bank_name: string;
  /** Raw value — only present in request payloads. */
  account_number?: string;
  /** Masked value — only present in API responses. */
  account_number_masked?: string;
  account_name: string;
  country: string;
}

export interface PayoutMethod {
  method: 'mobile_money' | 'bank';
  /** Set by the backend for index 0. Do not send in request payloads. */
  is_preferred?: boolean;
  mobile_money: MobileMoneyPayout | null;
  bank: BankPayout | null;
}

/** Ordered array — index 0 is always the preferred method. */
export type PayoutDetails = PayoutMethod[];

// ─── KYC ──────────────────────────────────────────────────────────────────────

export interface KycDetails {
  registration_number: string | null;
  transport_license_id: string | null;
  /** Received from backend only. Never send this field. */
  legit_verified?: boolean;
}

// ─── Policies ─────────────────────────────────────────────────────────────────

export interface StorageBasedPricing {
  /** When false, this model is inactive. Fee fields are still stored for future re-activation. */
  enabled: boolean;
  monthly_storage_fee_per_sku: number;
  pick_pack_fee_per_order: number;
  local_delivery_fee: number;
  out_of_region_delivery_fee: number;
}

export interface PickupBasedPricing {
  /** When false, this model is inactive. Fee fields are still stored for future re-activation. */
  enabled: boolean;
  base_rate_first_kg: number;
  additional_per_kg: number;
  out_of_region_surcharge: number;
}

export interface CodHandlingFee {
  type: 'percentage' | 'fixed';
  value: number;
}

export interface AdditionalFees {
  cod_handling_fee: CodHandlingFee;
  failed_delivery_fee: number;
  rto_fee: number;
  /** Defaults to 0 if not provided. */
  peak_season_surcharge?: number;
}

export interface AgencyPricingPolicy {
  storage_based: StorageBasedPricing;
  pickup_based: PickupBasedPricing;
  additional_fees: AdditionalFees;
  notes?: string | null;
}

export interface AgencyCodPolicy {
  enabled: boolean;
  /** Minor units; null = no per-order cap. */
  max_order_amount: number | null;
}

export interface AgencyReturnsPolicy {
  payer: 'vendor' | 'agency' | 'customer';
  handling_fee: number;
  return_window_days: number;
  notes?: string | null;
}

export interface AgencyDamagePolicy {
  claim_deadline_days: number;
  max_refund_per_item: number;
  /** Admin-controlled preset. Always present in the response. Never send in request payloads. */
  inspector?: 'agency' | 'vendor' | 'admin';
  /** Admin-controlled preset. Always present in the response. Never send in request payloads. */
  investigation_fee?: number;
  notes?: string | null;
}

export interface AgencyPolicies {
  pricing: AgencyPricingPolicy;
  returns: AgencyReturnsPolicy;
  damage: AgencyDamagePolicy;
  /** COD participation. Defaults to { enabled: false, max_order_amount: null }. */
  cod: AgencyCodPolicy;
  /** Up to 2 supporting document URLs (e.g. PDFs) for terms not covered above. Defaults to []. */
  documents?: string[];
}

// ─── Full Profile ──────────────────────────────────────────────────────────────

export interface DeliveryAgencyProfile {
  id: string;
  agencyName: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
  logo: FileDetail | null;   // { id, key, url, mimeType, size, originalName } — same shape as product media
  timezone: string;
  coverageAreas: string[];
  headquartersAddresses: HeadquartersAddress[];
  payoutDetails: PayoutDetails;
  kycVerified: boolean;
  policies: AgencyPolicies | null;
  wa: { verified: boolean; name?: string } | null;
  status: 'active' | 'pending_verification' | 'inactive';
  /** 0 = complete, 1–4 = step in progress */
  onboardingStep: number;
  createdAt: string;
  updatedAt: string;
}
```
