# MCP parity plan — every landing-page customer action as an MCP tool

**Goal.** Everything a signed-in customer can do on `frontend/landing` has an MCP tool
equivalent, served by the `wi-mall-mcp` n8n workflow, so the chat agent can do it too.

**Status of the plumbing (done, 2026-09-06).** The MCP client↔server flow works end to end —
see `bot-surface.md` § 2b. Identity travels as a **sealed token**, not a chat id, because
n8n's MCP Server Trigger gives a connected tool node no per-request context at all. Read that
section before adding a tool; it is the constraint that shapes every row below.

---

## 1 · What the inventory found

Every `/api/**` path the landing app calls, extracted from `frontend/landing/src`, mapped
against `tools/catalog.json` (64 tools) and `BOT_ROUTES` (49 routes).

| | |
|---|---|
| Landing customer actions already covered by a tool | **~40** |
| Gaps — no tool today | **35** |
| Of those, **the backend endpoint already exists** | **35 / 35** |
| Gaps needing new business logic | **0** |

⭐ **This is the finding that sizes the work.** Not one gap needs a new service, a new model
or a migration. Every one is a thin bot-surface route delegating to the same service the
customer API already calls — the shape `bot.routes.ts` was built for. The cost is route rows,
projections, catalogue entries and tests, not design.

---

## 2 · Three decisions this plan takes, and one it refuses

**D-1 · The 5-item cap is enforced SERVER-SIDE, not by the prompt.** Today `limit` defaults
to 5 and its **max is 100** (`bot.validators.ts:186`), so a model may ask for fifty and get
them. A rule that lives only in a system prompt is a rule the model breaks under pressure.
Step 0 makes it structural.

**D-2 · "More" is a link the backend composes.** The cap is useless without an escape hatch,
and n8n holds no copy table and no URL table — the same argument that put `reply` and
`error.customerMessage` server-side (three times now; see `bot-surface.md` § 14). The backend
returns the deep link into the landing app.

**D-3 · Two destructive actions become `flow_only` with an explicit confirmation**, rather
than model-callable: **account closure** and **disconnecting a messaging channel**. They stay
reachable — the parity goal is met — but a model cannot reach them on its own reading of a
sentence.

⛔ **REFUSED: `PATCH /api/me/password` gets no tool.** Changing a password needs the *current*
password, and a chat window is the worst place to type one: it persists in the Telegram/
WhatsApp message history, in n8n's execution log, and in the model's context window, none of
which the platform controls or can redact. `auth_send_password_reset_link` already exists,
already works from a chat, and sets a password without anyone typing the old one into a
transcript. That is the parity answer for this row. If you want the literal endpoint exposed
anyway, say so and I will build it — but it should be a decision, not an omission.

---

## 3 · Step 0 — the cap and the "more" link ✅ **DONE 2026-09-06**

Everything after this step adds list tools, and each one added before the cap exists is one
more place to retrofit it.

**Built:** `domain/bot-list-window.ts` (`BOT_CHAT_LIST_MAX`, `windowForChat`,
`botListMoreUrl`), both list schemas clamped, and the window applied to all six model-facing
list handlers. `test:bot-surface` **176/0** — § 13 is the window, including a source scan
that fails if a list handler stops going through it. Verified live over MCP:
`orders_list_groups` answered `meta: { total: 15, shown: 5, hasMore: true, moreUrl: ".../fr/shop/account/orders" }`.

**Four corrections to this plan, made while building:**

1. ⚠ **The locale prefix was missing from the plan and is the part that fails silently.**
   The storefront routes with `localePrefix: "as-needed"` — English owns the bare paths, the
   other four are prefixed. A bare path does **not** 404 for a French customer; middleware
   serves them the English tree. The bot answers in French and hands over an English page,
   and nothing reports a fault. `botListMoreUrl` reuses `toBotCopyLanguage`, so the link and
   the sentence beside it cannot disagree.
2. ⚠ **`addresses_list` had to sort the default address first.** `toBotAddressList` is a
   plain `map` in stored order, so capping at five could drop the customer's default — the
   one a chat answer is most likely to be about, and the one checkout falls back to.
3. **`addresses_set_default` is deliberately NOT capped.** It returns the whole list because
   setting a default clears every sibling's flag, and it is `flow_only` — no model narrates
   it, so the wall-of-text argument does not apply.
4. **The three `public` catalogue tools are capped in the CATALOGUE, not on the endpoint.**
   `/api/public/products` still accepts `limit=100` because the storefront legitimately pages
   twenty at a time. What is capped is the tool the model is handed. The plan said "apply to
   the public catalogue reads" as though they were bot-surface routes; they are not.

Also: the three ticket tools now carry `meta` **beside** their documented `pagination` key
rather than instead of it, so a client never has to know which tool puts the window where.

1. `domain/bot-list-window.ts` — new. One pure helper:
   `capForChat(items, total, moreUrl)` → `{ items: items.slice(0,5), total, hasMore, moreUrl }`.
   `BOT_CHAT_LIST_MAX = 5`, exported, one definition.
2. Clamp every list schema in `bot.validators.ts` to `.max(5)`. ⚠ Both sites — the `max(100)`
   at :186 and the `max(10)` at :342.
3. `moreUrl` is built from `STOREFRONT_URL` + a per-tool path table
   (`orders → /shop/account/orders`, `tickets → /shop/account/support`, …). Keep the table in
   one file; a URL invented at a call site is a 404 in a chat window.
4. Apply to every existing list projection: `orders_list_groups`, `tickets_list`,
   `bookings_list`, `wishlist_list`, `digital_list_entitlements`, `addresses_list`,
   `geo_search_address`, and the public catalogue reads.
5. `test:bot-surface` — assert `capForChat` never returns more than 5, that `hasMore` is
   `total > 5` and not `items.length === 5`, and that every list tool's response carries the
   block.

⚠ **`hasMore` must be derived from the real total, not from the page being full.** A list of
exactly 5 would otherwise claim there is more, and the customer follows a link to nothing.

---

---

## Known problems, parked for later

These were found while building the tools. None of them blocks the parity work, and none is
caused by it — they are existing platform bugs that the work walked into. Written down here
so they are not rediscovered from scratch.

### ✅ KI-1 · Customers cannot move a booking for a group service — **RESOLVED 2026-09-06**

**What broke.** A "capacity" service is one where several people share the same time slot —
a class, a group tour, a workshop. If a customer had booked one of those and tried to change
it to a different time, it always failed. They got an error even when the new time was free
and everything about the request was correct. Every customer with a group-service booking was
affected, on the website as well as in chat.

**Why.** Booking a slot puts a temporary 15-minute hold on it. For group services that hold is
saved under a key that includes the customer's own id, so several people can be booking the
same class at once. The "move my booking" code looked for the hold under the plain key,
without the customer id — the wrong place, so it never found it and refused.

**Where it was.** `src/modules/booking/services/booking.service.ts` — `rescheduleBooking`, the
`assertLocked` and `release` calls. `SlotLockService.extend` already carried a comment about
this exact mistake; it had been fixed there and in two other places, and this one was missed.

**What was actually done, and why it was not the one-line change this entry predicted.**
Passing the flag was indeed one line. It was not enough, and the two reasons are worth
keeping:

1. **The lock was not the only thing that refused a group move.** Step 3 asked "is this window
   free" and refused on any overlap, so even with the hold found, moving into a class with
   other attendees in it was still rejected. A group slot's question is "are there fewer than
   `maxBookings` seats taken", which is a different query — and it has to run under the
   per-slot capacity mutex, or a concurrent booking takes the last seat between the count and
   the write.
2. **Enabling the move would have corrupted the calendar.** Every seat in a class points at
   ONE shared `[x/N]` event, and the existing reschedule called `updateEvent` on it — so a
   fixed reschedule would have dragged the whole class to the mover's new time. Strictly worse
   than refusing.

So the group-specific rules were given their own home, `GroupBookingService`
(`src/modules/booking/services/group-booking.service.ts`): the owner-scoped hold, the seat
count, the mutex, and the shared-event lifecycle. `BookingService` asks it whether a product is
a group service and hands the group-specific work over; `createCapacityBooking` is now a
delegate, so the create path and the move path count seats through one implementation. That
was the actual root cause — the two paths had drifted because there was nowhere for the rule to
live.

**One thing beside it was fixed too.** All three cancellation paths called `deleteEvent` on the
booking's event — which, for a group service, deleted the whole class from the vendor's
calendar because one attendee dropped out. They now route through
`detachFromCalendarOnCancel`, which re-renders `[x/N]` and deletes only when the last seat
goes. Single-occupancy behaviour is unchanged.

**The fixture that was missing now exists.** `npm run seed:group-service` creates a 4-seat
class with four slots seeded to the four states a move can land in — the class the mover is
in, one with a seat free, one full, one empty — and prints the booking id and slot ids to
reproduce with. `npm run seed:group-service:clean` removes it.

⚠ Worth knowing: the dev database DID hold two `bookingMode: 'capacity'` variants when this
was written, so "the dev database does not have one" read as merely untested. Both were
**orphans** whose `products` row no longer existed, and the database held **zero** bookings of
any kind. The entry's conclusion was right; the reason was stronger than stated.

**Covered by** `npm run test:group-booking` (24, no DB). Three of its assertions are source
scans, because KI-1's shape is a MISSING ARGUMENT — `assertLocked(slot, owner)` and
`assertLocked(slot, owner, true)` both compile and both run, and only a scan can tell them
apart. Verified by re-introducing the bug: those three fail, the rest stay green.

**Not worked around on purpose, and that decision paid.** Making the chat tool use the other
key would have made chat behave differently from the website and hidden the bug — and the
storefront would still be broken today.

### KI-2 · Vendors get a broken "new booking" message — ✅ **FIXED 2026-09-06**

**What broke.** Every time a customer booked a service, the vendor was sent a notification with
no content in it, over in-app, email and Telegram, in all five languages.

⚠ **The symptom recorded here was wrong in a way worth keeping**, because it sent the reader
looking for the wrong mechanism. It read:

> New booking #undefined for undefined scheduled on Invalid Date.

The literal string `undefined` never appeared. `renderTemplate`
(`notifications/catalog/message-renderer.ts`) turns a nullish context value into an **empty
string** by design and then collapses the whitespace, so what vendors actually received was:

> New booking # for scheduled on Invalid Date.

Only the date said "Invalid Date", from `new Date(undefined).toLocaleString()`. That difference
matters: an `undefined` in the output would suggest a rendering bug, whereas an empty gap is the
renderer working exactly as specified on a payload that carries nothing — which is why nothing
anywhere raised an error, and why a **source scan** rather than a behavioural test is what
catches it.

**Two things this entry missed entirely.**

1. ⚠ **The WhatsApp send did not merely look wrong — it FAILED.** Meta rejects a template
   parameter that is an empty string, so `vendor_booking_created` was rejected on every booking
   and recorded on the notification's `deliveryErrors`. That channel had never once delivered
   this situation.
2. ⚠ **`booking.cancelled` had the IDENTICAL defect.** The vendor handler read `bookingNumber`
   there too and the producer did not send it, so *"Booking # has been cancelled."* named no
   booking at all — worse than the created message, whose remaining words at least said a
   booking existed.

**And the customer side was fine**, which this entry asked someone to check. Verified by reading
`customer-notification-event-handler.service.ts`: it reads `productTitle`/`vendorName`/`startAt`
— the names the producer actually sends — and declares each optional with a localized fallback
(`this.genericService(lang)`). Same event, same payload, correct on one side and empty on the
other. That asymmetry is now pinned by test rather than by reading.

**What was decided and built.** Both decisions were put to the project owner and answered:

1. **The names line up on the PRODUCER's spelling** — the handler now reads `productTitle` and
   `startAt`, the names the event has always used and the customer stack already reads. The event
   gained `bookingNumber`, `customerName` and `vendorTimezone`; nothing was renamed.
2. **A booking has a number now.** `Booking.bookingNumber` — `BKG-2026-000123`, generated at
   creation by `booking/utils/booking-number.generator.ts`, deliberately the same shape as
   `ORD-2026-000123` because a vendor reads both on one screen. Its sequence comes from an atomic
   `$inc` on `sequence_counters` rather than the order generator's `countDocuments() + 1`, which
   is a race two simultaneous bookings both lose. `null` on legacy rows, not backfilled (D-5),
   and every reader has a fallback.

**The message says something now**, which was the other half of the ask — the old copy was
correct-but-useless even once its three values were real. `vendor_booking_created` was widened
**3 → 5 params** (⚠ a Business Manager edit + re-approval in all five languages, tracked in
`api-doc/notifications/whatsapp-templates.md` §3) to add the customer's name and a
confirm-or-decline line. A `manual`-mode booking sits waiting for the vendor to accept it and the
old copy never said so:

> New booking #BKG-2026-000123 — Deep Tissue Massage for Awa Ndongo on 2026-09-12 14:30.
> It is waiting for you to confirm or decline it.

The date is also **timezone-correct now**. It was `toLocaleString()` with no zone and no locale,
so it rendered in whatever zone the Node process runs in — UTC in a container, an hour off for
every vendor in Douala, and wrong in a way nothing in the message discloses.

**Pinned by `npm run test:booking-notification` (40, DB-free).** Its first section is the one that
matters: for every `booking.*` event, every field either handler reads must be one the producer
publishes, by source scan. Nothing else can see this class of defect — `DomainEvent.payload` is
`any`, so both halves type-check perfectly while agreeing on nothing.

### KI-3 · A tool catalogue entry described fields that do not exist

**Already fixed**, recorded because of what it says about the rest of the catalogue.

Three booking tools told the chat assistant to read fields called `bookingNumber`,
`productTitle`, `vendorName`, `quotedPrice`, `finalPrice`, `outstanding` and `creditDue`. None
of those existed in what the backend actually sent. This is the third time this has happened
(support tickets had the same problem with `ticket_number`), which suggests the rest of
`tools/catalog.json` is worth one careful pass against the real responses.

## 4 · Steps 1–7 — the tools, in build order

Ordered by *value per unit of risk*: the reads and the completions first, the money and the
credentials last.

### Step 1 · Complete the account basics (5 tools) ✅ **DONE 2026-09-06**

**Built and live-verified** against the seeded customer and over MCP. `test:bot-surface`
**182/0**. Two of the five are model-facing (`profile_update`, `recently_viewed_list`) and
are on the MCP server now; the other three are `flow_only`, so by the tier rule they are
**deliberately not registered with the model** — Step 8's generator must keep honouring that.

Three decisions taken while building:

1. **`profile_update` writes ONE field, `name`.** The customer API takes seven; each of the
   six omissions is a decision recorded in `BotProfileUpdateSchema`. The sharp one is
   ⛔ `recentProductCode`, which is **server-managed** — `recentlyViewedService` orders and
   caps the list by it, so a caller-chosen value is a caller-chosen position in a bounded
   list. `bio` and `dateOfBirth` are refused because `toBotProfileSummary` drops them, so a
   customer could set something they can never read back here.
2. **`recently_viewed_list` gets NO `moreUrl`**, and `windowForChat` grew `surface: null`
   for it. The storefront records views from the product page and lists them on **no page at
   all** — verified in `frontend/landing`, where the only reference is the write. An
   invitation to "see the rest on the website" would be an invitation to a page that does
   not show them.
3. **Removing an address does not elect a replacement default.** That is the customer API's
   behaviour and it stays: the platform choosing where a parcel goes is worse than checkout
   asking. The response reports `hasDefault` so the bot can say so rather than letting the
   customer discover it at checkout.

⚠ **A pre-existing catalogue/schema drift was found and NOT fixed** (it is another feature's
contract): `identity_sync_sender.response.relay_verbatim`,
`identity_submit_onboarding.response.relay_verbatim` and `catalog_resolve_sku.response.notes`
are keys `tool.schema.json` does not allow, and `response` is `additionalProperties: false`.
`ajv` would reject the catalogue today. Either the schema widens or those three move — a
decision for whoever owns GAP-002 and GAP-003.

⚠ **`api-doc/n8n/bot-surface.md` § 3 said "three routes are DELETE with a body" and is now
five.** Corrected, with a note telling the reader to count the table rather than trust the
sentence — it is prose, and nothing asserts it.

**Original plan for this step, for reference:**

| Tool | Backend endpoint (exists) | Notes |
|---|---|---|
| `profile_update` | `PATCH /api/customer/profile` | name and preferences; language already has its own tool |
| `addresses_update` | `PATCH /api/customer/addresses/:id` | ⚠ must take a `geoCandidateRef`, never coordinates — same rule as `addresses_add` |
| `addresses_remove` | `DELETE /api/customer/addresses/:id` | `mutating`, confirmation |
| `recently_viewed_list` | `GET /api/customer/recently-viewed` | list → capped |
| `recently_viewed_clear` | `DELETE /api/customer/recently-viewed` | `mutating` |

⚠ `addresses_update` inherits the trap that made "add a second saved address" impossible: the
saved-address array is `2dsphere`-indexed and a null `location` bricks the whole customer
document. Reuse `__toSavedAddressInput`; write no `location` key.

### Step 2 · Notifications (4 tools) ✅ **DONE 2026-09-06**

`test:bot-surface` **188/0**, `test:customer-notifications` 53/0. Three are model-facing and
on the MCP server; `notifications_mark_all_read` is **`flow_only`** — nothing on this
platform can mark a notification unread again, and the unread flag is how a customer finds
what they have not seen, so a model must not clear an inbox on its own reading of "yeah I
know about those".

**The list is PROJECTED, not relayed** — one of the few routes here that builds its own
shape. Three fields on the stored document must never reach a model: `idempotencyKey`,
`deliveryErrors[]` (raw SMTP/Meta error strings — operator diagnostics) and `customerId`.
`deliveredVia` and `readAt` go too, as chat noise. A leak assertion pins all five.

**Two defects found, one fixed and one referred:**

1. ✅ **FIXED — the customer API could not filter to ticket notifications.** Its list filter
   hardcoded `['booking','order','shipment','payment']` while GAP-012 added `ticket` to
   `CUSTOMER_AGGREGATE_TYPES`, so the platform wrote notifications a customer could not ask
   for and got a `400` on a value the platform itself produces. Exactly the drift
   `customer-notification.model.ts` warns about at its own Mongoose enum, one layer up. Both
   surfaces now spread the constant. Widening only, so no caller changes behaviour. Verified
   live over MCP: `aggregateType: "ticket"` is accepted.
2. ✅ **REFERRED, then ANSWERED — 2026-09-07.** This read *"every customer notification's
   action URL is broken, platform-wide"*, and it was true: `customer-notification-catalog.ts`
   built its buttons from bare nouns (`orders/{{orderId}}`, `support/{{ticketId}}`,
   `bookings/{{bookingId}}`, `pay/{{payToken}}` and two more) and **`frontend/landing` served
   none of those paths** — no root-level segment, no rewrite, the real pages one level down
   under `/shop/account/…`. Never a bot defect: the same URL went into every notification
   email and every WhatsApp and Telegram button.

   **Four of the six now point at real pages** and every URL gained the locale prefix it had
   never carried. The record is `api-doc/notifications/storefront-routes.md`; the amended
   block is `bot-surface.md` § 6b.

   ⛔ **Two are still dead, and one is minted by a tool in this plan.**
   `payment_create_pay_link` returns `{STOREFRONT_URL}/pay/{token}` and `/pay/:token` is not
   built, so that tool hands a live customer a dead link. The tracking page is the other.
   Both are frontend work with the addresses pinned.

   ⚠ **The order button needed an owner decision precisely because it was not a rename.** The
   storefront's order page takes a **cartId** (a checkout group); the notification carries the
   **orderId** of the one parcel it is about. The owner chose a new single-order route over
   sending the group id. The bot's position is unchanged throughout: it relays what the
   platform stored rather than papering over it.

**Original plan for this step, for reference:**

| Tool | Backend endpoint |
|---|---|
| `notifications_list` | `GET /api/customer/notifications` |
| `notifications_unread_count` | `GET /api/customer/notifications/unread-count` |
| `notifications_mark_read` | `PATCH /api/customer/notifications/:id/read` |
| `notifications_mark_all_read` | `PATCH /api/customer/notifications/read-all` |

The preferences pair already exists. This closes the group.

### Step 3 · Reviews (1 tool) ✅ **DONE 2026-09-06**

`reviews_list_mine` → `POST /api/internal/bot/reviews/list`, backed by
`GET /api/customer/reviews`. `test:bot-surface` **197/0** · `verify:bot-surface` **83/0**.
`extended` tier, so it is model-facing.

**Live-verified** against the seeded customer (`seed:customer`, WhatsApp `237600000001`,
language `fr`), whose three reviews are exactly the fixture this needed — two `product` and
one `delivery`, all stored `published`:

```jsonc
{ "subject": { "type": "product",  "id": "…" }, "subjectLabel": "Best Car",
  "status": "published", "publiclyVisible": true  },
{ "subject": { "type": "delivery", "id": "…" }, "subjectLabel": null,
  "status": "published", "publiclyVisible": false, "orderId": "…" }   // ← the trap, on real data
```

and `{ limit: 1 }` answers
`meta: { shown: 1, total: 3, hasMore: true, moreUrl: ".../fr/shop/account/reviews" }` — the
locale prefix present, because the customer is French. `limit: 6` and `subjectType` are both
`400` with a localised `customerMessage`, not a silent clamp or a stripped key.
`verify:bot-surface` **83/0** (was 80 — three dispatch assertions added, because
`/reviews/list` sits beside the bare `POST /reviews` and reaching the *write* by mistake
would answer `400`, not `404`).

⛔ **The MCP server node is saved but NOT PUBLISHED.** `wi-mall-mcp` (`3X8oYCQZkCi7Wg4r`) has
the `reviews_list_mine` `httpRequestTool` wired to the trigger as its ninth tool, in the
**draft** version — `activeVersionId` still points at the eight-tool version, so a live
`tools/list` does not show it yet. **Publish the workflow to finish this step.**

⚠ **Unrelated, found while wiring it: `wi-mall-mcp`'s own description and its sticky note
both still say *"Identity travels on the endpoint URL query string, never as a tool
argument"*, which is the mechanism that was MEASURED NOT TO WORK** and replaced by the
sealed `botToken` (§ 2b). Every one of the nine tool nodes reads `$fromAI('botToken', …)`.
The text describes a design that was abandoned before the first tool shipped, and it is the
first thing a reader of that workflow meets.

The plan's own ⚠ — *reuse the customer DTO, not the public one* — was right and was not the
interesting part. Three things surfaced while building:

1. ⭐ **`status: "published"` does not mean "anyone can see it", and relaying it alone
   would make the bot lie.** A **delivery** review is an internal quality signal about the
   carrier: it moves the agent's aggregate and feeds their trust score, and it publishes to
   no page anywhere — `listPublicForProduct` is the only public review read there is. But a
   bare-star review carries no prose for a moderator, so `initialStatusOf` writes it
   straight to `published`. A model handed `status` says *"your review is live"* about
   something the customer will never find, and then offers a link to look for it.

   So the projection computes **`publiclyVisible`** (`product` **and** `published`) beside
   the relayed `status`. The storefront's own page already makes this determination — its
   `StatusBadge` shows "Delivery feedback" instead of a status — so the choice was never
   whether to make it, only whether to make it twice and let the two disagree. Fifth
   instance of the § 14 rule. `bot-surface.md` § 6c is the record.

2. **The list hydrates product names, in ONE batched read.** `AuthorReviewDto` carries
   `subjectId` and nothing else about the subject, which on a page is fine (the storefront's
   own review page shows no product name either) and in a chat is useless — the model cannot
   say what the review was *about* without five `catalog_get_product` calls. Resolved
   through `publicCatalogService.listByIds`, the same call `support-context.service.ts`
   uses, because it carries the **publishable predicate**: the bot cannot name a product a
   shopper could not open. `subjectLabel` is null for those and null for every delivery
   review, and `orderId` is the handle for the rows it cannot name.

3. **No `subjectType` filter, deliberately.** Pairing it with `status` invites
   `{ subjectType: 'delivery', status: 'published' }` — a query whose name promises a page
   nothing will ever appear on.

**Two guards were repaired, and both had already drifted:**

⚠ **`test:bot-surface` § 13's "every model-facing list handler goes through
`windowForChat`" was a hardcoded list of six, written at Step 0 and NOT extended when
Step 1 added `recently_viewed_list` or Step 2 added `notifications_list`.** For two steps it
was passing on a set that no longer matched the surface — the exact failure it exists to
catch, one level up. It is derived from `BOT_ROUTES` now, so a list route that is neither
windowed nor explicitly exempt fails.

Deriving it immediately found **`orders_list_shipments`, which does not window and should
not** — truncating one order's parcels is a *wrong* answer, not a short one ("three of your
seven parcels" reads as "you have three"), and there is no page to link to because the
storefront's order route takes a **cartId** while this route is addressed by orderId (the
⛔ in § 6b). It and `geo_search_address` are now written-down exemptions with their reasons,
rather than rows nobody had looked at.

⚠ **`catalog.json` does not conform to its own `tool.schema.json`, Step 1 counted three
violations and there are six**, and nothing anywhere checks. There is no ajv step, and this
repository's ajv is v6 — it cannot even load a 2020-12 schema, so the file has been
decorative since it was written. Step 1's three `response` keys (`relay_verbatim` ×2,
`notes`) are joined by three **top-level** `notes` keys on the payment and messaging rows,
which its scan did not look at.

Still not fixed — they are GAP-002/003/012's contract keys — but they are now a **closed
waiver set** in `test:bot-surface` § 1, which does the structural half of what ajv would.
A new violation fails; so does a waived one that gets fixed and left in the list.

One thing WAS fixed, because it is this plan's own mess: `gap_ref`'s pattern was
`^GAP-[0-9]{3}$`, which refuses the `MCP-PARITY-n` value Steps 1–3 have now written on ten
rows. The pattern was widened rather than the ten rows renamed — this is a parity step, not
a gap.

**Original plan for this step, for reference:**

| Tool | Backend endpoint |
|---|---|
| `reviews_list_mine` | `GET /api/customer/reviews` |

⚠ Reuse the **customer** review DTO, not the public one — a customer reading their own review
must see its moderation status, and the public projection deliberately strips author identity.

### Step 4 · Bookings — the largest gap ✅ **DONE 2026-09-06** (7 tools, not 9)

`test:bot-surface` **213/0** · `verify:bot-surface` **94/0** · `test:errors` **74/0**. The
plan asked for nine tools; **seven** were built, three of the existing booking tools were
re-shaped, and the two omissions are the interesting part.

⛔ **Five tool nodes are wired on the `wi-mall-mcp` DRAFT and NOT published** —
`bookings_list`, `bookings_get_availability`, `bookings_get`, `bookings_get_balance`,
`bookings_payment_status`. The five `flow_only` ones are deliberately absent, per the tier
rule. Together with step 3's `reviews_list_mine` the draft holds **six** unpublished tools
and needs one click.

| Tool | Route | Tier |
|---|---|---|
| `bookings_get_availability` | `POST /bookings/availability` | core |
| `bookings_create` | `POST /bookings` | flow_only + confirmation |
| `bookings_reschedule` | `PATCH /bookings/:bookingId/reschedule` | flow_only + confirmation |
| `bookings_get_balance` | `POST /bookings/:bookingId/balance` | extended |
| `bookings_payment_status` | `POST /bookings/:bookingId/payment-status` | extended |
| `bookings_pay` | `POST /bookings/:bookingId/pay` | flow_only + confirmation |
| `bookings_pay_balance` | `POST /bookings/:bookingId/pay-balance` | flow_only + confirmation |

#### ⛔ `bookings_lock_slot` and `bookings_unlock_slot` were NOT built

The plan flagged the trap itself — *"a lock taken on the model's initiative and never
released sells nobody the slot for a quarter of an hour"* — and then mitigated it with a
rule: **flow_only**, called only immediately before a confirmation turn, with unlock on
every abandoned path.

**That rule lives in a flow author's head**, which is the precise argument Step 0 used to
make the five-item cap structural instead of a line in the prompt. A chat turn can take
minutes and can simply never come back; the customer puts the phone down mid-sentence, and a
real appointment is off sale for fifteen minutes for somebody who has already left.

So `bookings_create` and `bookings_reschedule` **take the hold themselves**, immediately
before committing, and release it in a `finally` when the commit fails. There is no
bot-reachable path on which a hold outlives the request that took it, and the two tools that
could create one do not exist.

⚠ **This is also stricter than the customer API.** `BookingService.createBooking` releases
the hold at step 4 — *after* its transaction commits — so a `BOOKING_SLOT_UNAVAILABLE`
there leaves a dead hold to expire on its own TTL. `verify:bot-surface` pins the bot's
behaviour by attempting the same slot twice and asserting the second call is not a `409`.

#### ⭐ The decision this step is really about: two `pending`s on one document

`status: 'pending'` means the **vendor** has not accepted the appointment — a `manual`-mode
service is held until they do. `paymentStatus: 'pending'` means **money is in flight**, a
prompt sitting on the customer's handset. Same object, same word, unrelated meanings.

A model handed both merges them, and the two available mistakes are the two worst ones:
telling somebody they are booked when the vendor has not looked, or telling them to pay
again while a charge is live. So the projection computes **`awaitingVendorApproval`** beside
the relayed `status` — the same shape as Step 3's `publiclyVisible`, and the sixth instance
of the § 14 rule.

#### Four more decisions

1. **All five booking reads/writes now go through one projection**, which is a **deliberate
   breaking change to three shipped routes** (`bookings_list`, `bookings_get`,
   `bookings_cancel` relayed the raw Mongoose document). Safe: **no booking tool is on
   `wi-mall-mcp`, and `wi-mall-core` has never been activated** (`activeVersionId: null`,
   verified). The document leaked `metadata` — `Mixed`, and **writable by any web caller**
   through the customer API's own book route — plus `externalCalendarEventId`, a handle into
   the *vendor's* Google Calendar. Two shapes for one entity was the alternative, forever.
2. **`from`/`to` are optional on availability and mandatory on the customer API.** That
   endpoint 400s without both because a calendar widget always knows which fortnight it is
   drawing. A model does not, and making it compute two ISO-8601 instants is making it do
   date arithmetic — which fails *quietly*, as "no availability" for a product with plenty.
   Default: now → +21 days, the storefront's own `WINDOW_DAYS`.
3. **`bookings_create` takes `notes`, never a `metadata` object.** The customer API forwards
   an arbitrary blob onto the booking, and `createBooking` renders `metadata.notes` into the
   vendor's calendar event. One key has a defined destination; a model-authored object in a
   real business's calendar is not something the customer asked for.
4. **Booking payments rejoin the ordinary money tools.** Both pay routes answer a
   `transactionId`, which is what `payment_get_transaction`, `payment_authorize_otp` and
   `payment_create_pay_link` already take. No new payment machinery, and `cardToken` /
   `customerName` are absent from the schema — a card token has no business on a chat
   transport.

`ProductBookingService`'s seven-dependency assembly moved out of `product-booking.routes.ts`
into `product-booking.instance.ts`, so both doors share one wired service. Two hand-wired
copies is two chances to hand it a differently-configured `AvailabilityService`, which would
show up as the two doors disagreeing about when a product is free.

#### The error copy the `conflict` fallback would have got wrong

Seven codes gained per-code `customerMessage` entries, and the test for adding one —
*does the customer do something different?* — is met twice over here. The `conflict`
category fallback is **"That has already changed. Let me check where things stand and try
again."**, and for this family that is wrong in two ways: for a slot that is gone it
invites a retry that cannot ever succeed, and for `PAYMENT_BOOKING_IN_PROGRESS` it invites
**a second payment prompt on a real handset**.

`BOOKING_SLOT_UNAVAILABLE` · `BOOKING_SLOT_LOCKED` · `BOOKING_SLOT_FULL` ·
`BOOKING_NOT_RESCHEDULABLE` · `PAYMENT_BOOKING_IN_PROGRESS` ·
`PAYMENT_BOOKING_ALREADY_PAID` · `BOOKING_NO_BALANCE_DUE`, in all five languages.

⚠ **`test:errors` § 8 caught a real gap and is worth the mention.** The new
`createAppError(BOOKING_SLOT_LOCKED, 409)` call site was the code's first raise WITHOUT an
inline message — `product-booking.routes.ts` passes one as a literal — so it fell through to
the registry default and rendered as *"An unexpected error occurred"*. The baseline guard
refused to grow. `DEFAULT_ERROR_MESSAGES` gained the entry rather than the call site gaining
a literal: one message per code is the point of the registry.

#### Three defects found

1. ✅ **A capacity-mode service could not be RESCHEDULED — CLOSED, see KI-1 above.** Left in
   its original wording because the diagnosis is the useful part; do not read the ⛔ below as
   an open defect.

   ⛔ **A capacity-mode service CANNOT BE RESCHEDULED — on this surface or on the website.**
   `BookingService.rescheduleBooking` asserts the hold on the unscoped key
   (`slot:lock:{slotId}`, `scopeToOwner` defaulted to `false`) while `lockSlot` writes the
   **owner-scoped** one (`slot:lock:{slotId}:{userId}`) for capacity products. The two
   address different keys, so the assert always misses and the move is refused with
   `409 BOOKING_SLOT_NOT_LOCKED` however correct the request. The storefront's reschedule
   page takes the same lock through the same route and hits the same wall.
   **Not worked around**: using the unscoped key just for the bot would make this door behave
   differently from the one beside it and would hide the defect. `SlotLockService.extend`
   carries a comment about this exact asymmetry, having been fixed for it once already.
2. ✅ **Vendor "new booking" notifications rendered empty — CLOSED, see KI-2 above**, which
   also records that the symptom as written below was itself wrong (`renderTemplate` emits an
   empty string, never the literal `undefined`). Kept for the producer↔consumer lesson.

   ⛔ **Every vendor "new booking" notification renders with three missing substitutions,
   live.** `vendor-notification-event-handler.service.ts:147` destructures
   `{ bookingNumber, serviceName, startTime }` out of the `booking.created` payload, and
   `emitBookingCreatedEvent` publishes **none of those three** — it sends `productTitle`,
   `vendorName` and `startAt`. So the template *"New booking #{{bookingNumber}} for
   {{serviceName}} scheduled on {{startDate}}"* renders with two `undefined`s and
   `new Date(undefined).toLocaleString()` → **`Invalid Date`**, in all five languages, on
   email and WhatsApp and Telegram alike. Outside this step (it is the notifications module),
   and reported rather than fixed.
3. ⚠ **`bookingNumber` does not exist and three catalogue rows advertised it.**
   `bookings_list`, `bookings_get` and `bookings_cancel` named `bookingNumber`,
   `productTitle`, `vendorName`, `quotedPrice`, `finalPrice`, `outstanding` and `creditDue`
   in `important_fields`; the model carries `priceSnapshot`, `settlement.*` and populated
   refs, and **has never had a `bookingNumber` at all** (verified by source scan — it exists
   only as a notification placeholder, which is defect 2). Third instance of the
   `ticket_number` class the bot ticket controller already documents. All three rows now
   describe the projection they actually return.

**Original plan for this step, for reference:**

| Tool | Backend endpoint | Tier |
|---|---|---|
| `bookings_get_availability` | `GET /api/products/:productId/availability` | core |
| `bookings_lock_slot` | `POST /api/products/:productId/slots/:slotId/lock` | flow_only |
| `bookings_unlock_slot` | `POST /api/products/:productId/slots/:slotId/unlock` | flow_only |
| `bookings_create` | `POST /api/products/:productId/book` | flow_only + confirmation |
| `bookings_reschedule` | `PATCH /api/customer/bookings/:id/reschedule` | flow_only + confirmation |
| `bookings_get_balance` | `GET /api/customer/bookings/:id/balance` | extended |
| `bookings_pay_balance` | `POST /api/customer/bookings/:id/pay-balance` | flow_only |
| `bookings_pay` | `POST /api/bookings/:id/pay` | flow_only |
| `bookings_payment_status` | `GET /api/bookings/:id/payment-status` | extended |

⚠ **The 15-minute Redis slot lock is the trap.** A chat turn can take minutes — the customer
walks away mid-conversation — so a lock taken on the model's initiative and never released
sells nobody the slot for a quarter of an hour. Rules: `bookings_lock_slot` is **flow_only**,
it is called only immediately before a confirmation turn, and `bookings_unlock_slot` runs on
every abandoned path. The booking-row CAS is the real guarantee (see jovi-mall `CLAUDE.md`
§ Bookings); the lock is politeness and must not be treated as a reservation.

⚠ **`bookings_pay_balance` moves money.** It reuses `payment_create_pay_link`'s shape — the
tool returns a link, the customer pays on a page. No tool anywhere takes a card or a PIN.

### Step 5 · Payment methods (4 tools) ✅ **DONE 2026-09-06**

`test:bot-surface` **221/0**. All four built as planned.

| Tool | Route | Tier |
|---|---|---|
| `payment_methods_list` | `POST /payment-methods/list` | extended |
| `payment_methods_add` | `POST /payment-methods` | flow_only + confirmation |
| `payment_methods_set_default` | `PATCH /payment-methods/:methodId/default` | flow_only + confirmation |
| `payment_methods_remove` | `DELETE /payment-methods/:methodId` | flow_only + confirmation |

⛔ **One tool node (`payment_methods_list`) is wired on the `wi-mall-mcp` DRAFT and NOT
published**; the other three are `flow_only` and deliberately absent.

**The plan's masking ⚠ was already satisfied.** `PaymentMethodMapper.toDto` has never returned
`gateway_customer_id` or `gateway_instrument_id`. There was nothing to add — only a leak
assertion to write, which matters more here than it looks: for a **wallet** those two fields
*are* the customer's phone number, stored twice.

#### ⭐ A card cannot be saved from a chat, and it is structural

`POST /api/me/payment-methods` requires `gateway_customer_id` and `gateway_instrument_id`. For a
card the payment gateway's own SDK mints those **in a browser**, after the shopper types a number
the platform never sees. A chat has no browser and no SDK, so there is no honest way for a chat
caller to hold one — a model asked for those two fields would supply something invented.

For a **wallet** they are not tokens at all: the storefront sends the customer's E.164 number as
**both** values, because for mobile money the customer and the instrument are one thing. So
`payment_methods_add` takes `provider` + `phoneNumber` and composes the rest server-side —
including `display_label` and `last4`, which a model must **not** write: the label is what the
customer is shown at checkout, and one naming the wrong network is worse than none.

The schema offers no `method_type`, no `gateway_*` and no card fields, and it is `.strict()`, so
sending one is a 400 rather than a stripped field.

#### ⭐ `expired`, and the off-by-a-month that writes itself

An expired card stays in the list and still looks like a way to pay — nothing removes it, and the
customer API reports the month and the year as two plain numbers for the reader to compare
against today. That comparison, done by a model, is date arithmetic: it fails quietly, and the
failure lands as *"use your Visa ending 4242"* followed by a decline the customer has to work out
alone. So it is computed once, here.

⚠ **A card is good through the LAST DAY of its expiry month**, so the boundary is the first of
the month *after* it. Comparing against the first of the expiry month — the version somebody
writes without thinking — calls a perfectly good card dead for up to 31 days. Pinned by three
assertions on the boundary itself.

#### Three smaller decisions

1. **The default sorts first**, as `addresses_list` does. The chat cap is five and the platform
   allows ten, so a stored-order list could drop the one method the answer is about.
2. **`set_default` answers the whole list**, not the one row — setting a default clears the flag
   on every sibling, and a caller holding one updated row believes a stale list.
3. **Removing the default elects no replacement.** The customer API's behaviour, kept; the
   response reports `hasDefault` so a chat can say so rather than the customer discovering it at
   checkout.

⚠ **What this tool cannot do, and it is worth stating plainly.** The wallet's number is never
returned, so a saved wallet lets a chat *name* it and set it as the default — it does **not** let
a payment be filled in, and `bookings_pay` still asks for the number. The storefront hits the same
wall and works around it by keeping a copy in the browser's own storage; a chat has no equivalent.
Not a defect here, and not fixable without publishing the number.

`BotListDestination` gained a `paymentMethods` surface (`/shop/account/payment-methods`).

**Original plan for this step, for reference:**

| Tool | Backend endpoint | Tier |
|---|---|---|
| `payment_methods_list` | `GET /api/me/payment-methods` | extended |
| `payment_methods_add` | `POST /api/me/payment-methods` | flow_only |
| `payment_methods_set_default` | `PATCH /api/me/payment-methods/:id/default` | flow_only |
| `payment_methods_remove` | `DELETE /api/me/payment-methods/:id` | flow_only |

⚠ **The list must return the MASKED projection** that already exists (`maskPayoutMethods`'s
customer twin) — never a full mobile-money number into a model's context.

⚠ `/api/customer/payment-methods` is the **legacy** pair and is superseded by `/api/me/...`;
build against the latter only, so the bot surface does not pin a path the platform is leaving.

### Step 6 · Contact changes (6 tools) ✅ **DONE 2026-09-06**

| Tool | Bot route | Backend endpoint | Tier |
|---|---|---|---|
| `contact_get_state` | `POST /contact` | `GET /api/me/contact` | extended |
| `contact_change_email` | `PATCH /contact/email` | `PATCH /api/me/email` | flow_only |
| `contact_cancel_email_change` | `DELETE /contact/email/pending` | `DELETE /api/me/email/pending` | flow_only |
| `contact_change_phone` | `PATCH /contact/phone` | `PATCH /api/me/phone` | flow_only |
| `contact_confirm_phone` | `POST /contact/phone/confirm` | `POST /api/me/phone/confirm` | flow_only |
| `contact_cancel_phone_change` | `DELETE /contact/phone/pending` | `DELETE /api/me/phone/pending` | flow_only |

Contract: `bot-surface.md` § 15. Code: `controllers/bot-contact.controller.ts` +
`toBotContactState` in `dto/bot-projections.ts`.

**All five writes are `flow_only`, including the two CANCELS**, and that last part is a
decision rather than a copy-paste. A cancel destroys nothing durable — the customer simply
starts again — so it looks like the safe one to hand a model. It is not: cancelling
invalidates a link that is already sitting in a mail client, so the customer's *next* action
fails for a reason the chat never mentioned. Both failure directions read the same from their
side — *"I cannot get in and I do not know why"* — which is the same line all seven address
and payment-method writes already sit behind.

#### ⚠ The plan's own warning was HALF WRONG, and the true half is sharper

This step's brief said *"changing the login phone can orphan the conversation … the messaging
identity resolves through `login_phone` for WhatsApp (ladder step 2)"*. Verified in the
source: **for an already-bound sender it cannot.** `channel_connections` is step 1 of the
ladder and wins outright, so the binding survives the identifier moving underneath it — the
brief said as much in its own next sentence and then drew the conclusion from the first.

**What is actually true is a constraint the brief did not name at all:** the change usually
cannot be *finished* from the conversation it was started in. `ContactChangeService` proves a
new number by requiring a WhatsApp connection whose identity IS that number (there is no SMS
provider here, and a template to a stranger's number needs a credit wallet a customer does not
have), and an account holds **at most one** WhatsApp connection. So a customer whose WhatsApp
is bound to the OLD number must disconnect and reconnect from the new one; a customer on
Telegram must connect WhatsApp for the first time.

Three things came out of that, and the first is the deliverable:

- **`contact_get_state` answers a field the customer API does not have** —
  `phoneChangeProved`, three-valued (`null` nothing pending · `false` · `true`). Without it
  the only signal a customer gets is a `422` *after* they try. It is computed by
  `ContactChangeService.isPhoneChangeProved`, which was **made public in this step** so the
  bot surface calls it rather than re-deriving it: `external_id` arrives as bare digits while
  a login phone is strict E.164, and a second copy of that comparison reads `false` for every
  customer, always, while looking perfectly implemented. `test:bot-surface` § 16 scans for the
  delegation; `verify:bot-surface` proves the verdict against a real connection row.
- **The door does not refuse on that ground.** Opening a pending change is harmless and
  reversible and the customer may be about to go and connect the number.
- **The `reply` states the path**, in five languages
  (`botChrome('contactPhoneChangeStarted')`).

#### The masking asymmetry, which is the projection's whole reason to exist

Current identifiers **masked** (the rule `profile_get_summary` already set); a pending target
**verbatim**, because the read exists to answer *"which address should I be checking?"* and
`j••••t@example.com` does not answer it. `requestedAt` is dropped — `expiresAt` is the one a
chat can act on. Both halves are pinned, because masking the pending target would silently
make the flow unusable and un-masking the current one is a leak nothing else catches.

#### Three refusals earned customer copy and three did not

`CONTACT_CHANGE_PHONE_UNPROVEN` · `CONTACT_CHANGE_NOT_PENDING` · `CONTACT_CHANGE_EXPIRED` —
each because the **category fallback would send the customer to do the wrong thing**
(*"not something I can do right now"* invites waiting where the remedy is an action; *"that has
already changed — try again"* invites a retry that can never succeed).
`CONTACT_CHANGE_SAME_IDENTIFIER` and `CONTACT_CHANGE_IDENTIFIER_TAKEN` did not: their category
sentences already say the only true thing. `CONTACT_CHANGE_TOKEN_INVALID` is raised on a path
a chat never touches — **there is no `contact_confirm_email` and there cannot be one**, since
that confirm is unauthenticated and its token arrives in a mail client.

### Step 7 · The two gated actions ✅ **DONE 2026-09-06** — **4 tools, not 3**

| Tool | Bot route | Tier |
|---|---|---|
| `connections_list` | `POST /connections/list` | extended |
| `connections_disconnect` | `DELETE /connections/:channel` | **flow_only** |
| **`account_close_preview`** | `POST /account/close/preview` | **extended — added, see below** |
| `account_close` | `POST /account/close` | **flow_only** |

Contract: `bot-surface.md` § 16. Code: `controllers/bot-account.controller.ts` +
`toBotConnectionDto`.

#### ⭐ The fourth tool, and why the brief's "two-step confirmation" needed one

The brief asked for `account_close` to be *"flow_only, two-step confirmation, and the
confirmation must state that orders are retained pseudonymously"*. **Neither half of that is
deliverable from one route**, and the reasons are the ones this whole surface was built on:

- **The sentence.** The automation layer has no copy table and no translator — the argument
  that already put `error.customerMessage`, `onboarding.next.prompt` and the whole `reply`
  body on this side of the wire. Leaving the single most consequential sentence in the product
  to be composed by a flow is how a customer is told their orders will be deleted, in English,
  on the one turn that cannot be taken back. It is authored here now, in five languages, as
  `botChrome('accountClosurePrompt')`.
- **The blockers.** `close` refuses a dual-role account and one with orders in flight.
  Discovering that by *attempting the irreversible verb* and reading a `422` is a poor way to
  find out — and it happens after the customer has already confirmed.

⚠ **It had to be a separate ROUTE rather than a no-argument branch of `account_close`.**
That row is `mutating`, so `botIdempotency` demands a key on it, and a preview and a close
sharing one collide on the request fingerprint (`BOT_IDEMPOTENCY_KEY_REUSED`). A caller
working around that by minting two keys is a caller one mistake away from spending the close's
key on the preview. A non-mutating sibling has none of that — and, being a read, it is
**`extended`**, so a model can honestly answer *"how do I delete my account?"* and *"can I?"*
while the irreversible verb stays behind a flow.

Same shape as Step 4's refusal of the lock/unlock pair: a stated deviation, not a slip.

⚠ **The confirmation token is `ACCOUNT_CLOSURE_CONFIRMATION`, imported rather than retyped**,
and `test:bot-surface` § 16 asserts the catalogue's `confirmWith` enum against it. Two
spellings of one token is a flow that sends what the preview told it to and is refused every
time. It stays **untranslated** — it is an id the flow echoes after a button tap, exactly as
§ 14.6 requires, and what the customer *reads* is the localised `consequence`.

#### The one rule this step adds over the customer API

**`connections_disconnect` refuses the channel the request arrived on** —
`409 BOT_CONNECTION_ACTIVE_CHANNEL`, a new code with copy in five languages. A
`channel_connections` row is step 1 of the identity ladder, so cutting the current one leaves
this surface unable to resolve the sender it is mid-conversation with, and **the customer
cannot undo it from where they did it** (reconnecting needs a session, reached from the
storefront). That asymmetry is what makes it worth refusing rather than warning about.

Two properties are load-bearing and both are asserted: the check runs **before** the delegate
call (there is no re-bind verb, so a refusal reported after the unbind would describe
something that had already happened), and **the other channel stays disconnectable** — this is
not a blanket guard on the verb.

`isCurrentChannel` is computed in the projection rather than left to the caller: a caller
working it out means a caller comparing `channel` against something it believes about itself,
and the failure lands as a chat offering a disconnect button that answers 409. `howToConnect`
is dropped — relaying a `wa.me` deep link into a WhatsApp chat invites the customer to tap
through to the conversation they are already in.

#### `connections_list` is the THIRD exempt list, and the exemption is written down

`CONNECTION_CHANNELS` has exactly two members and the response always carries both, so the set
is closed at two, can never reach the five-row cap, and has nothing a `moreUrl` could point
at. `test:bot-surface` § 13 derives its check from `BOT_ROUTES`, so a `*_list*` tool must be
windowed or named in the exemption table — this one is named, beside `orders_list_shipments`
and `geo_search_address`.

### What these two steps cost, and what they are pinned by

**Ten tools, three of them model-facing.** The generator emits **49** now (was 46):
`contact_get_state`, `connections_list` and `account_close_preview`. Every one of the seven
writes is `flow_only`, and § 16 asserts that by name rather than relying on § 15's
"no `flow_only` is emitted" — which passes just as well when nothing is flow_only.

| | |
|---|---|
| `npm run test:bot-surface` | **245 / 0** — § 16 is the new group (11 assertions) |
| `npm run verify:bot-surface` | **112 / 0** — 16 new live assertions |
| `npm run test:errors` | 74 / 0 (one new code, `BOT_CONNECTION_ACTIVE_CHANNEL`) |
| `npm run gen:mcp-workflow` | 49 tools, 103 operations |
| `npx tsc --noEmit -p tsconfig{,.scripts}.json` | clean |

⚠ **The ops file is regenerated and NOT applied.** `api-doc/n8n/generated/wi-mall-mcp.ops.json`
now describes a 49-tool server; the live `wi-mall-mcp` workflow still holds 46 until somebody
applies it. That is an owner action, the same as Step 8's was.

### Step 7b · `tickets_add_attachment` ✅ **DONE 2026-09-07 — and it was two tools, not one**

**Built:** `files_receive_inbound` (`POST /files/inbound`, **flow_only**) and
`tickets_add_attachment` (`POST /tickets/:ticketId/attachments`, **extended**). Contract:
`api-doc/n8n/bot-surface.md` § 17. Catalogue is at **97** tools, **50** of them emitted.

| | |
|---|---|
| `npm run test:bot-surface` | **257 / 0** — § 17 is the new group (12 assertions) |
| `npm run verify:bot-surface` | **121 / 0** — § 12 is the new group (9 live assertions) |
| `npm run test:errors` | 74 / 0 (one new code, `BOT_INBOUND_FILE_EXPIRED`) |
| `npm run test:env` | 38 / 0 (one new variable, `BOT_FILE_BODY_LIMIT`) |
| `npm run gen:mcp-workflow` | 50 tools, 29 operations against the live node set |
| `npx tsc --noEmit -p tsconfig{,.scripts}.json` | clean |

#### ⭐ One tool could not have worked, and the reason generalises

The obvious shape is a single `tickets_add_attachment` taking the file. It cannot exist,
because **no one party can both hold the bytes and decide where they go**:

- the **model** has no bytes and no channel credentials — a `fileId` parameter is a field it
  fills in by invention;
- the **backend** must not fetch a caller-supplied URL (that is an outbound request to wherever
  the caller points it) and must not hold Meta's and Telegram's tokens;
- **n8n** has the bytes and cannot decide whether a photo is evidence for a ticket, which
  ticket, or whether the ticket exists yet.

So the intake is deterministic and the decision is the model's, joined by an opaque
**reference**. That is `GeoCandidateStore`'s pattern applied to a second problem — the model
names a handle, never a resource — and `InboundFileStore` is deliberately a separate class
rather than a generalisation of it, for the one behaviour that differs (below).

#### The four decisions worth knowing

1. **A FAILED attach puts the reference back.** `GeoCandidateStore` has no counterpart and
   should not: a spent geo handle costs a re-typed address, a spent file handle costs a photo
   the customer may no longer have. The attach fails for reasons that are theirs to fix — the
   five-per-ticket limit above all — and burning the handle turns *"that ticket already has
   five files"* into *"…and now send it again"*, for a file sitting in storage, correct and
   unused. The follower check therefore runs **before** `consume`, so a ticket id the model got
   wrong costs nothing either.
2. **The chat allowlist is narrower than the pipeline's** — images and PDF, not the pipeline's
   zip and two audio types. Voice notes are the case that decides it: both channels send
   `audio/ogg`, which the pipeline refuses anyway, so forwarding one spends a channel download
   to buy a guaranteed refusal. Enforced on both sides — n8n filters before it fetches, the
   backend refuses regardless.
3. **The upload is stamped `ownerType: 'customer'` / `ownerId: customerId`, and that is not
   bookkeeping.** `TicketAttachmentService.enforceFileAttachmentAuthorization` compares exactly
   those two fields against the actor, so any other stamp stores the file successfully and then
   refuses every attempt to attach it — a failure one route away from its cause.
4. **`TICKET_ATTACHMENT_LIMIT` is now exported.** It was a bare `5` inside `attachFile`, and the
   bot reports `attachmentCount` / `attachmentLimit` on the success response so a chat can say
   *"that is the fifth and last"* at the only moment saying it is free. Two numbers, one
   constant — a chat saying "4 of 5" while the service refuses at 3 is worse than silence.

#### ⚠ `app.ts` mounts a SECOND JSON body parser, on one path

`JSON_BODY_LIMIT` is 1 MB and base64 inflates by a third, so the global ceiling refuses every
real photo. `BOT_FILE_BODY_LIMIT` (12mb) is mounted on `/api/internal/bot/files/inbound` alone,
**above** the global parser — body-parser marks a request it has already read, so the global one
no-ops on it. Mounted the other way round the 1 MB limit fires first and the wide one is never
reached, with the code looking exactly as it does now; `test:bot-surface` § 17 pins the order.

It is the **backstop, not the refusal**. `BOT_INBOUND_FILE_MAX_BYTES` (8 MB, applied to the
DECODED buffer) is lower so it always fires first, because a body-parser 413 carries no error
code for a chat to relay.

#### The n8n half — built and published

| Workflow | What changed |
|---|---|
| `wi-mall-tg-adapter` | `is media?` → `fetch telegram file` (getFile + download) → `to base64`. `normalize` emits `kind: 'media'` with the caption as `text` |
| `wi-mall-wa-adapter` | `is media?` → `wa media meta` → `wa media bytes` → `to base64`. Meta needs **two** calls: the id resolves to a short-lived URL, and that URL still requires the bearer token |
| `wi-mall-core` | `is media?` → `upload inbound file` → `compose agent input`, on the agent branch only |
| `wi-mall-mcp` | `tickets_add_attachment` emitted; `files_receive_inbound` is flow_only and correctly absent |

All four are **published**, diffed from `activeVersionId` first. ⚠ `wi-mall-core`'s draft also
carried a concurrent, unrelated change — the language model swapped from Gemini 2.5 Flash Lite
to **Claude Sonnet 5** — which is exactly what § 11's diff-before-publish rule exists to
surface. It was published with the owner's explicit go-ahead rather than silently. Two sessions
have now edited these workflows on the same day, twice; do the diff.

⚠ **`compose agent input` runs on BOTH branches**, producing one `agentInput` the AI Agent reads
either way. The alternative — a conditional expression on the agent node guarding
`isExecuted` inline — is unreadable and is the kind of expression nobody edits correctly later.

⚠ **The system prompt gained a `FILES THE CUSTOMER SENDS` block, and it is load-bearing.**
Without an explicit *"you cannot see this"*, a model handed a filename describes what it assumes
is in the picture — so a customer is told their broken item looks fine. It is said twice: in the
per-turn note and in the prompt.

⚠ **`/files/inbound` is called AFTER `/identity/sync`, never before.** The row requires a
resolved customer, so a brand-new sender whose first message is a photo would be refused with
`BOT_IDENTITY_UNRESOLVED`. That is also why the upload sits on the **agent** branch and not in
the adapter: the adapter has no account yet, and a photo during onboarding answers no question
the checklist is asking.
---

## 5 · Step 8 — generate the MCP server from the catalogue ✅ **DONE 2026-09-06**

**Built:** `scripts/gen-mcp-workflow.ts` (`npm run gen:mcp-workflow`), which reads
`api-doc/n8n/tools/catalog.json` and emits **46** tool nodes in two renderings from one node
model — n8n Workflow SDK source (`api-doc/n8n/generated/wi-mall-mcp.workflow.ts`, validated
against the real SDK parser) and `update_workflow` operations
(`…/wi-mall-mcp.ops.json`, 97 of them). **`wi-mall-mcp` was rebuilt from it and is live**:
46 tool nodes, 46 `ai_tool` connections, **31 of them tools the agent could not see before**.
`test:bot-surface` **234/0** — § 15 is the new group, and it is the only place the server's
contents are constrained at all.

**Measured after the rebuild**, against the live workflow rather than the generator's own
output: 46 live tool nodes, missing 0, extra 0, **`flow_only` exposed 0**, every
`bot_internal` node carrying both the bearer credential and `X-Webhook-Secret`, every mutating
node carrying `Idempotency-Key`, and the door still answering **403** unauthenticated and
**403** on a wrong header.

✅ **The one check not run — an authenticated `tools/list` / `tools/call` — was RUN on
2026-09-07 and PASSED.** See § 11. It advertised 49 tools with zero `flow_only`, and a real
`tools/call` returned live backend data. The `X-MCP-Token` is now in jovi-mall's `.env`
(gitignored, read by nothing in `src/`), so it is repeatable rather than an owner action.

⚠ **This paragraph used to say the structural check "stands in for it", and that was too
generous.** The structural check reads the workflow definition; it cannot tell you the door
opens, the credential resolves, or the backend answers. All three turned out fine — but they
were unverified for a day, and one of them (the credential on a newly generated node) is
exactly what the apply warned might be missing.

### ⛔ `update_workflow` writes the DRAFT. Publishing is a SEPARATE call.

Every one of the 97 operations applied cleanly, every structural check passed, and the agent
was **still seeing the old 15 tools** — because `versionId` had moved and `activeVersionId`
had not. n8n reports the applied count and the new node total from the draft, so nothing in
any tool result says "not live", and `get_workflow_details` hands back the *draft* too.

**Check `versionId === activeVersionId` before claiming anything is live, and call**
`publish_workflow` **when it is not.** Both workflows needed it here — `wi-mall-mcp`
(46 tools) and `wi-mall-core` (the two deletions).

⚠ **Diff before publishing a workflow somebody else may also be editing.** `wi-mall-core` was
already carrying an unpublished draft when this session started, so publishing it blind could
have shipped another session's in-flight work. `get_workflow_versions_diff` from
`activeVersionId` to `versionId` showed exactly the two node removals and nothing else, which
is what made it safe. Do that check, not the optimistic assumption.

### Two renderings, and why the second exists

No tool can apply SDK code to an **existing** workflow, and `wi-mall-mcp` must keep its id:
`wi-mall-core`'s MCP Client Tool points at the endpoint path `wi-mall-customer`, and a second
workflow claiming that path collides with it while both are active. So the generator emits the
operations too, from the same node model — the SDK file is the reviewable artefact, the ops
file is what was actually applied. They cannot disagree about what the server holds.

### Six decisions this step took

1. ⛔ **`flow_only` is the only exclusion that matters, and it is now asserted rather than
   trusted.** `test:bot-surface` § 15 fails if a `flow_only` row ever appears in the emitted
   set. It also asserts a **count** (46), deliberately: every other assertion in that group
   passes on an *empty* emission, which is exactly the failure mode of a filter gone too
   broad.
2. **`page` and `limit` are never handed to the model, on any tool.** Step 0 capped chat lists
   at five with `meta.moreUrl` as the way out, and the MCP trigger's own instructions say "do
   not page through a list"; handing the model a `page` argument invites exactly that. The
   fifteen hand-written nodes had already omitted both — this makes it structural.
3. **The generator REFUSES rather than emitting an undescribed argument.** A bare
   `$fromAI('x', '', 'string')` is a value the model invents. A parameter needs a catalogue
   `description` **or** an enum; the constraint suffixes (`One of: …`, `Between n and m`,
   `A 24-character hexadecimal id`) are the schema restated, never new copy.
4. ⚠ **`$fromAI` string arguments are DOUBLE-quoted.** The catalogue's prose is full of
   apostrophes, and `\'` is **not a valid JSON escape** — a single-quoted argument would
   produce a workflow file that is not JSON. The SDK rendering uses `JSON.stringify` for the
   same reason rather than hand-rolling a literal at two levels of escaping.
5. **An optional argument is emitted as `… || undefined`**, which `JSON.stringify` drops. That
   also drops a falsy supplied value, which is correct for every optional argument on this
   surface (`unreadOnly: false` is the default; `minPrice: 0` filters nothing) and is what the
   hand-written nodes already did.
6. **A `public` catalogue tool carries no identity and no webhook secret**, and a
   `bot_internal` one always carries the sealed `botToken`. Both directions are asserted: a
   live credential on an unauthenticated shop read is as wrong as a missing one on a customer
   read. The trigger instructions gained the line that says so.

### The two things the brief asked to fix on the way past

- **The description and the sticky note both described the abandoned query-string identity
  design.** Both are generated now — `MCP_DESCRIPTION` and `STICKY_CONTENT` — so they cannot
  drift again. ⚠ n8n caps a workflow description at **255 characters** and refuses the write
  over it, which is why that constant is terse.
- ✅ **Step 10 is DONE** (below): `Get-Profile` and `Get-Support-Contacts` are deleted from
  `wi-mall-core`.

### ⚠ What this step cost, and the rule that came out of it

**21 uncommitted `catalog.json` entries were destroyed** partway through, by a
`git checkout -- api-doc/n8n/tools/catalog.json` run inside `jovi-mall/`. That directory is its
**own repository** with a large uncommitted tree, and the workspace-root `git status` says
nothing about it.

⚠ **Why it was run is the part worth keeping, because it was a MISREADING.** A patch to the
catalogue reported `2115 insertions, 146 deletions`; that was read as a line-ending artefact
and "undone". It was nothing of the kind — the working tree was **21 tools ahead of HEAD**, so
a diff that size was the honest one. `catalog.json` is stored **LF** in this repository and
`core.autocrlf=true` normalises on the way in, so line endings could not have produced it.
**A large diff on a file carrying uncommitted work is evidence of the uncommitted work, not of
a formatting mistake** — run `git show HEAD:<path>` and compare before believing otherwise.

Every recovery path was checked and none exists on this machine: no dangling blob (never
`git add`ed), no VS Code or Cursor local history, Desktop is not OneDrive-redirected, no restore points, no shadow copies, and the
workspace repo deliberately ignores the service directories.

All 21 were **rebuilt** — every machine-checkable field from `BOT_ROUTES`, `bot.validators.ts`,
`bot-projections.ts` and the controllers; the prose for the ten model-facing rows recovered
from the live `wi-mall-mcp` node descriptions, which had been composed from the lost copy. The
proof it landed faithfully is a number rather than a claim: `test:bot-surface` came back to
**221/0**, the exact figure recorded after Step 5, including the `42 GAP-001 tools` census —
which is also what established that the lost rows carried **no `gap_ref`** (none of them
appears in `BACKEND-GAPS.md`).

⛔ **Never run `git checkout`, `git restore`, `git stash` or `git reset --hard` inside
`jovi-mall/`, `admin/` or `geo-tracker/`.** To undo an edit, re-edit. To read HEAD, use
`git show HEAD:<path>` into a scratch file.

On line endings, since that is what the misreading was about: these repos are
`core.autocrlf=true`, so the working copy of `catalog.json` is **CRLF** while the stored blob
is LF, and git normalises between them. Writing it back with bare `\n` is therefore invisible
to `git diff` and harmless — write `.replace(/\n/g, '\r\n')` anyway, to keep the file
internally consistent with what every editor puts there. It round-trips exactly through
`JSON.stringify(obj, null, 2)` + CRLF + a trailing newline, so structural edits give clean
diffs.

### Three catalogue defects this step surfaced, and fixed

- **Three tools declared a path parameter in `request.path` and in the URL, and nowhere in
  `parameters.properties`** — `bookings_get_balance`, `bookings_payment_status`,
  `notifications_mark_read`. The generator cannot emit an argument that has no schema, so it
  refused; the rows were completed. `tool.schema.json` says `parameters` is "everything the
  model supplies", so those rows had always been wrong.
- **27 emitted parameters had no description.** 23 were given one, sourced from the code or
  the sibling copy. ⚠ One draft description was wrong before it was written down:
  `reviews_check_eligibility.subjectId` takes a **shipment** id for a delivery review, never
  an order id — `BotReviewEligibilitySchema`'s own header says so.
- **`notifications_mark_read` wrote its path in Express notation** (`:notificationId`) where
  `tool.schema.json` documents `{name}`. Normalised.

### Two defects it surfaced and did NOT fix

- **`bookings_list` / `bookings_get` / `bookings_cancel` and the five ticket tools carried
  stale `important_fields`.** The booking three still named the relayed Mongoose shape that
  Step 4 replaced with `toBotBookingDto`; the ticket five named `ticket_number`, a field
  `bot-ticket.controller.ts`'s own header says does not exist on `TicketSchema`. **These
  twelve WERE repaired** from the projections, since the code answers them unambiguously.
- ⛔ **Nothing pins catalogue PROSE against the code.** `test:bot-surface` § 1 asserts method,
  path, `mutating` and `requires_customer_role` — it cannot see that a `response.important_fields`
  list has gone stale under a changed projection, which is exactly how the twelve above
  drifted and stayed drifted through two green suites. Worth a future assertion; not built
  here.

### The original plan for this step

⚠ *Written before Step 0. `wi-mall-mcp` holds **15** hand-written tools today, not 3.*
At ~75 model-registered tools that stops being maintainable by hand.

1. Extend `tools/catalog.json` with every tool above — it is already the generation source and
   `test:bot-surface` § 1 already asserts the route table against it row for row.
2. Write `scripts/gen-mcp-workflow.ts`: reads `catalog.json`, emits n8n Workflow SDK code —
   one `httpRequestTool` node per tool with `core` or `extended` tier, `$fromAI` parameters
   derived from each tool's `parameters` JSON Schema, and the `botToken` argument on every
   identity-scoped row.
3. ⚠ **`flow_only` tools are NOT emitted.** That tier means "called by a deterministic step,
   never registered with the model", and it holds every money movement and every destructive
   action. The generator honouring it is what keeps that boundary real.
4. ⚠ **The SDK forbids loops and every function form**, so the generator emits fully unrolled
   `const` declarations. Only string consts and `+` concatenation survive its parser.

### The per-tool recipe (what "add a tool" means)

⚠ **EIGHT edits now, not six** — the list said six from before the generator existed, and
the two it was missing are the two that make the tool *reachable*. The registry checks fail
the boot on 1–4; nothing fails on 5–8, which is why they are written down.

1. `BOT_ROUTES` row — `tool`, `method`, `path`, `mutating`, `requiresCustomerRole`
2. a handler in the controller + its entry in `bot.routes.ts`' `HANDLERS` (closed both ways)
3. an argument schema in `bot.validators.ts`, `.strict()`
4. a projection in `dto/bot-projections.ts` — explicit fields, never a spread
5. a `catalog.json` entry — the contract copy `test:bot-surface` § 1 asserts
6. `error.customerMessage` copy for any new error code, in all five languages, or the boot fails
7. **`npm run gen:mcp-workflow`, and apply the emitted ops** — a catalogue row nobody
   regenerates from is a tool the model cannot see
8. **bump the count in `test:bot-surface` § 15** (`the generator emits N tools`) — the one
   assertion in that group that does not pass on an empty emission

Plus, for anything the platform says out loud: a `botChrome` string in all five languages
(a `reply`), and a window or a written exemption if it is a list (§ 13).

---

## 6 · Step 9 — close the MCP door ✅ **DONE 2026-09-06**

`headerAuth` on the MCP Server Trigger and on `wi-mall-core`'s MCP Client Tool, both
referencing the SAME dedicated credential — **`wi-mall MCP door`** (header `X-MCP-Token`) —
so the two sides cannot drift. Measured, not assumed: **403** unauthenticated, **403** on a
wrong header, **200** with the credential, and a real `tools/call` through the closed door
returned live backend data (`notifications_unread_count` → `{"unreadCount":38}`).

⚠ **A credential's DOMAIN ALLOWLIST can shut the door on your own client, silently.** The
first attempt reused `Wi-Mall-Header-Auth-Token`, which is restricted to `*.wi-mall.com` and
refuses `the8n.fante.cloud`. Both sides referenced one credential object, so the reasoning
"they cannot disagree" held — and was beside the point: the client could not present the
credential at all, and the agent would have been left with **zero tools** and no error a
customer could see. Any credential used against the n8n host must allow that domain.

⚠ **Neither `setNodeCredential` nor the SDK's `newCredential` can create a credential** — the
first requires an existing id, the second is rejected for plain generic auth types. A
dedicated credential is always an owner action.

**Base URLs moved to n8n env in the same step.** All eight tool nodes now read
`{{ $env.JOVI_MALL_BASE_URL }}`, the name `catalog.json` already specified, so relocating the
backend is one line on the VPS rather than eight node edits.

⚠ **Deliberately NO hardcoded fallback.** A `|| 'http://…'` default would keep working after
a typo in the variable NAME, hiding that the env is not being read at all — the exact
silent-misconfiguration failure `config/env.ts` argues against. Env-only fails loudly.

| n8n env var | value |
|---|---|
| `JOVI_MALL_BASE_URL` | `http://100.124.149.1:8022` |
| `STOREFRONT_BASE_URL` | `http://100.124.149.1:3000` |

⚠ **`STOREFRONT_BASE_URL` was UNSET, and that was a live pre-existing defect** —
`wi-mall-product-search` reads it to build product URLs, so every product it returned had
`url: null`. It must keep matching the backend's own `STOREFRONT_URL`, or the bot hands out
links to two different hosts: the backend builds `meta.moreUrl` from one and product search
builds product links from the other.

## 7 · Step 10 — retire the last native tool nodes ✅ **DONE 2026-09-06**

Fell out of Step 8 the moment `profile_get_summary` and `support_resolve_contacts` reached the
MCP server. `Get-Profile` and `Get-Support-Contacts` are **deleted** from `wi-mall-core`
(30 nodes now). Two tools with one purpose and different argument schemas is a reliable way to
make an agent pick the wrong one — and these two were the worse half of each pair: they built
the **raw** identity envelope from `$('Inbound')` rather than the sealed `botToken`, and they
hardcoded `http://100.124.149.1:8022` where every generated node reads
`{{ $env.JOVI_MALL_BASE_URL }}` (Step 9's decision).

`Search-Products` **stays** — it is the vectoriser's `toolWorkflow` and is deliberately not a
bot-surface route (see `vectoriser` docs).

---

## 8 · Deliberately NOT built, with the reason

| Landing call | Why no tool |
|---|---|
| `PATCH /api/me/password` | § 2. A password typed into a chat is a password in three logs nobody controls. `auth_send_password_reset_link` is the answer. |
| `POST /api/customer/cart/merge` | Merges the browser's local cart into the server's. There is no local cart in a chat. |
| `POST\|DELETE /api/customer/devices` | FCM push tokens for the web/native app. Meaningless for a bot. |
| `POST /api/customer/wishlist/saved-among` | A bulk "is this saved" helper for rendering a grid of hearts. A chat shows one product at a time. |
| `GET /api/customer/profile/completion-status` | Drives a progress bar. `identity_sync_sender` already returns the chat-shaped checklist. |
| `GET /api/customer/tickets/reference/{orders,products}` | Pickers for a `<select>`. The bot resolves a subject through `support_resolve_contacts`, which is better at it. |
| `GET /api/tracking/visible-agents` | Live GPS is a WebSocket with a per-viewer token the bot surface deliberately never holds. Shipment progress comes from `orders_list_shipments`. |
| `POST /api/auth/email-change/confirm` | Step 6's missing sixth verb, and it is missing structurally. The confirm is **unauthenticated on purpose** — the token arrives in a mail client that is routinely not the device the change was started on — so a chat has nothing to present. `contact_get_state` reports the pending change; the customer opens the link. |
| `POST /api/me/connections` (redeem) | Minting the code is the BOT's job (`/connect`) and redeeming it needs a real session, which is the whole proof: the code travels bot → person → an authenticated screen. A bot-surface redeem would close that loop inside one system and prove nothing. |

---

## 9 · Verification

- `npm run test:bot-surface` — the route table against `catalog.json`, row for row, for every
  new tool. This assertion **is** the contract; there is no shared package.
- `npm run verify:bot-surface` — over real HTTP, because Express route ORDER is invisible to a
  DB-free test and this service has been bitten by it twice. Every new `/:param` route needs
  its literal sibling declared first.
- `npm run test:env` — if any step reads a new variable.
- End-to-end over MCP: `initialize` → `tools/list` → `tools/call` with a real sealed token,
  and the tamper case (edit the `externalId` inside a valid token → `401`).

## 10 · Suggested sequencing

Steps 0 → 1 → 2 → 3 are low-risk and unlock most of the chat experience. Step 4 (bookings) is
the largest single win and the one with a real trap. Steps 5–7 touch money, credentials and
destructive actions and want their own review.

⚠ **Step 8 was taken out of order, after Step 5, and that was right** — 31 finished tools were
invisible to the agent while the list grew, and hand-adding is what produced that backlog. It
did pay for itself: **Steps 6 and 7 added ten more tools and cost one command each**, and
Step 10 fell out of it. Do not add a tool by hand again; edit the catalogue and regenerate.

✅ **Every step in this plan is DONE, Step 7b included.** Steps 6 and 7 closed on
2026-09-06; **Step 7b closed on 2026-09-07** and turned out to be two tools rather than one
— the inbound-media path it was blocked on is built, in both repositories' halves.

✅ **The instance is caught up — see § 11.** `wi-mall-mcp` was rendered against the live
node set, applied, diffed and **published** twice on 2026-09-07 — at **49** tools, then at
**50** when Step 7b landed. Step 8's outstanding authenticated `tools/list`/`tools/call` was
run at the same time and passed. Both channel adapters were republished with it.

⚠ **The generator would have failed on contact and § 11 is worth reading before the next
apply** — `HAND_WRITTEN_NODES` had drifted by 31 names, and the batch was 3 operations over
n8n's 100-op cap. Both fixed; `--existing` is now how you render.

---

## 11 · The owner actions on the instance ✅ **DONE 2026-09-07**

Steps 6 and 7 were code-complete on 2026-09-06 and the live server still held Step 8's 46
tools. This closes that, and closes Step 8's own outstanding check with it.

**`wi-mall-mcp` (`3X8oYCQZkCi7Wg4r`) now serves 49 tools, published and live** —
`versionId === activeVersionId === 09afcdec`, 51 nodes (49 tools + trigger + sticky).

### ⛔ The generator would have FAILED on contact, twice, and neither failure was subtle

Applying `wi-mall-mcp.ops.json` as generated on 2026-09-06 would have been rejected outright.
Two defects, found by inspecting the operations against the live workflow before sending them.

**1 · `HAND_WRITTEN_NODES` had drifted, and it is the third instance of this exact pattern.**
`main()` passed that constant — the **fifteen** names the workflow held *before* Step 8 — as the
`existing` argument that decides `addNode` versus `updateNodeParameters`. It was true the day it
was written and false the moment Step 8's own output was applied, because the workflow then held
**46**. So the regenerated ops emitted `addNode` for **31 nodes that already existed**.
`update_workflow` is atomic, so the whole batch would have been refused on the first collision —
loud, at least, rather than half-applied.

This is the same "a guard that names its subjects in a hardcoded list WILL drift" that § 13's
window check hit and that `HAND_WRITTEN_STICKIES` hit in the same file (it names a sticky note
Step 8 already deleted, so a second run emitted a `removeNode` for something that is not there).

**2 · 103 operations against a cap of 100.** `update_workflow` accepts **100 per call**. Step 8's
run was 97 and fitted; adding three tools pushed it over. Splitting across calls is the obvious
answer and it is the wrong one — a split loses the atomicity that makes this safe to run against
a live server at all.

**Both are fixed in `scripts/gen-mcp-workflow.ts`:**

- **`--existing <file>`** — a JSON file of the live workflow, as `get_workflow_details` returns
  it. Names, or nodes with parameters, or the whole payload: all three are accepted, because the
  useful thing is that somebody looked at the server. Tool nodes *and* sticky notes are derived
  from it, so neither hardcoded list is load-bearing any more.
- **Minimal diff.** With parameters supplied, a node whose pushed value is byte-identical to the
  live one emits **no operation**. That is what took 103 → **19** and put it back under the cap;
  it also means re-running the generator with nothing changed emits an empty tool diff, which is
  the property that makes it cheap to run often.
- **Two loud warnings on stdout** — one when `--existing` is absent (the ops are then rendered
  against a historical list and will fail), one when the batch exceeds the cap.

⚠ **`HAND_WRITTEN_NODES` and `HAND_WRITTEN_STICKIES` are kept as a historical record**, so the
first apply stays reproducible from the repository — and so the next person can see what the
drift looked like. They are no longer a default anybody should reach for.

### The 19 operations, and the diff that authorised them

3 `addNode` + 3 `addConnection` (the new reads, wired `ai_tool`), 1 sticky replaced,
1 `setWorkflowMetadata`, 9 `setNodePosition` (the grid shifts when three nodes are inserted),
1 `setNodeParameter` on the trigger's instructions. **No operation touched an existing tool
node's parameters, and none removed one.**

⚠ **The apply answered a warning that reads like a defect and is not**: *"HTTP Request nodes
(contact_get_state, connections_list, account_close_preview) were skipped during credential
auto-assignment."* That means n8n did not need to guess, because the operations carried
`credentials` explicitly. Verified rather than assumed — `get_workflow_versions_diff` from
`activeVersionId` to the new draft shows all three carrying
`httpBearerAuth: jovi-mall-Bearer Auth account`.

That diff is also the check ADR-less prudence demands here: it showed exactly 3 nodes added,
1 sticky swapped, 3 connections added, **`nodesModified: []`** and **`connectionsRemoved: []`** —
so nothing of another session's was about to be shipped by the publish.

### ⛔ The draft trap, confirmed a second time

After the apply: `versionId 09afcdec` ≠ `activeVersionId c096e01b`. The agent would still have
been seeing 46 tools. `publish_workflow` is a separate call and it is not optional — this is the
same trap Step 8 recorded, and it caught nothing only because it was expected.

### ✅ The authenticated check — Step 8's open item, now CLOSED

The one thing Step 8 could not do. Run end to end against the live door:

| | |
|---|---|
| `initialize` | **200**, `mcp-session-id` issued, and the returned `instructions` are the ones just published |
| `tools/list` | **49 advertised** — the three new reads present, **zero `flow_only`**, zero `identity_*`, and neither `page` nor `limit` offered on any tool |
| input schemas | all 40 `bot_internal` tools require `botToken`; none of the 9 `public` ones does |
| `tools/call` → `catalog_list_categories` | **live backend data** — 10 categories with real product counts, so the whole path resolves: client → closed door → tool node → `$env.JOVI_MALL_BASE_URL` → jovi-mall → back |
| `tools/call` → `contact_get_state` with a bogus token | **`401 BOT_IDENTITY_TOKEN_INVALID`**, returned as tool *content* rather than thrown |

⭐ **That last row is the most informative and it is worth reading twice.** Reaching
`BOT_IDENTITY_TOKEN_INVALID` means the request got past `requireServiceToken` *and*
`requireBotWebhookSecret` and all the way to `unsealBotIdentity` — so the bearer credential and
the `X-Webhook-Secret` header on a **newly generated** node are both correct. And it arrived as
content rather than an exception, which is `neverError: true` doing its job: a refusal reaches the
agent as something it can relay instead of a broken turn.

Door still closed, re-measured after the republish: **403** unauthenticated, **403** on a wrong
header value.

### ✅ The live server and the catalogue AGREE again — resolved 2026-09-07

This heading read *"NOT equal right now, and that is correct"*, and it was: while § 11 was
being applied a concurrent session had landed **`tickets_add_attachment`** in `catalog.json`
and in `BOT_ROUTES`, so the catalogue emitted 50 and the live server served 49. It was
deliberately not published then, on the grounds that the nodes point at a **deployed**
backend and a tool whose endpoint is not deployed is a tool that 404s in front of a live
agent.

**That session finished Step 7b and applied it**, by the recipe below: rendered against the
live node set (29 operations), diffed from `activeVersionId`, published. The server serves
**50**.

⚠ **The deployment concern was CHECKED rather than assumed, and the check is the reusable
part.** `JOVI_MALL_BASE_URL` and `wi-mall-core`'s literals both resolve to
`100.124.149.1:8022`, which is the `ts-node-dev --respawn` process running from this working
tree — verified from the process table, including that its child had respawned *after* the
edits. So "deployed" and "this tree" are the same host today. **Do not carry that forward as
a fact**: the moment the backend moves to a real deployment they diverge and the ordering
rule returns — deploy the backend first, then publish the tool.
### The recipe, now that it is one command and two calls

```bash
# 1 · snapshot the server  (get_workflow_details, detailLevel: "full" → save the JSON)
# 2 · render against reality
npm run gen:mcp-workflow -- --existing <that-file.json>
# 3 · apply           update_workflow(workflowId, operations)      ← atomic, ≤100 ops
# 4 · DIFF            get_workflow_versions_diff(activeVersionId → versionId)
# 5 · PUBLISH         publish_workflow(workflowId, versionId)      ← or the agent sees the old set
# 6 · confirm         versionId === activeVersionId
```

⚠ **Step 4 is not ceremony.** Two sessions have now edited these workflows on the same day.

### The door token is recorded now, and that is a change of posture

`MCP_DOOR_TOKEN` / `MCP_DOOR_URL` are in jovi-mall's **`.env`** (gitignored), so the
authenticated check above is repeatable rather than an owner action forever. They are
**deliberately absent from `.env.example`**: that file documents what `src/` READS and
`test:env` asserts it in both directions, so a variable no code reads would fail that census.

⚠ **The value was pasted into an assistant transcript to run this check.** Rotating it is the
conservative move — it is one credential object in n8n (`wi-mall MCP door`), referenced by both
the MCP Server Trigger and `wi-mall-core`'s MCP Client Tool, so a rotation is one edit and the
two sides cannot drift.

⛔ **BOTH VALUES ARE NOW STALE, measured 2026-09-16.** `MCP_DOOR_URL` still names
`https://the8n.fante.cloud/mcp/wi-mall-customer`, which answers **404 page not found** — the
instance moved to `the8n.wi-mall.com` (editor at `the8n-editor.wi-mall.com`). The same path on
the new host answers **403 Forbidden** to the recorded token, which is what this door returns
both when unauthenticated and on a wrong value — consistent with the rotation above having
happened. So the sentence "repeatable rather than an owner action forever" is **not true today**:
the authenticated check cannot be run from this repository until both values are refreshed.

⚠ **Do not close the gap by trying candidate tokens or paths.** That is credential fishing
against a live door, and a 403 tells you nothing about which of the two is wrong.

---

## 12 · The in-app screen tools ✅ **PUBLISHED 2026-09-16**

The bot rich-UI work (Stream 0) added three MCP-exposed reads, so the live server fell behind
the catalogue. Applied by the § 11 recipe, unchanged.

**`wi-mall-mcp` (`3X8oYCQZkCi7Wg4r`) now serves 54 tools, published and live** —
`versionId === activeVersionId === 669bceb9`, 56 nodes (54 tools + trigger + sticky).

| | |
|---|---|
| snapshot | 53 nodes — **51** tools, `versionId === activeVersionId === 03ee1eb9` |
| rendered | **33 operations** with `--existing`, under the 100 cap |
| applied | all 33, atomically |
| diff | 4 nodes added, 1 removed, **`nodesModified: []`**, 3 connections added, **`connectionsRemoved: []`** |
| published | `669bceb9`, confirmed equal to `activeVersionId` |

### ⭐ The live set had moved from 50 to 51 without us, and `--existing` is why that was a non-event

§ 11 recorded the server at **50** tools. The snapshot showed **51** — a concurrent session had
added one. Under the old hardcoded `HAND_WRITTEN_NODES` that would have emitted `addNode` for a
node that already existed and `update_workflow`, being atomic, would have refused the whole
batch. Rendered against the server it cost nothing: the extra tool produced no operation at all.

⚠ **Read the count in § 11 as a measurement, not a fact.** Re-snapshot every time.

### The three operations that were NOT in the batch, and why that is the check

`nodesModified: []` is the property that made this safe to publish while other sessions are
working: **no existing tool node's parameters were touched and none was removed.** The 23
`setNodePosition` operations and the `setNodeParameter` on the trigger's `/instructions` both
appear in the batch and in neither half of the diff — the instructions text was byte-identical
to the live value, which is the minimal-diff behaviour doing its job.

⚠ **The apply's warning is the same false alarm § 11 records** — *"HTTP Request nodes
(inapp_open_listing, inapp_open_stores, inapp_open_product) were skipped during credential
auto-assignment."* It means n8n did not have to guess, because the operations carried
`credentials` explicitly. Verified in the diff: all three carry
`httpBearerAuth: jovi-mall-Bearer Auth account` (`lz5ivIop9DF8mPHa`).

### ⛔ The three tools 404 until the backend is deployed, and this was published anyway

**`/api/internal/bot/inapp/{listing,stores,products/:id}` are not committed**, let alone
deployed — `git show HEAD:…/bot-route-table.ts` holds zero occurrences of `inapp_open_listing`
while the working tree holds one. Probing production cannot show this: **every** path under
`/api/internal/bot/*` answers `401` unauthenticated because `requireServiceToken` is a
`router.use` that fires before route matching, so an absent route and a present one are
indistinguishable from outside. The git check is the one that answers it.

The ordering rule this breaks is § 11's own — *deploy the backend first, then publish the tool*.
**The owner was told and chose to publish anyway.** The blast radius is bounded by
`neverError: true`: a 404 reaches the agent as relayable content rather than a thrown turn, so a
customer gets a degraded answer rather than silence. It is still a wasted turn on a live bot
until the deploy lands.

### ⚠ The authenticated check could NOT be run

For the reason recorded at the end of § 11: the door URL in `.env` is the old host and the token
is refused by the new one. So `tools/list` was **not** confirmed against the live door — the
54-tool figure above is from the server's own node set and the version diff, which is strong
evidence and not the same evidence. **Whoever refreshes those two values should re-run the § 11
check**, which is the only thing that proves the closed door still answers and that the three
new tools are actually advertised.
