# Review moderation — `/api/internal/admin/reviews`

**Verified against source on 2026-09-08** — the four routes, the `ModerationQueueQuerySchema` filters and limits, the `.strict()` reject body (`reason` 3-500 required), the `REVIEW_NOT_PENDING` compare-and-set with `details.status`, and the `meta.totalPages` naming, against `jovi-mall/src/modules/reviews/{routes/admin-review.routes.ts,controllers/admin-review.controller.ts,validators/review.validator.ts,services/review.service.ts}`.

> **wi-admin only.** Service token (`INTERNAL_ADMIN_SERVICE_TOKEN`) + `X-Actor-Id`, exactly
> like every other router on this prefix. There is **no public twin** and there must not be
> one — see [internal-service-api.md](./internal-service-api.md).
>
> The domain contract (what a review is, who may write one, what the aggregates feed) is
> [../reviews.md](../reviews.md). This page is the moderation surface alone.

---

## Why this is delegated rather than done against the database

The ordinary reason (ADR-004 D-2), and here it is unusually concrete. A moderation verdict
is three things in one operation:

1. a **compare-and-set** on `status: 'pending'`, so two moderators cannot both decide;
2. a **recompute** of every aggregate the review contributes to — the product's rating, or
   the agent's *and* the agency's;
3. for a delivery review, an **immediate trust recompute** of that agent, which after
   Phase 6 Step 11 moves their COD cash limit.

A second writer flipping `status` in `reviews` would leave (2) and (3) unfired, silently,
with the storefront's rating and the agent's trust score both stale and nothing anywhere
reporting it.

wi-admin may read `reviews` and `review_aggregates` **directly** for a report. It calls in to
*decide* one. Same read-a-record / delegate-a-verdict split as ADR-009 D-1.

---

## What lands in the queue

Not everything. **A review carrying free text is held; a bare star rating publishes
immediately.** The reasoning is in [../reviews.md § 3](../reviews.md#3--moderation-and-where-a-review-lands);
the operational consequence is that this queue contains prose and nothing else, so every row
in it has something for a human to actually read.

---

## `GET /`

The queue. Defaults to `status=pending`, **oldest first** — a queue is worked front to back,
and the row that has waited longest is the one somebody is owed an answer about. Every other
listing in this module is newest-first; this one is the exception on purpose.

| Query | |
|---|---|
| `status` | `pending` (default) · `published` · `rejected` |
| `subjectType` | `product` · `delivery` |
| `authorRole` | `customer` · `vendor` · `agency` |
| `page`, `limit` | `limit` ≤ 100, default 20 |

```json
{
  "success": true,
  "data": [
    {
      "id": "507f1f77bcf86cd799439088",
      "subjectType": "delivery",
      "subjectId": "507f1f77bcf86cd799439077",
      "rating": 1,
      "title": "Never showed up",
      "body": "…",
      "status": "pending",
      "publishedAt": null,
      "createdAt": "2026-08-21T09:00:00.000Z",

      "authorUserId": "507f1f77bcf86cd799439055",
      "authorRole": "customer",
      "targets": {
        "productId": null,
        "agentId": "507f1f77bcf86cd799439022",
        "agencyId": "507f1f77bcf86cd799439033",
        "vendorId": "507f1f77bcf86cd799439044"
      },
      "evidence": { "orderId": "507f1f77bcf86cd799439066", "shipmentId": "507f1f77bcf86cd799439077" },
      "moderation": null
    }
  ],
  "meta": { "total": 7, "page": 1, "limit": 20, "totalPages": 1 }
}
```

> ⚠ **`meta` here says `totalPages`, not `pages`.** The shared envelope in
> [`../README.md`](../README.md#the-response-envelope-read-this-first) names the field `pages`,
> and every other paginated list on this surface uses that name. This controller renames it on
> the way out (`admin-review.controller.ts:43-47`), so a client keying on `pages` reads
> `undefined` on this endpoint alone.

**`evidence` is what eligibility resolved**, snapshotted at write time. It is there so a
moderator can check the claim — this review is about *that* shipment on *that* order — rather
than taking the author's word for it. It is not re-derived on read, deliberately: an order
refunded or a shipment reassigned afterwards must not retroactively invalidate a review that
was legitimately earned.

**`targets` is what the rating attaches to**, not what was reviewed. For a delivery, the
subject is a shipment and the targets are the agent and the agency. `targets.vendorId` on a
product review is recorded and **not aggregated** — no surface reads a vendor's rating today.

---

## `GET /:id`

One review, same shape. `404 REVIEW_NOT_FOUND`.

---

## `POST /:id/publish`

Let it through. `200`, the updated review.

A **compare-and-set on `pending`**: a losing moderator gets `409 REVIEW_NOT_PENDING` carrying
`details.status` rather than overwriting the winner. Reload and look again — do not retry.

Publishing recomputes every aggregate the review contributes to, and for a delivery review
nudges the agent's trust recompute.

---

## `POST /:id/reject`

```json
{ "reason": "Contains a competitor's phone number" }
```

`reason` is **required**, 3–500 characters, `.strict()`. Unlike the optional reasons
elsewhere in this API: a rejection is the moderator's own judgement rather than a rule the
platform applied, and it is never shown to the author, so its only reader will be the next
moderator looking at the same account. A blank one makes the record worthless at exactly the
moment somebody needs it. Same position `POST /agencies/:id/reject` takes.

**The rejected review then counts for nothing, its star included.** The aggregate is
recomputed over published rows only, so exclusion is a property of the query rather than of a
subtraction somebody remembered to make.

Same compare-and-set and same `409 REVIEW_NOT_PENDING` as publish.

### There is no un-reject

Deliberately, and it is the same position the agency KYC verdict takes. A two-way toggle on a
moderation verdict makes the audit trail ambiguous about what was ever live. If a rejection
was wrong, the author may not resubmit either — one review per author per subject is a unique
index — so treat a rejection as final and handle a genuine mistake as a support matter.

---

## The moderator's identity

`req.auth` on this path is **synthesised from headers** — administrators hold no `users` row
in `jovi_mall`, so `moderation.byUserId` is an id that resolves to nothing in this database.
That is the deliberate trade ADR-004 D-1 records, and `moderation.bySource: "admin"` is what
makes the dangling reference legible rather than mysterious. **Never `.populate()` it.**

```json
"moderation": {
  "byUserId": "66c0…",
  "bySource": "admin",
  "at": "2026-08-21T11:04:00.000Z",
  "reason": "Contains a competitor's phone number"
}
```

---

## Errors

| Code | Status | When |
|---|---|---|
| `REVIEW_NOT_FOUND` | 404 | no such review |
| `REVIEW_NOT_PENDING` | 409 | already moderated — `details.status` says how |
| `VALIDATION_ERROR` | 400 | missing or over-long `reason`, unknown key |

---

## Not built here

- **No delete.** A review is moderated, never removed. `rejected` already means "counts for
  nothing", and a delete would also destroy the moderation record explaining why.
- **No author-facing notification.** A held or rejected review tells its author nothing
  beyond the `status` on `GET /api/{role}/reviews`. Notifying on a rejection would mean
  publishing the moderator's private reason, or writing a second one for the author — a
  product decision nobody has taken.
- **No bulk verbs.** Each verdict is one judgement about one piece of prose.
