# Public API — the blog

**No authentication.** Three endpoints, readable by a logged-out visitor, built to the ask in
[BACKEND-BLOG-REQUIREMENTS.md](../BACKEND-BLOG-REQUIREMENTS.md). They exist so the article pages under
`src/app/[locale]/(marketing)/blog/` can run on real content instead of `blog.fixtures.ts`.

The editor's side is **not in this service any more.** It moved to wi-admin at Phase 5 Part A and is
documented there as `admin/docs/api/content.md` (`/api/v1/content`); `/api/admin/articles` and
`/api/admin/article-authors` no longer exist here. Same data — wi-admin writes these collections
directly — and the schema and indexes below are still declared in this repository.

## Base path

```
/api/public
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public/articles?locale=…` | Article **summaries** for one locale — the index and the category hubs |
| GET | `/api/public/articles/index` | Every `(locale, slug)` pair plus dates — `generateStaticParams` + `sitemap.ts` |
| GET | `/api/public/articles/{slug}?locale=…` | One article **with its body** |

All three use the standard [response envelope](../README.md#the-response-envelope-read-this-first) and
send `Cache-Control: public, max-age=300`.

> **The five-minute window is real.** A newly published article is invisible to the site for up to
> five minutes, **plus** whatever your own `revalidate` adds. That is not instant and must not be
> described to an editor as instant.

---

## The three model decisions, as built

**1. One article, many translations.** The English and French versions of a post are one document, so
`hreflang` and the sitemap's language alternates are reconstructible. `availableLocales` on every
summary is exactly that set.

**2. Slugs are per-translation and localized**, and unique within a locale. The same slug in two
different languages is fine and is two distinct keys.

**3. A missing translation is a 404, never a fallback.** `/pt/<english-slug>` does not resolve — not
as English prose, not as a redirect. The one deliberate exception is the **author bio**, which falls
back to English (`title` and `bio` only; `name` is never translated).

---

## GET /api/public/articles

Summaries for one locale. Returns only articles that have a **published** translation in it.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `locale` | `en` \| `fr` \| `pt` \| `es` \| `ar` | — | **Required.** No default: a default would silently serve English to a caller that forgot the parameter. |
| `category` | category key | all | One of `selling`, `payments`, `delivery`, `growth`, `guides`. **The key, not the URL slug** — the slug is yours. |
| `limit` | number | `24` | 1–100. |
| `offset` | number | `0` | |

### Ordering

**`publishedAt` descending**, with the article id as tie-break. The index, this list, the sitemap and
the prev/next links at the foot of an article are three views of one sequence — the tie-break is what
keeps two articles published in the same second from ordering differently between them.

### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "getting-paid-on-whatsapp",
        "locale": "fr",
        "slug": "se-faire-payer-sur-whatsapp-au-cameroun",
        "title": "Se faire payer sur WhatsApp au Cameroun",
        "metaTitle": "Se faire payer sur WhatsApp — MoMo, OM et espèces",
        "excerpt": "…",
        "categoryKey": "payments",
        "author": {
          "id": "wimall-editorial",
          "name": "The WiMall team",
          "type": "Organization",
          "title": "Rédaction",
          "bio": "…",
          "avatarUrl": null
        },
        "publishedAt": "2026-07-08T08:00:00.000Z",
        "updatedAt": "2026-07-30T09:20:00.000Z",
        "featured": false,
        "cover": null,
        "wordCount": 1180,
        "availableLocales": ["en", "fr"]
      }
    ],
    "total": 5
  }
}
```

`data` is an **object** (`{ items, total }`), not the project's usual `meta` page envelope — `total`
alongside `limit`/`offset` is what path-based pagination needs.

### Fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable across translations **and** edits. Safe to hash for generated cover art. |
| `locale`, `slug`, `title`, `excerpt` | string | The requested translation, flattened onto the article. |
| `metaTitle` | string | **Omitted** when unset, not `null`. |
| `categoryKey` | string | One of the five keys. Labels and URL slugs are yours. |
| `author` | object | Resolved inline — no second round-trip. `title`/`bio` in the requested locale, English if absent. |
| `publishedAt` | string | ISO 8601, UTC. Always present. |
| `updatedAt` | string | ISO 8601, UTC. **Omitted when never revised.** Content revisions only — re-featuring or re-categorising an article does not move it. |
| `featured` | boolean | At most one per locale; see below. |
| `cover` | object \| null | Explicit `null` when absent (unlike the two above). `{ url, alt, width, height }`. |
| `wordCount` | number | Derived from the body on write, so it cannot drift from the prose. |
| `availableLocales` | string[] | Exactly the locales this article is **published** in, in the order `en, fr, pt, es, ar`. |

`readingMinutes` is deliberately **not** sent — compute it from the body you are about to render, as
`blog.format.ts` already does, so it cannot go stale after an edit.

### `featured`

At most one per locale, enforced by **demotion**: featuring an article un-features whatever it would
have competed with in the languages it shares. `featured` is per-article while the rule is per-locale,
so refusing would ask an editor to go and find out what is featured in four other languages first.

An editorial nicety, not a guarantee — lead with `featured` if one is set and fall back to the newest
article, which is what the index already does.

---

## GET /api/public/articles/index

Everything needed to enumerate routes at build time, and nothing else. Unpaginated.

```json
{
  "success": true,
  "data": [
    {
      "id": "getting-paid-on-whatsapp",
      "categoryKey": "payments",
      "publishedAt": "2026-07-08T08:00:00.000Z",
      "updatedAt": "2026-07-30T09:20:00.000Z",
      "translations": [
        { "locale": "en", "slug": "getting-paid-on-whatsapp-in-cameroon" },
        { "locale": "fr", "slug": "se-faire-payer-sur-whatsapp-au-cameroun" }
      ]
    }
  ]
}
```

Same order as the list. `translations` carries only **published** locales, so every pair here is a
route that resolves. An article whose every translation is drafted is omitted entirely rather than
contributing a row with no alternates.

> `index` is a **reserved slug** — no article can be published at an address that would shadow this
> endpoint. The route is also declared before `/:slug`, so the two protections cover each other.

---

## GET /api/public/articles/{slug}?locale=…

One article with its body. The pair `(locale, slug)` is the key.

Returns every summary field above **plus `body`** (see [The block vocabulary](#the-block-vocabulary)).

### The four outcomes

| Situation | Status | `error.code` | What to do |
|---|---|---|---|
| Resolves | `200` | — | Render. |
| Nothing at this address, **or** the article exists but not in this locale | `404` | `BLOG_ARTICLE_NOT_FOUND` | `notFound()`. |
| The slug is a **retired** one | `404` | `BLOG_ARTICLE_MOVED` | **Issue a permanent redirect** to `details.slug`. |
| The article was archived | `410` | `BLOG_ARTICLE_GONE` | Redirect to the category hub in `details.categoryKey`, or render a 410. |

### `BLOG_ARTICLE_MOVED` — why it is not an HTTP redirect

```json
{
  "success": false,
  "error": {
    "code": "BLOG_ARTICLE_MOVED",
    "statusCode": 404,
    "details": {
      "locale": "en",
      "slug": "how-to-get-paid-on-whatsapp",
      "previousSlug": "getting-paid-on-whatsapp-in-cameroon",
      "id": "getting-paid-on-whatsapp"
    }
  }
}
```

This API can only redirect **its own** URL. The URL that needs the 301 is the *page* — and only the
frontend can emit that. So the backend answers with the current slug and the page calls
`permanentRedirect(...)`; a `fetch` following an HTTP redirect would silently render the article at
the stale address, which is the duplicate-content problem the redirect exists to avoid.

A retired slug keeps working indefinitely, and **no other article can ever claim it** — a reused slug
turns a permanent redirect into a wrong answer, which is worse than the 404 it was avoiding.

---

## The block vocabulary

`body` is a JSON array of typed blocks. **It is never an HTML string** — every block is validated at
the boundary by a strict schema (`validators/article-body.validator.ts`), and an unknown block type,
an unknown *key* on a known block, or a `javascript:` href is a `400`, not a silently accepted field.

| `type` | Fields |
|---|---|
| `heading` | `level` (2\|3), `id`, `text` |
| `paragraph` | `text`: `RichText` |
| `list` | `ordered?`, `items`: `RichText[]` |
| `quote` | `text`, `attribution?` |
| `callout` | `tone` (`note`\|`tip`\|`warning`), `title?`, `text`: `RichText` |
| `image` | `url`, `alt`, `width`, `height`, `caption?` |
| `cta` | `title`, `body`, `href`, `label` |
| `faq` | `items`: `{ question, answer }[]` |
| `divider` | — |

`RichText` is a flat array of inline spans — no nesting. Marks (`bold`, `italic`, `code`) compose on
one span.

```json
[
  { "type": "text", "text": "Commission is taken " },
  { "type": "text", "text": "at payment", "bold": true },
  { "type": "text", "text": ", not at payout. See " },
  { "type": "link", "text": "the pricing page", "href": "/pricing" },
  { "type": "text", "text": "." }
]
```

Guarantees you can rely on when rendering:

- **`heading.id` is authored**, never derived from the text, and **unique within a body** — so an
  anchor survives a retitle or a retranslation, and a table of contents is recoverable in one pass.
- **Internal `href`s carry no locale prefix.** `/fr/pricing` is refused at the editor, so a plain
  `/pricing` is safe to localize. Allowed forms: `/path`, `#fragment`, `mailto:`, `http(s)://`.
  Everything else — `javascript:`, `data:`, protocol-relative `//host` — is refused.
- **`image.width` and `image.height` are always present**, so the box can be reserved.
- **Spans concatenate with no separator.** `"…taken "` + `"at payment"` is one run; do not insert
  whitespace between them.

Adding a block type is a **two-repo change**: `ArticleBody.tsx` switches exhaustively over the union,
so an unknown type is a compile error there rather than a blank space on a live page.

---

## Categories

Five, with stable keys. **The backend knows only the key** — labels live in your message catalog
(`pages.blog.categories.<key>`) and the URL slug is yours.

| `key` | your slug |
|---|---|
| `selling` | `selling-on-whatsapp` |
| `payments` | `payments-and-payouts` |
| `delivery` | `delivery-and-logistics` |
| `growth` | `growing-your-business` |
| `guides` | `product-guides` |

`?category=` takes the **key**. A sixth category is a two-repo change (`CategoryKey` is a union type
on your side), so ask before adding one.

---

## Reserved slugs

`category`, `page` and `index` are refused at the editor:

- `category` collides with `/blog/category/…`
- `page` collides with the path-based pagination `/blog/page/2` — reserved now, because reserving it
  later means retiring a published URL
- `index` collides with `GET /api/public/articles/index`

---

## Images

Nothing enforces a host, so `cover.url` and `image.url` can be anything `http(s)://` or an internal
path. Two things are still on your side before real images arrive:

1. **Allowlist the host in `next.config.ts` (`images.remotePatterns`)**, or covers keep rendering as
   plain `<img>` rather than `next/image`.
2. Recommended cover: **16:9, ≥1200px wide** — it is also the `og:image`, and 1200×630 is the
   social-card floor. Recommended, not enforced.

---

## Errors

Standard envelope.

| `error.code` | Status | Cause |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing/unknown `locale`, unknown `category`, out-of-range `limit`. `details.fields[]` names it. |
| `BLOG_ARTICLE_NOT_FOUND` | 404 | No published article at this `(locale, slug)`. |
| `BLOG_ARTICLE_MOVED` | 404 | Retired slug. `details.slug` is where it went. |
| `BLOG_ARTICLE_GONE` | 410 | Archived. `details.categoryKey` is the hub to fall back to. |

There is no `401`/`403` path — these routes carry no guard.

---

## Not built (deliberately)

**`GET /api/public/authors`** (§5d of the requirements). Authors are resolved **inline** on every
summary and detail, so while there are two house bylines a separate round-trip buys nothing. It
becomes a route here the day authors are editable by someone who is not an admin.
