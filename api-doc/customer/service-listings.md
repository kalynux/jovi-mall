# Service listings — the customer and public API

Businesses paid in person (plumbers, printers, repairers…) publish **service listings** on
Wi-Mall. A listing shows what the business does and where, with **no contact details**. A
signed-in customer taps a contact to see it; the **business** pays for that in credits — the
customer pays nothing.

Design record: `backend/PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md`. Provider side:
[vendor/service-listings.md](../vendor/service-listings.md).

---

## 1. Public reads (no sign-in)

### `GET /api/public/listings?q&category&country&city&area&page&limit`
A page of `PublicListingCard`:

```json
{
  "id": "…", "slug": "plumbing-akwa", "kind": "listing",
  "title": "Plumbing", "companyName": "Akwa Plumbers",
  "categories": [{ "id": "…", "name": "Plumbing", "slug": "plumbing" }],
  "country": "CM", "city": "Douala", "area": "Akwa",
  "photo": { "…FileDetail" } ,
  "rating": null,
  "availableFields": ["whatsapp", "phone", "location"],
  "revealCosts": { "first": 7, "next": 4 }
}
```

`availableFields` names which contact buttons to draw — **never a value**. No vendor id and no map
pin are ever public. `kind: "listing"` tells a listing apart from a product in mixed results.

🆕 **`rating`** (2026-11-08) is the customers' published rating, `{ "average": 4.5, "count": 12 }`,
or `null` when nobody has reviewed the listing — draw no stars then. Reviews: `GET
/api/public/listings/:listingId/reviews` (see `../reviews.md`). A signed-in customer can save a
listing from the card (`POST /api/customer/wishlist` `{ listingId }`, see `saved-and-viewed.md`);
the business is never told.

### `GET /api/public/listings/by-ids?ids=a,b` → `{ data: PublicListingCard[], missing[] }`
In the order asked (at most 50).

### `GET /api/public/listings/:slug` → `PublicListingDetail`
The card plus `description`, `descriptionRich`, `photos[]`, `openingHours[] | null`, `publishedAt`.
A listing that is not public is `404 LISTING_NOT_FOUND`.

An anonymous visitor sees the listing and a **"Sign in to contact"** prompt in place of the buttons.

---

## 2. Unlocking a contact — `POST /api/me/listings/:listingId/reveal`

A **customer** session (a vendor or agency session on the same account unlocks nothing).
Body `{ field }`, one of `whatsapp`, `phone`, `email`, `website`, `socials`, `location`, `video`.

Show this line at the buttons: *"This business will see your first name and part of your number."*

```json
{
  "field": "whatsapp",
  "value": { "number": "+237671234531", "link": "https://wa.me/237671234531" },
  "charged": true,
  "cost": 7,
  "alreadyRevealed": false,
  "windowEndsAt": "2026-12-07T12:00:00.000Z",
  "nextCost": 4,
  "askConsent": true,
  "consentVendorId": "…"
}
```

`value` by field: whatsapp `{ number, link }` · phone `{ number, numbers }` · email `{ address }` ·
website `{ url }` · socials `{ links[{ network, url }] }` · location `{ address, latitude,
longitude, mapUrl }` · video `{ url, host: "youtube" | "google_drive" }` (the link itself — open
it; YouTube plays it).

🆕 **Phone, 2026-11-08:** a business may give **two** phone numbers. One tap on "Phone" unlocks both,
for one charge:

```json
{ "field": "phone", "value": { "number": "+237671234531", "numbers": ["+237671234531", "+237699000111"] } }
```

`numbers` is every number, first first (one entry when the business gave one). `number` is always
`numbers[0]`, so a client that shows only `number` keeps working. **Show every entry of `numbers`**,
each with its own call button.

The same field again within 30 days returns the value with `alreadyRevealed: true` and is free.

**`askConsent: true`** (once per business, on the first unlock): ask *"May <business> send you
messages through Wi-Mall about your request?"* — Yes / No — and send the answer to
`PUT /api/me/listing-consents/:consentVendorId`. The default is No.

| Error (422 unless noted) | Show |
|---|---|
| `LISTING_UNREACHABLE` | "This business can't be reached right now." — deliberately the same for every reason |
| `LISTING_REVEAL_DAILY_LIMIT` | "You've reached today's limit for this business. Try again tomorrow." |
| `LISTING_FIELD_UNAVAILABLE` | "This business hasn't given that contact detail." |
| `LISTING_VIDEO_UNAVAILABLE` | "This video is no longer available." |
| `LISTING_NOT_FOUND` (404) | the listing is not public |

---

## 3. Messages from businesses — consents

### `GET /api/me/listing-consents`
Every business the customer was asked about or answered, newest change first:
`[{ vendorId, businessName, consent: "granted" | "not_granted" | "revoked", granted, askedAt, grantedAt, revokedAt }]`.

### `PUT /api/me/listing-consents/:vendorId` — body `{ granted: boolean }` → the same row
Grant, refuse or withdraw. Only toward a business the customer unlocked a contact from
(`404 LISTING_LEAD_NOT_FOUND` otherwise).

A business that may message the customer can send at most 3 messages per 30 days, of which one
"please call me". Every message carries **"Stop these messages"**, which withdraws the consent.
Replies go to the business's own WhatsApp, not to Wi-Mall. Closing the customer account withdraws
every consent.

---

## 4. In the chat (WhatsApp / Telegram)

The customer bot draws listing cards with one button per contact. A tap unlocks the contact (a
location arrives as a map pin, followed by an offer of the way-there video), and the first unlock
from a business is followed by the opt-in question. The AI never states a contact itself and never
unlocks one on its own — only the customer's tap does. Tokens: `api-doc/n8n/bot-surface.md`
§ 14.9 (`ls:`, `lr:`, `lc:`).
