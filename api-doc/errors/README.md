# API Error Handling Guide

This guide explains how frontend applications should handle and parse error responses from the Jovi Mall API. By standardizing our error formats, the frontend can reliably display appropriate feedback to users and trigger specific client-side UI flows based on explicit error codes.

## Standard Error Response Structure

Whenever an API request fails (e.g., due to validation, business logic violations, or server errors), the API will return a JSON payload with a `4xx` or `5xx` HTTP status code. The response body will strictly follow this structure:

```typescript
{
  "success": false,
  "requestId": "string",
  "error": {
    "code": "string",       // e.g., "AUTH_INVALID_CREDENTIALS"
    "message": "string",    // Human-readable fallback message
    "statusCode": number,   // HTTP status code (e.g., 400, 401, 404)
    "details"?: {}          // Optional object with supplemental error data
  }
}
```

### Field Descriptions

| Field | Type | Description |
| :--- | :--- | :--- |
| `success` | `boolean` | Always `false` for error responses. Use this to quickly verify if the request failed from the body payload (if your HTTP client resolves based on standard parsing). |
| `requestId` | `string` | A unique identifier for the request. **Highly recommended** to display this ID to the user in a generic "Something went wrong" toast, so they can provide it to customer support for tracing. |
| `error.code` | `string` | **The most important field.** A domain-centric identifier (e.g., `AUTH_TOKEN_EXPIRED`, `CATALOG_INSUFFICIENT_STOCK`). Frontend logic (like showing dedicated UI modals, redirecting, or mapping i18n translation keys) **must** be driven by this field. |
| `error.message` | `string` | A generic human-readable message provided by the backend. Useful as a fallback to display to the user if the frontend lacks a specific translation for the `error.code`. |
| `error.statusCode` | `number` | Repeats the HTTP response status code for programmatic convenience. |
| `error.details` | `object` | Optional supplemental data related to the specific error. See the section below for details. |

---

## Understanding the `error.details` Field

The `details` object provides precise context about exactly what went wrong. The structure of this object changes depending on the `error.code`. 

Below is a breakdown of what you can expect in the `details` field for specific scenarios:

### 1. Request Validation Errors
**Code:** `VALIDATION_ERROR` (Status `400`)
Occurs when the request payload (body, query, or params) fails base schema validation.

```json
{
  "details": {
    "fields": [
      {
        "path": "user.email",          // The dot-notation path to the invalid field
        "message": "Invalid email",    // Specific validation error for this field
        "code": "invalid_type"         // Zod validation internal code
      }
    ]
  }
}
```
*Frontend usage:* Map the `fields` array to the appropriate form input elements to display inline validation errors.

### 2. Database Constraint Violations (Duplicate Keys)
**Code:** `DATABASE_UNIQUE_CONSTRAINT_VIOLATION` (Status `409`)
Occurs when attempting to create a record that conflicts with an existing unique value (e.g., registering an already-used email or phone number).

```json
{
  "details": {
    "keyValue": {
      "email": "existing@email.com"   // The exact field and value that triggered the conflict
    }
  }
}
```

### 3. Catalog Bulk Update Validation
**Code:** `CATALOG_BULK_VALIDATION_FAILED` (Status `400`)
Occurs when uploading bulk inventory/catalog data (like CSVs) and specific rows fail validation.

```json
{
  "details": {
    "rowErrors": [
      {
        "row": 4,                               // The 1-indexed row number in the uploaded file
        "error": "Missing required field: sku"  // The specific error for that row
      }
    ]
  }
}
```

### 4. Catalog Bulk Update Limits
**Code:** `CATALOG_BULK_LIMIT_EXCEEDED` (Status `400`)
Occurs when a bulk operation payload has too many rows.

```json
{
  "details": {
    "limit": 1000 // The maximum number of rows allowed per request
  }
}
```

### 5. Analytics Timezone Issues
**Code:** `ANALYTICS_UNSUPPORTED_TIMEZONE` (Status `400`)

```json
{
  "details": {
    "timezone": "Mars/Phobos" // The rejected timezone string sent by the client
  }
}
```

### 6. Analytics Date Range Limits
**Code:** `ANALYTICS_DATE_RANGE_EXCEEDED` (Status `400`)

```json
{
  "details": {
    "maxDays": 365 // The maximum queryable period in days
  }
}
```

### 7. Other Contextual Domain Errors
The backend frequently includes context variables inside the `details` object for general domain errors. For example:
- `PAYMENT_ORDER_NOT_FOUND` may include `{"orderId": "..."}`
- `STORE_SLUG_TAKEN` may include `{"slug": "..."}`

---

## Best Practices for Frontend Error Handling

1. **Always default to parsing `error.code`.** Do not write business logic dependent on `statusCode` limits (e.g., `if (statusCode === 400)`) unless parsing a generic networking failure. Use `if (error.code === 'AUTH_TOKEN_EXPIRED') { triggerLogout(); }`.
2. **Use `error.message` as a fallback.** If your application supports full i18n, map the backend `error.code` directly to a translation key. If the key is missing in your dictionary, display the backend's `error.message` directly to the user.
3. **Log the `requestId`.** If the error is an unexpected `INTERNAL_SERVER_ERROR`, present the `requestId` in the UI to help the user report it: *"An unexpected error occurred. If you contact support, please provide this ID: req-1234abc"*.
