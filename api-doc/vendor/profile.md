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

Update the authenticated vendor's profile.

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
  "displayName": "TechSolutions",
  "email": "newemail@example.com",
  "phone": "+237698765432",
  "notificationPreferences": {
    "email": true,
    "whatsapp": false,
    "phone": false
  },
  "version": 3
}
```

**Fields**:

- `displayName` (optional, string, 2-100 chars): User-facing display name
- `email` (optional, string, valid email): Vendor email address
- `phone` (optional, string, 8-20 chars): Vendor phone number
- `notificationPreferences` (optional, object):
  - `email` (optional, boolean): Enable/disable email notifications
  - `whatsapp` (optional, boolean): Enable/disable WhatsApp notifications (feature-flagged)
  - `phone` (optional, boolean): Enable/disable phone notifications (feature-flagged)
- `version` (**required**, number): Current profile version for optimistic locking

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
