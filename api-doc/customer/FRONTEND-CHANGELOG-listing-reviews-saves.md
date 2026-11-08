# Frontend changelog (storefront, signed-in half) — saved listings and listing reviews (2026-11-08)

The public half (ratings on cards, the reviews list) is `../public/FRONTEND-CHANGELOG-listing-reviews.md`.
Shared rules and the referral page: `../FRONTEND-CHANGELOG-listing-reviews-saves-referrals.md`.
Contracts: `saved-and-viewed.md` (the saved list), `../reviews.md` § "Service listings".

## 1 · Saved listings — one "Saved" place (owner RS-1)

1. **A heart on the listing card and the listing page**, for a signed-in customer only (anonymous: none, or
   your usual sign-in prompt).
   - Save: `POST /api/customer/wishlist` `{ "listingId": "…" }` — 200, idempotent.
   - Remove: `DELETE /api/customer/wishlist/listings/:listingId`.
   - Hearts on a grid: `POST /api/customer/wishlist/saved-among` `{ "listingIds": [...] }` →
     `savedListingIds`. You may send `productIds` and `listingIds` in one call for a mixed grid.
2. **The Saved page shows both kinds** from `GET /api/customer/wishlist`, newest save first. ⚠ **Branch on
   `entry.kind`**:
   - `"product"`: exactly as today (`productId`, `product`).
   - `"listing"`: `listingId` and `listing` (the public listing card). Tapping it opens the listing page.
   - `listing: null` means it is no longer available: show "No longer available" and a working Remove, the
     same as a product.
   - Optional tabs: `?kind=product` / `?kind=listing`.
3. **Say what saving does, and nothing more.** It keeps the listing for later. It does not unlock a contact,
   costs nothing, and **the business is never told** (RS-2). It is not "notify me" (RS-9: no notification
   when a paused listing comes back).
4. Closing the account deletes the saved list (RS-10). No screen change.

⚠ Ship the `kind` branch **before or with** the heart: the bot can already save listings, so a Saved page that
assumes every entry has a `productId` will meet listing rows.

## 2 · Reviewing a listing (owner L-27)

Only a customer who **unlocked at least one contact** of that listing may review it.

1. Ask first: `GET /api/customer/reviews/eligibility?subjectType=listing&subjectId=<listingId>` →
   `{ eligible, reason, existingReviewId }`. Show "Rate this business" only when `eligible: true`.
   - `reason: "REVIEW_NOT_ELIGIBLE"`: they never unlocked a contact. Show nothing (or "Contact them first").
   - `reason: "REVIEW_ALREADY_EXISTS"`: show their review instead (`existingReviewId`).
   - `REVIEW_SUBJECT_NOT_REVIEWABLE`: the listing was removed by the business.
2. Submit: `POST /api/customer/reviews` `{ "subjectType": "listing", "subjectId": "<listingId>", "rating": 1–5,
   "title"?: "≤120", "body"?: "≤2000" }`. It is **public at once**, text included; tell the customer so
   before they submit.
3. "My reviews" (`GET /api/customer/reviews`) now has `subjectType: "listing"` rows. Label them with the
   listing title, from `GET /api/public/listings/by-ids`.
