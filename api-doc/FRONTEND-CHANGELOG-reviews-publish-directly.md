# FRONTEND-CHANGELOG — every review publishes immediately (2026-10-05)

**Cross-role.** Affects every app that writes or lists reviews: the storefront (customers), the
vendor dashboard and the agency dashboard. The agent app is unaffected. The admin dashboard
has its own page: `admin/api-doc/FRONTEND-CHANGELOG-reviews.md`. Full contract:
[reviews.md](./reviews.md).

## What changed

Until today, a review with a **title or a body** was saved as `pending` and waited for an
administrator's approval. No approval screen existed, so those reviews never appeared. Now
**every review is public the moment it is submitted, words included**. Reviews that were
waiting have been published.

Administrators can now, afterwards:
- **hide** a review (`unpublished`);
- **show** it again (`published`);
- **delete** it.

## What each app has to change

1. **After `POST /api/{customer,vendor,agency}/reviews`**, `data.status` is always
   `"published"`. Remove any "Submitted for review" / "Waiting for approval" message or
   branch. Show "Thanks — your review is live" (for a delivery review: "Thanks for your
   feedback". Delivery reviews are never shown publicly).
2. **"My reviews"** (`GET /api/{role}/reviews`): the status values are now **`published`** and
   **`unpublished`** only.
   - Render `unpublished` as **"Hidden by Wi-Mall"**. No reason is ever given (owner decision).
   - Delete any handling of `pending` or `rejected`.
   - The `?status=` filter accepts only `published` | `unpublished`. The old values answer
     `400`.
3. **A deleted review disappears** from "My reviews". Its author may then review the same
   product or delivery again: `GET …/reviews/eligibility` answers `eligible: true`, so show
   the form as normal.
4. **A hidden review still counts as "already reviewed".** Eligibility answers
   `eligible: false, reason: "REVIEW_ALREADY_EXISTS"` with its `existingReviewId`. Don't offer
   the form; show the existing review with its "Hidden" label.
5. **Public product reviews** (`GET /api/public/products/:productId/reviews`): no change. Only
   published reviews appear, and hidden or deleted ones drop out of `meta.rating` at once.

Nothing else in the request or response shapes changed.
