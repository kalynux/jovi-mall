# Rich Product Descriptions (`descriptionRich`)

**Verified against source on 2026-09-08** — R7 re-checked the four write schemas against the one shared `descriptionRichSchema` (`catalog/validators/rich-description.validator.ts:39`, used at `product.validator.ts:54,90` and `simple-product.validator.ts:51,97`) and the dashboard gate (`vendor-dash/src/lib/richtext/wire.ts:36`). No defects found.

**Re-verified in part on 2026-09-08** — the rollout status only: the vendor dashboard's `RICH_DESCRIPTION_WIRE_ENABLED` is `true` (`vendor-dash/src/lib/richtext/wire.ts:36`), reversing what this page said.

The structured description a vendor writes in the dashboard's formatting editor, and the source of truth for how a product reads when it is shared into **WhatsApp** or **Telegram**.

> [!IMPORTANT]
> **`description` and `descriptionRich` are not alternatives — they always travel together.**
> `descriptionRich` is the structured document; `description` is its plain-text
> projection. `description` remains the field that the storefront renders, that
> the `product_storefront_text` index tokenises, and that the AI vectoriser
> embeds. A client that sends one without the other, or sends a `description`
> that is not the projection of its `descriptionRich`, is sending inconsistent
> data.

> [!NOTE]
> **Implementation status: shipped, both sides.** The field is accepted on all four product
> write endpoints — including the two `.strict()` quick-add ones — persisted,
> and returned on every vendor-facing product read. The vendor dashboard's gate
> (`RICH_DESCRIPTION_WIRE_ENABLED`) **is `true`** — checked in that repository on 2026-09-08.
> See [Rollout](#rollout).

## Table of contents

- [The document model](#the-document-model)
- [Endpoints](#endpoints)
- [Field reference](#field-reference)
- [Channel formatting](#channel-formatting)
- [Rollout](#rollout)
- [Possible error codes](#possible-error-codes)

---

## The document model

An array of typed blocks with flat inline spans. Deliberately not HTML and not markdown — see [`docs_requirement.md` §2](../../docs_requirement.md#2-the-data-model) for the reasoning. The vocabulary is the intersection of what WhatsApp and Telegram both render: **bold, italic, strikethrough, links, bullet lists, numbered lists, paragraphs**. Nothing else.

```ts
type InlineNode =
  | { type: 'text'; text: string; bold?: boolean; italic?: boolean; strike?: boolean }
  | { type: 'link'; text: string; href: string; bold?: boolean; italic?: boolean; strike?: boolean };

type Block =
  | { type: 'paragraph'; text: InlineNode[] }
  | { type: 'list'; ordered?: boolean; items: InlineNode[][] };

type RichDoc = { version: 1; blocks: Block[] };
```

| Rule | Why |
|---|---|
| `version` must be `1` | A reader that does not recognise it falls back to `description` rather than rendering blocks it cannot interpret |
| A hard line break is `\n` inside a text span, not a new block | In chat a two-line address is one thought; splitting it inserts a blank line through the middle |
| Lists never nest | Neither platform has list markup — both render a literal `• ` / `1. ` prefix |
| `link.text` is stored apart from `href` | Telegram keeps the label, WhatsApp can only show a bare URL. The channels disagree, so the label stays data |
| `href` must be `https:`, `http:`, `mailto:` or `tel:` | Enforced at parse time, never at render time |

### Example

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
    }
  ]
}
```

The matching `description` sent in the same request:

```
🔥 Sac en raphia tressé — fait main à Douala.

• Cuir véritable
• Garantie 2 ans
```

---

## Endpoints

`descriptionRich` is accepted alongside `description` on every product write.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/vendor/products` | Layered create |
| `PATCH` | `/api/vendor/products/:id` | Layered update |
| `POST` | `/api/vendor/products/simple` | Quick-add create — schema is `.strict()` |
| `PATCH` | `/api/vendor/products/:id/simple` | Quick-add update — schema is `.strict()` |

It is returned by `GET /api/vendor/products/:id` and by the write responses. It is **not** included in the trimmed `GET /api/vendor/products` list response.

> [!NOTE]
> The two `/simple` schemas are `.strict()`, so an unknown key there returns
> `400 VALIDATION_ERROR` and rejects the **whole** request rather than stripping
> the field. `descriptionRich` is now a known key on all four, so it is safe to
> send everywhere. Any *other* unknown key on the two `/simple` routes still
> behaves this way.

### Example request — `PATCH /api/vendor/products/:id`

```json
{
  "description": "🔥 Sac en raphia tressé — fait main à Douala.\n\n• Cuir véritable",
  "descriptionRich": {
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
      { "type": "list", "items": [[{ "type": "text", "text": "Cuir véritable" }]] }
    ]
  }
}
```

### Example success `200`

```json
{
  "success": true,
  "data": {
    "id": "507f1f77bcf86cd799439011",
    "title": "Sac en raphia tressé",
    "description": "🔥 Sac en raphia tressé — fait main à Douala.\n\n• Cuir véritable",
    "descriptionRich": { "version": 1, "blocks": [] },
    "…": "…"
  },
  "message": "Product updated"
}
```

---

## Field reference

| Field | Type | Required | Validation |
|-------|------|----------|-----------|
| `description` | string | ✅ on create | Non-empty. The plain-text projection of `descriptionRich` |
| `descriptionRich` | object \| null | No | Must satisfy the model above; `version` must be `1`; ≤ 200 blocks; every `href` in the scheme allowlist |

**Semantics of `descriptionRich` on update:**

| Sent | Effect |
|---|---|
| absent | Stored value left alone |
| an object | Replaces the stored document |
| `null` | Clears it — the vendor removed their formatting |

`null` clears rather than being ignored: omitting it on an emptied description would leave the old document in place while `description` was replaced, and the next read would resurrect formatting the vendor deleted.

**Activation** is unchanged and still gated on `description` — an empty document yields an empty projection, so `CATALOG_PRODUCT_NO_DESCRIPTION` still fires correctly.

**Vectorisation and search** are unchanged and still read `description` only. `descriptionRich` is not indexed and is not sent to the vectoriser.

---

## Channel formatting

The same document produces genuinely different output per channel. This is the reason the field exists.

| | WhatsApp | Telegram (`parse_mode: 'HTML'`) |
|---|---|---|
| bold | `*text*` | `<b>text</b>` |
| italic | `_text_` | `<i>text</i>` |
| strikethrough | `~text~` | `<s>text</s>` |
| link | bare URL — `Label: https://…` | `<a href="https://…">Label</a>` — **label survives** |
| lists | literal `• ` / `1. ` | literal `• ` / `1. ` |
| escaping | **none available** | `&`, `<`, `>` only |

Three consequences worth knowing before writing a sender:

1. **WhatsApp markers must hug non-whitespace.** `* bold *` renders as literal asterisks; `*bold*` renders bold.
2. **WhatsApp has no escape character.** A span whose text already contains its own marker cannot be emphasised — the marker is dropped rather than emitted into broken output.
3. **Telegram must use HTML, not MarkdownV2.** MarkdownV2 requires escaping eighteen characters that product prose is full of (`.`, `-`, `!`, `(`, `)`), and one miss drops the entire message with `400 can't parse entities`.

There are also **two Telegram transports with different capabilities**: a Bot API `sendMessage` with `parse_mode: 'HTML'` keeps every mark, while a `t.me/share/url?...&text=` deep link renders its text verbatim and keeps none. Do not send HTML down the deep link.

Full algorithms, including truncation rules and test vectors, are in
[`docs_requirement.md` §7–§9](../../docs_requirement.md#7-sending-a-description-to-whatsapp).

---

## Rollout

**Both halves are live.** The vendor dashboard gates the field behind a single constant
(`RICH_DESCRIPTION_WIRE_ENABLED`, its `src/lib/richtext/wire.ts:36`) and that constant is
**`true`** — checked in that repository on 2026-09-08. ⚠ This paragraph said the gate was still
off until then; it had been flipped some time after the field shipped and nobody came back to
either copy of this page.

The constant is kept as a kill switch rather than deleted. If it is ever set back to `false`:

- The editor stays fully functional and `description` persists as always.
- Paragraphs, lists, line breaks, emoji and URLs survive a reload — the frontend
  reconstructs the document by parsing `description`.
- Inline marks (bold / italic / strikethrough) and link labels do not survive,
  because by design they leave no trace in the projection.

The rollout is order-independent: the backend accepts the field from clients that
send it and stores `null` for clients that do not, so the two sides can deploy in
either order and no product is left in a broken state by the gap.

### Server-side formatting

The document model, its validator and both channel formatters live in
`src/core/richtext/` — a deliberate mirror of the dashboard's
`src/lib/richtext/`, file for file, since there is no shared package between the
two repositories. `npm run test:rich-description` (149 assertions, no DB) asserts
the backend's WhatsApp and Telegram output against the dashboard's own fixtures
byte-for-byte, so a change on either side surfaces as a diff rather than as a
badly-rendered customer message.

Exported from `core/richtext`: `toPlainText`, `toWhatsApp`, `toTelegramHtml`,
`toTelegramPlain`, `escapeTelegramHtml`, `truncateDoc`, `richDocSchema`,
`parseRichDoc`.

---

## Possible error codes

| `error.code` | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Malformed document, unknown `version`, disallowed `href` scheme, or more than 200 blocks |
| `REQUEST_BODY_TOO_LARGE` | 413 | The whole request exceeded the body-size ceiling. The 200-block cap bounds the document's shape; this bounds its bytes |
| `CATALOG_PRODUCT_NO_DESCRIPTION` | 422 | `description` is empty at activation — unchanged by this field |

Field-level errors for description *content* are reported against
`error.details.fields[].path === 'description'`, never `descriptionRich`, so the
dashboard's existing error projection onto the editor keeps working.

## Related

- [products.md](./products.md) — product create/update contracts
- [simple-products.md](./simple-products.md) — the quick-add endpoints
- [product-update.md](./product-update.md) — incremental update flow
- [../telegram/README.md](../telegram/README.md) · [../whatsapp/README.md](../whatsapp/README.md)
- [`docs_requirement.md`](../../docs_requirement.md) — the backend implementation brief
