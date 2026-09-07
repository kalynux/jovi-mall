# Google Calendar Integration (OAuth)

Connect a user's Google Calendar via OAuth 2.0 so calendar-backed features (e.g. vendor booking
availability) can sync. Any authenticated user can connect; it is most relevant to **vendors**.

- **Base path**: `/api/integrations/google`
- **Auth**: `/connect` is **browser cookie auth** (it is a redirect chain started by the browser).
  `/connect-url`, `/status`, `/disconnect` and `/test` accept **either** transport — `requireAuth`
  prefers the `Authorization: Bearer` header over the cookie. **`/callback` is unauthenticated**;
  see below.
- **Response envelope**: JSON responses use the standard `{ success, data, message? }`. The
  connect/callback endpoints are **redirects** (302), not JSON — see below.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/integrations/google/connect` | required (cookie) | Redirect to Google's consent screen |
| `POST` | `/integrations/google/connect-url` | required (cookie **or** bearer) | Return the consent URL as JSON, for a caller that cannot be redirected |
| `GET` | `/integrations/google/callback` | **none** — the signed `state` is the credential | OAuth callback → stores tokens → redirects back to the caller |
| `GET` | `/integrations/google/status` | required | Is a Google Calendar connected? |
| `POST` | `/integrations/google/disconnect` | required | Disconnect the account |
| `GET` | `/integrations/google/test` | required | Test the connection (lists calendars) |

### Connect flow — web (unchanged)

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

### Connect flow — packaged app (Capacitor)

A native shell cannot use `/connect`: it authenticates with a bearer token so there is no cookie to
read, and **it must not load the consent screen in its own WebView** — Google refuses OAuth in an
embedded WebView with `disallowed_useragent`, and spoofing the user agent violates the OAuth policy.

```
1. POST /api/integrations/google/connect-url   { "returnTo": "wivendor://services/calendar" }
      → { success:true, data:{ url: "https://accounts.google.com/o/oauth2/v2/auth?..." } }
2. Open that url in a SYSTEM browser tab over the app
      (Chrome Custom Tab / SFSafariViewController — @capacitor/browser).
3. User approves. Google → /api/integrations/google/callback?code=...&state=...
      → server exchanges the code, stores tokens, then 302s to the returnTo carried in the state:
            wivendor://services/calendar?calendar=connected
      → the OS hands that to the app; close the browser tab and route to the screen.
```

`returnTo` is **optional**; omit it and the callback falls back to `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL`
exactly as the web flow does. It is validated when the state is minted — a value that is neither a
scheme listed in `GOOGLE_OAUTH_APP_SCHEMES` nor same-origin with `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL`
is rejected `400 VALIDATION_ERROR` *before* the user is sent to Google — and re-validated when it is
consumed. Between the two it travels inside the signed state, so it cannot be edited in transit.

> ⚠ **Configure `GOOGLE_OAUTH_APP_SCHEMES` per environment.** Unset, every native connect attempt is
> refused with a 400 and the web flow is unaffected.

---

## GET `/integrations/google/connect`

**Purpose**: Begin OAuth. Generates a signed `state` (CSRF protection, bound to the user id) and
redirects to Google's consent URL.

**Auth**: Required (cookie) · **Response**: `302` redirect to Google.

---

## POST `/integrations/google/connect-url`

**Purpose**: Return the Google consent URL as JSON instead of redirecting to it, so a caller with no
browser to navigate — a packaged app — can open it in a system browser tab and name where the result
should be handed back.

**Auth**: Required (cookie **or** bearer) · **Body**: `{ "returnTo"?: string }`

### Example success `200`

```json
{ "success": true, "data": { "url": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&state=…" } }
```

### Errors

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `returnTo` is not an allowed redirect target (see `GOOGLE_OAUTH_APP_SCHEMES`) |
| 401 | `AUTH_MISSING_TOKEN` | No session |

---

## GET `/integrations/google/callback`

**Purpose**: Handle Google's redirect. Verifies the signed `state`, exchanges `code` for tokens,
stores the connected account (and the vendor link if the user is a vendor).

**Auth**: **None.** · **Query**: `code` (string), `state` (string), `error` (string, from Google).

> **Why no auth.** The `state` is a JWT this service signed, bound to the user id and expiring in five
> minutes — it is what identifies the user, and it always was: the old cookie check was a second
> opinion about a fact the state had already established. It also cannot survive a packaged app, whose
> consent screen opens in a browser tab that does not share the app's session — the callback would
> 401 *after* the user had approved, which is the worst possible place to fail.
>
> Consequence: **`state_mismatch` is unreachable** and nothing emits it. Clients may keep the string.

**On success**: redirects to `<returnTo>?calendar=connected`, falling back to
`GOOGLE_OAUTH_FRONTEND_REDIRECT_URL` when the state carries no `returnTo`; otherwise responds
`{ success: true, data: null, message: "Google Calendar connected successfully" }`.

**On failure**: redirects with `?calendar=error&reason=<reason>` when there is somewhere to send the
user; otherwise returns the JSON error envelope. The state is verified **first**, before anything
else is checked, so every failure below it still lands the caller back where it started rather than
stranding a phone on the web dashboard. `reason` values:

| `reason` | Cause | JSON error code (no-redirect fallback) |
|---|---|---|
| `missing_state` | No `state` query param | `AUTH_OAUTH_STATE_INVALID` (400) |
| `invalid_state` | `state` invalid/expired | `AUTH_OAUTH_STATE_EXPIRED` (403) |
| `access_denied` | The user refused consent (Google sends `?error=access_denied`) | `VALIDATION_ERROR` (400) |
| `missing_code` | No `code` query param and no `error` either | `VALIDATION_ERROR` (400) |
| `connection_failed` | Token exchange / storage failed, or an unrecognised Google `error` | (rethrown; 5xx envelope) |
| ~~`state_mismatch`~~ | **No longer emitted** — there is no second identity to disagree with | — |

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

> ⚠ **`ok` is never `false` — do not branch on it.** `testConnection` lists one calendar and
> returns the literal `true`; any failure **throws** (`google.provider.ts:143-150`). So a `200`
> always carries `ok: true`, and a client's `if (!data.ok)` branch is dead code. **The status is
> the answer**, not the boolean.

### Errors

| Status | `error.code` | When |
|---|---|---|
| 401 | `AUTH_MISSING_TOKEN` | Not authenticated |
| 500 | `INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER` | **Every** failure, including "not connected" — see below |

> ⚠ **A vendor who has never connected gets a 500 here, not a 400, and the reason is lost.**
> `getAuthenticatedClient` raises `400 GOOGLE_CALENDAR_NOT_CONNECTED`
> (`google.provider.ts:158-160`), but this route's `catch` re-wraps **everything** as
> `INTEGRATION_UNSUPPORTED_CALENDAR_PROVIDER` at 500 (`google.routes.ts:308-310`). Two
> consequences:
>
> - The route passes `error.message` through, but 500 derives category **`internal`**, so the
>   boundary **replaces the message with the registry default and drops `details`** — in every
>   environment. The original *"Google Calendar is not connected"* never reaches the client.
> - So `/test` cannot distinguish "not connected" from "connected but broken". **Read
>   `GET /integrations/google/status` first** — that is the endpoint that answers the first
>   question, and it answers it without calling Google.
>
> This is a backend defect **documented, not fixed** (DOC-PROGRAM § 28): narrowing the catch is
> a behavioural change to a live route and outside this documentation program's remit.

## Environment

| Var | Purpose |
|---|---|
| `GOOGLE_OAUTH_FRONTEND_REDIRECT_URL` | Where the callback redirects the browser back to (with `?calendar=...`). If unset, the callback returns JSON instead of redirecting. |

## Related
- [../vendor/calendar.md](../vendor/calendar.md) · [../vendor/bookings.md](../vendor/bookings.md) · [../vendor/availability-rules.md](../vendor/availability-rules.md)
- [../auth/README.md](../auth/README.md) — cookie auth
