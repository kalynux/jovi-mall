# Customer auth — registration and sign-in

**The customer's whole auth story, in one page.** It is different from every other role's, and
the difference is not a detail: a customer never types a password, and never fills in a
registration form.

> ## TL;DR for the storefront
>
> | | Where it happens | What the frontend calls |
> |---|---|---|
> | **Register** | in the **WhatsApp / Telegram bot** — the account is created when they first interact with it | **nothing.** Send the user to the bot |
> | **Sign in** | the user sends **`/login`** to the bot and gets a link + a code | `POST /api/auth/magic/link` or `POST /api/auth/magic/code` |
> | **Password** | there isn't one | — |
>
> **Do not build a customer registration form, and do not show a customer a password field.**
> Both lead nowhere. See [What not to build](#what-not-to-build).

Full endpoint-level contract for the two sign-in endpoints: **[magic-login.md](./magic-login.md)**.
The rest of the auth surface (every other role, tokens, refresh, cookies):
[README.md](./README.md).

---

## Why it works this way

A customer account is created with a **system-generated password that is hashed and disclosed
to nobody, including the customer**. `User.password_hash` stays satisfied and the reset flow has
something to replace — but the resulting hash matches no credential in existence.

That single fact drives everything below. There is no password to type, so the sign-in has to
come from somewhere the platform can already prove the person controls: the phone number behind
their WhatsApp or Telegram account.

---

## 1. Registration — send them to the bot

**The account is created on the customer's first interaction with the bot.** The storefront's
whole job is to get them there.

```
Storefront "Sign up" / "Create account"
        │
        └── deep-link the user into the WhatsApp or Telegram bot
                │
                └── first interaction → the account exists
                        │
                        └── they send /login → link + code → signed in on the site
```

There is **no registration endpoint for the storefront to call.** Account creation on first
contact is bot-side backend work, landing with the n8n integration; nothing about it is a
frontend concern and no request shape is owed to you.

### The deep links

Two variables on the server, `WA_BOT_NUMBER` and `TELEGRAM_BOT_NAME`, produce these:

| Channel | Deep link | Note |
|---|---|---|
| WhatsApp | `https://wa.me/<WA_BOT_NUMBER>?text=<url-encoded command>` | `wa.me` **can** pre-fill the message |
| Telegram | `https://t.me/<TELEGRAM_BOT_NAME>` | Telegram **cannot** pre-fill; the user types the command |

> ⚠️ **There is no public endpoint that serves these to an anonymous visitor.** The API returns
> them only on `GET /api/me/connections`, which requires a session — useless on a signup page,
> where by definition there isn't one. **Put the bot number and bot name in the storefront's own
> configuration.** If that becomes a problem, ask for a `/api/public/*` route and it can be added.

### What the bot does with an unknown number today

Until bot-side registration ships, a `/login` from a number with no account is answered:

> *"I don't recognise this number. Create an account on the website first, then send /login again."*

Treat this as transitional copy. It changes when registration-on-first-contact lands, and it
changes bot-side — no frontend change follows from it.

### `POST /auth/register` still exists, and is not the customer path

The endpoint accepts `role: "customer"` (see [README.md](./README.md#post-authregister)), and
for a customer it **strips `password` if you send one** and generates one instead. It is not
removed, and business roles still use it — but a storefront should not drive customer signup
through it. Send them to the bot.

---

## 2. Sign-in — the bot mints, the site redeems

```
Customer sends  /login  to the WhatsApp or Telegram bot
        │
        ├── 1. a magic LINK        → tap it on the phone in their hand
        │
        └── 2. an 8-character CODE → type it on the desktop across the room
                                     paired with their phone number or email

both expire in 10 minutes · spending either kills the other · single use
```

Two credentials because they solve different problems. Neither is a fallback for the other —
offer both.

### Redeeming the link — `POST /api/auth/magic/link`

The link points at **your** page, not at the API: `STOREFRONT_URL/login/magic?t=<token>`.

**The storefront owes exactly one page.** It reads `?t=`, POSTs the token, and redirects on
success. Show a **spinner, not a button** — the user already expressed intent by tapping.

```jsonc
POST /api/auth/magic/link
{ "token": "Xk3vQ7…" }
```

> ⚠️ **It is a POST, and it must stay one.** WhatsApp and Telegram *fetch* URLs to build preview
> cards. A GET that signs you in is spent by the crawler before the user ever taps — a dead
> link, every time, for every user.

### Redeeming the code — `POST /api/auth/magic/code`

```jsonc
POST /api/auth/magic/code
{ "identifier": "+237600000000", "code": "4B2K91QN" }
```

- `identifier` — phone (E.164) **or** email, the same field `POST /auth/login` takes.
- `code` — 8 characters, **case-insensitive and forgiving**: `4b2k-91qn`, `4B2K 91QN` and
  `4B2K91QN` are the same code, `O` reads as `0`, `I`/`L` as `1`. **Send whatever the user
  typed** — do not uppercase, strip or normalise it client-side.

Both endpoints answer identically:

```jsonc
{ "success": true, "data": { "role": "customer", "user": { "…": "…" } }, "message": "Signed in" }
```

and set `access_token` (15 min) and `refresh_token` (30 days), both HttpOnly. **No tokens in the
body.** From here the session is indistinguishable from a password login — same claims, same
lifetimes, same revocation, same `GET /api/auth/me`.

Errors, the Telegram contact-share step, and the rate limits are in
[magic-login.md](./magic-login.md#post-apiauthmagiclink).

---

## 3. Telegram needs one extra step, once

WhatsApp's sender id **is** the phone number, so it matches the account directly. A Telegram
`chat_id` bears no relation to any phone number, so a first-time Telegram sender is anonymous —
the bot asks them to tap **"Share my phone number"**, and the contact message completes the
flow. They do not send `/login` again.

Nothing about this reaches the frontend. It is noted here only so support can explain it.

---

## 4. A customer *can* acquire a real password

Two entrances, both minting the same token, redeemed at the same
`POST /auth/reset-password`:

- `POST /auth/forgot-password` with their phone or email — delivered over **email *and*
  WhatsApp**.
- **`/reset-password`** sent to the bot.

Once they have set one, `POST /auth/login` works for them like any other role. Most never will.

> **Design consequence, stated rather than left to be found:** `password_changed_at` is this
> service's only session-revocation lever, and a customer who has never reset has never set one.
> A "sign out everywhere" for customers does not currently exist.

---

## 5. The support entrance — an operator-issued sign-in link

An administrator can have the platform send a customer a sign-in link on their behalf:
`POST /api/internal/admin/users/:userId/login-link` with `{ channel: 'email' | 'whatsapp' |
'telegram' }`.

It is the **same** ten-minute, single-use, `customer`-scoped credential the bot mints — a third
*entrance*, not a third mechanism, so it lands on the same `/login/magic` page and the same two
endpoints. The response carries a masked destination and **no token**, and the destination is
read from the customer's own record, never from the request.

It is customers-only, for the same reason `/login` is: a vendor, agency or agent reaches money
and other people's data, and signs in with a password. Those roles get a reset link instead
(`…/password-reset-link`).

Not a storefront surface — it lives on the admin dashboard. Listed here because it is a third
way a customer session gets created, and support will ask about it.

---

## What not to build

| Don't | Why | Instead |
|---|---|---|
| A customer registration form | There is no endpoint behind it, and `POST /auth/register` would create an account whose password nobody can use | A button that deep-links to the bot |
| A password field on the customer sign-in form | A customer who has never run a reset has no password; `POST /auth/login` will always refuse them | The code box, plus a "sign in with WhatsApp/Telegram" button |
| Copy that says *"no account with that number"* | `MAGIC_CODE_INVALID` is deliberately one code for four situations — differentiating it would make the endpoint a registration oracle | *"That code did not work — send `/login` again for a new one."* |
| Normalising the code before sending it | The server is already forgiving about case, spacing, `O`/`0` and `I`/`L`; client-side cleanup only introduces disagreements | Send it verbatim |
| Calling the cookie endpoints from the customer app | A Capacitor WebView's origin makes our cookie third-party, and `Set-Cookie` is a forbidden response header it cannot read anyway — the session would appear to succeed and then every request would 401 | `POST /api/auth/mobile/magic/{link,code}`, which returns the pair in `data.tokens`. Same service, same errors, same strict rate-limit bucket — see [magic-login.md](./magic-login.md#bearer-clients--apiauthmobilemagic) |

---

## Related

- [magic-login.md](./magic-login.md) — the endpoint-level contract, the refusal table, the
  Telegram contact step, rate limits, and the n8n mapping
- [README.md](./README.md) — the rest of the auth surface: every other role, tokens, refresh,
  cookies, the 90-day cap
- [../connections/README.md](../connections/README.md) — `/connect`, the other bot-minted code.
  A customer who signs in via the bot has connected that channel by doing so
- [../customer/profile.md](../customer/profile.md) — the profile they land on
