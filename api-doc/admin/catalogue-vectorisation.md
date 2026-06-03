# Admin — Catalogue & Vectorisation API

Admin-only endpoints for catalogue management and the vectorisation pipeline.

> [!IMPORTANT]
> **Authentication Required**
> All endpoints require:
> - `Authorization: Bearer <access_token>` header
> - `admin` role

---

## Table of Contents

- [Bulk Vectorise Products](#bulk-vectorise-products)

---

## Bulk Vectorise Products

```http
POST /api/admin/products/bulk-vectorise
```

Triggers the vectorisation pipeline for a specific list of products, or for **all eligible products** across the entire catalogue.

Unlike the automatic per-product fire-and-forget triggered by vendor actions, this endpoint is **synchronous** — it waits for the entire batch to complete and returns a full summary. Use it for:

- Manual re-runs after a previous vectorisation failed
- Initial bulk indexing when first onboarding a batch of products
- Reconciliation after a vectoriser outage

### Eligibility Rules (same as automatic)

A product is included in the batch **only if** all of the following are true:

| Condition | Value |
|-----------|-------|
| `status` | `active` |
| `vectorisationEnabled` | `true` |
| `title`, `description`, `category` | Non-empty |

Products that don't qualify are listed in `errors` with a reason of `"Not eligible for vectorisation"`.

---

### Request Body

```json
{
  "productIds": ["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439012"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `productIds` | string[] | No | Array of 24-char hex ObjectIds. **Omit the field entirely (or pass an empty array) to vectorise ALL eligible products** across all vendors. Use with caution on large catalogues. |

---

### Response `200`

Returns a summary after all products have been processed:

```json
{
  "success": true,
  "data": {
    "succeeded": 42,
    "failed": 2,
    "total": 44,
    "errors": [
      {
        "productId": "507f1f77bcf86cd799439013",
        "reason": "Not eligible for vectorisation (status, flag, or completeness)"
      },
      {
        "productId": "507f1f77bcf86cd799439014",
        "reason": "Batch request failed: network error"
      }
    ]
  },
  "message": "Vectorisation complete: 42 succeeded, 2 failed out of 44 total"
}
```

**Response fields:**

| Field | Type | Description |
|-------|------|-------------|
| `succeeded` | number | Products that were successfully vectorised (`vectorisationStatus = "completed"`) |
| `failed` | number | Products where vectorisation failed (includes ineligible, not-found, and API error cases) |
| `total` | number | Total number of product IDs that were processed |
| `errors` | array | Per-product failure details — always present (empty array if no failures) |

---

### Behaviour Details

1. **No IDs provided** → the server queries MongoDB for all products matching `{ status: "active", vectorisationEnabled: true, vectorisationStatus: { $in: ["not_started", "pending", "failed"] } }` and vectorises all of them.

2. **Specific IDs provided** → only those products are processed. Products that don't exist or don't belong to any vendor are returned in `errors`.

3. **Pending mark** → all eligible products are set to `vectorisationStatus: "pending"` before the batch is sent. If the server crashes mid-run, those products will remain `"pending"` until the reconciliation script or another admin run clears them.

4. **Retry logic** → the batch POST to the vectoriser is retried up to 3 times with exponential backoff (1s, 2s) on transient failures (network errors or 5xx responses). A 4xx from the vectoriser is not retried.

5. **Timeout** → 120 seconds for the entire batch. If the vectoriser takes longer, the request will timeout and all pending products will be set to `"failed"`.

---

### Error Responses

| Status | Code | Reason |
|--------|------|--------|
| `400` | `VALIDATION_ERROR` | `productIds` contains non-ObjectId strings |
| `401` | `AUTH_MISSING_TOKEN` | No auth token |
| `403` | `AUTH_FORBIDDEN` | Authenticated user is not admin |

> A `200` response with `failed > 0` is **not** an HTTP error — it means the endpoint ran successfully but some individual products could not be vectorised. Check `errors` for details.

---

## Reconciliation Script

For scheduled or CI-driven reconciliation, use the server-side script instead of this endpoint:

```bash
# Re-vectorise all stale products
npx ts-node src/scripts/reconcile-vectorisation.ts

# Dry run — print qualifying products without making changes
npx ts-node src/scripts/reconcile-vectorisation.ts --dry-run

# Limit to one vendor
npx ts-node src/scripts/reconcile-vectorisation.ts --vendor-id=<vendorId>

# Custom batch size and total limit
npx ts-node src/scripts/reconcile-vectorisation.ts --batch-size=100 --limit=1000
```

Exit codes: `0` = all succeeded, `1` = partial failures, `2` = fatal error (DB connection, etc.).
