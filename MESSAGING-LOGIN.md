# `/login` — passwordless customer sign-in from WhatsApp / Telegram

> ## ✅ BUILT — 2026-08-16
>
> All nine build-order steps landed. `npm run test:messaging-login` is green at **124**
> (DB-free) and `npm run verify:messaging-login` at **24** (needs Redis + Mongo);
> `tsc`, `lint`, and `test:{system,errors,env,connections,mobile-auth}` are clean, and the
> server boots with all three commands registered. Live contract:
> **`api-doc/auth/magic-login.md`**; the durable summary is `CLAUDE.md` §"Messaging login".
>
> **Four things were built differently from this document, each for a stated reason. Read
> them before treating the text below as current:**
>
> 1. **§3.3's pointer TTLs were wrong and would have made expiry unreachable.** The table
>    gives the record `600s + grace` and the pointers `600s`. A token whose pointer had
>    lapsed could then never resolve to its record, so `MAGIC_LINK_EXPIRED` /
>    `MAGIC_CODE_EXPIRED` would never be raised and every late user would be told INVALID —
>    the exact failure the grace window exists to prevent, and §9's "an expired record
>    answers EXPIRED" would have failed. **Both credential pointers now carry `TTL + grace`;
>    the identity pointer keeps the validity alone**, since an expired session needs no
>    revoking.
> 2. **Redis key names are HASHED.** §3.3 spells them `login:token:{token}` and
>    `login:code:{CODE}`. But `/system/cache/keys` lists key names to any developer-tools
>    caller and offers no value read — which is precisely the reasoning §6 already applies to
>    the attempt counter ("Redis key names reach the ops surface"). Leaving the two actual
>    session credentials in clear while hashing the semi-public phone number was incoherent,
>    so `digestForKey` covers the token, the code, the identity **and** the attempt
>    identifier. Values are untouched; that is where the raw material lives.
> 3. **The contact guard compares against the CONTEXT's `chat_id`, not a payload `from.id`.**
>    D-1 specifies `contact.user_id === from.id`, but if both sides come from the payload the
>    guard is satisfiable by anyone who can reach the webhook — it is not a guard. In a
>    Telegram private chat `chat.id` and `from.id` are the same number, and `chat_id` is the
>    value the controller established. A payload `from.id` is still honoured when present and
>    must also agree.
> 4. **`ConsumeLoginResult.expired` carries its record.** Without it, `redeemCode` cannot
>    confirm the code belongs to the account the caller *named* before deciding to say
>    "expired" — and expiry then becomes the oracle `MAGIC_CODE_INVALID` exists to close.
>
> Smaller deviations: the 8-character code lives in its own `domain/login-code.ts` (the plan's
> tree named only `login-token.ts`); `commands/webhook-context.ts` holds the shared sender
> parsing; `MAGIC_SESSION_GENERATION_FAILED` (500) was added to mirror
> `CONNECTION_CODE_GENERATION_FAILED`; the "vendor account" refusal copy says *business*
> account, because the account may be an agency or an agent and a message that guesses wrong
> reads as a bug.
>
> **One fix outside this feature was required:** `telegram.controller.ts` flattened *every*
> webhook error into `INTERNAL_SERVER_ERROR`, keeping only the message — so
> `MAGIC_CONTACT_UNVERIFIED` was erased on the only channel that can raise it. An `AppError`
> is now forwarded unchanged.
>
> **The feature is inert until the n8n work in §8 is done.** Nothing in this repository can
> complete it.
>
> ### ➕ Extended 2026-08-16: `/reset-password`
>
> A second bot command was added after this plan, at the product owner's request, and it
> changed two things the text below states as settled:
>
> - **The Telegram contact-share now serves TWO commands**, so §4.2's "no Redis state is
>   needed between `/login` and `login_contact`" no longer holds. The contact message says
>   nothing about which command was asked, so the prompt records a short-lived pending intent
>   (`services/pending-intent.store.ts`) and `login_contact` reads it. It defaults to `login`,
>   the lesser outcome. n8n is unaffected — it still posts `login_contact` for any contact.
> - **`/reset-password` is NOT customer-scoped.** §1's "a `/login` session is always scoped to
>   the `customer` role" is still true of `/login`; the reset command serves vendor, agency,
>   agent and customer alike, because a password belongs to the `users` row. It mints through
>   the EXISTING `PasswordResetService` — same token, same 30 minutes, same
>   `POST /auth/reset-password` — so it is a new entrance, not a second mechanism.
>
> Contract for both: `api-doc/auth/magic-login.md`.

**Status: BUILT.** The plan for the `/login` bot command and the two sign-in
credentials it hands out. It builds on the messaging-connection mechanism
(`src/modules/channel-connections/`, see `CLAUDE.md` §"Messaging connections") and reuses its
CommandBus registration, its code alphabet, and its Redis conventions.

Three design questions were settled before this draft; §2 records the answers and why.

---

## 1. What it does

```
Customer sends  /login  to the WhatsApp or Telegram bot
        │
        ├── the bot replies with TWO credentials for the same session:
        │
        │   1. a magic LINK        → tap it, signed in on that device
        │   2. an 8-character CODE → type it on the site with your phone or email
        │
        └── both expire in 10 minutes; using either kills the other
```

Two credentials because they solve different problems. The link is for the phone already in
the user's hand — one tap, no typing. The code is for the desktop in front of them when
WhatsApp is on a phone across the room.

**A `/login` session is always scoped to the `customer` role.** No other role is reachable
this way, whatever else the account holds.

---

## 2. The three settled decisions

### D-1. Telegram resolves identity by asking for a **verified contact**, not by a new column

**The problem.** WhatsApp's `wa_phone_id` **is** the sender's phone number, so it matches
`User.login_phone` directly — possession of the number is proved by the message itself, the
same model as an SMS OTP. Telegram's `chat_id` bears no relation to any phone number, so a
first-time Telegram sender is anonymous to us.

**Storing a `telegram_chat_id` does not by itself fix this** — a column is storage, and what
was missing is *verification*. Nothing can populate it on a first interaction, because at that
moment nothing has proved which human the chat belongs to. Writing it from an unverified
message would be worse than not having it: whoever sent the message would choose whose account
they log into.

**What closes the gap: Telegram's `request_contact`.** A keyboard button that asks the sender
to share their own phone number; Telegram returns a `contact` object carrying a
`phone_number` **it verified at signup**. That is exactly the missing proof, and it makes the
Telegram flow equivalent to WhatsApp's.

```
/login  from an unknown Telegram chat
   → bot replies with a "Share my phone number" button      (n8n renders request_contact)
   → user taps; Telegram sends a verified contact
   → n8n posts it as the `login_contact` command
   → we match the phone → account, PERSIST the mapping, and mint the credentials
   → every later /login from that chat is instant
```

> ### ⚠ The one guard that makes this safe: `contact.user_id === from.id`
>
> A Telegram user can share **somebody else's** contact card from their address book, and it
> arrives in the same shape. Without this check, anyone could forward a victim's contact and
> sign in as them — a one-message account takeover. Only a contact whose `user_id` equals the
> sender's own `id` is the sender's Telegram-verified number. **A contact with a missing or
> mismatched `user_id` must be refused outright**, not treated as a hint.

**The mapping lives in `channel_connections`, not on `User`.** That table already *is* this
mapping — `(user_id, channel, external_id)` with unique indexes in both directions — it is
already read by all four notification stacks, and it is what `/connect` writes. A
`telegram_chat_id` column beside it would be a second source of truth for one fact, which is
precisely the shape Phases 2–6 removed when they deleted the `wa` sub-document from four role
models. Two mappings drift, and the drift is a login bug.

So the contact-share becomes a **second, verified way to create a connection row** — one that
does not need a session. Resolution order, both channels:

1. `channel_connections.findByIdentity(channel, external_id)` → `user_id`. Instant.
2. **WhatsApp only:** normalise `wa_phone_id` to E.164, match `User.login_phone`. Persists the
   connection on success, so step 1 serves every later `/login`.
3. **Telegram only:** reply with the contact-share button; `login_contact` completes it and
   persists the connection.

A pleasant side effect: a customer who signs in via Telegram has *connected* Telegram by doing
so, and their Telegram notifications start working with no extra step.

> ### ⚠ Step 2 needs an explicit `+`, or it matches nothing at all
>
> `wa_phone_id` arrives from Meta as **bare digits** (`237600123456`), and `login_phone` is
> stored as strict E.164 (`+237600123456`). The shared helpers do **not** bridge that gap —
> verified against the real code:
>
> ```
> normalizePhoneNumber('237600123456') → '237600123456'   (strips formatting; adds no '+')
> isE164('237600123456')               → false            (E164_PATTERN = /^\+[1-9]\d{6,14}$/)
> toE164('237600123456')               → null
> ```
>
> So a naive `findByPhone(wa_phone_id)` queries `login_phone: '237600123456'` and matches
> **nothing, for every user** — a feature that silently reports "no account found" to
> everybody while looking correctly implemented. The resolver must prepend `+` when the value
> is all digits, then run `toE164` and refuse a `null`. Cover it with a fixture in both
> suites; it is the single easiest way to ship this feature broken.
>
> *(The E.164 back-fill migration is **not** a prerequisite — this is development and there are
> no legacy rows to repair, and `RegisterSchema` holds `phone` to `PhoneNumberSchema` so every
> new row is conformant. It becomes one only if this ever ships against a database that
> predates that enforcement.)*

### D-2. Eight characters over the Crockford alphabet — 2⁴⁰

Reusing `channel-connections/domain/connection-code.ts`'s alphabet
(`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no I/L/O/U, case-insensitive, `O→0` and `I/L→1`), at
**length 8**:

| | `/connect` code | `/login` code |
|---|---|---|
| Shape | 6 chars, 32 symbols | **8 chars, 32 symbols** |
| Space | 32⁶ ≈ 2³⁰ | 32⁸ ≈ **2⁴⁰** — about a **million times** larger than 6 digits |
| A correct guess gets… | your account linked to a stranger's WhatsApp | **that stranger's account** |

The larger space is the right call precisely because the blast radius differs: a `/login` code
grants a session, and the phone/email it is paired with is semi-public — so it is not really a
second factor and the code must stand on its own. At 2⁴⁰ it does, and the per-identifier
attempt limit in §6 goes back to being a backstop rather than the entire margin.

**The two codes are different lengths, which makes them non-interchangeable by construction.**
A connection code physically cannot be submitted as a login code, so a user pasting the wrong
one gets a clean rejection rather than a confusing partial match.

> Implementation note: generalise the existing generator to take a length
> (`generateCode(length)`), rather than copying it. The alphabet, the unbiased `byte & 31`
> sampling and the normaliser are shared; only the length differs.

### D-3. The link carries an opaque token, not an encrypted payload

32 random bytes, base64url, used as a Redis key. Not a JWT and not an encrypted blob, because
a self-contained token:

- **cannot be revoked** — which makes "using the code kills the link" unimplementable;
- **carries account data** into a chat log, a URL bar and every proxy in between;
- **needs key management**, and a leaked key forges sessions for every account at once.

An opaque lookup key has nothing to decrypt, leaks nothing if intercepted after expiry, and is
revoked with a `DEL`. Same shape as the password-reset token this service already issues.

---

## 3. Architecture

### 3.1 Reused unchanged

| Need | Existing thing |
|---|---|
| Bot command registration | `modules/commands/index.ts` + `CommandBus` |
| Sender identity | the `context` the two webhook controllers build (`wa_phone_id` / `chat_id`) |
| Identity → account, and persisting it | `channel-connections` repository (`findByIdentity`, `bind`) |
| Code alphabet + normaliser | `channel-connections/domain/connection-code.ts` (generalised to a length) |
| Phone normalisation | `core/validation/phone.ts` — `normalizePhoneNumber`, `toE164` |
| Session issuance | `core/auth/token.issuer.ts` — `issueTokenPair(userId, 'customer')` |
| Cookie delivery | `config/cookie.config.ts` — `setAuthCookies` |
| Rate limiting | mounting under `/api/auth` inherits the strict credential bucket |
| Redis registration | `REDIS_DB_CATALOG` + `CACHE_FLUSH_POLICY` (both — `test:system` asserts parity) |

### 3.2 New module — `src/modules/messaging-login/`

```
src/modules/messaging-login/
  domain/
    login-token.ts               opaque token generation. Pure.
  commands/
    login.command.ts             /login, both channels
    login-contact.command.ts     the Telegram contact-share completion
  services/
    login-session.store.ts       Redis (issue / consume-by-token / consume-by-code / attempts)
    identity-resolver.service.ts D-1's three steps, in one place
    messaging-login.service.ts   mint, redeem, issue session
  dto/messaging-login.dto.ts
  validators/messaging-login.validator.ts
  messaging-login.controller.ts
  messaging-login.routes.ts
  index.ts
```

Kept **separate from `channel-connections`**. They share an alphabet and a webhook and nothing
else: one mints a credential for an identity nobody owns yet, the other mints a credential that
**grants a session on an existing account**. Folding them together would put a passwordless
login path inside the module every notification service imports, and would make one blast
radius look like the other.

### 3.3 The Redis record

New logical database **`LOGIN_CODE_DB = 14`** (13 is `CONNECTION_CODE_DB`). Separate rather
than a prefix on 13, because `cache-flush-policy.ts` states consequences per database and
*"in-flight sign-ins fail"* is not *"in-flight connections fail"*.

**One session record, two keys pointing at it** — this is what makes "using either kills both"
true without a second source of truth:

| Key | Value | TTL |
|---|---|---|
| `login:session:{sessionId}` | the record below | 600s + grace |
| `login:token:{token}` | `sessionId` | 600s |
| `login:code:{CODE}` | `sessionId` | 600s |
| `login:identity:{channel}:{externalId}` | `sessionId` | 600s |
| `login:attempts:{identifierHash}` | integer | 600s |

```jsonc
{
  "userId":       "…",         // the only thing needed to issue a session
  "customerId":   "…",         // resolved at mint, so redemption is one read not three
  "channel":      "whatsapp",
  "identityHint": "••••3456",  // for the "signed in from WhatsApp ••••3456" audit line
  "createdAt":    "…",
  "expiresAt":    "…"
}
```

Redemption: key → `sessionId` → record → **delete the record and every pointer**, in that
order. Deleting the record first is what spends both credentials at once.

> Store **ids, not a snapshot**. A suspension, a role change or a deletion inside the ten
> minutes must be seen at redemption; a cached copy would not see it. The record is a pointer
> with a deadline, not a session.

> The `login:identity:` pointer means a second `/login` from the same messaging account
> **revokes the first**, so one person never has more than one live credential pair.

### 3.4 Redemption endpoints

Both under **`/api/auth`**, which is not cosmetic: that prefix carries the credential bucket
(20/min/IP), and `rate-limit/auth-paths.ts` is an **allowlist**, so a route added there inherits
the *strict* bucket automatically. These are credential endpoints.

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/magic/link` | `{ token }` | Redeem the magic link |
| `POST` | `/api/auth/magic/code` | `{ identifier, code }` | Redeem the code with a phone or email |

Both **set the two auth cookies** — same session model as `POST /auth/login`, no tokens in the
body:

```json
{ "success": true, "data": { "role": "customer", "user": { … } }, "message": "Signed in" }
```

### 3.5 ⚠ The magic link must point at the STOREFRONT, not this API

`STOREFRONT_URL/login/magic?t=…`, and that page POSTs the token to `/api/auth/magic/link`. Two
reasons, the first a real bug if ignored:

- **Link previews would spend the token.** WhatsApp and Telegram *fetch* URLs to build preview
  cards. A `GET` endpoint that signs you in is consumed by the crawler before the user taps —
  a dead link, every time. A `POST` from a page the crawler does not execute cannot be
  triggered that way.
- It follows the password-reset precedent, recorded there for the same reason: a browser flow
  needs a page, and only the frontend has one.

**n8n should also disable link previews** on these replies (`disable_web_page_preview` /
`preview_url: false`) — belt and braces, and a tidier message.

---

## 4. The bot commands

Registered beside `connect` in `modules/commands/index.ts`. Same contract: the handler
**returns** the reply text and n8n relays it; this service sends no message itself.

**Identity comes from the webhook `context`, never from `payload`.** Same rule as `/connect`,
and here it is load-bearing rather than merely correct: a caller-supplied identity on this
command is outright account takeover.

### 4.1 `/login`

**Reply on success**

```
Tap to sign in on this device:
https://shop.jovi-mall.com/login/magic?t=Xk3…

Or go to jovi-mall.com and sign in with your phone number and this code:
4B2K91QN

Both expire in 10 minutes and can be used once.
If you did not ask to sign in, ignore this message.
```

**Reply when Telegram does not recognise the chat** — the contact-share prompt. n8n renders a
`request_contact` keyboard; the handler returns the prompt text plus a marker
(`requestContact: true`) telling n8n which keyboard to attach.

**Refusals**

| Situation | Reply |
|---|---|
| No matching account | "I don't recognise this number. Create an account at jovi-mall.com first." |
| Account holds no `customer` role | "This number is registered as a vendor account. Sign in with your password at jovi-mall.com." — **never auto-provision a customer role** |
| `User.status !== 'active'` | "This account is not active. Contact support." |
| Telegram identity already bound to a **different** account | "This Telegram account is already connected to another account." Refuse; never transfer. |

Telling the sender their own number is unrecognised leaks nothing — they control it. Do **not**
mint a decoy credential.

### 4.2 `login_contact` (Telegram only)

Dispatched when n8n sees a `contact` on an inbound message.

1. **Refuse unless `contact.user_id === from.id`** — see D-1's guard. This is the whole
   security of the flow.
2. `toE164(contact.phone_number)`; a number that will not normalise is refused.
3. Match `User.login_phone` → apply the same refusal table as `/login`.
4. **Persist the connection** (`channel_connections.bind`) so later logins skip all of this.
5. Mint and reply exactly as `/login` does — the user does not send `/login` again.

No Redis state is needed between `/login` and `login_contact`: the contact message carries both
the chat id and the verified phone, so the two dispatches are independent.

### 4.3 Result shape

```jsonc
{ "success": true, "message": "…the text above, for n8n to relay…", "expiresInSeconds": 600 }
```

⚠ **The result must NOT carry the token or the code as separate fields.** `/connect` returns
`code` beside `message` for the automation layer's convenience; here they are session
credentials, and a webhook response body is logged in more places than a chat message.
`message` carries them because it must; nothing else should. Neither may ever be logged.

---

## 5. Redemption rules

### `POST /api/auth/magic/link` — `{ token }`

1. `login:token:{token}` → `sessionId`. Missing → `401 MAGIC_LINK_INVALID`.
2. Load and **delete** the session record and every pointer.
3. Past `expiresAt` → `401 MAGIC_LINK_EXPIRED` (grace window, exactly as connection codes).
4. **Re-check every gate at redemption, not at mint**: user exists, `status === 'active'`,
   still holds `customer`, customer profile still exists.
5. `issueTokenPair(userId, 'customer')` → `setAuthCookies`.

### `POST /api/auth/magic/code` — `{ identifier, code }`

Same, plus:

- `identifier` is a phone **or** an email — reuse `login`'s `includes('@')` discrimination and
  the same normalisers.
- Resolve code → `sessionId` → record, then **assert the record's `userId` matches the account
  the identifier resolves to.** A mismatch answers exactly like a wrong code.
- **Never distinguish** unknown identifier, wrong code, expired-and-swept, or mismatch. One
  code, one message — otherwise the endpoint is a registration oracle answering *"is this phone
  a customer here?"* for anyone, for any number.

### Error codes

Added to `core/error-codes.ts` + `core/errors.ts`; each raised at exactly one status
(`test:errors` censuses this).

| Code | Status | When |
|---|---|---|
| `MAGIC_LINK_INVALID` | 401 | Unknown, malformed, or already spent |
| `MAGIC_LINK_EXPIRED` | 401 | Real, and past its 10 minutes |
| `MAGIC_CODE_INVALID` | 401 | Wrong code, unknown identifier, or mismatch — **one code for all three** |
| `MAGIC_CODE_EXPIRED` | 401 | Real, and past its 10 minutes |
| `MAGIC_ATTEMPTS_EXCEEDED` | 429 | Over the per-identifier ceiling |
| `MAGIC_CONTACT_UNVERIFIED` | 400 | A shared contact that is not the sender's own |
| `AUTH_ACCOUNT_SUSPENDED` | 403 | Existing code, reused |

401 rather than 400: these are credentials, and the remedy is to obtain another.

---

## 6. Rate limiting

| Layer | Scope | Ceiling | Notes |
|---|---|---|---|
| A — global | IP | 1200/min | existing |
| credential bucket | IP | **20/min** | inherited from the `/api/auth` mount |
| per-identifier attempts | the targeted account | **5 per 10 min** | key on a **hash** of the normalised identifier — Redis key names reach the ops surface |
| per-identity `/login` mints | messaging identity | 1 live pair, revoke-on-reissue | the `login:identity:` pointer |

**Count the attempt before consuming**, as `/connect` does — otherwise a guesser spends other
people's live codes for free.

At 2⁴⁰ (D-2) these are backstops rather than the only margin, which is the point of choosing 8
characters over 6 digits.

---

## 7. Customers are passwordless in practice — what that changes

Customers will be registered with a **system-generated password, hashed and never disclosed**.
So `User.password_hash` stays `required: true` and the model needs no change — but three things
follow, and they are the reason this is its own section:

- **`RegisterSchema` must stop requiring `password` for `role: 'customer'`**, and must
  **ignore** one if sent rather than accept it. Accepting a caller-supplied password would
  create customers whose password somebody else chose and knows.
- **Generate with `crypto.randomBytes`, not a helper that could be predictable**, and keep it
  under bcrypt's 72-byte input limit. It must never be logged, returned, or included in any
  DTO — it exists only so the column is satisfied and so the reset flow has something to
  replace.
- **`/login` therefore becomes the primary customer sign-in path**, not a convenience.
  `POST /auth/login` will always fail for a customer who has never reset — correctly, but the
  storefront's sign-in form should route customers to the messaging flow rather than showing
  them a password field that cannot work.

**The reset path already mostly exists.** `POST /auth/forgot-password` delivers over **email
*and* WhatsApp** (`password-reset.service.ts`), keyed on `login_phone` — so a customer who
wants a real password can already ask for one, and the WhatsApp delivery makes that reachable
for the email-less majority. Whatever the customer reset flow becomes, it starts from working
machinery rather than nothing.

**One consequence to accept deliberately:** `password_changed_at` is this service's only
session-revocation lever, and a customer who has never reset has never set it. Combined with
the sliding 30-day refresh (see `api-doc/auth/README.md`), a stolen customer session has no
revocation path at all. Pre-existing, and not this feature's to fix — but this feature makes
sessions much easier to obtain, so it is the right moment to decide whether "sign out
everywhere" is needed.

### Bearer clients are out of scope

Both endpoints set cookies. The magic link opens the system browser and the code is typed on
the website, so cookies are right for both. A Capacitor WebView cannot use them — if the
customer app needs this it needs a `/api/auth/mobile/magic/*` twin returning `data.tokens`,
exactly as the mobile namespace does elsewhere. **Deliberately not built until asked for.**

---

## 8. Build order

1. Generalise the code generator to a length parameter; keep `/connect` at 6.
2. `LOGIN_CODE_DB = 14` → `redis.factory.ts` constants + `REDIS_DB_CATALOG` +
   `cache-flush-policy.ts`, all three in one change.
3. Error codes + registry messages.
4. `domain/login-token.ts`, `services/login-session.store.ts`.
5. `services/identity-resolver.service.ts` — D-1's three steps, the `+`-prepend, and the
   refusal table. **Write this one's tests first**; it is where the feature fails silently.
6. `commands/login.command.ts` + `commands/login-contact.command.ts` + registration.
7. Controller, validators, routes; mount under `/api/auth`.
8. Customer registration: generated password, `RegisterSchema` change.
9. Docs — `api-doc/auth/magic-login.md`; `api-doc/auth/README.md` endpoint table **and** its
   "complete auth surface" claim; both bot pages gain `/login` and `login_contact`;
   `CLAUDE.md` §"Messaging login".

No data migration. Development, no legacy rows — see the note under D-1.

**n8n work, outside this repo** — and the feature is inert without it:
- map `/login` → `command: "login"`, relay `message`
- render a `request_contact` keyboard when the result carries `requestContact: true`
- detect an inbound `contact` and post it as `command: "login_contact"` with `from.id`
- disable link previews on these replies
- send `X-Webhook-Secret` (already required for `/connect`)

> ### 📤 Handed off 2026-08-21 — [`api-doc/auth/N8N-HANDOFF.md`](./api-doc/auth/N8N-HANDOFF.md)
>
> The operator-facing version of the list above: seven items, each with why it matters and a link
> to the canonical contract, plus the three end-to-end checks that prove it took. Phase 6 Step 1
> ([`PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md`](../PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md)).
>
> Platform side re-verified the same day: `test:messaging-login` **158 / 0**.
> `BOT_WEBHOOK_SECRET` is set (Phase 2, step 2.E.4).
>
> **Went live on the n8n side:** _not yet — record the date here when checks 1–3 on that page pass._

## 9. Verification

**`npm run test:messaging-login`** — DB-free, hand-rolled asserts, following `test:connections`:

- token entropy and shape; the code is 8 chars from the agreed alphabet and a fixed point of
  the normaliser
- **the `contact.user_id === from.id` guard**, with a forwarded-contact fixture asserted refused
  — the single highest-value test in the suite
- **a bare-digits `wa_phone_id` resolves to the right account**, asserted against a fixture
  stored as `+237…`. This is the silent-failure case from D-1: without the `+` prepend the
  resolver returns "no account found" for everybody and every other test still passes
- the refusal table via injected fakes (no account / no customer role / suspended / Telegram
  identity owned by another account / identifier mismatch), asserting **one** error code across
  the four indistinguishable cases
- gates re-checked at **redemption**: plant a record whose user is suspended after minting and
  assert refusal
- using the link kills the code, and vice versa
- **LEAK assertions**: the command result carries no `token`/`code` field; no log line contains
  either; the attempt key is a hash, not a raw phone number; the generated customer password
  never appears in any DTO or log
- **SOURCE SCANS**: redeem routes under `/api/auth` (so they inherit the credential bucket);
  identity read from `context`, never `payload`; the magic link built from `STOREFRONT_URL`,
  never `API_PUBLIC_URL`

**`npm run verify:messaging-login`** — NEEDS Redis + Mongo, writes and removes its own
`verify-login-*` fixtures:

- WhatsApp `/login` resolves by `login_phone` with no connection present, and **persists** the
  connection so a second `/login` takes the fast path
- Telegram `/login` prompts for contact when unknown; `login_contact` completes it, persists,
  and mints
- both credentials point at one record; spending either invalidates the other, atomically under
  concurrency
- TTLs are 600s; an expired record answers `EXPIRED`, an unknown one `INVALID`
- a real `POST /api/auth/magic/{link,code}` sets both auth cookies and `GET /api/auth/me`
  answers as `customer`

**Then**: `npx tsc --noEmit`, `npm run lint`, boot the server (the only place a circular
import, a duplicate model registration or a silently failed index build shows up), and re-run
`test:system`, `test:errors`, `test:env` — all three are affected structurally by the new Redis
database, the new codes and the new variables.
