# Frontend changelog — service listings (storefront and customer account)

**Backend state:** built on branch `informational-service` (completed 2026-11-07), **not yet deployed**.
Full contract: [service-listings.md](service-listings.md). Cross-role summary:
[../FRONTEND-CHANGELOG-service-listings.md](../FRONTEND-CHANGELOG-service-listings.md).

## Public (no sign-in)

1. **Listing pages**: `GET /api/public/listings/:slug` — title, company, categories, city and area,
   photos, description, opening hours. One button per `availableFields` entry. For an anonymous
   visitor the buttons say **"Sign in to contact"**.
2. **Search / category pages**: `GET /api/public/listings` and `/by-ids`. Cards carry
   `kind: "listing"` — label them as service listings, distinct from products.
3. ⛔ Nothing public carries a contact, a vendor id or a map pin. Do not try to derive them.
3a. **Pricing page** (owner decision O-19): `GET /api/public/plans?role=vendor` now returns the seller
   plans **and** the provider plans together, each with `vendorKind` (`"seller"` | `"provider"`) and
   `maxActiveListings`. Show the two kinds apart (two groups or a switch), or ask for one kind with
   `&vendorKind=seller`. ⚠ This must ship **before** the provider plans are created in production,
   or the seller price list shows three extra plans. Agency and agent plans carry `vendorKind: null`.
3b. **"Sell on Wi-Mall" sign-up**, if the landing page has one: ask *"What will you do on Wi-Mall?"*,
   either sell products and services, or advertise a service business (customers unlock your contacts,
   you pay per contact), and send `vendorKind: "seller" | "provider"`. Say the choice cannot be
   changed later. Absent means seller.

## Signed in as a customer

4. **Reveal**: `POST /api/me/listings/:listingId/reveal { field }`. Under the buttons:
   *"This business will see your first name and part of your number."* Render `value` per field
   (WhatsApp: a "Chat on WhatsApp" link; location: a map from `latitude`/`longitude` and `mapUrl`;
   video: open the link). The customer pays nothing — do not show credit prices to customers.
5. When the response says **`askConsent: true`**, ask once: *"May <business> send you messages
   through Wi-Mall about your request?"* Yes / No → `PUT /api/me/listing-consents/:consentVendorId`.
6. **Account settings → "Businesses that may message me"**: `GET /api/me/listing-consents`, each with
   a switch (`PUT … { granted }`).
7. Refusals to show as plain sentences: `LISTING_UNREACHABLE` ("This business can't be reached right
   now"), `LISTING_REVEAL_DAILY_LIMIT`, `LISTING_FIELD_UNAVAILABLE`, `LISTING_VIDEO_UNAVAILABLE`.
