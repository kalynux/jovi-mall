# Change Password API

Reference for changing the authenticated user's **account password**.

> [!IMPORTANT]
> This is a **shared, role-agnostic** API mounted at `/api/me/password`. The **same endpoint, request body, and responses** work for **every** authenticated role (customer, vendor, admin, agent, agency). The account is resolved from the auth token — the password lives on the **User** record, not on any role entity, so there is exactly one password per account regardless of role.

---

## Authentication

Requires a valid access token (any authenticated role).

```
Authorization: Bearer <access_token>
```

The token may also be supplied via the `access_token` httpOnly cookie (browser clients).

All responses use the standard envelope:

- Success: `{ "success": true, "message": ... }`
- Failure: `{ "success": false, "requestId": "...", "error": { "code", "message", "statusCode", "details"? } }` — see [errors/README.md](../errors/README.md).

---

## PATCH /api/me/password

Change the authenticated user's password.

### Request Body

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

### Response

**Success (200 OK)**:

```json
{
  "success": true,
  "message": "Password updated successfully."
}
```

### Error Responses

**Validation Error (400)** — `newPassword` fails the strength policy or a field is missing:

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

**Incorrect Old Password (403)** — `USER_INVALID_PASSWORD`:

```json
{
  "success": false,
  "error": {
    "code": "USER_INVALID_PASSWORD",
    "message": "Current password is incorrect",
    "statusCode": 403
  }
}
```

### Notes

- **Password Verification**: The old password must be correct before the new password is set.
- **Audit & Events**: The change emits a `user.password.changed` domain event and writes a `PASSWORD_CHANGED` audit-log entry.
- **Session Invalidation**: Not yet implemented — existing sessions stay valid after a change (future work will invalidate them).

---

## Legacy alias

`PATCH /api/vendor/profile/password` (vendor role only) is a **deprecated alias** kept for existing vendor frontends. It routes to the exact same handler. New integrations should use `/api/me/password` for every role.

### Example

```bash
curl -X PATCH https://api.example.com/api/me/password \
  -H "Authorization: Bearer <access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "oldPassword": "OldSecureP@ss123",
    "newPassword": "NewSecureP@ss456!"
  }'
```
