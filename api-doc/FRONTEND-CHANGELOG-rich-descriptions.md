# Frontend hand-off — structured descriptions (`descriptionRich`) are live

**Verified against source on 2026-09-08** — R7 re-checked every ✅ in § 1 against source
(`catalog/models/product.model.ts:201,313,489`, `core/richtext/schema.ts:23-30`,
`core/richtext/format/`, the four write schemas, `modules/telegram/services/telegram-bot.service.ts:26,91-93`)
and ran the suite. **Two things corrected:** the suite reports **148** assertions, not 149; and the
TL;DR asked the dashboard team to flip a flag they have since flipped.

**To:** the vendor dashboard team
**From:** backend (`backend/jovi-mall`)
**Re:** [`api-doc/vendor/docs_requirement.md`](./vendor/docs_requirement.md) — implemented
**Date:** 2026-08-14

---

## TL;DR — one line changes on your side

```diff
- export const RICH_DESCRIPTION_WIRE_ENABLED = false;
+ export const RICH_DESCRIPTION_WIRE_ENABLED = true;
```

`frontend/vendor-dash/src/lib/richtext/wire.ts`. **That is the whole change.**
Nothing else in the dashboard needs editing, and there is no ordering
requirement — see [Deploy order](#4-deploy-order).

> ✅ **DONE — the dashboard flipped it.** Confirmed 2026-09-08 (R7):
> `RICH_DESCRIPTION_WIRE_ENABLED` is **`true`** at `vendor-dash/src/lib/richtext/wire.ts:36`.
> This hand-off has no outstanding ask; it is now a record of what shipped.

Everything below is either confirmation that a decision of yours was honoured, or
one of **four small deltas** you should know about. None of them require code
changes; two are worth a glance.

---

## Table of contents

- [1. What shipped](#1-what-shipped)
- [2. Deltas from the brief](#2-deltas-from-the-brief)
- [3. Things you asked for that are exactly as specified](#3-things-you-asked-for-that-are-exactly-as-specified)
- [4. Deploy order](#4-deploy-order)
- [5. How to verify it end-to-end](#5-how-to-verify-it-end-to-end)
- [6. Not built, and why](#6-not-built-and-why)

---

## 1. What shipped

| Checklist item from your §10 | Status |
|---|---|
| `descriptionRich` on `IProduct` + schema as `Mixed`, default `null` | ✅ |
| **Not** added to the `product_storefront_text` index | ✅ |
| `richDocSchema` with the `href` allowlist enforced at parse time | ✅ |
| Accepted on **all four** write endpoints, the two `.strict()` ones included | ✅ |
| `null` clears; absent leaves alone | ✅ |
| Persisted in the create and update services | ✅ (five paths — see §2.1) |
| Returned by `GET /api/vendor/products/:id` and by the write responses | ✅ |
| `description` still fed to the vectoriser and the text index, unchanged | ✅ |
| Shared formatter (`toPlainText` / `toWhatsApp` / `toTelegramHtml`) | ✅ |
| `telegram-bot.service.ts` no longer sends prose under `parse_mode: 'Markdown'` | ✅ (see §2.4) |
| §9 test vectors reproduce byte-for-byte | ✅ — **148** assertions, `npm run test:rich-description` (re-run 2026-09-08: 148 passed, 0 failed; this row said 149) |

The document model, validator and both formatters live in
`src/core/richtext/` — a **file-for-file mirror** of your
`src/lib/richtext/` (`types.ts`, `doc.ts`, `limits.ts`, `schema.ts`,
`format/{shared,whatsapp,telegram}.ts`). That layout is deliberate: there is no
shared package between the two repositories, so the next person to change the
vocabulary should be able to diff the two directories and see immediately what
must move together.

Our test suite asserts our formatter output against **your** fixtures
(`tools/richtext/fixtures.ts`), copied verbatim. If either side's rendering
drifts, it fails as a byte diff here rather than as a badly-rendered customer
message.

---

## 2. Deltas from the brief

### 2.1 `POST /api/vendor/products/:id/duplicate` now copies the document

Not in the brief, and it would have been a quiet data-loss bug: duplicating a
product copied `description` and dropped `descriptionRich`, so a vendor
duplicating a formatted product would silently get an unformatted one at exactly
the moment they expected an identical starting point.

**Impact on you:** none, except that duplicate now behaves the way a vendor
expects.

### 2.2 Reads return the document verbatim, without re-validating it

`descriptionRich` is a `Mixed` column, so a document round-tripped through an
older client could in principle fail `richDocSchema` on the way back out. We do
**not** re-parse on read and do **not** null it — discarding a vendor's stored
work at read time is the wrong failure.

**Impact on you:** your `parseRichDoc(value)` on hydrate is doing real work and
should stay. It is the only validation on the read path, and your fallback
(rebuild from `description`) is the correct one. Do not assume the API guarantees
a valid document just because it guaranteed one on write.

### 2.3 `null` is the only clear signal — `''` is a 400

Your §4 asked for `null` to clear, which it does. We deliberately did **not**
route the field through this codebase's `clearable()` helper, which additionally
coerces `''` and whitespace-only strings to `null`. That normalisation is right
for a text input and meaningless for an object, and a client sending `''` here
has a bug worth hearing about rather than silently satisfying.

**Impact on you:** none — `descriptionUpdateWire` already sends `null`. Just do
not send `''`.

### 2.4 The Telegram fix was wider than the brief asked, because the bug was already live

Your §8 flagged `telegram-bot.service.ts:58` as a hazard *for descriptions*. It
was in fact already dropping messages in production, for a reason unrelated to
this feature: **all four notification stacks** (vendor, agency, agent, customer)
composed their Telegram body as `` `*${subject}*\n\n${body}` `` under legacy
Markdown, and the catalog templates interpolate user-authored values — product
titles, store names, order references, agent notes. A single `_`, `*`, `[` or
backtick in any of them made the Bot API answer `400 can't parse entities`,
`sendMessage` return `false`, and the notification vanish with only a log line. A
vendor trading as **"Chez L_Artisan"** was simply never notified of anything, and
nothing in the system said so.

What changed:

- `parseMode` is now an explicit per-call option, **defaulting to `'none'`**
  (no `parse_mode` sent at all). An unformatted message always arrives; a
  malformed formatted one arrives not at all — so the default is the one that
  cannot fail.
- `'Markdown'` is gone as an option. MarkdownV2 is deliberately not offered, for
  exactly the reasoning in your §8.
- All four stacks now build their body through one shared
  `toTelegramNotificationBody(subject, body)` that escapes both halves and emits
  `<b>…</b>`, sent with `parseMode: 'HTML'`.

**Impact on you:** none — this is server-to-Telegram only. Worth knowing because
it means the channel is now safe for the descriptions your editor produces.

---

## 3. Things you asked for that are exactly as specified

Listed so you do not have to re-check them:

- **`description` is untouched as the projection.** The server never derives it
  from `descriptionRich`. Your `descriptionCreateWire` / `descriptionUpdateWire`
  remain the only place the pair is computed, which is what keeps them
  consistent. Three source-scan assertions in our test suite prove no write path
  calls `toPlainText`.
- **The text index still reads `{ title, tags, description }` and nothing else.**
  Asserted structurally (comments stripped, every `.index()` call scanned), not
  by eyeball.
- **The vectoriser payload never mentions the field.** Asserted by source scan.
- **`CATALOG_PRODUCT_NO_DESCRIPTION` is unchanged** — an empty document yields an
  empty projection, so the existing activation gate still catches it.
- **Field errors still name `description`.** Content-level validation is still on
  the string, so your `error.details.fields[].path === 'description'` projection
  onto the editor keeps working. `descriptionRich` only ever appears as an error
  path for a *structurally* malformed document (bad `version`, disallowed
  scheme, over 200 blocks) — which your editor cannot produce.
- **The href allowlist is `https:`, `http:`, `mailto:`, `tel:`, at parse time.**
  Relative hrefs rejected. `javascript:`, `data:`, `vbscript:`, `file:` all
  rejected, case-insensitively, on all four endpoints. Each is an explicit test.
- **≤ 200 blocks**, plus the request-body ceiling already in `app.ts`
  (`413 REQUEST_BODY_TOO_LARGE`). 200 passes, 201 is a 400.
- **`GET /api/vendor/products` (list) does not carry it**, as you said it need
  not. The trimmed list projection is unchanged.
- **Public/storefront endpoints do not return it.** Those DTOs are explicit
  projections and this is vendor-facing only; a leak assertion now covers it.

---

## 4. Deploy order

**Order-independent — deploy whenever you like.**

| | Backend old, flag `true` | Backend new, flag `false` | Both new |
|---|---|---|---|
| Layered create/update | field stripped, save succeeds | field absent, stored `null` | works |
| Quick-add create/update | ⚠️ `400`, save rejected | field absent, stored `null` | works |

The backend is already deployed, so only the middle and right columns are
reachable. The left column is the one that was ever dangerous, and it is now
behind you.

---

## 5. How to verify it end-to-end

```bash
# 1. Save a formatted description through the quick-add editor (the .strict() one).
PATCH /api/vendor/products/:id/simple
{ "description": "Sac tressé — fait main.",
  "descriptionRich": { "version": 1, "blocks": [
    { "type": "paragraph", "text": [
      { "type": "text", "text": "Sac tressé", "bold": true },
      { "type": "text", "text": " — fait main." } ] } ] } }

# → 200. The response `data.descriptionRich` echoes the document, so the form
#   rebases without a refetch.

# 2. Reload.
GET /api/vendor/products/:id     # → data.descriptionRich is the same document

# 3. Empty the description, then save.
PATCH /api/vendor/products/:id/simple
{ "description": "", "descriptionRich": null }
# → descriptionRich is null. It does NOT come back on the next read.

# 4. Confirm the boundary holds.
{ "descriptionRich": { "version": 1, "blocks": [ { "type": "paragraph",
    "text": [ { "type": "link", "text": "x", "href": "javascript:alert(1)" } ] } ] } }
# → 400 VALIDATION_ERROR
```

Backend-side: `npm run test:rich-description` (149 assertions, no database).

---

## 6. Not built, and why

> ✅ **SUPERSEDED 2026-09-06 — it was built.** `POST /api/vendor/products/:id/share`
> (`vendor-products.routes.ts:164` → `ProductShareService`) is live and **is** the first caller
> of these formatters, added at Phase 6 Step 5 (6.J). Its contract is
> [vendor/product-share.md](./vendor/product-share.md).
>
> The section below is **left standing as the dated record it is**, and one paragraph of it is
> still true and load-bearing: the share goes to the **vendor's own** connected WhatsApp or
> Telegram and carries **no recipient field**, for exactly the reasons argued here. So the ask
> in the last paragraph — *"send this product to a customer's WhatsApp"* — remains unbuilt and
> unbuildable on either platform's terms. What changed is the half that was a send path at all.
>
> Found by DOC-PROGRAM F-17 class 6, from the other end: `product-share.md` had **no inbound
> link anywhere in `api-doc/`**, and the only mention of "product-share" in the tree was this
> paragraph saying it did not exist.

**There is no endpoint that sends a product description to WhatsApp or
Telegram.** The formatters are implemented, tested and exported from
`core/richtext`, and the Telegram transport is now safe to carry prose — but
nothing calls them, because no product-share send path exists on the backend
today. The `whatsapp` module's only description-shaped field is a 72-character
list-row label, and the `telegram` module sends notifications only.

That was outside the brief, which asked for the formatter rather than a sender,
so this is a note rather than a gap. Your manual share button (the
`t.me/share/url` deep link, plain text) is unaffected and remains correct.

**If you want a server-side share** — "send this product to a customer's
WhatsApp" — say so and we will spec the endpoint. The formatting half is done;
what is missing is the send path, the recipient model and the rate/consent rules
around messaging a customer, and those are the parts worth designing rather than
inferring.

---

## Related

- [`api-doc/vendor/product-description-rich.md`](./vendor/product-description-rich.md) — the field's API reference, updated
- [`api-doc/vendor/products.md`](./vendor/products.md) · [`simple-products.md`](./vendor/simple-products.md) — the four endpoints
- [`api-doc/vendor/docs_requirement.md`](./vendor/docs_requirement.md) — your brief, kept as the record
- `src/core/richtext/` — the mirror of `frontend/vendor-dash/src/lib/richtext/`
