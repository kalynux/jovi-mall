# Admin API — the blog editor

The write side of [public/articles.md](../public/articles.md). Everything here is behind
`requireAuth` + `requireRole(['admin'])`.

```
/api/admin/articles
/api/admin/article-authors
```

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/articles` | List — **every status by default** |
| POST | `/api/admin/articles` | Create (always lands as a **draft**) |
| GET | `/api/admin/articles/:id` | One article, full editor shape |
| GET | `/api/admin/articles/:id/preview?locale=…` | The **public** shape, at any status |
| PATCH | `/api/admin/articles/:id` | Edit |
| POST | `/api/admin/articles/:id/publish` | Go live |
| POST | `/api/admin/articles/:id/unpublish` | Back to draft, for a correction |
| POST | `/api/admin/articles/:id/archive` | Retire for good — the URL answers `410` |
| DELETE | `/api/admin/articles/:id` | Only an article that was **never** published |
| GET/POST | `/api/admin/article-authors` | Bylines |
| GET/PATCH/DELETE | `/api/admin/article-authors/:id` | |

`:id` is the article's **stable string id** (`getting-paid-on-whatsapp`), not an ObjectId.

---

## The lifecycle

```
  create ──▶ draft ──publish──▶ published ──archive──▶ archived
                ▲                    │                     │
                └────unpublish───────┘                     │
                └───────────────unpublish──────────────────┘
```

`draft` and `archived` are both invisible publicly, and they are **not** interchangeable:

| | draft | archived |
|---|---|---|
| public detail | `404 BLOG_ARTICLE_NOT_FOUND` | `410 BLOG_ARTICLE_GONE` + `details.categoryKey` |
| meaning | never went live, or pulled for a fix | was live, retired on purpose |

A 404 on a URL with inbound links wastes them. That is why **delete is refused once an article has
ever been published** (`409 BLOG_ARTICLE_DELETE_NOT_ALLOWED`) — archive it instead.

---

## POST /api/admin/articles

Creates a **draft**. `status` is not settable here: created and published are different decisions,
and the second one has a checklist a create body could quietly skip.

```jsonc
{
  "id": "getting-paid-on-whatsapp",     // stable across translations AND edits; immutable
  "categoryKey": "payments",
  "authorId": "wimall-editorial",       // must already exist
  "featured": false,                    // optional
  "cover": {                            // optional, nullable
    "url": "https://cdn.example/covers/paid.jpg",
    "alt": "…",
    "width": 1600,
    "height": 900
  },
  "translations": [
    {
      "locale": "fr",
      "slug": "se-faire-payer-sur-whatsapp-au-cameroun",
      "title": "Se faire payer sur WhatsApp au Cameroun",
      "metaTitle": "…",                 // optional
      "excerpt": "…",
      "body": [ /* typed blocks — see public/articles.md */ ],
      "published": true                 // optional, defaults true
    }
  ]
}
```

`201` with the editor shape. Unknown keys are refused (`.strict()` everywhere), so a typo is a `400`
rather than a silently dropped field.

### What is derived, not accepted

| Field | Derived from |
|---|---|
| `wordCount` | the body, on every write — it cannot drift from the prose |
| `publishedAt` | first publish (or `publish`'s own `publishedAt`) |
| `updatedAt` | a **content comparison** on save (see below) |
| `previousSlugs` | a slug that changed |

### `published` per translation

A language marked `published: false` **404s** on the public route and is absent from
`availableLocales` and from the build index. It is how a live article carries a language that is
still being written — and how a language is taken down without deleting the prose.

---

## PATCH /api/admin/articles/:id

Every field optional; `id` is absent because it is immutable.

**`translations` is a full-array replace, not a merge.** A merge cannot express "remove the Spanish
translation", and a per-locale endpoint would leave the array's one cross-element rule (unique
locales) unenforceable. Omit the key to leave every translation untouched.

### Renaming a slug

Treat a published slug as immutable — changing one throws away whatever ranking the URL had. When one
must change anyway, the rename is handled rather than refused:

1. the old slug moves to `previousSlugs`,
2. the public route answers `404 BLOG_ARTICLE_MOVED` on it with the current slug, and
3. **no other article can ever claim it** (`409 BLOG_SLUG_TAKEN`).

Renaming back to a previous slug removes it from the history — it is current again, not retired.

### What counts as a revision

`updatedAt` (the article's `dateModified` in structured data) is stamped only when the **prose**
changes: a title, `metaTitle`, excerpt, slug, body, cover, or the set of languages. Deliberately not
stamped by `featured`, `categoryKey`, `authorId`, or flipping a translation's `published` — those move
the document, so a naive "did the row change?" test would report a revision that did not happen.

Only a **published** article accrues revisions; a draft has no readers for a `dateModified` to
describe.

---

## POST /api/admin/articles/:id/publish

```jsonc
{ "publishedAt": "2026-07-08T08:00:00.000Z" }   // optional — for importing an article
```

`publishedAt` is stamped on the **first** publish only. A republish after an unpublish keeps the
original date, because it is the sort key the index, the sitemap and the prev/next links share —
re-stamping it silently reorders pages that link to each other.

### The blocker checklist

`422 BLOG_ARTICLE_NOT_PUBLISHABLE` with **every** reason at once, not the first:

```json
{
  "error": {
    "code": "BLOG_ARTICLE_NOT_PUBLISHABLE",
    "statusCode": 422,
    "details": {
      "id": "getting-paid-on-whatsapp",
      "blockers": [
        "The byline this article credits does not exist — create the author first",
        "Every translation is marked unpublished — at least one language must be live"
      ]
    }
  }
}
```

Publishing is an explicit human action; telling an editor about one problem at a time, over three
round-trips, is how a publish button earns a reputation for being broken.

---

## GET /api/admin/articles/:id/preview?locale=…

Returns **exactly** the public detail shape, for an article at any status — so what an editor
approves is what ships.

It exists so that previewing never becomes a reason to relax the public endpoints. Drafts are not
returned publicly behind a flag; the difference between this and
`GET /api/public/articles/{slug}` is `requireRole(['admin'])`, and that is the whole point.

---

## Bylines — `/api/admin/article-authors`

```jsonc
{
  "id": "wimall-editorial",
  "name": "The WiMall team",            // NOT translated — a name is the same in five languages
  "type": "Organization",               // "Person" | "Organization"
  "avatarUrl": null,                    // optional
  "translations": {
    "en": { "title": "Editorial", "bio": "…" },   // English is REQUIRED
    "fr": { "title": "Rédaction", "bio": "…" }
  }
}
```

**`type` is not cosmetic.** It becomes the `@type` of the `author` node in the article's
`BlogPosting` structured data. A house byline like "The WiMall team" is an `Organization`; marking it
`Person` asserts that a human by that name exists — the same class of claim as an invented review
count, and the kind that earns a manual action rather than a warning.

**English is required** because it is the fallback every other locale resolves to. It is the one
deliberate fallback in the module: a blank byline where the structured data expects an author is
worse than a bio in the wrong language. Article *prose* never falls back.

`DELETE` is refused while any article credits the byline (`409 BLOG_AUTHOR_IN_USE`, with
`details.articleCount`). Re-point the articles first.

Seed the house byline on a fresh database with `npm run seed:blog`.

---

## Errors

| `error.code` | Status | Cause |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Bad block, unknown key, locale-prefixed href, duplicate heading id, duplicate locale… `details.fields[]` names the path. |
| `BLOG_SLUG_RESERVED` | 400 | Slug is `category`, `page` or `index`. |
| `BLOG_ARTICLE_NOT_FOUND` | 404 | Unknown article id, or `preview` for a locale it has no translation in. |
| `BLOG_AUTHOR_NOT_FOUND` | 404 | `authorId` does not exist. |
| `BLOG_ARTICLE_KEY_TAKEN` | 409 | `id` already used. |
| `BLOG_SLUG_TAKEN` | 409 | Another article holds this `(locale, slug)` — **including as a retired slug**. |
| `BLOG_ARTICLE_ALREADY_PUBLISHED` | 409 | Publishing a published article. |
| `BLOG_ARTICLE_DELETE_NOT_ALLOWED` | 409 | The article has been live. Archive it. |
| `BLOG_AUTHOR_KEY_TAKEN` | 409 | Author `id` already used. |
| `BLOG_AUTHOR_IN_USE` | 409 | Author is credited on `details.articleCount` article(s). |
| `BLOG_ARTICLE_NOT_PUBLISHABLE` | 422 | See the blocker checklist above. |

---

## Two rules enforced by convention, not by code

Both come from §8 of the requirements and neither is checkable at the boundary:

- **No prices in article bodies.** Not a plan price, not a credit pack price, not a commission
  percentage. `copy-claims.ts` holds the *marketing pages'* prose to the live catalog at build time;
  article bodies are not covered by that guard, so a number written into one goes stale silently. Say
  "your plan's rate" and link to `/pricing`, which is always live.
- **No invented metrics.** No "vendors see a 40% lift". There is no measurement behind a figure like
  that, and it would sit on a page carrying `Article` structured data.

---

## Tests

```bash
npm run test:blog       # 100 assertions, DB-free — blocks, slugs, derivations, DTO projection
npm run verify:blog     # 47 assertions, NEEDS Mongo — index builds, the lifecycle, route order
```

`verify:blog` exists for what the DB-free suite structurally cannot see: that the **unique multikey
index on `slug_keys` actually builds** (it exists because MongoDB refuses a compound index on
`translations.locale` + `translations.slug` — parallel array paths), that the `$elemMatch` queries
run, and that `/articles/index` is declared before `/articles/:slug`. It writes `verify-blog-*`
documents and deletes them again, pass or fail.
