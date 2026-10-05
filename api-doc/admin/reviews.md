# Review moderation — `/api/internal/admin/reviews`

**Rewritten 2026-10-05 against source:** the five routes, `AdminReviewQuerySchema`,
`ReviewModerationReasonSchema` / `RepublishReviewSchema`, the `REVIEW_STATUS_CONFLICT`
compare-and-set with `details.status`, and `meta.totalPages`, in
`jovi-mall/src/modules/reviews/{routes/admin-review.routes.ts,controllers/admin-review.controller.ts,validators/review.validator.ts,services/review.service.ts,repositories/review.repository.ts}`.

> **wi-admin only.** Service token (`INTERNAL_ADMIN_SERVICE_TOKEN`) + `X-Actor-Id`, exactly
> like every other router on this prefix. There is **no public twin** and there must not be
> one — see [internal-service-api.md](./internal-service-api.md). The dashboard-facing
> surface is wi-admin's `/api/v1/reviews` (`admin/api-doc/api/reviews.md`).
>
> The domain contract (what a review is, who may write one, what the aggregates feed) is
> [../reviews.md](../reviews.md). This page is the moderation surface alone.

---

## ⚠ What changed on 2026-10-05

**Every review now publishes on submission, prose included** (owner decision). Until then a
review carrying a title or body was written `pending` and waited for a moderator, and this
surface was an approval queue (`publish` / `reject`). No administrator could reach that queue,
so written reviews stayed invisible indefinitely.

Moderation is now **after the fact**, with three verbs on an already-public review:

| Verb | From | To | Aggregate | The author afterwards |
|---|---|---|---|---|
| `POST /:id/unpublish` | `published` | `unpublished` | its star leaves | sees it as `unpublished` in their own list; **cannot** write another review of that subject |
| `POST /:id/republish` | `unpublished` | `published` | its star returns | sees it `published` |
| `DELETE /:id` | any | soft-deleted (`deletedAt`) | its star leaves (if it counted) | it is gone from their list; they **may write a new one** |

`publish` and `reject` are gone, and so are the statuses `pending` and `rejected`
(`migrate:reviews-publish-all` published every held row and renamed `rejected` to
`unpublished`). `REVIEW_NOT_PENDING` became `REVIEW_STATUS_CONFLICT`.

---

## Why this is delegated rather than done against the database

The ordinary reason (ADR-004 D-2), and here it is unusually concrete. Every verb does three
things in one operation:

1. a **compare-and-set** (on the from-status, or on `deletedAt: null`), so two administrators
   cannot both act;
2. a **recompute** of every aggregate the review contributes to — the product's rating, or
   the agent's *and* the agency's;
3. for a delivery review, an **immediate trust recompute** of that agent, which after
   Phase 6 Step 11 moves their COD cash limit.

A second writer flipping `status` in `reviews` would leave (2) and (3) unfired, silently.
wi-admin reads `reviews` **directly** for its list and calls in to act on one.

---

## `GET /`

Every live (not deleted) review, **newest first**, every status unless filtered.

| Query | |
|---|---|
| `status` | `published` · `unpublished` |
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
      "status": "unpublished",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "createdAt": "2026-10-05T09:00:00.000Z",

      "authorUserId": "507f1f77bcf86cd799439055",
      "authorRole": "customer",
      "targets": {
        "productId": null,
        "agentId": "507f1f77bcf86cd799439022",
        "agencyId": "507f1f77bcf86cd799439033",
        "vendorId": "507f1f77bcf86cd799439044"
      },
      "evidence": { "orderId": "507f1f77bcf86cd799439066", "shipmentId": "507f1f77bcf86cd799439077" },
      "moderation": {
        "action": "unpublished",
        "byUserId": "66c0…",
        "bySource": "admin",
        "at": "2026-10-05T11:04:00.000Z",
        "reason": "Abusive language"
      }
    }
  ],
  "meta": { "total": 7, "page": 1, "limit": 20, "totalPages": 1 }
}
```

> ⚠ **`meta` here says `totalPages`, not `pages`.** The shared envelope in
> [`../README.md`](../README.md#the-response-envelope-read-this-first) names the field `pages`;
> this controller renames it on the way out. wi-admin's own list reads the collection directly
> and answers `pages`, so nothing consumes this name today.

**`evidence` is what eligibility resolved**, snapshotted at write time, so an administrator
can check the claim (this review is about *that* shipment on *that* order).

**`targets` is what the rating attaches to**, not what was reviewed. `targets.vendorId` is
recorded and **not aggregated**.

**`moderation` is the LAST action only** — each one overwrites it. The full history is
wi-admin's audit log, which records every action with its actor before it is performed.

**`publishedAt` is when the text first went public.** Unpublish leaves it; republish keeps it,
except on a row that was never public (a review rejected under the old rule), where republish
stamps it then.

---

## `GET /:id`

One live review, same shape. `404 REVIEW_NOT_FOUND` if absent or deleted.

---

## `POST /:id/unpublish`

```json
{ "reason": "Contains a competitor's phone number" }
```

`reason` is **required**, 3–500 characters, `.strict()`. It is never shown to the author or the
public; its only reader is the next administrator. `200`, the updated review.

A **compare-and-set on `published`**: an administrator who loses a race, or acts on a review
that is already hidden, gets `409 REVIEW_STATUS_CONFLICT` carrying `details.status`. Reload —
do not retry.

## `POST /:id/republish`

Body `{}` or `{ "reason": "…" }` (optional, 3–500). Compare-and-set on `unpublished`; same
`409 REVIEW_STATUS_CONFLICT`. `200`, the updated review.

## `DELETE /:id`

```json
{ "reason": "Spam" }
```

`reason` is **required**, 3–500 characters, sent as a JSON body on the `DELETE`. Works in any
status. A **soft** delete (`deletedAt` stamped, `moderation.action: "deleted"`), compare-and-set
on `deletedAt: null`; a second delete answers `404 REVIEW_NOT_FOUND`. `200`, the review as it
was deleted.

The row is kept for the record, but it leaves every surface and every aggregate — and it
**frees the author's slot**, because `review_one_live_per_author_per_subject` is partial on
`deletedAt: null`. There is no undelete.

---

## The moderator's identity

`req.auth` on this path is **synthesised from headers** — administrators hold no `users` row
in `jovi_mall`, so `moderation.byUserId` is an id that resolves to nothing in this database.
`moderation.bySource: "admin"` is what makes that legible. **Never `.populate()` it.**

---

## Errors

| Code | Status | When |
|---|---|---|
| `REVIEW_NOT_FOUND` | 404 | no such review, or already deleted |
| `REVIEW_STATUS_CONFLICT` | 409 | unpublish on a non-published review, or republish on a non-unpublished one — `details.status` says where it is |
| `VALIDATION_ERROR` | 400 | missing or out-of-range `reason`, unknown key, an old status (`pending`/`rejected`) as a filter |

---

## Not built here

- **No author-facing notification.** An unpublished or deleted review tells its author
  nothing beyond its `status` (or its absence) on `GET /api/{role}/reviews` — owner decision
  2026-10-05: shown as hidden, no message, never the reason.
- **No bulk verbs.** Each action is one judgement about one review.
