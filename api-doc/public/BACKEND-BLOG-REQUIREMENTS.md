# Backend requirements — blog / articles

What `backend/jovi-mall` has to provide for the article pages under
`src/app/[locale]/(marketing)/blog/` to run on real content instead of fixtures.

The frontend is **complete and working today** against
`src/lib/blog/blog.fixtures.ts`. Nothing below is needed to see the pages —
it is needed to let someone who is not a developer publish an article.

Routes shipped:

| Route | Example (en / fr) |
|---|---|
| Index | `/blog` · `/fr/blog` |
| Article | `/blog/how-to-sell-on-whatsapp-without-a-website` · `/fr/blog/comment-vendre-sur-whatsapp-sans-site-web` |
| Category hub | `/blog/category/payments-and-payouts` · `/fr/blog/category/payments-and-payouts` |

Everything the pages read goes through **`src/lib/blog/blog.api.ts`**. That
module is the entire integration surface: replace the fixture reads inside it
with `fetch` calls and no page, no component and no type changes. Each function
below names the endpoint it should call.

---

## 1. The shape of an article

Defined in `src/lib/blog/blog.types.ts`, which is the authoritative version —
this section is the summary and the reasoning.

```jsonc
{
  "id": "getting-paid-on-whatsapp",       // stable across translations & edits
  "categoryKey": "payments",              // one of the five keys in §3
  "authorId": "wimall-editorial",
  "publishedAt": "2026-07-08T08:00:00.000Z",   // ISO 8601, UTC
  "updatedAt": "2026-07-30T09:20:00.000Z",     // ISO 8601, UTC — omit if never revised
  "featured": true,                            // optional
  "cover": {                                   // optional — see §6
    "url": "https://cdn.example/covers/paid.jpg",
    "alt": "…",
    "width": 1600,
    "height": 900
  },
  "translations": [ /* one per language, see below */ ]
}
```

```jsonc
{
  "locale": "fr",                                        // en | fr | pt | es | ar
  "slug": "se-faire-payer-sur-whatsapp-au-cameroun",     // localized, unique per locale
  "title": "Se faire payer sur WhatsApp au Cameroun",
  "metaTitle": "Se faire payer sur WhatsApp au Cameroun — MoMo, OM et espèces", // optional
  "excerpt": "…",                                        // card copy + meta description
  "body": [ /* blocks, see §2 */ ]
}
```

### Three model decisions that are not negotiable without frontend work

**1. One article, many translations — not one article per language.**
The English and French versions of a post are the same document. The pages need
to know they are related in order to emit `hreflang` linking them, and the
sitemap submits one row per article carrying its language alternates. Storing
them as unrelated documents makes that impossible to reconstruct.

**2. Slugs are per-translation and localized.**
`/fr/blog/comment-vendre-sur-whatsapp-sans-site-web`, not the English slug under
a French prefix. The keyword in the path is a meaningful part of why the page
ranks, and French is where the competition is thinnest — this blog exists for
that. **A slug must be unique within its locale**, and should be immutable once
published; if it must change, the backend owes us a redirect (§9).

**3. A missing translation is a 404, not a fallback.**
`/pt/blog/<english-slug>` must not exist. Serving English prose at a Portuguese
URL publishes a page whose content contradicts its own `lang` attribute and
competes with its own original. The frontend enforces this — it only generates
the `(locale, slug)` pairs that exist — but the API must not paper over it by
substituting a default language.

The one deliberate exception is the **author bio**, which does fall back to
English. A blank byline where the structured data expects an author is worse
than a bio in the wrong language.

---

## 2. Article bodies are typed blocks, not HTML

`body` is a JSON array of typed blocks. **Please do not send an HTML string.**

Reasons, in order of weight:

1. **Security.** An HTML string from a CMS has to be sanitised on the way in and
   rendered with `dangerouslySetInnerHTML` on the way out. One missed edge case
   is stored XSS on the marketing domain — the same origin as the auth pages.
   Blocks render through React components that cannot emit markup an author did
   not ask for by name.
2. **Validation.** A block array is checkable at the boundary. An HTML string is
   checkable only by a sanitiser you have to keep current.
3. **Reuse.** A `faq` block becomes both an accordion and `FAQPage` structured
   data. An `h2` becomes a table-of-contents entry. Neither is recoverable from
   a string without parsing it.

### The block vocabulary

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

`RichText` is a flat array of inline spans — no nesting:

```jsonc
[
  { "type": "text", "text": "Commission is taken " },
  { "type": "text", "text": "at payment", "bold": true },
  { "type": "text", "text": ", not at payout. See " },
  { "type": "link", "text": "the pricing page", "href": "/pricing" },
  { "type": "text", "text": "." }
]
```

Span marks are `bold`, `italic`, `code`, and they compose on one span.

### Rules the editor must enforce

- **`heading.id` is authored, not derived from the text.** Deriving it means
  every anchor breaks the moment a title is edited or retranslated, silently
  killing any link anyone shared into the middle of an article. Ids must be
  unique within a body.
- **Internal `link.href` values carry no locale prefix.** Write `/pricing`, not
  `/fr/pricing` — the renderer localizes it. A prefixed path renders as
  `/fr/fr/pricing`. Anything starting `http(s)://` is treated as external and
  gets `rel="nofollow noopener noreferrer"` plus `target="_blank"`.
- **`image.width` and `image.height` are required.** They reserve the box so a
  loading image does not shift the paragraph under it.
- Adding a new block type means a frontend change. `ArticleBody.tsx` switches
  exhaustively over the union, so an unknown type is a **compile** error rather
  than a blank space on a live page — but it does mean the two must ship
  together.

---

## 3. Categories

Five, seeded, with stable keys. The frontend owns the slug and the accent
colour; the backend only needs the key.

| `key` | slug (URL) |
|---|---|
| `selling` | `selling-on-whatsapp` |
| `payments` | `payments-and-payouts` |
| `delivery` | `delivery-and-logistics` |
| `growth` | `growing-your-business` |
| `guides` | `product-guides` |

Category **labels are translated in the frontend message catalog**
(`messages/*.json` → `pages.blog.categories.<key>`), not returned by the API.
They are five words per language, they belong with the rest of the site chrome,
and routing them through the API would mean a deploy to fix a typo.

Category **slugs are deliberately locale-agnostic**, unlike article slugs: a
category page is an internal hub whose traffic comes from the blog itself, so
the keyword-in-path argument does not apply and a stable slug is one fewer
lookup table to keep in sync across five languages.

Adding a sixth category is a frontend change (`CategoryKey` is a union type).
Ask before adding one — a category with one article in it is an empty hub that
dilutes the internal linking it exists to concentrate.

---

## 4. Authors

```jsonc
{
  "id": "wimall-editorial",
  "name": "The WiMall team",
  "type": "Organization",              // "Person" | "Organization"
  "avatarUrl": "https://…",            // optional
  "translations": {
    "en": { "title": "Editorial", "bio": "…" },
    "fr": { "title": "Rédaction", "bio": "…" }
  }
}
```

`name` is not translated — a person's name is the same in five languages. The
job title and bio are.

**`type` matters and is not cosmetic.** It becomes the `@type` of the `author`
node in the article's `BlogPosting` structured data. A house byline like "The
WiMall team" is an `Organization`; marking it `Person` asserts that a human by
that name exists. That is the same class of claim as the invented review counts
`src/lib/seo/jsonld.ts` already refuses to emit, and it is the kind of thing
that earns a manual action rather than a warning.

---

## 5. Endpoints

Envelope is the project's existing `{ success, data }`, same as
`/api/public/plans`. All of these are **public, unauthenticated, GET**, and are
fetched server-side during the build/revalidation — so no CORS is involved.

### 5a. `GET /api/public/articles`

Article **summaries** for one locale. This is the index and the category hubs.

| Query param | Meaning |
|---|---|
| `locale` | **Required.** `en\|fr\|pt\|es\|ar`. Returns only articles that have a translation in it. |
| `category` | Optional category key. |
| `limit`, `offset` | Optional. Default limit 24. See §7 on pagination. |

Returns, per article, everything in §1 **except `body`**, plus the resolved
author and the `pathByLocale` map:

```jsonc
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "getting-paid-on-whatsapp",
        "locale": "fr",
        "slug": "se-faire-payer-sur-whatsapp-au-cameroun",
        "title": "…", "metaTitle": "…", "excerpt": "…",
        "categoryKey": "payments",
        "author": { "id": "…", "name": "…", "type": "Organization", "title": "…", "bio": "…" },
        "publishedAt": "…", "updatedAt": "…",
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

`availableLocales` is what the frontend turns into `pathByLocale` for hreflang.
It must list exactly the locales the article is **published** in.

**Ordering: `publishedAt` descending.** The index, the sitemap and the
previous/next links at the foot of an article all assume one order; if the API
returns a different one, prev/next stops matching what the index showed.

### 5b. `GET /api/public/articles/{slug}?locale=…`

One article **with its body**. `slug` is the localized slug, so the pair
`(locale, slug)` is the key. `404` when that pair does not exist — including
when the article exists but not in that locale (§1, decision 3).

Returns the summary fields above plus `body` (§2).

### 5c. `GET /api/public/articles/index`

Everything needed to enumerate routes at build time, and nothing else. Called
by `generateStaticParams` and by `app/sitemap.ts`.

```jsonc
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

Deliberately separate from 5a: the build needs every `(locale, slug)` pair in
one round-trip, and paying for five paginated calls with full summaries to get
a list of slugs would be the slowest part of the build.

### 5d. `GET /api/public/authors` *(optional)*

Only if authors become editable. While there are two house bylines, returning
them inline on each article (as 5a/5b do) is simpler and saves a round-trip.

### Caching

Match the plan catalog's convention: `Cache-Control: public, max-age=300`, and
the frontend uses `next: { revalidate: 300 }`. A published article is visible
within five minutes plus the page's own revalidation. **That is not instant and
must not be described to an editor as instant.**

---

## 6. Images

**No article currently ships an image, and that is deliberate.** Cards and
article headers render generated SVG cover art (`components/blog/CoverArt.tsx`)
— deterministic in the article id, themed from the category accent, zero network
requests. The alternative was stock photography, which tells the reader nothing
and costs a round-trip on the thin connections this product targets.

When real images do arrive, two things are needed and neither is done:

1. **A host allowlisted in `next.config.ts` (`images.remotePatterns`).** Until
   then, covers and inline images render as plain `<img>` rather than
   `next/image` — correct but unoptimised. There are `eslint-disable` comments
   marking every one of those sites.
2. **`width` and `height` on every image, from the backend.** Without them the
   page shifts as images load, which is a Core Web Vitals penalty on exactly the
   pages that exist to rank.

Recommended cover aspect ratio: **16:9**, at least 1200px wide (it is also the
`og:image`, and 1200×630 is the social-card floor).

---

## 7. Pagination and rendering mode — the one real handoff

Two frontend constants are correct **only** while articles are a compile-time
fixture, and both must change on the same day the API lands.

### 7a. `dynamicParams = false`

Set in `blog/[slug]/page.tsx` and `blog/category/[category]/page.tsx`. It means
a slug not in `generateStaticParams` is a static 404 — right for a fixture,
**wrong for a CMS**: an article published at 10am would 404 until the next
deploy.

Change to `export const dynamicParams = true` and add
`export const revalidate = 300`. New articles then appear on first request and
are cached from then on.

### 7b. `/blog` renders every article on one page

Fine for five. **Not fine past roughly thirty** — the page gets heavy and the
oldest articles end up too many links from the homepage to be crawled often.

The fix is path-based pagination — `/blog/page/2` — and **not** infinite scroll
or a "load more" button. Client-side pagination produces one indexable URL no
matter how many articles exist, which for a blog whose entire purpose is
ranking defeats the exercise. That is why 5a takes `limit`/`offset`; the
frontend just does not use them yet.

---

## 8. Before any of this is published: `BLOG_IS_PLACEHOLDER`

`src/lib/blog/blog.fixtures.ts` exports `BLOG_IS_PLACEHOLDER = true`. While it
is true:

- every blog page carries `robots: noindex, follow`, and
- no blog URL appears in `app/sitemap.ts`.

The five fixture articles are **structural placeholders, not publishable
editorial**. They are written to be factually true — every claim in them is one
already verified against the backend and recorded in
`BACKEND-REQUIREMENTS.md` §2 — but they have not been reviewed by a person, and
publishing unreviewed generated prose on a new domain is the fastest way to
teach Google that this site is a content farm. The project already took the
same precaution with the mock shop catalog.

`follow` is deliberate: the internal links from an article to `/pricing` still
pass their signal, so the blog is not a dead end while it waits.

Flipping the constant to `false` is a one-line change that puts every article
and category URL into the sitemap with its hreflang set and drops the noindex.
**It belongs to whoever has read the prose**, not to whoever wires up the API.

Two rules for anyone writing or importing articles, enforced by convention
rather than by code:

- **No prices in article bodies.** Not a plan price, not a credit pack price,
  not a commission percentage. `src/lib/marketing/copy-claims.ts` holds the
  *marketing pages'* prose to the live catalog at build time; article bodies are
  not covered by that guard, so a number written into one goes stale silently.
  Say "your plan's rate" and link to `/pricing`, which is always live.
- **No invented metrics.** No "vendors see a 40% lift". There is no measurement
  behind a figure like that, and it would sit on a page carrying `Article`
  structured data.

---

## 9. Smaller things worth deciding now

| Question | Recommendation |
|---|---|
| **Draft vs published** | The public endpoints must return published only. A preview mode for editors is a separate, authenticated concern — do not solve it by returning drafts with a flag. |
| **Slug changes** | Treat a published slug as immutable. If one must change, the backend owes a permanent redirect from the old localized path, or the article loses whatever ranking it had. |
| **Deleting an article** | Prefer unpublishing plus a 410, or a redirect to the category hub. A 404 on a URL with inbound links wastes them. |
| **A translation added later** | Fine and expected. The article's hreflang set grows on the next revalidation; nothing needs a deploy. |
| **`readingMinutes`** | Do not send it. The frontend computes it from the body (`blog.format.ts`) so it cannot drift from the text after an edit. Send `wordCount` if convenient; it is used in the structured data. |
| **Slug collisions with routes** | An article slugged `category` would collide with `/blog/category/…`. Reject that one slug at the editor. |
| **`featured`** | At most one per locale. The index leads with it and falls back to the newest article if none is set, so it is an editorial nicety, not a requirement. |

---

## 10. Summary of the ask

Minimum to go live on real content:

1. `GET /api/public/articles?locale=…&category=…&limit=…&offset=…` — summaries.
2. `GET /api/public/articles/{slug}?locale=…` — one article with its body.
3. `GET /api/public/articles/index` — every `(locale, slug)` pair plus dates.
4. An editor that produces §2 blocks, enforces authored heading ids, and refuses
   locale-prefixed internal links.
5. `Cache-Control: public, max-age=300` on all three.

Frontend work that pairs with it (one commit, in `blog.api.ts` plus two route
files): swap the fixture reads for fetches, flip `dynamicParams` to `true`, add
`revalidate = 300`.
