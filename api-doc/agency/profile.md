# Delivery Agency Profile Management API Documentation

## Overview

The Agency Profile Management API allows a delivery agency to view and update its profile — logistics, payout, branding, KYC, and policy data — outside of the first-time onboarding flow. All endpoints require authentication and are restricted to `agency` accounts.

> [!TIP]
> This document covers the **profile endpoints**. For:
> - The **full field dictionary and TypeScript interfaces** (every field on the profile object, validation rules, masking behavior), see [profile-schema.md](./profile-schema.md).
> - The **first-time onboarding flow** (`POST /api/agency`, `PUT /api/agency/onboarding/*`), see [onboarding.md](./onboarding.md).

**Base URL**: `/api/agency`

**Authentication**: All endpoints require a valid JWT token in the `Authorization` header, with `agency` role.

---

## Endpoints

### GET /api/agency/profile

Retrieve the authenticated agency's profile.

#### Authentication

- **Required**: Yes
- **Role**: `agency`

#### Headers

```http
Authorization: Bearer <jwt_token>
```

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "6641abc123def456",
    "agencyName": "FastTrack Logistics",
    "email": "contact@fasttrack.cm",
    "emailVerified": true,
    "phone": "+237612345678",
    "phoneVerified": false,
    "logoUrl": "https://cdn.example.com/fasttrack-logo.png",
    "coverageAreas": ["littoral", "centre"],
    "headquartersAddresses": [
      {
        "_id": "6641abc123def457",
        "region": "Littoral",
        "city": "Douala",
        "address_description": "Akwa, Rue Sylvani, immeuble ABC",
        "support_contact": { "phone": "+237612345678", "email": "douala@fasttrack.cm" }
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
        "notes": null
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
    "preferredLanguage": "en",
    "status": "pending_verification",
    "onboardingStep": 0,
    "version": 4,
    "createdAt": "2024-05-18T10:00:00.000Z",
    "updatedAt": "2024-05-18T10:15:00.000Z"
  }
}
```

See [profile-schema.md](./profile-schema.md) for the meaning and validation rules of every field above.

#### Error Responses

**Not Found (404)**:

```json
{
  "success": false,
  "error": {
    "code": "DELIVERY_AGENCY_NOT_FOUND",
    "message": "..."
  }
}
```

---

### PATCH /api/agency/profile

Update the authenticated agency's profile. **This is the endpoint to use for all post-onboarding edits** — including fields the agency originally set during onboarding (logistics, payout, branding, policies).

> [!IMPORTANT]
> **When to use this vs. the onboarding endpoints.**
> The `PUT /api/agency/onboarding/*` step endpoints are for the **first-time onboarding flow only**. Once onboarding is complete (`onboardingStep === 0`) they all return `409 DELIVERY_ONBOARDING_ALREADY_COMPLETED`.
> To let an agency change a previously-entered onboarding value from the **Settings UI**, send it here instead. See [onboarding.md](./onboarding.md) for the original first-time flow.

> [!WARNING]
> **No optimistic locking on this endpoint.** Unlike `vendor/profile.md`'s `PATCH /api/vendor/profile`, this endpoint does **not** accept or check a `version` field — sending one has no effect and is silently ignored (it is not part of `UpdateAgencyProfileSchema`). Concurrent-write protection (`version`) exists only on the separate `PUT /api/agency/onboarding/*` step endpoints, and there it's optional. Do not build a "refresh and retry on 409" flow around this endpoint — it will never receive a `409 CONFLICT` for a version mismatch.

#### Authentication

- **Required**: Yes
- **Role**: `agency`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### How to send

- **Partial update**: send **only** the fields you want to change. Omitted fields are left untouched.
- **Object/array fields are a full replace, not a merge.** When you send `coverage_areas`, `headquarters_addresses`, `payout_details`, or `policies`, the value you send **replaces** the entire stored value. To edit one entry, send the complete desired array/object (including the parts you want to keep).
- **`policies.damage.inspector` / `policies.damage.investigation_fee` are preserved automatically.** These two sub-fields are admin-controlled presets. Even though `policies` is otherwise a full replace, the server re-injects the agency's existing `inspector`/`investigation_fee` values (or platform defaults `"agency"` / `1000` if none set yet) into the response — the frontend never needs to send them and cannot override them here.
- **`onboardingStep` may change as a side-effect.** After every save, the server recalculates `onboardingStep` from the resulting data completeness (coverage areas + HQ addresses → step 1 done; payout details → step 2 done; `policies` present → complete). Clearing a previously-set field (e.g. sending an empty `payout_details` is rejected by validation, but removing all `policies` is not possible via this endpoint) can in principle move `onboardingStep` backwards. In practice this only surfaces if a field that was previously complete becomes incomplete.

#### Request Body (example — edit several fields at once)

```json
{
  "agency_name": "FastTrack Logistics SARL",
  "logo_url": "https://cdn.example.com/fasttrack-logo-v2.png",
  "timezone": "Africa/Douala",
  "preferred_language": "fr",
  "payout_details": [
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "Orange Money",
        "phone_number": "+237690000000",
        "account_name": "FastTrack Logistics Sarl"
      },
      "bank": null
    }
  ]
}
```

#### Field Reference

All fields are **optional** — send only what changed. This maps 1:1 to `UpdateAgencyProfileSchema` in `src/modules/delivery/validators/agency-onboarding.validator.ts`.

| Field | Type | Validation | Onboarding step it maps to | Notes |
|-------|------|------------|----------------------------|-------|
| `agency_name` | `string` | 1–200 chars | Init (`POST /api/agency`) | Registered agency name. |
| `logo_url` | `string \| null` | Valid absolute URL, or `null` | Step 3 (Branding) | Full replace of this field. |
| `timezone` | `string` | Min 1 char, IANA tz | Step 3 (Branding) | E.g. `"Africa/Douala"`. |
| `preferred_language` | `string` | Enum: `"en"`, `"fr"`, `"pt"`, `"es"`, `"ar"` | — (general) | Drives notification/UI language. |
| `coverage_areas` | `string[]` | Min 1 item, each a region key from `locations.json` | Step 1 (Logistics) | Full replace. |
| `headquarters_addresses` | `object[]` | Min 1 entry; see [Step 1 field reference](./onboarding.md#step-1-logistics-setup-required) | Step 1 (Logistics) | Full replace. Index 0 = primary HQ. |
| `payout_details` | `object[]` | 1–2 entries, ordered (index 0 = preferred); see [Step 2 field reference](./onboarding.md#step-2-payout-setup-required) | Step 2 (Payout) | Full replace. |
| `kyc_details` | `object` | `{ registration_number?, transport_license_id? }`, both nullable strings | — (general) | `legit_verified` is **admin-only** and ignored if sent. |
| `policies` | `object` | `{ pricing, returns, damage }` — see [Step 4 field reference](./onboarding.md#step-4-policy-setup-required) | Step 4 (Policy Setup) | Full replace of the **whole** `policies` object. `damage.inspector`/`damage.investigation_fee` are preserved server-side regardless of what (if anything) you send for them. |

> **Not editable here:** `email`, `phone` (no route exposes agency-initiated email/phone changes today), `status`, `kycVerified` (`kyc_details.legit_verified`), `onboardingStep`, `version` — all server/admin-controlled.

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "6641abc123def456",
    "agencyName": "FastTrack Logistics SARL",
    "email": "contact@fasttrack.cm",
    "emailVerified": true,
    "phone": "+237612345678",
    "phoneVerified": false,
    "logoUrl": "https://cdn.example.com/fasttrack-logo-v2.png",
    "coverageAreas": ["littoral", "centre"],
    "headquartersAddresses": [ ],
    "payoutDetails": [
      {
        "method": "mobile_money",
        "is_preferred": true,
        "mobile_money": {
          "provider": "Orange Money",
          "phone_number_masked": "••••0000",
          "account_name": "FastTrack Logistics Sarl"
        },
        "bank": null
      }
    ],
    "kycVerified": false,
    "policies": { "...": "unchanged, full policies object" },
    "wa": null,
    "timezone": "Africa/Douala",
    "preferredLanguage": "fr",
    "status": "pending_verification",
    "onboardingStep": 0,
    "version": 5,
    "createdAt": "2024-05-18T10:00:00.000Z",
    "updatedAt": "2024-05-20T09:30:00.000Z"
  },
  "message": "Profile updated successfully"
}
```

#### Error Responses

**Validation Error (400)**:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "policies.pricing.storage_based.enabled",
        "message": "At least one of storage_based or pickup_based must be enabled."
      }
    ]
  }
}
```

**Not Found (404)**:

```json
{
  "success": false,
  "error": {
    "code": "DELIVERY_AGENCY_NOT_FOUND",
    "message": "..."
  }
}
```

#### Notes

- **Editing onboarding fields**: After onboarding completes, this endpoint is the **only** way to change values originally captured during onboarding (logistics, payout, branding, policies). The onboarding step endpoints are locked (`409`) once complete.
- **Full-replace semantics**: `coverage_areas`, `headquarters_addresses`, `payout_details`, and `policies` overwrite the stored value wholesale. Always send the complete desired value, not a delta.
- **No optimistic locking**: see the `[!WARNING]` above — this endpoint has no `version` check, unlike the vendor equivalent and unlike this same agency's onboarding step endpoints.
- **Admin-controlled fields are protected**: `kyc_details.legit_verified` and `policies.damage.{inspector, investigation_fee}` cannot be changed here even if included in the request body.

---

### GET /api/agency/profile/completion-status

> [!NOTE]
> **Legacy endpoint, kept for backward compatibility.** New integrations should prefer [`GET /api/agency/onboarding/status`](./onboarding.md#1-check-onboarding-status), which returns a richer payload (per-step breakdown, progress percentage, warnings). This endpoint returns a minimal subset of the same information and is not being extended further.

Retrieve a minimal onboarding-completion summary for the authenticated agency.

#### Authentication

- **Required**: Yes
- **Role**: `agency`

#### Headers

```http
Authorization: Bearer <jwt_token>
```

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "onboardingStep": 0,
    "isComplete": true,
    "missingFields": [],
    "stepLabel": "Onboarding Complete"
  }
}
```

- `onboardingStep` *(number)* — `0` = complete, `1`–`4` = current step.
- `isComplete` *(boolean)*.
- `missingFields` *(string[])* — e.g. `["coverage_areas", "headquarters_addresses (min 1)", "payout_details", "policies"]`, whichever are still unset.
- `stepLabel` *(string)* — human label for the current step.

#### Error Responses

**Not Found (404)**:

```json
{
  "success": false,
  "error": {
    "code": "DELIVERY_AGENCY_NOT_FOUND",
    "message": "..."
  }
}
```

---

## Error Codes Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Insufficient permissions (wrong role) |
| `DELIVERY_AGENCY_NOT_FOUND` | 404 | No agency profile exists for the authenticated user |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Example Workflow — Change Payout Details (post-onboarding, from Settings)

Onboarding is already complete, so `PUT /api/agency/onboarding/payout` would return `409 DELIVERY_ONBOARDING_ALREADY_COMPLETED`. Edit via the profile endpoint instead. Send the **complete** payout array (full replace):

```bash
# 1. Read current profile (not required for a version — just to see current data)
curl -X GET https://api.example.com/api/agency/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# 2. Replace payout details
curl -X PATCH https://api.example.com/api/agency/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "payout_details": [
      {
        "method": "bank",
        "mobile_money": null,
        "bank": {
          "bank_name": "Afriland First Bank",
          "account_number": "10005000123456",
          "account_name": "FastTrack Logistics Sarl",
          "country": "CM"
        }
      }
    ]
  }'
```
