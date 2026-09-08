# Vendor · Share a product to a chat app

**Verified against source on 2026-09-08** — R7 read the whole page: the route
(`catalog/routes/vendor-products.routes.ts:164`), the unmasked `sentTo` and its WhatsApp `null`
(`controllers/vendor-product-share.controller.ts:53`, `ProductShareService.ts:139`,
`channel-connections/channel-connection.model.ts:63`), the 200-character title clamp
(`ProductShareService.ts:100`), the shared 4096 cap (`core/richtext/limits.ts:6-13`) and the three
`PRODUCT_SHARE_*` codes (`core/error-codes.ts:1155,1168,1177`). No defects found — the 2026-09-07
correction below still holds exactly.

**Verified against source on 2026-09-07** — every claim on this page was checked against
`jovi-mall/src/`, including the whole inherited defect list that `vendor-dash` carried for it
(DOC-PROGRAM § 24–28). Corrections are marked inline with ⚠ and a source citation.

`POST /api/vendor/products/:id/share`

Sends one of your products — title, storefront link, and the description with its
formatting preserved — to **your own** connected WhatsApp or Telegram, so you can forward it
to a customer.

Added in Phase 6 Step 5 (6.J). It is the first caller of the WhatsApp and Telegram
formatters in `core/richtext/`, which were complete and unused.

---

## Request

```jsonc
{ "channel": "whatsapp" }   // or "telegram"
```

The schema is **strict**: any other field is a `400`.

### ⚠ There is no recipient field, and that is a platform constraint

You cannot send this to a customer's number. **Neither channel permits it**, for two
different reasons:

| Channel | Why not |
|---|---|
| **WhatsApp** | Outside Meta's 24-hour service window only an **approved template** may be sent, and there is no product-share template. A free-form message to somebody who has not written to the bot in the last day is refused by policy. |
| **Telegram** | The Bot API sends to a `chat_id`, which exists only after that person has started the bot. There is no send-to-a-phone-number call. |

So a share goes to **you**, and you forward it. That is what a share button does anyway.

---

## What arrives

```
*Blue Shirt*
https://shop.example.com/stores/my-store/products/blue-shirt

Soft cotton, *pre-shrunk*, ships in 24h.
```

- The **title** leads, clamped to 200 characters.
- The **link** is store-scoped (`/stores/:storeSlug/products/:productSlug`) because a
  product slug is unique per vendor, not globally. It is omitted if you have no store yet,
  or if the platform has no `STOREFRONT_URL` configured — never emitted broken.
- The **description** is your `descriptionRich` rendered for that chat app: `*bold*` and
  `_italic_` for WhatsApp, `<b>`/`<i>` for Telegram. If you never used the formatting
  editor, your plain `description` is sent instead.

Everything is fitted to the 4096-character cap by trimming the **document**, so a message
never arrives with a half-open `*` or a severed `</b>`.

---

## Responses

**WhatsApp** — `sentTo` is always `null` on this channel:

```json
{
  "success": true,
  "data": { "channel": "whatsapp", "sentTo": null },
  "message": "Product sent to your whatsapp."
}
```

**Telegram** — the vendor's own `@username`, unmasked:

```json
{
  "success": true,
  "data": { "channel": "telegram", "sentTo": "@janes_shop" },
  "message": "Product sent to your telegram."
}
```

> ⚠ **This said *"`sentTo` is a masked hint, never the raw identifier"* and showed `"••••3456"`
> until 2026-09-07. Both halves were wrong.** The controller returns `target.handle` verbatim
> (`vendor-product-share.controller.ts:53`), which is `connection.handle` off the messaging
> connection (`ProductShareService.ts:139`) — **no masking is applied anywhere on this path**.
>
> - **Telegram**: the vendor's real `@username`, unmasked.
> - **WhatsApp**: **always `null`.** The model's own comment is explicit — *"Telegram
>   `@username`. Always null for WhatsApp, which has no handle."*
>   (`channel-connection.model.ts:63`). WhatsApp identities are phone ids and no handle is
>   stored, so there was never a `••••3456` to show.
>
> **A client must handle `null`**, and a UI that rendered the masked string as confirmation
> (*"sent to ••••3456"*) printed nothing at all on the more common channel. The masking helper
> that produces `••••1234` is real but lives on a different surface
> (`channel-connections/domain/identity-mask.ts`) and is not called here.
>
> This is disclosure in the harmless direction — the handle is the **vendor's own**, returned to
> the vendor who owns it — but do not carry "sentTo is masked" into any other page.

| `error.code` | Status | When | What to do |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing/unknown `channel`, or an extra field (such as a recipient) | Send `{ channel }` only |
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | No such product, or not yours | — |
| `PRODUCT_SHARE_CHANNEL_NOT_CONNECTED` | 422 | You have no connection on that channel. `details.howToConnect` carries the `/connect` command and a deep link | Connect the channel, then share again |
| `PRODUCT_SHARE_WINDOW_CLOSED` | 422 | **WhatsApp only** — your 24-hour service window is closed | Send the bot any message, then share again |
| `PRODUCT_SHARE_SEND_FAILED` | 502 | The channel accepted the request and did not deliver | Retry |

`PRODUCT_SHARE_WINDOW_CLOSED` is a `422`, not a `502`: nothing failed. It is a policy
boundary with an action you can take.

---

## Notes for a client

- **Render `details.howToConnect.deepLink` as a button** on the not-connected error. That
  field exists so the fix is one tap rather than an instruction to read.
- **Do not offer a recipient input.** See above — it cannot work, and the strict schema
  will reject it rather than silently ignore it.
- Sharing does not edit the product, so it is available on an `active` listing (unlike the
  write routes, which sit behind `requireProductEditable`).
