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

- Success: `{ "success": true, "message": ... }` — this endpoint sends **no `data` key**, unlike
  most of the API.
- Failure: `{ "success": false, "requestId": "...", "error": { "code", "message", "statusCode", "category", "details"? } }` — see [errors/README.md](../errors/README.md).

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
  "message": "Password updated successfully. All other sessions have been signed out."
}
```

The response also carries **`Set-Cookie` for both `access_token` and `refresh_token`**. The
change invalidates every token minted under the old password — including the pair this
request arrived with — so the caller is handed a replacement pair and stays signed in. Every
*other* session is signed out on its next request. A client that discards cookies from this
response will find itself logged out.

### Error Responses

**Validation Error (400)** — `newPassword` fails the strength policy or a field is missing:

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "statusCode": 400,
    "category": "validation",
    "details": {
      "fields": [
        {
          "path": "newPassword",
          "message": "Password must contain at least one uppercase letter",
          "code": "invalid_string"
        }
      ]
    }
  }
}
```

> `details.fields[]` is an **array inside a `fields` key**, and each entry uses **`path`**, not
> `field` — the platform-wide Zod projection. See [errors/README.md](../errors/README.md).

**Incorrect Old Password (403)** — `USER_INVALID_PASSWORD`:

```json
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "USER_INVALID_PASSWORD",
    "message": "Current password is incorrect",
    "statusCode": 403,
    "category": "authorization"
  }
}
```

### Notes

- **Password Verification**: The old password must be correct before the new password is set.
- **Audit & Events**: The change emits a `user.password.changed` domain event and writes a `PASSWORD_CHANGED` audit-log entry.
- **Session Invalidation**: Every session issued under the old password ends. Tokens here are
  stateless, so the revocation is a per-account instant stamped alongside the new hash: any
  access **or** refresh token minted before it is refused with `401 AUTH_PASSWORD_CHANGED`,
  on every authenticated request and on every refresh. A stolen 30-day refresh cookie stops
  working — that is the point of the change.
- **Your own session survives**, via the replacement cookie pair above. No other session gets
  one.
- **What clients must do**: treat `AUTH_PASSWORD_CHANGED` as terminal — do not retry, do not
  attempt a refresh (the refresh cookie is refused by the same rule). Clear local state and
  send the user to sign-in, showing the message: to someone who did not change their own
  password, it is the first sign that somebody else did.

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
