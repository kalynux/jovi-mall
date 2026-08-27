# Recommendations

What I changed from the original proposal, what I added, and what I am worried about.
Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) · [COMMAND-SPECIFICATION.md](./COMMAND-SPECIFICATION.md) · [BACKEND-GAPS.md](./BACKEND-GAPS.md).

---

## 1 · Changed from the proposal

### 1.1 · Command syntax — `/command arg` canonical, `:` kept as an alias

The proposal used `/command:value`. It is kept and works everywhere, but the **space form is canonical** and the **canonical names are underscore-safe**.

The reason is not taste. Telegram's `bot_command` entity accepts only `[a-zA-Z0-9_]`, so **`/reset-password` is parsed by Telegram as the command `/reset`** with `-password` as trailing text, and it cannot be registered with BotFather for autocomplete. That command is in production today and works only because the automation layer reads the raw message text. Every new hyphenated command would inherit the same quiet breakage.

So: canonical `[a-z][a-z0-9_]*`, every hyphenated form kept as an alias, parse from raw text, register the canonical names with BotFather.

### 1.2 · The bot never holds a customer session

The obvious way to let n8n call `/api/customer/*` is to mint a customer token for the resolved messaging identity. It is the least backend work and it is the wrong trade.

n8n would become a credential store for the entire customer base, and **there is no revocation lever**: `password_changed_at` is this service's only one, and a passwordless customer has never set it. A leaked customer session today has no revocation path at all. That is a pre-existing gap, and a design that makes sessions plentiful and machine-held is the wrong thing to build on top of it.

The curated surface (GAP-001) costs more and bounds the blast radius to the operations that were explicitly built.

### 1.3 · Money and destructive actions are removed from the model's reach entirely

Not "instructed carefully" — **not registered as tools at all**. Twenty-three of the sixty are `flow_only`: checkout, every payment call, order cancel, booking cancel, delivery-code disclosure and resend, address writes, review submission, ticket close, cart clear, registration.

The model can *enter* a flow. Deterministic steps make the calls. Prompt injection through a product title, a store name or a ticket note cannot reach a tool that is not in the list.

### 1.4 · A confirmation replays a stored call, never a re-derived one

The proposal asks which commands need confirmation. The more important question is what "yes" executes. The guard stores `{tool, args}` under a single-use token, renders the summary **from the stored args**, and on Yes executes the stored call without running the model again.

Without this, the model re-derives the arguments at confirm time and "yes" can execute something other than what the customer read. It also makes a double-tapped Yes harmless.

### 1.5 · `/support` needs a backend endpoint, not a routing policy in n8n

The proposal's default-support behaviour — "the most relevant contact based on the customer's recent interaction" — is a **policy**, and every input for it already exists in jovi-mall. Implementing the ladder in n8n puts a business rule in the automation layer and makes it three round-trips.

GAP-004 is a composite that walks it server-side and returns `resolvedFrom` so the bot can name what it routed from. The three-call fallback is fully specified and works today, so this is a quality gap rather than a blocker.

### 1.6 · Product actions are gated on product *type*, not assumed

The proposal notes that not every product supports cart or checkout, and the backend is stricter than it might look:

- **Services cannot be carted at all** — `CART_SERVICE_PRODUCT_NOT_ALLOWED`.
- **A basket holds one product type**, physical or digital, never both.
- **Digital is one product per basket, quantity 1.**
- A **service variant's price is a unit rate** per `durationMinutes`; printing it as "the price" misquotes the customer.
- **A closed store still sells** — `isOpen: false` is a holiday, and the backend does not block the cart on it.

Every one of these is in the tool descriptions rather than left to the model to discover from an error.

### 1.7 · Checkout completes in chat for mobile money, and hands off for cards

`POST /api/payments/initiate` and `/verify` take **no authentication** — deliberately, because a payment reference is shareable. That is what makes in-chat checkout possible without the bot holding a session: the flow authenticates to *create* the orders and the payment needs only the `cartId`.

Cards need a browser for Stripe's `clientSecret` and there is no page for it (GAP-008), so they hand off. Mobile money is the dominant local method and completes fully in chat.

### 1.8 · Registration gets an explicit consent step

The documentation implies an account is created silently on first contact. Creating an account is durable and has a data-protection footprint, and a person who messaged a shop to ask a price did not ask for one. One question, one tap — and the consent token is single-use, which is also what makes registration idempotent under retry.

---

## 2 · Commands removed

| Removed | Why |
|---|---|
| **`/region`, `/region:<x>`** | **No region concept exists on a customer anywhere in the backend.** Country is per saved address (default `CM`), currency is a preference, `state` is free text on an address, and the search bias is a server-side variable. It would be a setting that changes nothing — GAP-010 if one is genuinely wanted |
| **`/view-cart`** as its own command | Alias of `/cart`. Two commands for one screen is two things to document and translate |
| **`/add-to-cart`, `/buy-now`** as top-level commands | Kept as aliases of `add_to_cart` and `buy`. Published forms keep working; canonical names are BotFather-registrable |

## 3 · Commands added

| Added | Why |
|---|---|
| **`/start`** | Telegram sends it automatically, and it is the only place registration can begin. WhatsApp has no equivalent, so any first message from an unknown sender enters the same flow |
| **`/track`** | The single most-wanted thing a commerce bot does. `/orders` does not answer it — shipment state is a different call |
| **`/code`** | Cash on delivery is a first-class payment method here. Without this the customer must open the website to read a code they need at their front door |
| **`/confirm`** | Prepaid delivery confirmation had no customer-facing route at all until recently. Without it the seller's escrow never releases |
| **`/pay`** | An unpaid order is auto-cancelled after ~3 days. Resuming payment is the highest-value recovery action in the system |
| **`/stop`** | Meta expects an opt-out keyword to be honoured. It must also work as a bare `STOP` with no slash |
| **`/help`** | Filtered by sender state, so an anonymous sender is never shown a command that will refuse them |
| **`/downloads`, `/bookings`, `/saved`, `/review`, `/ticket`, `/notifications`, `/profile`** | Each maps to a surface that already exists and answers a question customers ask |

---

## 4 · Architectural risks

Ordered by how much damage they do if ignored.

### R-1 · The bot surface is a new privilege boundary, and it is wide

Forty-four tools reach every customer's cart, orders, addresses, tickets, downloads and money. Today the only comparable surface is `/api/internal/*`, which is narrow, machine-to-machine and reaches no customer data.

**Mitigations, all in the design:** two credentials rather than one; one route per operation rather than a proxy; identity never a parameter; audit on every mutation; per-identity rate limiting.

**The residual risk is real.** A compromised automation layer can act as any customer who has ever messaged the bot. It cannot mint sessions, cannot reach other roles, and leaves a trail — but it can place orders and read order history. Treat `BOT_WEBHOOK_SECRET` and `INTERNAL_SERVICE_TOKEN` as jointly equivalent to the customer base.

### R-2 · Checkout is not idempotent, and chat transports retry

`POST /api/customer/orders/checkout` creates orders and holds stock. A retry creates a **second set of both**. n8n retries, networks retry, and customers tap twice.

The confirmation token being single-use covers the human double-tap. It does **not** cover a delivery-layer retry after a response was lost. `Idempotency-Key` is part of GAP-001 and this route is the reason it is not optional.

### R-3 · Prompt injection through catalogue and ticket text

Product titles, descriptions, store names, ticket notes and review bodies are written by third parties and pass through the model.

The structural mitigation is §1.3: money and destructive tools are not in the model's list, so an injected instruction has nothing dangerous to call. Two more are worth adding at build time: pass third-party text as clearly delimited data, and strip `important_fields` down to what is needed rather than passing whole response bodies.

### R-4 · The 24-hour WhatsApp window is asymmetric and will be forgotten

Telegram has no equivalent, so a flow tested on Telegram works and the same flow on WhatsApp silently fails to send. Every waiting flow needs a template (GAP-012) or must finish inside the window.

⚠ A template registered in `template-registry.ts` but not approved in Business Manager **still fails on send**, and the failure is recorded rather than raised.

### R-5 · Context resolution is where a bot quietly does the wrong thing

"Cancel it", "add that", "where is it" are the natural way to speak and the natural way to act on the wrong object.

Mitigated by policy tiers (`explicit_only` for anything destructive) and by `must_echo`. **`must_echo` is the one to enforce in review** — it is easy to drop, it costs a few words, and it turns a silent wrong resolution into a one-turn correction.

### R-6 · Sixty tools is more than a model chooses well among

Tool-selection accuracy degrades as the list grows. Sixteen `core` tools are always loaded; twenty-one `extended` load on demand; twenty-three `flow_only` are never exposed. If accuracy is still poor, shrink `core` before improving the prompt.

### R-7 · This design has no test framework behind it

jovi-mall has **no test framework configured**. Everything here will be verified by running the server. The live suites (`verify:*`) are the closest thing to a safety net, and a `verify:bot-surface` in that shape is worth building alongside GAP-001 rather than after.

### R-8 · Two identity resolvers would be a login bug

GAP-001 must call the existing `LoginIdentityResolver`, not reimplement the ladder. Two implementations of "which account is this chat?" drift, and the drift is a login bug. The `messagingPhoneToE164` repair in particular is the single easiest way to ship this broken: it reports "no account" **to everybody** while looking perfectly implemented, and every test that does not use a bare-digits fixture still passes.

---

## 5 · Unresolved — decisions still owed

Nothing below blocks the next phase, but each one changes something in it.

| # | Question | Bearing on |
|---|---|---|
| **U-1** | **`BOT_WEBHOOK_SECRET`: require it everywhere, or only when a registration-capable command is registered?** Once accounts can be created from a webhook, the development exemption becomes a way to poison a user table | GAP-011. Recommendation: require it everywhere; the cost is one line in `.env` |
| **U-2** | **Does an inbound message imply consent to store a conversation transcript, and for how long?** The design keeps 30-minute focus and 24-hour recency, and strips credentials — but it does not settle the retention question | Context store TTLs |
| **U-3** | **Should the bot proactively message?** "Your order shipped" from the bot is useful and needs templates, an opt-in and a relationship to `orderUpdates`, which currently gates the existing notification stack | GAP-012 |
| **U-4** | **Is card payment in chat worth a hosted page?** Mobile money completes fully in chat and is dominant locally | GAP-008 |
| **U-5** | **Should the bot be a *fifth* notification channel, or reuse the WhatsApp/Telegram channels the notification stack already has?** At most one secondary channel may be enabled today. A bot that both converses and notifies on the same thread needs that resolved, or a customer gets two systems writing to one window | Notification preferences |
| **U-6** | **Session revocation for passwordless customers.** Pre-existing, not created here, and the reason the bot-minted-session option was rejected. Worth deciding on its own terms | Nothing here depends on it |
| **U-7** | **Which `TicketType` values should the bot offer?** `ticket_types.txt` is the list and the picker gaps are recorded as open on the vendor side | `tickets_create` |

---

## 6 · If only three things are built

1. **GAP-001, reads only** — `identity_resolve_sender`, cart read, orders, shipments, profile, addresses. It makes "where is my order?" work, which is most of the value, and carries none of the write risk.
2. **GAP-002 with GAP-011** — registration. Without it every command is unreachable for a new customer, and the storefront has no registration form to fall back on.
3. **Cart and checkout writes, with `Idempotency-Key`** — the commerce half. Not before 1 and 2, and not without the key.

Everything else is additive and can follow the conversation.
