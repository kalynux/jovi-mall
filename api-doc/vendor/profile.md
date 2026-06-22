# Vendor Profile Management API Documentation

## Overview

The Vendor Profile Management API allows vendors to view and update their profile information, manage notification preferences, and change their password. All endpoints require authentication and are restricted to vendor accounts only.

**Base URL**: `/api/vendor`

**Authentication**: All endpoints require a valid JWT token in the `Authorization` header.

---

## Endpoints

### GET /api/vendor/profile

Retrieve the authenticated vendor's profile.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

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
    "id": "507f1f77bcf86cd799439011",
    "email": "vendor@example.com",
    "emailVerified": true,
    "phone": "+237612345678",
    "phoneVerified": false,
    "businessName": "Tech Solutions Ltd",
    "displayName": "TechSol",
    "notificationPreferences": {
      "email": true,
      "whatsapp": false,
      "phone": false
    },
    "twoFactorEnabled": false,
    "status": "active",
    "version": 3,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-20T14:22:00.000Z"
  }
}
```

#### Error Responses

**Unauthorized (401)**:

```json
{
  "error": "Unauthorized: Missing token"
}
```

**Forbidden (403)**:

```json
{
  "error": "Forbidden: Insufficient permissions"
}
```

**Not Found (404)**:

```json
{
  "success": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Vendor profile not found"
  }
}
```

---

### PATCH /api/vendor/profile

Update the authenticated vendor's profile. **This is the endpoint to use for all post-onboarding edits** — including fields the vendor originally set during onboarding (payout details, branding, policies, country/timezone, etc.).

> [!IMPORTANT]
> **When to use this vs. the onboarding endpoints.**
> The `PUT /api/vendor/onboarding/*` step endpoints are for the **first-time onboarding flow only**. Once onboarding is complete (`onboarding_step === 0`) they all return `409 VENDOR_ONBOARDING_ALREADY_COMPLETED`.
> To let a vendor change a previously-entered onboarding value from the **Settings UI**, send it here instead. See [Onboarding docs](./onboarding.md) for the original first-time flow.
>
> **One exception:** the default delivery agency (onboarding Step 2) is **not** editable through this endpoint — use the dedicated [`PUT/DELETE /api/vendor/profile/default-delivery-agency`](#put-apivendorprofiledefault-delivery-agency) routes documented below.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### How to send

- **Partial update**: send **only** the fields you want to change. Omitted fields are left untouched.
- **`version` is always required** (optimistic locking — see [Optimistic Locking](#optimistic-locking)). Read it from `GET /api/vendor/profile` first.
- **Object/array fields are a full replace, not a merge.** When you send `payout_details`, `business_addresses`, `operating_hours`, `branding`, `social_links`, or `policies`, the value you send **replaces** the entire stored value. To edit one entry, send the complete desired array/object (including the parts you want to keep). Omitting a field entirely leaves it unchanged — sending it with a partial value overwrites the rest.

#### Request Body (example — edit several fields at once)

```json
{
  "displayName": "TechSolutions",
  "phone": "+237698765432",
  "country": "CM",
  "timezone": "Africa/Douala",
  "payout_details": [
    {
      "method": "mobile_money",
      "mobile_money": {
        "provider": "MTN Mobile Money",
        "phone_number": "+237670000000",
        "account_name": "Tech Solutions Sarl"
      },
      "bank": null
    }
  ],
  "notificationPreferences": { "email": true, "whatsapp": false, "phone": false },
  "version": 3
}
```

#### Field Reference

All fields are **optional except `version`**. Every field below maps to a profile/onboarding concept; send only what changed.

| Field | Type | Validation | Onboarding step it maps to | Notes |
|-------|------|------------|----------------------------|-------|
| `displayName` | `string` | 2–100 chars | — (general) | User-facing display name. |
| `businessDescription` | `string \| null` | Max 1000 chars | — (general) | Short business description. |
| `email` | `string` | Valid email | — (general) | **Feature-gated** — rejected with `403` when `ALLOW_EMAIL_CHANGE=false`. |
| `phone` | `string` | 8–20 chars | — (general) | Contact phone. |
| `country` | `string` | Exactly 2 chars, ISO-2 (auto-uppercased) | Step 1 (Basic Setup) | Editable independently here (onboarding required it alongside timezone + payout). |
| `timezone` | `string` | Min 1 char, IANA tz | Step 1 (Basic Setup) | E.g. `"Africa/Douala"`. |
| `payout_details` | `object[]` | 1–3 entries, ordered (index 0 = preferred) | Step 1 (Basic Setup) | Full replace. Sub-schema (`method`, `mobile_money`, `bank`) is identical to onboarding — see [Step 1 field reference](./onboarding.md#step-1-basic-setup-required). |
| `branding` | `object` | `logo_url`, `cover_image_url` — valid URLs or `null` | Step 3 (Branding) | Full replace. See [Step 3 field reference](./onboarding.md#step-3-branding-optional--skippable). |
| `business_addresses` | `object[]` | See onboarding sub-schema | Step 3 (Branding) | Full replace. See [Step 3 field reference](./onboarding.md#step-3-branding-optional--skippable). |
| `operating_hours` | `object[]` | Per-day `{ day, open_time "HH:MM", close_time "HH:MM", is_closed }` | — (general) | Full replace. |
| `policies` | `object \| null` | `{ return_policy?, cancellation_policy?, support_policy? }` (each nullable) | Step 4 (Policy Setup) | Full replace of the **whole** `policies` object — include every sub-policy you want to keep. See [Step 4 field reference](./onboarding.md#step-4-policy-setup-optional--skippable). |
| `kyc_details` | `object` | `{ national_id_number }` | — (general) | `legit_verified` is **admin-only** and ignored if sent. |
| `social_links` | `object` | `instagram`, `facebook`, `twitter` — valid URLs or `null` | — (general) | Full replace. |
| `notificationPreferences` | `object` | `{ email?, whatsapp?, phone? }` booleans | — (general) | `whatsapp`/`phone` are feature-flagged (see below). |
| `version` | `number` (integer) | **Required**, must match current profile `version` | — | Optimistic-locking guard. Mismatch → `409`. |

> **Not editable here:** `default_delivery_agency_id` (onboarding Step 2). Use the dedicated delivery-agency routes below. `legit_verified`, `status`, and `onboarding_step` are server/admin-controlled.

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "email": "newemail@example.com",
    "emailVerified": false,
    "phone": "+237698765432",
    "phoneVerified": false,
    "businessName": "Tech Solutions Ltd",
    "displayName": "TechSolutions",
    "notificationPreferences": {
      "email": true,
      "whatsapp": false,
      "phone": false
    },
    "twoFactorEnabled": false,
    "status": "active",
    "version": 4,
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-21T09:15:00.000Z"
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
        "field": "displayName",
        "message": "String must contain at least 2 character(s)"
      }
    ]
  }
}
```

**Email Change Locked (403)**:

> [!NOTE]
> Email changes are controlled by the `ALLOW_EMAIL_CHANGE` configuration flag. When set to `false`, this error is returned.

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Email changes are not allowed. Please contact support if you need to update your email address."
  }
}
```

**Feature Not Available (403)**:

> [!NOTE]
> WhatsApp and phone notifications are feature-flagged OFF in the initial release. This creates an upgrade path for premium plans.

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "WhatsApp notifications are not available on your current plan. Please upgrade to enable this feature."
  }
}
```

**Optimistic Locking Conflict (409)**:

> [!IMPORTANT]
> This error occurs when the profile was modified by another request between when you loaded it and when you tried to save it. The client should refresh the profile and retry the update.

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Profile was modified by another request. Please refresh the page and try again."
  }
}
```

#### Notes

- **Editing onboarding fields**: After onboarding completes, this endpoint is the **only** way to change values originally captured in the onboarding flow (payout, branding, policies, country/timezone). The onboarding step endpoints are locked (`409`). The exception is the default delivery agency — use its dedicated routes.
- **Full-replace semantics**: `payout_details`, `business_addresses`, `operating_hours`, `branding`, `social_links`, and `policies` overwrite the stored value wholesale. Always send the complete desired value, not a delta.
- **Optimistic Locking**: The `version` field prevents concurrent update conflicts. Always include the current version number from the GET response.
- **Email Changes**: If `ALLOW_EMAIL_CHANGE=false`, email updates are rejected. Contact support to change email.
- **Notification Preferences**: Only `email` notifications are available. `whatsapp` and `phone` are feature-flagged for future pricing tiers.

---

### PATCH /api/vendor/profile/password

Change the authenticated vendor's password.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### Request Body

```json
{
  "oldPassword": "CurrentPassword123!",
  "newPassword": "NewSecureP@ssw0rd"
}
```

**Fields**:

- `oldPassword` (**required**, string): Current password
- `newPassword` (**required**, string): New password

**Password Requirements**:
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

#### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "message": "Password updated successfully. Please use your new password on next login."
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
        "field": "newPassword",
        "message": "Password must contain at least one uppercase letter"
      }
    ]
  }
}
```

**Incorrect Old Password (403)**:

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Current password is incorrect"
  }
}
```

#### Notes

- **Password Verification**: The old password must be correct before the new password is set.
- **Session Invalidation**: Future implementation will invalidate all active sessions, requiring re-authentication with the new password.

---

### GET /api/vendor/profile/default-delivery-agency

Retrieve the authenticated vendor's currently-configured default delivery agency details.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
```

#### Response

**Success (200 OK)**:
Returns the agency details as a vendor-safe `VendorAgencyListItemDto`. Returns `null` if no default is configured.

```json
{
  "success": true,
  "data": {
    "id": "683abc1234567890abcdef01",
    "agencyName": "Swift Deliveries Cameroon",
    "logoUrl": "https://cdn.example.com/logos/swift-deliveries.png",
    "kycVerified": true,
    "headquartersAddress": {
      "region": "Littoral",
      "city": "Douala",
      "address_description": "4th Floor, Immeuble Ndokotti, Akwa"
    },
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
}
```

Or when no default is set:
```json
{
  "success": true,
  "data": null
}
```

#### Error Responses

Same as `GET /api/vendor/profile`.

---

### PUT /api/vendor/profile/default-delivery-agency

Set or update the authenticated vendor's default delivery agency outside the onboarding flow.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

#### Request Body

```json
{
  "agencyId": "683abc1234567890abcdef01"
}
```

**Fields**:
- `agencyId` (**required**, string, valid MongoDB ObjectId): The ID of the delivery agency.

#### Response

**Success (200 OK)**:
Returns the configured agency details as a vendor-safe `VendorAgencyListItemDto`.

```json
{
  "success": true,
  "data": {
    "id": "683abc1234567890abcdef01",
    "agencyName": "Swift Deliveries Cameroon",
    "logoUrl": "https://cdn.example.com/logos/swift-deliveries.png",
    "kycVerified": true,
    "headquartersAddress": {
      "region": "Littoral",
      "city": "Douala",
      "address_description": "4th Floor, Immeuble Ndokotti, Akwa"
    },
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
  },
  "message": "Default delivery agency updated successfully"
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
        "field": "agencyId",
        "message": "Invalid input: Must be a valid agency ID"
      }
    ]
  }
}
```

**Agency Not Found / Ineligible (400 / 404)**:
Returned if the agency does not exist, is inactive, or has not completed onboarding.
```json
{
  "success": false,
  "error": {
    "code": "DELIVERY_AGENCY_NOT_FOUND",
    "message": "The selected delivery agency does not exist."
  }
}
```

---

### DELETE /api/vendor/profile/default-delivery-agency

Clear the authenticated vendor's default delivery agency.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Headers

```http
Authorization: Bearer <jwt_token>
```

#### Response

**Success (200 OK)**:
```json
{
  "success": true,
  "message": "Default delivery agency cleared"
}
```

---

## Feature Flags & Configuration

### Email Change Lock

**Environment Variable**: `ALLOW_EMAIL_CHANGE`

- `true`: Vendors can update their email address
- `false` (default): Email changes are disabled, returns error with support contact message

**Use Cases**:
- Prevent spam/abuse
- Maintain email verification integrity
- Enforce business rules

### Notification Channels

**WhatsApp Notifications**:
- **Status**: Feature-flagged OFF (hardcoded)
- **Future**: Enable for premium plans

**Phone Notifications**:
- **Status**: Feature-flagged OFF (hardcoded)
- **Future**: Enable for premium plans

**Email Notifications**:
- **Status**: Always available
- **Default**: Enabled

---

## Optimistic Locking

All profile updates use **optimistic locking** to prevent data loss from concurrent modifications.

### How It Works

1. Client fetches profile: `GET /api/vendor/profile` → receives `version: 3`
2. Client modifies fields locally
3. Client sends update: `PATCH /api/vendor/profile` with `version: 3`
4. Server checks if current version is still `3`
   - **Match**: Update succeeds, version incremented to `4`
   - **Mismatch**: Returns 409 Conflict error
5. On conflict, client refreshes profile and retries

### Best Practices

- Always include the `version` field in update requests
- Handle 409 Conflict errors by refreshing data and prompting user to retry
- Display clear message: "Profile was updated elsewhere. Please refresh and try again."

---

## Domain Events & Audit Logging

### Events Emitted

**Profile Updated**:
```javascript
eventBus.publish('vendor.profile.updated', {
  eventType: 'vendor.profile.updated',
  aggregateId: vendorId,
  payload: {
    vendorId,
    changes: { email: { from: 'old@example.com', to: 'new@example.com' } }
  },
  occurredAt: new Date()
});
```

**Password Changed**:
```javascript
eventBus.publish('user.password.changed', {
  eventType: 'user.password.changed',
  aggregateId: userId,
  payload: { userId, role: 'vendor', roleEntityId: vendorId },
  occurredAt: new Date()
});
```

### Audit Logs

All profile updates and password changes are logged for compliance:

```javascript
auditLogger.log({
  actor: { userId, role: 'vendor' },
  action: 'VENDOR_PROFILE_UPDATED',
  resource: { type: 'Vendor', id: vendorId },
  changes: { displayName: { from: 'OldName', to: 'NewName' } },
  timestamp: new Date()
});
```

---

## Future Enhancements

### Two-Factor Authentication (2FA)

The system is designed for future 2FA integration:

- `twoFactorEnabled` field exists in response
- When implemented, sensitive operations (password change, email change) will require 2FA verification
- Extension point ready in service layer

### Pricing Plans

Notification preferences are already structured for plan-based enablement:

```typescript
if (vendor.plan === 'pro' || vendor.plan === 'enterprise') {
  VendorConfig.ENABLE_WHATSAPP_NOTIFICATIONS = true;
}
```

### Session Management

Password change currently logs intent to invalidate sessions. Future implementation:

- Store sessions in Redis with `vendor:{vendorId}:sessions` key
- On password change, delete all sessions
- Force re-authentication on next request

---

## Error Codes Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | Request body failed validation |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT token |
| `FORBIDDEN` | 403 | Insufficient permissions or business rule violation |
| `NOT_FOUND` | 404 | Vendor profile not found |
| `CONFLICT` | 409 | Optimistic locking version mismatch |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Security Best Practices

1. **Always use HTTPS** in production
2. **Store JWT tokens securely** (httpOnly cookies or secure storage)
3. **Never log sensitive data** (passwords, tokens)
4. **Implement rate limiting** on password change endpoint
5. **Monitor for suspicious patterns** (rapid email changes, failed password attempts)
6. **Rotate JWT secrets** periodically
7. **Implement session timeout** for inactive users

---

## Example Workflows

### Update Display Name

```bash
# 1. Get current profile
curl -X GET https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Response: { "data": { "version": 5, ... } }

# 2. Update display name
curl -X PATCH https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "displayName": "My New Business Name",
    "version": 5
  }'
```

### Change Password

```bash
curl -X PATCH https://api.example.com/api/vendor/profile/password \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "oldPassword": "OldSecureP@ss123",
    "newPassword": "NewSecureP@ss456!"
  }'
```

### Enable Email Notifications

```bash
curl -X PATCH https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "notificationPreferences": 
    {
      "email": true
    },
    "version": 5
  }'
```

### Change Payout Details (post-onboarding, from Settings)

Onboarding is already complete, so `PUT /onboarding/basic-setup` would return `409`. Edit via the profile endpoint instead. Send the **complete** payout array (full replace):

```bash
# 1. Read current version
curl -X GET https://api.example.com/api/vendor/profile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
# Response: { "data": { "version": 7, ... } }

# 2. Replace payout details
curl -X PATCH https://api.example.com/api/vendor/profile \
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
          "account_name": "Tech Solutions Sarl",
          "country": "CM"
        }
      }
    ],
    "version": 7
  }'
```
