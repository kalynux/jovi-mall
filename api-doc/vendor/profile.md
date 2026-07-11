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
    "branding": {
      "logo": {
        "id": "507f1f77bcf86cd799439030",
        "key": "vendors/logo-abc123.png",
        "url": "https://cdn.example.com/vendors/logo-abc123.png",
        "mimeType": "image/png",
        "size": 24576,
        "originalName": "logo.png"
      },
      "coverImage": null
    },
    "businessAddresses": [
      {
        "_id": "683abc1234567890abcdef02",
        "label": "Main Office",
        "address_line1": "123 Commerce Ave, Akwa",
        "address_line2": "Suite 4B",
        "city": "Douala",
        "state": "Littoral",
        "location": null
      }
    ],
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

> [!IMPORTANT]
> **Each `businessAddresses[]` entry is identified by `_id`, not `id`.** Unlike the outer profile
> object (which is remapped to `id`), address subdocuments are passed through as-is, so they keep
> Mongoose's default `_id` key. Use this `_id` value as `vendorAddressId` when setting a physical
> product's pickup location (`PATCH /api/vendor/products/:id`, `delivery.pickupLocation.vendorAddressId`
> — see [Vendor Products — Update Product](./products.md#update-product)).
>
> **UX guidance**: don't show this `_id` to the vendor. Render the address picker using `label`
> (and `address_line1`/`city` for disambiguation if two addresses share a label), and submit the
> matching `_id` as the value under the hood — the same pattern as any labeled-option/select
> control (display text ≠ submitted value).

> [!IMPORTANT]
> **`branding.logo` / `branding.coverImage` are populated file objects, not URLs.** This mirrors
> product media (see [Vendor Product Upload Reference — Media Handling](./product-upload-flow.md#media-handling)):
> the vendor uploads the image via `POST /api/files/upload` and gets back a file `id`; that `id` is
> what gets submitted (as `branding.logo_file_id` / `branding.cover_image_file_id`) via `PATCH
> /api/vendor/profile` or the onboarding branding step. Reads always resolve the stored file
> reference into `{ id, key, url, mimeType, size, originalName }`, or `null` if that slot is unset.

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
> **One exception:** the default delivery agency (onboarding Step 2) is **not** editable through this endpoint — use the dedicated [`PUT /api/vendor/profile/default-delivery-agency`](#put-apivendorprofiledefault-delivery-agency) route documented below. There is no route to clear it — vendors can only change it to a different agency (see that section for why).

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
  "branding": {
    "logo_file_id": "507f1f77bcf86cd799439030",
    "cover_image_file_id": "507f1f77bcf86cd799439031"
  },
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
| `branding` | `object` | `logo_file_id`, `cover_image_file_id` — MongoDB ObjectIds of files uploaded via `POST /api/files/upload`, or `null` | Step 3 (Branding) | Full replace — send both sub-fields, including the one unchanged, or it's cleared. See [Step 3 field reference](./onboarding.md#step-3-branding-optional--skippable). |
| `business_addresses` | `object[]` | See onboarding sub-schema | Step 3 (Branding) | Full replace — **include each existing address's `_id`** (from the `GET` response) to preserve its identity, or a fresh id is generated (and the "old" one is treated as removed — see below). See [Step 3 field reference](./onboarding.md#step-3-branding-optional--skippable). |
| `operating_hours` | `object[]` | Per-day `{ day, open_time "HH:MM", close_time "HH:MM", is_closed }` | — (general) | Full replace. |
| `policies` | `object \| null` | `{ return_policy?, cancellation_policy?, support_policy?, documents? }` (sub-policies nullable) | Step 4 (Policy Setup) | Full replace of the **whole** `policies` object — include every sub-policy you want to keep. `documents` (max 2 URLs) is cleared if omitted. See [Step 4 field reference](./onboarding.md#step-4-policy-setup-optional--skippable). |
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
    "branding": {
      "logo": {
        "id": "507f1f77bcf86cd799439030",
        "key": "vendors/logo-abc123.png",
        "url": "https://cdn.example.com/vendors/logo-abc123.png",
        "mimeType": "image/png",
        "size": 24576,
        "originalName": "logo.png"
      },
      "coverImage": {
        "id": "507f1f77bcf86cd799439031",
        "key": "vendors/cover-def456.jpg",
        "url": "https://cdn.example.com/vendors/cover-def456.jpg",
        "mimeType": "image/jpeg",
        "size": 184320,
        "originalName": "cover.jpg"
      }
    },
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
- **Full-replace semantics**: `payout_details`, `business_addresses`, `operating_hours`, `branding`, `social_links`, and `policies` overwrite the stored value wholesale. Always send the complete desired value, not a delta. For `business_addresses` specifically, echo back each entry's `_id` to preserve its identity — see the note above and [Update Product](./products.md#update-product) for why this matters to pickup locations.
- **Removing an in-use business address is blocked, not applied.** If the array you send omits (or regenerates the id of) an address that's still set as one or more physical products' `delivery.pickupLocation`, the **entire** `business_addresses` update is rejected with `409 VENDOR_BUSINESS_ADDRESS_IN_USE` — nothing is partially saved. `error.details.blockedAddresses` lists each such address with how many products reference it:
  ```json
  {
    "success": false,
    "error": {
      "code": "VENDOR_BUSINESS_ADDRESS_IN_USE",
      "message": "One or more business addresses you removed are still set as a pickup location on a product. Reassign or remove that pickup location first.",
      "details": {
        "blockedAddresses": [
          { "addressId": "683abc1234567890abcdef02", "label": "Main Shop", "productCount": 3 }
        ]
      }
    }
  }
  ```
  Reassign or clear those products' `delivery.pickupLocation` first (`PATCH /api/vendor/products/:id` — see [Update Product](./products.md#update-product)), then retry the address removal.
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

> [!NOTE]
> This may return a non-null agency **even if you never called the `PUT` endpoint below** —
> the vendor's first-ever approved [agency connection](./agency-connections.md) is automatically
> set as their default. Onboarding Step 2 (`PUT /api/vendor/onboarding/delivery-linking`) no
> longer sets this directly; see [Onboarding](./onboarding.md#step-2-delivery-linking-optional--skippable).

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

Set or update the authenticated vendor's default delivery agency outside the onboarding flow. Not
needed for your very first agency — see the auto-assignment note below.

> [!IMPORTANT]
> **You don't need to call this for your first agency.** The vendor's first-ever approved
> [connection](./agency-connections.md) is set as the default automatically, no call needed. Use
> this endpoint to *switch* between multiple active contracts afterward.
>
> **Vendors can change their default agency but can never clear it to null.** There is no `DELETE` route. A vendor's default only becomes unset if the underlying agency itself is deactivated by an admin — see [Admin: Delivery Agencies](../admin/delivery-agencies.md).
>
> **Switching to an active agency restores suspended products.** If the vendor's physical products were suspended because their previous default agency was deactivated, switching to a different **active** agency here immediately restores every one of those products to its own saved prior status (draft → draft, active → active, etc.). Switching to a `pending_verification` agency is accepted as a valid choice but does **not** restore anything yet, since a pending agency doesn't satisfy the physical-product activation gate.
>
> **Also auto-reassigns in-flight orders.** Any of the vendor's order items that are still `pending`/`assigned` (not yet picked up) and were riding on the *old* default agency are automatically moved to the new one — same effect as calling the item-level reassignment endpoint for each. An item is skipped (left on the old agency) if its **product** has its own explicit delivery-agency override, since that item was never really "on the default" in the first place. Items already `picked_up` or later are never touched. See `meta.reassignedOrderItems` / `meta.skippedOrderItems` in the response below.
>
> **Requires an active, approved connection with the agency.** You can no longer set any active agency as your default — only one you've sent (or received and accepted) a connection request with, and which is currently `active` (not pending, rejected, or paused for reapproval). Browse agencies and send/manage requests via [Agency Connections](./agency-connections.md). Attempting to set an agency without an active connection returns `422 CONNECTION_NOT_ACTIVE`.

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
  "meta": {
    "reassignedOrderItems": 2,
    "skippedOrderItems": [
      {
        "orderId": "665f000000000000000000aa",
        "itemId": "665f000000000000000000bb",
        "reason": "Product has its own delivery agency override"
      }
    ]
  },
  "message": "Default delivery agency updated successfully. 2 pending order item(s) reassigned to the new agency."
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

**No Active Connection (422)**:
Returned if you don't have an `active` connection with this agency (never requested, still `pending`, `rejected`, or `paused_reapproval`).
```json
{
  "success": false,
  "error": {
    "code": "CONNECTION_NOT_ACTIVE",
    "message": "You need an active, approved connection with this agency before setting it as your default. Send or check your connection request first."
  }
}
```

---

## Order Automation Settings

Per-vendor automation toggles stored on the vendor settings document. Created lazily
on first read/write, so defaults apply until a vendor changes them.

### GET /api/vendor/profile/auto-redirect-orders

Returns whether paid physical orders auto-dispatch to the agency in charge, plus the
optional max-order-total cap.

#### Authentication

- **Required**: Yes
- **Role**: `vendor`

#### Response

**Success (200 OK)**:
```json
{
  "success": true,
  "data": {
    "autoRedirectOrdersToAgency": false,
    "autoRedirectThresholdAmount": null
  }
}
```

- `autoRedirectOrdersToAgency` *(boolean)* — when `true`, a paid physical order's
  shipments advance `pending → assigned` automatically. Default `false`.
- `autoRedirectThresholdAmount` *(number | null)* — max order `total_amount` (in the
  order's own currency) for which auto-redirect applies. Orders above this cap stay
  `pending` for manual dispatch even when the toggle is on. `null` (default) = no cap.

### PUT /api/vendor/profile/auto-redirect-orders

Enable/disable auto-dispatch and optionally set the cap.

#### Request Body

```json
{
  "enabled": true,
  "thresholdAmount": 50000
}
```

- `enabled` *(boolean, required)*.
- `thresholdAmount` *(number ≥ 0 | null, optional)* — omit to leave the existing cap
  unchanged; send `null` to clear it (no cap); send a number to set the cap.

#### Response

**Success (200 OK)**:
```json
{
  "success": true,
  "data": {
    "autoRedirectOrdersToAgency": true,
    "autoRedirectThresholdAmount": 50000
  },
  "message": "Auto-redirect orders setting updated"
}
```

### GET /api/vendor/profile/auto-cancel-unpaid-days

Returns the number of days an order may remain unpaid before a daily background sweep
auto-cancels it (sets `fulfillment_status='cancelled'`, `payment_status='failed'`, and
notifies via the `order.cancelled` event).

#### Response

**Success (200 OK)**:
```json
{
  "success": true,
  "data": { "autoCancelUnpaidDays": 3 }
}
```

- `autoCancelUnpaidDays` *(number)* — default `3`.

### PUT /api/vendor/profile/auto-cancel-unpaid-days

Set the unpaid-order auto-cancel window.

#### Request Body

```json
{ "days": 5 }
```

- `days` *(integer, required)* — minimum `1` (cannot be `0`), maximum `90`.

#### Response

**Success (200 OK)**:
```json
{
  "success": true,
  "data": { "autoCancelUnpaidDays": 5 },
  "message": "Auto-cancel unpaid orders setting updated"
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
