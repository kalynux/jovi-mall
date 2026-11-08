# Frontend changelog (vendor dashboard, providers) — listing reviews (2026-11-08)

For **service providers** only; sellers see no change except the referral page below. Shared rules:
`../FRONTEND-CHANGELOG-listing-reviews-saves-referrals.md`. Contract: `../reviews.md` § "Service listings".

## 1 · Reviews of a listing (owner RS-8, RS-12)

Customers who unlocked a contact can now rate a listing, 1–5 stars with optional text. It is public at once.

1. **On the listing's page in the dashboard**, a Reviews section:
   `GET /api/vendor/listings/:id/reviews?page=&limit=` (limit ≤ 50). Works for the provider's own listing in
   **any** status, paused and archived included. Same body as the public reviews route:
   `data[]` of `{ id, rating, title, body, publishedAt }` and `meta.rating`
   (`{ average, count, distribution }`, or `null` with no reviews).
2. **The reviews are anonymous**, to the provider too. There is no name and no way to find the reviewer. Don't
   cross-reference the leads list.
3. **No reply.** There is no reply route and none is planned (RS-8). Don't draw a reply box.
4. **The listings list and listing page may show the rating** (`rating` on the public card, or `meta.rating`
   above).
5. A provider who thinks a review is abusive opens a ticket; only Wi-Mall can take a review down.

## 2 · A new notification: `listing.review_published`

One per published review: "A customer rated {listing} 4 out of 5. Open the listing to read the review."
`aggregateType: "listing"`, it opens `listings/:listingId` (the same deep link as the other listing notices).
It reaches the dashboard, push and email; on WhatsApp only when the provider wrote to Wi-Mall in the last 24
hours (owner RS-11, no template). It cannot be muted, like the other listing notices.

## 3 · The referral page

If the vendor is also a referral partner: see the shared changelog (`provider` category, `paymentKind`).
