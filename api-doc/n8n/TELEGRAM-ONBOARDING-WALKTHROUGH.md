# Telegram onboarding, turn by turn — every request and every response

**Status:** written 2026-08-26. **Every response body below was captured from a live
`npm run dev` server**, not composed by hand — chat id `900000771`, phone `+237699000771`,
`language: "fr"`. Timestamps and `candidateRef` values are the real ones from that run.

This is the literal wire trace for **one brand-new Telegram customer**, from their first
message to the moment you answer the question they originally asked. Contract reference:
[bot-surface.md § 11](./bot-surface.md).

> **The one thing to internalise before reading on**
>
> Every response tells you what to say. On success it is `data.onboarding.next.prompt`; on
> failure it is `error.customerMessage`. Both are already in the customer's language. **You
> never compose a sentence and you never translate one.** If you find yourself writing copy
> in the workflow, you are working around something.

> ### ⭐ UPDATED 2026-08-26 — read this before the `sendMessage` blocks below
>
> **You no longer compose the REQUEST either.** Every response now carries a top-level
> `reply` holding the complete, channel-ready request body — text, keyboard, button labels,
> all of it — and your only job is to POST it:
>
> ```
> POST  https://api.telegram.org/bot<TOKEN>/{{ $json.reply.method }}
> body  {{ $json.reply.body }}
> ```
>
> Contract: [bot-surface.md § 14](./bot-surface.md#14--reply--the-request-body-you-post-to-the-channel-unmodified).
>
> **Every `### → Telegram sendMessage` block below is now a CAPTURE of `reply.body`, not a
> set of assembly instructions.** Three specific instructions in this document are
> **obsolete**, and each is marked ✅ where it appears:
>
> 1. *"The button's own label is the one string you must supply… from a four-entry table in
>    the workflow"* — the label ships in `reply.body`, in five languages. Delete that table.
> 2. *"`next.requestContact` is absent now, so remove the keyboard"* — every reply that
>    carries no keyboard of its own carries `remove_keyboard`. There is no branch to write.
> 3. *"Put the *index* in `callback_data` and keep the refs in the execution's own state"* —
>    the `candidateRef` **is** the `callback_data`. It measures 46 bytes against Telegram's
>    64-byte cap, so the truncation that instruction was written to avoid does not occur.
> 4. **(2026-08-27)** *"You decide what counts as a skip… mapping passer / skip / saltar /
>    omitir / تخط"* — there is no word to map. A skippable step ships a **Skip button**
>    carrying `skip:<step>`, the same token in every language, and the prompt went back to
>    being a plain question. The general rule — **a closed answer set is always a button,
>    never typed text** — is
>    [bot-surface.md § 14.6](./bot-surface.md#146--a-determined-answer-is-a-button-never-a-typed-word),
>    and it governs every future turn with yes/no-shaped answers.
>
> Everything else on this page — the requests, the `data` bodies, the error table — is
> unchanged and still correct.
>
> ⚠ **The `← 200 OK (real response)` captures below were taken before this field existed and
> are left exactly as they were captured**, so they show `data` without the `reply` beside it.
> Re-capturing them would have meant re-running the trace with a different chat id and losing
> the real `candidateRef` values this page is worth reading for. Read them as "`data` is
> unchanged"; § 14 of the contract carries a full captured envelope with both halves.

---

## 0 · The constants for every call

```http
POST http://localhost:8022/api/internal/bot/identity/sync
Content-Type: application/json
Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
X-Webhook-Secret: <BOT_WEBHOOK_SECRET>
Idempotency-Key: tg-<update_id>
X-Request-Id: <optional, your own correlation id>
```

**Both credentials are required.** A leaked service token alone must not open every
customer's cart and orders, so the webhook secret is a second, separately-rotated lock.
Missing service token → `401 AGENT_SERVICE_TOKEN_INVALID`; missing secret →
`401 WEBHOOK_SECRET_INVALID`.

**`Idempotency-Key` is required on both routes and `tg-<update_id>` is the right value.**
Telegram's `update_id` is unique per update and stable across a redelivery, which is
precisely the property the key needs. Do not use a timestamp or a UUID generated per attempt
— a retry would then look like a new request and the guard would do nothing.

**The `identity` object goes on every request body**, beside the operation's own arguments:

```jsonc
"identity": {
  "channel": "telegram",
  "externalId": "900000771",   // message.chat.id — as a STRING
  "displayName": "Ada Nkeng",  // from.first_name + " " + from.last_name
  "handle": "@adankeng",       // "@" + from.username
  "language": "fr"             // from.language_code  ⚠ forward this, see Turn 1
}
```

⚠ **`externalId` must come from the webhook, never from anything the customer typed.** There
is no `customerId` or `userId` parameter on any route, and the envelope is `.strict()` — a
caller-supplied identity would be account takeover, so sending one is a `400` rather than a
silently ignored field.

---

## Turn 1 · An unknown chat sends a normal message

### ← Inbound from Telegram

```jsonc
{
  "update_id": 774100001,
  "message": {
    "message_id": 41,
    "from": {
      "id": 900000771, "is_bot": false,
      "first_name": "Ada", "last_name": "Nkeng",
      "username": "adankeng", "language_code": "fr"
    },
    "chat": { "id": 900000771, "type": "private", "first_name": "Ada" },
    "date": 1787923044,
    "text": "Bonjour, avez-vous des chaussures rouges ?"
  }
}
```

### What you do with it

**Hold `message.text` in the workflow.** This is the question you will answer at Turn 6, and
the backend does not store it — deliberately, because a durable column of raw customer
message text in the profile collection has no retention policy and a Redis stash is one more
expiry to reason about. The n8n execution that received the question is where it lives.

Then call `sync`.

### → `POST /api/internal/bot/identity/sync`

```jsonc
{
  "identity": {
    "channel": "telegram",
    "externalId": "900000771",
    "displayName": "Ada Nkeng",
    "handle": "@adankeng",
    "language": "fr"
  }
}
```

⚠ **Forward `language_code` as `identity.language`.** Before an account exists there is no
profile to read, so this is the *only* thing deciding whether that first prompt is French or
English. After the account exists it is ignored — a device locale must not override a
deliberate `/language` choice.

### ← `200 OK` (real response)

```jsonc
{
  "success": true,
  "data": {
    "registered": false,
    "isNew": false,
    "upgraded": false,
    "state": "anonymous",
    "customer": null,
    "onboarding": {
      "complete": false,
      "steps": [
        { "step": "phone",   "required": true,  "state": "pending", "at": null },
        { "step": "name",    "required": true,  "state": "pending", "at": null },
        { "step": "email",   "required": false, "state": "pending", "at": null },
        { "step": "address", "required": false, "state": "pending", "at": null }
      ],
      "next": {
        "step": "phone",
        "required": true,
        "skippable": false,
        "field": "contact",
        "kind": "phone_contact",
        "prompt": "D'abord, j'ai besoin de votre numéro de téléphone pour créer votre compte. Appuyez sur le bouton ci-dessous pour le partager.",
        "requestContact": true
      },
      "outstandingRequired": ["phone", "name"],
      "remaining": 4
    }
  }
}
```

### How you handle it

`registered: false` with a `200` is **not an error**. A Telegram `chat_id` maps to no phone
number, so there is genuinely no account yet — but "I need your number" is the ordinary first
turn of a Telegram conversation, not a failure.

`next.requestContact === true` → attach the contact keyboard. **Branch on presence, not on
value** — the key is absent, never `false`, everywhere else.

### → Telegram `sendMessage`

```jsonc
{
  "chat_id": 900000771,
  "text": "D'abord, j'ai besoin de votre numéro de téléphone pour créer votre compte. Appuyez sur le bouton ci-dessous pour le partager.",
  "reply_markup": {
    "keyboard": [[{ "text": "📱 Partager mon numéro", "request_contact": true }]],
    "one_time_keyboard": true,
    "resize_keyboard": true
  }
}
```

✅ **OBSOLETE since 2026-08-26 — the label comes from the API now.** This paragraph used to
read: *"The button's own label is the one string you must supply, because it is Telegram
chrome rather than a message. Key it off `identity.language` from a four-entry table in the
workflow."* That was the last piece of copy this document handed to the workflow, and it sat
on the one turn where a stranger decides whether to give up their phone number. The whole
block above is now `reply.body`, label included, in five languages. **Everything on this
page comes from the API.**

---

## Turn 2 · They tap the button

### ← Inbound from Telegram

```jsonc
{
  "update_id": 774100002,
  "message": {
    "message_id": 43,
    "from": { "id": 900000771, "first_name": "Ada", "username": "adankeng", "language_code": "fr" },
    "chat": { "id": 900000771, "type": "private" },
    "date": 1787923061,
    "contact": {
      "phone_number": "237699000771",
      "first_name": "Ada",
      "last_name": "Nkeng",
      "user_id": 900000771          // ⚠ THE FIELD EVERYTHING RESTS ON
    }
  }
}
```

### → `POST /api/internal/bot/identity/onboarding`

```jsonc
{
  "identity": { "channel": "telegram", "externalId": "900000771",
                "displayName": "Ada Nkeng", "handle": "@adankeng", "language": "fr" },
  "step": "phone",
  "contact": {
    "phoneNumber": "237699000771",
    "userId": "900000771",
    "firstName": "Ada",
    "lastName": "Nkeng"
  }
}
```

⚠ **Pass `contact.user_id` through untouched, and never substitute `from.id` for it.** A
Telegram user can forward somebody else's contact card out of their address book and it
arrives in exactly this shape with a *different* `user_id` — or none at all. The backend
compares it against the envelope's `externalId` and refuses a mismatch. If you "helpfully"
sent `from.id` in that field, the comparison would always succeed and the guard would be
worthless: an attacker could have an account created against a stranger's phone number.

⚠ **`phoneNumber` goes through as Telegram sent it.** Some clients include a leading `+`,
some do not. The backend repairs it to strict E.164. Do not normalise it yourself.

### ← `201 Created` (real response — truncated to what changed)

```jsonc
{
  "success": true,
  "data": {
    "registered": true,
    "isNew": true,                    // ⭐ the account was created by THIS call
    "upgraded": false,
    "state": "customer",
    "customer": {
      "state": "customer", "isCustomer": true,
      "displayName": "Ada Nkeng", "language": "fr",
      "connectedChannels": ["telegram"],
      "hasOpenOrders": false,
      "identityHint": "@adankeng"
    },
    "onboarding": {
      "complete": false,
      "steps": [
        { "step": "phone",   "required": true,  "state": "provided", "at": "2026-08-26T14:37:24.058Z" },
        { "step": "name",    "required": true,  "state": "pending",  "at": null },
        { "step": "email",   "required": false, "state": "pending",  "at": null },
        { "step": "address", "required": false, "state": "pending",  "at": null }
      ],
      "next": {
        "step": "name", "required": true, "skippable": false,
        "field": "name", "kind": "text",
        "prompt": "Quel nom dois-je utiliser pour vous ? C'est le nom qui figurera sur vos livraisons."
      },
      "outstandingRequired": ["name"],
      "remaining": 3
    }
  }
}
```

### How you handle it

`201` + `isNew: true` — the account exists now. **`isNew` is true exactly once in this
account's life**, so it is the correct trigger for a one-time welcome. Do not greet on
`!onboarding.complete`; that is true on every message until the checklist finishes.

✅ **OBSOLETE — no branch to write.** This used to read: *"`next.requestContact` is absent
now, so remove the keyboard."* Every Telegram reply that carries no keyboard of its own now
carries `remove_keyboard` already; it is a no-op against a chat with no keyboard, so the
rule needs no knowledge of what the previous turn rendered.

### → Telegram `sendMessage`

```jsonc
{
  "chat_id": 900000771,
  "text": "Quel nom dois-je utiliser pour vous ? C'est le nom qui figurera sur vos livraisons.",
  "reply_markup": { "remove_keyboard": true }
}
```

### ⚠ The failure branch — a contact that is not theirs

Sending `userId: "555555555"` against chat `900000771` produced this **real** response:

```jsonc
{
  "success": false,
  "requestId": "045bcc00-81b3-4bf5-a768-2e73ea23e220",
  "error": {
    "code": "MAGIC_CONTACT_UNVERIFIED",
    "message": "Please use the \"Share my phone number\" button so Telegram can confirm the number is yours.",
    "statusCode": 400,
    "category": "validation",
    "customerMessage": "Ce contact n'est pas le vôtre. Utilisez le bouton pour partager votre propre numéro."
  }
}
```

**Relay `customerMessage`, re-send the contact keyboard, and stay on this step.** No account
was created. Note that `message` and `customerMessage` are different strings for different
readers — `message` is for your logs.

---

## Turn 3 · They type their name

### ← Inbound

```jsonc
{ "update_id": 774100003,
  "message": { "message_id": 45, "from": { "id": 900000771, "language_code": "fr" },
               "chat": { "id": 900000771 }, "text": "Ada Nkeng" } }
```

### → `POST /identity/onboarding`

```jsonc
{ "identity": { "channel": "telegram", "externalId": "900000771",
                "displayName": "Ada Nkeng", "handle": "@adankeng", "language": "fr" },
  "step": "name",
  "name": "Ada Nkeng" }
```

`action` defaults to `"provide"`, so you may omit it.

### ← `200 OK` — the part that changed

```jsonc
"next": {
  "step": "email", "required": false, "skippable": true,
  "field": "email", "kind": "email",
  "prompt": "Souhaitez-vous ajouter une adresse e-mail ?"
}
```

✅ **UPDATED 2026-08-27 — the prompt is now just the question, and the option is a BUTTON.**

This capture and the note under it used to read *"Souhaitez-vous ajouter une adresse e-mail ?
C'est facultatif — dites simplement « passer » si vous préférez."* and *"The prompt already
tells them they may skip… every optional step says so in its own sentence."*

The sentence taught the customer a word to type, and that word differs per language — so
something had to map *passer · skip · saltar · omitir · تخطٍّ* onto `action: "skip"`, in the
layer with no copy table. `reply` now ships the button:

```jsonc
"reply": { "channel": "telegram", "method": "sendMessage", "body": {
  "chat_id": 900000771,
  "text": "Souhaitez-vous ajouter une adresse e-mail ?",
  "reply_markup": { "inline_keyboard": [[{ "text": "Passer", "callback_data": "skip:email" }]] }
}}
```

The label is translated; `callback_data` is the same string in every language. Still do not
append your own "(optional)".

---

## Turn 4 · They decline the email

### ← Inbound

```jsonc
{ "update_id": 774100004,
  "message": { "message_id": 47, "chat": { "id": 900000771 }, "text": "passer" } }
```

✅ **OBSOLETE — you no longer decide what counts as a skip.** This used to read: *"You decide
what counts as a skip. The backend takes `action: "skip"`; mapping the words passer / skip /
saltar / omitir / تخط — or an inline button — is the workflow's job."*

The inbound event is now a **tap**, not the text `"passer"`:

```jsonc
{ "update_id": 774100004,
  "callback_query": { "id": "…", "from": { "id": 900000771 },
                      "message": { "chat": { "id": 900000771 } },
                      "data": "skip:email" } }
```

Split `data` on `:` → `{ step: "email", action: "skip" }`. One rule per verb, and the whole
table is [bot-surface.md § 14.6](./bot-surface.md#146--a-determined-answer-is-a-button-never-a-typed-word).
No language is involved anywhere on that path. (The customer may still *type* their email on
that turn — the button is the other answer, not the only one.)

### → `POST /identity/onboarding`

```jsonc
{ "identity": { … }, "step": "email", "action": "skip" }
```

### ← `200 OK` (real response — the `steps` array is the point)

```jsonc
"steps": [
  { "step": "phone",   "required": true,  "state": "provided", "at": "2026-08-26T14:37:24.058Z" },
  { "step": "name",    "required": true,  "state": "provided", "at": "2026-08-26T14:37:24.165Z" },
  { "step": "email",   "required": false, "state": "skipped",  "at": "2026-08-26T14:37:24.189Z" },
  { "step": "address", "required": false, "state": "pending",  "at": null }
],
"next": {
  "step": "address", "required": false, "skippable": true,
  "field": "address", "kind": "geo_candidate",
  "prompt": "Dernière question : où dois-je livrer ?"
},
"outstandingRequired": [],
"remaining": 1
```

⚠ **`state: "skipped"` is durable.** They will never be asked for an email again, on any
future message, forever — which is the entire reason this checklist is stored rather than
derived from whether the field is empty.

Note `outstandingRequired` is now `[]` while `complete` is still `false`: both required steps
are done, so this account **can already check out**. Only the optional tail remains.

### If they had tried to skip a REQUIRED step

```jsonc
{ "error": { "code": "BOT_ONBOARDING_STEP_NOT_SKIPPABLE", "statusCode": 422,
             "category": "business_rule",
             "customerMessage": "Ce n'est pas possible pour le moment.",
             "details": { "step": "name" } } }
```

Relay `customerMessage` and re-ask the same step. Read `next.skippable` and you will never
send this.

---

## Turn 5 · The address — two calls, because coordinates never cross the wire

### ← Inbound

```jsonc
{ "update_id": 774100005,
  "message": { "message_id": 49, "chat": { "id": 900000771 }, "text": "Akwa, Douala" } }
```

### → `POST /api/internal/bot/geo/search`

```jsonc
{ "identity": { … }, "q": "Akwa, Douala", "limit": 3 }
```

### ← `200 OK` (real response)

```jsonc
{
  "success": true,
  "data": [
    {
      "candidateRef": "gc_H4qqMw2tPIKtx4sQrY8HuTzmtQS94EU2cMAZ0T_33Mk",
      "formattedAddress": "Akwa, Douala I, Wouri, Littoral, Cameroun",
      "components": { "street": null, "neighbourhood": "Akwa", "city": "Douala I",
                      "region": "Littoral", "country": "Cameroun", "countryCode": "CM" }
    },
    {
      "candidateRef": "gc_XmuXnf9sEdvozgVIn-dXAw9lh4fepo-KLUPMkFTvrVk",
      "formattedAddress": "École Bilingue la Pouponnière d&apos;AKWA, Rue 1.491, Camp Yabassi, Douala, Wouri, Littoral, Cameroun",
      "components": { "street": "Rue 1.491", "neighbourhood": "Camp Yabassi", "city": "Douala",
                      "region": "Littoral", "country": "Cameroun", "countryCode": "CM" }
    }
  ]
}
```

⚠ **There are no coordinates in that response and there is no way to send any.** You get an
opaque `candidateRef` and hand it straight back. Two reasons, and the second has already cost
this platform something: a machine that can build a `geo` object can build a wrong one, and a
`null` inside the 2dsphere-indexed saved-address array makes the **whole customer document
unwritable** — which presents as "this customer cannot be edited at all".

⚠ **`candidateRef` is single-use and expires in 30 minutes.** Do not cache it across a
conversation.

> ✅ **A defect this walkthrough surfaced, now FIXED (2026-08-26).** The capture above was
> taken before the fix and is left as it was: `d&apos;AKWA` is an HTML entity the provider
> returned, which jovi-mall passed through unescaped into the chat window, the delivery label
> and the stored `order.delivery_address`. Providers HTML-escape because their data comes
> from OpenStreetMap.
>
> `SanitizedGeocodingProvider` now decodes on the way out of `createGeocodingProvider`, so
> every adapter is covered and so is any future one. **That second result now reads
> `d'AKWA`.** The geocoding cache key moved `v1 → v2` in the same change, because entries
> written before the fix would otherwise have served the broken string for their full 24-hour
> TTL — for exactly the popular addresses. Pinned by `npm run test:geocoding-sanitize` (44).

### → Telegram `sendMessage` — let them choose

```jsonc
{
  "chat_id": 900000771,
  "text": "Laquelle est la bonne ?",
  "reply_markup": { "inline_keyboard": [
    [{ "text": "Akwa, Douala I, Wouri, Littoral", "callback_data": "addr:0" }],
    [{ "text": "École Bilingue la Pouponnière…",  "callback_data": "addr:1" }]
  ]}
}
```

✅ **OBSOLETE, and it was wrong about the measurement.** This used to read: *"`callback_data`
is capped at 64 bytes and a `candidateRef` is ~47 — it fits, but only just. Put the index in
`callback_data` and keep the refs in the execution's own state. A ref plus any prefix you add
will silently truncate."*

A handle is `gc_` plus 43 base64url characters — **46 bytes against a 64-byte cap**, measured
and pinned by `test:bot-surface`. The backend now builds this keyboard and puts the
**`candidateRef` itself** in `callback_data`, so post `callback_query.data` straight back as
`geoCandidateRef` and keep nothing in the execution's state. (The renderer still drops the
keyboard rather than truncating if an id ever does exceed the cap — a picker that looks
perfect and does nothing when tapped is the failure that instruction was guarding against,
and it is now guarded structurally.)

### ← They pick one, then → `POST /identity/onboarding`

```jsonc
{
  "identity": { … },
  "step": "address",
  "address": {
    "label": "Maison",
    "geoCandidateRef": "gc_H4qqMw2tPIKtx4sQrY8HuTzmtQS94EU2cMAZ0T_33Mk",
    "addressLine2": "portail bleu"
  }
}
```

`label` is yours to pick (or ask for). `addressLine2` is the flat number, the landmark, the
directions — everything a geocoder never knows. `isDefault` is unnecessary: the **first**
address a customer saves is made default automatically.

### ← `200 OK` (real response — onboarding closes)

```jsonc
{
  "success": true,
  "data": {
    "registered": true, "isNew": false, "upgraded": false, "state": "customer",
    "customer": { "displayName": "Ada Nkeng", "language": "fr",
                  "connectedChannels": ["telegram"], "hasOpenOrders": false,
                  "identityHint": "@adankeng", "state": "customer", "isCustomer": true },
    "onboarding": {
      "complete": true,                 // ⭐ THE SIGNAL
      "steps": [
        { "step": "phone",   "required": true,  "state": "provided", "at": "2026-08-26T14:37:24.058Z" },
        { "step": "name",    "required": true,  "state": "provided", "at": "2026-08-26T14:37:24.165Z" },
        { "step": "email",   "required": false, "state": "skipped",  "at": "2026-08-26T14:37:24.189Z" },
        { "step": "address", "required": false, "state": "provided", "at": "2026-08-26T14:37:55.799Z" }
      ],
      "next": null,
      "outstandingRequired": [],
      "remaining": 0
    }
  }
}
```

### ⚠ The failure branch — a spent or stale handle

Replaying the same `geoCandidateRef` produced this **real** response:

```jsonc
{
  "success": false,
  "requestId": "7deef5b8-21ac-438a-919f-7fae867b6f23",
  "error": {
    "code": "BOT_GEO_CANDIDATE_EXPIRED",
    "message": "That address candidate is unknown or has expired — run the search again",
    "statusCode": 400,
    "category": "validation",
    "customerMessage": "Cette recherche d'adresse a expiré. Redonnez-moi l'adresse et je la rechercherai.",
    "details": { "candidateRef": "gc_zM95M1u7Orwu39oYJ44wSP8Lan_bq3FqOuCEELB3xSM" }
  }
}
```

The remedy is **always** to run `geo/search` again. Never re-send held coordinates — there
are none to hold, which is the point.

---

## Turn 6 · Answer the question from Turn 1

`onboarding.complete` just flipped `false → true`. **That transition is your cue**, and it is
the only place the held message is used.

```jsonc
{
  "chat_id": 900000771,
  "text": "Parfait, votre compte est prêt ! Vous me demandiez des chaussures rouges — voici ce que j'ai trouvé…"
}
```

Then run whatever tool the original message called for — `products_search`, `cart_add_item`,
and so on. From here the conversation is ordinary.

⚠ **Watch the transition, not the value.** `complete: true` is on every subsequent response
for the rest of the account's life; replaying the held message on all of them would answer
the same question forever.

---

## Turn 7 · Every message after that

### → `POST /identity/sync`

Same body as Turn 1. Still called on **every** inbound message.

### ← `200 OK` (real response)

```jsonc
{
  "success": true,
  "data": {
    "registered": true, "isNew": false, "upgraded": false, "state": "customer",
    "customer": { "state": "customer", "isCustomer": true,
                  "displayName": "Ada Nkeng", "language": "fr",
                  "connectedChannels": ["telegram"], "hasOpenOrders": false,
                  "identityHint": "@adankeng" },
    "onboarding": { "complete": true, "steps": [ … ], "next": null,
                    "outstandingRequired": [], "remaining": 0 }
  }
}
```

`complete: true` + `next: null` + `isNew: false` → skip onboarding entirely and go straight
to serving the message. **This is cheap and writes nothing** — the resolution is one indexed
lookup on `channel_connections`, which is why calling it every time is the design rather than
an extravagance.

`customer.hasOpenOrders` is there so you can open with *"your parcel is on its way"* when it
is worth mentioning. `customer.language` is what you use for any string you do supply.

---

## The complete decision table

Everything you branch on, in one place.

| Response | Meaning | What you do |
|---|---|---|
| `200` · `registered: false` | Telegram, unbound chat | Send `next.prompt` + contact keyboard |
| `201` · `isNew: true` | Account created by this call | Welcome them **once**, then send `next.prompt` |
| `200` · `upgraded: true` | An existing vendor/agency/agent gained a customer profile | Nothing special — treat as a customer |
| `200` · `complete: false`, `next` non-null | Mid-onboarding | Send `next.prompt`; keyboard iff `next.requestContact` |
| `200` · `complete: true`, `next: null` | Ready | Serve the message. On the *transition*, replay the held one |
| `400 MAGIC_CONTACT_UNVERIFIED` | Contact was not theirs | `customerMessage` + re-send the keyboard |
| `400 BOT_ONBOARDING_VALUE_REQUIRED` | You sent `provide` with no value | Workflow bug. `details.field` names it |
| `400 BOT_GEO_CANDIDATE_EXPIRED` | Handle spent or stale | `customerMessage`, then `geo/search` again |
| `409 BOT_ONBOARDING_NOT_REGISTERED` | A non-`phone` step with no account | Workflow bug — you skipped `next`. `details.availableStep` |
| `409 BOT_REGISTRATION_IDENTITY_TAKEN` | This chat belongs to another account | `customerMessage`. Escalate to support |
| `422 BOT_ONBOARDING_STEP_NOT_SKIPPABLE` | Skipped a required step | Workflow bug — read `next.skippable` |
| `403 AUTH_ACCOUNT_SUSPENDED` | Account suspended or closed | `customerMessage`. **Do not retry** — no second account will be made |
| `400 BOT_IDEMPOTENCY_KEY_REQUIRED` | No `Idempotency-Key` header | Workflow bug |
| `409 BOT_IDEMPOTENCY_IN_PROGRESS` | The same key is still in flight | Wait ~1s and retry the same key |
| `503 BOT_IDEMPOTENCY_STORE_UNAVAILABLE` | Redis unreachable; **nothing ran** | Retry with backoff, same key |
| `503` on `identity/sync` in a maintenance window | Read-only mode refuses account creation | Fall back to `identity/resolve` |

**Rule of thumb:** if `error.category` is `validation` or `conflict` **and** the code ends in
a step name, it is your workflow that is wrong. Everything else is relayable to the customer
as `customerMessage`.

---

## The ONE string the API does *not* give you

✅ **This section used to list three, and two of them are gone.** It read: *"The three strings
the API does not give you — the contact button label, skip-word recognition, and the Turn-6
bridge sentence."*

1. ~~**The contact button label**~~ — ships in `reply.body`, in five languages.
2. ~~**Skip-word recognition**~~ — there is no word to recognise. It is a button carrying
   `skip:<step>`, identical in every language.
3. **The Turn-6 bridge sentence** — *"Parfait, votre compte est prêt ! Vous me demandiez…"*.
   **Still yours, and it always will be:** it quotes the message the customer sent at Turn 1,
   which only your execution is holding. This is the one place on the page where you compose.

Key it off `identity.language` (before an account exists) or `customer.language` (after).

---

## WhatsApp, in one paragraph

The same two endpoints with `"channel": "whatsapp"` and `externalId` set to the `wa_phone_id`
**exactly as Meta sends it — bare digits, no `+`.** The backend repairs it to E.164;
"helpfully" adding a `+` is one of the few ways to break this. The flow is shorter by two
turns: the sender id *is* the phone number, so Turn 1 answers `201 isNew: true` immediately
with the `phone` step already `provided` and `next.step: "name"`, and Turn 2 never happens.
`requestContact` never appears — WhatsApp has no equivalent mechanism. Everything from Turn 3
on is identical.

---

## Related

- [bot-surface.md](./bot-surface.md) — the full contract; § 11 is registration and onboarding
- [tools/catalog.json](./tools/catalog.json) — the machine-readable tool definitions
- [BACKEND-GAPS.md](./BACKEND-GAPS.md) — § GAP-002, the plan, with its two reversed decisions
- [../auth/magic-login.md](../auth/magic-login.md) — where `requestContact` was established
