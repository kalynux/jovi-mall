# Auth API

## Base URL

```
http://localhost:8022/api
```

> All paths below are relative to `/api`.

---

## Overview

The auth system handles user registration, login, token management, and account verification. Authentication is **role-based** — every user has one or more roles (`vendor`, `customer`, `agency`, `agent`, `admin`), and all JWTs are scoped to a **single active role** at a time.

> ## ✅ Closed (2026-08-14) — `POST /auth/login` checks the password again
>
> For a period `auth.service.ts` computed `bcrypt.compare(...)` and **threw the result
> away**: any password authenticated any account, for every role. The throw is restored,
> deliberately with **no environment escape hatch** — a bypass whose failure direction is
> "open on a typo" is what the environment validator exists to argue against.
>
> Everything downstream was always sound — the password-epoch revocation, the suspension
> checks, the credential rate limit — and was simply being bypassed at the front door.
>
> **If a seed, fixture or dev account relied on "any password works", it needs a real
> password now.** `npm run test:mobile-auth` asserts the check is enforced and that no
> environment variable can disable it.

### Session Strategy: two delivery modes, one session model

The tokens are the same everywhere — same claims, same lifetimes, same secrets, same
revocation. Only **delivery** differs, and it is chosen by the route namespace, never by a
header:

| Namespace | Delivery | For |
|---|---|---|
| `/auth/*` | two **HttpOnly cookies** | browsers |
| `/auth/browser/*` | the same two cookies | OAuth redirect flows needing a stable login URL |
| `/auth/mobile/*` | a **`tokens` object in the response body** | native / WebView clients that cannot use a cookie |

See [Mobile namespace](#mobile-namespace--bearer-clients) below.

On every successful login or registration **through the cookie namespaces**, the server sets
**two HttpOnly cookies**:

| Cookie | TTL | Purpose |
|--------|-----|---------|
| `access_token` | 15 min | Authenticates requests |
| `refresh_token` | 30 days | Issues new access tokens without re-login |

Both cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. **On `/auth/*` and
`/auth/browser/*`, tokens are never returned in the response body** — only `/auth/mobile/*`
returns them, and it sets no cookie at all.

The cookie `max-age` and the token's own `exp` are derived from the *same* two constants
(`core/auth/token.issuer.ts`), so a cookie can never outlive or predecease the token inside it.

---

## Response Envelope

> **⚠️ Breaking change (2026-07-17):** auth responses are now wrapped in the platform-standard
> success envelope. Payloads that were previously returned at the top level (`{ user, role, role_entity }`)
> are now nested under `data`.

Every **success** response on this service uses:

```json
{ "success": true, "data": <payload>, "meta": { "...": "pagination or summary" }, "message": "optional note" }
```

- `data` always holds the payload (object, array, or `null`).
- `meta` appears only on paginated/list responses (`{ total, page, limit, pages }`).
- `message` is an optional human-readable note.

Every **error** response uses the mirror shape:

```json
{ "success": false, "requestId": "req_abc", "error": { "code": "AUTH_INVALID_CREDENTIALS", "message": "Invalid credentials", "statusCode": 401, "category": "authentication", "details": {} } }
```

`error.category` is always present — one of nine values. See [errors/README.md](../errors/README.md).

Read `data` for the body, `error.code` for programmatic handling. All examples below show the full envelope.

---

## Frontend Integration

All fetch/axios calls **must** include credentials to send cookies:

```js
// fetch
fetch('/api/auth/me', { credentials: 'include' });

// axios (set globally once)
axios.defaults.withCredentials = true;
```

All POST endpoints require `Content-Type: application/json`.

---

## Roles

| Role | Has Onboarding? | Notes |
|------|----------------|-------|
| `customer` | ❌ No | `onboarding_step` is always `0` |
| `vendor` | ✅ Yes — 4 steps (`PUT` per step) | Must complete before accessing dashboard |
| `agency` | ✅ Yes — init + 4 steps (`PUT` per step) | Must complete before accessing dashboard |
| `agent` | ✅ Yes — 2 steps (one `PATCH …/step`) | Must complete before accessing dashboard |
| `admin` | ❌ No | `onboarding_step` is always `0` |

A user can hold **multiple roles** and log in under any of them independently.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | Public | Register a new account |
| `POST` | `/auth/login` | Public | Log in and set auth cookies |
| `POST` | `/auth/logout` | Public | Clear both auth cookies |
| `GET` | `/auth/me` | Required | Get current user (lightweight) |
| `GET` | `/auth/auth-me/:role` | Required | Restore session + re-issue cookies |
| `POST` | `/auth/add-role` | Required | Add a second role to an existing account |
| `POST` | `/auth/send-email-verification` | Required | Send email verification link |
| `GET` | `/auth/verify-email` | Public | Confirm email via token link |
| `POST` | `/auth/forgot-password` | Public | Start a password reset. **Always answers 200** |
| `POST` | `/auth/reset-password` | Public | Redeem a reset token and set a new password |
| `POST` | `/auth/browser/login` | Public | Browser-namespace login (JSON only) — see below |
| `POST` | `/auth/browser/refresh` | Public (cookie) | Explicitly issue a new access token from the refresh cookie |
| `POST` | `/auth/browser/logout` | Public | Browser-namespace logout (JSON only) |
| `POST` | `/auth/mobile/login` | Public | Log in, **tokens in the body**, no cookies |
| `POST` | `/auth/mobile/register` | Public | Register, tokens in the body |
| `POST` | `/auth/mobile/refresh` | Public (body) | Exchange a refresh token for a **fresh pair** |
| `GET` | `/auth/mobile/auth-me/:role` | Required | Restore session + a fresh pair |
| `POST` | `/auth/mobile/add-role` | Required | Add a role + a pair scoped to it |
| `POST` | `/auth/magic/link` | Public | Redeem a magic link — **passwordless customer sign-in** |
| `POST` | `/auth/magic/code` | Public | Redeem an 8-character sign-in code with a phone or email |

There is **no** `POST /auth/refresh` or `/auth/verify-code` on this service, and no
`/auth/mobile/logout`; the table above is the complete auth surface
(`src/modules/auth/auth.routes.ts` + `routes/browser-auth.routes.ts` +
`routes/mobile-auth.routes.ts` + `modules/messaging-login/messaging-login.routes.ts`).

> ### ⚠ Customers sign in through the bot, not through this form
>
> `/auth/magic/*` redeems the two credentials a customer gets by sending **`/login`** to the
> WhatsApp or Telegram bot. It is not a convenience — it is the **primary customer sign-in
> path**, because customers are registered with a system-generated password that is never
> disclosed to them.
>
> So `POST /auth/login` will **always fail for a customer who has never run a password reset**,
> and `POST /auth/register` no longer requires `password` for `role: "customer"` (and ignores
> one if sent). Every other role is unchanged.
>
> Full contract, including the Telegram contact-share step and the deliberately
> undifferentiated error codes: **[magic-login.md](./magic-login.md)**.

> ### Password reset has a bot entrance too, for EVERY role
>
> Sending **`/reset-password`** to the WhatsApp or Telegram bot replies with the same link
> `POST /auth/forgot-password` sends by email and WhatsApp — same token, same 30 minutes, same
> single use, redeemed by the same `POST /auth/reset-password`. It is a new *entrance*, not a
> second mechanism.
>
> Unlike `/login`, it serves **vendors, agencies and agents as well as customers**: a password
> belongs to the account, not to a role. It is therefore the only self-service recovery a vendor
> or agency has from a chat, and the way a passwordless customer acquires a real password.
> See [magic-login.md](./magic-login.md#reset-password--a-reset-link-from-a-chat-any-role).

> **`POST /auth/request-wa-verification` was removed.** It minted a code the user carried to
> the WhatsApp bot. Connecting a messaging account is no longer an auth concern at all — it is
> `POST /api/me/connections`, the bot mints the code, and it covers Telegram too. See
> [../connections/README.md](../connections/README.md).

---

## Password reset

Added 2026-08-14. Before it there was no recovery path at all: `PATCH /api/me/password`
requires the **old** password, and the only other way to change a login identifier is an
admin-only route on the internal service surface — so a forgotten password was a permanent
lockout.

### POST `/auth/forgot-password`

```json
{ "identifier": "jane@example.com" }
```

`identifier` is an email address or an E.164 phone number, normalised exactly as `/auth/login`
normalises it.

**Always answers `200` with the same body**, whether or not the account exists:

```json
{ "success": true, "data": null, "message": "If that account exists, a password reset link has been sent." }
```

> **⚠️ Do not treat any part of this response as a signal about whether an account exists.**
> The uniformity is deliberate: any observable difference — a 404, a different message, a
> suspended-account error — turns this endpoint into an account-enumeration oracle. Feed it a
> list of phone numbers and learn which ones bank here. A suspended account is also answered
> with the same 200 and no email.
>
> A malformed identifier *is* still a `400`. That leaks nothing: it says the **input** is not
> a well-formed address or number, which the caller can see for themselves.

**Delivery is over email *and* WhatsApp** when both identifiers are on file. WhatsApp matters
here: `phone` is the required registration field and `email` is optional, so an email-only
reset would be undeliverable for a large share of this audience.

The link points at `STOREFRONT_URL/reset-password?token=…` — the **storefront**, not this API,
because a reset needs a form for the new password and only the frontend has one. (Contrast
email verification, whose link is a `GET` this service answers directly.)

The token lives **30 minutes** and is single-use.

### POST `/auth/reset-password`

```json
{ "token": "…64 hex…", "newPassword": "Str0ng!Pass" }
```

`newPassword` must satisfy the shared strength rule: **8+ characters with an uppercase, a
lowercase, a digit and a symbol** — the same `PasswordStrengthSchema`
`PATCH /api/me/password` uses.

> ⚠️ That is deliberately **stricter than `POST /auth/register`**, which still accepts 6
> characters with no complexity rule. The two disagree, and this is the right side of the
> disagreement: raising registration is a breaking change for existing clients and is out of
> scope, but a new password set through a new endpoint has no back-compat debt.

**Success `200`** — `{ "success": true, "data": null, "message": "Your password has been reset…" }`

> **It does not sign you in.** The link arrives by email or WhatsApp, either of which may be
> read on a device that is not the one asking — issuing a session on redemption would hand it
> to whoever opened the message. Sign in with the new password through `/auth/login`.

> **It revokes every other session.** The write stamps `password_changed_at`, and any token
> issued before that instant is refused with `401 AUTH_PASSWORD_CHANGED` on both the access
> and refresh paths. That is the point of a reset after a compromise.

| `error.code` | Status | When |
|---|---|---|
| `AUTH_RESET_TOKEN_INVALID` | 400 | Token absent, expired, malformed **or already spent** — deliberately one code for all four, so the response cannot confirm whether a token was ever real |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | The account was suspended between the request and the redemption |
| `VALIDATION_ERROR` | 400 | `newPassword` fails the strength rule |

Both endpoints inherit the credential bucket below (20/min/IP).

> **The `/auth/browser/*` trio is a parallel namespace, not a different session model.** It
> exists so OAuth redirect flows have a stable browser login URL; it issues the *same* two JWT
> cookies as `/auth/login`. All three require `Content-Type: application/json`
> (`requireJsonContent`, a CSRF mitigation) and answer `400 VALIDATION_ERROR —
> "Bad Request: Only JSON content is accepted"` otherwise. `POST /auth/browser/login` takes the
> same body as `/auth/login` and returns a **smaller** payload —
> `{ user: { id, email, role } }` only, with no `role_entity`. Use `/auth/login` unless you are
> specifically in an OAuth redirect flow.

### Rate limiting

The `/auth` prefix — all three routers — sits behind **two** IP-scoped buckets, chosen per path
and applied before authentication:

| Bucket | Limit | Paths |
|---|---|---|
| **credential** | **20/min/IP** | everything that presents a credential: `login`, `register`, `forgot-password`, `reset-password`, `add-role`, the verification routes, and the `browser`/`mobile` login + register twins. **The default** — a route added here later inherits it |
| **session** | **300/min/IP** | everything that merely extends a session you already hold: `/auth/me`, `/auth/auth-me/:role`, `/auth/mobile/auth-me/:role`, `/auth/browser/refresh`, `/auth/mobile/refresh` |

Exactly one of the two applies per request. The credential number is the strictest in the
service and is a security control, not a backstop; the session number is a backstop, and
Layer A (1200/IP) plus Layer B (600–1200/user) still apply on top of both.

> ⚠ **On an *authenticated* route, `RateLimit: remaining=…` describes Layer B, not the bucket
> above.** Layer B is attached at the tail of `requireAuth`, so it writes its headers last and
> overwrites whatever ran before it. On `GET /auth/me` as a customer you will therefore read
> `RateLimit-Policy: 600;w=60` — the per-*user* ceiling — even though the 300/IP session bucket
> also counted the request. This is not new to the split (Layer A has always been overwritten
> the same way); it is worth knowing because the header you can read is the per-user one, and it
> is usually the one you would want. On an unauthenticated route (`login`, `mobile/refresh`) the
> header is the IP bucket, because Layer B never runs.

See [rate-limits.md](../rate-limits.md).

---

## POST `/auth/register`

Creates a new user and a role profile in one step. Sets both auth cookies on success.

**Auth**: Public

### Request Body

```json
{
  "phone": "+2348012345678",
  "password": "secret123",
  "name": "John Doe",
  "role": "vendor",
  "email": "john@example.com",
  "business_name": "John's Shop",
  "agency_name": "Fast Riders"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | ✅ | **E.164, with the `+` and country code** (`+2348012345678`). Used as login identifier. Must be unique. Stored canonicalised — formatting you send (spaces, dashes, parentheses) is stripped. See [Contact formats](../README.md#contact-formats-phone--email). |
| `password` | string | **conditionally** | Min 6 characters. **Required for every role EXCEPT `customer`** — see the note below. |
| `name` | string | ✅ | Min 2 characters. Used for all roles. |
| `role` | string | ✅ | One of: `customer`, `vendor`, `agency`, `agent`. Defaults to `vendor`. |
| `email` | string | ❌ | Required for `vendor`. Must be unique. Validated and **lowercased** — see [Contact formats](../README.md#contact-formats-phone--email). |
| `business_name` | string | ❌ | For `vendor` role. Falls back to `name`. |
| `agency_name` | string | ❌ | For `agency` role. Falls back to `name`. |

> **Customer registration**: only `phone`, `name`, and `role: "customer"` are needed.

> ### ⚠ A customer's `password` is not required, and is IGNORED if sent
>
> Customers are passwordless in practice — they sign in through **`/login`** on WhatsApp or
> Telegram ([magic-login.md](./magic-login.md)). The account is created with a
> system-generated password that is hashed and disclosed to nobody, so `User.password_hash`
> stays satisfied and the reset flow has something to replace.
>
> The field is **stripped**, not merely optional: honouring a caller-supplied password would
> create accounts whose password somebody else chose and knows. A client that still sends one
> gets a normal `201` — it simply will not work at `POST /auth/login`.
>
> **Nothing changed for `vendor`, `agency` or `agent`**: a body omitting `password` for any of
> them is still a `400`, and `role` still defaults to `vendor`, so an old body with no `role`
> and no `password` is refused exactly as before.
>
> A customer who wants a real password uses `POST /auth/forgot-password`, which delivers over
> email **and** WhatsApp.

### Response `201`

Sets cookies `access_token` and `refresh_token`.

```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "664abc...",
      "login_phone": "+2348012345678",
      "login_email": "john@example.com",
      "roles": ["vendor"],
      "status": "active"
    },
    "role": "vendor",
    "role_entity": {
      "_id": "664def...",
      "user_id": "664abc...",
      "business_name": "John's Shop",
      "email": "john@example.com",
      "phone": "+2348012345678",
      "email_verified": false,
      "phone_verified": false,
      "onboarding_step": 1,
      "status": "pending_verification"
    }
  }
}
```

> `data.role_entity.onboarding_step` tells you where to redirect. See [Onboarding Flow](#onboarding-flow) below.
>
> No tokens in response body.

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `400` | `User with this phone already exists` | Phone already registered |
| `400` | `User with this email already exists` | Email already registered |
| `400` | `Validation Error` | Missing/invalid fields |

---

## POST `/auth/login`

Authenticates and sets role-scoped JWT cookies.

**Auth**: Public

### Request Body

```json
{
  "identifier": "+2348012345678",
  "password": "secret123",
  "role": "vendor"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `identifier` | string | ✅ | Phone number **in E.164** (`+2348012345678`) or email address. Whichever it is, it must be valid — see [Contact formats](../README.md#contact-formats-phone--email). |
| `password` | string | ✅ | Account password |
| `role` | string | ❌ | Required if the user has multiple roles. |

> If the user only has one role, `role` can be omitted — it will be resolved automatically.

> **Note:** the identifier is normalised before lookup (emails lowercased, phone formatting
> stripped), so `Ada@Example.COM` and `+234 801 234 5678` both resolve. A phone identifier that is
> not E.164 is rejected with `VALIDATION_ERROR` rather than failing as bad credentials.

### Response `200`

Sets cookies `access_token` and `refresh_token`.

```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "664abc...",
      "login_phone": "+2348012345678",
      "roles": ["vendor", "customer"],
      "status": "active"
    },
    "role": "vendor",
    "role_entity": {
      "_id": "664def...",
      "business_name": "John's Shop",
      "onboarding_step": 1,
      "status": "pending_verification"
    }
  }
}
```

> Check `data.role_entity.onboarding_step` to determine where to redirect the user. See [Post-Login Routing](#post-login--registration-routing).

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `401` | `Invalid credentials` | Wrong phone/email or password |
| `401` | `Role selection required` | User has multiple roles, `role` not specified |
| `401` | `User does not have this role` | Requested role not on account |

---

## POST `/auth/logout`

Clears both auth cookies. Always succeeds — safe to call even when not logged in.

**Auth**: Public

### Request Body

None.

### Response `200`

```json
{
  "success": true,
  "data": null,
  "message": "Logged out successfully"
}
```

---

## POST `/auth/browser/refresh`

Issues a new `access_token` cookie using the `refresh_token` cookie.

> **Note:** There is **no** `POST /auth/refresh` on the main auth router. Three refresh paths exist:
> 1. **Automatic (recommended for cookie clients):** `requireAuth` performs a *silent refresh*
>    from the `refresh_token` **cookie** whenever the access token is missing or expired,
>    transparently re-issuing the access cookie — so browser clients rarely refresh explicitly.
>    It fires on a **cookie** or on no credential at all; it deliberately will **not** fire for a
>    caller who presented an expired `Authorization: Bearer` (see below).
> 2. **Explicit, cookie:** `POST /auth/browser/refresh` (this endpoint), for clients that want to
>    refresh proactively. Re-issues the **access cookie only**.
> 3. **Explicit, bearer:** [`POST /auth/mobile/refresh`](#post-authmobilerefresh), which takes the
>    refresh token in the body and returns a **fresh pair**.

> ⚠️ **A bearer caller with an expired access token gets `401 AUTH_TOKEN_EXPIRED`, never a
> silent refresh** — even if a `refresh_token` cookie happens to be attached. Refreshing from an
> ambient cookie would authenticate the request as whoever that cookie belongs to while the
> client kept sending its own expired token, which is a bug that is close to undiagnosable from
> the client side. Bearer clients refresh explicitly, through path 3. (Earlier revisions of this
> page said bearer callers "must re-login on expiry"; that stopped being true when
> `/auth/mobile/refresh` shipped.)

**Auth**: Public (uses `refresh_token` cookie automatically)

### Request Body

None.

### Response `200`

Sets a new `access_token` cookie.

```json
{
  "success": true,
  "data": { "user": { "id": "664abc...", "role": "vendor" } },
  "message": "Access token refreshed"
}
```

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `401` | `Invalid or expired refresh token` | Token missing or expired |

---

## Mobile namespace — bearer clients

`/auth/mobile/*` exists for clients that **cannot hold a cookie**. Two things are true of a
Capacitor / React Native WebView at once, and neither is fixable client-side:

1. Its origin is `capacitor://localhost` (iOS) or `https://localhost` (Android), so a cookie
   for the API host is a **third-party cookie** and is blocked by default.
2. `Set-Cookie` is a **forbidden response-header name** in the Fetch standard — stripped from
   every `Response.headers` object in every engine — so it cannot scrape the token out of the
   response the way a native HTTP client (the agent app's Dio stack) can.

**There is no client-type header.** The namespace *is* the switch. Nothing about your request
selects a mode, so a browser's behaviour cannot change by accident and there is no extra header
to add to a CORS allow-list.

### What is the same

Everything except delivery. Same `AuthService`, same claims, same secrets, same 15-minute /
30-day lifetimes, same error codes, same password-epoch revocation, same suspension checks. A
rule added to login or role resolution applies to both namespaces without anyone remembering to.

### What is different

- The pair comes back as `data.tokens`.
- **No cookie is set.** Not a smaller one, not a redundant one — none.
- `Content-Type: application/json` is **not** required (the browser namespace's
  `requireJsonContent` is a CSRF mitigation, and there is no ambient credential here to forge
  with). Send JSON anyway; the body parser expects it.
- There is **no `/auth/mobile/logout`**. Discard the tokens locally. `POST /auth/logout` also
  works and is a harmless no-op for you.

### The `tokens` object

```jsonc
{
  "success": true,
  "data": {
    "user":        { "...": "identical to the cookie endpoint" },
    "role":        "agency",
    "role_entity": { "...": "identical to the cookie endpoint" },
    "tokens": {
      "accessToken":      "eyJhbGciOi...",
      "refreshToken":     "eyJhbGciOi...",
      "accessExpiresIn":  900,
      "refreshExpiresIn": 2592000
    }
  }
}
```

`accessExpiresIn` / `refreshExpiresIn` are **seconds**, and they are the exact values passed to
`jwt.sign` as `expiresIn` — not a second reading of the same configuration. Refresh
**proactively** off them (≈60s before `accessExpiresIn` elapses) rather than waiting for a 401;
it costs fewer requests against the rate limiter and avoids a user-visible stall.

### Storage

Store both in the **iOS Keychain / Android Keystore**, never plain preferences. Refresh tokens
are stateless JWTs with no revocation store, so a stolen one stays valid until it expires or
the account's password changes. See [Known limitation](#known-limitation) below.

---

### POST `/auth/mobile/login`

Same body as [`POST /auth/login`](#post-authlogin). **`200`** with `tokens` added, no cookies.

### POST `/auth/mobile/register`

Same body as [`POST /auth/register`](#post-authregister). **`201`** with `tokens` added.

### GET `/auth/mobile/auth-me/:role`

**Auth**: Required (bearer). Same payload as [`GET /auth/auth-me/:role`](#get-authauth-merole),
plus `tokens`.

> **Do not skip this one.** It is the only endpoint that re-issues **both** tokens for an
> already-signed-in caller, which is what restarts the 30-day window on app launch. Without it,
> `refreshExpiresIn` counts down from the last password entry regardless of how much the app is
> used. `POST /auth/mobile/refresh` also slides the window, so calling either is enough — but
> `auth-me` is the one that also returns fresh profile state.

### POST `/auth/mobile/add-role`

**Auth**: Required (bearer). Same body as [`POST /auth/add-role`](#post-authadd-role).
**`201`**, and the returned pair is scoped to the **newly added** role — replace your stored
tokens with it or the next request is still scoped to the old role.

### POST `/auth/mobile/refresh`

**Auth**: Public — the refresh token *is* the credential.

```jsonc
{ "refreshToken": "eyJhbGciOi..." }
```

**Response `200`**

```jsonc
{ "success": true, "data": { "tokens": { "accessToken": "...", "refreshToken": "...",
                                         "accessExpiresIn": 900, "refreshExpiresIn": 2592000 } } }
```

**It returns a fresh pair, not just an access token** — unlike `/auth/browser/refresh`. Because
refresh tokens are stateless with no server-side store, minting a new one does not invalidate
the old one, so there is no rotation window to get wrong. Every refresh therefore **slides the
30-day window**, and an actively-used session never hard-expires.

**Replace both stored tokens on every refresh.** Keeping the old refresh token still works
(the old one is not invalidated), but you lose the sliding window, which is the point.

> ⚠ **A JWT's `iat` is in whole seconds**, so two mints in the same second for the same
> `{userId, role}` are **byte-identical**. Log in and immediately refresh, and the "new" access
> token can equal the old string. It is a correct, valid token either way — but never use "did
> the token string change?" as the signal that a refresh succeeded. Use the HTTP status.

#### Errors — the client behaves differently for each

| `error.code` | Status | What it means | Do |
|---|---|---|---|
| `AUTH_MISSING_TOKEN` | 401 | No `refreshToken` in the body | Sign out |
| `AUTH_REFRESH_TOKEN_INVALID` | 401 | Malformed, wrong signature, **or an *access* token posted here** (the `type: "refresh"` claim is checked) | Sign out. If you see this in development, check you are not sending the wrong half of the pair |
| `AUTH_SESSION_EXPIRED` | 401 | The refresh token's own 30 days elapsed | Sign out, prompt login |
| `AUTH_PASSWORD_CHANGED` | 401 | The account's password changed after this token was minted | Sign out **immediately, and do not retry** — every token you hold is refused by the same rule. Worth surfacing verbatim: for someone who did not change their password, it is the first sign that somebody else did |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | The account was suspended | Sign out, show the reason |
| `AUTH_USER_NOT_FOUND` | 401 | The account no longer exists | Sign out |

#### Maintenance windows

This route is **exempt from `readonly` maintenance** and blocked in `down`. It mints a token
and writes nothing, and it is a bearer client's only renewal path — a cookie client renews
inside an ordinary GET, so without the exemption a read-only window would sign out every native
client fifteen minutes in while browsers carried on.

---

## GET `/auth/me`

Returns the current user with the active role and its role entity.

**Auth**: Required

### Response `200`

```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "664abc...",
      "login_phone": "+2348012345678",
      "roles": ["vendor"],
      "status": "active"
    },
    "role": "vendor",
    "role_entity": { "_id": "664def...", "business_name": "John's Shop", "onboarding_step": 0 }
  }
}
```

---

## GET `/auth/auth-me/:role`

Re-authenticates and returns full user + role entity + fresh cookies. **Use on app launch to restore session state.**

**Auth**: Required

**URL Params**: `:role` — the role to load the entity for.

### Response `200`

Sets fresh `access_token` and `refresh_token` cookies.

```json
{
  "success": true,
  "data": {
    "user": { "_id": "...", "roles": ["vendor", "customer"], "..." : "..." },
    "role": "vendor",
    "role_entity": {
      "_id": "...",
      "business_name": "John's Shop",
      "onboarding_step": 1,
      "status": "pending_verification",
      "..." : "..."
    }
  }
}
```

> Check `data.role_entity.onboarding_step` to route to onboarding or dashboard.

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `401` | `Account not found` | userId in token no longer exists |
| `401` | `User does not have this role` | Role mismatch |

---

## POST `/auth/add-role`

Adds a second role to an **already authenticated** user. Sets cookies scoped to the newly added role.

**Auth**: Required

### Request Body

```json
{
  "role": "customer",
  "name": "John Doe"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `role` | string | ✅ | The new role to add |
| `name` | string | ❌ | For `customer`, `agent`, `admin` roles |
| `business_name` | string | ❌ | For `vendor` role |
| `agency_name` | string | ❌ | For `agency` role |

### Response `201`

Sets fresh cookies scoped to the **newly added role**.

```json
{
  "success": true,
  "data": {
    "user": { "_id": "...", "roles": ["vendor", "customer"], "..." : "..." },
    "role": "customer",
    "role_entity": { "_id": "...", "name": "John Doe", "onboarding_step": 0, "..." : "..." }
  }
}
```

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `400` | `User already has the 'customer' role` | Role already registered |
| `400` | `Validation Error` | Missing/invalid fields |
| `401` | `Unauthorized` | No valid token |

---

## POST `/auth/send-email-verification`

Sends a verification link to the email on the user's **current role entity**. Valid for **24 hours**.

**Auth**: Required

### Request Body

None. The `userId` and `role` are read from the JWT.

### Response `200`

```json
{ "success": true, "data": { "message": "Verification email sent" } }
```

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `400` | `Email already verified` | Already verified |
| `400` | `No email to verify` | Role entity has no email |
| `400` | `{role} profile not found` | Role entity missing |

---

## GET `/auth/verify-email`

Confirms the email address. Called automatically when the user clicks the verification link.

**Auth**: Public

### Query Parameters

| Param | Type | Required |
|-------|------|----------|
| `token` | string | ✅ |

**Example**: `GET /api/auth/verify-email?token=abc123def456...`

### Response `200`

```json
{ "success": true, "data": { "message": "Email verified successfully" } }
```

---

## POST `/auth/request-wa-verification`

Starts the WhatsApp phone verification flow.

**Auth**: Required

### Request Body

```json
{ "update_other_roles": false } // if set to true, it will auto update (verify) the whastsapp status of the other roles that are not verified
```

### Response `200`

```json
{
  "success": true,
  "data": {
    "code": "A1B2C3D4",
    "command": "/link:A1B2C3D4",
    "wa_link": "https://wa.me/234XXXXXXXXXX?text=%2Flink%3AA1B2C3D4",
    "expires_in_seconds": 600,
    "instructions": "Click the wa_link to verify your WhatsApp account automatically..."
  }
}
```

> `data.code` is 8 alpha-numeric characters.

---

## Post-Login / Registration Routing

After a successful login, registration, or `auth-me`, read `role_entity.onboarding_step` from the response:

```
onboarding_step === 0  →  Route to role dashboard
onboarding_step  > 0  →  Route to onboarding screen for that step
```

> **Customer and Admin** always return `onboarding_step: 0`. Route them directly to dashboard.

---

## Onboarding Flow

Onboarding is **field-presence driven**: every profile write recalculates `onboarding_step` from scratch. The server always reports the next incomplete step.

> **The three roles do NOT share one shape.** Vendor and agency use a **`PUT` per step**; only
> the agent has a single `PATCH …/onboarding/step` endpoint. The old
> `PATCH /api/vendor/onboarding/step` and `PATCH /api/agency/onboarding/step` were removed and
> no longer exist. This page is a summary — the field-by-field contracts are in
> [vendor/onboarding.md](../vendor/onboarding.md), [agency/onboarding.md](../agency/onboarding.md)
> and [agent/onboarding.md](../agent/onboarding.md).

### Vendor Onboarding — four `PUT` steps

**Auth**: Required (`vendor` role). Full contract: [vendor/onboarding.md](../vendor/onboarding.md).

| Step | Value | Label | Endpoint | Required? |
|------|-------|-------|----------|-----------|
| `BASIC_SETUP` | `1` | Basic Setup | `PUT /api/vendor/onboarding/basic-setup` | ✅ |
| `DELIVERY_LINKING` | `2` | Delivery Linking | `PUT /api/vendor/onboarding/delivery-linking` | skippable |
| `BRANDING` | `3` | Branding | `PUT /api/vendor/onboarding/branding` | skippable |
| `POLICY_SETUP` | `4` | Policy Setup | `PUT /api/vendor/onboarding/policy-setup` | skippable |
| `COMPLETED` | `0` | Done | — | — |

Reads: `GET /api/vendor/onboarding/status` (rich: `steps[]`, `progressPercent`, `completedFields`,
`warnings`) and `GET /api/vendor/profile/completion-status` (step + missing fields only).

> **Step 2 no longer selects an agency.** It is a plain step-advance. A default delivery agency
> requires the agency's consent and is set automatically when the first connection request is
> approved — see [vendor/agency-connections.md](../vendor/agency-connections.md). To browse
> agencies, use `GET /api/vendor/delivery-agencies` or
> `GET /api/vendor/agency-connections/browse`; there is no `GET /api/agency` listing endpoint.

Every `PUT` step accepts an optional `version` integer for optimistic concurrency
(`409 VENDOR_ONBOARDING_CONCURRENT_MODIFICATION` on a mismatch), and every one returns
`{ success, data: { profile, completionStatus } }`. Once `onboarding_step === 0`, all four
answer `409 VENDOR_ONBOARDING_ALREADY_COMPLETED` — edit via `PATCH /api/vendor/profile` instead.

---

### Customer Onboarding

**No onboarding flow.** `onboarding_step` is always `0`.

Route customers directly to the customer dashboard after login or registration.

Profile updates (name, avatar, bio, preferences, addresses, etc.) are handled through:

```
GET   /api/customer/profile
PATCH /api/customer/profile
```

---

### Agency Onboarding — an init call, then four `PUT` steps

**Auth**: Required (`agency` role). Full contract: [agency/onboarding.md](../agency/onboarding.md).

| Step | Value | Label | Endpoint | Required? |
|------|-------|-------|----------|-----------|
| Init | — | Agency Initialization | `POST /api/agency` | ✅ |
| `LOGISTICS_SETUP` | `1` | Logistics Setup | `PUT /api/agency/onboarding/logistics` | ✅ |
| `PAYOUT_SETUP` | `2` | Payout Setup | `PUT /api/agency/onboarding/payout` | ✅ |
| `BRANDING` | `3` | Branding | `PUT /api/agency/onboarding/branding` | skippable |
| `POLICY_SETUP` | `4` | Policy Setup | `PUT /api/agency/onboarding/policies` | ✅ |
| `COMPLETED` | `0` | Done | — | — |

Read: `GET /api/agency/onboarding/status`. Same `version` concurrency field, raising
`409 DELIVERY_ONBOARDING_CONCURRENT_MODIFICATION`.

---

### Agent Onboarding — one `PATCH`, two steps

**Base**: `PATCH /api/agent/onboarding/step` — the one role that still uses the single-endpoint
shape. **Auth**: Required (`agent` role). Full contract: [agent/onboarding.md](../agent/onboarding.md).

| Step | Value | Label | Body |
|------|-------|-------|------|
| `VEHICLE_SETUP` | `1` | Vehicle Setup | `{ step: 1, vehicle_info: { vehicle_type, color, plate_number?, photo_file_id? } }` |
| `IDENTITY_SETUP` | `2` | Identity (Optional) | `{ step: 2, skip?: true, avatar_url?, timezone? }` |
| `COMPLETED` | `0` | Done | — |

Read: `GET /api/agent/profile/completion-status`.

---

## `role_entity` Shapes

Below are the key fields returned in `role_entity` for each role. Some fields are omitted for brevity.

### Customer

```json
{
  "_id": "...",
  "user_id": "...",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+2348098765432",
  "email_verified": false,
  "phone_verified": false,
  "avatar": null,
  "bio": null,
  "saved_addresses": [],
  "preferences": {
    "language": "en",
    "currency": "XAF",
    "marketing_opt_in": false,
    "ai_tone": [],
    "ads_compact_mode": false,
    "compact_mode": false
  },
  "onboarding_step": 0,
  "status": "pending_verification"
}
```

### Vendor

```json
{
  "_id": "...",
  "user_id": "...",
  "business_name": "John's Shop",
  "display_name": null,
  "business_description": null,
  "email": "john@example.com",
  "phone": "+2348012345678",
  "email_verified": false,
  "phone_verified": false,
  "country": null,
  "timezone": "Africa/Douala",
  "branding": { "logo_file_id": null, "cover_image_file_id": null },
  "business_addresses": [],
  "payout_details": null,
  "kyc_details": { "national_id_number": null, "legit_verified": false },
  "social_links": { "instagram": null, "facebook": null, "twitter": null },
  "onboarding_step": 1,
  "status": "pending_verification"
}
```

> `onboarding_step: 1` on fresh registration — vendor must complete Basic Setup before accessing the dashboard.

---

## Token Details

### Access Token Payload

```json
{
  "userId": "664abc...",
  "role": "vendor",
  "iat": 1708000000,
  "exp": 1708000900
}
```

- Expiry: **15 minutes** (env: `AUTH_ACCESS_TOKEN_TTL`, in seconds)
- Signing: `HS256` with `JWT_SECRET`

### Refresh Token Payload

```json
{
  "userId": "664abc...",
  "role": "vendor",
  "type": "refresh",
  "iat": 1708000000,
  "exp": 1710592000
}
```

- Expiry: **30 days** (env: `AUTH_REFRESH_TOKEN_TTL`, in seconds)
- Signing: `HS256` with `JWT_REFRESH_SECRET` (falls back to `JWT_SECRET`)

### Revocation — `iat` is load-bearing

Both tokens are **stateless**: the server keeps no list of issued tokens, so there is nothing
to delete when a session must end. Changing the account password is what revokes them. The
change stamps a per-account instant, and **both** credential paths refuse any token whose
`iat` predates it:

| Path | Refuses with |
|---|---|
| every authenticated request (`requireAuth`, access token) | `401 AUTH_PASSWORD_CHANGED` |
| silent refresh and `POST /auth/browser/refresh` (refresh token) | `401 AUTH_PASSWORD_CHANGED` |

Practical consequences for a client:

- **Treat `AUTH_PASSWORD_CHANGED` as terminal.** Do not retry and do not attempt a refresh —
  the refresh cookie is refused by the same rule. Clear local state and send the user to
  sign-in. The message is worth surfacing verbatim: for someone who did *not* change their
  password, it is the first sign that somebody else did.
- The caller who performs the change **keeps their session** — `PATCH /api/me/password`
  returns a fresh cookie pair in the same response. See [me/password.md](../me/password.md).
- Everything else signs out on its next request: other browsers, other devices, and any
  bearer token that was minted earlier.

---

## Environment Variables

```
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret   # Optional, falls back to JWT_SECRET

AUTH_COOKIE_DOMAIN=.example.com          # Leave blank for localhost
AUTH_ACCESS_TOKEN_TTL=900                # 15 minutes in seconds
AUTH_REFRESH_TOKEN_TTL=2592000           # 30 days in seconds
```

---

## Complete Auth Flows

### Flow A — New Registration + Onboarding (Vendor)

```
1. POST /api/auth/register   { phone, password, name, role: "vendor", email, business_name }
      → Sets access_token + refresh_token cookies
      → Returns { user, role_entity }
      → role_entity.onboarding_step === 1 → route to onboarding

2. PUT /api/vendor/onboarding/basic-setup       { country, timezone, payout_details }
      → Returns { profile, completionStatus }
      → completionStatus.onboardingStep → 2

3. PUT /api/vendor/onboarding/delivery-linking  { }        (a plain step-advance)
      → completionStatus.onboardingStep → 3

4. PUT /api/vendor/onboarding/branding          { skip: true }  OR provide branding
      → completionStatus.onboardingStep → 4

5. PUT /api/vendor/onboarding/policy-setup      { skip: true }  OR provide policies
      → completionStatus.isComplete === true → route to vendor dashboard
```

### Flow B — New Registration (Customer)

```
1. POST /api/auth/register   { phone, password, name, role: "customer" }
      → Sets access_token + refresh_token cookies
      → role_entity.onboarding_step === 0 → route directly to customer dashboard
```

### Flow C — Login

```
1. POST /api/auth/login   { identifier, password, role }
      → Sets access_token + refresh_token cookies
      → Returns { user, role, role_entity }
      → Check role_entity.onboarding_step for routing
```

### Flow D — Restoring Session on App Launch

```
1. GET /api/auth/auth-me/:role   (using existing access_token cookie)
      → Refreshes both cookies
      → Returns { user, role, role_entity }
      → Check role_entity.onboarding_step for routing
```

### Flow E — Expired Access Token

```
Cookie clients (browsers, and any native client sending a refresh COOKIE):
  Refresh is AUTOMATIC — requireAuth silently refreshes from the refresh_token
  cookie and re-issues the access cookie. No explicit call needed.
  (To refresh proactively: POST /api/auth/browser/refresh — access token only)

Bearer clients (/auth/mobile/*):
  NO silent refresh — an expired bearer is answered 401 AUTH_TOKEN_EXPIRED even
  if a refresh cookie happens to be attached. Refresh explicitly:

    POST /api/auth/mobile/refresh   { refreshToken }
      → { tokens: { accessToken, refreshToken, accessExpiresIn, refreshExpiresIn } }
      → replace BOTH stored tokens; the 30-day window slides
      → 401 AUTH_SESSION_EXPIRED | AUTH_REFRESH_TOKEN_INVALID | AUTH_PASSWORD_CHANGED
        or 403 AUTH_ACCOUNT_SUSPENDED  → sign out

  Better: refresh PROACTIVELY, ~60s before accessExpiresIn elapses, and never
  see this flow at all.
```

### Flow E′ — Mobile app lifecycle, end to end

```
1. POST /api/auth/mobile/login  { identifier, password, role }
      → { user, role, role_entity, tokens }
      → store tokens in Keychain / Keystore

2. every request:  Authorization: Bearer <accessToken>
      (a stale cookie can no longer beat it — the bearer is read first)

3. ~60s before accessExpiresIn:  POST /api/auth/mobile/refresh { refreshToken }
      → replace both tokens

4. on app launch:  GET /api/auth/mobile/auth-me/:role
      → fresh profile state AND a fresh pair (restarts the 30-day window)

5. logout: discard the tokens. No server call is required.
```

### Flow F — Multi-Role Login / Role Switch

```
1. POST /api/auth/login   { identifier, password, role: "customer" }
      → Sets cookies scoped to "customer"

(to switch back to vendor:)
2. POST /api/auth/login   { identifier, password, role: "vendor" }
      → Overwrites cookies scoped to "vendor"
```

### Flow G — Adding a Second Role

```
1. POST /api/auth/add-role   { role: "customer", name: "John Doe" }
      → Creates customer profile for the logged-in user
      → Sets cookies scoped to "customer"
      → Returns { user, role: "customer", role_entity }
```

### Flow H — Logout

```
1. POST /api/auth/logout
      → Clears both cookies
      → Returns { success: true, data: null, message: "Logged out successfully" }
      → Redirect to login page

   Bearer clients: discard the tokens locally. Calling this is harmless but does
   nothing for you — there are no cookies to clear, and see below for why there
   is no server-side revocation to invoke.
```

---

## Known limitation

Tokens here are **stateless JWTs with no revocation store**, so there is nothing to delete when
a session must end. Consequences, stated plainly rather than left to be discovered:

- **A stolen refresh token stays valid until it expires.** Logging out does not revoke it —
  logging out only discards your own copy.
- **A password change is the only thing that kills one early**, via the `iat` epoch above. It
  is the correct remedy after a compromise, and it evicts every session on every device except
  the one performing the change.
- **For bearer clients the 30-day window is *sliding*, with no absolute cap.** Every
  `/auth/mobile/refresh` and every `auth-me` re-issues the refresh token at full lifetime, so
  an actively-used session never hard-expires — and neither does an actively-abused one. This
  is not new behaviour (`auth-me` has always re-issued both, and every client calls it on
  launch); the mobile namespace only makes it explicit. It is stated here so the trade is a
  shared decision rather than an assumption.

The mitigation that is in force is client-side: **store tokens in the iOS Keychain / Android
Keystore, never plain preferences.** If a server-side revocation store is wanted later, the
cheapest hook is `AuthService.rotateRefreshToken`, which already loads the user row on every
refresh — a `token_version` compared there would cost no extra query.
