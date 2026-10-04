# AI listing copy

`POST /api/vendor/ai/listing-copy` writes a listing's description, tags, SEO title, SEO description
and/or categories from its name, 1–4 photos and the vendor's notes. **It saves nothing.** The
vendor copies the results into the form and saves through the usual product and service routes.

This answers the dashboard's request of 2026-10-04 (`ai-listing-copy-requirement.md`). The request
and response shapes are the ones that request proposed. The differences are listed at the end.

```
POST /api/vendor/ai/listing-copy
Auth: vendor (same guard as /api/vendor/products)
Rate limit: 20 calls per vendor per 10 minutes
```

The call is synchronous. It normally answers in 4–8 seconds and never takes longer than 45.

## Request

```jsonc
{
  "target": "product",              // "product" | "service"
  "productType": "physical",        // products only: "physical" | "digital". Must be absent for services.
  "listingId": "66f…",              // optional — must be one of this vendor's listings, else 404
  "language": "fr",                 // "en" | "fr" | "es" | "pt" | "ar"
  "fields": ["description", "tags", "seoTitle", "seoDescription", "categories"],
  "input": {
    "title": "Nike Air Max 90",     // 1–200 characters
    "categories": [],               // 0–5: what the form already has
    "notes": "original, sizes 40 to 45, 1-year warranty, delivery in Douala", // optional, ≤ 500
    "imageFileIds": ["66b…"]        // 1–4 of this vendor's media-library images; first = main
  },
  "previous": { "seoTitle": "…" }   // optional: regenerate only; keys must be in `fields`
}
```

The body is **strict**. An unknown field, including any attempt to send prompt text, gets
`400 VALIDATION_ERROR`. `categories` may be in `fields` only while `input.categories` is empty.

The photos do **not** need to be attached to a product. A fresh upload the vendor picked in the
popup is fine. A photo is refused when it is not this vendor's file, is deleted, is not an image,
is larger than 15 MB, or cannot be read. The server shrinks each photo to 1024 px before the model
sees it.

## Response `200`

```jsonc
{
  "success": true,
  "data": {
    "results": {
      "description": { "descriptionRich": { "version": 1, "blocks": [ /* RichDoc */ ] } },
      "tags": ["nike", "air max 90", "baskets", "chaussures homme", "sneakers"],
      "seoTitle": "Nike Air Max 90 originales — pointures 40 à 45",
      "seoDescription": "…",
      "categories": [{ "id": "65a…", "name": "Baskets" }]   // or one { "name": "…" } proposal
    },
    "failed": [],           // requested fields that came back unusable: refunded
    "creditsCharged": 5,    // = number of keys in `results`
    "balance": 115,
    "generationId": "66d…"
  }
}
```

The server checks every field before it returns it, so whatever reaches the dashboard already
meets these rules:

| Field | Guarantee |
|---|---|
| `description` | Passes the same `richDocSchema` every product write runs. Paragraphs and lists only, **no links**, no URLs in text, ≤ 12 list items, ≤ 3,776 plain-text characters. Derive `description` with `toPlainText` as you already do. |
| `tags` | 3–10, unique ignoring case, no `#`, 1–3 words, ≤ 40 characters each |
| `seoTitle` | ≤ 60 characters, cut on a word boundary, no emoji |
| `seoDescription` | ≤ 160 characters, cut on a word boundary, no emoji |
| `categories` | 1–3 existing categories (id **and** the stored name), or exactly one `{ name }` proposal when nothing fit. An id the model invented is dropped. A "new" name that is already an existing spelling comes back as that category's id. |

Category names come back as **stored**. Categories have no translations: translated spellings
are aliases of one row. So a French request can get "Sneakers" if that is the stored name.

## Credits

- Cost: `fields.length × actionCosts.aiCopyField` (1 today). Read the live value from
  `GET /api/public/credit-packs` → `actionCosts.aiCopyField` rather than hard-coding it.
- The charge is taken up front, before the model runs. Each field in `failed` is refunded with a
  `refund` ledger row. When nothing came back, the whole charge is refunded.
- Ledger rows carry `reason_code: "ai_listing_copy"` and `ref = generationId`. In
  `/api/vendor/transactions` they read "AI listing copy".
- A refusal before the model runs (validation, photo, foreign listing, empty wallet, rate limit)
  charges nothing.

## Errors

| Code | HTTP | Charged? |
|---|---|---|
| `VALIDATION_ERROR` | 400 | no |
| `CATALOG_PRODUCT_NOT_FOUND` | 404 | no: `listingId` is not this vendor's |
| `BILLING_INSUFFICIENT_CREDITS` | 402 | no; the model is never called |
| `AI_COPY_IMAGE_INVALID` | 422 | no; `details: { fileId, reason }` |
| `RATE_LIMIT_EXCEEDED` | 429 | no |
| `AI_COPY_FAILED` | 502 | refunded in full: timeout, or nothing usable |
| `AI_COPY_UNAVAILABLE` | 503 | refunded in full: switched off, or the writing service is down |

## Where it differs from the request document

1. **Timeout is `AI_COPY_FAILED`**, as asked. "Unavailable" means the service could not be reached.
2. **`tags` minimum is 3, not 5.** Five is what the model is asked for. Below three the field fails
   and is refunded, because a vendor should not pay a credit for one tag.
3. **Model.** Owner decision: the model runs in an n8n workflow and uses the cheap models already
   in use, `openai/gpt-5.6-luna` first and `qwen/qwen3.8-flash` as fallback. It does not use Claude.
   The system prompt lives in that workflow, not in the request (§ 6 of the request holds).
4. The price is now published at `/api/public/credit-packs` (`aiCopyField`), so `AI_COPY_FIELD_COST`
   in the dashboard can read it rather than mirror it.

Engine and prompt: [`../n8n/ai-listing-copy/README.md`](../n8n/ai-listing-copy/README.md).
