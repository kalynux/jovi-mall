# Vendor Google Calendar Connection

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–28). Corrections are marked inline with ⚠ and a source citation.

How a vendor connects their Google Calendar, inspects what was granted, and disconnects. This is part of the **service product / booking** setup.

> **Booking system docs:** [Implementation guide](../booking-implementation-guide.md) · [Service product setup](./products.md#service-products) · [Availability rules](./availability-rules.md) · **Google Calendar connection** (this doc) · [Vendor booking management](./bookings.md) · [Customer booking flow](../customer/bookings.md)

---

## Why connect a calendar?

| Capability | Calendar required? |
|------------|--------------------|
| Fetch available slots (`GET /api/products/:id/availability`) | **No** — works from availability rules alone. Without a connected calendar the vendor's external busy times are simply not subtracted, so slots reflect only the configured rules. |
| Create a booking (`POST /api/products/:id/book`) | **No** — the booking is committed first and the calendar event is mirrored afterwards, best-effort. A vendor with no calendar connected still sells correctly. |
| Accurate availability (busy times blocked) | **Recommended** — connecting lets the system subtract the vendor's existing Google events from offered slots. |

> ⚠ **This row said "**Yes** — … Without a connection this step fails" until 2026-09-06, and it
> was false in the direction that costs a sale.** The calendar write is **Step 5, after the
> commit, inside a `try`** (`booking.service.ts:130-135`), and a vendor with no calendar
> connected is caught by name and logged as a warning — *"Booking … created without a calendar
> event"* (`:158-162`). Nothing is rolled back and no error reaches the customer.
>
> **The reason it is safe to be best-effort is worth knowing before anyone "restores" the
> coupling:** availability derives this product's own occupancy from the **booking rows**, not
> from the calendar (same comment, `:134-135`). The calendar only ever *adds* the vendor's other
> commitments on top. Make the booking depend on the write again and a Google outage starts
> rejecting confirmed sales.

**Bottom line:** connect the calendar during service-product setup — not because booking needs
it, but because without it the vendor's *other* commitments are invisible and the platform will
happily book over them.

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
| Invalid/expired `state` | `…?calendar=error&reason=invalid_state` |
| **Vendor pressed Cancel on Google's consent screen** | `…?calendar=error&reason=access_denied` |
| Token exchange failed, or any other Google error | `…?calendar=error&reason=connection_failed` |

> ⚠ **Two corrections here, 2026-09-06.** `state_mismatch` was listed and **is unreachable** —
> the callback carries no session to disagree with, and the source says so at
> `google.routes.ts:189-191`: *"there is no second identity to disagree with. Callers may keep
> the string; nothing emits it."* A client branching on it never matched.
>
> And **`access_denied` was missing**, which is the one a vendor actually hits: Google reports a
> refusal as `?error=access_denied` with no code, and it is mapped to itself deliberately
> (`:226-228`) rather than falling through to `missing_code` — *"which tells someone who just
> pressed Cancel that Google failed to send a code: true, and useless."* Treat it as "the vendor
> changed their mind", not as an error to report.

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

## Per-product calendar status

```http
GET /api/vendor/products/:id/service/calendar-status
```

The same connection, answered **in the context of one service product**, so a product editor can
prompt for a calendar without a second lookup of which product it is talking about. Auth:
`vendor`; the product must belong to the caller.

> ⚠ **Do not render this as "this service cannot take bookings until you connect a calendar"** —
> that sentence was suggested here until 2026-09-06 and it is **false**, for the reason in
> § "Why connect a calendar?" above: booking creation is committed before the calendar is touched
> and succeeds without one (`booking.service.ts:130-135`). Prompt with what is actually true —
> *"connect a calendar so we don't book over your other commitments"*.
>
> ⚠ **The route's own source comment calls this endpoint a STUB returning a "placeholder
> response"** (`vendor-products.routes.ts:545-546`). It is not: `VendorServiceCalendarController`
> reads the real `ConnectedCalendarAccount`, which is what the shapes below describe. The comment
> is stale and is **documented rather than edited** here — but do not let it persuade you the
> endpoint is unfinished.

**Response — connected:** `200 OK`

```json
{
  "success": true,
  "data": {
    "connected": true,
    "provider": "google",
    "calendarEmail": "vendor@gmail.com",
    "lastSyncAt": "2026-02-09T23:54:00.000Z",
    "expiresAt": "2026-02-10T00:54:00.000Z",
    "syncStatus": "connected"
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
    "lastSyncAt": null,
    "expiresAt": null,
    "syncStatus": "not_connected"
  }
}
```

> ⚠ **The two branches do not carry the same key.** Connected returns **`calendarEmail`**; not
> connected returns **`email: null`**. There is no `calendarId` and no `permissions` here — read
> `GET /api/vendor/calendar/status` above for those. The connection itself is per **vendor**, not
> per product, so this endpoint's only product-specific behaviour is its two guards.

**Errors:**

| `error.code` | Status | When |
|---|---|---|
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | Unknown product, or not this vendor's |
| `CATALOG_BOOKING_INVALID_PRODUCT_TYPE` | 400 | The product's `type` is not `service` |

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
