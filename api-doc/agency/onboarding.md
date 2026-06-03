# Delivery Agency Onboarding API Documentation

This documentation provides frontend developers with the complete specifications needed to build the delivery agency onboarding flow.

The flow uses dedicated `PUT` endpoints for each step with strict step-order enforcement. A step that has already been completed can be re-submitted to update its data — the backend will save the new data while keeping the current `onboarding_step` unchanged.

---

## Overview

The onboarding is a **4-step process** entered after the user adds the "agency" role to their account:

| # | Step | Endpoint | Required? |
|---|------|----------|-----------|
| Init | Agency Initialization | `POST /api/agency` | Yes |
| 1 | Logistics Setup | `PUT /api/agency/onboarding/logistics` | Yes |
| 2 | Payout Setup | `PUT /api/agency/onboarding/payout` | Yes |
| 3 | Branding | `PUT /api/agency/onboarding/branding` | No (skippable) |
| 4 | Policy Setup | `PUT /api/agency/onboarding/policies` | Yes |

`onboarding_step` values returned in the profile:

| Value | Meaning |
|-------|---------|
| `1` | Awaiting Logistics Setup |
| `2` | Awaiting Payout Setup |
| `3` | Awaiting Branding |
| `4` | Awaiting Policy Setup |
| `0` | **Onboarding Complete** → redirect to dashboard |

---

## 1. Check Onboarding Status

Call this on every login to determine which onboarding screen to show.

- **Endpoint**: `GET /api/agency/onboarding/status`
- **Auth**: Yes (Agency role)

### Response

```json
{
  "success": true,
  "data": {
    "currentStep": 1,
    "currentStepLabel": "Logistics Setup",
    "isComplete": false,
    "progressPercent": 0,
    "completedFields": [],
    "missingFields": [
      "coverage_areas",
      "headquarters_addresses (min 1)"
    ],
    "steps": [
      { "step": 1, "label": "Logistics Setup",      "status": "current",   "required": true  },
      { "step": 2, "label": "Payout Setup",          "status": "pending",   "required": true  },
      { "step": 3, "label": "Branding (Optional)",   "status": "pending",   "required": false },
      { "step": 4, "label": "Policy Setup",          "status": "pending",   "required": true  }
    ],
    "warnings": [
      "KYC verification is pending. Your agency may have limited functionality until verified by admin."
    ]
  }
}
```

**Frontend routing logic:**

```
currentStep === 0  →  /dashboard          (onboarding complete)
currentStep === 1  →  /onboarding/logistics
currentStep === 2  →  /onboarding/payout
currentStep === 3  →  /onboarding/branding
currentStep === 4  →  /onboarding/policies
```

**`steps[].status` meanings:**

| Value | Meaning |
|-------|---------|
| `"completed"` | Step was already submitted successfully. |
| `"current"` | This is the step the user should complete next. |
| `"pending"` | Step is locked until prior required steps are done. |

---

## 2. Initialization

Called immediately after the user adds the "agency" role. Sets the agency name and unlocks Step 1.

- **Endpoint**: `POST /api/agency`
- **Auth**: Yes (Agency role)

### Request Body

```json
{
  "agency_name": "FastTrack Logistics"
}
```

| Field | Type | Required? | Validation |
|-------|------|-----------|------------|
| `agency_name` | `string` | Yes | Min 1, Max 200 chars |

### Success Response (`201 Created`)

```json
{
  "success": true,
  "data": {
    "id": "6641abc123def456",
    "agencyName": "FastTrack Logistics",
    "onboardingStep": 1,
    "createdAt": "2024-05-18T10:00:00Z",
    "updatedAt": "2024-05-18T10:00:00Z"
  }
}
```

---

## 3. Submit Onboarding Steps

### Optimistic Concurrency (Optional)

Any `PUT` step endpoint accepts an optional `version` integer field. If supplied, the backend checks that it matches the profile's current `version` before writing. If it doesn't match (another session submitted changes simultaneously), the request fails with `DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION (409)`.

**Best practice:** Always pass `version` from the last profile response you received. On success, the response includes the incremented `version` — store it for the next write.

### Re-edit Behaviour

Once a step is marked complete you may re-submit its endpoint to update the data (e.g., the agency changes their bank account). The backend saves the new values but does **not** reset `onboarding_step`. This means:

- Submitting Step 1 again when you're on Step 3 → data saved, `onboarding_step` stays `3`.
- Submitting Step 4 at any point after Step 2 → data saved, `onboarding_step` unchanged (unless this is the final step, in which case it advances to `0`).

---

### Step 1: Logistics Setup (Required)

- **Endpoint**: `PUT /api/agency/onboarding/logistics`
- **Auth**: Yes (Agency role)
- **Prerequisite**: Agency initialized (`POST /api/agency` called)

Captures the geographic regions served by the agency and at least one physical headquarters address.

#### Request Body

```json
{
  "coverage_areas": ["littoral", "centre", "ouest"],
  "headquarters_addresses": [
    {
      "region": "Littoral",
      "city": "Douala",
      "address_description": "Akwa, Rue Sylvani, immeuble ABC",
      "support_contact": {
        "phone": "+237612345678",
        "email": "douala@fasttrack.cm"
      }
    },
    {
      "region": "Centre",
      "city": "Yaoundé",
      "address_description": "Bastos, Avenue Kennedy",
      "support_contact": {
        "phone": "+237699876543",
        "email": null
      }
    }
  ],
  "version": 0
}
```

#### Field Reference

| Field | Type | Required? | Validation | Notes |
|-------|------|-----------|------------|-------|
| `coverage_areas` | `string[]` | Yes | Min 1 item. Each string is a region key from `locations.json`. | Keys must be lowercase (e.g. `"littoral"`, `"centre"`). |
| `headquarters_addresses` | `object[]` | Yes | Min 1 entry. | **Index 0 is always the primary headquarters.** Additional entries are branch offices. |
| `headquarters_addresses[].region` | `string` | Yes | Min 1, Max 100 chars | State/region name (display label). |
| `headquarters_addresses[].city` | `string` | Yes | Min 1, Max 100 chars | City name. |
| `headquarters_addresses[].address_description` | `string` | Yes | Min 1, Max 200 chars | Full street address / landmark. |
| `headquarters_addresses[].support_contact.phone` | `string` | Yes | Min 6, Max 20 chars. Regex `/^\+?[0-9\s\-()]+$/` | Phone number for this location. |
| `headquarters_addresses[].support_contact.email` | `string \| null` | No | Valid email format | Contact email for this location. |
| `version` | `number (integer)` | No | Must match profile `version` if provided | Optimistic concurrency guard. |

---

### Step 2: Payout Setup (Required)

- **Endpoint**: `PUT /api/agency/onboarding/payout`
- **Auth**: Yes (Agency role)
- **Prerequisite**: Step 1 completed

Captures the agency's payout methods. The **first entry in the array is always the preferred/default** method.

#### Request Body — Mobile Money only

```json
{
  "payout_details": [
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "MTN Mobile Money",
        "phone_number": "+237670000000",
        "account_name": "FastTrack Logistics Sarl"
      },
      "bank": null
    }
  ]
}
```

#### Request Body — Mobile Money (preferred) + Bank (fallback)

```json
{
  "payout_details": [
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "MTN Mobile Money",
        "phone_number": "+237670000000",
        "account_name": "FastTrack Logistics Sarl"
      },
      "bank": null
    },
    {
      "method": "bank",
      "mobile_money": null,
      "bank": {
        "bank_name": "UBA Cameroon",
        "account_number": "10033000000000001",
        "account_name": "FastTrack Logistics Sarl",
        "country": "CM"
      }
    }
  ]
}
```

#### Field Reference

| Field | Type | Required? | Validation | Notes |
|-------|------|-----------|------------|-------|
| `payout_details` | `object[]` | Yes | Min 1 entry, Max 2 entries. No duplicate `method` types. | Ordered array — index 0 is the preferred method. |
| `payout_details[].method` | `string` | Yes | Enum: `"mobile_money"` or `"bank"` | Determines which sub-object is required. |
| `payout_details[].mobile_money` | `object \| null` | Conditional | Required if `method === "mobile_money"`, otherwise `null`. | See sub-fields below. |
| `payout_details[].bank` | `object \| null` | Conditional | Required if `method === "bank"`, otherwise `null`. | See sub-fields below. |

**`mobile_money` sub-fields:**

| Field | Type | Required? | Validation |
|-------|------|-----------|------------|
| `provider` | `string` | Yes | Min 1 char. E.g. `"MTN Mobile Money"`, `"Orange Money"` |
| `phone_number` | `string` | Yes | Valid local phone format |
| `account_name` | `string` | Yes | Min 1 char |

**`bank` sub-fields:**

| Field | Type | Required? | Validation |
|-------|------|-----------|------------|
| `bank_name` | `string` | Yes | Min 1 char |
| `account_number` | `string` | Yes | Min 1 char |
| `account_name` | `string` | Yes | Min 1 char |
| `country` | `string` | Yes | Min 1 char. ISO country code recommended (e.g. `"CM"`) |

> **Security note:** The API response masks sensitive payout data. `phone_number` is returned as `phone_number_masked` (e.g. `••••0000`) and `account_number` as `account_number_masked`. The raw values are never returned.

---

### Step 3: Branding Setup (Optional / Skippable)

- **Endpoint**: `PUT /api/agency/onboarding/branding`
- **Auth**: Yes (Agency role)
- **Prerequisite**: Step 2 completed

Captures the agency logo and operating timezone. This step is optional — the user can skip it and the flow will advance to Step 4.

#### Request Body — Providing Data

```json
{
  "logo_url": "https://cdn.example.com/fasttrack-logo.png",
  "timezone": "Africa/Douala",
  "version": 1
}
```

#### Request Body — Skipping

Send `skip: true` to bypass this step without providing branding data. The flow will advance to Step 4.

```json
{
  "skip": true
}
```

#### Field Reference

| Field | Type | Required? | Validation | Notes |
|-------|------|-----------|------------|-------|
| `skip` | `boolean` | No | — | Set `true` to skip this step entirely and advance to Policy Setup. |
| `logo_url` | `string \| null` | No | Must be a valid absolute URL | Ignored if `skip: true`. |
| `timezone` | `string` | No | IANA timezone string | Defaults to `"Africa/Douala"` if not provided. Ignored if `skip: true`. |
| `version` | `number (integer)` | No | Must match profile `version` if provided | Ignored if `skip: true`. |

---

### Step 4: Policy Setup (Required)

- **Endpoint**: `PUT /api/agency/onboarding/policies`
- **Auth**: Yes (Agency role)
- **Prerequisite**: Step 2 completed (Step 3 may be skipped)

This is the final required step. It captures the three policy pillars that govern how the agency operates with vendors and customers: **pricing**, **returns**, and **damage handling**.

#### Request Body

```json
{
  "policies": {
    "pricing": {
      "storage_based": {
        "enabled": true,
        "monthly_storage_fee_per_sku": 500,
        "pick_pack_fee_per_order": 200,
        "local_delivery_fee": 1000,
        "out_of_region_delivery_fee": 2500
      },
      "pickup_based": {
        "enabled": false,
        "base_rate_first_kg": 1500,
        "additional_per_kg": 300,
        "out_of_region_surcharge": 1000
      },
      "additional_fees": {
        "cod_handling_fee": {
          "type": "percentage",
          "value": 2
        },
        "failed_delivery_fee": 500,
        "rto_fee": 700,
        "peak_season_surcharge": 500
      },
      "notes": "Bulk orders above 50kg get 10% discount on base rate."
    },
    "returns": {
      "payer": "vendor",
      "handling_fee": 500,
      "return_window_days": 7,
      "notes": "Only unopened items accepted. Customer must provide unboxing video for refund."
    },
    "damage": {
      "claim_deadline_days": 7,
      "max_refund_per_item": 50000,
      "notes": "Damage claims without original packaging will be rejected."
    }
  },
  "version": 2
}
```

> **Note on `enabled` flags:** At least one of `storage_based.enabled` or `pickup_based.enabled` must be `true`. Submitting both as `false` will return a `400 VALIDATION_ERROR`. You must still supply all fee fields regardless of `enabled` state — the backend stores them so the agency can toggle the model on later without re-entering values.

#### Field Reference — `policies.pricing`

The `pricing` object covers two fulfilment models (`storage_based` and `pickup_based`) plus shared `additional_fees`. Each model has an `enabled` flag so agencies that only operate one model can disable the other.

**`pricing.storage_based`** — fees when the agency warehouses vendor stock and ships from its own facility:

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `enabled` | `boolean` | Yes | At least one model must be `true` | Whether this pricing model is active. Set `false` if the agency does not offer warehouse storage. |
| `monthly_storage_fee_per_sku` | `number` | Yes | ≥ 0 | Monthly fee per unique SKU stored in the warehouse. |
| `pick_pack_fee_per_order` | `number` | Yes | ≥ 0 | Fee charged each time an order is picked from the shelf and packed for dispatch. |
| `local_delivery_fee` | `number` | Yes | ≥ 0 | Flat delivery fee for shipments within the same region as the warehouse. |
| `out_of_region_delivery_fee` | `number` | Yes | ≥ 0 | Flat delivery fee for shipments to a different region. |

**`pricing.pickup_based`** — fees when the agency collects goods from the vendor's location and delivers to the customer:

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `enabled` | `boolean` | Yes | At least one model must be `true` | Whether this pricing model is active. Set `false` if the agency does not offer pickup from vendor. |
| `base_rate_first_kg` | `number` | Yes | ≥ 0 | All-in fee for pickup and delivery covering the first 1 kg. |
| `additional_per_kg` | `number` | Yes | ≥ 0 | Extra charge per kg beyond the first 1 kg. |
| `out_of_region_surcharge` | `number` | Yes | ≥ 0 | Extra charge when the delivery destination is outside the vendor's region. Applied on top of the base rate. |

**`pricing.additional_fees`** — applied on top of either active model:

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `cod_handling_fee` | `object` | Yes | See below | Fee charged to the vendor for Cash-on-Delivery orders. |
| `cod_handling_fee.type` | `string` | Yes | Enum: `"percentage"` or `"fixed"` | `"percentage"`: `value` is a % of order total (e.g. `2` = 2%). `"fixed"`: `value` is a flat amount. |
| `cod_handling_fee.value` | `number` | Yes | ≥ 0 | The numeric magnitude of the COD fee. |
| `failed_delivery_fee` | `number` | Yes | ≥ 0 | Fee charged per failed delivery attempt. |
| `rto_fee` | `number` | Yes | ≥ 0 | Return-to-Origin fee when a package cannot be delivered and must go back to the vendor. |
| `peak_season_surcharge` | `number` | No | ≥ 0, default `0` | Extra charge during high-demand periods (e.g. holidays). Omit or send `0` if not applicable. |

**`pricing.notes`**:

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `notes` | `string` | No | Max 700 chars | Free-text for any pricing terms not covered above (e.g. bulk discounts, minimum order thresholds). |

---

#### Field Reference — `policies.returns`

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `payer` | `string` | Yes | Enum: `"vendor"`, `"agency"`, `"customer"` | Who bears the cost of return shipping. |
| `handling_fee` | `number` | Yes | ≥ 0 | Fee the agency charges to process, inspect, and restock (or dispose of) a returned item. |
| `return_window_days` | `number` | Yes | ≥ 0 | Days from delivery within which a return may be initiated. `0` means returns are not accepted. |
| `notes` | `string` | No | Max 700 chars | Additional conditions or required proof (e.g. item must be unopened, unboxing video required). |

---

#### Field Reference — `policies.damage`

| Field | Type | Required? | Validation | Description |
|-------|------|-----------|------------|-------------|
| `claim_deadline_days` | `number` | Yes | ≥ 0 | Days from delivery within which a damage claim must be filed. Claims after this window are rejected. |
| `max_refund_per_item` | `number` | Yes | ≥ 0 | Maximum compensation amount the agency will pay per damaged item. |
| `notes` | `string` | No | Max 700 chars | Additional conditions or rejection criteria (e.g. packaging requirements). |

> **Admin-only fields:** `inspector` and `investigation_fee` are **not accepted from the frontend**. They are preset by the platform admin and will appear in the profile response (defaulting to `"agency"` and `1000` respectively). Do not send these fields — they will be silently ignored.

---

## 4. Successful Step Response

All `PUT` step submissions return the full updated profile and a `completionStatus` block. Use `completionStatus.onboardingStep` to advance the frontend to the next screen.

```json
{
  "success": true,
  "message": "Policy setup completed",
  "data": {
    "profile": {
      "id": "6641abc123def456",
      "agencyName": "FastTrack Logistics",
      "email": null,
      "emailVerified": false,
      "phone": null,
      "phoneVerified": false,
      "logoUrl": null,
      "coverageAreas": ["littoral", "centre"],
      "headquartersAddresses": [
        {
          "_id": "6641abc123def457",
          "region": "Littoral",
          "city": "Douala",
          "address_description": "Akwa, Rue Sylvani",
          "support_contact": {
            "phone": "+237612345678",
            "email": "douala@fasttrack.cm"
          }
        }
      ],
      "payoutDetails": [
        {
          "method": "mobile_money",
          "is_preferred": true,
          "mobile_money": {
            "provider": "MTN Mobile Money",
            "phone_number_masked": "••••0000",
            "account_name": "FastTrack Logistics Sarl"
          },
          "bank": null
        }
      ],
      "kycVerified": false,
      "policies": {
        "pricing": {
          "storage_based": {
            "enabled": true,
            "monthly_storage_fee_per_sku": 500,
            "pick_pack_fee_per_order": 200,
            "local_delivery_fee": 1000,
            "out_of_region_delivery_fee": 2500
          },
          "pickup_based": {
            "enabled": false,
            "base_rate_first_kg": 1500,
            "additional_per_kg": 300,
            "out_of_region_surcharge": 1000
          },
          "additional_fees": {
            "cod_handling_fee": { "type": "percentage", "value": 2 },
            "failed_delivery_fee": 500,
            "rto_fee": 700,
            "peak_season_surcharge": 500
          },
          "notes": "Bulk orders above 50kg get 10% discount on base rate."
        },
        "returns": {
          "payer": "vendor",
          "handling_fee": 500,
          "return_window_days": 7,
          "notes": null
        },
        "damage": {
          "claim_deadline_days": 7,
          "max_refund_per_item": 50000,
          "inspector": "agency",
          "investigation_fee": 1000,
          "notes": null
        }
      },
      "wa": null,
      "timezone": "Africa/Douala",
      "status": "pending_verification",
      "onboardingStep": 0,
      "version": 4,
      "createdAt": "2024-05-18T10:00:00Z",
      "updatedAt": "2024-05-18T10:15:00Z"
    },
    "completionStatus": {
      "onboardingStep": 0,
      "isComplete": true,
      "missingFields": [],
      "stepLabel": "Onboarding Complete"
    }
  }
}
```

---

## 5. Error Handling

### Validation Errors (`400 VALIDATION_ERROR`)

Returned when the request body fails Zod schema validation. The `details` array pinpoints each invalid field.

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "policies.damage.inspector",
        "message": "Invalid enum value. Expected 'agency' | 'vendor' | 'admin'"
      },
      {
        "field": "policies.pricing.additional_fees.cod_handling_fee.type",
        "message": "Invalid enum value. Expected 'percentage' | 'fixed'"
      }
    ]
  }
}
```

### Logic & State Errors

| HTTP | Code | When it occurs | Suggested frontend action |
|------|------|----------------|---------------------------|
| `400` | `DELIVERY_ONBOARDING_STEP_INCOMPLETE` | A prerequisite step has not been completed (e.g. submitting Step 3 before Step 1). | Redirect to the earliest incomplete step. |
| `400` | `DELIVERY_ONBOARDING_STEP_INVALID` | The payload was sent to the wrong step endpoint. | Check routing logic. |
| `409` | `DELIVERY_ONBOARDING_ALREADY_COMPLETED` | The agency is fully onboarded; onboarding endpoints are locked. Use the general profile update endpoint instead. | Redirect to dashboard. |
| `409` | `DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION` | The `version` you sent does not match the server's current value — another session saved changes in the meantime. | Show a prompt: *"Your profile was modified elsewhere. Please refresh and try again."* Then re-fetch the profile, store the new `version`, and let the user re-submit. |
| `404` | `DELIVERY_AGENCY_NOT_FOUND` | No agency profile exists for the authenticated user. | Trigger the initialization flow (`POST /api/agency`). |
