# Onboarding API Endpoints Documentation

This document provides details on the onboarding flows and endpoints for the different roles in the Jovi Mall platform: **Vendor**, **Delivery Agent**, and **Delivery Agency**. 

Note: **Customers** do not have an onboarding flow (their `onboarding_step` is inherently `0` or complete upon registration).

---

## General Onboarding Flow

For all role types, the frontend flow is dictated by checking the completion status of the current user.

1. **Check Completion Status**: The frontend should call the respective `/profile/completion-status` endpoint for the active role after login.
2. **Route to Step**: The response includes `onboardingStep` (the next step to complete) and `isComplete` (whether onboarding is finished). Route the user to the appropriate screen based on `onboardingStep`.
3. **Submit Step Data**: Submit the required payload to the respective `/onboarding/step` endpoint.
4. **Repeat**: After a successful step submission, repeat the `completion-status` check or rely on the updated step in the response to navigate to the next screen.

---

## 1. Vendor Onboarding

Vendors must complete basic setup and select a delivery agency before their profile is considered fully active. Branding and additional addresses can be skipped initially.

### Endpoints
*   **Status Check**: `GET /api/vendor/profile/completion-status`
*   **Submit Step**: `PATCH /api/vendor/onboarding/step`

### Steps & Payloads

#### **Step 1: Basic Setup (Mandatory)**
**Payload**:
```json
{
  "step": 1,
  "country": "CM", // Valid ISO-2 code
  "timezone": "Africa/Douala", // Required
  "payout_details": {
    "provider": "mtn_mobile_money",
    "account_number": "number string",
    "account_name": "name string",
    "provider_meta": {} // Optional metadata
  }
}
```

#### **Step 2: Delivery Linking (Mandatory)**
**Payload**:
```json
{
  "step": 2,
  "default_delivery_agency_id": "agency_id_str" // Required
}
```

#### **Step 3: Branding & Extras (Skippable)**
**Payload**:
```json
{
  "step": 3,
  "skip": false, // Set to true to skip this step without providing branding data
  "branding": { // Optional — ids of files uploaded via POST /api/files/upload
    "logo_file_id": "507f1f77bcf86cd799439030",
    "cover_image_file_id": "507f1f77bcf86cd799439031"
  },
  "business_addresses": [ // Optional
    {
      "label": "string",
      "address_line1": "string",
      "address_line2": "string", // Optional
      "city": "string",
      "state": "string", // Optional
      "location": { // Optional
        "type": "Point",
        "coordinates": [longitude, latitude]
      }
    }
  ]
}
```

---

## 2. Delivery Agent Onboarding

Delivery Agents (Drivers) must provide vehicle information. Identity setup can be added later and thus is skippable at the onboarding stage.

### Endpoints
*   **Status Check**: `GET /api/agent/profile/completion-status`
*   **Submit Step**: `PATCH /api/agent/onboarding/step`

### Steps & Payloads

#### **Step 1: Vehicle Setup (Mandatory)**
**Payload**:
```json
{
  "step": 1,
  "vehicle_info": {
    "vehicle_type": "bike", // Enums: "bike", "car", "van", "truck"
    "color": "red",
    "plate_number": "string" // Optional/Nullable
  }
}
```

#### **Step 2: Identity Setup (Skippable)**
**Payload**:
```json
{
  "step": 2,
  "skip": false, // Set to true to skip this step
  "avatar_url": "url", // Optional
  "timezone": "Africa/Douala" // Optional
}
```

---

## 3. Delivery Agency Onboarding

Agencies must define their coverage areas and headquarters, followed by payout settings. Branding can be skipped.

### Endpoints
*   **Status Check**: `GET /api/agency/onboarding/status` (`GET /api/agency/profile/completion-status` is kept for backward compatibility)
*   **Submit Step**: `PUT /api/agency/onboarding/{logistics|payout|branding|policies}` (steps 1–4)

> [!IMPORTANT]
> **[`agency/onboarding.md`](../agency/onboarding.md) is authoritative** for the agency flow — full
> field references, validation rules and error codes. The payloads below are a summary.

### Steps & Payloads

#### **Step 1: Logistics Setup (Mandatory)**

`coverage_areas` and `headquarters_addresses` are stored on the [Magazin](../agency/magazin.md) and
validated against `country`. Coverage areas are **region keys** of that country (from
`locations.json`), not polygons. Each HQ entry carries a `geo` — a result selected from
`GET /api/geo/search` — and `location`, `region` and `city` are **derived from it** server-side.

**Payload**:
```jsonc
{
  "country": "CM",                          // Valid ISO-2 code; set once
  "coverage_areas": ["littoral", "centre"], // Minimum 1 region key
  "headquarters_addresses": [               // Minimum 1. First entry is primary.
    {
      "label": "Douala HQ",                 // Required, 1–50 chars — your name for the location
      "address_description": "Akwa, Rue Sylvani, immeuble ABC",
      "support_contact": {
        "phone": "+237612345678",
        "email": "douala@fasttrack.cm"      // Optional
      },
      // Required on every new/edited entry; must resolve inside `country`.
      "geo": {
        "formatted_address": "Akwa, Douala, Cameroon",
        "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0511] },
        "provider": "nominatim",
        "components": { "city": "Douala", "region": "Littoral", "country_code": "CM" }
      }
    }
  ]
}
```

#### **Step 2: Payout Setup (Mandatory)**

`payout_details` is an **ordered array** of methods (max 3); the first entry is the preferred one.

**Payload**:
```jsonc
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

#### **Step 3: Branding (Skippable)**
**Payload**:
```jsonc
{
  "skip": false, // Set to true to skip
  "logo_file_id": "507f1f77bcf86cd799439030", // Optional — id from POST /api/files/upload
  "timezone": "Africa/Douala" // Optional
}
```

#### **Step 4: Policy Setup (Mandatory)**

The largest payload of the flow — pricing (at least one of `storage_based` / `pickup_based` enabled),
returns, damage, and optional `cod` participation. See
[`agency/onboarding.md`](../agency/onboarding.md) for the full field reference.

**Payload**:
```jsonc
{
  "policies": {
    "pricing": { "storage_based": { /* … */ }, "pickup_based": { /* … */ }, "additional_fees": { /* … */ } },
    "returns": { "payer": "vendor", "handling_fee": 0, "return_window_days": 7 },
    "damage":  { "claim_deadline_days": 5, "max_refund_per_item": 50000 },
    "cod":     { "enabled": true, "max_order_amount": 200000 } // Optional
  }
}
```
