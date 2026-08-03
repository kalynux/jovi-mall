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

### 7. File Upload Policy Violations
**Code:** `UPLOAD_POLICY_VIOLATION` (Status `400`)
Returned by `POST /api/files/upload` when one or more files fail the upload
security/policy pipeline (MIME sniffing, size, duplicate detection, virus scan,
etc.). Because several files are validated in one request, the `details.violations`
array can contain **multiple entries**, each scoped to a file via `fileIndex`.

```json
{
  "details": {
    "violations": [
      {
        "code": "MIME_NOT_ALLOWED",   // machine-readable reason — drive UI/i18n off this
        "message": "File type not allowed: application/x-executable",
        "fileIndex": 0,   // 0-based index into the uploaded files array (absent for request-wide violations)
        "metadata": { "detectedMimeType": "application/x-executable", "originalName": "aaron-burden-b9drVB7xIOI-unsplash.jpg" }   // optional extra context
      }
    ]
  }
}
```

*Frontend usage:* Map each `violation.fileIndex` back to the corresponding file in
your upload list and show the per-file reason inline. `violation.code` is one of:
`FILE_TOO_LARGE`, `MIME_NOT_ALLOWED`, `TOO_MANY_FILES`, `QUOTA_EXCEEDED`,
`VIRUS_DETECTED`, `PERMISSION_DENIED`, `TOTAL_SIZE_EXCEEDED`, `DUPLICATE_FILE`,
`MIME_TYPE_MISMATCH`, `POLYGLOT_DETECTED`, `UNDETECTABLE_TYPE`. See the
[File Management API](../vendor/file-management.md#post-apifilesupload) for the full
per-code reference.

Always read `details.violations[]`, never the top-level `message` — it is
`"Upload policy permissions violated"` only when a `PERMISSION_DENIED` rule fired,
and `"Upload policy violations found"` for everything else. `PERMISSION_DENIED` is
not expected from `POST /api/files/upload`, which is open to every authenticated
role; it belongs to the purpose-scoped upload routes (digital assets, delivery
proof, system files).

### 8. Other Contextual Domain Errors
The backend frequently includes context variables inside the `details` object for general domain errors. For example:
- `PAYMENT_ORDER_NOT_FOUND` may include `{"orderId": "..."}`
- `STORE_SLUG_TAKEN` may include `{"slug": "..."}`

### 9. Vendor <-> Agency Connection Errors
**Code:** `CONNECTION_INVALID_STATUS_TRANSITION` (Status `400`)
Returned by the [Agency Connections](../vendor/agency-connections.md) API when an action (e.g.
`approve`, `terminate`) doesn't apply to the connection's current status.

```json
{
  "details": {
    "from": "rejected",  // the connection's actual current status
    "to": "active"       // the status the attempted action would have produced
  }
}
```

Other codes in this family — see [Agency Connections](../vendor/agency-connections.md) and
[Vendor Connections](../agency/vendor-connections.md) for full context, no `details` payload:
`CONNECTION_NOT_FOUND` (404), `CONNECTION_VENDOR_NOT_FOUND` (404), `CONNECTION_ALREADY_EXISTS`
(409), `CONNECTION_NOT_PENDING` / `CONNECTION_NOT_PAUSED` / `CONNECTION_NOT_ACTIVE` (422),
`CONNECTION_NOT_REQUESTER` / `CONNECTION_NOT_APPROVER` / `CONNECTION_WRONG_REAPPROVAL_PARTY` (403).

### 10. Cash on Delivery (COD) Errors

The `COD_` family covers checkout eligibility, delivery-code verification, agent cash exposure,
deposits, remittances and discrepancies. Role-specific context:
[customer/orders.md](../customer/orders.md#cod), [agent/cod-cash.md](../agent/cod-cash.md),
[agency/cod-cash-management.md](../agency/cod-cash-management.md), [admin/cod.md](../admin/cod.md).

| Code | Status | When | `details` |
|---|---|---|---|
| `COD_NOT_AVAILABLE_FOR_DIGITAL` | 422 | COD checkout on a digital cart | — |
| `COD_AGENCY_NOT_SUPPORTED` | 422 | A delivery agency on the order doesn't handle COD | `{ agencyId, agencyName }` |
| `COD_ORDER_AMOUNT_EXCEEDS_LIMIT` | 422 | Order total above an agency's COD cap | `{ agencyName, maxOrderAmount, orderTotal }` |
| `COD_COLLECTION_NOT_FOUND` | 404 | No cash collection for the shipment (not COD / not picked up) | — |
| `COD_COLLECTION_ALREADY_COLLECTED` | 409 | Cash already recorded for this shipment | — |
| `COD_COLLECTION_NOT_COLLECTIBLE` | 422 | Shipment/collection state doesn't allow collection | `{ shipmentStatus }` or `{ collectionStatus }` |
| `COD_INVALID_CODE` | 422 | Wrong delivery code | `{ attemptsRemaining }` |
| `COD_CODE_ATTEMPTS_EXCEEDED` | 423 | Code locked after too many wrong attempts — resend required | — |
| `COD_CODE_RESEND_TOO_SOON` | 429 | Code (re)send rate limit | `{ retryInSeconds }` |
| `COD_AGENT_NOT_ASSIGNED` | 422 | COD shipment pickup attempted without an assigned agent | — |
| `COD_AGENT_EXPOSURE_EXCEEDED` | 422 | Assignment would exceed the agent's cash exposure limit | `{ currentExposure, additionalAmount, effectiveLimit }` |
| `COD_AGENT_TRUST_TOO_LOW` | 422 | Trust below COD threshold, or open cash-shortfall flag | `{ trustScore, minimum }` or `{ reason }` |
| `COD_AGENT_HAS_OUTSTANDING_CASH` | 422 | Agent unlink blocked by undeposited cash | `{ outstanding }` |
| `COD_DEPOSIT_INVALID_AMOUNT` | 422 | Deposit amount not a positive integer | `{ amount }` |
| `COD_DEPOSIT_EXCEEDS_BALANCE` | 422 | Deposit larger than the agent's held cash | `{ amount, outstanding }` |
| `COD_DEPOSIT_NOT_FOUND` | 404 | Unknown deposit, or not this agency's | — |
| `COD_DEPOSIT_ALREADY_RESOLVED` | 409 | Deposit already confirmed or rejected | `{ status }` |
| `COD_DEPOSIT_REFERENCE_REQUIRED` | 422 | Direct-to-platform deposit with no transfer reference | — |
| `COD_DEPOSIT_AGENCY_ALREADY_SETTLED` | 422 | Direct payment for cash the agency already remitted — pay the agency instead | `{ amount, agencyOwesPlatform, hint }` |
| `COD_DEPOSIT_WRONG_RECIPIENT` | 403 | Only the party the cash was handed to may confirm/reject it | `{ recipient, hint }` |
| `DELIVERY_AGENT_NOTIFICATION_NOT_FOUND` | 404 | Notification not found, or not this agent's | — |
| `DELIVERY_AGENT_NOTIFICATION_CHANNEL_NOT_VERIFIED` | 400 | Tried to enable an unverified secondary channel | `{ channel }` |
| `DELIVERY_AGENT_NOTIFICATION_DELIVERY_FAILED` | 502 | A secondary-channel delivery failed (in-app still recorded) | — |
| `COD_REMITTANCE_INVALID_AMOUNT` | 422 | Remittance amount not a positive integer | `{ amount }` |
| `COD_REMITTANCE_EXCEEDS_LIABILITY` | 422 | Declared amount (plus open declarations) above what the agency owes | `{ amount, pendingDeclared, outstanding }` |
| `COD_REMITTANCE_NOT_FOUND` | 404 | Unknown remittance | — |
| `COD_REMITTANCE_ALREADY_RESOLVED` | 409 | Remittance already confirmed/rejected | — |
| `COD_DISCREPANCY_NOT_FOUND` | 404 | Unknown discrepancy | — |
| `COD_DISCREPANCY_ALREADY_RESOLVED` | 409 | Discrepancy already closed | — |
| `PAYMENT_ORDER_IS_COD` | 422 | Online payment attempted for a cash-on-delivery order/checkout | `{ cartId? }` |

### Agent ↔ agency contracts

Full documentation: [agency/agent-roster.md](../agency/agent-roster.md) (canonical) and
[agent/agency-membership.md](../agent/agency-membership.md).

**The handshake** — request, approve, reject, withdraw:

| Code | HTTP | Description | Details |
|------|------|-------------|---------|
| `AGENT_MEMBERSHIP_ALREADY_EXISTS` | 409 | A live contract between this agent and agency already exists | `{ status, contractId }` |
| `CONTRACT_NOT_FOUND` | 404 | Unknown, **or** belongs to another party — never 403, so neither side can probe the other's roster | — |
| `CONTRACT_TRANSITION_NOT_PERMITTED` | 403 | Wrong party for this verb. **Keyed on whose TERMS are standing, not on who opened the contract**: the proposer may only `withdraw`, the counterparty may only `approve`/`reject`/`counter`. Also `suspend` raised by an agent | `{ transition, party, proposer, hint }` |
| `CONTRACT_INVALID_TRANSITION` | 409 | The contract is not in a status this transition can leave | `{ transition, from, allowedFrom }` |
| `AGENT_MEMBERSHIP_LIMIT_REACHED` | 422 | The agent is at their agency cap. Checked at **approval**, not at request | `{ current, max }` |
| `AGENT_KYC_NOT_VERIFIED` | 422 | Re-checked at approval, not trusted from request time | `{ kycStatus, hint }` |
| `AGENT_PLATFORM_BANNED` | 403 | A platform ban overrides every contract | `{ hint }` |
| `AGENT_NOT_FOUND` | 404 | `agentId` does not resolve | — |

**Two-party status requests** — pause, reactivate, terminate:

| Code | HTTP | Description | Details |
|------|------|-------------|---------|
| `CONTRACT_STATUS_REQUEST_NOT_FOUND` | 404 | Unknown, or not addressed to you | — |
| `CONTRACT_STATUS_REQUEST_NOT_PENDING` | 409 | Already resolved | `{ state }` |
| `CONTRACT_STATUS_REQUEST_ALREADY_PENDING` | 409 | One open request per contract per transition | `{ requestId }` |
| `CONTRACT_STATUS_REQUEST_NOT_YOURS` | 403 | You raised it; the counterparty resolves it | `{ requestedByRole, hint }` |
| `CONTRACT_HAS_OUTSTANDING_COD` | 422 | Termination blocked — the agent still holds that agency's cash. Scoped to the one contract | `{ outstandingCod, hint }` |
| `CONTRACT_HAS_UNPAID_EARNINGS` | 422 | Termination blocked — the agency still owes the agent | `{ outstandingPayment, hint }` |

**Negotiated terms**:

| Code | HTTP | Description | Details |
|------|------|-------------|---------|
| `CONTRACT_TERMS_REQUIRED` | 422 | An agent's join request stated terms but omitted `fee_split`. Coverage alone would leave their own proposal paying zero — omit `terms` entirely instead | `{ hint }` |
| `CONTRACT_TERMS_NOT_PROPOSED` | 422 | **Approving terms nobody proposed.** `termsProposedBy` is `null` — a bare agent join request, or a legacy contract whose split was never configured. The agency must propose first | `{ contractId, hint }` |
| `CONTRACT_TERMS_NOT_NEGOTIABLE` | 403 | A party wrote a term group that is not theirs. Agents may write `fee_split` and `coverage` only; `employment` and the COD threshold are nobody's to negotiate | `{ party, offending, negotiable, hint }` |
| `CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED` | 409 | `PATCH …/terms` on a live contract. Its agreed split is pricing deliveries right now — raise a proposal instead | `{ status, hint }` |
| `CONTRACT_FEE_SPLIT_INVALID` | 422 | A `percentage` split with no share, or a `flat` one with no fee. Checked on the patch **merged over the stored split**, so a partial update is not rejected for a field it does not touch | `{ model, hint }` |
| `CONTRACT_COD_THRESHOLD_OUT_OF_BOUNDS` | 422 | Outside the absolute per-contract bounds | `{ requested, min, max }` |
| `CONTRACT_COD_THRESHOLD_EXCEEDS_HEADROOM` | 422 | The agent's shared pool has no room — another agency's slice may be the cause | `{ requested, headroom, shortfall, hint }` |
| `CONTRACT_COD_THRESHOLD_BELOW_OUTSTANDING` | 422 | Cannot set a threshold beneath cash already held under the contract | `{ requested, outstandingBalance, hint }` |
| `CONTRACT_COVERAGE_OUTSIDE_AGENT_RADIUS` | 422 | An agency cannot grant coverage the agent never agreed to work | — |
| `CONTRACT_COVERAGE_REGION_NOT_COVERED` | 422 | **Assignment gate.** The delivery region is outside the regions this contract covers | `{ deliveryRegion, coveredRegions, hint }` |
| `CONTRACT_SHIPMENT_VALUE_EXCEEDED` | 422 | **Assignment gate.** The shipment is worth more than this contract's per-shipment ceiling | `{ shipmentValue, ceiling, hint }` |
| `CONTRACT_SETTLEMENT_EXCEEDS_OUTSTANDING` | 422 | A settlement larger than the balance it discharges | — |

**Terms proposals** — changes to a **live** contract, which are staged rather than applied:

| Code | HTTP | Description | Details |
|------|------|-------------|---------|
| `CONTRACT_TERMS_PROPOSAL_NOT_FOUND` | 404 | Unknown, **or** on a contract that is not yours — never 403, same rule as `CONTRACT_NOT_FOUND` | — |
| `CONTRACT_TERMS_PROPOSAL_NOT_PENDING` | 409 | Already accepted, rejected, withdrawn or superseded — possibly by a concurrent call | `{ state }` |
| `CONTRACT_TERMS_PROPOSAL_ALREADY_PENDING` | 409 | One open proposal per contract. Counter or cancel the open one | `{ proposalId, proposedByRole }` |
| `CONTRACT_TERMS_PROPOSAL_NOT_YOURS` | 403 | Answering your own proposal, or cancelling someone else's. `/resolve` and `/counter` are the counterparty's; `/cancel` is the author's | `{ proposedByRole, hint }` |

> **Reading a failed `approve`.** Guard order is terms → platform gates → COD pool, so
> `CONTRACT_TERMS_NOT_PROPOSED` means exactly what it says — nobody has made an offer — and not that
> something is wrong with the agent's account. Render it as "waiting on terms", not as an error.

Legacy roster codes, still live: `DELIVERY_AGENT_ALREADY_IN_AGENCY` (409),
`DELIVERY_AGENT_NOT_IN_AGENCY` (404), `DELIVERY_AGENT_HAS_ACTIVE_SHIPMENTS` (422),
`AGENT_MEMBERSHIP_NOT_FOUND` (404), `AGENT_MEMBERSHIP_NOT_APPROVED` (409 — despite the name, it
means "not **active**"; the code predates the status rename), `AGENT_MEMBERSHIP_NOT_PENDING` (409),
`AGENT_MEMBERSHIP_NOT_SUSPENDED` (409).

> `DELIVERY_INVITE_NOT_FOUND` and `DELIVERY_INVITE_ALREADY_PENDING` were **removed** with the
> email-invite endpoints. An agency now reaches an agent through the directory
> (`GET /api/agency/agents/browse` → `POST /api/agency/agents/requests`).

---

## Best Practices for Frontend Error Handling

1. **Always default to parsing `error.code`.** Do not write business logic dependent on `statusCode` limits (e.g., `if (statusCode === 400)`) unless parsing a generic networking failure. Use `if (error.code === 'AUTH_TOKEN_EXPIRED') { triggerLogout(); }`.
2. **Use `error.message` as a fallback.** If your application supports full i18n, map the backend `error.code` directly to a translation key. If the key is missing in your dictionary, display the backend's `error.message` directly to the user.
3. **Log the `requestId`.** If the error is an unexpected `INTERNAL_SERVER_ERROR`, present the `requestId` in the UI to help the user report it: *"An unexpected error occurred. If you contact support, please provide this ID: req-1234abc"*.
