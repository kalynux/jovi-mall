# Marketing landing + shop — what Phase 4 and Phase 5 changed

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md)
- **The signed-in half of the shop** is [../customer/FRONTEND-CHANGELOG-phase-4-5.md](../customer/FRONTEND-CHANGELOG-phase-4-5.md)
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

> **Headline: no public endpoint changed in either phase.** `/api/public/articles*`,
> `/api/public/catalog*` and `/api/public/plans` are byte-identical. What changed is **who owns
> the blog editor** — and therefore where the block-type contract you switch on now lives.

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 The **blog editor moved to wi-admin**; the block union's authority moved with it | **Required if you own `ArticleBody.tsx`** — one doc pointer and one ordering rule |
| 2 | `FileDetail` on catalog DTOs gained an `access` field | Small — widen the type |
| 3 | Every public read is unchanged | None |
| 4 | The shop's signed-in half inherits a 90-day session cap | See the customer document |

---

## 1 · 🔴 The blog editor moved — and so did the authority for the block union

### What moved

`/api/admin/articles` and `/api/admin/article-authors` **no longer exist in jovi-mall.** Writes to
`articles` and `article_authors` are wi-admin's now
([`admin/docs/api/content.md`](../../../admin/docs/api/content.md), 14 routes at `/api/v1/content`).

### What did not move

**Everything you call.** [articles.md](./articles.md) is unchanged as a contract:

| | |
|---|---|
| `GET /api/public/articles?locale=…` | unchanged — summaries, `featured`, categories |
| `GET /api/public/articles/:slug?locale=…` | unchanged — summary fields plus `body` |
| `BLOG_ARTICLE_MOVED` | unchanged — still carries the current slug on a renamed article |
| hreflang / `availableLocales` | unchanged |
| The `slug_keys` history mechanism | unchanged, and **still declared in jovi-mall** |

jovi-mall keeps the Mongoose schema, the indexes — including the unique multikey index on
`slug_keys` that exists only because Mongo refuses a compound index on two parallel array paths —
and the whole public read half. wi-admin owns the *writes* to a collection whose *schema and
indexes* live in another repository. That split is deliberate and written down; it is the reason
nothing on your side moved.

### The part that is actually yours: the block vocabulary

`body` is a JSON array of typed blocks over a **nine-type discriminated union**, and
`ArticleBody.tsx` switches over it exhaustively so an unknown type is a compile error rather than
a blank space on a live page. [articles.md § The block vocabulary](./articles.md#the-block-vocabulary)
still describes this as a *two-repo* change. **After Phase 5 there are three copies of that union
and only one of them is the authority:**

| Repository | Role |
|---|---|
| **wi-admin** `content/validators/article-body.validator.ts` | 🟢 **The authority.** It is the only writer. A block type is added here first. |
| **jovi-mall** `blog/validators/article-body.validator.ts` | A duplicate, kept for the `ArticleBody` **type** on the public DTO and for the cross-repo fixture assertion below |
| **Marketing site** `ArticleBody.tsx` | Your exhaustive switch |

There is **no shared package and there will not be one.** The house mechanism is a mirrored
fixture list, the same one `test:rich-description` uses for your chat formatters: wi-admin's
`test:content` owns a list of 17 block documents with their expected verdict, and jovi-mall's
`test:blog` asserts its retained schema reaches the **identical** verdict on the **identical**
list. Neither repository imports the other; both go red when they disagree.

⚠ **Nothing checks *your* copy.** That is the same gap the Phase 2 · 3 changelog recorded for the
chat formatter, and it is unchanged.

**The ordering rule, unchanged and still load-bearing: the reader ships first.** A new block type
must be deployed to the marketing site *before* an editor can publish one, or the first article
using it renders a blank space — or throws, if your switch is exhaustive — on a live page. When
a block type is added, ask wi-admin to hold the editor grant until your release is out.

### Doc pointers to fix

`jovi-mall/api-doc/admin/articles.md` was **deleted**. If you have it bookmarked, the editor
contract is now [`admin/docs/api/content.md`](../../../admin/docs/api/content.md). Everything you
read is still [articles.md](./articles.md).

---

## 2 · `FileDetail` gained an `access` field

Product media, store logos and banners on the public catalog DTOs come back as `FileDetail`. That
shape gained a field, and one of its fields became nullable:

```jsonc
{ "id": "…", "key": "products/…", "url": "https://…/api/files/products/…",
  "access": "public",                      // ← new, always present
  "mimeType": "image/webp", "size": 10241, "originalName": "…" }
```

| Field | Type | Meaning |
|---|---|---|
| `url` | `string \| null` | Fetchable directly when a string. `null` means there is no public URL. |
| `access` | `"public" \| "authorized"` | Which of the two this is. **Always present.** |

**Nothing on the storefront is `authorized` today**, and no public URL changed by a single byte —
this was a routing change, not a migration, and nothing moved on disk. The two private trees are
digital-product files and delivery-proof photos, neither of which appears in a public DTO.

**So why look at it at all?** Three catalog read paths (`ProductListService`,
`enrich-product-detail`, `vendor-profile.dto`) were assembling `FileDetail` **by hand** and now go
through the one resolver, so this field arrives on the shop's product cards and detail pages. If
your type is a hand-written interface, widen it: `access` will be present and `url` is now
`string | null` on the shared shape.

Full detail, including the reasoning for `null`:
[../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md).

---

## 3 · Everything else on the public surface is unchanged

Verified against a running server after the Phase 5 cutover:

| Path | Behaviour |
|---|---|
| `GET /api/public/plans` | **200** — plan catalog and credit packs, unchanged |
| `GET /api/public/articles` | **400** without `locale` — unchanged; `locale` has always been required |
| `GET /api/health` | **200** — still the frozen contract: exact path, exact body, unconditional 200, no `{success,data}` envelope, exempt from rate limiting and maintenance mode |
| `GET /api/public/catalog/*` | unchanged — products, categories, stores; product URLs still nested under their store |

**Rate limits are unchanged.** The IP-scoped layer in front of the public routes is the same one
Phase 16 introduced; ceilings are backstops, not budgets, and the store still fails **open** when
Redis is down.

**The storefront's stock semantics, the six deliberate deviations and the nested product-URL rule**
are all unchanged — [catalog.md](./catalog.md) and
[FRONTEND-CHANGELOG-shop.md](./FRONTEND-CHANGELOG-shop.md) remain accurate.

---

## 4 · The shop's signed-in half — one thing to carry across

The landing page has no session, so § 1 of the cross-role page does not apply to it. **The shop's
signed-in half does**, and there is one required change there:

🔴 **A session is now capped at 90 days absolutely**, announced by
`401 AUTH_SESSION_CAP_REACHED`, which fires on **any** authenticated request and must be routed to
sign-in rather than retried or refreshed. Because customers on this platform sign in
**passwordlessly through the messaging bot**, that re-authentication is one bot round-trip — but a
customer bounced out and shown a password field they never had is the failure mode to avoid.

Detail: [../customer/FRONTEND-CHANGELOG-phase-4-5.md § 1](../customer/FRONTEND-CHANGELOG-phase-4-5.md).

---

## 5 · What did NOT change

- **Every public URL for a file.** Product imagery, store logos and banners, videos, general
  documents — byte-identical.
- **`GET /api/public/articles*`** — paths, DTOs, redirect behaviour, hreflang, categories.
- **The five article categories and their stable keys.** The backend still knows only the key;
  labels stay in your message catalog and the URL slug stays yours.
- **`GET /api/health`'s frozen shape**, if you render a status indicator.
- **There is still no customer registration endpoint.** Customers register on first bot contact;
  the storefront calls nothing for it. [../auth/customer-auth.md](../auth/customer-auth.md).
- **`POST /api/payments/initiate` and `/verify` are still unauthenticated by design** — a mother
  orders and a son pays. Examined and withdrawn as a finding; do not "fix" it.

---

## 6 · Where to look

| Topic | Document |
|---|---|
| The cross-role summary | [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md) |
| The public blog contract | [articles.md](./articles.md) |
| The blog **editor** (wi-admin) | [`admin/docs/api/content.md`](../../../admin/docs/api/content.md) |
| The public catalog | [catalog.md](./catalog.md) · [FRONTEND-CHANGELOG-shop.md](./FRONTEND-CHANGELOG-shop.md) |
| Plans and credit packs | [README.md](./README.md) · [../billing-plans-across-roles.md](../billing-plans-across-roles.md) |
| Private files and `access` | [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) |
| Rate limits | [../rate-limits.md](../rate-limits.md) |
| Health probes | [../health.md](../health.md) |
