# Auth API

## Base URL

```
http://localhost:8022/api
```

> All paths below are relative to `/api`.

---

## Overview

The auth system handles user registration, login, token management, and account verification. Authentication is **role-based** — every user has one or more roles (`vendor`, `customer`, `agency`, `agent`, `admin`), and all JWTs are scoped to a **single active role** at a time.

### Session Strategy: Two-Cookie JWT

On every successful login or registration, the server sets **two HttpOnly cookies**:

| Cookie | TTL | Purpose |
|--------|-----|---------|
| `access_token` | 15 min | Authenticates requests |
| `refresh_token` | 30 days | Issues new access tokens without re-login |

Both cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` in production. **Tokens are not returned in the response body.**

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
| `POST` | `/auth/request-wa-verification` | Required | Start WhatsApp phone verification |
| `POST` | `/auth/browser/login` | Public | Browser-namespace login (JSON only) — see below |
| `POST` | `/auth/browser/refresh` | Public (cookie) | Explicitly issue a new access token from the refresh cookie |
| `POST` | `/auth/browser/logout` | Public | Browser-namespace logout (JSON only) |

There is **no** `POST /auth/refresh`, `/auth/forgot-password`, `/auth/reset-password` or
`/auth/verify-code` on this service; the table above is the complete auth surface
(`src/modules/auth/auth.routes.ts` + `src/modules/auth/routes/browser-auth.routes.ts`).

> **The `/auth/browser/*` trio is a parallel namespace, not a different session model.** It
> exists so OAuth redirect flows have a stable browser login URL; it issues the *same* two JWT
> cookies as `/auth/login`. All three require `Content-Type: application/json`
> (`requireJsonContent`, a CSRF mitigation) and answer `400 VALIDATION_ERROR —
> "Bad Request: Only JSON content is accepted"` otherwise. `POST /auth/browser/login` takes the
> same body as `/auth/login` and returns a **smaller** payload —
> `{ user: { id, email, role } }` only, with no `role_entity`. Use `/auth/login` unless you are
> specifically in an OAuth redirect flow.

### Rate limiting

The whole `/auth` prefix — both routers — sits behind the **credential bucket**: 20 requests per
minute per IP, the strictest limit in the service, applied before authentication. It covers
login, registration, verification-code resend and the browser namespace alike. See
[rate-limits.md](../rate-limits.md).

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
| `password` | string | ✅ | Min 6 characters. |
| `name` | string | ✅ | Min 2 characters. Used for all roles. |
| `role` | string | ✅ | One of: `customer`, `vendor`, `agency`, `agent`. Defaults to `vendor`. |
| `email` | string | ❌ | Required for `vendor`. Must be unique. Validated and **lowercased** — see [Contact formats](../README.md#contact-formats-phone--email). |
| `business_name` | string | ❌ | For `vendor` role. Falls back to `name`. |
| `agency_name` | string | ❌ | For `agency` role. Falls back to `name`. |

> **Customer registration**: only `phone`, `password`, `name`, and `role: "customer"` are needed.

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

> **Note:** There is **no** `POST /auth/refresh` on the main auth router. Two refresh paths exist:
> 1. **Automatic (recommended):** `requireAuth` performs a *silent refresh* from the `refresh_token`
>    cookie whenever the access token is missing/expired, transparently re-issuing the access cookie —
>    so browser clients rarely need to refresh explicitly.
> 2. **Explicit:** `POST /auth/browser/refresh` (this endpoint), for clients that want to refresh
>    proactively. Bearer-only callers (mobile/service) cannot silently refresh — they must re-login on expiry.

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

### Flow E — Expired Access Token (Silent Refresh)

```
Browser clients (cookie auth):
  Refresh is AUTOMATIC — requireAuth silently refreshes from the refresh_token
  cookie and re-issues the access cookie. No explicit call needed.
  (To refresh proactively: POST /api/auth/browser/refresh)

Bearer-only clients (mobile/service):
  Cannot silently refresh. On 401 → re-login.
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
```
