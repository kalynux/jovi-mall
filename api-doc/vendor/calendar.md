# Vendor Google Calendar Connection

How a vendor connects their Google Calendar, inspects what was granted, and disconnects. This is part of the **service product / booking** setup.

> **Booking system docs:** [Implementation guide](../booking-implementation-guide.md) · [Service product setup](./products.md#service-products) · [Availability rules](./availability-rules.md) · **Google Calendar connection** (this doc) · [Vendor booking management](./bookings.md) · [Customer booking flow](../customer/bookings.md)

---

## Why connect a calendar?

| Capability | Calendar required? |
|------------|--------------------|
| Fetch available slots (`GET /api/products/:id/availability`) | **No** — works from availability rules alone. Without a connected calendar the vendor's external busy times are simply not subtracted, so slots reflect only the configured rules. |
| Create a booking (`POST /api/products/:id/book`) | **Yes** — booking creation writes an event to the vendor's Google Calendar. Without a connection this step fails. |
| Accurate availability (busy times blocked) | **Recommended** — connecting lets the system subtract the vendor's existing Google events from offered slots. |

**Bottom line:** connect the calendar during service-product setup, before customers book.

---

## Authentication

All endpoints require an authenticated vendor session. `requireAuth` accepts either the `access_token` httpOnly cookie (preferred, browser) or `Authorization: Bearer <token>` (API/mobile fallback).

> [!IMPORTANT]
> The **connect** step is a browser redirect / OAuth flow — not a JSON API call. It must run in the browser so it can carry the session cookie and follow redirects to Google's consent screen. See [Connect](#connect-google-calendar) below.

---

## Requested Permissions (OAuth scopes)

When the vendor connects, Google asks them to approve these scopes:

| Scope | What it allows |
|-------|----------------|
| `https://www.googleapis.com/auth/calendar` | Read, create, and delete events on the vendor's Google Calendar (read busy times; write booking events) |
| `https://www.googleapis.com/auth/userinfo.email` | View the Google account email address |
| `https://www.googleapis.com/auth/userinfo.profile` | View basic Google profile info |

Offline access is requested (`access_type=offline`, `prompt=consent`) so the backend receives a refresh token and can keep the connection alive.

---

## Connect Google Calendar

There are two entry points; both end at the same OAuth flow.

### Recommended: start the OAuth flow

```http
GET /api/integrations/google/connect
```

Navigate the **browser** to this URL (e.g. `window.location.href = '/api/integrations/google/connect'`). The backend generates a signed CSRF `state` and redirects to Google's consent screen. After the vendor approves, Google redirects back to the callback below.

> The vendor convenience wrapper `POST /api/vendor/calendar/connect` simply 302-redirects to `GET /api/integrations/google/connect`. Because it relies on a browser redirect, prefer navigating the browser directly to the `GET` URL rather than calling it with `fetch`.

### OAuth callback (handled by Google → backend → frontend)

```http
GET /api/integrations/google/callback?code=...&state=...
```

The vendor's browser is redirected here by Google. The backend validates `state`, exchanges the `code`, and stores the encrypted tokens + granted scope against the vendor.

**Where the browser lands next depends on `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL`:**

When that env var is set (e.g. `http://localhost:5173/dashboard/services`), the backend **302-redirects the browser back to the frontend** with a result query string — so the frontend owns the landing UX:

| Outcome | Redirect |
|---------|----------|
| Success | `…/dashboard/services?calendar=connected` |
| Missing `code` | `…?calendar=error&reason=missing_code` |
| Missing `state` | `…?calendar=error&reason=missing_state` |
| `state` user mismatch | `…?calendar=error&reason=state_mismatch` |
| Invalid/expired `state` | `…?calendar=error&reason=invalid_state` |
| Token exchange failed | `…?calendar=error&reason=connection_failed` |

The frontend should read `calendar` / `reason` on its landing route, then call `GET /api/vendor/calendar/status` to refresh the panel.

**Fallback (env var unset):** the callback returns JSON on success (`{ "success": true, "message": "Google Calendar connected successfully" }`) and structured errors on failure — `400 VALIDATION_ERROR` (missing code), `400/403 AUTH_OAUTH_STATE_INVALID` (missing/mismatched state), `403 AUTH_OAUTH_STATE_EXPIRED` (invalid/expired state).

---

## Connection Status

```http
GET /api/vendor/calendar/status
```

Returns whether the vendor has a connected calendar, the connected email, and the permissions they granted. Use this to render the "Calendar connected as …" panel.

**Response — connected:** `200 OK`

```json
{
  "success": true,
  "data": {
    "connected": true,
    "provider": "google",
    "email": "vendor@gmail.com",
    "calendarId": "primary",
    "permissions": [
      { "scope": "https://www.googleapis.com/auth/calendar", "description": "Read, create, and delete events on your Google Calendar" },
      { "scope": "https://www.googleapis.com/auth/userinfo.email", "description": "View your Google account email address" },
      { "scope": "https://www.googleapis.com/auth/userinfo.profile", "description": "View your basic Google profile info" }
    ],
    "requiresReauth": false,
    "lastSyncAt": "2026-02-09T23:54:00.000Z",
    "expiresAt": "2026-02-10T00:54:00.000Z"
  }
}
```

**Response — not connected:** `200 OK`

```json
{
  "success": true,
  "data": {
    "connected": false,
    "provider": null,
    "email": null,
    "calendarId": null,
    "permissions": [],
    "requiresReauth": false,
    "lastSyncAt": null,
    "expiresAt": null
  }
}
```

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `connected` | boolean | Whether a Google Calendar is linked |
| `provider` | `"google"` \| null | Calendar provider |
| `email` | string \| null | The Google account the calendar belongs to |
| `calendarId` | string \| null | Target calendar (defaults to `primary`) |
| `permissions` | array | Granted OAuth scopes, each with a human-readable `description` |
| `requiresReauth` | boolean | `true` if access was revoked or token refresh failed — the vendor must reconnect |
| `lastSyncAt` | ISO datetime \| null | When the connection record was last updated |
| `expiresAt` | ISO datetime \| null | Current access-token expiry (auto-refreshed using the stored refresh token) |

> [!NOTE]
> `expiresAt` is the short-lived access-token expiry and is refreshed automatically; it does **not** mean the connection drops. Watch `requiresReauth` instead — when `true`, prompt the vendor to reconnect.

---

## Disconnect Google Calendar

```http
POST /api/vendor/calendar/disconnect
```

Removes the vendor's stored Google Calendar connection.

**Response:** `200 OK`

```json
{ "success": true, "message": "Google Calendar disconnected successfully" }
```

**Error Responses:**

- `401 AUTH_MISSING_TOKEN`: No authenticated user on the request

---

## Recommended setup sequence

1. **Connect Google Calendar** — navigate the browser to `GET /api/integrations/google/connect`; confirm with `GET /api/vendor/calendar/status`.
2. **Create the service product** with `serviceConfig` — see [products.md](./products.md#service-products).
3. **Add availability rules** and activate them — see [availability-rules.md](./availability-rules.md).
4. Customers can now fetch slots, lock, book, and pay — see [customer/bookings.md](../customer/bookings.md).
