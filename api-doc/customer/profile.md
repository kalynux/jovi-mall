# Customer — Profile, Addresses & Saved Payment Methods

Self-service management of the authenticated customer's profile, saved delivery addresses, and saved
payment-method metadata.

- **Base URL**: `http://localhost:8022/api`
- **Auth**: Required (cookie or `Bearer`) — see [../auth/README.md](../auth/README.md)
- **Permissions**: `customer` only (every route is guarded by `requireRole(['customer'])`)
- **Headers**: `Content-Type: application/json` on `POST`/`PATCH`. Browser clients send `credentials: 'include'`.
- **Response envelope**: standard `{ success, data, message? }` — see [../README.md](../README.md#the-response-envelope-read-this-first).

All operations resolve the customer from the JWT (`req.auth.role_entity`); there is no customer-id path
parameter — a customer can only read/write **their own** record.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/customer/profile` | Get the full profile |
| `PATCH` | `/customer/profile` | Update profile fields & preferences |
| `GET` | `/customer/profile/completion-status` | Profile completeness (always complete for customers) |
| `POST` | `/customer/addresses` | Add a saved address |
| `PATCH` | `/customer/addresses/:id` | **Edit a saved address in place** |
| `DELETE` | `/customer/addresses/:id` | Remove a saved address |
| `PATCH` | `/customer/addresses/:id/default` | Mark a saved address as default |
| `POST` · `DELETE` | `/customer/devices` | Register / unregister a push token |
| `POST` | `/customer/payment-methods` | Save payment-method display metadata |
| `DELETE` | `/customer/payment-methods/:id` | Remove a saved payment method |

> **Related:** [customer/payment-methods.md](./payment-methods.md) documents the shared
> `/me/payment-methods` surface used at checkout. The routes here manage the copies stored **on the
> customer profile**.

---

## GET `/customer/profile`

**Purpose**: Return the authenticated customer's full profile.

**Auth**: Required · **Permissions**: `customer`

> **⚠️ Casing: camelCase at the top level, snake_case inside nested objects.**
>
> This page used to show the whole response in snake_case, and that was wrong — it has misled
> at least one integrator. `CustomerProfileMapper.toResponseDto` renames only the **scalars**
> and passes `savedAddresses`, `preferences` and `savedPaymentMethods` through verbatim, so
> their inner keys keep the persistence spelling. `modules/customers/dto/customer-profile.dto.ts`
> is the authority. The example below is a real response.

### Example success `200`

```json
{
  "success": true,
  "data": {
    "id": "664cust...",
    "name": "Jane Doe",
    "email": "jane@example.com",
    "emailVerified": false,
    "phone": "+237670000000",
    "phoneVerified": true,
    "avatar": null,
    "bio": null,
    "dateOfBirth": null,
    "savedAddresses": [
      {
        "_id": "664addr...",
        "label": "Home",
        "address_line1": "123 Market St",
        "address_line2": null,
        "city": "Douala",
        "state": "Littoral",
        "country": "CM",
        "is_default": true,
        "geo": { "formatted_address": "…", "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0611] } }
      }
    ],
    "savedPaymentMethods": [],
    "preferences": {
      "language": "en",
      "currency": "XAF",
      "marketing_opt_in": false,
      "ai_tone": [],
      "ads_compact_mode": false,
      "compact_mode": false
    },
    "recentProductCode": null,
    "wa": null,
    "timezone": "Africa/Douala",
    "status": "active",
    "onboardingStep": 0,
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

---

## PATCH `/customer/profile`

**Purpose**: Update profile fields and/or preferences. All fields optional; only provided fields change.

**Auth**: Required · **Permissions**: `customer`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `name` | string | ❌ | 1–100 chars, trimmed |
| `avatarFileId` | string \| null | ❌ | MongoDB ObjectId of a file uploaded via `POST /api/files/upload` — *clearable*. The **write** field for the avatar; reads return the resolved `avatar` file object. |
| `avatarUrl` | string \| null | ❌ | *(deprecated, no effect on reads)* still accepted for backward compatibility but no longer surfaced — use `avatarFileId`. |
| `bio` | string \| null | ❌ | ≤ 500 chars — *clearable* |
| `dateOfBirth` | string (date) \| null | ❌ | coercible to a date; `null` clears |
| `recentProductCode` | string \| null | ❌ | trimmed — *clearable* |
| `preferences` | object | ❌ | see below |
| `preferences.language` | string | ❌ | 2–10 chars (BCP-47) |
| `preferences.currency` | string | ❌ | exactly 3 chars (ISO-4217), upper-cased |
| `preferences.marketing_opt_in` | boolean | ❌ | |
| `preferences.ai_tone` | string[] | ❌ | non-empty strings |
| `preferences.ads_compact_mode` | boolean | ❌ | |
| `preferences.compact_mode` | boolean | ❌ | |

> **Clearable fields**: send `null` **or `""`** to clear (stored and returned as `null`); omit the
> key to leave the value unchanged. Applies to `avatarFileId`, `bio`, `recentProductCode`,
> and to `address_line2`/`state` in saved addresses. See [Conventions](../README.md#conventions).

> **Profile avatar is a file reference.** Upload the image via `POST /api/files/upload`, then send the
> returned file `id` as `avatarFileId`. Reads return `avatar` as a **resolved file object** — the same
> `{ id, key, url, mimeType, size, originalName }` shape product images use — or `null` when unset;
> never a bare URL string. While set, that file counts as *in use* — it appears under `usage.references`
> on `GET /api/files/:id` with `entityType: "customer", field: "avatar"`, and cannot be deleted until you
> detach it (`avatarFileId: null`). See [File Management — the `usage` object](../vendor/file-management.md#get-apifilesid).

### Example request

```json
{ "name": "Jane A. Doe", "bio": "Coffee & gadgets.", "preferences": { "language": "fr", "currency": "XAF" } }
```

### Example success `200`

```json
{ "success": true, "data": { "_id": "664cust...", "name": "Jane A. Doe", "...": "..." }, "message": "Profile updated successfully" }
```

### Example error `400` (validation)

```json
{ "success": false, "requestId": "req_abc", "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "statusCode": 400, "details": { "fields": [{ "path": "avatarFileId", "message": "avatarFileId must be a valid file id", "code": "invalid_string" }] } } }
```

---

## GET `/customer/profile/completion-status`

**Purpose**: Report profile completeness. Customers have **no onboarding flow**, so this reports complete.

**Auth**: Required · **Permissions**: `customer`

### Example success `200`

```json
{ "success": true, "data": { "onboardingStep": 0, "isComplete": true, "missingFields": [], "stepLabel": "Done" } }
```

---

## POST `/customer/addresses`

**Purpose**: Add a saved delivery address. Returns the **updated full profile**.

**Auth**: Required · **Permissions**: `customer`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `label` | string | ✅ | 1–50 chars |
| `address_line1` | string | ✅ | 1–200 chars |
| `address_line2` | string \| null | ❌ | ≤ 200 chars |
| `city` | string | ✅ | 1–100 chars |
| `state` | string \| null | ❌ | ≤ 100 chars |
| `country` | string | ❌ | exactly 2 chars, upper-cased, **defaults to `CM`** |
| `is_default` | boolean | ❌ | defaults `false` |
| `location` | GeoPoint \| null | ❌ | *(deprecated — prefer `geo`)* `{ type: "Point", coordinates: [lng, lat] }` |
| `geo` | GeoAddress \| null | ❌ | The selected address-search result — the canonical geospatial address. See [Geospatial addresses](../geo/README.md). |

Attach `geo` by letting the user search their address via `GET /api/geo/search` and sending back the
selected candidate (plus `raw_input`). The loose text fields remain for display/back-compat; `geo`
carries the coordinates + provider place id + admin components used for mapping and proximity.

### Example request

```json
{
  "label": "Home",
  "address_line1": "123 Market St",
  "city": "Douala",
  "state": "Littoral",
  "country": "CM",
  "is_default": true,
  "geo": {
    "formatted_address": "123 Market St, Douala, Cameroun",
    "coordinates": { "type": "Point", "coordinates": [9.7043, 4.0611] },
    "provider": "nominatim",
    "provider_place_id": "way:987654",
    "components": { "city": "Douala", "region": "Littoral", "country": "Cameroon", "country_code": "CM" },
    "raw_input": "123 Market St, Douala"
  }
}
```

### Example success `201`

```json
{ "success": true, "data": { "_id": "664cust...", "saved_addresses": [{ "_id": "664addr...", "label": "Home", "is_default": true, "...": "..." }] }, "message": "Address added" }
```

---

## PATCH `/customer/addresses/:id`

**Purpose**: Edit a saved address **in place**. Returns the updated profile.

**Auth**: Required · **Permissions**: `customer` · **Path param**: `id` = saved-address id

> **Why this exists.** Editing used to mean delete + re-add, which mints a **new** `_id` —
> while past orders still reference the old one through `deliveryAddressId`. A customer
> correcting a typo in their street name silently orphaned every order delivered there.

### Request body

Every field of [`POST /customer/addresses`](#post-customeraddresses) is accepted and **all are
optional**; only the keys you send are written. Omitting a key leaves the stored value alone.

| Field | Type | Notes |
|---|---|---|
| `label`, `address_line1`, `city` | string | Same constraints as on create |
| `address_line2`, `state` | string \| null | *Clearable* |
| `country` | string(2) | No default here — a PATCH must not rewrite an unrelated field |
| `location` | GeoPoint \| null | *(deprecated — prefer `geo`)* |
| `geo` | GeoAddress \| null | Send `null` to clear. See the warning below |

> **`is_default` is NOT accepted here.** It is a relationship *between* addresses — exactly
> one may hold it — not a property of one, so setting it means clearing every sibling.
> [`PATCH /customer/addresses/:id/default`](#patch-customeraddressesiddefault) owns that.

> **⚠️ Clearing `geo` makes the address unusable for physical checkout.** `geo` is what a
> delivery is routed to, and it is only populated by picking a result from
> `GET /api/geo/search`. An address without it is refused at checkout with
> `422 ORDER_DELIVERY_ADDRESS_REQUIRED`.

### Example success `200`

```json
{ "success": true, "data": { "id": "664cust...", "savedAddresses": [{ "_id": "664addr...", "city": "Yaoundé" }] }, "message": "Address updated" }
```

### Errors

| `error.code` | Status | When |
|---|---|---|
| `CUSTOMER_ADDRESS_NOT_FOUND` | 404 | No such address on this profile |
| `VALIDATION_ERROR` | 400 | A supplied field fails its constraint |

---

## DELETE `/customer/addresses/:id`

**Purpose**: Remove a saved address. Returns the updated profile.

**Auth**: Required · **Permissions**: `customer` · **Path param**: `id` = saved-address id (ObjectId)

### Example success `200`

```json
{ "success": true, "data": { "_id": "664cust...", "saved_addresses": [] }, "message": "Address removed" }
```

---

## PATCH `/customer/addresses/:id/default`

**Purpose**: Mark one saved address as the default (unsets the previous default). Returns the updated profile.

**Auth**: Required · **Permissions**: `customer` · **Path param**: `id` = saved-address id (ObjectId)

### Example success `200`

```json
{ "success": true, "data": { "_id": "664cust...", "saved_addresses": [{ "_id": "664addr...", "is_default": true }] }, "message": "Default address updated" }
```

---

## POST · DELETE `/customer/devices`

**Purpose**: Register (or unregister) an FCM token so the customer can receive push
notifications. Returns `{ success, data }` / `{ success, message }`.

**Auth**: Required · **Permissions**: `customer`

Identical contract to the vendor, agency and agent mounts — see
[agent/push-notifications.md](../agent/push-notifications.md). The controller is
role-agnostic and keys on the **user**, not the customer record.

```json
{ "token": "fcm-token…", "platform": "web" }
```

`platform` is `web` | `android` | `ios`. `DELETE` takes `{ "token": "…" }`.

> **This mount was simply missing.** The customer notification catalog has always said push
> is sent "to every device the customer has registered" — but there was no way for a customer
> to register one, so `FcmPushService` resolved tokens by user and always found none. It was
> a promise to nobody.

> Not to be confused with `/api/agent/device` (singular) — that is an agent's device
> *capabilities* and location permission, a different concept on an adjacent path.

---

## POST `/customer/payment-methods`

**Purpose**: Save **display metadata** for a gateway-managed payment method. Tokenization lives with the
provider — this stores only what's needed to show the method in the UI.

**Auth**: Required · **Permissions**: `customer`

### Request body

| Field | Type | Required | Validation |
|---|---|---|---|
| `provider` | string | ✅ | non-empty |
| `gateway_customer_id` | string | ✅ | non-empty |
| `gateway_instrument_id` | string | ✅ | non-empty |
| `display_label` | string | ✅ | 1–100 chars (e.g. "Visa •••• 4242") |
| `method_type` | enum | ✅ | `card` \| `mobile_money` \| `bank_transfer` |
| `is_default` | boolean | ❌ | defaults `false` |

### Example success `201`

```json
{ "success": true, "data": { "_id": "664cust...", "saved_payment_methods": [{ "_id": "664pm...", "display_label": "Visa •••• 4242", "method_type": "card", "is_default": false }] }, "message": "Payment method added" }
```

---

## DELETE `/customer/payment-methods/:id`

**Purpose**: Remove a saved payment method. Returns the updated profile.

**Auth**: Required · **Permissions**: `customer` · **Path param**: `id` = saved-payment-method id (ObjectId)

### Example success `200`

```json
{ "success": true, "data": { "_id": "664cust...", "saved_payment_methods": [] }, "message": "Payment method removed" }
```

---

## Business rules & notes

- Every route is scoped to the caller — there is no way to read or modify another customer's profile.
- Address/payment mutations return the **whole updated profile**, so the client can replace its cached copy.
- `country` defaults to `CM` and is stored upper-cased; `currency` is stored upper-cased (ISO-4217).
- Saved payment methods hold **no secrets** — only provider/display metadata.

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body fails the Zod schema (see `details.fields`) |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_EXPIRED` | 401 | Not authenticated |
| `AUTH_ROLE_NOT_FOUND` | 403 | Authenticated as a non-customer role |
| `NOT_FOUND` | 404 | Address / payment-method id not found on the profile |

## Related

- [../auth/README.md](../auth/README.md) — session & role model
- [./payment-methods.md](./payment-methods.md) — checkout payment methods (`/me/payment-methods`)
- [./orders.md](./orders.md) · [./cart.md](./cart.md)
