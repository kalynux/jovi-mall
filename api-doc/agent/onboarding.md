# Delivery Agent Onboarding API Documentation

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
    "color": "Red", // Min 1, Max 50 characters
    "plate_number": "LT-123-AB" // Optional/Nullable
  }
}
```

### Step 2: Identity Setup (Optional)

This step captures the avatar and timezone. Since it is optional, the user can choose to skip it.

#### Request Body (Providing Data)
```json
{
  "step": 2,
  "avatar_url": "https://example.com/avatar.jpg", // Optional, must be a valid URL
  "timezone": "Africa/Douala" // Optional
}
```

#### Request Body (Skipping Step)
If the user clicks "Skip" on the UI, send this payload to immediately complete the onboarding process:
```json
{
  "step": 2,
  "skip": true
}
```

### Successful Response (Applies to both steps)

```json
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
  }
}
```
*Note: The backend recalculates the step and returns the next appropriate `onboardingStep` in the response, so the frontend can immediately transition to the next screen based on `completionStatus.onboardingStep`.*

---

## Error Handling

If validation fails, the API responds with a `400 Bad Request` containing detailed field errors.

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "vehicle_info.vehicle_type",
        "message": "Required"
      }
    ]
  }
}
```

If an invalid step is provided:
```json
{
  "success": false,
  "error": {
    "code": "DELIVERY_ONBOARDING_STEP_INVALID",
    "message": "Unknown onboarding step: 3"
  }
}
```
