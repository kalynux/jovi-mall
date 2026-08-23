# Marketing landing + shop — what Phase 2 and Phase 3 changed

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)
- **The shop's signed-in half** — cart, checkout, orders, order tracking — is
  [../customer/FRONTEND-CHANGELOG-phase-2-3.md](../customer/FRONTEND-CHANGELOG-phase-2-3.md).
  Read both: `/api/public/*` covers the logged-out surface only.

---

## Short version

**No `/api/public/*` endpoint changed.** Not a path, a field, a status code or an error shape.
`/plans`, `/credit-packs`, `/products`, `/categories`, `/stores` and `/articles` all answer
exactly as [README.md](./README.md), [catalog.md](./catalog.md) and
[articles.md](./articles.md) describe them.

What matters to you is **one contract you own that nothing enforces** (§ 1), a **performance
change** you can now design against (§ 2), and how the site should behave around a deploy (§ 3).

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 The **blog block-type union** is a two-repo contract with a **deploy ordering rule** | **Standing process** |
| 2 | Catalog queries are **indexed** now, not scanning | Optional — re-measure |
| 3 | Deploy/restart behaviour for SSR and ISR fetches | Small |
| 4 | The **status/health** endpoint, if the site shows one | Small |
| 5 | Passwordless customer sign-in can now be **silently unavailable** | **Design for it** |
| 6 | Address search is behind auth — no anonymous geocoding | Confirmation, not a change |

---

## 1 · 🔴 The blog block-type union — ship the reader first

`ArticleBody.tsx` in the marketing site switches **exhaustively** over the same block-type union
that jovi-mall validates with `ArticleBlockSchema` — a `z.discriminatedUnion('type', …)` over
nine block types. There is **no enforcement of any kind** between the two repositories: no
shared package, no test, no CI job. This paragraph and the release checklist are the whole of it.

**The two failure directions, and they are not symmetric:**

| Change | Consequence |
|---|---|
| **Adding** a block type to the schema **before** the site has a case for it | An editor can publish a block the site cannot render. |
| **Removing** a block type from the schema | **Breaks a published article** that already uses it. |

**The rule, from [`docs/RUNBOOK.md`](../../../docs/RUNBOOK.md#two-repo-release-checklist)
(row 6) § 4 rule 2 — the reader ships first:**

> Ship the `ArticleBody.tsx` case **first**, then the schema change. Never in one window.

This is the general breaking-change rule of this workspace applied to your repo: **reader first,
tolerant of both shapes; writer second, in a separate release.** It exists because a change that
ignored it has already shipped once (Phase 16's error envelope, on geo-tracker).

**Why it is being raised now.** Phase 3 audited contract enforcement across the workspace and
found that **neither CI workflow had ever executed a single assertion** — one died on a secret
that was never created, the other on a heap OOM, both silently, on every run since they were
written. Both are now fixed and have been watched going green. The audit also found that the
release checklist *claimed* this blog contract was on it when it was not. It is now row 6, with
this ordering rule attached.

Block vocabulary: [articles.md § The block vocabulary](./articles.md#the-block-vocabulary).
Your requirements document: [BACKEND-BLOG-REQUIREMENTS.md](./BACKEND-BLOG-REQUIREMENTS.md).

---

## 2 · Catalog queries are indexed now

`migrate:storefront-indexes` was applied to the dev database as part of Phase 2's migration
backlog. Before it, **every public catalog request scanned the `products` collection.**

No shape changed and nothing in [catalog.md](./catalog.md) is different — but if you had been
avoiding a filter, a sort or a facet because it felt slow, **re-measure it**. The cost model has
changed.

Two related facts:

- **`autoIndex` is now off in production** (still on in development). Index creation is an
  explicit, ledgered migration step, because a failed index build at boot fails **silently** —
  the failure mode where everything works and everything is slow, with no error anywhere.
- A **live defect was fixed** in the same step: the one `$text` index in this codebase (on
  `products`) had always been reported as missing by the operations screens, because MongoDB
  reports a text index as an internal sentinel with the real fields in a sibling, alphabetised
  document. Both sides are canonicalised now. Nothing you call, but it is why "the search index
  is missing" was a false alarm rather than an explanation for a slow search.

⚠ This ran against the **dev** database. There is no production database yet, and the migration
ledger is forward-looking — do not assume production is indexed on day one.

---

## 3 · Deploys no longer truncate requests — what that means for SSR/ISR

jovi-mall previously had **no** shutdown handling: a restart severed in-flight requests
mid-transaction. It now drains.

| What | Value | For a Next.js app |
|---|---|---|
| In-flight requests | complete, not truncated | An SSR render or an ISR revalidation already in flight when a deploy starts **finishes**. |
| Drain budget | `SHUTDOWN_TIMEOUT_MS`, default **10 s** | Anything still running past that is cut. |
| Idle keep-alive sockets | closed after **65 s** | **This one matters.** A long-lived Node server reusing a pooled connection after the backend closed it sees `ECONNRESET`. Keep your fetch agent's idle timeout **below 65 s**, or make ISR revalidation retry once on a connection-level error rather than serving a stale-with-error page. |
| New connections during drain | refused | Retry with backoff. |

The practical design note: **a build-time or revalidation fetch failure should degrade to the
last good content, not to a 500.** These are read-only public endpoints; there is never a reason
for a backend restart to take the marketing site down.

---

## 4 · If the site shows a status indicator

| Service | Liveness | Readiness |
|---|---|---|
| jovi-mall | `GET /api/health/live` | `GET /api/health/ready` |
| geo-tracker | `GET /healthz` | `GET /readyz` |

And the one you are most likely to reach for:

```
GET /api/health  →  200  {"status":"ok","timestamp":"2026-08-19T14:03:11.204Z"}
```

**`GET /api/health` is a frozen wire contract** — exact path, exact body, **unconditional 200**,
**no `{success, data}` envelope** (it is deliberately not in the house response shape), exempt
from rate limiting and from maintenance mode. It is now pinned by a test rather than by a comment.

- It answers **200 while the database is down**. It is a reachability check, not a health check.
  Do not build a "system status: operational" badge on it and imply more than it says.
- `GET /api/health/ready` is the one that 503s on a real dependency failure.
- Do not assume `/api/health` will ever return a non-200 or grow a field. geo-tracker treats any
  status ≥ 300 there as a failure of **its own** readiness, so tightening it would take live
  tracking down across the platform.

See [../health.md](../health.md) and [../system-uptime-status.md](../system-uptime-status.md).

---

## 5 · Passwordless customer sign-in can now be silently unavailable

Customer authentication on this platform is **bot-first**: customers register on first bot
contact and sign in passwordlessly with a code the bot mints. **The storefront calls no
registration endpoint** — see [../auth/customer-auth.md](../auth/customer-auth.md), which is the
canonical document.

Phase 2 set `BOT_WEBHOOK_SECRET`, which had been unset. Those webhooks used to be **open in
development** and fail-closed in production only; they now require an `X-Webhook-Secret` header
everywhere.

**The n8n side must send the same value, or `/connect` answers 401 and mints no codes.** To a
visitor that presents as *"I asked for a login code and nothing arrived"*, with nothing in your
UI to explain it. The n8n workflow is separately still non-functional for an unrelated reason
(it maps `/link`, not `/connect`), and that work lives outside these repositories.

**Design for it:** a "code sent" screen with no timeout and no alternative is a dead end. Give a
retry, a visible timeout, and a fallback contact route.

---

## 6 · Address search stays behind authentication

Not a change — a confirmation, because it was re-verified during the phase-D decision on
geocoding (Q-8, "own the geocoding or rent it").

Both geocoding call sites sit behind `requireAuth`, so **no anonymous storefront traffic reaches
the geocoding provider**. The public catalog and the blog do not geocode. The decision taken was
*cache first, then rent one adapter*, and it is Phase 6 work — nothing lands on your surface yet.

If a future landing feature wants address autocomplete for a logged-out visitor, that is a new
public surface and a new decision, not an existing endpoint you can call.

---

## 7 · What explicitly did not change for you

- **The public envelope and every `/api/public/*` endpoint.** Unchanged.
- **Rate limits.** Anonymous traffic is IP-scoped exactly as [../rate-limits.md](../rate-limits.md)
  describes. Phase 2 froze the *exemption* lists with tests; it did not change any ceiling. The
  store fails open by design — a Redis outage does not turn into a 500 on every request.
- **Live tracking.** There is no public tracking surface, and Phase 3's tracking work reaches no
  logged-out screen. A shop customer's order-tracking view is a signed-in surface — see the
  [customer changelog](../customer/FRONTEND-CHANGELOG-phase-2-3.md) § 1, which contains a
  correctness fix you must apply.
- **The six deliberate deviations and the stock semantics** recorded in
  [FRONTEND-CHANGELOG-shop.md](./FRONTEND-CHANGELOG-shop.md) still stand as written.
