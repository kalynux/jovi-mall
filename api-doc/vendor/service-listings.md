# Service listings — the provider's API

A **service provider** is a vendor who publishes **listings** instead of selling products: who
they are, what they do, where (city and area), with photos and a description, and **no contact
details in public**. Each contact detail sits behind a button; when a signed-in customer taps
one, Wi-Mall charges the provider's **credits** and shows that detail. That charge is the
platform's revenue, because the job is paid away from Wi-Mall.

Design record: `backend/PRODUCTION-READINESS/SERVICE-LISTINGS-PLAN.md` (decisions L-1…L-31,
O-12…O-24). On screen the feature is **"Service listing"** (French *"Annonce de service"*).

All routes here need a vendor session whose **vendor kind is `provider`**. A seller calling them
gets `403 AUTH_VENDOR_KIND_FORBIDDEN` (`details.required: "provider"`); a provider calling a
seller route (products, orders, store, earnings…) gets the same error with `"seller"`.

---

## 1. Vendor kind

| | |
|---|---|
| Field | `vendorKind`: `"seller"` \| `"provider"` |
| Set | once, at sign-up — `POST /api/auth/register` or add-role, body `vendorKind` (absent = `seller`) |
| Read | `GET /api/auth/me`, `/auth/auth-me/vendor`, `GET /api/vendor/profile`, and the access token claim `vendor_kind` |
| Change | never by the vendor. Admin-only, not built in v1 |

🆕 **A provider's country is set at sign-up** (2026-11-08). A seller chooses it in onboarding Step 1, which a
provider never sees (they start at `onboarding_step: 0`). So register and add-role set `country` from the sign-up
phone number's country code (`+237…` → `CM`, `+225…` → `CI`), or `CM` when it matches no country. Country is
set-once (`403 PROFILE_COUNTRY_IMMUTABLE` on a change), and providers registered earlier receive the same value
from `backfill:provider-country`. The dashboard does not need to set it.

A provider has **no store**: no public store page, no products, orders, delivery agencies, stock,
bookings, bargaining, earnings or payouts. A provider has a profile, listings, billing (plans and
credits), storage, a credit transaction history and their leads.

---

## 2. A listing's life

```
draft ──submit──► pending_review ──approve──► live ⇄ suspended
  ▲                    │                        │
  └──── withdraw ──────┤ reject ──► rejected    └── archive ──► archived
                       │              │
                       └──────────────┴── edit + submit again
```

| `status` | Meaning |
|---|---|
| `draft` | never submitted (or withdrawn before its first approval) |
| `pending_review` | first submission, waiting for an administrator |
| `rejected` | first submission refused; editing it and submitting again is allowed |
| `live` | approved and visible |
| `suspended` | approved, but not reachable by new customers — see `suspension.reason` |
| `archived` | closed by the provider; terminal |

**An edit to a `live` listing is a revision**: the approved version stays live while the edited
copy (`pending`) waits for review (`review.state`: `editing` → `pending_review` → back to
`editing` with reasons when rejected). Contact edits are reviewed too.

`suspension.reason`:

| Reason | Why | Comes back |
|---|---|---|
| `insufficient_credits` | the balance fell below the first-reveal cost (7) | **on its own** at the next top-up or plan credit |
| `platform_oversight` | an administrator took it offline (`suspension.note`) | only by an administrator |
| `plan_quota_exceeded` | over the plan's `max_active_listings` after a downgrade | on an upgrade, oldest first |

---

## 3. Listings

### `GET /api/vendor/listings?status&q&page&limit`
🆕 **`q`** (2026-11-08): 1–200 characters, trimmed. Matches the **title** and the **company name** on
the working copy (`pending`) **and** the live copy (`published`), so a draft and a live listing in
revision are found by either name. **Case- and accent-insensitive** both ways (`electricite` finds
"Électricité", `ÉLEC` finds "Akwa Elec"). Typed characters are matched literally. Combines with
`status`. `q: ""` or over 200 characters is `400 VALIDATION_ERROR`; send no `q` for the whole list.

A page of `VendorListingSummary`:
`{ id, slug, status, title, companyName, hasRevision, review, suspension, availableFields[], vectorisationStatus, publishedAt, createdAt, updatedAt }`.

### `POST /api/vendor/listings` — body `{ content?, contacts? }` → `VendorListingDetail` (status `draft`, `201`)
### `PATCH /api/vendor/listings/:id` — same body → `VendorListingDetail`
Saving is partial: a half-written draft saves. Completeness is judged at submit.

`content`: `{ title, companyName, categories (1–5, the shared product categories), country (ISO-2),
city, area (neighbourhood — public), description (20–5000 at submit), descriptionRich, photoFileIds[≤10],
openingHours[{ day, openTime, closeTime, isClosed }] | null }`.

`contacts` (**never public**): `{ whatsapp (E.164), phone (E.164), phone2 (E.164), email, website, socials[≤5 { network, url }],
location (the GeoAddress the address search returned: address + pin), video: { url } }`.

🆕 **`phone2`** (2026-11-08) is an optional **second phone number** (e.g. an MTN and an Orange line).
`whatsapp` stays a single number. Rules:
- `phone` and `phone2` are **one contact field**: the "Phone" button unlocks both, for **one** charge,
  so a customer can still cost a provider at most seven fields.
- A `phone2` equal to `phone` (same digits) is dropped. A `phone2` with no `phone` becomes `phone`.
  Clearing `phone` while `phone2` is set moves the second number up. So the stored pair is
  always "first, optional second".
- "Ask them to call me" sends the **first** number, as before.
- `VendorListingDetail.contacts.{published,pending}` carry `phone2` (`null` when unset).
- Changing either number on a live listing is a revision reviewed like any other edit.
Any contact may be cleared with `null`. The video is a **link** — YouTube (make it *unlisted*) or
Google Drive (*anyone with the link*); Wi-Mall stores no video. Another host is
`422 LISTING_VIDEO_LINK_INVALID`.

`409 LISTING_STATUS_CONFLICT` while the working copy is `pending_review`.

### `GET /api/vendor/listings/:id` → `VendorListingDetail`
Adds `published`, `pending` (content, photos resolved), `contacts: { published, pending }` (the
provider's own), `lastDecision { decision, at, reasons[] }`, `archivedAt`.

### `POST /api/vendor/listings/:id/submit`
Takes the indexing fee (`CREDIT_COST_VECTORISATION`, 5) — `402 BILLING_INSUFFICIENT_CREDITS` when
the balance cannot pay it — scans the text for phone numbers, emails and links (pre-flags for the
reviewer, never a refusal), checks a YouTube link can be watched, and sends it to review.
`422 LISTING_INCOMPLETE` with `details.missing[]` (`title`, `companyName`, `categories`, `country`,
`city`, `area`, `description`, `contact`); `422 LISTING_VIDEO_NOT_WATCHABLE`.
The fee is returned on a rejection, a withdrawal, or a failed indexing.

### `POST /api/vendor/listings/:id/withdraw`
Back to editing before a decision; the fee is returned.

### `DELETE /api/vendor/listings/:id/revision`
Drops a live listing's revision (also one already waiting for review — its fee is returned). The
live version stays.

### `POST /api/vendor/listings/:id/archive`
Terminal. A pending fee is returned.

---

## 4. Settings — `GET` / `PUT /api/vendor/listing-settings`

`{ onEmpty, debtFloor, maxCreditsPerCustomerPerDay }` (a PUT sends all three).

| Field | Default | Meaning |
|---|---|---|
| `onEmpty` | `"continue_engaged"` | when credits run out: `continue_engaged` keeps serving customers who already revealed a field on that listing while it was live, until their own 30-day window ends (the balance may go negative); `stop` refuses everyone |
| `debtFloor` | `null` (no floor) | how negative the balance may go for those customers; ≤ 0 |
| `maxCreditsPerCustomerPerDay` | `null` (no limit) | the most one customer may cost on one listing per day (Africa/Douala day); when set, at least the first-reveal cost |

`422 LISTING_SETTINGS_INVALID` for a positive floor or a cap below the first-reveal cost.

---

## 5. What a reveal costs

Per field, per customer, per listing, within a **30-day window** from that customer's first
reveal: **first field 7 credits, each further field 4**. The same field again within the window
is free. After 30 days the next reveal starts at 7 again. A provider viewing their own listing is
never charged. Read the live numbers from `GET /api/public/credit-packs` →
`actionCosts.listingRevealFirst` / `listingRevealNext` — never hard-code them.

Ledger rows (credit history): `listing_reveal` (debit), `listing_reveal_refund` (refund),
`credit_debt_written_off` (at account closure, when the balance was negative).

---

## 6. Leads — `GET /api/vendor/leads?listingId&page&limit`

One row per customer per listing per 30-day window, newest first:

```json
{
  "id": "…", "listingId": "…", "listingTitle": "Plumbing",
  "customer": { "displayName": "Jean-Paul K.", "maskedPhone": "+237 ••• ••• •31" },
  "fields": [{ "field": "whatsapp", "revealId": "…", "at": "…", "cost": 7, "refunded": false }],
  "windowStart": "…", "windowEnd": "…",
  "consent": "granted",              // "granted" | "not_granted" | "revoked"
  "channel": "whatsapp",             // where the customer revealed: web | whatsapp | telegram
  "callMeAvailable": true,
  "freeTextAvailable": false,
  "messagesLeft": 2,
  "reportOpen": false
}
```

**The provider never sees the customer's full number** — a first name, a last initial, the
country code and the last two digits. `displayName` / `maskedPhone` may be `null`.

---

## 7. Messaging a customer

Only a customer who **opted in** to this provider's messages can be reached, and only through
Wi-Mall. The customer is asked once, after their first reveal from the provider, and can withdraw
at any time (every relayed message carries **"Stop these messages"**). When `consent` is not
`granted`, hide both buttons and show *"Needs the customer's opt-in"*.

**At most 3 messages per customer per 30 days**, of which **at most 1 call-me**.

### `POST /api/vendor/leads/:leadId/call-me` → `{ message }`
Sends "Ask them to call me": the business name and the listing's **first** phone number (else WhatsApp number).
Works at any time. **Costs 2 credits** (`CREDIT_COST_WHATSAPP_TEMPLATE`), on every channel. If
the message cannot be delivered, `message.status` is `"failed"` and the credits are returned.

### `POST /api/vendor/leads/:leadId/message` — body `{ body }` (1–1000) → `{ message }`
Free text, relayed by Wi-Mall. **No credits.** On WhatsApp it works only inside the 24-hour window
(the customer wrote to Wi-Mall's WhatsApp in the last 24 hours) — **WhatsApp's rule, not
Wi-Mall's**: grey the button when `freeTextAvailable` is false and explain that it reopens when
the customer writes. Always allowed on Telegram.

`message`: `{ id, kind: "call_me" | "free_text", channel: "whatsapp" | "telegram", status: "sent" | "failed", credits, at }`.

The customer answers the provider directly (the message links the provider's own WhatsApp);
replies never come back through Wi-Mall.

| Error (422 unless noted) | When |
|---|---|
| `LISTING_MESSAGE_CONSENT_REQUIRED` | the customer has not opted in (or withdrew) |
| `LISTING_MESSAGE_CHANNEL_UNAVAILABLE` | the customer has no linked WhatsApp or Telegram |
| `LISTING_MESSAGE_CAP_REACHED` | 3 messages in 30 days (`details.messagesLeft: 0`) |
| `LISTING_CALL_ME_ALREADY_SENT` | the one call-me of the 30 days was sent |
| `LISTING_MESSAGE_WINDOW_CLOSED` | free text on WhatsApp outside the 24-hour window |
| `LISTING_FIELD_UNAVAILABLE` | call-me on a listing with no phone and no WhatsApp |
| `BILLING_INSUFFICIENT_CREDITS` (402) | call-me with fewer than 2 credits |
| `LISTING_LEAD_NOT_FOUND` (404) | not this provider's lead |

---

## 8. Reporting a lead — `POST /api/vendor/leads/:leadId/report`

One button for both reasons (L-31): a refund request, a suspicious customer, or both.

Body: `{ wants: ("refund" | "check_customer")[1..2], revealIds: string[], reason (10–700) }`
→ `201 { ticketId, ticketNumber }` (`ticketNumber` is the short `#A1B2C3` reference).

`revealIds` are the reveals concerned (from `fields[].revealId`); required when asking for a
refund. It opens one support ticket (type `LISTING_LEAD_REPORT`). An administrator sees the
customer's real identity, may refund reveals and may block the customer on that listing. While a
report is open, `reportOpen` is true and a second report is refused.

`422 LISTING_REPORT_INVALID` — reveals not on this lead (`details.revealIds`), a refund naming no
reveal (`details.field: "revealIds"`), or a report already open (`details.reason: "report_open"`).
The generic ticket form refuses this type.

---

## 9. Notifications to the provider

In-app, push, and the provider's chosen channel (WhatsApp templates pending Meta approval since
2026-11-07). Not mutable — each is about whether customers can reach the business.

| Situation | Message |
|---|---|
| `listing.approved` | approved and now visible |
| `listing.rejected` | not approved, with the reviewer's reasons |
| `listing.suspended` | paused for new customers, with why (credits, an administrator, the plan) |
| `listing.resumed` | live again |
| `listing.video_unavailable` | a customer could not watch the YouTube video — replace the link (nothing was charged) |

Each opens `listings/:listingId` in the vendor dashboard.
