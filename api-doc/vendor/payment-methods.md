# Saved Payment Methods API

Reference for managing a user's **saved payment methods** — the tokenized cards / mobile-money / bank instruments used to **pre-fill the checkout page** on the frontend.

> [!IMPORTANT]
> This is a **shared, role-agnostic** API mounted at `/api/me/payment-methods`. The **same endpoints, request bodies, and responses** work for **every** authenticated role (customer, vendor, admin, agent, agency). The owner is resolved from the auth token — a user only ever sees and manages **their own** methods.
>
> This file documents it from the **vendor** perspective. The identical reference also lives in [customer](../customer/payment-methods.md), [admin](../admin/payment-methods.md), [agency](../agency/payment-methods.md), and [agent](../agent/payment-methods.md) folders.

---

## Security model — read this first

> [!WARNING]
> **Never send raw card numbers (PAN) or CVV to this API.** This backend does **not** store, and will not accept, full card data. Storing PAN/CVV here would violate PCI-DSS.

The flow is:

1. The frontend collects raw card details and sends them **directly to the payment gateway's SDK** (e.g. Stripe.js / NotchPay / MyCoolPay), which **tokenizes** them.
2. The gateway returns opaque token references (a customer id and an instrument/payment-method id).
3. Your frontend sends **only those tokens plus non-sensitive display metadata** (brand, last 4 digits, expiry month/year, cardholder name) to this API.

The stored `gateway_customer_id` / `gateway_instrument_id` are secrets and are **never returned** in any response.

---

## Authentication

All endpoints require a valid access token (any authenticated role).

```
Authorization: Bearer <access_token>
```

The token may also be supplied via the `access_token` httpOnly cookie (browser clients).

All responses use the standard envelope:

- Success: `{ "success": true, "data": ... }` (write endpoints may also include a `"message"`).
- Failure: `{ "success": false, "requestId": "...", "error": { "code", "message", "statusCode", "details"? } }` — see [errors/README.md](../errors/README.md).

---

## The Payment Method object

This is the shape returned by every read/write endpoint (the `data` field). **It never contains gateway token ids.**

```json
{
  "id": "665f1c2a9b1e4a0012a3b4c5",
  "provider": "stripe",
  "method_type": "card",
  "display_label": "VISA •••• 8947",
  "brand": "visa",
  "last4": "8947",
  "exp_month": 7,
  "exp_year": 2030,
  "holder_name": "Koushik Sarkar",
  "is_default": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The payment method id. Use it in the `:id` path of update/delete calls. |
| `provider` | string | Gateway/provider that owns the token. E.g. `stripe`, `notchpay`, `mycoolpay`, `mtn_momo`, `orange_money`. |
| `method_type` | enum | One of `card`, `mobile_money`, `bank_transfer`. Drives which icon/UI to render. |
| `display_label` | string | Human label for lists/rows, e.g. `VISA •••• 8947` or `MTN •••• 1234`. |
| `brand` | string \| null | Card network or mobile operator, e.g. `visa`, `mastercard`, `MTN`, `ORANGE`. |
| `last4` | string \| null | Last 4 digits of the card / phone number. Exactly 4 digits when present. |
| `exp_month` | number \| null | Card expiry month, `1`–`12`. Null for non-card methods. |
| `exp_year` | number \| null | Card expiry 4-digit year, e.g. `2030`. Null for non-card methods. |
| `holder_name` | string \| null | Cardholder / account holder name. |
| `is_default` | boolean | Whether this is the user's default method (pre-selected at checkout). Exactly one method is default at a time. |

---

## Behavior rules

- **Single default:** at most one method per user has `is_default: true`. Setting a new default automatically clears the previous one.
- **First method auto-defaults:** the very first method a user adds becomes the default automatically, even if `is_default` was omitted/`false`.
- **Limit:** a user may store up to **10** methods. The 11th returns `PAYMENT_METHOD_LIMIT_REACHED` (`409`).
- **Deleting the default:** removing the default method does **not** auto-promote another. The user is left with no default until they set one (`PATCH .../:id/default`). Recommended UX: if the deleted method was default and others remain, prompt the user to pick a new default.
- **Ownership:** every operation is scoped to the caller. Referencing another user's method id returns `PAYMENT_METHOD_NOT_FOUND` (`404`), never another user's data.

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/me/payment-methods` | List all of the user's saved methods |
| `GET` | `/api/me/payment-methods/default` | Get the user's default method (or `null`) |
| `POST` | `/api/me/payment-methods` | Save a new method |
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
      "id": "665f1c2a9b1e4a0012a3b4c5",
      "provider": "stripe",
      "method_type": "card",
      "display_label": "VISA •••• 8947",
      "brand": "visa",
      "last4": "8947",
      "exp_month": 7,
      "exp_year": 2030,
      "holder_name": "Koushik Sarkar",
      "is_default": true
    },
    {
      "id": "665f1d3b9b1e4a0012a3b4d7",
      "provider": "notchpay",
      "method_type": "mobile_money",
      "display_label": "MTN •••• 1234",
      "brand": "MTN",
      "last4": "1234",
      "exp_month": null,
      "exp_year": null,
      "holder_name": "Koushik Sarkar",
      "is_default": false
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

Convenience endpoint for checkout: returns the single method to pre-select.

**Response:** `200 OK`

```json
{
  "success": true,
  "data": {
    "id": "665f1c2a9b1e4a0012a3b4c5",
    "provider": "stripe",
    "method_type": "card",
    "display_label": "VISA •••• 8947",
    "brand": "visa",
    "last4": "8947",
    "exp_month": 7,
    "exp_year": 2030,
    "holder_name": "Koushik Sarkar",
    "is_default": true
  }
}
```

If the user has no methods, `data` is `null`:

```json
{ "success": true, "data": null }
```

---

### 3. Add a payment method

```http
POST /api/me/payment-methods
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Rules |
|-------|------|----------|-------|
| `provider` | string | **Yes** | 1–50 chars. The gateway that issued the token, e.g. `stripe`. |
| `gateway_customer_id` | string | **Yes** | Non-empty. The gateway's customer/wallet id from tokenization. **Stored, never returned.** |
| `gateway_instrument_id` | string | **Yes** | Non-empty. The gateway's card/instrument/payment-method id. **Stored, never returned.** |
| `method_type` | enum | **Yes** | One of `card`, `mobile_money`, `bank_transfer`. |
| `display_label` | string | **Yes** | 1–100 chars. Label shown in lists, e.g. `VISA •••• 8947`. |
| `brand` | string \| null | No | ≤ 50 chars. Card network / operator. |
| `last4` | string \| null | No | Exactly 4 digits (regex `^\d{4}$`). |
| `exp_month` | number \| null | No | Integer `1`–`12`. |
| `exp_year` | number \| null | No | Integer `2000`–`2100`. |
| `holder_name` | string \| null | No | ≤ 100 chars. |
| `is_default` | boolean | No | Defaults to `false`. If `true`, becomes the default and clears any previous default. (The first method ever added is always default regardless.) |

> The nullable display fields (`brand`, `last4`, `holder_name`) treat `""` as `null` — an empty form
> input is stored as `null`, never rejected. A non-empty invalid value (e.g. a 3-digit `last4`) is
> still rejected. See [Conventions](../README.md#conventions).

**Example — card:**

```json
{
  "provider": "stripe",
  "gateway_customer_id": "cus_Qabc123XYZ",
  "gateway_instrument_id": "pm_1PdEf2GhIjKlMnOp",
  "method_type": "card",
  "display_label": "VISA •••• 8947",
  "brand": "visa",
  "last4": "8947",
  "exp_month": 7,
  "exp_year": 2030,
  "holder_name": "Koushik Sarkar",
  "is_default": true
}
```

**Example — mobile money:**

```json
{
  "provider": "notchpay",
  "gateway_customer_id": "notch_cus_8821",
  "gateway_instrument_id": "notch_inst_2231",
  "method_type": "mobile_money",
  "display_label": "MTN •••• 1234",
  "brand": "MTN",
  "last4": "1234",
  "holder_name": "Koushik Sarkar"
}
```

**Response:** `201 Created` — returns the created method (without gateway ids).

```json
{
  "success": true,
  "data": {
    "id": "665f1c2a9b1e4a0012a3b4c5",
    "provider": "stripe",
    "method_type": "card",
    "display_label": "VISA •••• 8947",
    "brand": "visa",
    "last4": "8947",
    "exp_month": 7,
    "exp_year": 2030,
    "holder_name": "Koushik Sarkar",
    "is_default": true
  },
  "message": "Payment method added"
}
```

**Errors:**

| Status | `error.code` | When |
|--------|--------------|------|
| `400` | `VALIDATION_ERROR` | Body fails validation (missing required field, bad `last4`, `exp_month` out of range, etc.). `error.details.fields[]` lists each failure. |
| `409` | `PAYMENT_METHOD_LIMIT_REACHED` | User already has 10 saved methods. |
| `401` | `AUTH_*` | Missing/invalid/expired token. |

---

### 4. Set a method as default

```http
PATCH /api/me/payment-methods/:id/default
```

Marks the given method as default and clears the previous default.

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string | The payment method id. |

**Response:** `200 OK` — returns the updated (now-default) method.

```json
{
  "success": true,
  "data": {
    "id": "665f1d3b9b1e4a0012a3b4d7",
    "provider": "notchpay",
    "method_type": "mobile_money",
    "display_label": "MTN •••• 1234",
    "brand": "MTN",
    "last4": "1234",
    "exp_month": null,
    "exp_year": null,
    "holder_name": "Koushik Sarkar",
    "is_default": true
  },
  "message": "Default payment method updated"
}
```

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
| `VALIDATION_ERROR` | `400` | Request body failed schema validation. Inspect `error.details.fields`. |
| `PAYMENT_METHOD_NOT_FOUND` | `404` | The referenced method does not exist or is not owned by the caller. |
| `PAYMENT_METHOD_LIMIT_REACHED` | `409` | The 10-method-per-user cap was hit. |
| `AUTH_MISSING_TOKEN` / `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED` / `AUTH_SESSION_EXPIRED` | `401` | Authentication problem. See [auth docs](../auth/README.md). |

See [errors/README.md](../errors/README.md) for the full envelope and `details` shapes.

---

## Checkout autofill — recommended frontend flow

1. On entering the checkout/payment screen, call `GET /api/me/payment-methods` to render the saved-method chips/rows (mirrors the "Payment Method" row in the mockup).
2. Pre-select the method where `is_default: true` (or call `GET /api/me/payment-methods/default`). Use `brand`, `last4`, `exp_month`/`exp_year`, and `holder_name` to fill the read-only card preview and the form fields.
3. When the user adds a new card via the gateway SDK, `POST` the resulting tokens + display metadata, optionally with `is_default: true`, then refresh the list.
4. Let the user switch the default with `PATCH .../:id/default` and remove a method with `DELETE .../:id`.

> [!NOTE]
> Charging still happens through the existing payment-initiation endpoints. This API only **manages** the saved instruments and powers autofill; wiring a saved method directly into a charge is a separate (future) step.
