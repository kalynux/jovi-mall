# Where notification buttons point — and the pages behind them

**Verified against source on 2026-09-08** — the backend half only: the pay-link session
projection and its `paidFor` object, the four `state` values and their status-before-expiry
ordering, the `PAYMENT_LINK_NOT_FOUND` conflation, and the `sk_`/`rk_` publishable-key refusal,
against `jovi-mall/src/modules/payments/domain/pay-link.ts` and
`src/modules/payments/services/pay-link.service.ts`. The **route addresses** on this page are
facts about `frontend/landing`, which this backend cannot check — that is the point of the page.

**Audience: whoever builds `frontend/landing`.** Backend readers want
`src/modules/notifications/catalog/customer-notification-catalog.ts`, whose header
carries the rules; this page is the cross-repository half.

Every customer notification — email, WhatsApp, Telegram, and the inbox row inside the
shop — can carry one action button. The label is written in the customer's language on
this side; the **address** is a route in `frontend/landing`, and **nothing checks that
the route exists.** There is no shared package, no build step that spans the two
repositories, and no test that can reach across. A wrong address fails nowhere: it is a
404 in one customer's browser, and the only person who sees it is the person the message
was for.

That is not hypothetical. Every one of these was wrong from the day it was written until
**2026-09-07** — the tails said `orders/{{orderId}}`, `support/{{ticketId}}`,
`bookings/{{bookingId}}`, and the shop serves those pages under `/shop/account/`. All
22 buttons, in every language, on every channel, for as long as they have existed.

> ## ✅ CLOSED 2026-09-07 — the three owed pages are built
>
> The catalogue was corrected on the backend, and the storefront then built the three
> routes it named that did not yet exist. **All six addresses below now resolve**, on
> both the web and the packaged app.
>
> | # | Page | Outcome |
> |---|---|---|
> | 1 | `/shop/account/orders/detail/:orderId` | **Built.** `detail` kept as specified — see § 1 |
> | 2 | `.../:orderId/tracking` | **Built**, on the existing live-tracking stack |
> | 3 | `/pay/:token` | **Built**, top level, no session, real Stripe Payment Element |
>
> Two things came back the other way and are at the bottom of this page: the storefront
> now resolves **both** vintages of `action.path`, so messages sent before the fix are no
> longer dead links; and the pay session does not say **what** is being paid for.

---

## The six addresses

`{STOREFRONT_URL}` + the locale prefix + the path below. **22 situations, 6 distinct
addresses.**

| Button | Address (after the locale prefix) | Situations | Page |
|---|---|---|---|
| View booking | `/shop/account/bookings/:bookingId` | 9 | ✅ |
| Pay balance | `/shop/account/bookings/:bookingId/balance` | 1 | ✅ |
| View request | `/shop/account/support/:ticketId` | 3 | ✅ |
| View order | `/shop/account/orders/detail/:orderId` | 5 | ✅ built 2026-09-07 |
| Track delivery | `/shop/account/orders/detail/:orderId/tracking` | 3 | ✅ built 2026-09-07 |
| Pay now | `/pay/:token` | 1 | ✅ built 2026-09-07 |

The bot's "see the rest of your orders" links use the same tree and are listed in
`bot-surface.md`; those all point at pages that exist.

---

## ✅ 1 · The single-order page — `/shop/account/orders/detail/:orderId`

**Why the existing order page could not serve this.** A basket containing items from three
shops becomes **three orders**, one per shop, sharing one `cartId`. The shop's
`/shop/account/orders/[cartId]` shows that whole checkout group. A notification is about
**one** of those orders — *"your parcel from Shop B has shipped"* — and carries that
order's id. Handing an order id to the group page looks up a group that does not exist.

The alternative was to send the group id instead and land on the page that already
exists. That was offered and declined: a message about one parcel should land on that
parcel. **The storefront built the page rather than taking the compromise.**

**Data:** `GET /api/customer/orders/:id` — already served, already scoped to the signed-in
customer, no backend change needed. It returns the order with its items, status, payment
state and (per ADR-A06) the carrying agent's partial name and photo while they hold it.

**Note the segment `detail`. It was kept exactly as specified**, and the reason held up
under the App Router: `orders/[cartId]` is a dynamic segment sitting at that same depth,
and a static sibling is what stops it swallowing the id. Without `detail`, every
single-order link would silently render the group screen against an id it cannot resolve —
which is the original bug wearing a different hat.

**Where it lives.** The screen is `components/shop/account/OrderDetail.tsx`, and its body
is the same `VendorOrderCard` the group screen renders, imported rather than rewritten —
so a customer arriving from a push sees the card they already know from their order
history, and there is no second rendering of an order to drift out of step with the first.

**Paying is still a group action.** An unpaid single order links across to the group
screen rather than growing a pay sheet of its own: `initiatePayment` is called with
`cartId`, a basket is charged once, and `initiatePaymentForCart` already filters to the
still-payable orders. Nothing here uses the `orderId` form of `initiate`.

## ✅ 2 · The tracking page — `/shop/account/orders/detail/:orderId/tracking`

Nested under the single-order page above, because a customer tracks **one parcel**; a
checkout group can be several parcels going to several places on different days.

**Data, in two parts:**

- **The parcels:** `GET /api/customer/orders/:orderId/shipments` — this backend.
- **The live position:** a WebSocket to **geo-tracker**, a separate service, opened with
  *the same access token* this API uses. The protocol is geo-tracker's
  `api-doc/tracking-websocket.md`; the customer-facing rules are
  `jovi-mall/api-doc/tracking/live-tracking.md`.

⚠ **Read the `permission_revoked` table in that second file before writing the socket
handler.** The frame carries a `reason` and only **one** of its three values means the
delivery finished. Acting on the other two tells a customer their parcel arrived because
their token aged out — which is exactly what shipped once already, and had to be fixed on
both sides.

**That handler already existed and was reused, not rewritten.**
`components/shop/account/DeliveryTracking.tsx` has honoured the three-value rule since
2026-08-19 — it reports an outcome from `shipment_completed` alone and stays silent on
`authorization_expired` and `authorization_unavailable`. The tracking page mounts the same
`Shipments` block the order card mounts, so there is one socket implementation on this
side and one place for that rule to be got right.

The one thing the page adds is an empty state: `Shipments` renders nothing when an order
has no parcels yet, which is correct inside an order card and is a blank screen on a page
that is nothing else. A shopper who taps "Track delivery" before pickup is told the seller
is still preparing it.

## ✅ 3 · The payment page — `/pay/:token`

**It was already live and already broken.** The bot's `payment_create_pay_link` tool has
been minting these links and handing them to customers in chat; the address was right and
the page was missing. It exists now.

**It works with NO session, and that is the entire point of the feature.** A mother
orders; her son gets the link and pays. He has no account. Every other page in this list
lives under `/shop/account`, which the middleware gates on a session — build this one
there and you lock out the only person it is for. It is at the **top level**, beside
`(auth)` and `(marketing)`, and `middleware.ts` needed no change: the gate is a prefix
list and `/pay` is not on it.

**Data:** `GET /api/payments/session/:token` — unauthenticated by design, an explicit
projection (never the transaction document). It returns the amount, the currency, what is
being paid for, and — only while the payment is still open — the gateway's client secret.

Three behaviours to honour, and how each is met:

- **The token is opaque and expiring**, deliberately not the transaction id. Do not
  build any URL in this flow out of an id. — *Nothing in the flow composes a URL from an
  id; `payPath()` takes the minted token and nothing else.*
- **A settled payment answers `settled`, not `expired`.** Render "this is already paid"
  and nothing else. Showing an expiry invites a second payment. — *The page renders the
  server's `state` verbatim and never re-derives it from `expiresAt`. `expiresAt` is shown
  only as a wall-clock time on a payable session, and is not a countdown.*
- **A fresh mint replaces the previous link.** An old link going dead is correct
  behaviour, not a bug. — *`PAYMENT_LINK_NOT_FOUND` renders "ask for a new one", never
  "something went wrong". It is matched on the error **code**, so an unrelated 404 on the
  way in does not tell a reader their good link is dead.*

**Stripe.** The card form is a real `<PaymentElement>`; `@stripe/stripe-js` and
`@stripe/react-stripe-js` were added for it. `session.publishableKey` is preferred over
the storefront's own `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, since the server's key is read
off the same account that minted the client secret. Both being null is a real state — a
mobile-money-only deployment, or the backend refusing a key that turned out to be an
`sk_` — and it renders as "cards aren't available right now" rather than a broken form.

⚠ **`amount` and `chargedAmount` are both shown, and they are formatted differently.**
`amount` is the catalogue price in XAF, which has no minor unit; `chargedAmount` arrives
from `fromMinorUnit()` with its decimals intact, so it is formatted through
`Intl.NumberFormat` rather than the storefront's `formatMoney`, which rounds. Rounding
the charge would print a figure that does not match the customer's card statement, on the
one line whose only job is to match it.

---

## Rules that apply to all of them

### The locale prefix is real, and getting it wrong fails silently

`next-intl` runs `localePrefix: "as-needed"`: English owns the bare tree (`/shop/…`) and
the other four are prefixed (`/fr/shop/…`). Every URL this backend builds now carries the
customer's language. A wrong prefix does **not** 404 — middleware rewrites it onto the
English tree — so the customer gets a page in a language they were not written to, and
nothing anywhere reports a fault.

The five must stay identical on both sides: `en · fr · pt · es · ar`
(`LOCALE_CODES` there, `SUPPORTED_LANGUAGES` here). Two hand-maintained lists in two
repositories with nothing comparing them — a language added on one side only produces
links into a tree that does not exist.

### Every page needs its app twin

Each of these exists **twice** in the shop, and a new one that skips the second half works
on the website and silently fails in the phone app:

| | web | app (static export) |
|---|---|---|
| order group | `/shop/account/orders/[cartId]` | `/shop/account/order?id=` |
| **one order** | `/shop/account/orders/detail/[orderId]` | `/shop/account/order/detail?id=` |
| **tracking** | `/shop/account/orders/detail/[orderId]/tracking` | `/shop/account/order/tracking?id=` |
| booking | `/shop/account/bookings/[bookingId]` | `/shop/account/booking?id=` |
| balance | `/shop/account/bookings/[bookingId]/balance` | `/shop/account/booking/balance?id=` |
| support thread | `/shop/account/support/[ticketId]` | `/shop/account/ticket?id=` |
| **pay link** | `/pay/[token]` | **none — see below** |

The static export has no server to resolve a path segment against, so the app addresses
the same screen by query string. The screen itself lives in a shared component and both
routes are thin wrappers.

⚠ **The two new order rows are siblings of `orders/[cartId]`, not children of it**, so
excluding that tree from the app build says nothing about them. `build-native.mjs` needed
its own entry for `orders/detail` and the export build fails outright without it.

⚠ **`orders/detail?id=` takes an `orderId`; `order?id=` one level up takes a `cartId`.**
The two ids are indistinguishable by eye and resolve to nothing in each other's screen.

**`/pay/[token]` deliberately has no twin.** Unlike the six above it is not something the
app has to be able to open: a pay link is a URL sent into a chat and opened in whatever
browser the recipient tapped it from — who is very often not the account holder and has no
app installed at all. That is the feature. It is dropped from the app build the way
`(marketing)` is dropped.

**The notification links target the web addresses.** How a deep link opens the installed
app is a Capacitor concern and is out of scope here.

### The address is a promise, not a detail

A link that has been sent cannot be changed. Renaming one of these routes silently breaks
every message already sitting in a customer's inbox — so a rename is a **two-repository
change in one go**: the route here, the tail in
`customer-notification-catalog.ts`, and its assertion in `test:customer-notifications`.

---

## Two things back to the backend

### 1 · The storefront resolves BOTH vintages of `action.path` — old inbox rows are alive again

`action.path` is `button.urlSuffix` verbatim, so the 2026-09-07 fix changed the shape of
every path the storefront receives:

```
old (before 2026-09-07)         new (what the catalogue writes now)
─────────────────────────       ────────────────────────────────────
orders/<id>                     shop/account/orders/detail/<id>
orders/<id>/tracking            shop/account/orders/detail/<id>/tracking
bookings/<id>                   shop/account/bookings/<id>
bookings/<id>/pay-balance       shop/account/bookings/<id>/balance
support/<id>                    shop/account/support/<id>
—                               pay/<token>
```

`lib/shop/notification-routing.ts` matches **both**, and both resolve to the same screens.
That matters because **the inbox is durable**: rows written before the fix are still sitting
in customers' notification lists and are still tappable, and so are the emails and chat
messages that carried them. They are no longer dead ends.

Two consequences worth knowing on your side:

- **Nothing needs backfilling.** There is no reason to rewrite stored `action.path`
  values, and doing so would be the riskier of the two options.
- **`bookings/<id>/pay-balance` is understood but is not an address.** It is the old tail
  only; the live one is `.../balance`. Please do not reintroduce the old spelling on the
  strength of it being accepted.

The `orderId`/`cartId` lookup that used to bridge the gap is **gone**. Resolving a
notification is now pure string work with no API call, which is why the inbox rows are
ordinary links again rather than buttons with a spinner.

### 2 · The pay session does not say what is being paid for

This page's description of `GET /api/payments/session/:token` says it returns *"the
amount, the currency, **what is being paid for**, and … the client secret."* The shipped
projection (`PayLinkSession` in `payments/services/pay-link.service.ts`) carries
`transactionId`, `state`, `gateway`, `amount`, `currency`, `chargedAmount`,
`chargedCurrency`, `clientSecret`, `publishableKey`, `expiresAt` — and **nothing that
names the order**.

So the page currently reads, in full: *"Amount due — 24 000 FCFA."* The person paying is
by design often **not** the person who ordered, which makes this the one payment screen in
the platform where the payer has no other way to know what they are paying for. A son
handed a link by his mother sees a number and a card field.

Not a blocker — the page ships as it is — but a line or two would close it, and it is
additive:

```jsonc
{
  "…": "…",
  "description": "3 items from Boutique Ndogbong",   // or an order number
  "orderNumbers": ["ORD-2026-000046"]                 // optional
}
```

⚠ **Whatever is added has to survive being read by a stranger**, since that is who holds
the link. An order number and a seller name are safe; a delivery address, a customer name
or a line-item list is not, and the projection should stay explicit rather than becoming a
spread — that discipline is already written down where it is defined.

#### ✅ Answered 2026-09-07 — `paidFor`, and one change from the sketch above

`GET /api/payments/session/:token` now carries a `paidFor` object. Contract and reasoning:
`api-doc/payments/README.md` § *"`paidFor` — and why it is fields rather than a sentence"*.

```jsonc
"paidFor": {
  "kind": "order",                  // order | booking
  "reference": "ORD-2026-000046",   // the handle the payer can match; null on a legacy row
  "orderCount": 1,                  // >1 when one payment settles a multi-vendor basket
  "itemCount": 3,                   // null for a booking
  "sellers": ["Boutique Ndogbong"]  // ⚠ always [] for a booking
}
```

**The one change: no rendered `description`.** Structured fields instead, and the page
composes the sentence. The reason is specific to this screen rather than a general
preference — **it is the one reader this backend cannot localise for.** Every other page is
served to somebody with an account and a `preferred_language`; the holder of a pay link has
neither and may not exist in the database at all. A sentence composed server-side would
arrive in English on a page otherwise translated into five languages, and it would be
English *in the line that says what the money is for*. You know the reader's locale — it is
in the URL they opened. So: facts from here, sentence from there.

`orderNumbers` as an array became `reference` + `orderCount` for the same reason. A
multi-vendor basket is one payment settling several orders, and the page can say
*"order ORD-… and 2 others"* in the reader's language from those two fields, where an array
would have forced a join somewhere.

⚠ **`sellers` is empty for a booking, deliberately, and it is not an oversight to fix.** A
shop's name is already a public storefront page, so naming it tells a stranger only that
somebody bought something. A *service provider's* name is frequently the sensitive fact
itself — a clinic, a lawyer — and this backend cannot tell which vendors are which. A
booking travels as its reference and its amount; the payer confirms with whoever sent them
the link. Please do not fill the gap client-side from another endpoint.

Your privacy constraint was taken as written and is now enforced rather than documented:
the buyer (name, email, phone, delivery address), the line items (titles, SKUs, per-item
prices) and the service on a booking are each asserted absent by source scan in
`test:payments`, because the failure mode is a field *appearing* and no behavioural test
can be written against a field that does not exist yet.

### 3 · Two backend docs still say the pay page is missing

Now stale, and both in the direction that costs someone an afternoon:

- `api-doc/n8n/bot-surface.md` — *"`/pay/:token` is not built — so that tool hands a live
  customer a dead link today."*
- `api-doc/n8n/BACKEND-GAPS.md` — *"Option 1 was taken, minus the page."*

**✅ Both corrected 2026-09-07.** Thank you for catching them — the first one was written
here the day before, which is roughly how long that class of claim takes to go stale.
`BACKEND-GAPS.md` now says why it changed rather than quietly reading as though it was
always true, since the point of that entry is the decision trail.
