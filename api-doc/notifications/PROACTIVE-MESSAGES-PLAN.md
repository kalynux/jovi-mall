# Proactive messages — every message the platform sends FIRST ends in the obvious next action

> **EXECUTED 2026-09-27 — steps 0–8 built; nothing yet proven on a handset.** Owner rulings that
> day: Q-4 yes · Q-5 the notification channel only · Q-6 yes (template optional) · Q-7 ship off ·
> **Q-8 12 hours, not 6.** Submitted to Meta the same day and **APPROVED**:
> eleven customer templates edited to add their quick replies (22), and the COD code as
> **`wi_mall_delivery_code`, AUTHENTICATION** — Meta rejected `cod_delivery_code` twice as UTILITY
> (`INCORRECT_CATEGORY`), so the owner ruled for an authentication template, sent only when the
> free message is refused. Four things this plan got wrong,
> found while executing it:
> 1. **`cod_delivery_code` had never been submitted** — § 1.4 and Step 8 call it "already approved".
>    The 3a guard found it.
> 2. **A template button cannot be omitted at send time** (§ 3.4, Step 6). It is shown regardless,
>    and a tap on one sent with no payload returns its label. Every placeholder token now declares a
>    `templateFallback`.
> 3. **The submitter could only CREATE** — Step 4's edits would have been silently skipped. It gained
>    `--edit`.
> 4. **`order.refunded` needed no new event** (Step 2): `payment.refunded` was already published and
>    subscribed by nothing.
>
> What follows is the plan as written.

**Status: PLAN. Nothing in it is built.** Measured against source on **2026-09-27**; every claim
carries a `file:line`. Read § 1 before § 4 — the single most expensive mistake available here is
building stage 1 again, because **stage 1 is already done and green**, and the two documents a
reader would most naturally trust about it (`whatsapp-templates.md` § 14.4 and the catalogue's own
header comments) both describe a **draft that was revised before it shipped**.

A *proactive* message is one the platform sends on its own: the customer did not type anything to
provoke it. Twenty-five of them are notifications; three more are sent by other code entirely
(§ 1.4). The goal: each one ends in the button a person would actually reach for, on WhatsApp and
on Telegram.

---

## 1 · What is true today, measured

### 1.1 The headline — stage 1 shipped, and the docs describing it are stale

The chat quick-reply mechanism is **built, wired to both chat channels, and asserted at boot**:

| Piece | Where |
|---|---|
| `QuickReplyDef` type + the per-channel capability matrix | `src/modules/notifications/catalog/notification-catalog.ts:91-102` (matrix in the comment at `:66-73`) |
| `actions?: QuickReplyDef[]` on a situation | `notification-catalog.ts:104-122` (the field at `:121`) |
| The vocabulary, per situation | `src/modules/notifications/catalog/customer-notification-catalog.ts:232-296` (labels) and on the situations themselves |
| Render + the dead-button drop | `customer-notification-catalog.ts:1762-1789` |
| Boot assertion (3 caps, 5 languages, verb grammar) | `customer-notification-catalog.ts:1537-1602`, called from `:1516` |
| WhatsApp **in-window** reply buttons | `src/modules/notifications/services/customer-notification-event-handler.service.ts:1666-1675` |
| Telegram inline keyboard | `customer-notification-event-handler.service.ts:1592-1598` → `src/modules/telegram/services/telegram-notification.service.ts:91-102` |
| The link moved into the body when buttons displace the CTA | `customer-notification-catalog.ts:1806-1808`, used at handler `:1667` |
| Suite | `npm run test:customer-notifications` — `scripts/test/test-customer-notifications.ts:718-900` |

⚠ **`whatsapp-templates.md` § 14.4 (`:1204-1219`) lists 13 situations and a button set that the code
does not ship.** It is the pre-revision draft. Three of its rows have no `actions` in the catalogue
at all (`customer_booking_confirmed`, `customer_booking_completed`, `customer_booking_reminder`), and
three more list a button that was withdrawn or removed before shipping: `That works`
(`customer_booking_rescheduled`), `Leave a review` (`customer_order_delivered`) and
`Where is it now` (`customer_order_delivery_failed`). **Do not submit from that table.** § 3 below is
the measured set.

### 1.2 Every proactive situation, measured

25 situations: `src/modules/notifications/models/customer-notification.model.ts:178-205` (the union at
`:28-153`; the Mongoose enum is spread from the array, so the two cannot drift — `:161-177`).

Columns: **copy** = `base` text; **langs** = languages of that copy; **tmpl** = the template *name*
the send path asks Meta for; **submitted** = that name is in
`api-doc/notifications/whatsapp-template-payloads.json` (i.e. it exists at Meta); **URL btn** = the
link button; **taps** = chat quick replies that actually ship; **trigger** = the code that raises it.

| # | Situation | copy | langs | tmpl | submitted | URL btn | taps (shipping) | trigger |
|---|---|---|---|---|---|---|---|---|
| 1 | `booking.created` | ✅ `:470` | 5 | `customer_booking_created` | ✅ | Voir la réservation | — | `…event-handler:223` |
| 2 | `booking.confirmed` | ✅ `:503` | 5 | `customer_booking_confirmed` | ✅ | booking | — | `:269` |
| 3 | `booking.rescheduled` | ✅ `:538` | 5 | `customer_booking_rescheduled` | ✅ | booking | `tkt:new` | `:297` |
| 4 | `booking.cancelled` | ✅ `:591` | 5 | `customer_booking_cancelled` | ✅ | booking | `book:{{productId}}` | `:330` |
| 5 | `booking.completed` | ✅ `:625` | 5 | `customer_booking_completed` | ✅ | booking | — | `:374` |
| 6 | `booking.reminder` | ✅ `:661` | 5 | `customer_booking_reminder` | ✅ | booking | — | `booking-reminder.worker.ts:153` |
| 7 | `booking.payment.received` | ✅ `:694` | 5 | `customer_booking_payment_received` | ✅ | booking | — | `:521` |
| 8 | `booking.balance.received` | ✅ `:749` | 5 | `customer_booking_balance_received` | ⛔ **NO** | booking | — | `:521` |
| 9 | `booking.payment_failed` | ✅ `:804` | 5 | `customer_booking_payment_failed` | ⛔ **NO** | booking | `pay:rt:{{transactionId}}` | `:576` |
| 10 | `booking.balance.due` | ✅ `:840` | 5 | `customer_booking_balance_due` | ✅ | Payer le solde | — | `CompletionPricingService.ts:189` |
| 11 | `booking.refunded` | ✅ `:873` | 5 | `customer_booking_refunded` | ✅ | booking | — | `:422` |
| 12 | `booking.refund.pending` | ✅ `:908` | 5 | `customer_booking_refund_pending` | ✅ | booking | — | `:424` |
| 13 | `order.created` | ✅ `:943` | 5 | `customer_order_created` | ✅ | Voir la commande | — | `:669` |
| 14 | `order.payment.received` | ✅ `:976` | 5 | `customer_order_payment_received` | ✅ | order | — | `:724` |
| 15 | `order.payment_link` | ✅ `:1018` | 5 | `customer_order_payment_link` | ✅ | Payer maintenant | — | `bot-messaging.controller.ts:181` |
| 16 | `order.payment_failed` | ✅ `:1075` | 5 | `customer_order_payment_failed` | ⛔ **NO** | order | `pay:rt:{{transactionId}}` | `:796` |
| 17 | `order.shipped` | ✅ `:1109` | 5 | `customer_order_shipped` | ✅ | Suivre la livraison | `ord:{{orderId}}` | `:859` |
| 18 | `order.out_for_delivery` | ✅ `:1145` | 5 | `customer_order_out_for_delivery` | ✅ | track | — | `:861` |
| 19 | `order.delivered` | ✅ `:1178` | 5 | `customer_order_delivered` | ✅ | order | `tkt:new:hp:{{orderId}}` | `:863` |
| 20 | `order.delivery_failed` | ✅ `:1225` | 5 | `customer_order_delivery_failed` | ✅ | track | `tkt:new:rd:…` · `tkt:new:ad:…` | `:865` |
| 21 | `order.cancelled` | ✅ `:1284` | 5 | `customer_order_cancelled` | ✅ | order | — | `:826` |
| 22 | `order.refunded` | ✅ `:1317` | 5 | `customer_order_refunded` | ✅ | order | — | ⛔ **NOTHING** |
| 23 | `ticket.replied` | ✅ `:1362` | 5 | `customer_ticket_replied` | ✅ | Voir la demande | `tkt:{{ticketId}}:rp` | `:954` |
| 24 | `ticket.awaiting_customer` | ✅ `:1402` | 5 | `customer_ticket_awaiting_customer` | ✅ | ticket | `tkt:{{ticketId}}:rp` | `:112` |
| 25 | `ticket.resolved` | ✅ `:1446` | 5 | `customer_ticket_resolved` | ✅ | ticket | `tkt:{{reopenableTicketId}}` | `:115` |

Line numbers in the `copy` column are `customer-notification-catalog.ts`; bare `:NNN` in `trigger`
is `customer-notification-event-handler.service.ts`.

**Totals: 25 situations · 25 templates named · 22 submitted · 25 URL buttons · 10 situations carry
taps (11 buttons) · 24 have a trigger.**

⚠ **Two numbers in the source are already stale, and both are the trap this plan warns about in
§ 6.** `notification-catalog.ts:118-120` says *"11 of the 24 customer situations"*; the true figure is
**15 of 25**. `customer-notification-catalog.ts:202-203` says *"designed once for all 24 situations"*;
there are 25. Neither is load-bearing — `test-customer-notifications.ts:741-745` already records that
this exact count expired three times in one day and was replaced by two properties a withdrawal
cannot falsify. **Fix the comments; do not re-introduce a count.**

### 1.3 ⛔ Three templates the send path names and Meta does not have

`customer_booking_balance_received`, `customer_booking_payment_failed`, `customer_order_payment_failed`
are absent from **both** `whatsapp-template-payloads.json` (verified: 192 payload objects / 96
distinct names / `generatedAt: 2026-09-15T17:03:02.810Z`) **and**
`src/modules/whatsapp/handlers/template/template-registry.ts:195-231` (22 `customer_*` entries).

The consequence is not cosmetic. Outside the 24-hour window a template is the only way to reach a
WhatsApp customer (`src/modules/whatsapp/validation/policy-validator.ts:161` returns
`['template']`). The send is refused by Meta, `meta-cloud.provider.ts:98-113` throws, the handler
converts it to a delivery error on the row (`customer-notification-event-handler.service.ts:1745-1750`)
and **the customer is told nothing.** Two of the three are *payment failures* — the highest-stakes
message the platform sends.

This is the same silence `templateLanguage()` was built to end (`notification-i18n.ts:55-80`),
reproduced by a different mechanism: the language is now right and **the name does not exist**.

⚠ **Why a green suite did not catch it.** Everything asserted against the payload file is about
*languages* or the OTP payload's shape (`test-customer-notifications.ts:941-1024`,
`test-phone-verification.ts:257-340`). **Nothing anywhere compares the template NAME set in the
catalogues to the submitted set.** The registry check at `test-customer-notifications.ts:987-1000`
filters on `!submitted.has(t.language)` alone, so a registry name absent from the file passes.

The full staleness, measured across all four catalogues (103 distinct names today; 94 in the file
plus 2 hand-built OTP names) is **9 templates, not "about seven"**: the three above, plus
`vendor_payout_transfer_failed`, `agency_payout_transfer_failed`, `agent_payout_requested`,
`agent_payout_paid`, `agent_payout_rejected`, `agent_payout_transfer_failed`. Six of those are not
customer-facing and are out of scope here (§ 9) — but the *guard* in Step 3 covers all nine.

### 1.4 Three proactive messages that are not notifications

| What | Where | Channels | Button |
|---|---|---|---|
| **COD delivery code** | `src/modules/cod/services/cash-collection.service.ts:217-235` → `src/modules/cod/services/delivery-code.service.ts:64-118` | ⛔ **WhatsApp only**, addressed from `customer.phone`, not the channel-connections store | none (`template-registry.ts:188` records `false`) |
| Phone-verification OTP | `src/modules/phone-verification/services/phone-verification.service.ts:212-299` | WhatsApp | OTP copy-code button |
| Product share | `src/modules/catalog/domain/services/ProductShareService.ts:202-219` | WhatsApp | none; refuses out of window with a remedy |

Only the first is in scope. **A Telegram-only customer with a COD order never receives their code in
chat** — the `notifyCodeIssued` path has no Telegram branch and no in-app notification. The code
remains visible in the customer app, which is the stated fallback
(`delivery-code.service.ts:129-132`), but the message that was supposed to carry it reaches nobody.

### 1.5 Delivery: in-app plus ONE secondary channel

`determineDeliveryChannels` — `customer-notification-event-handler.service.ts:1334-1382`.

- Priority `telegram > email > whatsapp`, one only.
- ⭐ **`originChat` overrides it** (`:1362-1364`): when a payment result belongs to a checkout that
  started in a chat, that chat takes the single secondary slot. Carried from
  `IPaymentTransaction.originChat`, narrowed at `:138-140`.
- Preference gating: `:64-73`. Eleven situations are ungated by design, listed with reasons at
  `:74-89` — **`order.refunded` is in that list**, which is how a situation nobody triggers still
  reads as "always sent".

**The 24-hour window** (`src/modules/whatsapp/whatsapp.service.ts`, 73 lines, the whole feature):

| | |
|---|---|
| Key | `open_chat_window:<bare digits>` — `whatsapp.service.ts:22` |
| Redis DB | `WA_WINDOW_DB = 6` — `src/infra/redis/redis.factory.ts:39` |
| TTL | `82800` = **23 h**, deliberately inside Meta's 24 — `whatsapp.service.ts:6` |
| Written | `recordInbound` `:31-37`; the only per-message writer is `src/modules/bot-surface/services/bot-registration.service.ts:231` |
| Read | `canSendFreeMessage` `:43-48` — six call sites incl. `…event-handler:1639` |

⚠ The `237…` vs `+237…` mismatch that refused every free-form send is **fixed** — one `.replace(/^\+/, '')`
at `whatsapp.service.ts:22`, dated in its own docstring at `:11-19`, pinned by
`scripts/test/test-phone-verification.ts:480-516`. Residual, and stated in the code at `:18-19`: it
strips a `+`, it cannot invent a country code.

### 1.6 What a delivered message feeds back

`noteSentToChat` — `customer-notification-event-handler.service.ts:1462-1488` → `botRecentlySentStore.noteSent`.

Three properties this plan must not break:

1. **Only a message that actually arrived is recorded.** The call sites are behind `attemptDelivery`'s
   boolean (`:1412`, `:1437`).
2. **No token and no URL reaches the record.** What is passed is `[button.label, ...quickReplies.map(r => r.label)]`
   (`:1470-1473`) — labels only — and `stripUrls` redacts any URL in the text
   (`src/modules/bot-surface/domain/bot-recently-sent.ts:106-115`). The reason is the destination:
   the record lands in an AI prompt and from there in an n8n execution log (`bot-recently-sent.ts:39-42`).
3. **Fire-and-forget.** A Redis blip costs the model context, never a customer their message (`:1481-1487`).

`RECENTLY_SENT_MAX = 5` (`bot-recently-sent.ts:51`) · TTL 2 h, matched to the bot's chat memory (`:58`)
· text clipped to 160 (`:61`).

### 1.7 Stage 2 is blocked on two lines of type, in a module no stream owns

A template quick-reply *payload* cannot be sent today, and the module looks as though it can —
`sub_type: 'quick_reply'` is already in the union at
`src/modules/whatsapp/types/whatsapp-message.types.ts:116`.

| # | Blocker | Where | Effect |
|---|---|---|---|
| 1 | `TemplateParameter.type` has no `'payload'`, and there is no `payload?: string` field | `whatsapp-message.types.ts:123-124` | will not compile |
| 2 | the runtime validator repeats the same list as a hardcoded allowlist and throws | `src/modules/whatsapp/handlers/template/template-validator.ts:127` | casting past `tsc` still fails `WHATSAPP_INVALID_PAYLOAD` **before Meta is called** |

**Zero `QUICK_REPLY` buttons exist in the submitted set** — 186 URL buttons and 2 OTP across 192
payloads. Meta's constraints, as recorded and re-verified at `whatsapp-templates.md:1170-1178`:
quick replies must be consecutive; caps are 10 total / 2 URL / 10 quick reply; **4+ buttons or a
mixed set does not render on WhatsApp desktop**, which is the binding limit and holds a template to
**1 URL + 2 quick replies**; and **editing an approved template requires re-approval**.

### 1.8 The template button says "Open", in two languages, forever

`scripts/generate-whatsapp-templates.ts:415-428`:

```ts
text: lang === 'fr' ? 'Ouvrir' : 'Open',
url: `${base}/{{1}}`,
```

So **out of window, every one of the 22 customer templates offers a button labelled `Open`/`Ouvrir`** —
never "Track delivery", "Pay now" or "View booking", even though the catalogue holds those labels in
five languages (`customer-notification-catalog.ts:66-198`). In window the rich label is used
(`…event-handler:1681`). The label is frozen at approval, so changing it is a 22 × 2 resubmission.
That is an owner decision, Q-1.

**The generator's env contract** (`generate-whatsapp-templates.ts:371-376`) is four variables, one per
audience — and the customer one is **`STOREFRONT_URL`**, *not* `VENDOR_APP_URL`:

```
vendor: VENDOR_APP_URL · agency: AGENCY_APP_URL · agent: AGENT_APP_URL · customer: STOREFRONT_URL
```

Pre-flight refuses all four before touching the output file (`:534-541`). Unset → `:391-396`;
non-https or localhost → `:397-402`. Overridable with `--base-customer=https://…` (`:390`).
⚠ **There is no host allowlist in code** — any public https host passes; the four `*.wi-mall.com`
hosts in the committed JSON are a record of the last run's env, not a constraint. ⚠ **The generator
does not load `.env`**, and the repo's current values (`.env:253-255`, `:261` — `http://100.124.149.1:…`)
would both trip refusal 2. ⚠ `whatsapp-templates.md`'s own env table (`:1270-1279`) **omits
`STOREFRONT_URL`**, which is the one the customer templates need.

---

## 2 · Decisions this plan takes

**D-1 · Stage 1 is closed. This plan is stage 1½ and stage 2.** No re-derivation of the vocabulary,
no second render path. Everything new either reuses the existing `actions` mechanism or lives on the
template side.

**D-2 · Reuse a token or add a handler; never invent a fourth segment.** `bot-ticket-actions.ts:83-105`
parses at most `<verb>:<a>:<b>:<c>`, and `booking.rescheduled`'s comment
(`customer-notification-catalog.ts:576-581`) records a `tkt:new:bk:<bookingId>` that had to be
abandoned because a booking id where an order id is expected **parses** and is therefore worse than a
refusal. Every token in § 3 is checked against the closed verb set (`bot-action-id.ts:62-149`), the
sub-dispatch list (`bot-action-dispatch.ts:58`) and the owning handler's own parser.

**D-3 · The three unsubmitted templates come first, and they are not a button change.** They are a
live silence on payment failures (§ 1.3). They are submitted *with* their stage-2 buttons rather than
twice, because they are **created**, not edited — and a creation costs no re-approval quota.

**D-4 · Situations keep their URL button. A tap is added only where the bot can finish the job in
chat.** The existing rule (`customer-notification-catalog.ts:212-218`), unchanged. A button that
repeats the link costs a Meta re-approval and buys the customer nothing.

**D-5 · `order.refunded` gets a trigger, not a deletion.** It is fully built — copy in five
languages, an approved template, a URL button, and a documented decision to send it ungated
(`…event-handler:77`). What is missing is three lines.

**D-6 · The abandoned-basket reminder is free-form only and submits no template.** It fires inside
the customer's own window by construction (§ 5), so there is nothing to approve and nothing to wait
for. It is therefore the one step that can land independently of Meta.

**D-7 · What this plan refuses: a second render path for notifications.** `BotReplyIntent` /
`renderBotReply` (`src/modules/bot-surface/domain/channel-reply.ts:83-315`, `:1367-1375`) is a
*composer* whose output n8n POSTs; the notification stack POSTs to Meta and Telegram itself through
`WaServiceMessage.*` and `TelegramNotificationService`. Unifying them is a real improvement and is
**out of scope** (§ 9) — doing it inside a button change would put every proactive message on an
untested path.

---

## 3 · The button vocabulary, designed ONCE

Template buttons cannot be changed after approval without spending quota, so this table is the
whole vocabulary — what ships today, what is added, and what each addition costs.

### 3.1 Shipping today, verified routable (no new handler)

| Button | Token | Verb routed by | Situations | en / fr / pt / es / ar (chars) |
|---|---|---|---|---|
| Try again | `pay:rt:{{transactionId}}` | `pay` → `CHECKOUT_ACTION_HANDLERS` | 9, 16 | Try again 9 / Réessayer 10 / Tentar de novo 14 / Intentar otra vez 17 / إعادة المحاولة |
| Order details | `ord:{{orderId}}` | `ord` → `ORDER_ACTION_HANDLERS` | 17 | Order details 13 / Détails 7 / Detalhes 8 / Detalles 8 / تفاصيل الطلب |
| Something's wrong | `tkt:new:hp:{{orderId}}` | `tkt` | 19 | Something's wrong 17 / Un problème 11 / Há um problema 14 / Hay un problema 15 / هناك مشكلة |
| I was not there | `tkt:new:rd:{{orderId}}` | `tkt` | 20 | I was not there 15 / Je n'étais pas là 17 / Não estava lá 13 / No estaba allí 15 / لم أكن هناك |
| My address is wrong | `tkt:new:ad:{{orderId}}` | `tkt` | 20 | My address is wrong 19 / Adresse incorrecte 18 / Morada errada 13 / Dirección errónea 18 / العنوان خاطئ |
| Reply here | `tkt:{{ticketId}}:rp` | `tkt` | 23, 24 | Reply here 10 / Répondre ici 12 / Responder aqui 14 / Responder aquí 14 / الرد هنا |
| Not sorted | `tkt:{{reopenableTicketId}}` | `tkt` | 25 | Not sorted 10 / Pas résolu 10 / Não resolvido 14 / Sin resolver 12 / لم يُحل |
| Ask to change | `tkt:new` | `tkt` | 3 | Ask to change 13 / Demander un autre 18 / Pedir outra hora 16 / Pedir otra hora 15 / طلب وقت آخر |
| Book again | `book:{{productId}}` | `book` → `PURCHASE_ACTION_HANDLERS` | 4 | Book again 10 / Réserver à nouveau 19 / Reservar de novo 16 / Reservar otra vez 17 / حجز مرة أخرى |

All nine labels are already in the catalogue at `customer-notification-catalog.ts:232-296`, all within
the 20-character cap in five languages, all within Telegram's 64-byte `callback_data` budget with a
24-character id expanded — asserted at `customer-notification-catalog.ts:1537-1602`.

### 3.2 ⭐ ADD NOW — zero new handler code, the button's chain already exists

| Button | Token | Situation | Why it is free |
|---|---|---|---|
| **Leave a review** | `rate:{{orderId}}` | 19 `order.delivered` | `LEAVE_REVIEW_LABEL` is already defined in five languages (`customer-notification-catalog.ts:250-252`) and currently **unused**. |

⛔ **The catalogue's own comment says this is impossible, and that comment is now false.**
`customer-notification-catalog.ts:1211-1216` reads *"`rate` is a declared verb that NO stream
registers, and there is no review path behind it at all"*. It was true when written. It stopped being
true in commit `c39bff7` (**2026-09-21**, *"every drawn button now reaches a handler"*), which added
`REVIEW_ACTION_HANDLERS = Object.freeze({ rate: handleRateTap })` at
`src/modules/bot-surface/controllers/bot-review.controller.ts:371-373`, registered in the dispatcher
at `bot-action.controller.ts:103`.

`handleRateTap` (`bot-review.controller.ts:225`) implements exactly the arity this button needs:
`rate:<orderId>` is **the invitation** — it checks the order belongs to the caller
(`:236-242`, a miss is 404 by design) and replies with the five-star picker, which renders as a
WhatsApp list and Telegram inline buttons (`starOptions`, `:342-347`). The arities are documented at
`bot-action-id.ts:552-567`.

⚠ Also restore the two unused label constants' reason for existing, or delete them: `CANCEL_BOOKING_LABEL`
(`:232-234`) and `THAT_WORKS_LABEL` (`:236-238`) are defined, in five languages, and referenced
nowhere. They are the residue of § 3.3.

### 3.3 Needs a new handler key — owner decision, real work

| Button | Proposed token | Situation | What is missing |
|---|---|---|---|
| That works | `yes:bkmove:{{bookingId}}` | 3 `booking.rescheduled` | `yes` **is** sub-dispatched (`bot-action-dispatch.ts:58`) and `BOOKING_ACTION_HANDLERS` holds only `open:bl` (`bot-booking.controller.ts:502-504`). The token shape is already correct and recorded as "a registration away" (`customer-notification-catalog.ts:571-575`). **Cheapest of the three.** |
| Cancel booking | `yes:bkcnl:{{bookingId}}` + `no:bkcnl:{{bookingId}}` | 2 `booking.confirmed`, 6 `booking.reminder` | Cancelling is destructive, so it needs the confirm pair the order-cancel path already models (`yes:cnc` / `no:cnc`, `bot-ticket-actions.ts:168-174`) — two registry keys and a signed ref, not one button. `bookingService.cancelBooking` exists (`bot-booking.controller.ts:450`) but has no tap route. |
| Leave a review (booking) | `rate:bk:{{bookingId}}` | 5 `booking.completed` | ⛔ **Not a fourth arity of `rate`.** `handleRateTap` resolves an **`OrderModel`** row (`bot-review.controller.ts:236-242`) and a `Booking` carries no `order_id` — the two are separate aggregates. This needs a review-subject path for services, which the discovery stream owns. |

⚠ **`booking.completed`'s context does not even carry a product id** (`…event-handler:379-401`), so
"Book again" is not available there either without a handler change.

### 3.4 The stage-2 submission set — what each template gains

Per D-4 and the desktop-rendering limit (1 URL + 2 quick replies), **8 templates gain buttons**:

| Template | URL | Quick reply 1 | Quick reply 2 |
|---|---|---|---|
| `customer_booking_payment_failed` | keep | Try again | — |
| `customer_order_payment_failed` | keep | Try again | — |
| `customer_order_shipped` | keep | Order details | — |
| `customer_order_delivered` | keep | Leave a review | Something's wrong |
| `customer_order_delivery_failed` | ⚠ see below | I was not there | My address is wrong |
| `customer_booking_rescheduled` | keep | Ask to change | — |
| `customer_ticket_replied` | keep | Reply here | — |
| `customer_ticket_awaiting_customer` | keep | Reply here | — |
| `customer_ticket_resolved` | keep | Not sorted | — |

That is 9 rows; `customer_booking_cancelled` (`Book again`) is the tenth and is Q-4.

⚠ **`customer_order_delivery_failed` is the one that hits the limit**: its URL button is
`TRACK_BUTTON` and it carries **two** quick replies, so URL + 2 is exactly at the desktop cap and is
fine — but adding a third (the removed "Where is it now") would break rendering. It was already
removed for a different and better reason, recorded at `customer-notification-catalog.ts:285-291`:
the link button already says "Track delivery", so the tap was a second control for one intent.

⚠ **`customer_ticket_resolved`'s button is conditional at SEND time, not in the template.** It is
suppressed for a *closed* request by omitting the id its token carries — the drop-guard at
`customer-notification-catalog.ts:1774-1780`. Meta permits this: button parameters are supplied per
send. The template must be approved *with* the button.

**The other 16 templates are untouched**, which is the point of D-4 — 16 re-approvals not spent.

---

## 4 · The work, in ordered steps

Legend: **[code]** an engineer does it · **[meta]** needs Meta's review, so it has lead time ·
**[owner]** only the project owner can do it.

### Step 0 · **[owner]** + **[meta]** — submit the three missing templates *with* their buttons

The live silence from § 1.3. Nothing else in this plan matters more, and it is the only step whose
absence is costing customers today.

Because these are **created** rather than **edited**, their stage-2 buttons come free — no
re-approval is spent, and the round is one round instead of two. So Step 0 depends on Step 4 having
chosen the button set (it has: § 3.4), but **not** on Step 4 being built: an approved button that the
code cannot yet send simply goes unused until Step 5 lands.

Owner actions, in order:

1. Set `STOREFRONT_URL=https://wi-mall.com` and the three `*_APP_URL` production hosts in the shell
   (⚠ the generator does not read `.env` — § 1.8), then `npm run whatsapp:templates`.
2. `npm run whatsapp:templates:submit` with **no** `--submit` — prints the diff against the live
   WABA and sends nothing (`scripts/submit-whatsapp-templates.ts`).
3. Review, then submit. **English and French only** — the owner's standing ruling, recorded at
   `whatsapp-templates.md:1226-1231`. `pt`/`es`/`ar` reach English through `templateLanguage()`
   (`notification-i18n.ts:77-80`) and need no template of their own.

⛔ **Approval is not evidence the send works.** Meta reviews *content* at approval and validates
*component shape* at send. One live send per new template is the only proof — the same lesson as
ADR-022's "a successful n8n execution proves nothing" (§ 6).

**Verified by:** the three names present in `whatsapp-template-payloads.json`; `test:customer-notifications`
green; one real out-of-window send each, on a handset.

### Step 1 · **[code]** — restore "Leave a review" and correct three stale comments

Owns exclusively:
- `src/modules/notifications/catalog/customer-notification-catalog.ts` — add
  `{ token: 'rate:{{orderId}}', label: LEAVE_REVIEW_LABEL }` to `order.delivered`'s `actions`
  (`:1209-1223`), **before** `Something's wrong` (the positive action first, as `order.delivery_failed`
  orders its two). Rewrite the withdrawal comment at `:1211-1216` to record that `rate` is routed
  since `c39bff7` and cite `bot-review.controller.ts:371-373`. Fix the two expired counts at
  `:202-203` and `notification-catalog.ts:118-120` **by removing the number**, not by updating it.

No other file changes. `order.delivered` already supplies `{{orderId}}` (`…event-handler:863`).

**Tests:** `npm run test:customer-notifications` (the boot assertion and the caps already cover the
new entry) · `npm run test:bot-surface` · `npm run typecheck && npm run typecheck:scripts`.

**Verified by:** an `order.delivered` notification on a handset whose "Leave a review" tap returns the
five-star picker, on both WhatsApp and Telegram.

### Step 2 · **[code]** — give `order.refunded` a trigger

Owns exclusively:
- `src/modules/notifications/services/customer-notification-event-handler.service.ts` — a handler
  beside `handleOrderCancelled` (`:813`), modelled on `handleBookingPaymentUpdated`'s refund branch
  (`:405-487`), with `idempotencyKey: \`customer.order.refunded:${…}\`` per the convention at `:378`.
- `src/modules/notifications/customer-notification-event-consumer.ts` — one `eventBus.subscribe` line.

⚠ **Find the publisher before writing the subscriber.** Nothing publishes an order-refund event
today; if the refund path raises no event, this step is *also* a one-line publish inside the
refunding service, and that file then belongs to this step too. Do not invent an event name — reuse
whatever the money path already emits, and if there is none, name it `order.refunded` to match the
situation.

**Tests:** `npm run test:customer-notifications` · `npm run test:system` (worker/subscriber
inventory).

**Verified by:** a refund on a dev order producing exactly one inbox row and one chat message.

### Step 3 · **[code]** — the guard that would have caught § 1.3, and § 1.2's dead tokens

Two source scans. They are the highest-leverage code in this plan, because both failures they catch
are invisible to every existing suite.

Owns exclusively:
- `scripts/test/test-customer-notifications.ts` — **3a**: every `whatsapp.template.name` in the
  **four** catalogues is present in `whatsapp-template-payloads.json`, both directions, with the two
  hand-built OTP names allowlisted **by name** and the reason written at the allowlist. This is the
  assertion whose absence let nine templates drift.
- `scripts/test/test-bot-surface.ts` — **3b**: every `actions[].token` in
  `CUSTOMER_NOTIFICATION_CATALOG` resolves to a **routed** registry key. `botActionCoverage`
  (`:483-671`) cannot see these tokens and **says so at `:517-531`**: the catalogue writes them as
  literals with placeholders, so no builder is called, and *"TEN dead tokens survived in that file
  until a census read it by hand."* The new scan reads `routed` out of the dispatcher's own merge
  call — never a hardcoded list.

⚠ **3b must strip comments before scanning**, for the reason `test-bot-surface.ts:464-468` and
`test-customer-notifications.ts:908-934` both give: a ⛔ rule stated in a docstring would otherwise
satisfy the rule's own guard. Withdrawn tokens live in comments in this very file.

⚠ **3a must not take its expected set from the generator by running it** — the generator needs four
env vars and refuses without them, so a CI run would skip, and skipped looks like passing. Read the
catalogues and the JSON as data.

⚠ **Both must be non-vacuous and shown to bite**, in the style already used at
`test-customer-notifications.ts:773-790`: mutate an in-memory copy, assert the failure names the
right thing, restore.

**Verified by:** temporarily adding a token with a bogus verb makes 3b red; temporarily renaming a
template in a catalogue makes 3a red. Both restored before commit.

### Step 4 · **[owner]** — approve the stage-2 button set

The decision, not the build: § 3.4's nine rows, plus Q-4's tenth. Costs **9 or 10 re-approvals × 2
languages = 18–20 submissions**, and the monthly edit quota is finite. Step 0's three templates are
*creations* and do not draw on it.

### Step 5 · **[code]** — unblock the template quick-reply payload

Owns exclusively:
- `src/modules/whatsapp/types/whatsapp-message.types.ts` — add `'payload'` to
  `TemplateParameter.type` (`:124`) and `payload?: string`.
- `src/modules/whatsapp/handlers/template/template-validator.ts` — add `'payload'` to `validTypes`
  (`:127`) and a `case 'payload'` requiring a non-empty string in the switch below it.

⚠ **These two lists are a deliberate duplication and both must change.** The type stops it
compiling; the validator throws at runtime before Meta is called. Changing one is the failure mode
`whatsapp-templates.md:1147-1157` calls *registered, validated, and never reached*.

⛔ **Always send an explicit `payload`.** Meta documents a template quick-reply tap as
`messages[0].type === "button"` with `button.payload`, and describes the payload as carrying the
**label text**; what arrives when no payload parameter was supplied is undocumented
(`whatsapp-templates.md:1180-1192`). The WhatsApp adapter forwards `button.payload` verbatim, so a
visible label such as `Try again` would otherwise arrive where a verb is expected. The dispatcher
already treats an unparseable token as the unknown-button refusal (`bot-action-dispatch.ts:130-147`),
which is the correct landing — but only if a payload is always sent.

**Tests:** a new case in whichever suite owns the WhatsApp module's validator, asserting a
`quick_reply` button component with a `payload` parameter passes and one with an empty payload
throws `WHATSAPP_INVALID_PAYLOAD`.

### Step 6 · **[code]** — emit the quick-reply button components out of window

Owns exclusively:
- `src/modules/notifications/services/customer-notification-event-handler.service.ts` — in the
  template branch (`:1691-1742`), after the URL button component at `:1701-1717`, push one
  `{ type: 'button', sub_type: 'quick_reply', index: n, parameters: [{ type: 'payload', payload: token }] }`
  per resolved quick reply, indices continuing from the URL button's `0`.
- `scripts/generate-whatsapp-templates.ts` — emit the `BUTTONS` component's quick replies from the
  catalogue's `actions`, so the approved template and the send agree by construction. **Quick replies
  after the URL button and consecutive** — alternating is rejected by Meta.

⚠ **`renderCustomerQuickReplies` is already the single source of the set** (`:1405` in window,
`:1647` for the WhatsApp branch). Call it once in the template branch too; do not re-derive.

⚠ **The drop-guard must keep working out of window.** A situation whose quick reply is dropped
(`ticket.resolved` on a closed request) must send **no** button parameter for that index — not an
empty one. An index with no parameter is what "this button is not offered this time" looks like on
the wire.

### Step 7 · **[code]** + **[owner]** — the abandoned-basket reminder

Its own section: § 5.

### Step 8 · **[code]** — the COD code reaches a Telegram customer, and ends in a button

Owns exclusively:
- `src/modules/cod/services/cash-collection.service.ts` (`notifyCodeIssued`, `:217-235`) and
  `src/modules/cod/services/delivery-code.service.ts`.

Route it through the channel-connections store like every other proactive message instead of
`customer.phone`, and append `ord:{{orderId}}` — "Order details" — as the single tap. The template
`cod_delivery_code` gains no button: it is already approved without one, and adding one there is a
re-approval for a message whose content *is* the action (Q-5).

⚠ The code is a **credential**. It may go in the message; it must never reach `recentlySent`
(§ 1.6). `noteSentToChat` records the label, not the body — but this path does not call
`noteSentToChat` at all today, and **it must not start.** Write that reason at the call site.

---

## 5 · The abandoned-basket reminder

One reminder, about six hours after the basket was last touched, from a swept worker. It is
**deliberately the only new proactive situation this plan adds.**

### 5.1 Why it needs no template, and why that is the whole design

⭐ **Six hours is inside Meta's 23-hour window by construction** (`whatsapp.service.ts:6`), and the
window is stamped on **every inbound message** (`bot-registration.service.ts:231`). A customer who
filled a basket in the bot sent a message to do it. So a reminder at +6 h is free-form, needs no
approved template, spends no quota, and waits on no review.

⚠ **That argument holds only for a basket built in the chat.** A basket filled on the storefront by
somebody who has never messaged the bot has **no open window**, and the reminder would be refused
with `WHATSAPP_POLICY_VIOLATION` (`policy-validator.ts:76-89`). So the rule is: **send only where the
window is actually open** — check `canSendFreeMessage` (`whatsapp.service.ts:43-48`) and, when it is
closed, send the in-app row and Telegram and **no WhatsApp message at all**. Do not add a template
to cover it; that converts a free step into a Meta round and the case it covers is a customer the
platform has no chat relationship with.

Why six and not two or twelve: two catches somebody still shopping in another tab and reads as
nagging; twelve falls outside the window for a morning basket and turns the whole feature into a
template submission. Six clears a lunch break, stays inside the window with 17 hours of margin, and
is one number the owner can move by config.

### 5.2 What decides "abandoned"

`ICart` is keyed `userId`, holds `items[]`, and has `updatedAt` from `timestamps: true`
(`src/modules/cart/models/cart.model.ts:74-80`, `:174`). Every add, quantity change and removal moves
it. So: **a cart with at least one item whose `updatedAt` fell into the window, and whose owner has a
chat connection.**

⚠ **`cart.model.ts` declares no index** — `grep 'index(' ` returns nothing. A sweep filtering on
`updatedAt` needs one, and per the pre-production rule (index migrations only, no data migrations)
this is an **index migration** through `scripts/migrate.ts`. ⚠ Declare it and run
`migrate:declared-indexes`; `autoIndex` is off in production.

### 5.3 How it is not sent twice, and how checkout cancels it

Three mechanisms, and the third is the one that makes a mutable cart safe:

1. **Window tiling.** `updatedAt ∈ [now − lead − interval, now − lead)`, exactly as
   `BookingReminderWorker` tiles `startAt` (`src/modules/booking/workers/booking-reminder.worker.ts:24-29`).
   Consecutive passes tile the range: no cart falls between two windows and none appears in both. A
   skipped pass loses reminders rather than duplicating them — the safer failure.
2. **An idempotency key per cart *state*, not per cart.** `customer.cart.abandoned:<cartId>:<updatedAt ms>`,
   following `booking-reminder.worker.ts:157`. ⚠ **The `updatedAt` stamp in the key is load-bearing.**
   A bare `<cartId>` would silence the reminder forever after one send, so a customer who abandons,
   comes back, adds two things and abandons again is never reminded of the second basket. Including
   the stamp makes "a new abandonment" a new key — and tiling means the same state is only ever
   swept once anyway.
3. **Checkout cancels it by deleting the basket.** Order creation clears the cart — recorded at
   `bot-action-id.ts:113-115` (*"Creating orders clears the basket, so by the time a payment fails
   there is no basket left to check out"*). An empty or absent cart cannot match the sweep. **No
   cancellation flag is needed, and none should be added**: a flag is a second source of truth about
   whether a basket exists.

⚠ **Do not remind on a cart whose items are all unbuyable.** A basket of delisted or out-of-stock
variants produces a message whose button leads to a dead end. Check buyability, or say in the step
why it was judged acceptable — silently skipping this is the kind of scope cut D-7's sibling rule
forbids.

### 5.4 The shape

- **Situation:** `cart.abandoned`, added to `CustomerNotificationType` (`customer-notification.model.ts:28-153`)
  and its runtime array `:178-205`. `CustomerAggregateType` needs **`cart`** adding (`:212-219`) —
  today's five are `booking | order | shipment | payment | ticket`.
- **Copy:** five languages, one line, naming what is in the basket. Never a price — a price in a
  reminder is a promise the catalogue can break before they return.
- **Preference:** a new key on `customer-notification-preference.model.ts`, defaulting **on**, and
  it belongs in the *gated* group (`…event-handler:64-73`), not the ungated one. This is the only
  proactive message on the platform that is not the consequence of something the customer or their
  counterparty did, so it is the one that most needs an off switch.
- **URL button:** the basket page. ⚠ Read the storefront's route tree — the catalogue's header
  (`customer-notification-catalog.ts:36-64`) records that all 22 suffixes were once wrong and that a
  route which does not exist yet is worse than no button. Update
  `api-doc/notifications/storefront-routes.md` in **both** copies of the mirror.
- **Tap:** `cart:view` — already a routed verb (`bot-action-id.ts:85-100`), carries no placeholder so
  it can never render empty, and its handler returns the basket as data for the model to narrate.
- **Template:** ⛔ **none.** `whatsapp.template` is a required field of `SituationMessages`
  (`notification-catalog.ts:108-111`), so this situation is the first that needs the field to be
  optional, **or** a name that is submitted for completeness and never sent. Decide this explicitly —
  Q-6. Do **not** name a template that does not exist: that is § 1.3's defect, chosen on purpose.
- **Worker:** `src/modules/cart/workers/abandoned-cart.worker.ts`, implementing `ObservableWorker`
  exactly as `booking-reminder.worker.ts:41-105` does — `schedules` reporting the **same** config
  value it schedules with (`test:system` asserts this), `withWorkerLock('abandoned-cart', …)` for the
  cross-instance guard, `maintenanceBlocksWorkers()` on the tick, `null` on a skip and `0` for
  "nothing was due".
- **Config:** `CART_REMINDER_ENABLED` (default **off** — Q-7), `CART_REMINDER_LEAD_MINUTES` (360),
  `CART_REMINDER_INTERVAL_MS`, `CART_REMINDER_BATCH_SIZE`. ⚠ Add all four to `.env.example`; `test:env`
  asserts `.env.example` against every variable `src/` reads **in both directions**.

---

## 6 · Traps this codebase has already proven

Each one has cost this repository a real defect. The evidence is cited so the executing session can
read it rather than take it on faith.

**T-1 · A successful run proves nothing.** ADR-022: on 2026-09-07 jovi-mall was down, Meta refused a
reply, a customer got nothing, and all three n8n executions recorded `success`. The template version
of the same trap is spelled out at `whatsapp-templates.md:1259-1266`: **Meta reviews content at
approval and validates component shape at send**, so a template can read `APPROVED` while every send
carrying its new button parameter is refused. *One live send per changed template, or it is not
done.*

**T-2 · A count inside an assertion is a dated observation wearing the clothes of a rule.**
`test-customer-notifications.ts:741-745` records this happening **three times in one day** in that
one file — *"every time, a number was a date-stamped observation …; every time, it went red for a
CORRECT change."* It was replaced with two properties a withdrawal cannot falsify. The same rot is
live right now in three more places: `notification-catalog.ts:118-120` ("11 of the 24"),
`customer-notification-catalog.ts:202-203` ("all 24 situations"), and
`whatsapp-template-payloads.json:8` (`templateCount: 95` beside 96 distinct names — the generator's
own `rows.length + 1` at `generate-whatsapp-templates.ts:595`). *Assert the property; delete the
number.*

**T-3 · A guard must not take its cap from the module it guards.** `assertCustomerQuickRepliesSendable`
hardcodes `MAX_LABEL_CHARS = 20` with the reason written at `customer-notification-catalog.ts:1543`
— *"Not imported — the notifications stack does not depend on the WhatsApp module"* — and
`test:bot-surface` separately asserts that `bot-action-id.ts`'s 64 and `channel-reply.ts`'s 64 agree
(`bot-action-id.ts:151-158`). That is the correct shape: duplicate the number and assert the
duplication. Importing `WA_LIMITS` into the guard would make the guard pass automatically the day
somebody widened the limit.

**T-4 · A producer that writes a token as a string literal has no parser.** This is the trap most
likely to bite this specific work. The catalogue's ids do not exist until render time, so it
**cannot** call `bot-action-id.ts`'s builders and writes `'tkt:new:hp:{{orderId}}'` by hand.
`test-bot-surface.ts:517-531` states the consequence exactly: the coverage scan sees builder *calls*,
so *"this scan cannot see a single token it produces"*, and **"TEN dead tokens survived in that file
until a census read it by hand."** Two of the ten are still visible as withdrawal comments
(`customer-notification-catalog.ts:571-575` and `:1211-1216`) — and § 3.2 proves the second half of
the trap: one of those withdrawals is **now obsolete and nobody noticed for six days**, because
nothing re-checks it either. Step 3b is the fix.

**T-5 · Template language fallback must be explicit and asserted, because a language resolving to an
unapproved template is a failed send — silence.** `templateLanguage()` (`notification-i18n.ts:77-80`)
clamps to the literal `'en'`, deliberately not `DEFAULT_LANGUAGE` (reasoning at `:68-74`), and is
pinned by five assertions plus two source scans over all six send sites
(`test-customer-notifications.ts:965-1067`). ⚠ **The neighbouring mechanism already lied once about
exactly this**: `template-registry.ts` registered all five languages, so *"the code's own model of
the world said the template existed"* and the real defect survived for months
(`notification-i18n.ts:39-46`; the fix and its reasoning at `template-registry.ts:100-126`). The
registry is fixed; § 1.3 is the same class of lie one level down — the *name*, not the language.

**T-6 · A comment stating a rule can defeat that rule's own guard.** Comments are stripped before
every source scan in both suites, and both say why (`test-bot-surface.ts:461-468`,
`test-customer-notifications.ts:908-934`). Step 3b scans a file whose withdrawn tokens live in
comments; without stripping, it would pass on them.

**T-7 · A red CI job skips the live suites, and skipped looks like passing.** Do not read a green
board as evidence. Re-measure.

---

## 7 · Open questions for the owner

Plain language. Each has a recommendation and what the answer costs.

> **Q-1 · Out of window, every button on a WhatsApp message says "Open". Should it say what it
> actually does?**
> Inside 24 hours of the customer's last message we send the right words — "Track delivery", "Pay
> now", "View booking". Outside that window WhatsApp only lets us send a pre-approved message, and
> the button on all 22 of ours was approved with the single word "Open" (French: "Ouvrir"). Changing
> it means re-submitting all 22 in both languages — 44 submissions — and Meta allows only a limited
> number of edits per month.
> **Recommendation: not now, and not all at once.** Change it on the four where the button is the
> point — the two payment ones, out-for-delivery and delivery-failed — and leave the rest as "Open".
> **Cost:** doing all 22 spends most of a month's edit allowance on wording; doing four spends
> little and fixes the messages where a vague button actually loses money.

> **Q-2 · Three messages cannot reach a WhatsApp customer at all right now. Submit them this week?**
> When a payment fails, or a booking balance is paid, we send a message. If the customer has not
> written to us in the last 23 hours, WhatsApp requires a pre-approved version of that message — and
> for these three we never submitted one. So the message is refused and **the customer is told
> nothing.** Two of the three are payment failures.
> **Recommendation: yes, first, ahead of everything else here.** **Cost:** a few days of Meta review.
> Submitting them as brand-new messages also means their buttons come free — an edit costs quota, a
> creation does not.

> **Q-3 · Should a customer be able to cancel a booking by tapping a button in chat?**
> Today the reminder and the confirmation both say "View booking" and nothing else. Cancelling from
> chat needs two buttons, not one — a tap and then a confirmation — because a mis-tap would cancel a
> real appointment.
> **Recommendation: yes, but as its own piece of work after this one.** **Cost:** it is the largest
> item on this list and it touches the bookings code, not the messages code. Bundling it in would
> hold up the three silent messages in Q-2.

> **Q-4 · "Book again" on a cancelled booking — worth a re-approval?**
> When a booking is cancelled we can offer a one-tap re-book. It works in chat today; putting it on
> the pre-approved version costs one edit in two languages.
> **Recommendation: yes.** A cancelled appointment is the single best moment to win the booking back.
> **Cost:** 2 of the month's edits.

> **Q-5 · The cash-on-delivery code goes only to WhatsApp. Fix that?**
> A customer paying cash gets a code to give the delivery agent. We send it by WhatsApp only, to the
> phone number on their profile — so **a customer who uses Telegram never gets it in chat.** It is
> still in the app, but the message meant to carry it reaches nobody.
> **Recommendation: yes — send it the same way every other message is sent.** **Cost:** small, and no
> Meta involvement. It is a bug, not a feature request.

> **Q-6 · The basket reminder is the first message with no WhatsApp pre-approved version. Is that
> allowed to stay that way?**
> Every other message has one. This one does not need one, because it is sent within hours of the
> customer's own message and is therefore free-form. But our code currently *requires* every message
> to name one.
> **Recommendation: make the field optional, and write down that this message is deliberately
> in-window-only.** **Cost:** a small code change. The alternative — submitting a version we never
> send — is what caused the Q-2 problem in reverse, and would leave a message in Meta's system that
> nothing keeps honest.

> **Q-7 · Should the basket reminder be switched on the day it ships?**
> **Recommendation: ship it off, turn it on after watching one day of what it *would* have sent.**
> This is the first message the platform sends that is not the consequence of something the customer
> did — it is the one with real potential to annoy. **Cost:** one extra day.

> **Q-8 · Six hours — right?**
> **Recommendation: yes, and it is one setting we can change without a deploy-time decision.** Two
> hours catches people still shopping. Twelve falls outside WhatsApp's free-reply window for a
> morning basket, which would turn this into another Meta submission.

---

## 8 · Definition of done

**Suites green**, run from `jovi-mall/`:

| | |
|---|---|
| `npm run test:customer-notifications` | the catalogue, the caps, the language fallback, **and new: catalogue ↔ submitted name parity (3a)** |
| `npm run test:bot-surface` | the route table, the coverage scan, **and new: every catalogue token is routed (3b)** |
| `npm run test:recently-sent` | no token and no URL entered the model's context |
| `npm run test:system` | every worker's reported schedule equals the value it schedules with — the abandoned-cart worker included |
| `npm run test:env` | all four `CART_REMINDER_*` present in `.env.example`, both directions |
| `npm run typecheck` **and** `npm run typecheck:scripts` | ⚠ `typecheck` covers `src/**` only; a broken suite otherwise compiles and exits 0 |

**Boot assertions pass:** `assertCustomerCatalogComplete()` (`customer-notification-catalog.ts:1504`),
which calls `assertCustomerQuickRepliesSendable()` (`:1537`) — five languages, ≤ 20 characters,
≤ 64 bytes with a 24-character id expanded, ≤ 3 per situation, verb-prefixed, no duplicates.

**Proven on a handset** — the only evidence that counts, per T-1. On **both** WhatsApp and Telegram,
in **English and French**:

1. `order.delivered` **in window** → "Leave a review" returns the five-star picker; a star publishes.
2. `order.payment_failed` **out of window** → the newly approved template arrives, and "Try again"
   re-opens the charge. *This is the one that proves Step 0, Step 5 and Step 6 together.*
3. `ticket.resolved` for a **closed** request out of window → the message arrives with **no**
   "Not sorted" button, and for a *resolved* one it arrives with it.
4. A refund on a dev order → exactly one `order.refunded` message.
5. A COD order → the code arrives on Telegram.
6. A basket left six hours → one reminder, and a second sweep sends nothing.
7. After each of the above, the customer types "ok thanks" and the bot answers about the right thing —
   `recentlySent` recorded it, with the URL redacted and no token present.

⚠ **Re-measure, do not trust a number in this document.** Every count in § 1 was true on 2026-09-27.

---

## 9 · What is NOT in scope

Stated so the executing session does not absorb any of it silently. Several are real and should
become their own work.

1. **The six non-customer templates missing from the submitted set** —
   `vendor_payout_transfer_failed`, `agency_payout_transfer_failed` and the four
   `agent_payout_*`. Same defect as § 1.3 and the same silence, for vendors, agencies and agents.
   **Step 3a will turn them red**, which is correct and intended: the guard names the whole problem
   and the owner decides when to submit. Do not delete or allowlist them to get green.
2. **Quick replies for the vendor, agency and agent stacks.** Those three handlers have no
   reply-button support at all — only `ctaUrl` or plain text. This plan is customer-only.
3. **Unifying the two outbound abstractions** (D-7). `BotReplyIntent`/`renderBotReply` composes for
   n8n; the notification stack POSTs itself. Worth doing; not inside a button change.
4. **Reviewing a booking** (§ 3.3). Needs a review-subject path for services; belongs to the
   discovery stream.
5. **Cancelling a booking by tap** (Q-3). Needs the confirm pair and belongs to bookings.
6. **Any n8n change.** The tap path already exists and forwards `button.payload` verbatim. Step 5's
   rule exists so that no n8n change is needed.
7. **Adding a language.** `pt`/`es`/`ar` resolve to English by the owner's standing ruling
   (`whatsapp-templates.md:1226-1231`). Chat copy, email, Telegram and the inbox stay five-language.
8. **`tracking_audit.viewer_id`, retention, and anything in geo-tracker.** Untouched.
9. **`whatsapp-templates.md`'s other stale counts** (`:199-200`, `:214-219`, `:35-42`) and its
   five-language convention lines (`:227`, `:248`, `:264`) which contradict its own banner at `:3-7`.
   ⚠ **Except § 14.4's button table and the env table at `:1270-1279`** — those two mislead *this*
   work directly (§ 1.1, § 1.8) and whichever step first reads them should correct them in place.
