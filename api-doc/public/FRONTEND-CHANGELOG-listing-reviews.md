# Frontend changelog (storefront, public half) — listing ratings and reviews (2026-11-08)

The signed-in half (saving, writing a review) is `../customer/FRONTEND-CHANGELOG-listing-reviews-saves.md`.
Shared rules: `../FRONTEND-CHANGELOG-listing-reviews-saves-referrals.md`. Contract: `../reviews.md`
§ "Service listings" and `../customer/service-listings.md`.

## 1 · The listing card's `rating` is real now

`PublicListingCard.rating` on `/api/public/listings`, `/by-ids` and `/:slug` was always `null`. It is now
`{ "average": 4.5, "count": 12 }`, or **`null` when nobody has reviewed the listing**. Draw stars and the
count when it is an object; draw **nothing** when it is `null` (not "0 reviews", not empty stars). Same rule
as the product card.

## 2 · The listing page shows its reviews

`GET /api/public/listings/:listingId/reviews?page=&limit=` (limit ≤ 50) — unauthenticated, cached 5 minutes,
the **same body as the product reviews route**:

```json
{
  "success": true,
  "data": [{ "id": "…", "rating": 5, "title": null, "body": "Came the same day.", "publishedAt": "…" }],
  "meta": { "total": 12, "page": 1, "limit": 10, "totalPages": 2,
            "rating": { "average": 4.5, "count": 12, "distribution": { "1": 0, "2": 0, "3": 1, "4": 4, "5": 7 } } }
}
```

- Reuse your product reviews component. `meta.rating` is `null` when there are none.
- **No author identity** is published, exactly as for products. Don't add a name.
- A listing the public cannot see answers an empty page, not a 404.
- There is **no reply from the business** (owner RS-8). Don't draw a reply slot.
