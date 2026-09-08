# Vendor dashboard — what Phase 2 and Phase 3 changed

**Verified against source on 2026-09-08** — R7 re-checked the two load-bearing claims: a vendor resolves to **no** tracking visibility (`modules/tracking-integration/services/visible-agents.service.ts:17,109`), and the chat-formatter fixtures really are vendored from the dashboard — `scripts/test/test-rich-description.ts:6-9` names `frontend/vendor-dash/tools/richtext/fixtures.ts` as their origin, so the asymmetry § 1 describes is real. Suite green (148/148). No defects found.

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)

---

## Short version

**No vendor endpoint changed.** Not one path, field, status code or error shape. Phase 2 was
deployability work and Phase 3 was the tracking seam — and a vendor is the one role with **no**
live-tracking surface at all (`visible-agents` resolves `vendor → none`, deliberately and
unchanged).

What you do have is **one standing obligation you own and nothing enforces** (§ 1), three
library upgrades under paths your screens exercise (§ 2), and a handful of behaviour changes
around restarts and data (§ 3–5).

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 The **chat-formatter fixture contract** is yours to keep in sync — nothing catches drift | **Standing process** |
| 2 | `sharp`, `nodemailer`, `firebase-admin` upgraded | **Re-test** uploads, emails, push |
| 3 | Templated emails were broken in built environments — **fixed** | Retry anything you wrote off |
| 4 | `last_ordered_at` backfilled; catalog indexes applied | None |
| 5 | Restart/keep-alive behaviour, probes, token rotation | Small |

---

## 1 · 🔴 The chat-formatter contract is byte-for-byte, cross-repository, and asymmetric

**This is the one item on this page that needs a process, not a code change.**

jovi-mall renders a product's `descriptionRich` into WhatsApp and Telegram message text. Its
suite `test:rich-description` asserts that output **byte-for-byte** against fixtures that were
**copied verbatim out of this dashboard's `tools/richtext/fixtures.ts`**.

The vendored copy is what makes the two agree. It is also what makes the contract **asymmetric
in the dangerous direction**:

| Change on… | Caught by |
|---|---|
| the **backend** side | `test:rich-description`, in CI |
| the **dashboard** side | **nothing** |

If `tools/richtext/` changes and the vendored fixtures do not, the suite stays green, the copy
goes quietly stale, and the drift surfaces as a vendor reporting that WhatsApp *"put stars
everywhere"* — arbitrarily far from the commit that caused it.

**The manual step, and it is yours:**

> When this dashboard's `tools/richtext/fixtures.ts` changes, re-copy the expected strings into
> jovi-mall's `scripts/test/test-rich-description.ts` and re-run it **in the same release**.

It is now row 5 of the two-repo release checklist in
[`docs/RUNBOOK.md`](../../../docs/RUNBOOK.md#two-repo-release-checklist), alongside the
tracking contracts — read that table before shipping a rich-text change.

**Why this is being raised now.** Phase 3 audited contract enforcement across the workspace and
found that **neither CI workflow had ever executed a single assertion** — one died on a secret
that was never created, the other on a heap OOM, both silently, on every run since they were
written. Both are fixed and both have now been watched going green. In the course of that, the
release checklist was found to claim this contract was on it when it was not. It is now.

Related and unchanged: [product-description-rich.md](./product-description-rich.md) and
[../FRONTEND-CHANGELOG-rich-descriptions.md](../FRONTEND-CHANGELOG-rich-descriptions.md).

---

## 2 · Three libraries moved under paths your screens exercise

The dependency backlog went from **49 vulnerabilities / 4 critical** to **6 moderate / 0 high /
0 critical**, and the CI gate is now hard. No API changed — but three of the upgrades sit
directly under vendor workflows and deserve a pass.

| Package | Move | What to re-test |
|---|---|---|
| `sharp` | 0.34 → **0.35.3** | **Every image path**: product image upload and its resize/derivative generation, store logo and banner, avatars. This upgrade also changes the platform-specific `@img/*` binaries, so it is a genuine runtime change, not a version bump. See [product-upload-flow.md](./product-upload-flow.md) and [file-management.md](./file-management.md). |
| `nodemailer` | 7 → **9.0.5** | Anything that ends in an email — order notifications, invitations, verification. One file, three methods, all API-unchanged. |
| `firebase-admin` | 13 → **14.2.0** | Push notifications. v14 **removed the legacy namespaced API outright** and the backend moved to modular imports. ⚠ **An actual FCM send is unverified** — it needs credentials and a device. Test end to end before relying on it. See [notification-channels.md](./notification-channels.md). |

---

## 3 · Templated emails were broken in every built environment — now fixed

Worth calling out because it may explain a bug you stopped reporting.

`tsc` emits no `.hbs` files, so the compiled `dist/` shipped **without any mail template**. Every
templated email was therefore broken under `npm start` — that is, in any deployed or
container-built environment. It worked under `npm run dev` only, which is exactly why it survived.

Found while building the container image in Phase 2. The build now copies non-TS runtime assets
from a manifest, and a test enforces the manifest.

**If a vendor-facing email flow was written off as unreliable, retry it.**

---

## 4 · Data and indexes

Phase 2 built a migration ledger (`schema_migrations`, with `migrate:status` / `migrate:up`) and
applied the **entire 15-migration backlog** to the dev database. Three rows touch your screens:

| Migration | Effect |
|---|---|
| `backfill:last-ordered` | `last_ordered_at` populated on **15** products and **11** variants. Any sort or badge keyed on it now has data on legacy rows. |
| `migrate:storefront-indexes` | Public catalog queries are indexed rather than scanning `products`. **Performance only** — no shape change, but if you had been avoiding a filter because it felt slow, re-measure. |
| `migrate:billing-owner-scope` | Already applied here; no-op. Plans and credit read by `owner_type` as [billing.md](./billing.md) describes. |

Also: **`autoIndex` is now off in production** (it stays on in development). Index creation is an
explicit, ledgered migration step rather than something Mongoose does at boot, because a failed
index build at boot fails **silently** — the production failure mode where everything works and
everything is slow, with no error anywhere.

⚠ These ran against the **dev** database. There is no production database yet and the ledger is
forward-looking, so **keep your defensive handling of legacy/missing fields.**

---

## 5 · Restarts, probes, and tokens

- **Deploys no longer truncate requests.** jovi-mall had *no* shutdown handling; it now drains.
  An accepted request completes (budget `SHUTDOWN_TIMEOUT_MS`, default **10 s**), then the
  listener closes. A long product-image upload is the realistic case that can still be cut.
- **Idle keep-alive sockets close after 65 s.** A browser handles this; a server-side proxy or
  BFF in front of your dashboard should keep its idle timeout below 65 s or retry idempotent
  GETs once on a connection-level error.
- **Probes:** `GET /api/health` is **frozen** — exact path, body `{status, timestamp}`,
  unconditional 200, **no `{success, data}` envelope**, exempt from rate limiting and
  maintenance. It is a reachability check, not a readiness check, and will answer 200 with the
  database down. Use `GET /api/health/ready` for readiness. See [../health.md](../health.md).
- **`JWT_SECRET` rotation** invalidates every live access token at once: every call 401s until
  re-authentication. Treat a mid-session 401 as normal and refresh; do not treat it as fatal.
- **Rate limits are unchanged** — see [../rate-limits.md](../rate-limits.md).

---

## 6 · What explicitly did not change for you

- **Vendors have no live-tracking surface.** The tracking authorization policy resolves
  `vendor → none`, and Phase 3's whole tracking-seam rework — the revocation reason codes, the
  ETA resolution, the drop-off pull — reaches no vendor screen. If a vendor needs delivery
  visibility, that is a product question, not a gap left by these phases.
- **The response envelope, the error taxonomy and every vendor endpoint.** Unchanged.
- **Bargainable pricing, private files, agency storage, rich descriptions.** Their existing
  changelogs in [`../`](../) still describe current behaviour.
