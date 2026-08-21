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
    "category": "string",   // NEW — one of nine values, see below. Always present.
    "details"?: {}          // Optional object with supplemental error data
  }
}
```

---

## `error.category` — the nine-value taxonomy

**New in Phase 16.** Always present, on every error, from all three backend services
(jovi-mall, wi-admin and geo-tracker emit the same nine strings).

It exists so a client can behave sensibly about an error it has **no specific handling
for** — which is most of them, since the registry has 547 codes. Branch on `code` when you
have something particular to do; fall back to `category` for everything else.

| `category` | Means | What a client should generally do |
|---|---|---|
| `authentication` | Not signed in, session ended, or the account cannot sign in at all | Send them to sign in. Do **not** retry |
| `authorization` | Signed in, but this is not theirs | Show a "no access" state. Do not retry |
| `validation` | The request was malformed or failed a field rule | Surface it against the form. `details.fields` is populated for schema failures |
| `not_found` | No such record — **or** it exists and is not yours | Treat as absent. Never infer existence from a 404 |
| `conflict` | The state moved underneath you | **Reload, then retry** — do not resend the same intent |
| `business_rule` | Well-formed and refused on purpose | Show `message`; it explains which rule. This is not a fault |
| `rate_limit` | Too many requests | Back off. Respect `Retry-After`; see [rate-limits.md](../rate-limits.md) |
| `external_service` | A third party (gateway, maps, messaging) did not respond | Offer a retry. Not the user's fault and not fixable by them |
| `internal` | Our fault | Show the generic message **and the `requestId`**. Offer a retry |

### Two categories are deliberately opaque

For **`external_service`** and **`internal`**:

- `message` is a fixed, generic sentence — never the underlying failure.
- **`details` is omitted entirely.**

This is **permanent and applies in every environment**, including development. Do not build
a client that expects to read a cause out of a 5xx: it was never a stable contract, and as
of Phase 16 it is not sent at all. The information still exists — it is journaled internally
against the `requestId`, and support staff and administrators can look it up.

`code` is still real on a 5xx (`PAYMENT_INITIATION_FAILED`, not a generic stand-in), so
specific handling remains possible.

> **This is what makes `requestId` matter.** On a 5xx it is the only handle anyone has.
> Show it. A user who can quote `req_abc123` turns an unactionable "something went wrong"
> into a support conversation that resolves.

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

### 1b. Request-Level Rejections (malformed before any schema ran)

**Codes:** `REQUEST_BODY_INVALID` (400) · `REQUEST_BODY_TOO_LARGE` (413) ·
`REQUEST_MEDIA_TYPE_UNSUPPORTED` (415)

Raised when the body could not be parsed at all, so no route and no schema was reached. All
three are `category: "validation"` and carry no `details`.

Previously these returned **`500 INTERNAL_SERVER_ERROR`** — the server blaming itself for
the caller's payload. If you have a workaround keyed on that, remove it. The three are
distinct because the remedies are: fix the JSON, send less, send a different `Content-Type`.

### 1c. Rate Limiting

**Code:** `RATE_LIMIT_EXCEEDED` (429), `category: "rate_limit"`

```json
{ "details": { "retryAfterSeconds": 60 } }
```

Also carries `RateLimit`, `RateLimit-Policy` and `Retry-After` headers (IETF draft-7).
**Prefer the headers**; the body field is a convenience. Full policy:
[rate-limits.md](../rate-limits.md).

Distinct from `COD_CODE_RESEND_TOO_SOON`, which is also a 429 but is a per-resource cooldown
on one delivery code rather than a request-volume ceiling — and clears differently.

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
**Code:** `UPLOAD_POLICY_VIOLATION` (Status `400`, or `413` for `FILE_TOO_LARGE`)
Returned by `POST /api/files/upload` and `POST /api/files/upload/video` when one or more
files fail the upload security/policy pipeline (MIME sniffing, size, duplicate detection,
virus scan, etc.) **or one of the four cheap pre-pipeline gates** (no files, too many files,
too large, unsupported claimed type). It is the **only** top-level code either route
produces for a refusal. Because several files are validated in one request, the `details.violations`
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
your upload list and show the per-file reason inline. `violation.code` is one of the eleven
pipeline codes — `FILE_TOO_LARGE`, `MIME_NOT_ALLOWED`, `TOO_MANY_FILES`, `QUOTA_EXCEEDED`,
`VIRUS_DETECTED`, `PERMISSION_DENIED`, `TOTAL_SIZE_EXCEEDED`, `DUPLICATE_FILE`,
`MIME_TYPE_MISMATCH`, `POLYGLOT_DETECTED`, `UNDETECTABLE_TYPE` — **or `NO_FILES_UPLOADED`**,
which the controller's cheap pre-pipeline gate raises through the same shape. See the
[File Management API](../vendor/file-management.md#post-apifilesupload) for the full
per-code reference.

Always read `details.violations[]`, never the top-level `message` — it is the fixed string
`"Upload policy violations found"` for **every** case, whichever rule fired, so it tells a
caller nothing. (It used to vary; it no longer does.) `PERMISSION_DENIED` is not expected
from `POST /api/files/upload`, which is open to every authenticated role; it belongs to the
purpose-scoped upload routes (digital assets, delivery proof, system files).

The **statusCode varies** on this code: `413` when the violation is `FILE_TOO_LARGE`,
`400` otherwise. Branch on the violation, not on the status.

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
| `CONTRACT_COVERAGE_REGION_INVALID` | 400 | **Terms-write gate.** A proposed `coverage.regions` entry is not a region of the agency's country — a city, or a typo. Region keys come from `locations.json`, the same catalogue the agency's own coverage areas use; a localized name (`"Extrême-Nord"`) is accepted and canonicalised. `allowedRegions` is the full catalogue, so a picker can be repaired from the error | `{ invalid, requiredCountry, allowedRegions }` |
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

## Agency storage: warehoused products and their stock

The agency-facing product actions
([Agency → Inventory](../agency/inventory.md)) and the two-sided stock flow
([Agency](../agency/stock-requests.md) · [Vendor](../vendor/stock-requests.md)).

| Code | HTTP | Meaning | `details` |
|---|---|---|---|
| `INVENTORY_STOCK_LEVEL_NOT_FOUND` | 404 | No such stock row for this agency — another agency's row 404s, never 403s | — |
| `INVENTORY_LOCATION_UNKNOWN` | 422 | The depot named is not one of the caller's own | `{ locationId }` |
| `INVENTORY_PRODUCT_NOT_STORED_HERE` | 404 | The caller does not warehouse this product. Same 404-not-403 rule | — |
| `INVENTORY_PRODUCT_NOT_SUSPENDABLE` | 422 | Only an `active` product can be storage-suspended. A draft or archived one is not on sale, so suspending it would achieve nothing but block editing | — |
| `INVENTORY_PRODUCT_NOT_AGENCY_SUSPENDED` | 422 | Unsuspend target is not suspended, or was suspended **by someone else / for another reason** — a system delivery-agency suspension is not an agency's to lift | `{ status, reason }` |
| `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` | 422 | The product cannot go back on sale: the activation gate still fails | `{ blockers: [{ code, message, details }] }` |

> **`INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` carries a checklist, not a single cause.**
> Render `details.blockers` as a list — each `message` is written to be shown, and it is
> what tells the agency what to raise with the vendor. The product stays suspended.

| Code | HTTP | Meaning | `details` |
|---|---|---|---|
| `STOCK_REQUEST_NOT_FOUND` | 404 | Unknown, **or** not a request the caller is party to — never 403 | — |
| `STOCK_REQUEST_ALREADY_PENDING` | 409 | One open request per SKU. Withdraw yours, or answer theirs | `{ requestId, requestedByRole, hint }` |
| `STOCK_REQUEST_NOT_PENDING` | 409 | Already approved, rejected or withdrawn — possibly by the other party a moment ago | `{ status }` |
| `STOCK_REQUEST_NOT_YOURS` | 403 | Wrong verb for your side: `approve`/`reject` belong to the counterparty, `withdraw` to the author | `{ availableActions }` |
| `STOCK_REQUEST_STALE` | 409 | The product stopped being warehoused by that agency while the request stood | — |
| `STOCK_REQUEST_NO_CHANGE` | 422 | The requested quantity is already the recorded one | `{ quantity }` |
| `CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK` | 422 | A warehoused product cannot have unlimited stock. Fires as an activation blocker, on a `PATCH /products/:id` moving pickup to `agency_storage`, and on a request asking to go unlimited | `{ variant }` or `{ variant, variants }` |

> **`STOCK_REQUEST_NOT_PENDING` means reload, not retry.** It is a compare-and-set miss:
> the row exists and somebody resolved it first. Re-sending would apply an intent formed
> against a state that no longer holds. Refetch the request and show its outcome.

> **Never re-implement the authority table behind `STOCK_REQUEST_NOT_YOURS`.** Every
> request DTO carries `availableActions` — the server's verdict for the current viewer —
> and rendering buttons from anything else is how a client offers a verb the API refuses.

---

## Blog / editorial

The public reader ([public/articles.md](../public/articles.md)). The editor moved to wi-admin at
Phase 5 Part A (`admin/docs/api/content.md`), and it raises these **same codes** from its own
registry — deliberately, so a client sees one vocabulary across the cutover. The three below that
a logged-out visitor can reach are still raised here, by the public reader.

The first three are reachable by a **logged-out visitor**, so their `message` is written to be shown.

| Code | HTTP | Meaning | `details` |
|---|---|---|---|
| `BLOG_ARTICLE_NOT_FOUND` | 404 | No published article at this `(locale, slug)` — including when the article exists but not in that language. **No fallback to another locale, ever** | `{ locale, slug }` |
| `BLOG_ARTICLE_MOVED` | 404 | The slug is a **retired** one. The article is at `details.slug` | `{ locale, slug, previousSlug, id }` |
| `BLOG_ARTICLE_GONE` | 410 | Archived on purpose. Send the reader to the category hub | `{ locale, slug, categoryKey }` |
| `BLOG_SLUG_RESERVED` | 400 | Slug is `category`, `page` or `index` — each collides with a route | `{ locale, slug, reserved }` |
| `BLOG_AUTHOR_NOT_FOUND` | 404 | `authorId` does not exist | `{ id }` or `{ authorId }` |
| `BLOG_ARTICLE_KEY_TAKEN` | 409 | Article `id` already used | `{ id }` |
| `BLOG_SLUG_TAKEN` | 409 | Another article holds this `(locale, slug)` — **including as a retired slug** | `{ locale, slug }` |
| `BLOG_ARTICLE_ALREADY_PUBLISHED` | 409 | Publishing an already-published article | `{ id }` |
| `BLOG_ARTICLE_DELETE_NOT_ALLOWED` | 409 | The article has been live; its URL may have inbound links. **Archive it instead** | `{ id, publishedAt }` |
| `BLOG_AUTHOR_KEY_TAKEN` | 409 | Author `id` already used | `{ id }` |
| `BLOG_AUTHOR_IN_USE` | 409 | The byline is credited on articles. Re-point them first | `{ id, articleCount }` |
| `BLOG_ARTICLE_NOT_PUBLISHABLE` | 422 | Publish checklist failed | `{ id, blockers: string[] }` |

> **`BLOG_ARTICLE_MOVED` is a 404 the frontend turns into a 301.** The API can only redirect its own
> URL; the address that needs the permanent redirect is the *page*. Read `details.slug` and call
> `permanentRedirect(...)` — a `fetch` that followed an HTTP redirect would render the article at the
> stale URL, which is the duplicate-content problem the redirect exists to prevent.

> **`BLOG_ARTICLE_NOT_PUBLISHABLE` carries a checklist, not a single cause** — the same convention as
> `INVENTORY_PRODUCT_UNSUSPEND_BLOCKED`. Render every `details.blockers[]` entry.

> **Malformed article bodies are `VALIDATION_ERROR`, not a blog-specific code.** A locale-prefixed
> `href`, a duplicate heading id, an image without dimensions, an unknown block type and an unknown
> key on a known block all fail the Zod schema — `details.fields[]` gives the path
> (`translations.0.body.3.href`).

---

## Best Practices for Frontend Error Handling

1. **Always default to parsing `error.code`.** Do not write business logic dependent on `statusCode` limits (e.g., `if (statusCode === 400)`) unless parsing a generic networking failure. Use `if (error.code === 'AUTH_TOKEN_EXPIRED') { triggerLogout(); }`.
2. **Use `error.message` as a fallback.** If your application supports full i18n, map the backend `error.code` directly to a translation key. If the key is missing in your dictionary, display the backend's `error.message` directly to the user.
3. **Use `error.category` as your default branch.** You will never have specific handling for
   all 547 codes. The category tells you the four things that actually change client
   behaviour: is it worth retrying, should the user re-authenticate, is it their input, or is
   it ours.
4. **Log the `requestId`.** If the error is an unexpected `INTERNAL_SERVER_ERROR`, present the `requestId` in the UI to help the user report it: *"An unexpected error occurred. If you contact support, please provide this ID: req-1234abc"*.
