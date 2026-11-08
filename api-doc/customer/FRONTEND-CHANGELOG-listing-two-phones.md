# Frontend changelog (storefront) — a listing's phone can be two numbers (2026-11-08)

Contract: `service-listings.md` § 2 (the reveal). Not deployed yet.

A business may now give **two phone numbers** (for example an MTN and an Orange line). It is still **one**
contact button, "Phone", and one tap unlocks both, for one charge to the business.

`POST /api/me/listings/:listingId/reveal` `{ "field": "phone" }` now answers:

```json
{ "field": "phone", "value": { "number": "+237671234531", "numbers": ["+237671234531", "+237699000111"] } }
```

- **`numbers`** is every number, first first: one entry when the business gave one, two when it gave two.
- **`number`** is always `numbers[0]`, so a screen that only reads `number` keeps working, but shows one.
- **Render every entry of `numbers`**, each with its own "Call" (`tel:`) action, under the one "Phone" result.
  When the customer unlocks phone a second time inside the 30-day period (free), the reply carries both again.
- No other field changed. `availableFields` still lists `phone` once.
