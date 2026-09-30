# Saved Payment Methods API

**Verified against source on 2026-09-30, at jovi-mall `290c2c8`**: the five `/api/me/payment-methods` routes, the request schema, the returned DTO and the error paths, against `src/modules/payment-methods/{routes.ts,validators/payment-method.validators.ts,dto/payment-method.dto.ts,services/payment-method.service.ts}`.

Reference for managing a user's **saved payment methods**: the mobile-money wallets a user keeps so a payment form can offer "your MTN wallet ending 4417".

> [!IMPORTANT]
> This is a **shared, role-agnostic** API mounted at `/api/me/payment-methods`. The **same endpoints, request bodies, and responses** work for **every** authenticated role (customer, vendor, admin, agent, agency). The owner is resolved from the auth token: a user only ever sees and manages **their own** methods.
>
> This file documents it from the **agency** perspective. The identical reference also lives in [customer](../customer/payment-methods.md), [vendor](../vendor/payment-methods.md), [admin](../admin/payment-methods.md), and [agent](../agent/payment-methods.md) folders.

> [!WARNING]
> **Changed on 2026-09-30, and it breaks old app builds.** The request body used to carry a
> free-text `provider` plus `gateway_customer_id` / `gateway_instrument_id` and display fields.
> That shape is **refused** now (`400 VALIDATION_ERROR`), so an app build that still sends it
> **can no longer save a method**. Paying is not affected. The response shape changed too. See
> [The old shape is refused](../customer/payment-methods.md#the-old-shape-is-refused-2026-09-30) and the
> [changelog](../FRONTEND-CHANGELOG-payment-providers.md#saving-a-payment-method-2026-09-30).

---

## What you can save — read this first

- **Mobile-money wallets only**: `MTN`, `ORANGE` or `MOOV`, with the phone number.
- **Saving a card is refused for now.** `provider: "CARD"` answers `400 VALIDATION_ERROR`. Cards
  saved before 2026-09-30 still appear in the list (as `provider: "CARD"`) and can be set as
  default or deleted.
- **You never name a payment company.** The same `MTN` / `ORANGE` / `MOOV` values you send on a
  charge ([payments/routing.md](../payments/routing.md)) are what you save. Which company moves
  the money is the server's choice, made at payment time.
- **The full phone number is never returned**, on any endpoint. Reads carry a masked copy
  (`"+2376••••4417"`) and the last four digits. If your payment form wants to pre-fill the
  number, keep your own copy on the device when the user saves it.

---

## Authentication

All endpoints require a valid access token (any authenticated role).

```
Authorization: Bearer <access_token>
```

The token may also be supplied via the `access_token` httpOnly cookie (browser clients).

All responses use the standard envelope:

- Success: `{ "success": true, "data": ... }` (write endpoints may also include a `"message"`).
- Failure: `{ "success": false, "requestId": "...", "error": { "code", "message", "statusCode", "details"? } }`. See [errors/README.md](../errors/README.md).

---

## The Payment Method object

This is the shape returned by every read/write endpoint (the `data` field), on every surface
(`/api/me`, `/api/customer`, and the `savedPaymentMethods` array of the customer profile).

```json
{
  "id": "665f1d3b9b1e4a0012a3b4d7",
  "provider": "MTN",
  "kind": "MOBILE_MONEY",
  "label": "MTN Mobile Money · ••••4417",
  "maskedPhone": "+2376••••4417",
  "last4": "4417",
  "isDefault": true,
  "createdAt": "2026-09-30T10:12:44.000Z",
  "updatedAt": "2026-09-30T10:12:44.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The payment method id. Use it in the `:id` path of update/delete calls. |
| `provider` | `"MTN"` \| `"ORANGE"` \| `"MOOV"` \| `"CARD"` \| `null` | What the user holds. The same vocabulary as the charge `provider`. `CARD` and `null` occur on **older** rows only (see below). |
| `kind` | `"MOBILE_MONEY"` \| `"CARD"` \| `"BANK_TRANSFER"` | Drives which icon to render. `BANK_TRANSFER` occurs on older rows only. |
| `label` | string | Text for lists and rows, e.g. `MTN Mobile Money · ••••4417`. |
| `maskedPhone` | string \| null | The wallet number with its middle hidden: first 5 characters, `••••`, last 4. `null` for a card, and for an older row whose number is not known. |
| `last4` | string \| null | The last 4 digits of the number (or of the card, on an older card row). |
| `isDefault` | boolean | Whether this is the user's default method. At most one method is default at a time. |
| `createdAt` / `updatedAt` | string (ISO 8601) | When the row was created / last changed. |

No payment-company field is returned, ever, and neither is the full number.

**Older rows are shown, not hidden.** Methods saved before 2026-09-30 are read in the new shape:

| Saved before as | Reads as |
|---|---|
| `mtn_momo` · `orange_money` · `moov_money` | `provider` `MTN` · `ORANGE` · `MOOV`, `kind: "MOBILE_MONEY"` |
| a card | `provider: "CARD"`, `kind: "CARD"`, `maskedPhone: null` |
| a payment-company name (`notchpay`, `mycoolpay`…) | `provider: null`. `maskedPhone` is filled only when the old row happens to hold a full international number |
| a bank transfer | `provider: null`, `kind: "BANK_TRANSFER"`, `maskedPhone: null` |

So a client never sees the old lowercase values, and should **treat `provider: null` as "unknown
wallet"**: show it, let the user delete it, but don't pre-select it for a payment.

---

## Behavior rules

- **Single default:** at most one method per user has `isDefault: true`. Setting a new default automatically clears the previous one.
- **First method auto-defaults:** the very first method a user adds becomes the default automatically, even if `isDefault` was omitted or `false`.
- **Limit:** a user may store up to **10** methods. The 11th returns `PAYMENT_METHOD_LIMIT_REACHED` (`409`).
- **No duplicate check:** saving the same number twice creates two rows. If you don't want that, check the list (`provider` + `last4`) before saving.
- **Deleting the default:** removing the default method does **not** auto-promote another. The user is left with no default until they set one (`PATCH .../:id/default`). Recommended UX: if the deleted method was default and others remain, prompt the user to pick a new default.
- **Ownership:** every operation is scoped to the caller. Referencing another user's method id returns `PAYMENT_METHOD_NOT_FOUND` (`404`), never another user's data.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/me/payment-methods` | List all of the user's saved methods |
| `GET` | `/api/me/payment-methods/default` | Get the user's default method (or `null`) |
| `POST` | `/api/me/payment-methods` | Save a new wallet |
| `PATCH` | `/api/me/payment-methods/:id/default` | Mark a method as default |
| `DELETE` | `/api/me/payment-methods/:id` | Delete a method |

---

### 1. List payment methods

```http
GET /api/me/payment-methods
```

Returns all of the caller's methods, **default first**, then newest first.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": [
    {
      "id": "665f1d3b9b1e4a0012a3b4d7",
      "provider": "MTN",
      "kind": "MOBILE_MONEY",
      "label": "MTN Mobile Money · ••••4417",
      "maskedPhone": "+2376••••4417",
      "last4": "4417",
      "isDefault": true,
      "createdAt": "2026-09-30T10:12:44.000Z",
      "updatedAt": "2026-09-30T10:12:44.000Z"
    },
    {
      "id": "665f1c2a9b1e4a0012a3b4c5",
      "provider": "ORANGE",
      "kind": "MOBILE_MONEY",
      "label": "Orange Money · ••••0044",
      "maskedPhone": "+2376••••0044",
      "last4": "0044",
      "isDefault": false,
      "createdAt": "2026-09-29T08:01:10.000Z",
      "updatedAt": "2026-09-29T08:01:10.000Z"
    }
  ]
}
```

An empty wallet returns `"data": []`.

---

### 2. Get the default payment method

```http
GET /api/me/payment-methods/default
```

Convenience endpoint for a payment form: returns the single method to pre-select.

**Response:** `200 OK`: `data` is one Payment Method object, as above.

If the user has no default, `data` is `null`:

```json
{ "success": true, "data": null }
```

---

### 3. Add a payment method

```http
POST /api/me/payment-methods
Content-Type: application/json
```

**Request body** (strict: an unknown key is refused, not ignored):

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `provider` | `"MTN"` \| `"ORANGE"` \| `"MOOV"` | **Yes** | Uppercase, exactly one of these three. `CARD` is refused ("saving a card is not available yet"), and so are the old lowercase values (`mtn_momo`…) and payment-company names. |
| `phoneNumber` | string | **Yes** | International format (E.164), e.g. `+237670124417`. Spaces, dashes, dots and parentheses are stripped first, so `+237 670 12 44 17` is accepted. |
| `label` | string | No | 1–100 characters, trimmed. When absent, the server writes one: `MTN Mobile Money · ••••4417`, `Orange Money · ••••0044`, `Moov Money · ••••NNNN`. An empty or blank `label` is refused: omit the key instead. |
| `isDefault` | boolean | No | Defaults to `false`. If `true`, becomes the default and clears any previous default. (The first method ever added is always default regardless.) |

**Example:**

```json
{
  "provider": "MTN",
  "phoneNumber": "+237670124417",
  "isDefault": true
}
```

**Response:** `201 Created`: the created method.

```json
{
  "success": true,
  "data": {
    "id": "665f1d3b9b1e4a0012a3b4d7",
    "provider": "MTN",
    "kind": "MOBILE_MONEY",
    "label": "MTN Mobile Money · ••••4417",
    "maskedPhone": "+2376••••4417",
    "last4": "4417",
    "isDefault": true,
    "createdAt": "2026-09-30T10:12:44.000Z",
    "updatedAt": "2026-09-30T10:12:44.000Z"
  },
  "message": "Payment method added"
}
```

**The number must belong to the network you name.** A Cameroon number's prefix identifies its
network, and when it contradicts `provider` the save is refused with
`422 PAYMENT_PROVIDER_PHONE_MISMATCH` and nothing is written. The prefix alone decides:

| `provider` | Number's prefix says | Result |
|---|---|---|
| `MTN` | MTN | saved |
| `MTN` | Orange | `422`, `details.detected: "ORANGE"` |
| `ORANGE` | MTN | `422`, `details.detected: "MTN"` |
| `MOOV` | MTN or Orange | `422` |
| any | unknown (Camtel `62x`, Nexttel `66x`, a non-Cameroon number) | saved: the declared provider wins |

**Errors:**

| Status | `error.code` | When |
|--------|--------------|------|
| `400` | `VALIDATION_ERROR` | `provider` missing or not one of `MTN`/`ORANGE`/`MOOV` (including `CARD`); `phoneNumber` missing or not international format; a bad `label`; **any key of the old shape** (`gateway_customer_id`, `gateway_instrument_id`, `method_type`, `display_label`, `brand`, `last4`, `exp_month`, `exp_year`, `holder_name`, `is_default`). `error.details.fields[]` lists each failure. |
| `422` | `PAYMENT_PROVIDER_PHONE_MISMATCH` | The number is on another network. `details: { provider, detected }`. |
| `409` | `PAYMENT_METHOD_LIMIT_REACHED` | User already has 10 saved methods. |
| `401` | `AUTH_*` | Missing/invalid/expired token. |

---

### 4. Set a method as default

```http
PATCH /api/me/payment-methods/:id/default
```

Marks the given method as default and clears the previous default. Works on older rows too
(including an older card).

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The payment method id. |

**Response:** `200 OK`: the updated (now-default) method, with `"message": "Default payment method updated"`.

**Errors:**

| Status | `error.code` | When |
|--------|--------------|------|
| `404` | `PAYMENT_METHOD_NOT_FOUND` | No method with that id belongs to the user. |
| `401` | `AUTH_*` | Missing/invalid/expired token. |

---

### 5. Delete a payment method

```http
DELETE /api/me/payment-methods/:id
```

Permanently removes the method.

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The payment method id. |

**Response:** `200 OK` (no `data`).

```json
{ "success": true, "message": "Payment method removed" }
```

**Errors:**

| Status | `error.code` | When |
|--------|--------------|------|
| `404` | `PAYMENT_METHOD_NOT_FOUND` | No method with that id belongs to the user. |
| `401` | `AUTH_*` | Missing/invalid/expired token. |

---

## Error codes summary

| `error.code` | Status | Meaning |
|--------------|--------|---------|
| `VALIDATION_ERROR` | `400` | Request body failed validation, including a card, an old-shape key, or a badly formatted number. Inspect `error.details.fields`. |
| `PAYMENT_PROVIDER_PHONE_MISMATCH` | `422` | The number belongs to another network than `provider`. `details: { provider, detected }`. |
| `PAYMENT_METHOD_NOT_FOUND` | `404` | The referenced method does not exist or is not owned by the caller. |
| `PAYMENT_METHOD_LIMIT_REACHED` | `409` | The 10-method-per-user cap was hit. |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | `401` | Authentication problem. See [auth docs](../auth/README.md). |

See [errors/README.md](../errors/README.md) for the full envelope and `details` shapes.

---

## Pre-filling a payment — recommended frontend flow

1. When a payment screen opens, call `GET /api/payments/options` for what can be paid with, and
   `GET /api/me/payment-methods` for the user's wallets.
2. Pre-select the default method **only if its `provider` is listed in `/options`**. A `CARD` or
   `null` method is shown but not pre-selected.
3. Send the charge with that `provider` and the phone number. The server does **not** return the
   number, so fill it from the copy your app kept when the user saved the wallet (match it on
   `id` and `last4`). With no copy, ask the user to type it.
4. Let the user save a new wallet with `POST`, switch the default with `PATCH .../:id/default`
   and remove one with `DELETE .../:id`.

> [!NOTE]
> Every charge an app starts takes the provider and number in its own request body
> ([payments/README.md](../payments/README.md)). No app-facing door charges a saved method by
> its `id`. The one place the server itself uses a saved wallet is the chat and mini-app checkout,
> which charges the customer's saved wallet (the default first, else the newest; read server-side,
> never returned).

