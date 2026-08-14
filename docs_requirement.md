# Backend requirements — structured product descriptions (`descriptionRich`)

**Audience:** backend developer on `backend/jovi-mall`
**Frontend status:** shipped and merged. Everything below is what the frontend needs from the backend for the feature to be complete.
**Blocking?** No. The vendor dashboard works today without any of this. What is missing without it is *persistence of inline formatting* — see [§1](#1-what-works-today-and-what-does-not).

---

## Table of contents

- [1. What works today, and what does not](#1-what-works-today-and-what-does-not)
- [2. The data model](#2-the-data-model)
- [3. Mongoose changes](#3-mongoose-changes)
- [4. Zod changes — the four endpoints](#4-zod-changes--the-four-endpoints)
- [5. Read path](#5-read-path)
- [6. Invariants you must not break](#6-invariants-you-must-not-break)
- [7. Sending a description to WhatsApp](#7-sending-a-description-to-whatsapp)
- [8. Sending a description to Telegram](#8-sending-a-description-to-telegram)
- [9. Test vectors](#9-test-vectors)
- [10. Checklist](#10-checklist)

---

## 1. What works today, and what does not

Vendors now write product descriptions in a formatting editor (bold, italic, strikethrough, bullet lists, numbered lists, links, emoji) with a live WhatsApp/Telegram preview. The editor produces a structured document; the frontend derives a plain-text projection from it and sends that in the existing `description` field.

| | Today | After this work |
|---|---|---|
| Paragraphs, line breaks, bullet/numbered lists, emoji, URLs | Persist | Persist |
| **Bold / italic / strikethrough** | **Lost on reload** | Persist |
| **Link labels** (text ≠ URL) | **Lost on reload** | Persist |
| Storefront, search, AI vectoriser | Unaffected | Unaffected |

The loss happens because the frontend currently reconstructs the document by re-parsing `description`, which by design contains no formatting markers. Structure survives that round trip; inline marks cannot.

> [!IMPORTANT]
> There is a feature gate in the frontend: `RICH_DESCRIPTION_WIRE_ENABLED` in
> `src/lib/richtext/wire.ts`, currently `false`. It exists because
> `CreateSimpleProductSchema` and `UpdateSimpleProductSchema` are `.strict()` —
> sending an unknown `descriptionRich` there today returns `400 VALIDATION_ERROR`
> and rejects the **entire** save. **Tell the frontend team when this ships** so
> the constant is flipped to `true`. Nothing else changes on the frontend.

---

## 2. The data model

A description is an array of typed blocks with flat inline spans. It is deliberately **not** HTML and **not** markdown: storing WhatsApp's own `*bold*` syntax would make one messenger's quirks the source of truth, and storing HTML would mean sanitising on the way in and rendering through `dangerouslySetInnerHTML` on the way out.

The vocabulary is exactly the intersection of what WhatsApp and Telegram both support. There are no headings, colours, tables or font sizes, because no chat client renders them.

```ts
type InlineNode =
  | { type: 'text'; text: string; bold?: boolean; italic?: boolean; strike?: boolean }
  | { type: 'link'; text: string; href: string; bold?: boolean; italic?: boolean; strike?: boolean };

type Block =
  | { type: 'paragraph'; text: InlineNode[] }
  | { type: 'list'; ordered?: boolean; items: InlineNode[][] };

type RichDoc = { version: 1; blocks: Block[] };
```

Notes that matter:

- **`version` is load-bearing.** A reader that does not recognise it must fall back to `description`, never render blocks it does not understand.
- **A hard line break inside a paragraph is a `\n` inside a text span**, not a new block. Shift+Enter produces it, and in chat a two-line address is one thought.
- **Lists never nest.** Neither platform has list markup — both formatters emit a literal `• ` / `1. ` prefix — so a nested list would render as an indent nobody can see.
- **`link.text` is stored separately from `href` on purpose.** Telegram renders `<a href>` with the label intact; WhatsApp has no anchor syntax at all. The channels disagree, so the label must stay data rather than markup.

Reference implementation (the frontend's, which the schema below mirrors exactly):
`frontend/vendor-dash/src/lib/richtext/types.ts` and `schema.ts`.

### Worked example

```json
{
  "version": 1,
  "blocks": [
    {
      "type": "paragraph",
      "text": [
        { "type": "text", "text": "🔥 " },
        { "type": "text", "text": "Sac en raphia tressé", "bold": true },
        { "type": "text", "text": " — fait main à Douala." }
      ]
    },
    {
      "type": "list",
      "items": [
        [{ "type": "text", "text": "Cuir véritable" }],
        [
          { "type": "text", "text": "Garantie " },
          { "type": "text", "text": "2 ans", "bold": true }
        ]
      ]
    },
    {
      "type": "paragraph",
      "text": [
        { "type": "text", "text": "Voir le " },
        { "type": "link", "text": "guide des tailles", "href": "https://wimall.cm/guide" }
      ]
    }
  ]
}
```

Its `description` projection — what the same request also sends:

```
🔥 Sac en raphia tressé — fait main à Douala.

• Cuir véritable
• Garantie 2 ans

Voir le guide des tailles: https://wimall.cm/guide
```

---

## 3. Mongoose changes

`src/modules/catalog/models/product.model.ts`

Add to the `IProduct` interface, next to `description` (currently line ~145):

```ts
descriptionRich?: RichDoc | null;
```

Add to the schema, next to the `description` path (currently line ~215):

```ts
// Structured description. `description` above remains its plain-text projection
// and stays the only field that is indexed and vectorised — see §6.
descriptionRich: { type: Schema.Types.Mixed, default: null },
```

`Mixed` rather than a nested sub-schema: the shape is a recursive union that Mongoose sub-schemas express badly, and it is already validated by Zod at the boundary, which is where validation belongs. **Do not add it to the `product_storefront_text` index** (line ~382) — see §6.

---

## 4. Zod changes — the four endpoints

Add one shared fragment, e.g. `src/modules/catalog/validators/rich-description.validator.ts`:

```ts
import { z } from 'zod';

const ALLOWED_SCHEMES = ['https:', 'http:', 'mailto:', 'tel:'];

function isAllowedHref(href: string): boolean {
    try {
        return ALLOWED_SCHEMES.includes(new URL(href).protocol);
    } catch {
        return false;
    }
}

const marks = {
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    strike: z.boolean().optional(),
};

const inlineNodeSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string(), ...marks }),
    z.object({
        type: z.literal('link'),
        text: z.string(),
        href: z.string().refine(isAllowedHref, 'Unsupported link scheme'),
        ...marks,
    }),
]);

export const richDocSchema = z.object({
    version: z.literal(1),
    blocks: z
        .array(
            z.discriminatedUnion('type', [
                z.object({ type: z.literal('paragraph'), text: z.array(inlineNodeSchema) }),
                z.object({
                    type: z.literal('list'),
                    ordered: z.boolean().optional(),
                    items: z.array(z.array(inlineNodeSchema)),
                }),
            ]),
        )
        .max(200, 'Description has too many blocks'),
});
```

> [!WARNING]
> **The `href` scheme allowlist must be enforced at parse time, not at render
> time.** A `javascript:` href caught only by a renderer is one missed call site
> away from being live. Reject it at the boundary and no renderer can ever
> receive it.

Then wire it into all four product-write schemas:

| Endpoint | File | Line (today) | Add |
|---|---|---|---|
| `POST /api/vendor/products` | `product.validator.ts` | 48 | `descriptionRich: richDocSchema.nullable().optional(),` |
| `PATCH /api/vendor/products/:id` | `product.validator.ts` | 82 | same |
| `POST /api/vendor/products/simple` | `simple-product.validator.ts` | 45 | same |
| `PATCH /api/vendor/products/:id/simple` | `simple-product.validator.ts` | 89 | same |

> [!IMPORTANT]
> **The two simple-product schemas are `.strict()`** (`simple-product.validator.ts:77` and `:117`). Until the field is added there, a request carrying it is rejected in full — which is exactly why the frontend gate exists. The two layered schemas are not top-level strict and merely strip it, so the layered wizard would appear to work while the quick-add editor 400s. Add all four together.

**Semantics of the value:**

| Sent | Means |
|---|---|
| absent | Leave the stored value alone |
| an object | Replace the stored document |
| `null` | Clear it — the vendor deleted their formatting |

`null` must clear rather than be ignored. Omitting it on an emptied description would leave the old rich document in place while `description` was replaced, and the next read would resurrect formatting the vendor deliberately removed.

Also update `src/modules/catalog/dto/product.dto.ts` (`CreateProductDto`, `UpdateProductDto`) and pass the field through in:

- `ProductUpdateService.ts` (~line 102, alongside the existing `description` assignment)
- `SimpleProductCreateService.ts` (~line 147)

---

## 5. Read path

Return `descriptionRich` wherever `description` is returned on a **vendor-facing** product read:

- `GET /api/vendor/products/:id` — required; this is what the edit forms hydrate from.
- `POST/PATCH` responses that echo the product — required, so the form rebases without a refetch.
- `GET /api/vendor/products` (list) — **not** required. The list response is deliberately trimmed and the frontend does not read it there.

For **public / storefront** endpoints, returning it is optional and currently unused — the storefront renders `description`. If you do return it, do not stop returning `description`.

---

## 6. Invariants you must not break

**1. `description` stays the plain-text projection, and stays authoritative for everything except chat formatting.**

Three consumers depend on it being clean prose:

- The **customer storefront** renders it as raw text (`landing/src/components/shop/ProductDetail.tsx:348` — `<p>{p.desc}</p>`). Markers stored here would show up as literal asterisks to customers.
- The **text index** `product_storefront_text` (`product.model.ts:382`) tokenises it at weight 1, and backs the `?q=` search.
- The **AI vectoriser** embeds it verbatim (`api-doc/vendor/products.md`, "What gets indexed").

So: **do not index `descriptionRich`, do not send it to the vectoriser, and do not derive `description` from it server-side.** The frontend already sends a consistent pair.

**2. The activation gate keeps checking `description`.** `ProductStatusValidationService.ts:147` (`CATALOG_PRODUCT_NO_DESCRIPTION`) is correct as written and needs no change — an empty document produces an empty projection, so the existing rule still catches it.

**3. Server-side field errors keep naming `description`.** The frontend projects `error.details.fields[].path === 'description'` onto the editor. Do not start emitting `descriptionRich` as the error path for content problems.

**4. Cap the payload.** `description` is currently unbounded (no `maxlength`, no `.max()`). The document should be capped too — the `.max(200)` on blocks above, plus a body-size limit — so a malformed client cannot store a multi-megabyte document.

---

## 7. Sending a description to WhatsApp

WhatsApp has **no markup language**. It has four in-band markers the client interprets while rendering, and **no escape character**.

| Intent | Emit |
|---|---|
| bold | `*text*` |
| italic | `_text_` |
| strikethrough | `~text~` |
| link | the bare URL — there is no anchor syntax |

Algorithm (reference: `frontend/vendor-dash/src/lib/richtext/format/whatsapp.ts`):

1. **Blocks** join with `\n\n`. A `paragraph` renders its spans concatenated. A `list` renders one line per item, prefixed `• ` (unordered) or `1. `, `2. `… (ordered). Hard line breaks inside a span stay `\n`.
2. **Marks** wrap the span innermost-first, producing `~*_text_*~`.
3. **Markers must hug non-whitespace.** A span of `" spéciale "` must emit `" *spéciale* "`, never `"* spéciale *"` — the latter renders as literal asterisks. Hoist leading/trailing whitespace outside the marker pair. Apply markers **per line**, since a pair does not reliably survive a line break.
4. **Marker collision.** If a span's text already contains the marker character it would be wrapped in, **omit that marker**. `*Toile 5*7 cm*` makes the client bold "Toile 5" and leave a stray character; dropping the marker loses the emphasis but keeps the sentence. The frontend warns the vendor when this happens.
5. **Links** render as `Label: https://url`, or the bare URL when the label is the URL. **Do not apply marks to a link** — a leading `*` gets absorbed into WhatsApp's URL detection often enough to produce a dead link.
6. **Truncate the document, not the string.** Cap at `WA_LIMITS.TEXT_BODY` (4096) or `MEDIA_CAPTION` (1024) by trimming the *document* to fit and only then formatting. Cutting the formatted string can drop a closing `*`, and the client then renders everything after it as one bold run.

---

## 8. Sending a description to Telegram

> [!CAUTION]
> **`telegram-bot.service.ts:58` currently hard-codes `parse_mode: 'Markdown'` (legacy v1) with no escaping anywhere in the module.** Piping a vendor-authored description through it as-is will fail: any `_`, `*`, `[` or `` ` `` in the text makes the Bot API return `400 Bad Request: can't parse entities`, `sendMessage` returns `false`, and the send is silently dropped (the boolean is only logged, line 70). **This must be addressed before any product description reaches that method.**

**Use `parse_mode: 'HTML'`.**

Not MarkdownV2. MarkdownV2 requires escaping eighteen characters — ``_ * [ ] ( ) ~ ` > # + - = | { } . !`` — and a product description collides with them constantly: every price (`12.500 FCFA`), every French dash, every `(x2)`, every `!`. A single missed escape does not degrade the formatting, it drops the entire message. HTML's escape set is three characters that never appear in prose by accident.

| Intent | Emit |
|---|---|
| bold | `<b>text</b>` |
| italic | `<i>text</i>` |
| strikethrough | `<s>text</s>` |
| link | `<a href="url">label</a>` — **the label survives, unlike WhatsApp** |

Algorithm (reference: `format/telegram.ts`):

1. Same block layout as WhatsApp — `\n\n` between blocks, literal `• ` / `1. ` prefixes (Telegram has no list markup either).
2. Escape **only** `&`, `<`, `>`, in that order (`&` first, or the ampersands introduced by the other two get double-escaped).
3. Escape the `href` too. `<` and `>` cannot legally appear in a URL, but `&` routinely does in query strings — `?a=1&b=2` is exactly how a link breaks in practice.
4. Nest marks outermost-first: `<s><b><i>text</i></b></s>`.
5. Truncate the document, not the string — a severed `</b>` is a rejected send, not a cosmetic defect.

### Two Telegram transports, two formats

| Transport | Format | Marks survive? |
|---|---|---|
| Bot API `sendMessage` + `parse_mode: 'HTML'` | `toTelegramHtml` | Yes |
| `https://t.me/share/url?...&text=` deep link | plain text | **No** — `text` is rendered verbatim |

The vendor dashboard's manual share button uses the deep link, so it sends plain text and tells the vendor so. Server-side sends should use the Bot API and get full formatting. Do not send HTML down the deep link — the customer would see literal `<b>` tags.

### Suggested placement

A `RichDescriptionFormatter` in `src/modules/catalog/` (or shared under `src/core/`) exporting `toPlainText`, `toWhatsApp` and `toTelegramHtml`, reused by both messaging modules. The existing `truncate()` in `src/modules/whatsapp/constants/whatsapp-limits.ts` is the right length-clamping helper and already matches the frontend's behaviour.

---

## 9. Test vectors

These are the frontend's own fixtures, verified by `npm run richtext:verify` in `frontend/vendor-dash`. A backend formatter should produce byte-identical output.

**A. Bold name, struck-through old price, emoji**

```
doc: "🔥 " + bold("Sac en raphia tressé") + " — fait main à Douala."
     "Prix : " + bold("12.500 FCFA") + " (au lieu de " + strike("18.000 FCFA") + ")"
```
```
WhatsApp  🔥 *Sac en raphia tressé* — fait main à Douala.
          ⏎⏎
          Prix : *12.500 FCFA* (au lieu de ~18.000 FCFA~)

Telegram  🔥 <b>Sac en raphia tressé</b> — fait main à Douala.
          ⏎⏎
          Prix : <b>12.500 FCFA</b> (au lieu de <s>18.000 FCFA</s>)
```

**B. Links — the channel divergence**

```
doc: "Voir le " + link("guide des tailles", "https://wimall.cm/guide?ref=a&size=eu") + " avant de commander."
     link("https://wimall.cm/boutique", "https://wimall.cm/boutique")
```
```
WhatsApp  Voir le guide des tailles: https://wimall.cm/guide?ref=a&size=eu avant de commander.
          ⏎⏎
          https://wimall.cm/boutique

Telegram  Voir le <a href="https://wimall.cm/guide?ref=a&amp;size=eu">guide des tailles</a> avant de commander.
          ⏎⏎
          <a href="https://wimall.cm/boutique">https://wimall.cm/boutique</a>
```

**C. Marker collision (WhatsApp drops the mark, Telegram keeps it)**

```
doc: bold("Toile 5*7 cm") + " · réf. " + italic("AB_12")
```
```
WhatsApp  Toile 5*7 cm · réf. AB_12
Telegram  <b>Toile 5*7 cm</b> · réf. <i>AB_12</i>
```

**D. HTML-hostile characters**

```
doc: "Tailles < 40 & > 44 disponibles — voir \"conditions\""
```
```
WhatsApp  Tailles < 40 & > 44 disponibles — voir "conditions"
Telegram  Tailles &lt; 40 &amp; &gt; 44 disponibles — voir "conditions"
```

**E. Edge whitespace inside a mark (double-click selection)**

```
doc: "Promo" + bold(" spéciale ") + "du weekend"
```
```
WhatsApp  Promo *spéciale* du weekend          ← NOT "Promo * spéciale *du weekend"
```

**F. Lists**

```
doc: bold("Caractéristiques")
     ul["Cuir véritable, doublure coton", "Garantie " + bold("2 ans")]
     ol["Hauteur : 32 cm", "Largeur : 28 cm"]
```
```
WhatsApp  *Caractéristiques*
          ⏎⏎
          • Cuir véritable, doublure coton
          • Garantie *2 ans*
          ⏎⏎
          1. Hauteur : 32 cm
          2. Largeur : 28 cm
```

Also covered by the frontend fixtures and worth mirroring: multi-codepoint emoji (`👨‍👩‍👧‍👦`, `🇨🇲`), accented French throughout, `€1,299.00` / `850.000 FCFA` inside marks, hard line breaks inside one paragraph, and a 60-item list that exceeds 4096 characters and must truncate at a clean boundary with an ellipsis and no unbalanced markers.

---

## 10. Checklist

- [ ] `descriptionRich` added to `IProduct` + the Mongoose schema as `Mixed`, default `null`
- [ ] **Not** added to the `product_storefront_text` index
- [ ] `richDocSchema` added, with the `href` scheme allowlist enforced at parse time
- [ ] Accepted on **all four** write endpoints — including the two `.strict()` simple ones
- [ ] `null` clears; absent leaves alone
- [ ] Persisted in `ProductUpdateService` and `SimpleProductCreateService`
- [ ] Returned by `GET /api/vendor/products/:id` and by the write responses
- [ ] `description` still fed to the vectoriser and the text index, unchanged
- [ ] Shared formatter implemented (`toPlainText` / `toWhatsApp` / `toTelegramHtml`)
- [ ] `telegram-bot.service.ts` no longer sends vendor prose under `parse_mode: 'Markdown'`
- [ ] Test vectors in §9 reproduce byte-for-byte
- [ ] **Frontend team told to flip `RICH_DESCRIPTION_WIRE_ENABLED` to `true`**

---

## Related

- `api-doc/vendor/product-description-rich.md` — the API reference for this field
- `api-doc/vendor/products.md` — product create/update contracts
- `api-doc/vendor/simple-products.md` — the quick-add endpoints (the `.strict()` ones)
- `api-doc/telegram/README.md`, `api-doc/whatsapp/README.md` — the messaging modules
- `frontend/vendor-dash/src/lib/richtext/` — the reference implementation
- `frontend/vendor-dash/tools/richtext/verify.ts` — the formatter test harness
