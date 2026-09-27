# Bookings phase 6 — finishing the appointment journey in the chat bot

**Goal.** A customer who wants an appointment can get one, pay for it, and be told what
happened — in the conversation they are already in, in their own language, on both chat
platforms.

**Status, measured 2026-09-27.** Almost all of it is *built*. Three screens, their routes,
their transport-neutral core and their five-language copy all exist and compile. What does
not exist is the **plumbing between them and a customer**: nothing on the platform can open
the picker or the payment screen, the one screen that is reachable is reachable only from
the other two, all three pages fetch a URL that returns 404, and the two messages that carry
a booking payment's outcome go to a channel the customer was not looking at.

⚠ **Every claim in this document was read out of the source on 2026-09-27 and carries its
file:line.** Where a document, a code comment or a memory note said something the code
contradicted, the code won and the contradiction is named. Four such contradictions are
recorded below; one of them is a comment in `bot-action-id.ts` claiming a behaviour the
purchase controller does not have.

---

## 1 · The one-paragraph finding

`bk` (pick a time) and `bp` (pay for it) are **unreachable code**. There is no call site
anywhere in `src/` that mints a session of either kind: `openInAppScreen` has seven callers
(`bot-booking.controller.ts:480`, `bot-discovery.controller.ts:293,303,407`,
`bot-inapp.controller.ts:293`, `bot-order.controller.ts:1027`, `bot-ticket.controller.ts:740`)
and not one passes `kind: 'bk'` or `kind: 'bp'`. `bl` (your appointments) is reachable only
from the `open:bl` button, which is drawn in exactly two places —
`miniapp/surfaces/booking.controller.ts:168` (the receipt pushed *after* a `bk` confirm) and
`whatsapp/flows/commands/flow-complete.command.ts:200` (a bookings Flow completion) — both of
which are downstream of `bk`. **The three-screen journey is a closed loop with no entrance.**

That is why nothing in it has ever run on a handset, and why the stream memory's "nothing of
this stream is outstanding in code" is true of the stream's own files and false of the
feature.

---

## 2 · What is true today, step by step

Legend: ✅ built and reachable · 🟡 built, reachable, wrong · ⛔ built, **unreachable** ·
❌ not built.

| # | Journey step | State | Evidence | What the customer gets today |
|---|---|---|---|---|
| 1 | A customer asks about a service and sees a product card with a **Book** button | ✅ | `bot-action-id.ts:269` builds `book:<productId>`; routed at `bot-purchase.controller.ts:311` | A card with a Book button |
| 2 | Tapping **Book** opens the day/time picker | ❌ | `executePurchase`'s `book` branch returns `outcome: 'chat'`, `url: null` (`bot-purchase.controller.ts:465-471`) | The sentence *"When would you like this? Tell me a day and a time."* (`bot-chrome-copy.ts:483-489`). The customer types free text and the model has to turn it into `bookings_get_availability` + `bookings_create`. ⚠ `bot-action-id.ts:261-263` says *"`book` reaches the slot picker"* — **it does not** |
| 3 | The picker lists only the days that have times, then that day's times | ⛔ | `readBookingPicker` (`booking.core.ts:278-321`), `public/bk.html` (257 lines, complete) | Nothing — no handle of kind `bk` can be minted |
| 4 | Confirming takes the slot, spending the handle once | ⛔ | `confirmBooking` (`booking.core.ts:355-401`), `consume` at `:359`, route at `miniapp.routes.ts:202` | Nothing |
| 5 | A slot lost to somebody else between picking and confirming is explained | ❌ | `confirmBooking` throws `BOOKING_SLOT_LOCKED` 409 *after* consuming the handle (`booking.core.ts:359` then `:369`); `bk.html:220-221` maps anything that is not 410/404 to `copy.failed`, and the Confirm button never unlatches (`bk.html:207-214`) | *"Something went wrong. Close this and ask me again in the chat."* — for a slot somebody simply took first. The decision that a re-minted `bk` handle should keep its original expiry is **unimplemented: there is no re-mint path at all** |
| 6 | The chat confirms the appointment, naming the reference and the time | ⛔ | `pushReceipt` (`booking.controller.ts:139-174`), `bookingChatReceipt` ×5 languages | Nothing (step 4 cannot happen) |
| 7 | A **My bookings** button under that receipt opens the list | ⛔ | `booking.controller.ts:166-169` draws `open:bl`; routed at `bot-booking.controller.ts:503` | Nothing |
| 8 | **My appointments** lists this customer's own appointments | ⛔ 🟡 | `readCustomerBookings` (`booking.core.ts:608-650`), `public/bl.html` | Unreachable; and when reached it would be wrong — see § 3 |
| 9 | Typing `/bookings` opens that list | ❌ | `command-registry.ts:338-345` — `handler: null`, so `LIVE_COMMANDS` (`:352`) excludes it and `/help` never lists it | The command falls through to the model |
| 10 | An unpaid appointment offers a way to pay it | ❌ | Nothing mints `kind: 'bp'`; `readCustomerBookings` returns no status and no payable flag (`booking.core.ts:612`) | Nothing. The whole `bp` screen, its two routes (`miniapp.routes.ts:219-220`) and its five-language copy are unreachable |
| 11 | The payment screen shows what is owed, re-resolved now, holding no figure | ⛔ | Session holds no amount (`inapp-surface.store.ts:234`); `amountDueFor` at read (`booking.core.ts:463`) and the booking re-read at pay (`:508`) | Nothing |
| 12 | The payment screen refuses a booking that cannot be charged | ❌ | `payableBooking` checks ownership + `deletedAt` only (`booking.core.ts:542-553`); `amountDueFor(booking, 'primary')` returns `priceSnapshot` unguarded (`:569-570`) | It would draw *"Pay XAF 15,000"* for a booking already paid or cancelled, then refuse at Pay — by which time the handle is **spent** (`:502`) and `markSpent` (`:590-600`) keeps the page latched (`bp.html:136-139`). A dead screen at the moment of paying |
| 13 | Pressing Pay opens the charge and says only that the request is on its way | ⛔ | `payBooking` (`booking.core.ts:493-534`), `paySent` copy, `booking.controller.ts:115-118` | Nothing |
| 14 | The outcome arrives **in the chat the customer paid in** | 🟡 | `initiateBookingPayment` (`payment-orchestrator.service.ts:814-818`) and `initiateBookingBalancePayment` (`:1013-1017`) take **no `originChat`**, so `determineDeliveryChannels` falls back to telegram > email > whatsapp (`customer-notification-event-handler.service.ts:1349-1385`) | The receipt can land on Telegram, or by email, for a customer who paid on WhatsApp — the exact defect measured for orders on 2026-09-22 and fixed there (`:1335-1339`), unfixed here. The screen promised *"I'll tell you in the chat"* |
| 15 | A failed booking payment offers **Try again** | 🟡 | `booking.payment_failed` draws `pay:rt:<transactionId>` (`customer-notification-catalog.ts:292,835`) with the booking transaction's id (`customer-notification-event-handler.service.ts:562-597`); `paymentTap` → `retryCharge` → `resolveCheckoutPayment` filters `cartId: { $ne: null }` (`bot-checkout.controller.ts:806-808`); a booking transaction has `bookingId` and no `cartId` (`payment-transaction.model.ts:53-57,344-355`) | *"I could not find that payment on your account. Ask me about your latest order and I will look it up."* (`bot-error-copy.ts:727-733`) — about an **appointment** |
| 16 | A balance the shop settled above the quote can be paid | 🟡 | `booking.balance.due` has **no `actions:`** (`customer-notification-catalog.ts:840-871`); its only affordance is a URL button to `shop/account/bookings/{{bookingId}}/balance` (`:91-95`) | A link to a storefront page a chat customer has no web session for |
| 17 | An appointment can be cancelled | ✅ | `bookings_cancel` (`bot-route-table.ts:381`), `BotBookingController.cancel`. Deliberately **not** on the screen (`bl.html:28-31`) | Works, in chat, as designed |
| 18 | An unpaid appointment is swept after 24 hours | ✅ | `booking.config.ts:29-37` (`afterMinutes` 1440), worker filters CONFIRMED + `requiresPayment` + unpaid/failed (`unpaid-booking-cancel.worker.ts:109-112`) | Works, untouched |

### 2.1 · The three booking pages all fetch a URL that does not exist

`bl.html:152`, `bk.html:246` and `bp.html:213` fetch **`/api/bot/miniapp/copy?lang=…`**. The
six non-booking screens fetch `base + "/copy?lang=…"` — which resolves to
`/api/bot/miniapp/s/<kind>/<handle>/copy`, the route at `miniapp.routes.ts:133`. There is no
one-segment `/copy` route on that router (the complete list is `miniapp.routes.ts:50,53,56,
121,124,133,149,158,161,173,174,187,200,201,202,219,220,229,230,243,244,247,257,258`), so all
three booking pages get a 404 and fall back to their inline English `FALLBACK` object.

Consequences differ per screen, and the third one is the bad one:

- **`bk`** — `readBookingPicker` returns `copy` with the data (`booking.core.ts:283,295`), so
  the booking words localise. Only `loading` / `failed` / `expired` stay English.
- **`bp`** — `readBookingPayment` returns `copy` (`booking.core.ts:445,466`), same as above.
- **`bl`** — `readCustomerBookings` returns **no `copy` at all** (`booking.core.ts:612`) while
  `bl.html:131` expects `data.copy`. So **every word of the bookings list is English in all
  five languages** — the title, the empty state, and all three failure states. The words exist
  (`bot-booking-copy.ts:117-143` declares `listTitle` and `listEmpty`; `:145+` has all five
  languages); nothing carries them to the page.

There is a fourth, smaller one: `bk.html:227` reads `copy.sent`, and **`sent` is not a member
of `BookingScreenCopy`** (`bot-booking-copy.ts:117-143`). So the page's "done" line is
`FALLBACK.sent` — *"Done — I have told you in the chat."* — in English, always, even once the
copy URL is fixed.

### 2.2 · Verified as already fixed

Asked for explicitly, and confirmed in source rather than taken on report:

| Claim | Verdict | Evidence |
|---|---|---|
| Caller-supplied slot intervals are matched against real availability | ✅ fixed | `assertOfferedSlot` is called by `bookProduct` (`ProductBookingService.ts:258`) **and** by `lockSlot` (`:315`); defined `:345` |
| The vendor reschedule defect (hold asserted under one id, written under another) | ✅ fixed | `booking.service.ts:484-486` resolves `scopeToOwner` from `groupBookingService.resolveCapacity` and asserts under `lockOwnerId`; `assertShopRuleSlot` (`:652`) is shared with `holdSlotForReschedule` (`:704`) |
| The populated-`productId` variant of the same defect | ✅ fixed | `referencedIdOf` (`bot-booking.controller.ts:519-524`), pinned by `test:booking-slot-offer` |
| `bp` holds no amount; it is re-resolved at read and again at pay | ✅ holds | `inapp-surface.store.ts:234`; `booking.core.ts:463` and `:508` |
| A slot id is checked against the **session's** product, never the body's | ✅ holds | `confirmBooking` reads `productId` off the session (`booking.core.ts:366-367`) |
| A reschedule re-verifies availability at confirm | ✅ holds | `rescheduleBooking` → `assertRescheduleTarget` (`booking.service.ts:471`) |
| `bk` lives 15 minutes and `touch` may not extend it | ✅ holds | `inapp-surface.store.ts:108` and the `Exclude<…, 'co' \| 'bk' \| 'bp'>` signature at `:342` |
| Pay-at-the-shop is not offered; the 24-hour sweep is untouched | ✅ holds | No branch anywhere; `booking.config.ts:29-37` |
| Cancelling stays in the chat | ✅ holds | No cancel control on `bl`; `bl.html:28-31` states the reason |
| A re-minted `bk` after a lost slot race keeps the **original** expiry | ❌ **unimplemented** | There is no re-mint path; `mint` always stamps a fresh expiry (`inapp-surface.store.ts:261`). See row 5 of the table above |
| The standard booking notification is skipped for a booking made in chat | ❌ **unimplemented** | `handleBookingCreated` (`customer-notification-event-handler.service.ts:204-227`) has no chat-origin branch, and no suppression mechanism exists — `originChat` appears only on payment transactions. A Telegram customer booking from `bk` would get the pushed receipt *and* `booking.created`, which under `bookingUpdates` prefers Telegram (`:1367`). Two messages about one appointment |

### 2.3 · Documents that contradict the code

1. `bot-action-id.ts:261-263` — *"`book` reaches the slot picker"*. It reaches a chat sentence
   (`bot-purchase.controller.ts:465-471`).
2. `bot-action-id.ts:328-333` — *"`bk` and `bp` … are deliberately unreachable from a button
   at all"*. Presented as a safety decision; it is also the reason the feature does not work,
   and the stated hazard ("a picker handle holds a slot") does not apply to a button carrying a
   **product id** rather than a handle. That is exactly the `open:co` reasoning at `:317-326`.
3. `api-doc/n8n/bot-surface.md:2306` documents `pay:rt` as belonging to *"the
   `order.payment_failed` notification"*. The catalogue also attaches it to
   `booking.payment_failed` (`customer-notification-catalog.ts:835`), where the handler
   refuses it.
4. `CLAUDE.md` § Testing says 131 suites. Re-measured 2026-09-27 with the command that file
   supplies: **jovi-mall 92 `test:*` + 21 `verify:*`, wi-admin 27 + 15 = 155.** Do not trust
   the number; re-measure.

---

## 3 · The work, in ordered steps

Steps 1–4 open **no new door** and are invisible to a customer; they may ship in any order
among themselves. Steps 5–7 each open a door and each must land atomically. Step 9 is the
guard, and it lands **last and green** — see § 6 on why a suite with a known red is a suite
whose next finding is unverifiable.

### Step 1 · The copy plumbing

**Owns exclusively:** `src/modules/bot-surface/miniapp/public/bl.html`,
`public/bk.html`, `public/bp.html`,
`src/modules/bot-surface/miniapp/surfaces/booking.core.ts`,
`src/modules/bot-surface/domain/bot-booking-copy.ts`.

1. Change the copy fetch in all three pages from `"/api/bot/miniapp/copy?lang="` to
   `base + "/copy?lang="`, matching the six screens that work.
2. `readCustomerBookings` returns `copy: bookingScreenCopy(input.language)` beside `bookings`,
   the way `readBookingPicker` and `readBookingPayment` already do.
3. `BookingScreenCopy` gains three members, in all five languages (§ 5): `sent`, `slotTaken`,
   `payNothingDue`.
4. `bk.html` maps a **409** to `copy.slotTaken` rather than to `copy.failed`, and re-enables
   **Back** on that one refusal so the customer can pick another time. It does **not** re-enable
   Confirm — the handle is spent, and going back re-reads the day from a live session-less
   read. ⚠ Going back needs a live `bk` handle, and the handle is gone; so the honest behaviour
   is the sentence plus *"ask me again in the chat"*, and the re-mint is Step 6's follow-up
   question for the owner (§ 7, Q-3).

**Tests.** Extend `test:inapp-bookings`: a source scan asserting (a) no file under
`miniapp/public/` fetches a one-segment `/copy`, (b) every `copy.<key>` any booking page reads
is a member of `BookingScreenCopy` or of `inAppCopy`'s table, (c) `readCustomerBookings`
returns a `copy` key. **Mutation proof:** delete the `copy` key from the return type — (c)
must bite.

**Verified by.** `curl` the three screens' `/copy?lang=fr` and `?lang=ar` and read French and
Arabic back; open `bl` with `?lang=fr` and see *"Vos rendez-vous"*.

### Step 2 · The bookings list becomes useful

**Owns exclusively:** `booking.core.ts`, `bot-booking-copy.ts`, `public/bl.html`.

1. Each row gains `status` (the booking's own status, as data) and `statusLabel` (a short
   translated word for the row **description**, § 5). A cancelled appointment must not read as
   a live one.
2. Each row gains `payable: 'primary' | 'balance' | null` — computed from
   `requiresPayment`/`paymentStatus` and from `settlement.balanceDue − settlement.balancePaid`.
   This is what lets Step 5 offer a Pay control, and it carries **no amount**: the figure is
   `bp`'s to resolve.
3. Sort **upcoming first**, then past. Today `sort({ startAt: -1 })` (`booking.core.ts:620`)
   puts the appointment *furthest in the future* at the top and buries the next one.
4. Resolve `shopTimezone` **once per distinct vendor**, not once per row (`booking.core.ts:627`
   is inside the loop — up to 20 vendor reads per open).

**Tests.** `test:inapp-bookings`: the first row of a fixture holding two future and one past
booking is the **nearest** future one; a cancelled booking carries its label; the vendor
timezone read count equals the number of distinct vendors. ⚠ The row-title assertion must run
in **French and Arabic** (§ 6).

**Verified by.** A seeded customer with one cancelled, one unpaid and one past appointment,
read on `bl` in `fr`.

### Step 3 · Refuse an unchargeable booking at the READ, not at the pay

**Owns exclusively:** `booking.core.ts`.

`readBookingPayment` refuses, with `BOOKING_BALANCE_ALREADY_SETTLED`'s sibling reasoning and
the `payNothingDue` sentence, when: the booking is cancelled; or `purpose === 'primary'` and
`paymentStatus === 'paid'`; or `requiresPayment` is false. The balance branch already refuses
a settled balance (`booking.core.ts:574-578`) — this gives the primary branch the guard it
lacks.

**Why at the read.** The refusal at Pay costs the handle (`:502`) and leaves the page latched
(`bp.html:136-139`), so the customer meets a dead screen. Refusing at the read costs nothing
and is a sentence they can act on.

**Tests.** `test:inapp-bookings`, four cases (cancelled · paid primary · no payment required ·
settled balance). **Mutation proof:** delete the primary-paid guard — the assertion must bite.
⚠ Anchor the assertion on the **line**, not on "contains `amountDueFor`": a mutant already
proved that `session.amount ?? amountDueFor(...)` satisfies a contains-check.

### Step 4 · The payment outcome reaches the chat it was paid in

**Owns exclusively:** `src/modules/payments/services/payment-orchestrator.service.ts` (the two
booking methods only), `booking.core.ts`,
`src/modules/bot-surface/controllers/bot-booking.controller.ts`.

1. `initiateBookingPayment` and `initiateBookingBalancePayment` gain a fourth parameter
   `options: { originChat?: 'whatsapp' | 'telegram' | null } = {}`, recorded on the transaction
   **exactly** as `initiatePayment` does at `payment-orchestrator.service.ts:452` — on a new
   attempt only, never overwriting a live one.
2. `payBooking` passes `session.channel` (`booking.core.ts:522-524`).
3. `BotBookingController.pay` and `.payBalance` pass `req.bot!.envelope.channel`
   (`bot-booking.controller.ts:397,424`), as `bot-checkout.controller.ts:607` does.

**Do not touch** the storefront route `booking-payment.routes.ts:40` — it has no chat, and
omitting the option there is the honest state.

**Tests.** `test:booking-notification`: both booking paths write `originChat` when given one
and omit it when not. `test:inapp-bookings`: `payBooking` passes the session's channel and
never a caller-supplied one. **Mutation proof:** drop the argument at either call site.

**Verified by.** A live booking payment from a WhatsApp chat whose account also has Telegram
linked: the receipt must arrive on **WhatsApp**.

### Step 5 · `bp` gets its door, and "Try again" stops lying

**Owns exclusively:** `src/modules/bot-surface/domain/bot-action-id.ts` (one builder),
`bot-booking.controller.ts` (handler + map row),
`src/modules/notifications/catalog/customer-notification-catalog.ts` (two `actions:` entries),
`api-doc/n8n/bot-surface.md` § 14.9 (two rows).

1. A new builder `bookingPayActionId(bookingId, purpose)` → `bpay:<bookingId>` for the price
   and `bpay:<bookingId>:b` for a balance. Byte budget: `bpay:` + 24 hex + `:b` = **31 bytes**
   against Telegram's 64. It carries a **booking id, never a handle** — the `bp` session is
   minted on the tap, by the server, for whoever tapped, which is the `open:co` property at
   `bot-action-id.ts:317-326`.
2. A handler in `BOOKING_ACTION_HANDLERS` that resolves the booking against the caller,
   refuses it under Step 3's rules, then `openInAppScreen({ payload: { kind: 'bp', bookingId,
   purpose }, fallbackPath: … , labelKey: 'payAppointmentButton' })`.
   ⚠ `fallbackPath` **must not be null** — `BOT_MINIAPP_BASE_URL` is unset in production
   (`inapp-url.ts:47-52`; `.env.example:1037` is commented out), so the fallback is the path
   that actually runs, and a null one renders a sentence with nothing to press
   (`bot-booking.controller.ts:460-467`).
3. `booking.payment_failed` swaps `TRY_PAYMENT_AGAIN` for this token, and
   `booking.balance.due` **gains** an `actions:` entry with it (it has none today,
   `customer-notification-catalog.ts:840-871`) while keeping its URL button for email.

**⛔ What must land together, and in what order.** The handler and the § 14.9 rows go
**first**, the catalogue `actions:` entries **last**. `test:bot-surface`'s § 20 fails
`DRAWN BUT NOT ROUTED` naming the builder (`test-bot-surface.ts:663`) and
`ROUTED BUT UNDOCUMENTED` for a missing § 14.9 row (`:667`). A drawn-but-unrouted token is
**silent on both platforms** — Telegram reports nothing for an unhandled callback.

**Tests.** `test:bot-surface` § 20 (free, once the rows exist). `test:inapp-bookings`: the
token's byte length; the handler refuses another customer's booking with a 404, not a 403; the
handler passes a non-null `fallbackPath`. New in `test:inapp-bookings`: **no `booking.*`
catalogue situation may draw a token whose handler cannot serve a booking** — assert the
booking situations' tokens against a named allowlist, and say in the comment that
`pay:rt`'s handler filters `cartId: { $ne: null }` (`bot-checkout.controller.ts:806-808`).

### Step 6 · `bk` gets its door: Book opens the picker

**Owns exclusively:** `bot-action-id.ts` (the `BotInAppSurface` comment and nothing else),
`src/modules/bot-surface/controllers/bot-purchase.controller.ts` (the `book` tap path only),
`bot-booking.controller.ts` (one map row), `bot-chrome-copy.ts` (one key),
`api-doc/n8n/bot-surface.md` § 14.9 (one row).

1. Route **`open:bk:<productId>`** in `BOOKING_ACTION_HANDLERS`: mint
   `{ kind: 'bk', productId, bookingId: null }` through `openInAppScreen`, with
   `fallbackPath` = the product's own storefront path (`/shop/p/<productId>`, the redirect-stub
   form `bot-booking.controller.ts:164-168` already documents for an id-without-slug).
2. The `book` tap keeps its invite sentence and **gains a button** carrying that token, with
   the new `bookChooseTimeButton` label (§ 5, cap 20).
   ⚠ Keep the sentence. `executePurchase` is transport-neutral and its `book` branch is also
   read by the WhatsApp Flow completion path (`flow-complete.command.ts:206+`); the sentence is
   what invites the reply that a customer with no screen can still give.
3. Amend the comment at `bot-action-id.ts:328-333` to say what is now true: `bl` and `bk` are
   nameable by a button because neither carries a handle, and `bp` is nameable under its own
   verb for the same reason.

**⛔ Handler first, button second, one change.** Same rule as Step 5, same suite, same reason.

**Tests.** § 20. `test:inapp-bookings`: `open:bk:` + 24 hex is 32 bytes; the handler refuses a
non-bookable product with the same 404 the availability read gives
(`booking.core.ts:144-148`); `fallbackPath` is non-null.

**Verified by.** A real Telegram handset: tap **Book** on a service, pick a day, pick a time,
confirm, read the receipt, tap **My bookings**.

### Step 7 · `/bookings` becomes a live command

**Owns exclusively:** `src/modules/bot-commands/domain/command-registry.ts` (one row's
`handler`), plus the handler's own new file under `bot-commands/`.

Give `bookings` a handler: bare, it opens `bl`; with a `ref`, it answers that one appointment
in chat through `BotBookingController.get`'s projection. This is the customer's front door and
today it is `handler: null` (`command-registry.ts:338-345`), so `/help` does not list it.

**Tests.** The command suite: `/bookings` and all six aliases resolve; `/help` now lists it;
`assertCommandRegistryValid` still passes.

### Step 8 · (Owner decision — see Q-4) One message, not two, for a chat booking

Implements the decision recorded in the bookings stream memory and absent from the code.
Narrowest shape: `confirmBooking` stamps the origin chat on the booking's `metadata`, and
`handleBookingCreated` skips the **secondary channel only** (never the in-app row) when that
chat is still connected — mirroring `determineDeliveryChannels`' `originChat` branch
(`customer-notification-event-handler.service.ts:1364-1367`).

⚠ `bot-booking.controller.ts:226-233` states that `notes` is *"the ONLY metadata this surface
will write"*. A second key needs that comment amended in the same change, or the next reader
will believe a rule the code has stopped keeping.

### Step 9 · The guard that would have caught all of this

**Owns exclusively:** `scripts/test/test-bot-surface.ts` (one new section).

**Every `InAppSurfaceKind` must have at least one mint site.** Scan `src/` for a `kind: '<k>'`
literal inside an `openInAppScreen(` or `inAppSurfaceStore.mint(` call and fail
`KIND WITH NO DOOR: '<k>' is served, routed and documented, and nothing mints it`. `bl`, `bk`
and `bp` all fail this today; `sl` passes only through a tool
(`bot-action-id.ts:281-284`), so the scan must count tool doors too.

⛔ **Lands last, green.** Landing it early would put a known red in a shared suite, and the
bookings stream already measured what that costs: a mutant aimed at an already-red assertion
reports a bite and proves nothing, so the next finding on that suite is unverifiable.

---

## 4 · The money rules, as invariants

A screen handle that can place an order or move money **is a credential**. These are the
properties the code must keep; each is true today unless marked.

| # | Invariant | Where it lives | State |
|---|---|---|---|
| M-1 | **The `bp` session holds no amount.** It carries a booking id and a purpose and nothing else | `inapp-surface.store.ts:234` | ✅ keep |
| M-2 | **The amount is re-resolved at the read and again at the pay.** A balance moves when a vendor settles the appointment, so a screen opened five minutes ago must not charge a five-minute-old figure | `booking.core.ts:463` (read) and `:508` (pay, via the orchestrator's own re-read) | ✅ keep. ⚠ Pin line-anchored: `session.amount ?? amountDueFor(...)` satisfies a contains-check |
| M-3 | **`bp` lives ten minutes and `touch` may not extend it.** Checkout's number for checkout's reason | `inapp-surface.store.ts:110,342` | ✅ keep |
| M-4 | **`bp` is single-use: `pay` consumes it.** A double tap, a refresh and a forwarded URL all find it gone | `booking.core.ts:502` | ✅ keep |
| M-5 | **Everything after the consume is spent, whatever went wrong.** A page told otherwise offers a Pay button backed by a handle that no longer exists | `markSpent`, `booking.core.ts:590-600` | ✅ keep |
| M-6 | **Absent means spent.** The page unlatches only on a 400/422 carrying `details.spent === false` — the error boundary strips `details` from internal and gateway failures, and a lost response has no body | `bp.html:136-139` | ✅ keep |
| M-7 | **The network check for a *typed* number happens BEFORE the consume; for the *account's* number, after.** A number no network resolves must not cost the handle | `booking.core.ts:497-500` and `:519` | ✅ keep |
| M-8 | **The page never receives the payer's number in full.** Only `maskedPayerNumber`, so a customer can recognise their own wallet | `booking.core.ts:473`; `storedPayerNumber` is server-side only | ✅ keep |
| M-9 | **The gateway is the server's choice, never the page's** | `mobileMoneyGateway()`, `booking.core.ts:498` | ✅ keep |
| M-10 | **No surface may claim an outcome** — not "paid", not "failed". The orchestrator publishes a verdict only where the gateway gave one (webhook, verify sweep), never from the catch around the charge where a timeout cannot be told from a refusal | `booking.controller.ts:102-113`, `bp.html:27-32`, `miniapp.routes.ts:215-218` | ✅ keep. ⚠ The property is "no **verdict**", not "no failure message": *"payment received"* on the screen's own authority is the same fault in the cheerful direction and the easier one to add later |
| M-11 | **A booking that cannot be charged is refused at the READ** | Step 3 | ❌ **add** |
| M-12 | **The outcome goes to the chat the payment was made in** | Step 4 | ❌ **add** |
| M-13 | **A handle never travels in a chat button.** `bpay:` and `open:bk:` carry a booking id and a product id; the session is minted on the tap for whoever tapped | Steps 5–6 | ❌ **add**, and it is why those tokens are safe |
| M-14 | **`bp` carries no address and no price the page can edit.** There is nothing to edit: the page posts only an optional phone number | `bp.html:174-178` | ✅ keep |
| M-15 | **Money maths never happens in a web page.** `amountText` arrives formatted from the server | `booking.core.ts:472` | ✅ keep |
| M-16 | **A slot lost between picking and confirming is explained as a lost slot, and reports nothing about payment** | Step 1 item 4 | ❌ **add** |

### What the customer is told, per money outcome

| Outcome | Who says it | What they read |
|---|---|---|
| Pay pressed, charge opened | the `bp` screen | `paySent` — *"I've sent the request to your phone. Approve it there and I'll tell you in the chat."* Then the screen closes |
| Charge succeeded | `booking.payment.received` (ungated by preference — `customer-notification-event-handler.service.ts:63-71` lists it as deliberately always-sent) | the receipt, **in the chat they paid in** once Step 4 lands |
| Balance charge succeeded | `booking.balance.received` — its own situation, because the primary copy ends *"see you then"* (`:509-521`) | as above. ⚠ Its WhatsApp template is unsubmitted, so outside the 24-hour window it cannot reach a WhatsApp customer — owner's, not ours |
| Charge failed | `booking.payment_failed`, both purposes announced (`:548-553`) | the failure, plus a **Pay** button that re-opens `bp` (Step 5) instead of today's order-shaped refusal |
| Nothing owed | the `bp` read | `payNothingDue`, before any button is drawn (Step 3) |
| Slot lost at confirm | the `bk` screen | `slotTaken` (Step 1) |
| Timeout / no verdict | **nobody**, deliberately | the screen said the request is on its way; the verdict arrives when the gateway gives one |

---

## 5 · What the customer reads — five languages

**WhatsApp caps, pinned as literals in `bot-booking-copy.ts:34-44`** (24 / 72 / 20 / 30 — the
platform's numbers, not ours): reply-button title **20**; at most **three** buttons, otherwise
a list; list row title **24**, description **72**; Flow option title **30**.

⚠ **A title built from DATA must distinguish two rows, and the case to check is French or
Arabic — never English.** `fitBookingRowTitle` (`bot-booking-copy.ts:52-59`) shortens the
service and keeps the time whole, because two appointments for one service differ by nothing
else. Every new data-derived row needs a short label and a test in `fr` and `ar`.

### New members of `BookingScreenCopy` (page states — no cap)

| Key | en | fr | pt | es | ar |
|---|---|---|---|---|---|
| `sent` | Done — I have told you in the chat. | C'est fait — je vous l'ai dit dans la conversation. | Pronto — já lhe disse na conversa. | Listo — te lo he dicho en el chat. | تم — لقد أخبرتك في المحادثة. |
| `slotTaken` | Somebody just took that time. Ask me again in the chat and I will show you what is left. | Quelqu'un vient de prendre cet horaire. Redemandez-moi dans la conversation et je vous montrerai ce qui reste. | Alguém acabou de reservar essa hora. Pergunte-me de novo na conversa e mostro-lhe o que resta. | Alguien acaba de reservar esa hora. Pregúntame otra vez en el chat y te muestro lo que queda. | حجز شخص آخر هذا الموعد للتو. اسألني مرة أخرى في المحادثة وسأعرض لك ما تبقّى. |
| `payNothingDue` | There is nothing to pay on this appointment. | Il n'y a rien à payer pour ce rendez-vous. | Não há nada a pagar nesta marcação. | No hay nada que pagar en esta cita. | لا يوجد ما يُدفع على هذا الموعد. |

### New buttons (`bot-chrome-copy.ts`, `cap: 20`)

| Key | en | fr | pt | es | ar |
|---|---|---|---|---|---|
| `bookChooseTimeButton` | Choose a time (13) | Choisir un horaire (18) | Escolher hora (13) | Elegir hora (11) | اختر موعدًا (11) |
| `payAppointmentButton` | Pay now (7) | Payer maintenant (16) | Pagar agora (11) | Pagar ahora (11) | ادفع الآن (9) |

For the balance quick reply, **reuse `PAY_BALANCE_LABEL`** — it already exists in the
notification catalogue for that situation's URL button
(`customer-notification-catalog.ts:91-95`). A second construction of one sentence is the
drift this codebase has already paid for four times.

### New row status labels (the `bl` row **description**, sharing 72 with the reference — keep ≤ 20)

| Key | en | fr | pt | es | ar |
|---|---|---|---|---|---|
| `statusAwaitingShop` | Awaiting the shop (17) | À confirmer (11) | A confirmar (11) | Por confirmar (13) | في انتظار التأكيد (17) |
| `statusUnpaid` | Not paid yet (12) | Non payé (8) | Não pago (8) | Sin pagar (9) | غير مدفوع (9) |
| `statusBalanceDue` | Balance to pay (14) | Solde à payer (13) | Saldo a pagar (13) | Saldo por pagar (15) | رصيد مستحق (10) |
| `statusCancelled` | Cancelled (9) | Annulé (6) | Cancelado (9) | Cancelado (9) | ملغى (4) |
| `statusDone` | Finished (8) | Terminé (7) | Concluído (9) | Finalizada (10) | منتهٍ (5) |

⚠ A `manual`-mode service comes back **pending**, and no surface may call it "booked"
(`booking.core.ts:348-352`). `statusAwaitingShop` is that row's word.

---

## 6 · Traps this codebase has proven

Each has a receipt in this repository. They are listed because every one of them produced a
green suite over a broken feature.

1. **A drawn-but-unrouted token is silent on both platforms.** Telegram reports nothing for an
   unhandled callback, so the customer presses a button and nothing happens at all. It shipped
   once with the close-account buttons (`6b2a47d`). `test-bot-surface.ts:663` now fails
   `DRAWN BUT NOT ROUTED` naming the builder — **so land the handler first, the button second,
   in one change.** § 20's own history is the second lesson: its first version recorded the
   **verb** for every builder, so `open:bl` with no handler was invisible because `open:co` was
   routed. *The unit counted must be the unit claimed.*

2. **A token can be drawn AND routed AND still be a dead end.** § 20 cannot see that
   `pay:rt` reaches a handler filtering `cartId: { $ne: null }`
   (`bot-checkout.controller.ts:806-808`), so a booking's "Try again" is green in every suite
   and answers a customer about their *orders*. Step 5's new assertion is the only thing that
   will catch the next one.

3. **A fixture that supplies what the producer forgot tests the renderer, not the feature.**
   `bl.html` reads `data.copy`; `readCustomerBookings` sends none. Any suite that hands the
   page a fixture *with* `copy` proves the page renders and proves nothing about the screen.
   Drive the real read.

4. **A mutant can lie in five ways** — it does not **compile** (a frozen literal makes
   `200 === 24` a type error), it does not **apply** (an anchor naming a method in another
   file), it is about a **different span**, it targets an assertion that was **already red**
   (reports a bite, proves nothing — score a bite only if the target fails *and* was passing at
   baseline), or it applies **partially** (9 of 14 French fields anglicised, the language stayed
   distinguishable, the guard passed). Make mutations **atomic** — swap a whole block. ⛔ Build
   the mutant copy from **HEAD** (`git checkout-index`), never from the live tree: other
   sessions are mid-write and the live copy may not compile, which reads as vacuous everywhere.

5. **A count inside an assertion is a dated observation.** This document's suite figures were
   already wrong in `CLAUDE.md` when it was written (§ 2.3). Assert a **property**, and where a
   count is unavoidable, name it as an observation with its date.

6. **A guard must not take its standard from the thing it is checking.** The row-title
   assertion once read the cap from `BOOKING_TEXT_CAPS` — the module it guards — so raising
   `rowTitle` to 200 would have gone green while Meta went on truncating at 24. The caps are
   now **literals**.

7. **A rule-stating comment can defeat that rule's own guard.** A scan that strips comments
   first will pass a mutant inserted into a comment; a scan that does not will go green on a
   comment that merely restates the rule. Name the span the guard covers, in the guard.

8. **Money maths never happens in a web page**, and the corollary this journey rests on: a
   held amount is an amount that can disagree with what is charged. `bp` holds none.

9. **A negative property's regression looks like a feature.** "This screen claims no outcome"
   and "this session holds no amount" both fail *by somebody adding something helpful*. Both
   need their own assertion; `test:kyc` is the precedent.

10. **`BOT_MINIAPP_BASE_URL` is unset in production**, so the storefront fallback is not a rare
    branch — it is the path that actually runs (`bot-booking.controller.ts:460-467`). A null
    `fallbackPath` renders a sentence with nothing to press, which is the defect
    `inapp_open_product` shipped with. Every new screen door must pass a real path.

---

## 7 · Open questions for the owner

Plain language, with a recommendation and what each answer costs.

**Q-1 · When someone taps "Book" on a service, should the bot open a small screen where they
pick a day and then a time — or keep asking them to type it out?**
*Recommendation: open the screen.* The screen is already built, tested and translated into all
five languages; today it cannot be opened at all, and the customer instead types "Tuesday
afternoon" and hopes the assistant reads it correctly. Cost of yes: roughly a day, and one
button appears on service cards. Cost of no: the three screens stay unreachable code and should
then be deleted rather than left looking alive.

**Q-2 · Should "My appointments" hide cancelled appointments, or show them marked
"Cancelled"?**
*Recommendation: show them, marked.* A customer who cancelled something and then sees an empty
list often assumes the cancellation did not work and asks again. Cost either way is the same
small change; hiding them is slightly less work and slightly more support.

**Q-3 · If somebody else takes the time while a customer is still choosing, what should the
customer see?**
*Recommendation: "Somebody just took that time — ask me again and I'll show you what's left",
and they go back to the chat.* Today they see "Something went wrong", which sounds like our
fault. The nicer version — the screen quietly reloading with the remaining times — needs a new
mechanism (a fresh screen pass issued on the spot, keeping the original expiry so nobody can
hold a shop's calendar open indefinitely). That is about an extra half-day. Worth saying which
you want, because it is the difference between a sentence and a mechanism.

**Q-4 · Today somebody who books an appointment in the chat would get two messages about it:
the immediate confirmation in the conversation, and the platform's standard booking message,
which may arrive somewhere else entirely — by email, or on the other chat app. Do you want that
cut to one?**
*Recommendation: yes, keep the one in the conversation.* Cost: a small extra field recorded on
the appointment. Cost of no: customers occasionally get the same news twice, in two places,
worded differently.

**Q-5 · When an appointment's payment fails, the "Try again" button we show today gives a
confusing answer about orders. Should tapping it re-open the payment screen for that
appointment?**
*Recommendation: yes.* This is the clearest defect in the whole journey — the button is drawn,
is tapped, and answers with a sentence about the customer's *orders*. Cost of yes: part of a
day. Cost of no: remove the button, because as it stands it is worse than nothing.

**Q-6 · Should typing `/bookings` work?**
*Recommendation: yes.* It is already in the command list with six aliases in four languages,
and it does nothing; it is also the only front door to appointments that does not require the
customer to have just booked something. Cost: part of a day.

**Q-7 · Still no "pay at the shop"?**
*Recommendation: confirm no, for now.* Nothing offers it and this plan does not add it. Note
the reason it is not a small change: an accepted-but-unpaid appointment is **automatically
cancelled 24 hours after it is made**, so "pay at the shop" would need that rule replaced
first — and on WhatsApp the set of buttons on a form is frozen when the form is published, so
adding it later means re-submitting the form.

**Q-8 · Is `BOT_MINIAPP_BASE_URL` set on the live host?** The code says it is not, and every
screen in the platform silently falls back to a storefront web page when it is unset — a page a
chat customer has no sign-in for. If the answer is "not set", then Steps 5–7 still improve
things (the fallback at least lands somewhere real), but nobody will see the screens. This is a
one-line answer that changes what "done" looks like, and I cannot check it without touching
production.

---

## 8 · Definition of done

**Suites.** All of `test:inapp-bookings`, `test:bot-surface`, `test:booking-availability`,
`test:booking-notification`, `test:booking-slot-offer`, `test:group-booking`,
`test:whatsapp-flows`, `test:errors`, `test:env` green, plus `typecheck` **and**
`typecheck:scripts` in `jovi-mall` (the first covers only `src/**`, so a broken suite otherwise
compiles and exits 0). `eslint` clean. ⚠ Re-measure the suite count rather than quoting one.

**Mutation-proven, not merely green.** One atomic mutant per invariant added in Steps 3, 4, 5
and 9, built from HEAD, each scored a bite only if its target fails *and* was passing at
baseline.

**Boot assertions.** The server starts; `assertCommandRegistryValid` passes with `bookings`
live; `assertNoShadowedRoutes` unchanged; `TTL_SECONDS` still total over `InAppSurfaceKind`
(that totality is what carries a new kind into the page controller's allowlist,
`inapp-page.controller.ts:207-209`).

**The new guard is green.** `KIND WITH NO DOOR` reports nothing — every served screen kind has
a mint site.

**Proven on a real handset** (Telegram first, then WhatsApp for the chat halves):

1. Tap **Book** on a service → the picker opens → pick a day → pick a time → **Confirm**.
2. The chat shows the receipt with the reference and the time, and a **My bookings** button.
3. Tap **My bookings** → the list opens, **in French**, with the next appointment first and a
   cancelled one shown as cancelled.
4. An unpaid appointment offers **Pay now** → the payment screen shows the amount, the masked
   wallet hint, one button.
5. Press **Pay** → the screen says the request is on its way and closes. The mobile-money
   prompt arrives on the phone.
6. Approve it → the receipt arrives **in the same chat**, not by email and not on the other
   platform.
7. Refuse it → the failure arrives in the same chat with a **Pay** button that re-opens the
   screen.
8. Type `/bookings` → the list opens.
9. Repeat 1–4 with the interface in **Arabic** and confirm no row is truncated into an
   ambiguous one.

⛔ Steps 6 and 7 are the two that cannot be proven offline and are the two most likely to be
declared done on a code read.

---

## 9 · What is NOT in scope, and why

Stated so it cannot be silently absorbed.

- **WhatsApp Flows for bookings.** `definitions/booking.flow.ts` holds all three forms and they
  are deliberately **absent from the publisher's list**, asserted by `test:whatsapp-flows`
  (`N8N-DEPLOY-DAY-CHANGES.md` § 13.6). ⛔ *"Move a form out of this list only when the owner
  says so explicitly. Never infer it from a file appearing, from a read landing, or from a
  definition validating."* This plan publishes nothing and edits no Flow definition. ⭐ Worth
  knowing: the Flow's `flow_token` **is** the `ia_` handle, so Steps 5–6 also unblock the
  WhatsApp half for whenever the owner does publish.
- **Pay at the shop.** Q-7. It needs the 24-hour sweep rule replaced, which is a product
  decision with money attached.
- **Any vendor-side booking work.** The vendor hold, `assertShopRuleSlot`, the "choose any
  time" reschedule and `api-doc/vendor/bookings.md` are done and are not touched.
- **Group / capacity booking behaviour.** KI-1 is closed and `GroupBookingService` stays as it
  is. Touching the lock key namespace is how KI-1 happened.
- **A cancel control on the `bl` screen.** Cancelling has money attached — refund rules, and on
  two gateways a support ticket rather than a refund — so it stays in the chat where it can be
  explained and confirmed (`bl.html:28-31`).
- **MCP tools that open the booking screens.** There is no `inapp_open_booking*` tool, by
  omission rather than by decision, and adding one means letting a **model** mint a
  money-moving handle. That is a separate owner decision, not a gap to fill.
- **`creditDue` refunds.** The customer overpaid and it is **recorded, never refunded**, by
  explicit product decision (`booking.model.ts:88`). A bot must report it as "the shop settled
  below the quote", never as money on its way back.
- **Retiring the old Mini App rail** (`miniapp.routes.ts:50,53,56` and
  `miniapp.controller.ts`). A named task, and somebody else's.
- **`booking.balance.received`'s WhatsApp template.** Unsubmitted, so outside the 24-hour
  window that one message cannot reach a WhatsApp customer. Owner's, not an engineering step.

---

## 10 · Related

`api-doc/n8n/bot-surface.md` § 14.9 (every tap and what it answers) · § 19.5 (a handle is a
credential) · `api-doc/booking-implementation-guide.md` · `api-doc/n8n/MCP-PARITY-PLAN.md` ·
`api-doc/n8n/N8N-DEPLOY-DAY-CHANGES.md` § 13.6 · `api-doc/vendor/bookings.md`
