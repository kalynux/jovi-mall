# Notification deep links — the vendor, agency and agent apps

**Audience: whoever builds `vendor-dash`, `agency-dash` or `agent_app`.** One document
rather than three, because the rules are shared and three copies drift — which is the
failure this whole contract exists to prevent. Find your app's section; the rules above it
apply to all three.

Backend readers want `scripts/test/test-notification-deeplinks.ts`, which pins the
vocabulary below against the catalogues.

---

## The decision this document records

Every notification your app receives can carry a button. The backend does **not** know your
routes and will never try to: it sends a short **label** like `shipments/665f…`, and your
app decides which of its own screens that means.

That was chosen on 2026-09-07 over two alternatives, and knowing why saves re-arguing it:

- **The backend owning your real routes** was rejected because it silently breaks the next
  time any of the three apps renames a page — the backend cannot see your route tree and no
  test can span the repositories. It also contradicts what vendor-dash already does.
- **Dropping the button on email/WhatsApp/Telegram** was the safe fallback and was not
  needed once translation was chosen.

**This is already how all three of you work in-app.** The agent app translates through
`resolveDeepLink`; agency-dash prefixes `/dashboard/`; vendor-dash resolves from
`aggregateType` + `aggregateId` and ignores the path entirely. Nothing below asks you to
change that. What it does is (a) write the vocabulary down so it stops being folklore, and
(b) name the one case that is genuinely broken today.

---

## What arrives, and where

The same label reaches you three ways. **All three carry it; only the third is a URL.**

| | Shape | Where |
|---|---|---|
| **In-app inbox** | `action: { label, path, url? }` or `null` | `GET /api/{vendor,agency,agent}/notifications` |
| **Push (FCM)** | `data: { type, aggregateType, aggregateId, path? }` | your FCM handler |
| **Email · WhatsApp · Telegram** | an absolute URL: `{APP_URL}/{path}` | the message button |

`path` is the label. `label` is the button's text, already translated into the recipient's
language — **render it, never write your own**, or a French agency reads an English button.

`url` is `path` glued onto `VENDOR_APP_URL` / `AGENCY_APP_URL` / `AGENT_APP_URL`. It exists
for the channels that can only carry a link. **Route on `path` wherever you have it**; `url`
is the fallback for the one case where you do not.

---

## The rules the backend guarantees

These hold for every value in every table below, and `test:notification-deeplinks` fails if
one stops holding:

1. **No leading or trailing slash.** You are joining this onto a base; a slash here gives
   you `//orders` or `/dashboard//orders`, which resolve to something else.
2. **No route prefix and no locale.** These are labels, not addresses. `dashboard/`,
   `shop/` and `/fr/` are yours to add.
3. **At most one id, always last.** So a `switch` on the literal segments is enough and
   nobody needs a parser.
4. **The set is closed and versioned by a test.** Adding, renaming or removing one is a
   change to `test:notification-deeplinks`, to this document, and to your translator — in
   the same pull request. If somebody skips that, the test fails here before it reaches you.
5. **An absent `action` is a real state, not a missing value.** Render no button. Do not
   invent a destination — see `shipment.reassigned_away` below for one that means exactly
   what it says.

⚠ **Treat an unknown `path` as "no button", never as an error.** That is what makes it safe
for the backend to add one before you ship a case for it — the worst outcome is a
notification with no button, in an app that has not been rebuilt yet.

---

## Vendor — `vendor-dash`

`VENDOR_APP_URL` · 8 labels.

| `path` | Sent by | Carries |
|---|---|---|
| `orders/{{orderId}}` | `order.created`, `order.cancelled`, `payment.received.partial`, `payment.received.full`, `shipment.rejected` | an Order id |
| `bookings/{{bookingId}}` | `booking.created`, `booking.cancelled` | a Booking id |
| `products/{{productId}}` | `storage.depot_changed`, `storage.product_suspended`, `storage.product_unsuspended` | a Product id |
| `agency-connections/{{connectionId}}` | `connection.request_received`, `connection.approved`, `connection.rejected`, `connection.reapproval_needed` | a Connection id |
| `stock-requests/{{requestId}}` | `storage.stock_request.{received,approved,rejected}` | a StockRequest id |
| `tickets/{{ticketId}}` | `payout.requested`, `payout.paid`, `payout.rejected` | ⚠ a **Ticket** id — a payout is tracked as a support ticket, and `aggregateId` on these is the **PayoutRequest** id, which is a different thing |
| `plans` | `plan.expiring`, `plan.expired` | — |
| `settings/storage` | `storage.alert` | — |

**Your app currently ignores `path`** and routes from `aggregateType` + `aggregateId`
instead, which is why your in-app inbox works. That is a legitimate way to satisfy this
contract and nothing here asks you to abandon it — the labels above are simply what you
would switch on if you ever preferred to.

⚠ **The one row where the two sources disagree is `tickets/{{ticketId}}`.** The path carries
the ticket; `aggregateId` carries the payout request. Your `notificationRoute` already
routes payouts to the payout screen rather than building a ticket link, with a comment
saying so — that is correct, and the table above is why.

---

## Agency — `agency-dash`

`AGENCY_APP_URL` · 8 labels.

| `path` | Sent by | Carries |
|---|---|---|
| `shipments/{{shipmentId}}` | `shipment.assigned`, `shipment.offer.accepted`, `shipment.assignment.unfilled`, `shipment.agent.{picked_up,delivered,failed,returned}` | a Shipment id |
| `agents/{{contractId}}` | the eight `agent_contract.*` situations | ⚠ a **contract** id, not an agent id |
| `vendor-connections/{{connectionId}}` | `connection.request_received`, `connection.approved`, `connection.rejected`, `connection.reapproval_needed` | a Connection id |
| `cod/deposits/{{depositId}}` | `cod.deposit.declared`, `cod.deposit.direct_to_platform` | an AgentDeposit id |
| `stock-requests/{{requestId}}` | `storage.stock_request.{received,approved,rejected}` | a StockRequest id |
| `tickets/{{ticketId}}` | `payout.requested`, `payout.paid`, `payout.rejected` | a Ticket id |
| `plans` | `plan.expiring`, `plan.expired`, `shipment.cap.exceeded` | — |
| `settings/storage` | `storage.alert` | — |

**Your `dashboardRoute()` already does the translation** — it prefixes `/dashboard/` — and
you built alias routes for `plans`, `settings/storage` and `stock-requests/:requestId`
naming this contract in their comments. Four of the eight resolve today.

**Four do not, and this table is the list of what to add:**

- `cod/deposits/:id` — there is no `cod` route; hand-overs live under `cash/:tab`.
- `shipments/:id` — `shipments` exists without an `:id` child.
- `tickets/:id` — same shape.
- `vendor-connections/:id` — the screen is `vendors/:tab`.

⚠ **`agents/{{contractId}}` works by a happy accident worth making deliberate.** It lands on
`agents/:tab`, and `Agents.tsx` sniffs a contract id in the tab slot. That is fine and was
written on purpose — just be aware the id is a *contract*, so a future `agents/:agentId`
route would silently capture it.

---

## Agent — `agent_app` (Flutter)

`AGENT_APP_URL` · 5 labels.

| `path` | Sent by | Carries |
|---|---|---|
| `offers/{{offerId}}` | `shipment.offer.received`, `shipment.offer.reminder`, `shipment.offer.expired` | an Offer id |
| `cod/deposits/{{depositId}}` | `cod.deposit.recorded`, `cod.deposit.confirmed`, `cod.deposit.rejected` | an AgentDeposit id |
| `memberships/{{contractId}}` | the eight `agent_contract.*` situations | ⚠ a **contract** id — see below |
| `plans` | `plan.expiring`, `plan.expired` | — |
| `settings/storage` | `storage.alert` | — |
| *(no button)* | `shipment.reassigned_away` | — |

**Your app is the reference implementation of this contract.** `resolveDeepLink` in
`lib/core/router/deep_links.dart` handles all five, documents them in a table, returns null
for anything unknown and falls back to the inbox. Nothing to change.

⚠ **`memberships` is the pre-refactor word for a contract**, and it is kept deliberately.
The backend calls it a contract everywhere else (`AgentAgencyContract`, `contractId`,
`agent_contract.*`); renaming the path would break a shipped client to tidy a string no
agent ever sees. Your resolver's comment already says this. The test asserts it stays.

⚠ **`shipment.reassigned_away` sends no button on purpose.** The shipment is no longer that
agent's, and every scoped read 404s once `agent_id` is cleared — so a button would lead to
an error page. Your null-to-inbox fallback is the correct handling.

---

## Emailed buttons — decided 2026-09-08, and both halves are yours

Everything above concerns the in-app inbox and push, which work. The **email, WhatsApp and
Telegram** buttons are a different matter, and today they do not land correctly for any of
the three of you.

> **✅ The owner's decision (2026-09-08): the buttons STAY on every channel.**
> The backend keeps sending them, unchanged, on email, WhatsApp and Telegram. Nothing on the
> backend side is being removed or gated. **Both fixes below are front-end side**, and each
> is the owning team's to schedule and to implement however they see fit — what follows is a
> description of the problem and a suggestion, not a specification.

Those channels can only carry a URL, so the button is `{APP_URL}/{path}` — for example
`https://agency.wi-mall.com/shipments/665f…`. Two problems:

**Web dashboards** — that URL has no `/dashboard` in it, and both SPAs answer an unmatched
path with `Navigate to="/dashboard"`. So the recipient lands on the dashboard home with no
explanation. Not a 404 — a silent wrong page, which is worse.

*A suggestion, not a requirement — you own this and may solve it any way you prefer.* The
smallest change we can see is to reuse the translation you already do for push, one layer
up: in the top-level catch-all route, try your existing resolver on the incoming path before
falling back to `/dashboard`. That keeps one vocabulary and one resolver rather than two.

If you would rather handle it differently — a dedicated `/link/:path` entry route, a
server-side redirect, or anything else — that is entirely fine. **The backend does not care
how you route it**, and nothing here needs to be agreed with us before you build it. The
only thing worth telling us is if you decide *not* to fix it, so the owner can weigh that
against leaving the buttons switched on.

**The agent app** — it cannot receive one at all. It is a Flutter mobile app with **no App
Links and no custom scheme** in its `AndroidManifest.xml` — measured 2026-09-08: **zero**
`<data android:scheme…>` entries, against **two each** for vendor-dash (`wivendor://` plus an
`autoVerify` App Link on `vendor.wi-mall.com`) and agency-dash (`wiagency://` plus the same
on its own host). Its own `api-doc/agent/push-notifications.md` already says
`url` is *"Web-oriented; ignore it on mobile"*, which is correct advice and also means the
emailed button has nowhere to go.

> **✅ Decided (2026-09-08): configure App Links for the agent app. The buttons stay.**
> This was put to the platform owner as a choice between configuring App Links and dropping
> the button from the agent's external channels, and the answer was **configure**. So this is
> now an agent-app task, not an open question.

*A suggestion, not a requirement.* What is missing is an `<intent-filter>` in
`android/app/src/main/AndroidManifest.xml` carrying a `<data android:scheme…>` entry — a
custom scheme (`wiagent://…`), an `autoVerify` App Link on the agent's host, or both, which
is the shape vendor-dash and agency-dash already use. Once the app can be opened by a link,
the `path` you receive is the same vocabulary as the tables above, so your existing
`resolveDeepLink` should be able to take it unchanged.

⚠ **One thing to know before you start:** an `autoVerify` App Link needs a
`assetlinks.json` published on the agent host, and Android verifies it at install time — so
this is a deployment step as well as a manifest change. A custom scheme has no such
requirement and is the cheaper first move if you want the button working sooner.

### Why nobody is complaining

All three notification stacks default **email, Telegram and WhatsApp to `false`**, and
nothing seeds them. Someone has to switch a channel on deliberately before they ever see one
of these. (The customer stack is different — its arrival channel is seeded at registration,
which is why its equivalent bug was live and had to be fixed the same week.)

---

## If you need a new deep link

Ask, rather than inventing one — the vocabulary is a closed set and the backend test refuses
anything not in it.

Adding one is: the button in the catalogue, the literal in
`scripts/test/test-notification-deeplinks.ts`, a row in this document, and a case in your
translator. The first three are the backend's and land together; yours can follow whenever,
because an unknown `path` renders no button rather than an error.
