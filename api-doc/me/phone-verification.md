# Phone verification — WhatsApp OTP

`/api/me/phone/verify/*` · all authenticated roles · `requireAuth`

## Why this exists beside `/api/me/phone/confirm`

There are **two proofs of a phone number**, and they are not alternatives you pick between —
each serves accounts the other cannot reach.

| | `POST /api/me/phone/confirm` | `POST /api/me/phone/verify/confirm` |
|---|---|---|
| Proof | an existing WhatsApp **connection** on that number | a **six-digit code** sent to it |
| Strength | stronger — a message actually *arrived* from the number | weaker — we sent the code ourselves |
| Serves | customers (they reach the platform through the bot) | **vendor · agency · agent · admin** |
| Body | `{}` | `{ "code": "123456" }` |

Dashboard roles never register through the bot, so they hold no connection and
`phone_verified` could never become true for them. That is what this flow is for. **The
customer path is unchanged** — do not route customers here when they have a connection.

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

`delivery` is `"text"` inside Meta's 24-hour service window and `"template"` outside it. It is
reported because it is the first thing to ask in support when a code did not arrive.

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

⛔ **Measured 2026-09-14: NEITHER template can be used, and out-of-window verification does not
work.** The fallback machinery below is built, tested and inert. Both halves failed on Meta's
side, for the same underlying reason:

| | What Meta said |
|---|---|
| `wi_mall_phone_verification` (AUTHENTICATION) | **cannot be created.** Code 10, subcode 2388185, *"This WhatsApp Business Account doesn't have permission to create a message template"*. The category is gated behind business verification and this WABA's owning business is `business_verification_status: "rejected"`. UTILITY templates create normally on the same credential, which is what isolates it to the category. |
| `wi_mall_phone_verification_utility` (UTILITY) | **created, then REJECTED at review within minutes**, `rejected_reason: INCORRECT_CATEGORY` — in both languages. |

⛔ **The UTILITY route is closed by Meta, not by an implementation detail.** Resubmitting with
`allow_category_change: true` — which lets Meta assign the category it thinks correct rather
than refusing — came back `REJECTED` **synchronously**. Meta classifies one-time-password
content as AUTHENTICATION and will not accept it anywhere else; the category it wants is the one
this WABA cannot use. Rewording the copy to read as something other than a verification code
would be evading that classifier rather than satisfying it, and the WABA carrying all 188 other
templates is what would be at risk.

✅ **There is one real fix: resolve the business verification.** The AUTHENTICATION template then
creates, the first path starts succeeding, and the fallback is never reached — no code change
and no redeploy, because the order never changed. Set `PHONE_VERIFY_FALLBACK_TEMPLATE_NAME=`
(empty) to close the fallback explicitly in the meantime; it changes no behaviour today beyond
skipping one send that is going to fail.

⚠ **In-window verification is unaffected and works.** A user who has messaged the platform in
the last 24 hours gets the code as free-form text, which needs no template and no approval. It
is only the out-of-window path — a dashboard user who has never messaged the bot — that is
closed.

If **both** fail — or the fallback is closed and the first fails — the request answers
`PHONE_VERIFICATION_DELIVERY_FAILED` and names both templates. That loudness is deliberate: a
verification code that silently never arrives is indistinguishable, to the person waiting, from
a platform ignoring them. Which template actually carried a given code is a server log line,
not a field.

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
