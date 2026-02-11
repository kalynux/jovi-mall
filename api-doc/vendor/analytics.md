# Vendor Analytics API

**Base Path:** `/api/vendor/analytics`

**Authentication Required:** Yes (Vendor role)

**Description:** Analytics endpoints provide aggregated metrics for vendor business intelligence. All endpoints support timezone-aware date ranges and return explicit error codes when data is unavailable.

---

## Core Concepts

### Date Range Parameters
- **Timezone-Aware:** Date boundaries calculated in vendor's timezone
- **Max Range:** 365 days
- **Format:** ISO 8601 date strings (YYYY-MM-DD)

### Data Availability Contract
- **No Silent Zeros:** Returns `503 AGGREGATION_NOT_READY` when data unavailable
- **Explicit Staleness:** `lastCalculatedAt` timestamp indicates freshness
- **Immutable Metrics:** GMV and orderCount never change retroactively

### Fiscal Calendar
- **Locked to Gregorian:** Only `'gregorian'` calendar supported
- **Hard Validation:** Non-gregorian values return `400 INVALID_FISCAL_CALENDAR`

---

## Endpoints

### GET /api/vendor/analytics/dashboard

Get overview metrics for dashboard display.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `timezone` | string (IANA) | No | Vendor timezone (default: vendor's timezone) |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` (default: gregorian) |

**Response (200 OK):**

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
- `data.bookings.*` - Booking-related metrics
- `meta.lastCalculatedAt` - Most recent aggregation timestamp in range

**Error Responses:**

```json
// 400 - Invalid date range
{
  "error": "INVALID_DATE_RANGE",
  "message": "Start date must be before or equal to end date"
}

// 400 - Range too large
{
  "error": "DATE_RANGE_EXCEEDED",
  "message": "Date range cannot exceed 365 days"
}

// 503 - Data not available
{
  "error": "AGGREGATION_NOT_READY",
  "message": "No analytics data available for vendor XXX in range 2026-02-01 to 2026-02-28. Aggregation may not have run yet or vendor has no data for this period."
}
```

---

### GET /api/vendor/analytics/sales

Get detailed sales metrics with optional daily breakdown.

**Query Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string (ISO date) | Yes | Start date (YYYY-MM-DD) |
| `to` | string (ISO date) | Yes | End date (YYYY-MM-DD) |
| `breakdown` | enum | No | `'daily'` or `'none'` (default: none) |
| `timezone` | string (IANA) | No | Vendor timezone |
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
| `limit` | number | No | Top N products (1-50, default: 5) |
| `timezone` | string (IANA) | No | Vendor timezone |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` |

**Response (200 OK):**

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
| `timezone` | string (IANA) | No | Vendor timezone |
| `fiscalCalendar` | enum | No | Must be `'gregorian'` |

**Response (200 OK):**

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

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `INVALID_DATE_RANGE` | 400 | Start date after end date, or invalid date format |
| `DATE_RANGE_EXCEEDED` | 400 | Date range exceeds 365 days |
| `UNSUPPORTED_TIMEZONE` | 400 | Invalid IANA timezone string |
| `INVALID_FISCAL_CALENDAR` | 400 | Fiscal calendar must be 'gregorian' |
| `AGGREGATION_NOT_READY` | 503 | No data available for requested period |

---

## Data Aggregation Details

### Scheduled Aggregation
- **Frequency:** Daily at 2:00 AM server time
- **Scope:** All active vendors
- **Timezone-Aware:** Each vendor's data aggregated in their timezone

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
   try {
     const response = await fetch('/api/vendor/analytics/dashboard?from=2026-02-01&to=2026-02-28');
     if (response.status === 503) {
       // Show "Data not yet available" message
       return;
     }
     const data = await response.json();
   } catch (error) {
     // Handle network errors
   }
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
