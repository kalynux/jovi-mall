# n8n handoff — what has to change outside this repository

**Audience:** whoever maintains the n8n workflow that relays the WhatsApp and Telegram bots.
**Status:** handed off **2026-08-21** · Phase 6, Step 1 of
[`PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md`](../../../PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md).

Everything on the platform side is **built, tested and deployed**: `npm run test:messaging-login`
is **158 / 0**, and a live suite (`verify:messaging-login`) exercises the flow end to end against
real Redis and Mongo. **The feature is inert until the seven items below land in n8n.** Nothing in
this repository can make it work.

> ### Why this is urgent rather than tidy
>
> Customers are **passwordless by default**. `RegisterSchema` strips a supplied password for
> `role: 'customer'` and mints a random one, so **`POST /auth/login` always fails for a customer
> who has never reset**. Until `/login` works through the bot, a customer who did not set a
> password has **no way to sign in at all**, and the storefront must not show them a password
> field that cannot work. See [customer-auth.md](./customer-auth.md).

---

## The two endpoints, and the header

| Bot | URL | Auth |
|---|---|---|
| WhatsApp | `POST {API}/api/webhooks/whatsapp/` | `X-Webhook-Secret` |
| Telegram | `POST {API}/api/webhooks/telegram/webhook` | `X-Webhook-Secret` |

`BOT_WEBHOOK_SECRET` is **set on the platform side** as of 2026-08-18. Mismatch or absence is
`401 WEBHOOK_SECRET_INVALID` — and it fails **`/connect` too**, so a wrong value breaks account
linking as well as sign-in.

**This page does not restate the payload shapes.** They are documented once, in the pages linked
in the right-hand column, and a second copy here would drift out of date the first time one
changed. Follow the links.

---

## The checklist — seven items

| # | Do | Why it matters | Canonical reference |
|---:|---|---|---|
| **1** | Map `/login` → `command: "login"` | The command exists and is registered; nothing dispatches it | [magic-login.md](./magic-login.md) · [telegram](../telegram/README.md#login-and-login_contact--passwordless-customer-sign-in) |
| **2** | Map `/reset-password` → `command: "reset_password"` (**underscore**) | The user types a hyphen; the command name has an underscore | [whatsapp](../whatsapp/README.md) § `reset_password` |
| **3** | Relay `message` to the chat **verbatim** | The handler *returns* the reply; this service sends no message itself. One relay path, not two outbound APIs | [telegram](../telegram/README.md) |
| **4** | On `requestContact: true`, attach a `request_contact` keyboard ("Share my phone number") | A Telegram `chat_id` bears no relation to a phone number, so a first-time sender is anonymous. This is the only way to learn who they are | [telegram](../telegram/README.md#-one-keyboard-two-commands) |
| **5** | Post **any** inbound `contact` as `command: "login_contact"`, forwarding the **whole** contact object including **`user_id`**, plus `from.id` | ⚠ **This is the security of the whole flow.** A user can share *somebody else's* contact card; only a contact whose `user_id` equals the sender's own is accepted. A missing or mismatched one is refused with `400 MAGIC_CONTACT_UNVERIFIED` | [telegram](../telegram/README.md) — "Forward the WHOLE contact" |
| **6** | On a **400**, relay `error.message` to the chat | The refusals are written to be read by the user ("I don't recognise this number…"). Swallowing them leaves the user staring at silence | [magic-login.md](./magic-login.md) refusal table |
| **7** | **Disable link previews** on these replies — `disable_web_page_preview` (Telegram) / `preview_url: false` (WhatsApp) | Belt and braces. The magic link points at the storefront, not at a `GET` that signs you in, precisely so a preview crawler cannot spend the token — but a preview card of a sign-in page is noise regardless | [MESSAGING-LOGIN.md](../../MESSAGING-LOGIN.md) § 3.5 |

### One trap worth reading twice — item 4 and 5 together

**`/reset-password` also returns `requestContact: true`** on an unknown chat, and its
contact-share is posted as `login_contact` **too — the same mapping**. The contact message carries
the phone number and the sender and **nothing about which command was asked**.

**Nothing special is needed on the n8n side:** keep posting `login_contact` for *any* inbound
contact. The platform records a short-lived pending intent when it renders the prompt and reads it
when the contact arrives, so the reply you get back is whichever command the user was answering.
Do **not** try to branch on which command was asked — n8n does not have the information, and the
platform does.

---

## What NOT to do

- **Do not send an identity in `payload`.** The identity is read from the webhook `context`
  (`chat_id` / WhatsApp phone id) and never from a caller-supplied field. On `/login` a
  caller-supplied identity is outright account takeover.
- **Do not log the reply body.** `message` carries the magic link and the 8-character code
  because it must; they are session credentials. The result deliberately carries **no separate
  `token` or `code` field** for exactly this reason — a webhook response body is logged in more
  places than a chat message.
- **Do not transfer a Telegram identity between accounts.** If one is already bound elsewhere the
  platform refuses; that refusal is correct and is not a bug to route around.
- **Do not auto-create anything.** A number with no account, or an account with no `customer`
  role, gets a refusal message, never a provisioned account.

---

## How to know it actually took

Three checks, in this order. Each fails distinctly, which is the point.

1. **`/connect` still works.** If it stopped, item 1 or the secret broke something shared — fix
   that before looking at sign-in.
2. **WhatsApp `/login` from a number that has a customer account** → a message containing a link
   and an 8-character code, and the link opens the storefront's magic page (not the API).
3. **Telegram `/login` from a chat the platform has never seen** → the contact prompt with a
   working "Share my phone number" button; tapping it signs in; **a second `/login` from that same
   chat is instant** (the connection persisted, so the prompt must not appear twice).

Then, on the platform side, `npm run verify:messaging-login` against the same environment.

When 1–3 pass, record the date in [`MESSAGING-LOGIN.md`](../../MESSAGING-LOGIN.md) § 8 — that
document is the record of what was handed off and when it went live.
