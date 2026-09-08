# Vendor dashboard — what Phase 4 and Phase 5 changed

**Verified against source on 2026-09-08** — R7 re-checked the seven ranked changes: the 90-day absolute session cap (`core/auth/token.issuer.ts:27-49`), the nullable `FileDetail.url` plus `access` (`catalog/read-models/file-detail.resolver.ts:67-88`), magic-byte sniffing and ClamAV on every upload (`core/uploads/processors/file-sniffing.processor.ts:10`, `scanners/clamav-scanner.ts:56`, `upload-config.ts:231`) and the 5 MB policy-document cap (`modules/vendor/controller/vendor-profile.controller.ts:23,159`). No defects found.

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md)
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 A session is now capped at **90 days absolutely** — new terminal 401 | **Required** — one branch, and a login route |
| 2 | 🔴 `FileDetail.url` is `string \| null`; new `access` field | **Required** — compiler-guided, and for you it is only digital products |
| 3 | Every upload you make is now **virus-scanned and magic-byte sniffed** | Design — two new refusal paths to render |
| 4 | Policy-document uploads got real rules (PDF-only by *bytes*, 2 × 5 MB, quota) | Small |
| 5 | Digital products: the raw storage URL is **gone**; the token is the only door | None — you were already using the token |
| 6 | Tickets: the administrator snapshot shape is now documented, and it had changed | Small — read `assigned_admin` / `created_by_admin` |
| 7 | Tickets: staff notes filed by administrators used to leak to you | None — but it explains seed data |

**Nothing you call was renamed, removed or re-shaped.** Products, variants, inventory, orders,
shipping, billing, earnings, transactions, the storefront read side, the rich-description
formatter contract and every payout surface answer exactly as their documents describe.

---

## 1 · 🔴 The 90-day absolute session cap

Full explanation in [the cross-role page § 2](../FRONTEND-CHANGELOG-phase-4-5.md#2---a-sign-in-is-now-bounded-at-90-days-whatever-it-does-in-between).
The dashboard-specific version:

Your dashboard is a **cookie** client, so it has always renewed silently inside an ordinary
request and a vendor who uses it weekly has, until now, never seen a login screen again. That
stops being true.

| | |
|---|---|
| **Code** | `AUTH_SESSION_CAP_REACHED` · **401** · category `authentication` |
| **Fires on** | **any authenticated request**, not just a refresh |
| **Window** | 90 days since the vendor last actually proved a credential |

```ts
// in your response interceptor, BEFORE the generic 401-refresh-retry branch
if (err.error?.code === 'AUTH_SESSION_CAP_REACHED') {
  clearSession();
  redirectToLogin({ notice: 'Your session expired — please sign in again.' });
  return;                       // never retry, never refresh: both fail identically
}
```

⚠ **The ordering matters.** Most dashboards have a "401 → refresh → replay" interceptor. If this
code reaches it, the refresh 401s with the same code and you loop. Branch on the code **first**.

**What resets the clock:** a real login, a registration, or a **password change**. Note the last
one — a password change re-issues with a fresh `auth_time`, which is what keeps "change your
password" a complete remedy after a compromise. `auth-me` on launch does **not** reset it any
more; that was the defect.

---

## 2 · 🔴 `FileDetail` gained `access`, and `url` can be `null`

**The document to read is [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md).**

```jsonc
{ "id": "…", "key": "…", "url": "https://…" | null,
  "access": "public" | "authorized",
  "mimeType": "…", "size": 0, "originalName": "…" }
```

**For the vendor dashboard the practical blast radius is small**, because almost everything you
render is in a public tree:

| Surface | `access` | Changed? |
|---|---|---|
| Product images and thumbnails, variant media | `public` | No — same URL |
| Store logo and banner | `public` | No |
| Your avatar | `public` | No |
| Videos, general documents | `public` | No |
| Policy documents (the PDFs you upload on your profile) | `public` | No |
| **Digital product assets** (`digital/`) | **`authorized`** | 🔴 **`url` is `null`** |
| Ticket attachments | `public` today | No — see § 7 |

**So: one surface.** If any screen builds a link from a digital asset's `url` — a "download your
own file" affordance on the product editor, a preview, an admin-ish audit view — it will now
receive `null`. There is no vendor-side byte route for a digital asset; the only door is the
buyer's `GET /api/digital/download/:token`.

Everywhere else, `url` is still a string and your `<img>` tags are fine. The `access` field is
new on **every** file, including public ones, so widen your type and branch:

```ts
if (file.access === 'public' && file.url) { /* render */ }
else { /* authorized — fetch through the owning entity's route, with credentials */ }
```

`url: string | null` is deliberately a *type* change so TypeScript produces your migration list.

---

## 3 · Every upload is now actually scanned, and the type check got real

Until Phase 4, the virus scanner on your upload paths was a **no-op** — including on digital
products, the tree whose bytes travel furthest. `UPLOAD_VIRUS_SCAN_PROVIDER` was parsed and read
by nothing. All five upload surfaces now run a real ClamAV scan.

Two new outcomes to render:

| Situation | Wire | What to show |
|---|---|---|
| The file is infected | **`400 UPLOAD_POLICY_VIOLATION`** — `VIRUS_DETECTED` in `details.violations[]` | "This file was rejected by a virus scan." Do not retry it. |
| The scanner could not be asked | **`502 UPLOAD_VIRUS_SCAN_UNAVAILABLE`** | "We could not check this file right now — please try again." **Retryable.** |

⚠ **The second is not a rejection of the file.** It refuses the upload because "could not scan"
must never be spelled "clean", but the file was never judged. Presenting it as "your file was
rejected" tells the vendor something untrue about their own document. Its category is
`external_service`, so the message is replaced with the registry default and `details` are
dropped in every environment — you will not get diagnostics on the wire, and should not try.

**Also now enforced where it was not:** magic-byte sniffing. The `Content-Type` your browser
sends is no longer trusted anywhere. A `.png` that is really something else is refused with a
policy violation, on paths that previously accepted it.

---

## 4 · Policy documents: same request, same response, real rules

`POST /api/vendor/profile/policy-documents` used to call the storage provider **directly** — no
scan, no sniffing, no fingerprint, no quota. The only gate was the `Content-Type` your client
declared, which means anything at all named `.pdf` was stored and handed back as a public URL you
then republish to your delivery agencies and customers.

It now runs the real pipeline. **The response is still `{ urls: string[] }` — no client moves.**

| Rule | Value |
|---|---|
| Files per request | 2 |
| Per-file size | 5 MB (10 MB total) |
| Type | **PDF only, checked against the sniffed bytes** |
| Quota | Counts against **your plan's media cap** |
| Virus scan | Yes |

Two consequences for the profile screen:

- **A vendor near their storage cap can now be refused here**, where they never could be before.
  Surface the quota violation the same way your product-media upload does.
- **A renamed non-PDF is now refused.** Previously it was stored and the agency downloading it
  got a broken file.

The URLs these return are still **public by design** — the endpoint's whole contract is handing
you a URL you republish into `policies.documents`.

**One backend cost, stated so it does not surprise you later:** a document you upload and never
submit back into your policies is now **retained** rather than reclaimed by the abandoned-upload
sweep. Nothing to do; it just means the storage number can drift up from abandoned attempts.

---

## 5 · Digital products — the raw URL is gone, and that is what makes the token real

The `digital/` storage tree left the public static mount. Before Phase 4, a buyer who had ever
seen the raw storage path could re-share it indefinitely: the download token's **single-use
consumption**, its **download counter** and its **revocation** were all bypassed by that path,
permanently, and nothing recorded that it happened.

**`GET /api/digital/download/:token` is unchanged and is now the only door.** Nothing in your
dashboard moves for this — except that the three enforcement mechanisms your product settings
expose finally mean what they say.

**Entitlement revocation is unchanged on the wire.**
`POST /api/vendor/entitlements/:id/revoke` still answers `404 DIGITAL_ENTITLEMENT_NOT_FOUND` for
an unknown id and `422 DIGITAL_ENTITLEMENT_ALREADY_REVOKED` for one already revoked, and still
appends an `entitlement.revoked` timeline entry carrying your reason. Phase 4 brought a second,
route-less internal method into line with yours; your door was already correct.

---

## 6 · Tickets: the administrator snapshot is documented now, and it had quietly changed

`assigned_admin` and `created_by_admin` on your ticket reads carry an **administrator snapshot**.
It used to be `{ user_id, role, name, avatar }` and has been `{ name, job_title, department,
avatar_url }` for some time — the doc simply never said so, and nothing broke, because the field
is `null` on almost every ticket. That is exactly how a documented shape goes stale unnoticed.

```json
{ "name": "Kofi Mensah", "job_title": "Support lead", "department": "Customer Care", "avatar_url": null }
```

Now written up in [tickets.md § Administrator snapshot](./tickets.md). The four things worth
knowing:

- **`assigned_admin` is `null` until a wi-admin administrator takes the ticket**, and most
  tickets never are. `null` is the normal state, not missing data.
- **`created_by_admin`** carries the identical shape and had been documented **nowhere**. It is
  non-null only when an administrator opened the ticket *for* you.
- **`avatar_url` is reserved and permanently `null`.** Administrators have no picture — there is
  no upload surface for one and wi-admin has no write-side file surface at all. **Render the
  initials from `name` and do not branch on this field.** It is carried so that the day an avatar
  exists, nothing about this shape changes.
- **There is deliberately no `tier` and no `id`.** `assigned_admin_id` sitting beside the block is
  an id in the administration service and **resolves to nothing** in this one — treat it as
  opaque, or ignore it and read the block.

---

## 7 · Ticket notes — why seeded tickets may show staff shorthand

Notes carry `visibility: PUBLIC | PRIVATE`, and you are shown the public ones plus the private
ones addressed to you. Until 2026-08-20 wi-admin sent the wrong field name for that switch —
`isPublic`, where this service reads `visibility` — and because the receiving schema is not
`strict()`, the key was **dropped** and the default (`PUBLIC`) applied. **Every note wi-admin ever
created was filed public.**

Fixed at the boundary. The historical rows were **not** backfilled (this platform is
pre-production and deliberately writes no data migrations), so a ticket in the dev database may
carry a note that was meant to be internal. Nothing to build; it explains what you may be seeing.

---

## 8 · What did NOT change

- **The rich-description contract.** `test:rich-description` still asserts your `tools/richtext/`
  fixture strings byte-for-byte on the WhatsApp and Telegram formatters. Unchanged, and it is
  still the case that **a change on your side is caught by nothing** — keep the manual step.
- **`ENABLED_PAYOUT_METHODS` is still `['mobile_money']`.** Phase 4 fixed a test that asserted
  against the switch, not the switch. Bank and card payout entries are still refused on `method`.
- **Every public file URL.** Product imagery, store logo and banner, avatars, videos, general
  documents — byte-identical. This was a routing change, not a migration; nothing moved on disk.
- **Bargainable pricing, simple/advanced product mode, the activation gate.** Untouched. (A dead
  `VariantPricingService` that would have written `price` without syncing the `bargain` minimum
  was deleted — it had no route and no importer.)
- **Checkout.** A `CartService.validateCheckout` with zero call sites was deleted; the live path
  (`cart-quote.service.ts`) is unchanged.

---

## 9 · Where to look

| Topic | Document |
|---|---|
| The cross-role summary | [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md) |
| 🔴 Private files and `access` | [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) |
| Sessions and tokens | [../auth/README.md](../auth/README.md) |
| Uploads | [../uploads/README.md](../uploads/README.md) · [file-management.md](./file-management.md) · [storage.md](./storage.md) |
| Digital products | [digital-products.md](./digital-products.md) |
| Tickets (the shared payload reference for every role) | [tickets.md](./tickets.md) |
| Error catalog | [../errors/README.md](../errors/README.md) |
