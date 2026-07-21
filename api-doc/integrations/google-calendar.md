# Google Calendar Integration (OAuth)

Connect a user's Google Calendar via OAuth 2.0 so calendar-backed features (e.g. vendor booking
availability) can sync. Any authenticated user can connect; it is most relevant to **vendors**.

- **Base path**: `/api/integrations/google`
- **Auth**: Required — **browser cookie auth** (`access_token` cookie). The connect/callback flow is a
  browser redirect chain, so it relies on the cookie, not a `Bearer` header.
- **Response envelope**: JSON responses use the standard `{ success, data, message? }`. The
  connect/callback endpoints are **redirects** (302), not JSON — see below.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/integrations/google/connect` | required (cookie) | Redirect to Google's consent screen |
| `GET` | `/integrations/google/callback` | required (cookie) | OAuth callback → stores tokens → redirects back to the app |
| `GET` | `/integrations/google/status` | required | Is a Google Calendar connected? |
| `POST` | `/integrations/google/disconnect` | required | Disconnect the account |
| `GET` | `/integrations/google/test` | required | Test the connection (lists calendars) |

### Connect flow (frontend)

```
1. Navigate the browser to  GET /api/integrations/google/connect
      → 302 redirect to Google's consent screen.
2. User approves. Google redirects to /api/integrations/google/callback?code=...&state=...
      → server exchanges the code, stores tokens, then:
        • if GOOGLE_OAUTH_FRONTEND_REDIRECT_URL is set → 302 back to it with a result query string
          (e.g. ?calendar=connected   or   ?calendar=error&reason=<reason>)
        • else → JSON { success:true, data:null, message:"Google Calendar connected successfully" }
3. Read the query string on your redirect page to show success/error.
```

> **Use a full-page navigation**, not `fetch`, for `/connect` — it is a redirect to Google. Cookies must
> be sent (same-site), so the flow works from the app origin.

---

## GET `/integrations/google/connect`

**Purpose**: Begin OAuth. Generates a signed `state` (CSRF protection, bound to the user id) and
redirects to Google's consent URL.

**Auth**: Required (cookie) · **Response**: `302` redirect to Google.

---

## GET `/integrations/google/callback`

**Purpose**: Handle Google's redirect. Verifies `state` matches the authenticated user, exchanges
`code` for tokens, stores the connected account (and the vendor link if the user is a vendor).

**Auth**: Required (cookie) · **Query**: `code` (string), `state` (string).

**On success**: redirects to `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL?calendar=connected` when configured;
otherwise responds `{ success: true, data: null, message: "Google Calendar connected successfully" }`.

**On failure**: redirects with `?calendar=error&reason=<reason>` when a frontend URL is configured;
otherwise returns the JSON error envelope. `reason` values:

| `reason` | Cause | JSON error code (no-redirect fallback) |
|---|---|---|
| `missing_code` | No `code` query param | `VALIDATION_ERROR` (400) |
| `missing_state` | No `state` query param | `AUTH_OAUTH_STATE_INVALID` (400) |
| `state_mismatch` | `state` user ≠ authenticated user | `AUTH_OAUTH_STATE_INVALID` (403) |
| `invalid_state` | `state` invalid/expired | `AUTH_OAUTH_STATE_EXPIRED` (403) |
| `connection_failed` | Token exchange / storage failed | (rethrown; 5xx envelope) |

---

## GET `/integrations/google/status`

**Purpose**: Report whether the caller has a connected Google Calendar.

**Auth**: Required

### Example success `200` (connected)

```json
{ "success": true, "data": { "connected": true, "email": "jane@gmail.com", "expiresAt": "2026-08-01T00:00:00.000Z" } }
```

### Example success `200` (not connected)

```json
{ "success": true, "data": { "connected": false } }
```

---

## POST `/integrations/google/disconnect`

**Purpose**: Disconnect the caller's Google Calendar (revokes/removes the stored account).

**Auth**: Required

### Example success `200`

```json
{ "success": true, "data": null, "message": "Disconnected successfully" }
```

---

## GET `/integrations/google/test`

**Purpose**: Verify the stored connection works by attempting to list the user's calendars.

**Auth**: Required

### Example success `200`

```json
{ "success": true, "data": { "ok": true } }
```

### Errors

| Status | `error.code` | When |
|---|---|---|
| 401 | `AUTH_MISSING_TOKEN` | Not authenticated |
| 500 | `INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER` | Connection test failed |

## Environment

| Var | Purpose |
|---|---|
| `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL` | Where the callback redirects the browser back to (with `?calendar=...`). If unset, the callback returns JSON instead of redirecting. |

## Related
- [../vendor/calendar.md](../vendor/calendar.md) · [../vendor/bookings.md](../vendor/bookings.md) · [../vendor/availability-rules.md](../vendor/availability-rules.md)
- [../auth/README.md](../auth/README.md) — cookie auth
