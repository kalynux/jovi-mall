# Delivery Agent Onboarding API Documentation

**Verified against source on 2026-09-08** — both step schemas, the merge-on-resubmit rule, the
completion-status shape and its three `stepLabel` values, and the completion lock, against
`src/modules/agents/{controllers/agent-self.controller.ts, validators/agent.validator.ts,
domain/services/agent-profile.service.ts, domain/vehicle-info.ts}`.

This documentation provides frontend developers with the specifications needed to build the delivery agent onboarding flow. 

Unlike the agency onboarding which has been upgraded to a more RESTful structure recently, the agent onboarding currently relies on a generic `PATCH` endpoint for step progression.

## Overview

The delivery agent onboarding is a **2-step process**:
1. **Vehicle Setup** (Required) - Captures vehicle type, plate number, and color.
2. **Identity Setup** (Optional) - Captures avatar image and timezone.

A step value of `0` means **COMPLETED**. When the status returns `0`, the frontend should route the user directly to the agent dashboard.

---

## 1. Check Onboarding Status

When a delivery agent logs in, the frontend must check their onboarding status to determine which screen to show.

- **Endpoint**: `GET /api/agent/profile/completion-status`
- **Method**: `GET`
- **Auth Required**: Yes (Agent role)

### Response

```json
{
  "success": true,
  "data": {
    "onboardingStep": 1, 
    "isComplete": false,
    "missingFields": [
      "vehicle_info (vehicle_type, color required)"
    ],
    "stepLabel": "Vehicle Setup"
  }
}
```

*Frontend Routing Logic:*
- If `onboardingStep === 0` (or `isComplete === true`), redirect to `/dashboard`.
- If `onboardingStep === 1`, redirect to `/onboarding/vehicle-setup`.
- If `onboardingStep === 2`, redirect to `/onboarding/identity-setup`.

---

## 2. Submit Onboarding Steps

All steps are submitted to a single polymorphic `PATCH` endpoint by including the `step` number in the payload.

- **Endpoint**: `PATCH /api/agent/onboarding/step`
- **Method**: `PATCH`
- **Auth Required**: Yes (Agent role)

### Step 1: Vehicle Setup (Required)

This step captures the agent's vehicle information.

#### Request Body
```json
{
  "step": 1,
  "vehicle_info": {
    "vehicle_type": "bike", // Enums allowed: 'bike', 'car', 'van', 'truck'
    "color": "red", // Min 1, Max 50 characters — see the palette below
    "plate_number": "LT-123-AB", // Optional/Nullable — null or "" clears it
    "photo_file_id": "665f1c2a9b1e4a0012a3b4ee" // Optional/Nullable — id from POST /api/files/upload
  }
}
```

> **`color` is a vocabulary, not an enum.** Prefer one of
> `white silver grey black red orange yellow green blue purple brown beige gold` — lowercase,
> English, never localized on the wire. Any other string is still accepted, for the "another colour"
> case. Values are trimmed, lowercased and de-aliased (`gray` → `grey`) on write.

> **The vehicle photo is a file reference.** Upload the image via `POST /api/files/upload` and send
> the returned `id`. It must be an image (`400 CATALOG_FILE_TYPE_INVALID` otherwise). Reads return
> the resolved object as `vehicle_info.photo` — see [profile.md](./profile.md).

> Re-submitting step 1 **merges**: `plate_number` and `photo_file_id` keep their stored value when
> the key is omitted, so going back to change the vehicle type does not discard the photo.

### Step 2: Identity Setup (Optional)

This step captures the avatar and timezone. Since it is optional, the user can choose to skip it.

#### Request Body (Providing Data)
```json
{
  "step": 2,
  "avatar_url": "https://example.com/avatar.jpg", // Optional, must be a valid URL — null or "" clears it
  "timezone": "Africa/Douala" // Optional
}
```

> [!NOTE]
> **Onboarding still takes a legacy `avatar_url` (a plain URL string).** The **canonical** avatar is a
> **file reference** set on the profile endpoint (`PATCH /api/agent/profile`, field
> `avatar_file_id` — see [profile.md](./profile.md#patch-agentprofile)): upload the image via
> `POST /api/files/upload`, then send the returned file `id`.
> While set, that file counts as *in use* — it appears under `usage.references` on `GET /api/files/:id`
> with `entityType: "agent", field: "avatar"`, and cannot be deleted until you detach it
> (`avatar_file_id: null`). Profile reads return `avatar` as a **resolved file object** —
> `{ id, key, url, access, mimeType, size, originalName }` (the same shape product images use) — or `null`; never
> a bare URL string. See [File Management — the `usage` object](../vendor/file-management.md#get-apifilesid).

#### Request Body (Skipping Step)
If the user clicks "Skip" on the UI, send this payload to immediately complete the onboarding process:
```json
{
  "step": 2,
  "skip": true
}
```

### Successful Response (Applies to both steps)

```jsonc
{
  "success": true,
  "data": {
    "profile": {
       // ... full agent profile object
       "onboardingStep": 2
    },
    "completionStatus": {
      "onboardingStep": 2,
      "isComplete": false,
      "missingFields": [],
      "stepLabel": "Identity Setup (Optional)"
    }
  },
  "message": "Vehicle setup saved."   // step 2 answers "Onboarding complete."
}
```

`stepLabel` is one of exactly three strings — `"Onboarding Complete"` (0), `"Vehicle Setup"` (1),
`"Identity Setup (Optional)"` (2). `missingFields` today has exactly one possible entry,
`"vehicle_info (vehicle_type, color required)"`, present only while no vehicle has been saved.
**Both are English and are not localized** — treat them as tokens to switch on, or ignore them and
switch on `onboardingStep`, rather than showing them to the agent.
*Note: The backend recalculates the step and returns the next appropriate `onboardingStep` in the response, so the frontend can immediately transition to the next screen based on `completionStatus.onboardingStep`.*

---

## Error Handling

If validation fails, the API responds with a `400 Bad Request` containing detailed field errors.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [
        {
          "path": "vehicle_info.vehicle_type",
          "message": "Required",
          "code": "invalid_type"
        }
      ]
    }
  }
}
```

If an invalid step is provided:
```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "DELIVERY_ONBOARDING_STEP_INVALID",
    "message": "Invalid onboarding step",
    "statusCode": 400,
    "category": "business_rule",
    "details": { "step": 3, "allowed": [1, 2] }
  }
}
```

### Onboarding is locked once completed

While onboarding is in progress the agent may move freely between steps —
re-submitting step 1 from step 2, for example, updates the vehicle info and
keeps them on step 2. **Once `onboardingStep === 0` (COMPLETED), both steps are
closed**: any submission to `PATCH /api/agent/onboarding/step` returns `409`.

```json
{
  "success": false,
  "requestId": "3f8a1c74-9b2e-4d10-8c55-6a0f2b7e19dd",
  "error": {
    "code": "AGENT_ONBOARDING_ALREADY_COMPLETED",
    "message": "Agent onboarding is already completed. Update your details from profile settings instead.",
    "statusCode": 409,
    "category": "conflict"
  }
}
```

The frontend must **not** send an onboarding step after completion. Vehicle
info, avatar and timezone remain fully editable afterwards through the profile
endpoints — `PATCH /api/agent/profile`, `PATCH /api/agent/preferences` and
`PATCH /api/agent/dispatch-settings`, all specced in
[profile.md](./profile.md) — which never reopen onboarding. On
`PATCH /api/agent/profile` the avatar is set as a **file reference** via
`avatar_file_id` (see the note under Step 2 above), not a raw URL.
