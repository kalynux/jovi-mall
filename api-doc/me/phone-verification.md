# Phone verification — WhatsApp OTP

`/api/me/phone/verify/*` · all authenticated roles · `requireAuth`

## Why this exists beside `/api/me/phone/confirm`

There are **two proofs of a phone number**, and they are not alternatives you pick between —
each serves accounts the other cannot reach.

| | `POST /api/me/phone/confirm` | `POST /api/me/phone/verify/confirm` |
|---|---|---|
| Proof | an existing WhatsApp **connection** on that number | a **six-digit code** sent to it |
| Strength | stronger — a message actually *arrived* from the number | weaker — we sent the code ourselves |
| Serves | the bot surface (`contact_confirm_phone`) | **every dashboard and the storefront** — customer · vendor · agency · agent · admin |
| Body | `{}` | `{ "code": "123456" }` |

Dashboard roles never register through the bot, so they hold no connection and
`phone_verified` could never become true for them. That is what this flow was built for.

⭐ **Customers use it too** (owner decision, 2026-09-21). A customer changing their number on the
storefront gets the code, instead of being told to message the bot from the new number. The
connection proof stays for the bot surface only. When the code completes a change, the account's
WhatsApp link moves off the number being given up. See
[contact-change.md](contact-change.md#the-phone-proof-is-a-whatsapp-code).

## Endpoints

### `GET /api/me/phone/verify`

What is verifiable and whether a code is in flight. Free, no side effect.

```json
{
  "success": true,
  "data": {
    "phoneMasked": "+237•••••3456",
    "completesPendingChange": false,
    "pending": true,
    "expiresAt": "2026-09-14T12:10:00.000Z"
  }
}
```

`completesPendingChange` is the field that decides your copy. When `true`, a phone change is in
flight and the code proves the **new** number — confirming it swaps the account's identifier.
When `false`, the code merely proves the number already on the account.

### `POST /api/me/phone/verify/request`

No body. The target is chosen **server-side**: the pending number if a change is in flight,
otherwise the current one.

```json
{
  "success": true,
  "data": {
    "phoneMasked": "+237•••••3456",
    "expiresAt": "2026-09-14T12:10:00.000Z",
    "delivery": "text"
  }
}
```

`delivery` is `"text"` when the code went as a free-form message inside Meta's 24-hour service
window, and `"template"` otherwise: outside the window, **or inside it when the free-form send was
refused** and the backend fell back to the template. It is reported because it is the first thing
to ask in support when a code did not arrive.

⚠ **`"template"` does not tell you WHICH template.** Two are tried in order outside the window
(see below) and both report `"template"` — deliberately, so a client cannot come to depend on a
fallback that is meant to be retired. Which one carried the code is in the server log.

### `POST /api/me/phone/verify/confirm`

```json
{ "code": "123456" }
```

⚠ **The body is `.strict()` and accepts only `code`.** Sending `phone` alongside it is a `400`,
not a silently-stripped field — the number was fixed when the code was minted. A caller that
could name the number could prove control of one and have another marked verified.

```json
{ "success": true, "data": { "phone": "+237600123456", "changed": true } }
```

`changed: true` means the account's login phone moved; `false` means the existing number was
verified in place.

## Refusals

| Code | Status | Meaning | What the client should do |
|---|---|---|---|
| `PHONE_VERIFICATION_NO_TARGET` | 422 | no number on the account | send them to `PATCH /api/me/phone` first |
| `PHONE_VERIFICATION_CODE_INVALID` | 422 | wrong code | show `details.attemptsLeft`, let them retype |
| `PHONE_VERIFICATION_CODE_EXPIRED` | 422 | past its TTL, or nothing in flight | offer "send a new code" |
| `PHONE_VERIFICATION_TOO_MANY_ATTEMPTS` | 429 | attempt limit spent | the code is destroyed — request a new one |
| `PHONE_VERIFICATION_RESEND_TOO_SOON` | 429 | cooldown | `details.retryAfterSeconds` — disable the button for that long |
| `PHONE_VERIFICATION_DELIVERY_FAILED` | 502 | WhatsApp refused the send | retryable; see below |

`INVALID` and `EXPIRED` are deliberately **distinct**, because the remedies differ: retype
versus request a new code. Collapsing them sends people hunting for a typo that is not there —
the same reasoning as `CONNECTION_CODE_EXPIRED`.

`details.attemptsLeft` is disclosed on purpose. It tells the holder of the real code that they
mistyped and how much room is left; it tells an attacker only what they could count themselves.
The secret is the code, not the counter.

## Limits

| | Default | Variable |
|---|---|---|
| Code lifetime | 10 min | `PHONE_VERIFY_TTL_SECONDS` |
| Wrong guesses | 5 | `PHONE_VERIFY_MAX_ATTEMPTS` |
| Resend cooldown | 60 s | `PHONE_VERIFY_RESEND_COOLDOWN_SECONDS` |

⚠ The **attempt limit is the security of a six-digit code**, not its length. The cooldown is
**account-scoped**, not per target number — a number-scoped gate bounds nothing when the caller
chooses the number.

## Outside the 24-hour window: two templates, tried in order

Only an approved template may be sent outside Meta's service window, and the backend tries
**two**, in a fixed order. **Nothing about this is visible to a client** — `delivery` is
`"template"` either way, deliberately, so no frontend can come to depend on which one went out.

1. **`wi_mall_phone_verification`** — category `AUTHENTICATION`, always tried first. It is where
   one-time-password content belongs: Meta supplies the localised body, the "do not share this
   code" line and the expiry notice, and it carries a copy-code button.
2. **`wi_mall_phone_verification_utility`** — category `UTILITY`, tried only if the first send
   fails.

✅ **The out-of-window TEMPLATE problem is solved as of 2026-09-15.** The first template is
approved and the second is never reached.

✅ **THE THIRD REASON — the 131037 display-name gate — CLOSED ON 2026-09-16, by CHANGING THE
NUMBER.** The platform now sends from **+237 652 705 926** (`1263609603508344`), display name
**Wi-Mall**, `name_status: "APPROVED"`. The previous number had never had a display name
submitted and Meta's ten-changes-per-month quota for it was already spent, so it was replaced
rather than repaired — a new number takes its display name at registration instead of out of
that quota.

⚠ **An approved display name is bound to the NUMBER, while the 190 approved templates are bound
to the WABA.** The WABA did not change, so nothing needed resubmitting; the display name did not
carry over, which is exactly why replacing the number was a fix rather than a reset. Expect that
asymmetry again if the number ever moves.

✅ **A SECOND phone-scoped gate was found and closed the same day: Cloud API registration.** For
a few hours the new number read `status: "PENDING"` — verified and named, but not registered, so
**both** the in-window free-form send and the out-of-window template send would still have failed.
`POST /1263609603508344/register` closed it; it now reads `status: "CONNECTED"`,
`platform_type: "CLOUD_API"`, `quality_rating: "GREEN"`.

⚠ **Both gates are phone-scoped, and that is the durable lesson for this page.** Neither a
display name nor a Cloud API registration travels with the WABA, so **any future number change
re-opens both** while leaving the 190 approved templates untouched — the reverse of the intuition
that templates are the fragile part. Neither is visible from inside this codebase: the API answers
`PHONE_VERIFICATION_DELIVERY_FAILED` identically whichever one is short.

| | Status |
|---|---|
| `wi_mall_phone_verification` (AUTHENTICATION) | ✅ **APPROVED**, `en` + `fr` (`4426347317613316`, `1393590468966788`). Meta approved it within seconds of submission. |
| `wi_mall_phone_verification_utility` (UTILITY) | ⛔ **REJECTED and unusable** — `rejected_reason: INCORRECT_CATEGORY`, both languages. Now dead weight rather than a fallback. |

⚠ **This page said the opposite one day earlier, and knowing why prevents the wrong conclusion
being drawn from the fallback's existence.** On 2026-09-14 the AUTHENTICATION template could not
be created at all — code 10, subcode 2388185, *"This WhatsApp Business Account doesn't have
permission to create a message template"* — because Meta gates that category behind business
verification and this WABA's owning business was `business_verification_status: "rejected"`.
UTILITY templates created normally on the same credential, which is what isolated it to the
category rather than the token. The business reached **`verified`** on 2026-09-15 and the
template created on the first attempt. **No code changed**, because the send path had always
tried AUTHENTICATION first.

⛔ **The UTILITY fallback did NOT come back with it, and must never be resubmitted.** Its
rejection is about OTP **content**, not about the business — resubmitting with
`allow_category_change: true`, which lets Meta assign the category it thinks correct rather than
refusing, came back `REJECTED` **synchronously**. Meta classifies one-time-password content as
AUTHENTICATION and will not accept it anywhere else. Rewording it to read as something other than
a verification code would be evading that classifier rather than satisfying it, and the WABA
carrying all 189 other templates is what would be at risk.

Set `PHONE_VERIFY_FALLBACK_TEMPLATE_NAME=` (empty) if you want the doomed second call gone; it
changes no behaviour that works today. The knob is kept wired because a business verification can
lapse, and this WABA has already been on both sides of that line inside two days.

⚠ **In-window verification needs no template** — a user who has messaged the platform in the last
24 hours gets the code as free-form text. ✅ **As of 2026-09-16 every known gate in front of that
is clear** — display name approved, number registered, quality GREEN.

⚠ **"Needs no template approval" and "delivers" remain two different claims, and this page has
been wrong about that three times.** Every phone-scoped precondition on this account has blocked
the free-form path and the template path *together*, and each was found only after the previous
was cleared — so a closed gate has never once been evidence of delivery here. The only evidence
is a code arriving on a handset.

⛔ **That sentence was FALSE until 2026-09-15, and the correction is the whole reason the
section below exists.** The window is a Redis key, and it was written by exactly one thing:
`POST /api/webhooks/whatsapp`. The automation layer reaches that path only on its *command*
branch, so an ordinary chat message never opened it — **for anybody, ever**. Every request
therefore took the template path above, and with both templates unsendable, **every single
out-of-window and in-window attempt alike failed with `PHONE_VERIFICATION_DELIVERY_FAILED`**.
Messaging the bot first — the obvious remedy, and the one a user would try — changed nothing.

`POST /api/internal/bot/identity/sync` now stamps the window on every inbound message, on the
one path n8n calls for every message rather than only for commands. `test:connections`
§ "inbound activity is actually STAMPED" pins it, because deleting that call breaks no request
and fails no other suite.

If **both** fail — or the fallback is closed and the first fails — the request answers
`PHONE_VERIFICATION_DELIVERY_FAILED` and names both templates. That loudness is deliberate: a
verification code that silently never arrives is indistinguishable, to the person waiting, from
a platform ignoring them. Which template actually carried a given code is a server log line,
not a field.

## What a client must DO on `PHONE_VERIFICATION_DELIVERY_FAILED`

**Never ask the user to message the WhatsApp bot first.** The backend already falls back to the
approved AUTHENTICATION template wherever free-form text cannot go: outside the 24-hour window,
and inside it when the free-form send is refused anyway. So by the time this 502 comes back,
**every route was tried and WhatsApp refused them all**. Nothing the user can do in the bot
changes that.

⛔ **Until 2026-09-21 this section said the opposite**: it told clients to have the user send the
bot any message and then press Resend, so the code could go as free text. **Remove that copy and
the `wa.me` link from every frontend that built it.** It sent people to repair something they
cannot see, and it made things worse. The bot recorded the window under the bare number
(`237…`), while the send path checked it under `+237…`, a key nothing wrote. So texting the bot
steered the code onto the free-text path, the policy check refused it as "outside the window",
and the request failed with no template attempt. A user who had *not* texted the bot got the
template and could verify. Both halves are fixed: one window key whichever spelling asks
(`whatsapp.service.ts`), and a refused free-form send falls back to the template.

Required of the client:

- **Show it as a temporary failure with a Resend button**, and respect the 60-second cooldown
  (`PHONE_VERIFICATION_RESEND_TOO_SOON`, 429, `details.retryAfterSeconds`).
- **Offer a way to contact support** if it happens again. A refusal on every route is a platform
  or Meta-side fault, and support can read the reason in the server log.
- **Do not tell the user the platform is down.** ⛔ The agent app currently maps *every* 502 to
  "We can't reach our systems right now" before it reads `error.code`. Branch on the code first.

```
POST /api/me/phone/verify/request
→ 502  PHONE_VERIFICATION_DELIVERY_FAILED
   ├─ show: "We couldn't send your code on WhatsApp right now. Please try again
   │         in a minute."
   ├─ primary action: Resend (respects the 60s cooldown)
   └─ secondary action: Contact support
```

## Administrators — a different door, same mechanism

Administrators hold no `users` row in this service (they live in wi-admin's own database), so
they cannot reach `/api/me/*` at all. They go through wi-admin:

```
PATCH /api/v1/auth/me/phone                 { "phone": "+237600123456" }   ← wi-admin
POST  /api/v1/auth/me/phone/verify/request                                 ← wi-admin
POST  /api/v1/auth/me/phone/verify/confirm  { "code": "123456" }           ← wi-admin
        │
        └─→ POST /api/internal/admin/phone-verification/{request,confirm}  ← this service
```

**The work is split, and the split is the design.** jovi-mall **sends and judges** the code —
it owns the WhatsApp credentials, the 24-hour window bookkeeping and the templates, and a
second copy in wi-admin would mean two services holding the same Meta credentials and two
window caches disagreeing. wi-admin **owns the record** — the confirm here answers *"this
number was proved"* and writes nothing, because this service has no administrator row to stamp.
Same split ADR-004 D-2 already draws for every other admin operation.

Two consequences worth knowing:

- ⚠ **The OTP subject is namespaced** (`admin:<id>` vs `user:<id>`, `domain/subject.ts`).
  Administrator ids and `users._id` are both ObjectIds from independently generated spaces, so
  a bare key would let a customer and an administrator collide — one person's code overwriting
  another's, one person's cooldown throttling the other.
- ⚠ **wi-admin re-checks the proved number against its own record before stamping.** An
  administrator can change their number in the ten minutes between requesting a code and typing
  it, and this service — holding no admin record — cannot know. Without that check a code
  minted for the old number would verify the new one.

⚠ **It is a CONTACT detail, not a login factor.** Administrators already have TOTP MFA, which
is stronger than a WhatsApp OTP; nothing in wi-admin's auth path reads `phone_verified`. Wiring
it in would weaken the login, not harden it — that would be a security decision, not a
refactor.
