# Onboarding API Endpoints Documentation

**Verified against source on 2026-09-08** — every route in the three step tables exists and is
named correctly (`PUT /api/vendor/onboarding/{basic-setup,delivery-linking,branding,policy-setup}`,
`PUT /api/agency/onboarding/{logistics,payout,branding,policies}`,
`PATCH /api/agent/onboarding/step`, and the four `*/completion-status` reads), against the live
route table for `jovi-mall/src/`.

This document provides details on the onboarding flows and endpoints for the different roles in the Jovi Mall platform: **Vendor**, **Delivery Agent**, and **Delivery Agency**. 

Note: **Customers** do not have an onboarding flow (their `onboarding_step` is inherently `0` or complete upon registration).

---

## General Onboarding Flow

For all role types, the frontend flow is dictated by checking the completion status of the current user.

1. **Check Completion Status**: The frontend should call the respective `/profile/completion-status` or `/onboarding/status` endpoint for the active role after login.
2. **Route to Step**: The response includes `onboardingStep` (the next step to complete) and `isComplete` (whether onboarding is finished). Route the user to the appropriate screen based on `onboardingStep`.
3. **Submit Step Data**: Submit the required payload to that step's endpoint.
4. **Repeat**: After a successful step submission, repeat the status check or rely on the updated `completionStatus` in the response to navigate to the next screen.

> **⚠ The three roles do not share one endpoint shape.** Vendor and agency use a **`PUT` per
> step**; only the **agent** has a single `PATCH …/onboarding/step` taking a `step` field. The
> old `PATCH /api/vendor/onboarding/step` and `PATCH /api/agency/onboarding/step` were removed
> and no longer exist.

---

## 1. Vendor Onboarding

Four steps, each its own `PUT`. Step 1 is mandatory; steps 2–4 are skippable. A completed step can
be re-submitted to update its data without resetting progress.

> [!IMPORTANT]
> **[`vendor/onboarding.md`](../vendor/onboarding.md) is authoritative** for the vendor flow —
> full field references, validation rules and error codes. The payloads below are a summary.

### Endpoints
*   **Status Check**: `GET /api/vendor/onboarding/status` (rich) · `GET /api/vendor/profile/completion-status` (step + missing fields)
*   **Submit Step**: `PUT /api/vendor/onboarding/{basic-setup|delivery-linking|branding|policy-setup}` (steps 1–4)

Every step accepts an optional `version` integer for optimistic concurrency
(`409 VENDOR_ONBOARDING_CONCURRENT_MODIFICATION` on a mismatch). Once `onboarding_step === 0`, all
four answer `409 VENDOR_ONBOARDING_ALREADY_COMPLETED` — edit through `PATCH /api/vendor/profile`
instead.

### Steps & Payloads

#### **Step 1: Basic Setup (Mandatory)** — `PUT /api/vendor/onboarding/basic-setup`
**Payload**:
```jsonc
{
  "country": "CM",              // Valid ISO-2 code; locks at onboarding completion
  "timezone": "Africa/Douala",  // Required
  "payout_details": [ /* ordered array, max 3 — see ../vendor/payout-methods.md */ ]
}
```

#### **Step 2: Delivery Linking (Skippable)** — `PUT /api/vendor/onboarding/delivery-linking`

**This step no longer selects an agency.** It is a plain step-advance. Choosing a delivery agency
requires that agency's **consent**, so it happens through
[Agency Connections](../vendor/agency-connections.md) instead — and
`default_delivery_agency_id` is set **automatically** the first time any connection is approved.

**Payload**: `{}` (or `{ "skip": true }`)

#### **Step 3: Branding & Extras (Skippable)** — `PUT /api/vendor/onboarding/branding`
**Payload**:
```jsonc
{
  "skip": false, // Set to true to skip this step without providing branding data
  "branding": {  // Optional — ids of files uploaded via POST /api/files/upload.
                 // Stored on the vendor's Store, not the profile.
    "logo_file_id": "507f1f77bcf86cd799439030",
    "cover_image_file_id": "507f1f77bcf86cd799439031"
  },
  "business_addresses": [ // Optional — a FULL REPLACE of the array. Re-send the `_id`
                          // you were given on read for an existing entry, or it is
                          // treated as a removal (409 VENDOR_BUSINESS_ADDRESS_IN_USE if
                          // a product's pickup location still points at it).
    {
      "_id": "507f1f77bcf86cd799439040", // omit when adding a new address
      "label": "Main Shop",
      "address_line1": "123 Market St",
      "address_line2": null,
      "city": "Douala",
      "state": "Littoral",
      // Required on every new/edited entry; must resolve inside `country`.
      "geo": { "...": "a selected GET /api/geo/search result — see ../vendor/onboarding.md" }
    }
  ]
}
```

#### **Step 4: Policy Setup (Skippable)** — `PUT /api/vendor/onboarding/policy-setup`
**Payload**:
```jsonc
{
  "skip": false,
  "return_policy": { /* … */ },
  "cancellation_policy": { /* … */ },
  "support_policy": { /* … */ }
  // `policies.documents` takes URLs from POST /api/vendor/profile/policy-documents
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
    "color": "red", // Lowercase English colour token; free text accepted
    "plate_number": "string", // Optional/Nullable
    "photo_file_id": "665f1c2a9b1e4a0012a3b4ee" // Optional/Nullable — id from POST /api/files/upload
  }
}
```

> Full contract (colour palette, photo rules, merge semantics):
> [agent/onboarding.md](../agent/onboarding.md) and [agent/profile.md](../agent/profile.md).

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
Each is `mobile_money`, `bank` or `card` — though 🚧 **only `mobile_money` can be configured right
now**. Full field reference: [Agency payout methods](../agency/payout-methods.md) (vendors: [the
same schema, vendor side](../vendor/payout-methods.md)).

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
