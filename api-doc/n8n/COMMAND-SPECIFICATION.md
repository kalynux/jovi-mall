# Customer command specification — WhatsApp and Telegram

**Status:** design only, 2026-08-24. Machine-readable twin: [`tools/commands.json`](./tools/commands.json).
**Read first:** [ARCHITECTURE.md](./ARCHITECTURE.md) — this page assumes its pipeline, its identity model and its four surfaces.

Thirty-four commands. Three are already live and must not change. The rest are new, and every one of them exists because typing it is faster or less ambiguous than saying it in words — where that is not true, the AI agent handles the intent and no command was created.

---

## Part I — the grammar

### The form

```
/<command>[@botname] [<arg1> [<arg2> …]]
/<command>:<arg1>                          ← equivalent, first argument only
```

`/support:vendor` and `/support vendor` are the same thing. The colon form is kept because it is what the original proposal used and what any published material will show; the space form is what most people type on a phone.

### The rules

| Rule | Detail |
|---|---|
| **Case** | Insensitive. `/Cart`, `/CART`, `/cart` are one command |
| **Diacritics** | Insensitive on the command name — `/categorie` matches `/catégorie`. Arguments keep their accents |
| **`@botname`** | Stripped. Telegram appends it in group chats |
| **Whitespace** | Collapsed. A trailing `:` with no argument is the bare command |
| **Quoting** | `/search "red dress"` is one argument. Unquoted trailing text is joined for free-text commands and split for identifier commands |
| **Not a command** | Any message not starting with `/` goes to the AI agent. Always |

### ⚠ Canonical names are underscore-safe, and this is not cosmetic

Telegram's `bot_command` entity accepts only `[a-zA-Z0-9_]`, 1–32 characters. Two consequences, both live today:

- **`/reset-password` is parsed by Telegram as the command `/reset`**, with `-password` as trailing text. It works only because the automation layer reads the raw message text rather than the entity. A future implementation that trusts the entity breaks a command that is in production.
- **It cannot be registered with BotFather**, so it never autocompletes and never appears in the command menu.

So: canonical names are `[a-z][a-z0-9_]*`, every hyphenated form ever published is kept as an alias, and **the parser always reads raw text**. Register the canonical names with BotFather; the aliases still work when typed.

### Unknown commands

Do not guess and do not execute. Offer the closest canonical name within an edit distance of 2, otherwise `/help`.

⚠ **An unknown command is never forwarded to the AI agent as prose.** A mistyped `/cancle` must not become a cancellation because a model read it charitably.

### Resolution order

Five ways a message becomes an intent, tried in this order:

1. **Canonical name** — exact.
2. **Alias** — exact.
3. **Interactive payload** — a button or list row *the bot itself sent*. It carries its own intent and arguments and never re-enters the parser.
4. **A live flow's expected input** — an OTP, a chosen address, a Yes. A flow in progress consumes the message before anything else interprets it.
5. **AI agent** — free-text classification.

---

## Part II — conventions that apply to every command

Stated once here so no command block repeats them.

**Authentication.** Every command runs under the automation layer's credentials, never a customer's. Commands marked *identity* require the sender to resolve to a customer (ARCHITECTURE §3.3); the rest work for anyone. No command anywhere accepts a customer id, a user id or a token as an argument.

**Errors.** Handled by [`tools/errors.json`](./tools/errors.json), keyed on `error.code` then `error.category`. Only failures with command-specific behaviour are listed per command below.

**Confirmation.** `false` = execute. `true` = two-phase, echoing the resolved subject, executing the *stored* call (ARCHITECTURE §5). `out_of_band` = never executed in chat.

**Missing arguments** are asked for, never invented. Where a command can resolve an argument from context, its block says so and names the policy.

**Language.** Every reply is in `customer.preferences.language` — one of `en · fr · pt · es · ar`. Product text is never translated; the product carries `contentLanguage` saying which language the seller wrote in.

**Rendering.** WhatsApp: ≤ 3 buttons (titles ≤ 20 chars), or a list of ≤ 10 rows (titles ≤ 24, descriptions ≤ 72), body ≤ 1024. Telegram: inline keyboard, 2 per row. Any credential-bearing reply sets `preview_url: false` / `disable_web_page_preview: true`.

**Sender-state gate.**

| State | Reaches |
|---|---|
| Anonymous | `/start` `/help` `/search` `/categories` `/category` `/product` `/store` `/similar` `/reviews` `/login` `/reset-password` `/connect` |
| Non-customer (vendor, agency, agent) | The same set. **Nothing customer-scoped.** `/reset-password` is the point of their being here |
| Customer | Everything |

---

## Part III — the commands

### Index

**Session** [`/start`](#start) · [`/help`](#help) · [`/login`](#login) · [`/reset-password`](#reset-password) · [`/connect`](#connect)
**Discovery** [`/search`](#search) · [`/categories`](#categories) · [`/category`](#category) · [`/product`](#product) · [`/store`](#store) · [`/similar`](#similar) · [`/reviews`](#reviews)
**Buying** [`/cart`](#cart) · [`/add-to-cart`](#add-to-cart) · [`/checkout`](#checkout) · [`/buy`](#buy) · [`/pay`](#pay)
**Orders** [`/orders`](#orders) · [`/order`](#order) · [`/track`](#track) · [`/code`](#code) · [`/confirm`](#confirm) · [`/cancel`](#cancel)
**Account** [`/address`](#address) · [`/language`](#language) · [`/profile`](#profile) · [`/notifications`](#notifications) · [`/stop`](#stop)
**Help** [`/support`](#support) · [`/ticket`](#ticket)
**More** [`/saved`](#saved) · [`/downloads`](#downloads) · [`/bookings`](#bookings) · [`/review`](#review)

---

<a name="start"></a>
## `/start`

| | |
|---|---|
| **Syntax** | `/start` |
| **Aliases** | — |
| **Purpose** | First contact. Establish who this is, and offer an account if they have none |
| **Arguments** | none |
| **Identity** | not required — this is what establishes it |
| **Tools** | `identity_resolve_sender` → `identity_register_customer` |
| **Flow** | `registration` |
| **Confirmation** | ✅ — creating an account is a durable act |
| **Status** | **GAP-002** |

**Behaviour.** Resolve the sender. Known customer → a short welcome naming what they can do, plus anything in flight (an unpaid order, a parcel out for delivery). Known non-customer → say the account is a business account and offer `/reset-password`. Unknown → offer to create an account.

**WhatsApp.** There is no `/start` convention — Meta users just write. **Any first message from an unknown sender enters the same flow**, and their original message is answered after registration rather than discarded.

**Telegram.** The conventional first command; Telegram sends it automatically when the chat is opened. Register it with BotFather. A `chat_id` maps to no phone number, so registration cannot proceed until the contact is shared — see [`/login`](#login) for the keyboard.

**Example — Telegram, unknown chat**
```
User:  /start
Bot:   Welcome to Jovi Mall. To set up your account, Telegram needs to
       confirm your phone number.
       [ Share my phone number ]
User:  (taps; Telegram sends a verified contact)
Bot:   Thanks — I don't have an account for +237 6•• ••• 456 yet.
       Shall I create one? You can shop straight away.
       [ Yes, create it ]  [ Not now ]
```

---

<a name="help"></a>
## `/help`

| | |
|---|---|
| **Syntax** | `/help [<topic>]` |
| **Aliases** | `/aide` `/menu` `/ayuda` `/ajuda` `/commands` `/?` |
| **Purpose** | What the bot can do — narrowed to what this sender can actually do |
| **Identity** | not required |
| **Tools** | `identity_resolve_sender` |
| **Confirmation** | false |

**Behaviour.** The command list is filtered by sender state, so an anonymous sender is never shown `/track`. With a topic, explain that one area.

**WhatsApp.** An interactive list of ≤ 10 rows grouped by area, never a wall of text. **Telegram.** Inline keyboard; keep the BotFather list in step with `commands.json`.

---

<a name="login"></a>
## `/login`  🔒 LIVE

| | |
|---|---|
| **Syntax** | `/login` |
| **Aliases** | `/signin` `/connexion` |
| **Purpose** | Sign in on the website without a password |
| **Identity** | not required — resolves it |
| **Customer role** | ✅ required |
| **Tools** | `auth_send_login_link` (CommandBus `login`) |
| **Confirmation** | false |
| **Status** | **live** — mapped in n8n, handoff item 1 |

**Behaviour.** Mints a magic link and an 8-character code, both for one session, both good for 10 minutes; spending either kills the other. A second `/login` revokes the first pair, so one identity never holds more than one live credential.

⚠ **The reply carries no `code` and no `token` field.** The credentials are inside `message` only, because a webhook response body is logged in more places than a chat message. **Relay `message` verbatim, store none of it, and never let the model see it.**

⚠ **A customer who signs in this way has also connected the channel**, so their notifications start working with no separate `/connect`.

**Refusals** arrive as HTTP 200 with `success: false` and a `message` to relay: no matching account · the account holds no customer role · the account is not active · this Telegram chat belongs to another account. All four are relayed verbatim.

**WhatsApp.** The sender id *is* the phone number, so it resolves in one turn. `preview_url: false`.

**Telegram.** A first-time chat is anonymous. The result carries `requestContact: true` → attach the "Share my phone number" keyboard. The contact comes back and is posted as `login_contact`; **the user does not send `/login` again**. Every later `/login` from that chat is instant.

⚠ **Only the sender's own contact is accepted.** A Telegram user can share somebody else's card and it arrives in the same shape; without the `user_id` check, forwarding a victim's contact is a one-message account takeover. Forward the **whole** contact object including `user_id`. On a `400 MAGIC_CONTACT_UNVERIFIED`, relay `error.message` — that is how the refusal reaches the user, and its wording does not read as an accusation because the ordinary way to hit it is tapping the wrong contact.

---

<a name="reset-password"></a>
## `/reset-password`  🔒 LIVE

| | |
|---|---|
| **Syntax** | `/reset-password` |
| **Canonical** | `reset_password` — **underscore**, both in the CommandBus and for BotFather |
| **Aliases** | `/password` `/motdepasse` `/mot-de-passe` `/forgot` |
| **Purpose** | A link to choose a new password |
| **Identity** | not required |
| **Customer role** | ❌ **not** required — this serves every role |
| **Tools** | `auth_send_password_reset_link` (CommandBus `reset_password`) |
| **Confirmation** | `out_of_band` |
| **Status** | **live** — handoff item 2 |

**Behaviour.** The same link `POST /auth/forgot-password` sends by email and WhatsApp: same token, 30 minutes, single use. Redeeming it stamps `password_changed_at`, which revokes every other live session on the account.

⚠ **This is the only self-service recovery a vendor, agency or agent has from a chat**, and the only route by which a passwordless customer acquires a real password. A password belongs to the account, not to a role.

⚠ **Never collect, verify, suggest or repeat a password in chat.** Never confirm identity by asking the customer questions. This command is the entire password surface.

**Telegram.** Two traps, both live:
1. The user types a hyphen; the command name has an underscore.
2. Telegram's entity parser stops at the hyphen — **parse from raw text**.

Its contact share is posted as `login_contact` too, the *same* mapping as `/login`. The contact carries nothing about which command was asked; the platform recorded a pending intent and reads it. **Do not branch** — the automation layer does not have the information and the platform does. With no intent on record it falls back to `login`, deliberately the lesser outcome.

---

<a name="connect"></a>
## `/connect`  🔒 LIVE

| | |
|---|---|
| **Syntax** | `/connect` |
| **Aliases** | `/link` |
| **Purpose** | A 6-character code to connect this chat to an existing account |
| **Identity** | not required · **Customer role** ❌ |
| **Tools** | `connections_send_connect_code` (CommandBus `connect`) |
| **Confirmation** | false |
| **Status** | **live** |

**Behaviour.** The code stands for the messaging identity alone; **nothing is connected until it is typed on the website**, where a session says who is claiming it. A second `/connect` invalidates the first.

⚠ **If `/connect` stops working after any change, something shared broke.** It is the canary for the webhook secret and the CommandBus registration — fix that before looking anywhere else.

---

<a name="search"></a>
## `/search`

| | |
|---|---|
| **Syntax** | `/search <words>` |
| **Aliases** | `/find` `/chercher` `/rechercher` `/buscar` `/procurar` |
| **Arguments** | `query` — free text, required. Missing → "what are you looking for?" |
| **Identity** | not required |
| **Tools** | `catalog_search_products` |
| **Flow** | `browse` |
| **Confirmation** | false |

**Behaviour.** Five results, newest first unless the customer asked otherwise. Each card carries price, stock, rating and the seller.

⚠ **`q` is a whole-word text search over title, tags and description.** Searching `dres` will **not** find "dress", and it does **not** match SKUs. Pass the customer's words; when they gave a partial word, say the search was for that word rather than silently returning nothing.

⚠ **There is no popularity sort.** Asking for one is a `400`, not a silent fallback.

**Errors.** `VALIDATION_ERROR` when `minPrice > maxPrice` or the sort is unknown → reprompt on that one value.

**WhatsApp.** Interactive list, 5 rows, plus a "Show more" row when `meta.pages > 1`. Row title ≤ 24 chars — truncate the title, never drop the price. **Telegram.** Photo cards with inline keyboards, or a numbered list with a pagination row.

**Example**
```
User:  /search robe wax
Bot:   3 results for "robe wax":
       1. Ankara Wax Print Maxi Dress — 24,000 XAF — in stock — Maison Bella ★4.3
       2. Wax Wrap Dress — from 18,000 XAF — in stock — Douala Threads
       3. Kente Wax Midi — 31,000 XAF — out of stock — Maison Bella
       [ Open 1 ]  [ Open 2 ]  [ More ]
```

---

<a name="categories"></a>
## `/categories`

| | |
|---|---|
| **Syntax** | `/categories` · **Aliases** `/cats` |
| **Identity** | not required · **Tools** `catalog_list_categories` · **Confirmation** false |

**Behaviour.** Categories that currently have something for sale, with counts, biggest first. A complete small set rather than a page — but still render ≤ 10 and offer the rest.

⚠ There is no category taxonomy behind this. `Product.category` is free text, and the list is derived over the browse filter — so a category whose every product is a draft simply is not there.

---

<a name="category"></a>
## `/category`

| | |
|---|---|
| **Syntax** | `/category[:<name>]` · **Aliases** `/categorie` `/categoria` |
| **Arguments** | `name` — optional. Missing → list the categories and let them pick |
| **Identity** | not required · **Tools** `catalog_list_categories`, `catalog_search_products` · **Confirmation** false |

⚠ **Match the argument against the live list before using it.** Category is exact-match free text, so an unrecognised name returns an empty page — which reads as "we sell nothing like that" when the truth is "that is not what it is called here".

---

<a name="product"></a>
## `/product`

| | |
|---|---|
| **Syntax** | `/product:<sku\|id\|url>` · **Aliases** `/p` `/item` `/produit` `/produto` `/producto` |
| **Arguments** | `ref` — optional; resolves from the product in focus |
| **Context** | `single_unambiguous_focus`, **must echo** |
| **Identity** | not required |
| **Tools** | `catalog_get_product` · `catalog_get_product_by_slug` · `catalog_resolve_sku` (GAP-003, ✅ **BUILT** 2026-08-26) · `recently_viewed_record` |
| **Flow** | `product_card` · **Confirmation** false |

**Behaviour.** A product card: image, title, price, stock, rating, seller, and actions. Recording the view keeps `/support` routing and the website's recently-viewed list in agreement with the conversation.

⚠ **A service variant's price is a unit rate**, per `durationMinutes` — printing it as "the price" misquotes the customer. Quote `priceFrom` with `priceUnit`.

⚠ **Select a variant on `optionValueIds`, never on a rebuilt option signature.** Renaming an option value is a supported operation that leaves the stored signature saying the old name.

⚠ **A closed store still sells.** `isOpen: false` is a vacation, not a suspension — say "the seller is on holiday", never "unavailable".

**Errors.** `CATALOG_PRODUCT_NOT_FOUND` covers absent, draft, archived, suspended and suspended-vendor, indistinguishably. **Never speculate about which** — the ambiguity exists so a competitor cannot enumerate an unreleased catalogue.

**SKU today.** `catalog_resolve_sku` is **BUILT** (2026-08-26). Send the code **exactly as the customer typed it** — the backend tries the as-typed, uppercase and lowercase spellings in one lookup and the as-typed one wins, so upper-casing it first works against that rule. It answers the *variant's* price and stock, not the product card's. On a `404`, falling back to a text search is still the right second move, and the reply should say it *searched* rather than *looked up*.

**WhatsApp.** ≤ 3 buttons: **Add to cart · Buy now · Similar**. Details and reviews go on a list. A native `product` message needs a Meta Commerce catalogue (**GAP-009**); until then, image + caption + buttons. **Telegram.** Photo with caption and a 2×2 inline keyboard.

---

<a name="store"></a>
## `/store`

| | |
|---|---|
| **Syntax** | `/store[:<slug>]` · **Aliases** `/shop` `/boutique` `/seller` `/vendeur` |
| **Arguments** | `slug` — optional; resolves from the product or order in focus |
| **Context** | `focus_or_most_recent`, must echo |
| **Identity** | not required · **Tools** `catalog_get_store`, `catalog_list_store_products` · **Confirmation** false |

**Behaviour.** The seller's public page and their published support contacts — this is the source for the vendor branch of `/support`. Any contact field may be null.

⚠ **`city` is the only address component published**, deliberately: a seller's other addresses are the places they ship from, which are private.

---

<a name="similar"></a>
## `/similar`

| | |
|---|---|
| **Syntax** | `/similar[:<product ref>]` · **Aliases** `/related` `/similaire` |
| **Identity** | not required · **Tools** `catalog_list_related_products` · **Confirmation** false |

⚠ **The heading must follow `meta.source`.** `co_purchase` → "Frequently bought together". `same_category` → "More in this category". Calling the fallback "customers also bought" is a claim about other shoppers that is not true, and on a young catalogue the fallback is the common case.

An empty list is a successful answer. `orders` is always `null` on the fallback.

---

<a name="reviews"></a>
## `/reviews`

| | |
|---|---|
| **Syntax** | `/reviews[:<product ref>]` · **Aliases** `/avis` `/ratings` `/opinions` |
| **Identity** | not required · **Tools** `catalog_list_product_reviews` · **Confirmation** false |

**Behaviour.** Three reviews and the star breakdown.

⚠ **A product nobody has reviewed carries `rating: null`, never a zero-count summary.** Say "no reviews yet" — never "0 stars".

⚠ Delivery reviews are internal, feed an agent's trust score, and have no public endpoint. This command only ever shows product reviews.

---

<a name="cart"></a>
## `/cart`

| | |
|---|---|
| **Syntax** | `/cart [add\|remove\|qty\|clear] [<ref>] [<qty>]` |
| **Aliases** | `/panier` `/view-cart` `/viewcart` `/basket` `/carrito` `/carrinho` |
| **Identity** | ✅ · **Customer role** ✅ |
| **Tools** | `cart_get` `cart_add_item` `cart_remove_item` `cart_set_item_quantity` `cart_clear` |
| **Flow** | `cart` · **Confirmation** ✅ for `clear` only |
| **Status** | **GAP-001** |

**Behaviour.** Bare → the basket, line by line, with the total item count. An empty basket is a successful answer, never an error.

⚠ **Two rules the customer will hit.** A basket may hold items from several sellers but only **one product type** — physical or digital, never both (`CART_MIXED_PRODUCT_TYPES`). **Services cannot be carted at all** (`CART_SERVICE_PRODUCT_NOT_ALLOWED`); they are booked.

⚠ On a mixed-type conflict, **offer to check out what is there first.** Never clear a basket the customer built in order to add one thing.

⚠ Adding reserves nothing. Stock is only held at checkout, for 30 minutes.

**Sub-commands.** `add` → [`/add-to-cart`](#add-to-cart). `qty <ref> <n>` sets an **absolute** quantity (`0` is refused — use `remove`). `remove` takes out one variant; the by-product delete that would remove every size of a garment is deliberately not exposed. `clear` confirms, naming how many items will go.

**WhatsApp.** ≤ 3 buttons: **Checkout · Modify · Clear**. Line edits go through a list, not buttons. **Telegram.** One inline row per line with − / + / ✕, plus a Checkout row.

---

<a name="add-to-cart"></a>
## `/add-to-cart`

| | |
|---|---|
| **Syntax** | `/add-to-cart[:<sku\|id>] [<qty>]` · **Canonical** `add_to_cart` |
| **Aliases** | `/add` `/ajouter` |
| **Arguments** | `ref` optional (context), `quantity` optional (default 1) |
| **Context** | `single_unambiguous_focus`, **must echo** |
| **Identity** | ✅ · **Tools** `catalog_get_product` → `cart_add_item` · **Confirmation** false |
| **Status** | **GAP-001** |

**Behaviour.** Increments if the exact variant is already there.

⚠ **Context resolves the product; it never resolves the variant.** A product with more than one variant always asks which, even when exactly one product is in focus. Guessing a size is how a customer receives the wrong garment.

⚠ **Always name what was added** — *"Added Ankara Wax Print Maxi Dress — Size M"*, never *"Added to cart"*. A wrong resolution that is stated is corrected in one turn.

**Example — context resolution done right**
```
Bot:   [product card] Ankara Wax Print Maxi Dress — from 24,000 XAF
User:  /add-to-cart
Bot:   Which size?  [ S ]  [ M ]  [ L ]
User:  (taps M)
Bot:   Added Ankara Wax Print Maxi Dress — Size: M (24,000 XAF).
       Your basket: 3 items, 51,000 XAF.
       [ Checkout ]  [ Keep shopping ]  [ View basket ]
```

---

<a name="checkout"></a>
## `/checkout`

| | |
|---|---|
| **Syntax** | `/checkout` · **Aliases** `/commander` |
| **Identity** | ✅ · **Customer role** ✅ |
| **Tools** | `cart_get` → `addresses_list` → `cart_quote` → `checkout_create_orders` → `payment_initiate` → `payment_authorize_otp` → `payment_verify` |
| **Flow** | `checkout` — 8 steps, ARCHITECTURE §8.1 |
| **Confirmation** | ✅ before order creation, and again before payment |
| **Status** | **GAP-001** |

**Behaviour.** Basket → address → quote → method → confirm → orders → payment → settled. Fully in chat for mobile money; cards hand off.

⚠ **The quote step is not optional.** An address is only deliverable if it carries a geocoded location, which only the address picker populates — so an address the customer **explicitly chose** still fails checkout if they typed it by hand. Learning that at the pay button, after the orders exist, is the worst possible moment.

⚠ **Ask for the mobile-money operator; never guess.** MTN or Orange. A wrong operator reaches the customer as "payment declined".

⚠ **Branch on `status`, not the HTTP code.** A refused charge is HTTP `200` with `status: "FAILED"`.

⚠ **After the orders exist, the customer is holding stock for 30 minutes.** If the flow stalls, say the hold lapsed.

**Payment branches.** `instructions.ussdCode` → "dial `*126#` and approve". `instructions.requiresOtp` → collect the SMS code (there is **no** USSD code on this branch). `instructions.clientSecret` → hand off; cards are paid on the website.

**Cash on delivery** needs no payment call at all. Eligibility is checked at order creation: physical only, every agency must support it, and some cap the per-order amount — `COD_ORDER_AMOUNT_EXCEEDS_LIMIT` carries the cap, which makes it actionable.

**Errors worth special copy.** `CATALOG_INSUFFICIENT_STOCK` carries `sku`, `requested` and `available` — offer the available quantity. `ORDER_DELIVERY_ADDRESS_REQUIRED` with `reason: selected_address_not_geocoded` takes them into the address flow, not a bare "invalid address".

---

<a name="buy"></a>
## `/buy`

| | |
|---|---|
| **Syntax** | `/buy[:<sku\|id>]` · **Aliases** `/buy-now` `/buynow` `/acheter` `/comprar` |
| **Identity** | ✅ · **Tools** as `/checkout`, preceded by `cart_add_item` |
| **Flow** | `checkout` · **Confirmation** ✅ |
| **Status** | **GAP-001** |

**Behaviour.** Add one thing and go straight to checkout.

⚠ **There is no separate buy-now basket.** Express checkout uses the same cart. When the cart already holds something, say so and offer both routes — check out everything, or empty first. **Silently discarding a basket the customer built is not acceptable.**

⚠ Not every product can be bought this way. Services are booked; a digital product allows only one per basket and quantity 1.

---

<a name="pay"></a>
## `/pay`

| | |
|---|---|
| **Syntax** | `/pay[:<order ref>]` · **Aliases** `/payer` `/payment` `/paiement` `/pagar` |
| **Arguments** | `ref` optional. Missing → list unpaid orders |
| **Identity** | ✅ · **Tools** `orders_list_groups` `orders_get_order` `payment_initiate` `payment_authorize_otp` `payment_verify` |
| **Flow** | `payment` · **Confirmation** ✅ |
| **Status** | **GAP-001** for the reads; the payment calls are live |

**Behaviour.** Resume payment on an order left unpaid.

⚠ **Payment is against the checkout group (`cartId`), not the single order.** One payment settles every order in the group.

⚠ A cash-on-delivery order has no online payment — say so rather than failing (`PAYMENT_ORDER_IS_COD`).

⚠ **The phone number is confirmed in the turn that spends it**, never taken from context. A payment prompt is sent to a handset; the wrong number sends it to a stranger.

---

<a name="orders"></a>
## `/orders`

| | |
|---|---|
| **Syntax** | `/orders [<status>]` · **Aliases** `/commandes` `/my-orders` `/pedidos` `/mes-commandes` |
| **Identity** | ✅ · **Tools** `orders_list_groups` · **Confirmation** false · **Status** **GAP-001** |

**Behaviour.** Five most recent groups, each one purchase however many sellers were in it.

The group payment status is an aggregate: `paid` · `awaiting_payment` · `partially_paid` (including a cash order partway through per-shipment collection) · `refunded` · `failed` · `disputed` · `unknown` · `mixed`. Render the word, not the enum.

⚠ An unknown status filter is a `400` naming the field, not a silent empty page — reprompt.

---

<a name="order"></a>
## `/order`

| | |
|---|---|
| **Syntax** | `/order:<order ref>` · **Aliases** `/commande` |
| **Arguments** | `ref` optional; the order in focus, named back |
| **Context** | `focus_or_most_recent`, must echo |
| **Identity** | ✅ · **Tools** `orders_get_order`, `orders_get_group` · **Confirmation** false · **Status** **GAP-001** |

⚠ **`ORDER_NOT_FOUND` also means "not yours".** The two are indistinguishable on purpose — phrase it as one answer and never infer existence from a 404.

⚠ **Never include a delivery code in an order summary.** It is present in the group response and is stripped before the model sees it. See [`/code`](#code).

---

<a name="track"></a>
## `/track`

| | |
|---|---|
| **Syntax** | `/track[:<order ref>]` · **Aliases** `/tracking` `/suivi` `/suivre` `/rastrear` `/seguimiento` |
| **Arguments** | `ref` optional; the single order in flight, named back. Several → list |
| **Context** | `focus_or_most_recent`, must echo |
| **Identity** | ✅ · **Tools** `orders_list_groups` → `orders_list_shipments` |
| **Flow** | `tracking` · **Confirmation** false · **Status** **GAP-001** |

**Behaviour.** Per parcel: stage, history, tracking number, the delivery company and their contacts, and the carrier's first name while they are actually carrying it.

**The vocabulary is five words**, the same five the customer's notifications use: `preparing` · `shipped` · `out_for_delivery` · `delivered` · `delivery_failed`. The eleven internal statuses are dispatch machinery and are never shown.

⚠ **There is no live map in chat.** Live GPS is a WebSocket authorised with a per-viewer token the bot deliberately never holds. Report the stage — it is the better chat answer anyway.

⚠ **`estimatedDelivery` is always `null`.** Nothing in the platform estimates a delivery date. **Never invent one**, and never soften it into "should arrive tomorrow".

⚠ **Never publish the carrier's phone number or full legal name.** `displayName` is partial by design — "Jean T." — and `agent` is `null` more often than set: no one is bound yet at `preparing`, and the disclosure is **revoked** once the parcel settles. A customer with a question contacts the **agency**, on a business line its owner chose to publish.

⚠ **The internal note on a failed delivery is never shown.** It is written by an agent for their agency ("gate locked, dog"). Only the count of failed attempts is surfaced.

---

<a name="code"></a>
## `/code`  ⚠ sensitive

| | |
|---|---|
| **Syntax** | `/code[:<order ref>]` · **Aliases** `/delivery-code` `/cod` `/code-livraison` |
| **Arguments** | `ref` — **`explicit_only`**. Missing → list cash orders awaiting collection |
| **Identity** | ✅ · **Tools** `orders_get_cod_code`, `orders_resend_cod_code` |
| **Flow** | `cod_code` · **Confirmation** ✅ for resend only · **Status** **GAP-001** |

**Behaviour.** The customer's secret 6-digit code for a cash parcel, and the exact amount to pay.

⚠ **Five rules, and they are the reason this command is `flow_only` behind the scenes:**
1. **Only on an explicit request.** Never proactively, never inside an order summary, never as colour in an answer about something else.
2. **Never resolved from context.** The customer names the order.
3. **Always with the warning:** *give this code to the agent only after you have received your package and paid.* It is their proof-of-payment lever; releasing it early is signing a receipt.
4. **Never written to the conversation transcript.** Same reasoning as the login reply.
5. **Only while the collection is pending.** Afterwards it is gone, not hidden.

**Resend** is rate-limited server-side to one per 60 seconds (`COD_CODE_RESEND_TOO_SOON` carries `retryInSeconds`) and invalidates the previous code.

⚠ If the code never arrives, the platform records the cash as collected after 7 days at `agent_delivered`. Do not describe that as a penalty — it exists because a customer can pay and still not produce a code.

---

<a name="confirm"></a>
## `/confirm`

| | |
|---|---|
| **Syntax** | `/confirm[:<order ref>]` · **Aliases** `/received` `/confirm-delivery` `/recu` |
| **Arguments** | `ref` required. Missing → list parcels awaiting confirmation |
| **Identity** | ✅ · **Tools** `orders_list_shipments` → `orders_confirm_shipment_delivery` |
| **Flow** | `confirm_delivery` · **Confirmation** ✅ · **Status** **GAP-001** |

**Behaviour.** Records that a parcel arrived. Once every parcel on the order is confirmed, the order completes and the seller's 7-day escrow hold begins.

⚠ **Refused on cash orders.** Those are confirmed by handing the agent the code, which records the payment and the delivery in one step. **Do not offer the action for a cash parcel** — offer the code.

⚠ **Never confirm on the customer's behalf** because a status says the agent reported delivery. This is the customer's word and it is the lever they hold in a dispute.

---

<a name="cancel"></a>
## `/cancel`

| | |
|---|---|
| **Syntax** | `/cancel:<order ref> [<reason>]` · **Aliases** `/annuler` `/cancelar` |
| **Arguments** | `ref` — **required, `explicit_only`**. `reason` optional, ≤ 500 chars, **verbatim** |
| **Identity** | ✅ · **Tools** `orders_get_order` → `orders_cancel`, or `bookings_get` → `bookings_cancel` |
| **Flow** | `cancel` · **Confirmation** ✅ · **Status** **GAP-001** |

**Behaviour.** Fetch, check the policy, summarise, confirm, execute.

⚠ **Never resolved from context, in any circumstance.** "Cancel it" against the wrong order is unrecoverable.

⚠ **The seller's policy decides, not the platform's.** `CANCELLATION_NOT_ALLOWED` carries `cancellable` and `deadline` — quote their terms rather than promising an outcome.

**Three refusals with distinct copy.** A **paid** order cannot be cancelled here and needs a refund conversation (`ORDER_CANCEL_REQUIRES_REFUND` → offer a ticket). Past `processing` it is too late (`ORDER_NOT_CANCELLABLE`). A **cash** order additionally requires that no parcel has been picked up — after that the customer can still refuse at the door, which is worth saying because it is the actual remedy.

⚠ **Never promise a refund.** Report the payment status the response carried. Some gateways cannot refund at all and settle by hand.

---

<a name="address"></a>
## `/address`

| | |
|---|---|
| **Syntax** | `/address [add\|default] [<args>]` · **Aliases** `/adresse` `/addresses` `/direccion` `/endereco` |
| **Identity** | ✅ · **Tools** `addresses_list` `geo_search_address` `geo_reverse_address` `addresses_add` `addresses_set_default` |
| **Flow** | `address` — ARCHITECTURE §8.2 · **Confirmation** ✅ for `add` and `default` · **Status** **GAP-001** |

**Behaviour.** Bare → saved addresses, which is the default, and whether each can actually be delivered to. `add` → the capture flow. `default` → change which one new orders go to.

⚠ **Never save typed text as an address.** Only a picked candidate carries a geocoded location, and one without it is refused at checkout — so saving typed text produces an address that looks fine everywhere and cannot be used. `addresses_add` takes an opaque candidate handle for exactly this reason.

⚠ **A pin is not an address.** Always show the reverse-geocoded result and have the customer confirm before saving.

⚠ **`address_line2` is the part a geocoder never knows** — the flat number, the landmark, "the blue gate opposite the pharmacy". Ask for it; it is what makes a delivery succeed.

**Not commands: edit and delete.** Past orders reference the address id, so editing in place has consequences a chat window explains badly. Both hand off to the website.

**WhatsApp.** Offer location sharing first. **Telegram.** Ask with a `request_location` keyboard button, not in prose.

**Example**
```
User:  /address add
Bot:   Where should we deliver? Share your location, or type the address.
       [ 📍 Share location ]
User:  Rue de l'Université, Yaoundé
Bot:   Which one?
       1. Rue de l'Université, Ngoa-Ekellé, Yaoundé
       2. Rue de l'Université, Centre, Yaoundé
User:  1
Bot:   Any flat number or landmark? (helps the driver find you)
User:  Blue gate opposite the pharmacy
Bot:   Save as?  [ Home ]  [ Work ]  [ Other ]
User:  Home
Bot:   Saved "Home": Rue de l'Université, Ngoa-Ekellé, Yaoundé
       — blue gate opposite the pharmacy.
       [ Make it my default ]
```

---

<a name="language"></a>
## `/language`

| | |
|---|---|
| **Syntax** | `/language[:<code>]` · **Aliases** `/langue` `/lang` `/idioma` `/lingua` |
| **Arguments** | `code` — one of `en fr pt es ar`, or the language's own name. Missing → offer the five |
| **Identity** | ✅ · **Tools** `profile_set_language` · **Confirmation** false · **Status** **GAP-001** |

⚠ **The change is durable and reaches email and notifications**, not just this conversation. Do not switch on a single message in another language — people code-switch. Offer, and switch when they say yes.

⚠ **Product text is never translated.** It is vendor-authored in one language and the product says which. Label it honestly rather than appearing to have translated it.

---

<a name="profile"></a>
## `/profile`

| | |
|---|---|
| **Syntax** | `/profile` · **Aliases** `/profil` `/account` `/compte` `/me` `/cuenta` |
| **Identity** | ✅ · **Tools** `profile_get_summary` · **Confirmation** false · **Status** **GAP-001** |

**Behaviour.** Name, masked contact details, language, currency, timezone, saved-address count.

⚠ **Contact details come back masked**, from the bot surface, deliberately. A chat window is shared, screenshotted and occasionally shoulder-surfed, and the customer already knows their own number.

**Hands off to the web:** changing an email or phone (a verification flow — the identifier does not move until proved), and closing an account (irreversible, and anonymise-and-retain rather than deletion).

---

<a name="notifications"></a>
## `/notifications`

| | |
|---|---|
| **Syntax** | `/notifications` · **Aliases** `/notif` `/alerts` `/alertes` |
| **Identity** | ✅ · **Tools** `notifications_get_preferences`, `notifications_update_preferences` |
| **Flow** | `notification_settings` · **Confirmation** ✅ for changes · **Status** **GAP-001** |

⚠ **At most one secondary channel is on at a time** — enabling one disables the others.

⚠ **Money and cancellations always send and no setting silences them.** Payment received, refund issued, refund pending, balance due, and a seller calling something off. Say so plainly. A silent refund is indistinguishable from a stolen payment.

⚠ Enabling an unverified channel is a `400`, not a silent accept — an enabled channel that delivers nothing reads as the platform being broken.

---

<a name="stop"></a>
## `/stop`

| | |
|---|---|
| **Syntax** | `/stop`, **and a bare `STOP` with no slash** · **Aliases** `/unsubscribe` `/desabonner` |
| **Identity** | ✅ · **Tools** `notifications_update_preferences` · **Confirmation** ✅ · **Status** **GAP-001** |

**Behaviour.** Moves the secondary notification channel off this one.

⚠ **Be honest about what it does not do.** In-app records are always written, and money and cancellation messages are not silenceable by any setting. Promising silence the platform will break is worse than saying no.

**WhatsApp.** Meta expects an opt-out keyword to be honoured, so a bare `STOP` must work without a slash. Confirm what changed and how to undo it.

---

<a name="support"></a>
## `/support`

| | |
|---|---|
| **Syntax** | `/support[:vendor\|agency\|platform]` · **Aliases** `/contact` `/assistance` |
| **Arguments** | `scope` — default `auto` |
| **Context** | `focus_or_most_recent`, **must echo** |
| **Identity** | ✅ · **Tools** `support_resolve_contacts` (GAP-004, ✅ **BUILT** 2026-08-26), `catalog_get_store`, `orders_list_shipments`, `tickets_create` |
| **Flow** | `support` · **Confirmation** ✅ to open a ticket · **Status** ✅ available — one call |

**Behaviour — the relevance ladder.** `auto` walks it in order and **always names what it routed from**:

```
1. the product or order in focus in this conversation
2. the customer's most recent order   → seller, and delivery company once it has shipped
3. the last product they opened       → seller
4. recentProductCode on the profile   → seller
5. nothing                            → platform support
```

| Situation | Answer |
|---|---|
| A relevant seller | Their published contacts, plus "or I can open a ticket" |
| A relevant delivery company | Their published contacts. **Only exists once an order has a shipment** |
| No relevant context | Platform support. Offer a ticket — do not ask them to guess |
| Explicit `:vendor` with no seller in context | Say there is nothing recent, and offer to find one |
| Explicit `:agency` with only a product in context | **Legitimately empty.** An agency attaches to a shipment, not to a product. Ask which order |

⚠ **The three parties are not interchangeable.** A product question goes to the seller. A parcel question goes to the delivery company. Money, accounts and anything about the platform itself goes to the platform. Routing a delivery complaint to a seller who cannot act on it wastes both people's time.

⚠ **Answer the question when you can.** Routing someone to a phone number is a worse answer than telling them where their parcel is.

⚠ Any contact field may be `null`. Offer what exists and fall through to a ticket.

⚠ **GAP-004 landed on 2026-08-26, so the three-call fallback below is HISTORY, not instructions.** The flow used to compose this from `orders_list_groups` → `catalog_get_store` → `orders_list_shipments` — three round-trips, the same answer, three chances to route wrongly, and the ladder that joins them living in n8n. `support_resolve_contacts` now returns all three parties with `resolvedFrom` and `subject.label` in one call; see [bot-surface.md § 12](./bot-surface.md#12--support-routing-gap-004).

---

<a name="ticket"></a>
## `/ticket`

| | |
|---|---|
| **Syntax** | `/ticket[:<TKT-1043>]` · **Aliases** `/tickets` `/billet` |
| **Arguments** | `ref` optional. Missing → open tickets |
| **Identity** | ✅ · **Tools** `tickets_list` `tickets_get` `tickets_add_note` `tickets_close` |
| **Flow** | `tickets` · **Confirmation** ✅ for close · **Status** **GAP-001** |

**Behaviour.** Bare → open tickets with status. With a reference → that ticket and its public conversation.

⚠ **`assigned_admin` is `null` until a human takes it**, which is the state almost every ticket is in. Say "waiting to be picked up" — never invent a handler.

⚠ **Customers never see internal staff notes**, and a note the customer adds is always public. Do not imply there is a hidden conversation.

⚠ **Never close a ticket because a conversation went quiet.** Only the customer decides their problem is over.

⚠ **Check for an existing open ticket before creating one.** Add a note instead — a duplicate splits the history across two records.

---

<a name="saved"></a>
## `/saved`

| | |
|---|---|
| **Syntax** | `/saved [add\|remove] [<product ref>]` · **Aliases** `/wishlist` `/favorites` `/favoris` `/favoritos` |
| **Identity** | ✅ · **Tools** `wishlist_list` `wishlist_add` `wishlist_remove` · **Confirmation** false · **Status** **GAP-001** |

**Behaviour.** Saving is idempotent and does **not** move the entry — a wishlist is ordered by when you decided, and a second tap is not a new decision.

⚠ **An entry's product can be `null`** when it went off sale. Render "no longer available" with a working remove button. **Never drop the row silently** and **never say why** — that would leak a seller's catalogue state to anyone who once saved a product.

⚠ Do not remove something from the wishlist because it was added to the basket. Different lists; the customer did not ask.

---

<a name="downloads"></a>
## `/downloads`

| | |
|---|---|
| **Syntax** | `/downloads` · **Aliases** `/telechargements` `/files` `/fichiers` |
| **Identity** | ✅ · **Tools** `digital_list_entitlements` → `digital_create_download_link` |
| **Flow** | `downloads` · **Confirmation** false · **Status** **GAP-001** |

⚠ `maxDownloads: null` means unlimited and `expiresAt: null` means never expires — **say so in words**, never print `null`. `canDownload` is the single flag that decides whether to offer the download.

⚠ **One link at a time, on request.** A link is single-use and lasts 15 minutes; the allowance moves on *execute*, not on creation, so an unused link costs nothing — but a link is a bearer credential in a URL. `preview_url: false`.

---

<a name="bookings"></a>
## `/bookings`

| | |
|---|---|
| **Syntax** | `/bookings[:<booking ref>]` · **Aliases** `/rendezvous` `/rdv` `/appointments` `/reservations` `/citas` |
| **Identity** | ✅ · **Tools** `bookings_list` `bookings_get` `bookings_cancel` |
| **Flow** | `bookings` · **Confirmation** ✅ for cancel · **Status** **GAP-001** |

**Behaviour.** Read and cancel only. Times in the customer's own timezone.

⚠ **Making a booking hands off to the website.** A slot must be locked against a live calendar and used within 15 minutes, and chat abandonment is common — each abandoned flow holds a slot nobody else can take.

⚠ **Rescheduling also hands off**, and must never be answered by cancelling: cancelling loses the original slot, and a new one may not exist.

⚠ **`creditDue` is recorded, not refunded.** If the provider settled below what was paid, say the provider intends to hand it back and offer support. **Never promise a refund.**

---

<a name="review"></a>
## `/review`

| | |
|---|---|
| **Syntax** | `/review[:<order ref>]` · **Aliases** `/rate` `/noter` |
| **Identity** | ✅ · **Tools** `reviews_check_eligibility` → `reviews_create` |
| **Flow** | `review` · **Confirmation** ✅ · **Status** **GAP-001** |

**Behaviour.** Check eligibility → collect stars → offer words → **say which will happen** → submit.

⚠ **A bare star rating publishes immediately. A review with words waits for a moderator.** Tell the customer which before submitting — a number cannot be abusive, prose can, and the wait is not a failure.

⚠ **Never write the customer's words for them**, and never infer a rating from their tone. A review is attributed to them.

⚠ **A delivery review takes a shipment id, not an order id**, is never published anywhere, and is attributed to the carrying agent server-side — the customer never chooses whom it lands on.

**Eligibility** is verified purchase or verified delivery, always. A `200` with `eligible: false` is a successful answer to a question; check before asking, so an ineligible customer is never invited to write something that will be refused.

---

## Part IV — commands considered and not created

| Proposed | Outcome | Why |
|---|---|---|
| `/region`, `/region:<x>` | **Removed** | No region concept exists on a customer anywhere in the backend. Country is per saved address (default CM), currency is a preference, and the search bias is a server-side variable. It would be a setting that changes nothing — **GAP-010** if one is wanted |
| `/view-cart` | **Alias of `/cart`** | Two commands for one screen is two things to document and translate |
| `/add-to-cart`, `/buy-now` | **Kept, canonicalised** | Aliases of `add_to_cart` and `buy`; the published hyphenated forms keep working and the canonical names are BotFather-registrable |
| `/product` with no argument | **Kept, context-resolved** | Resolves the product in focus, named back. Never the variant |
| A `/checkout-web` escape hatch | **Not created** | The flow already hands off when it must, and says why. A command for it invites using it as a first resort |
| `/faq`, `/hours`, `/shipping-policy` | **Not created** | The AI agent answers these from the store and product data it already reads. A command per FAQ topic is a command per topic forever |
| `/agent`, `/human` | **Not created** | `/support` and `/ticket` are the escalation path, and they route to whoever can actually act |
| `/delete-account` | **Not created** | Irreversible and anonymise-and-retain rather than deletion. `/profile` hands off |

---

## Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the pipeline, identity, context, flows, security
- [BACKEND-GAPS.md](./BACKEND-GAPS.md) — the twelve gaps these commands depend on
- [tools/commands.json](./tools/commands.json) — the machine-readable parser table
- [tools/catalog.json](./tools/catalog.json) — the tools each command calls
- [../auth/N8N-HANDOFF.md](../auth/N8N-HANDOFF.md) — the three live commands' existing contract
