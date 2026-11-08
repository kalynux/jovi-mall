# Frontend changelog — service listings (cross-role)

**What it is:** a second kind of vendor, the **service provider**, publishes listings whose
contact details customers unlock with a tap; the provider pays per unlocked contact in credits.
Plan and decisions: `backend/PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md`.

**Backend state:** branch `informational-service` in jovi-mall and wi-admin, **not yet deployed**.
Twelve WhatsApp templates (six names × en/fr) submitted to Meta on 2026-11-07, pending review.

| App | Read |
|---|---|
| Vendor dashboard | [vendor/FRONTEND-CHANGELOG-service-listings.md](vendor/FRONTEND-CHANGELOG-service-listings.md) · reference [vendor/service-listings.md](vendor/service-listings.md) |
| Storefront / landing (public + signed-in customer) | [customer/FRONTEND-CHANGELOG-service-listings.md](customer/FRONTEND-CHANGELOG-service-listings.md) · reference [customer/service-listings.md](customer/service-listings.md) |
| Admin dashboard | `admin/api-doc/FRONTEND-CHANGELOG-service-listings.md` (wi-admin) |
| Customer bot | `n8n/bot-surface.md` § 14.9 (`ls:` / `lr:` / `lc:`) and the four `listings_*` tools in `n8n/tools/catalog.json` |

Agency and agent apps: **no change.**

Shared rules every app follows:
- Credit prices come from `GET /api/public/credit-packs` → `actionCosts` (`listingRevealFirst`,
  `listingRevealNext`, `vectorisation`, `whatsappTemplate`), never hard-coded.
- Contacts are never public, never in a list, never in search. They appear only in the answer to a
  customer's tap, in the provider's own editor, and in wi-admin behind an audited permission.
- On screen the feature is **"Service listing"** / *"Annonce de service"*; in legal text,
  "Informational Service Listing".
