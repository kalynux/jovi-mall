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
| `vendor` | ✅ Yes — 3 steps | Must complete before accessing dashboard |
| `agency` | ✅ Yes — 3 steps | Must complete before accessing dashboard |
| `agent` | ✅ Yes — 2 steps | Must complete before accessing dashboard |
| `admin` | ❌ No | `onboarding_step` is always `0` |

A user can hold **multiple roles** and log in under any of them independently.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | Public | Register a new account |
| `POST` | `/auth/login` | Public | Log in and set auth cookies |
| `POST` | `/auth/refresh` | Public (cookie) | Issue new access token from refresh cookie |
| `POST` | `/auth/logout` | Public | Clear both auth cookies |
| `GET` | `/auth/me` | Required | Get current user (lightweight) |
| `GET` | `/auth/auth-me/:role` | Required | Restore session + re-issue cookies |
| `POST` | `/auth/add-role` | Required | Add a second role to an existing account |
| `POST` | `/auth/send-email-verification` | Required | Send email verification link |
| `GET` | `/auth/verify-email` | Public | Confirm email via token link |
| `POST` | `/auth/request-wa-verification` | Required | Start WhatsApp phone verification |

---

## POST `/auth/register`

Creates a new user and a role profile in one step. Sets both auth cookies on success.

**Auth**: Public

### Request Body

```json
{
  "phone": "08012345678",
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
| `phone` | string | ✅ | Min 10 digits. Used as login identifier. |
| `password` | string | ✅ | Min 6 characters. |
| `name` | string | ✅ | Min 2 characters. Used for all roles. |
| `role` | string | ✅ | One of: `customer`, `vendor`, `agency`, `agent`. Defaults to `vendor`. |
| `email` | string | ❌ | Required for `vendor`. Must be unique. |
| `business_name` | string | ❌ | For `vendor` role. Falls back to `name`. |
| `agency_name` | string | ❌ | For `agency` role. Falls back to `name`. |

> **Customer registration**: only `phone`, `password`, `name`, and `role: "customer"` are needed.

### Response `201`

Sets cookies `access_token` and `refresh_token`.

```json
{
  "user": {
    "_id": "664abc...",
    "login_phone": "08012345678",
    "login_email": "john@example.com",
    "roles": ["vendor"],
    "status": "active"
  },
  "role_entity": {
    "_id": "664def...",
    "user_id": "664abc...",
    "business_name": "John's Shop",
    "email": "john@example.com",
    "phone": "08012345678",
    "email_verified": false,
    "phone_verified": false,
    "onboarding_step": 1,
    "status": "pending_verification"
  }
}
```

> `onboarding_step` tells you where to redirect. See [Onboarding Flow](#onboarding-flow) below.
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
  "identifier": "08012345678",
  "password": "secret123",
  "role": "vendor"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `identifier` | string | ✅ | Phone number or email address |
| `password` | string | ✅ | Account password |
| `role` | string | ❌ | Required if the user has multiple roles. |

> If the user only has one role, `role` can be omitted — it will be resolved automatically.

### Response `200`

Sets cookies `access_token` and `refresh_token`.

```json
{
  "user": {
    "_id": "664abc...",
    "login_phone": "08012345678",
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
```

> Check `role_entity.onboarding_step` to determine where to redirect the user. See [Post-Login Routing](#post-login--registration-routing).

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
  "message": "Logged out successfully"
}
```

---

## POST `/auth/refresh`

Issues a new `access_token` cookie using the `refresh_token` cookie.

**Auth**: Public (uses `refresh_token` cookie automatically)

### Request Body

None.

### Response `200`

Sets a new `access_token` cookie.

```json
{
  "message": "Token refreshed",
  "user": { "_id": "...", "roles": ["vendor"], "..." : "..." }
}
```

### Errors

| Status | Message | Cause |
|--------|---------|-------|
| `401` | `Invalid or expired refresh token` | Token missing or expired |

---

## GET `/auth/me`

Returns the raw user object. Lightweight — no role entity loaded.

**Auth**: Required

### Response `200`

```json
{
  "user": {
    "_id": "664abc...",
    "login_phone": "08012345678",
    "roles": ["vendor"],
    "status": "active"
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
```

> Check `role_entity.onboarding_step` to route to onboarding or dashboard.

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
  "user": { "_id": "...", "roles": ["vendor", "customer"], "..." : "..." },
  "role": "customer",
  "role_entity": { "_id": "...", "name": "John Doe", "onboarding_step": 0, "..." : "..." }
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
{ "message": "Verification email sent" }
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
{ "message": "Email verified successfully" }
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
  "code": "A1B2C3D4", // 8 alpha-numeric characters
  "command": "/link:A1B2C3D4",
  "wa_link": "https://wa.me/234XXXXXXXXXX?text=%2Flink%3AA1B2C3D4",
  "expires_in_seconds": 600,
  "instructions": "Click the wa_link to verify your WhatsApp account automatically..."
}
```

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

Onboarding is **field-presence driven**: every profile write recalculates `onboarding_step` from scratch. Steps do not have to be completed in order — the server always reports the next incomplete step.

### Vendor Onboarding

**Base**: `PATCH /api/vendor/onboarding/step`  
**Auth**: Required (`vendor` role)

| Step | Value | Label | Required Fields |
|------|-------|-------|-----------------|
| `BASIC_SETUP` | `1` | Basic Setup | `country`, `timezone`, `payout_details` |
| `DELIVERY_LINKING` | `2` | Delivery Linking | `default_delivery_agency_id` |
| `BRANDING` | `3` | Branding (Optional) | `branding` (attached file ids), `business_addresses` — or `skip: true` |
| `COMPLETED` | `0` | Done | — |

#### Step 1 — Basic Setup

```json
{
  "step": 1,
  "country": "CM",
  "timezone": "Africa/Douala",
  "payout_details": { "..." : "..." }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `country` | string | ✅ | ISO-2 country code (e.g. `"CM"`) |
| `timezone` | string | ✅ | IANA timezone string (e.g. `"Africa/Douala"`) |
| `payout_details` | object | ✅ | Payout configuration object |

#### Step 2 — Delivery Linking

```json
{
  "step": 2,
  "default_delivery_agency_id": "664abc..."
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `default_delivery_agency_id` | string | ✅ | MongoDB ObjectId of the delivery agency |

> Use `GET /api/agency` to list available agencies.

#### Step 3 — Branding (Optional / Skippable)

Branding images are attached files, not raw URLs — upload the logo/cover image first via
`POST /api/files/upload` (multipart, field name `files`), then submit the returned file `id`s below.
See [Vendor Onboarding — Step 3: Branding](../vendor/onboarding.md#step-3-branding-optional--skippable).

To provide branding data:

```json
{
  "step": 3,
  "branding": {
    "logo_file_id": "507f1f77bcf86cd799439030",
    "cover_image_file_id": "507f1f77bcf86cd799439031"
  },
  "business_addresses": [
    {
      "label": "Main Shop",
      "address_line1": "123 Market St",
      "city": "Douala",
      "state": "Littoral"
    }
  ]
}
```

To skip this step:

```json
{
  "step": 3,
  "skip": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `skip` | boolean | ❌ | Set `true` to skip branding and mark complete |
| `branding.logo_file_id` | string (ObjectId) \| null | ❌ | Id of a file uploaded via `POST /api/files/upload` |
| `branding.cover_image_file_id` | string (ObjectId) \| null | ❌ | Id of a file uploaded via `POST /api/files/upload` |
| `business_addresses` | array | ❌ | List of business addresses |

#### Onboarding Step Response

All step requests return `{ success, data }`:

```json
{
  "success": true,
  "data": {
    "profile": {
      "_id": "...",
      "business_name": "John's Shop",
      "onboarding_step": 2,
      "..."  : "..."
    },
    "completionStatus": {
      "onboardingStep": 2,
      "isComplete": false,
      "missingFields": ["default_delivery_agency_id"],
      "stepLabel": "Delivery Linking"
    }
  }
}
```

Use `completionStatus.missingFields` to prompt the user for specific missing data.

#### Check Onboarding Status

```
GET /api/vendor/profile/completion-status
```

Returns the current step and missing fields without mutating any data.

```json
{
  "success": true,
  "data": {
    "onboardingStep": 1,
    "isComplete": false,
    "missingFields": ["payout_details"],
    "stepLabel": "Basic Setup"
  }
}
```

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

### Agency Onboarding

**Base**: `PATCH /api/agency/onboarding/step`  
**Auth**: Required (`agency` role)

| Step | Value | Label | Required Fields |
|------|-------|-------|-----------------|
| `LOGISTICS_SETUP` | `1` | Logistics Setup | `coverage_areas` (min 1), `headquarters_addresses` (min 1) |
| `PAYOUT_SETUP` | `2` | Payout Setup | `payout_details` |
| `BRANDING` | `3` | Branding (Optional) | `logo_url`, `timezone` — or `skip: true` |
| `COMPLETED` | `0` | Done | — |

---

### Agent Onboarding

**Base**: `PATCH /api/agent/onboarding/step`  
**Auth**: Required (`agent` role)

| Step | Value | Label | Required Fields |
|------|-------|-------|-----------------|
| `VEHICLE_SETUP` | `1` | Vehicle Setup | `vehicle_info` (`vehicle_type`, `color`) |
| `IDENTITY_SETUP` | `2` | Identity (Optional) | `avatar_url`, `timezone` — or `skip: true` |
| `COMPLETED` | `0` | Done | — |

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
  "phone": "08098765432",
  "email_verified": false,
  "phone_verified": false,
  "avatar_url": null,
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
  "phone": "08012345678",
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

2. PATCH /api/vendor/onboarding/step  { step: 1, country, timezone, payout_details }
      → Returns { profile, completionStatus }
      → completionStatus.onboardingStep → 2

3. PATCH /api/vendor/onboarding/step  { step: 2, default_delivery_agency_id }
      → completionStatus.onboardingStep → 3

4. PATCH /api/vendor/onboarding/step  { step: 3, skip: true }  OR  provide branding
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
1. Any API call returns 401
2. POST /api/auth/refresh   (refresh_token cookie sent automatically)
      → Issues new access_token cookie
3. Retry original request
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
      → Returns { success: true }
      → Redirect to login page
```
