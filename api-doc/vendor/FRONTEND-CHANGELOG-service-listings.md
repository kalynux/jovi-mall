# Frontend changelog — service listings (vendor dashboard)

**Backend state:** built on branch `informational-service` (2026-10-22, completed 2026-11-07), **not yet
deployed**. Full contract: [service-listings.md](service-listings.md). Cross-role summary:
[../FRONTEND-CHANGELOG-service-listings.md](../FRONTEND-CHANGELOG-service-listings.md).

## What changes for the vendor dashboard

1. **Sign-up asks the vendor kind.** `vendorKind: "seller" | "provider"` on register / add-role.
   Absent = seller. It can never be changed by the vendor — say so on the choice.
2. **Branch the whole app on `vendorKind`** (from `/auth/me`, `/vendor/profile`, the token claim).
   A provider has **no** store, products, orders, delivery agencies, stock, bookings, bargaining,
   earnings or payouts — those routes answer `403 AUTH_VENDOR_KIND_FORBIDDEN` for a provider. A
   provider keeps profile, billing (plans + credits), files, transactions (credit movements), KYC,
   tickets and notifications, and gains **Listings**, **Leads** and **Listing settings**.
   ⚠ Seller screens are unchanged, except that a seller calling a provider route gets the same 403.
3. **Listings screen** (`/vendor/listings`): list, create, edit, submit, withdraw, discard a
   revision, archive. Show the status and, when `suspended`, `suspension.reason` in words:
   out of credits ("top up and it comes back on its own"), taken offline by Wi-Mall (`note`),
   over your plan ("upgrade to bring it back"). When `review.state` is `rejected`, show
   `review.reasons`. A live listing being edited shows "Changes waiting for review" while the
   approved version stays live.
4. **The editor**: public content and **hidden contacts** separately, with a clear "customers
   never see these until they tap" note. Location = the address search's result (address + pin,
   one field). Video = a pasted YouTube (unlisted) or Google Drive (anyone with the link) URL, with
   the instructions; Wi-Mall stores no video. Submitting costs the indexing credits
   (`actionCosts.vectorisation`) — show it on the button.
5. **Credits**: read `GET /api/public/credit-packs` → `actionCosts.listingRevealFirst` /
   `listingRevealNext` (7 / 4 today) and **never hard-code them**. Explain: first contact a customer
   unlocks costs 7, each further one 4, the same one again free for 30 days. The balance may be
   **negative** (grace for customers already engaged) — render negatives.
6. **Listing settings** (`/vendor/listing-settings`): what happens when credits run out
   (`onEmpty`), how negative it may go (`debtFloor`, empty = no limit), and the most one customer may
   cost per day (`maxCreditsPerCustomerPerDay`, empty = no limit).
7. **Leads screen** (`/vendor/leads`): masked customer, the fields they unlocked with date and cost,
   refunded marks, the 30-day window. Two buttons per row:
   - **"Ask them to call me"** — enabled by `callMeAvailable`; costs 2 credits.
   - **"Send a message"** — enabled by `freeTextAvailable`. When false on a WhatsApp lead with
     consent, grey it and open a sheet: *"WhatsApp only allows businesses to write freely within
     24 hours of the customer's last message to Wi-Mall. It reopens when the customer writes."*
   - Hide both when `consent` is not `granted`: *"Needs the customer's opt-in."*
   - Show `messagesLeft` (3 per customer per 30 days, at most one call-me).
   - **"Report"** — opens a sheet: refund these reveals, check this customer, or both; pick the
     reveals; write a reason (10–700). Disabled while `reportOpen`.
8. **Notifications**: five new situations — `listing.approved`, `listing.rejected`,
   `listing.suspended`, `listing.resumed`, `listing.video_unavailable` — with `aggregateType:
   "listing"` and the deep link `listings/:listingId`.
9. **Plans**: provider plans (`vendorKind: "provider"`, `maxActiveListings`) come back from the plan
   list beside seller plans; show only the provider's own kind.
