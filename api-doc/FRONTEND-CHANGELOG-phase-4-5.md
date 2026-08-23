# Frontend changelog — Phase 4 (Per-service hardening) and Phase 5 (Legacy close-out)

What [`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md)
Phases **4** and **5** changed, written for the people who build against the API.

- **Written:** 2026-08-21
- **Phase 4 landed:** 2026-08-19 → 2026-08-20 · design record
  [`PHASE-4-HARDENING-PLAN.md`](../../PRODUCTION-READINESS/PHASE-4-HARDENING-PLAN.md)
- **Phase 5 landed:** 2026-08-20 · design record
  [`PHASE-5-LEGACY-CLOSEOUT-PLAN.md`](../../PRODUCTION-READINESS/PHASE-5-LEGACY-CLOSEOUT-PLAN.md)
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

> **This page is the cross-role half.** Everything here applies to every client of this
> backend. The parts that land on one screen live in that role's folder — see the index below.

---

## The one-paragraph version

**Phase 4 is the first instalment in this series that breaks clients on purpose, and it does it
twice.** A stored file in a private tree no longer has a public URL — `FileDetail.url` becomes
`string | null` and gains an `access` discriminator — so anything rendering a delivery-proof
photo from a raw URL renders nothing until it moves to the new authorized route. And a sign-in
is now bounded absolutely at **90 days** regardless of how often it refreshes, announced by a
new error code your client must route to login rather than retry. Alongside those, every upload
surface is now virus-scanned for real (three of five were no-ops and two bypassed the pipeline
entirely), and geo-tracker's session TTL moved 48 h → 72 h.

**Phase 5 deleted jovi-mall's entire public admin surface.** There is no `/api/admin/*` in this
service any more — eleven mounts, thirteen live `requireRole(['admin'])` guard sites and two
api-doc files are gone, and a pre-cutover refresh token carrying `role: 'admin'` is now refused
**403** instead of minting an admin session. The blog editor **moved** to wi-admin; the public
blog read is untouched. If you are not building the admin dashboard, Phase 5 costs you nothing
but a link update — and one thing worth knowing about support-ticket notes (§ 5).

---

## Which document you read

| You build | Read | Then also |
|---|---|---|
| **Vendor dashboard** | [vendor/FRONTEND-CHANGELOG-phase-4-5.md](./vendor/FRONTEND-CHANGELOG-phase-4-5.md) | this page |
| **Agency dashboard** | [agency/FRONTEND-CHANGELOG-phase-4-5.md](./agency/FRONTEND-CHANGELOG-phase-4-5.md) | 🔴 [FRONTEND-CHANGELOG-private-files.md](./FRONTEND-CHANGELOG-private-files.md) — proof photos |
| **Agency / agent mobile app** | [agent/FRONTEND-CHANGELOG-phase-4-5.md](./agent/FRONTEND-CHANGELOG-phase-4-5.md) | 🔴 [private-files](./FRONTEND-CHANGELOG-private-files.md) · [geo-tracker](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md) |
| **Customer app** | [customer/FRONTEND-CHANGELOG-phase-4-5.md](./customer/FRONTEND-CHANGELOG-phase-4-5.md) | this page |
| **Marketing landing + shop** | [public/FRONTEND-CHANGELOG-phase-4-5.md](./public/FRONTEND-CHANGELOG-phase-4-5.md) | this page |
| **Admin dashboard** (wi-admin, `/api/v1/*`) | [`admin/docs/FRONTEND-CHANGELOG-phase-4-5.md`](../../admin/docs/FRONTEND-CHANGELOG-phase-4-5.md) | this page — **§ 6 deletes your old endpoints** |
| **Any live-tracking client** | [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md) | — |

---

## The change list, ranked by what it costs you

| # | Change | Breaking? | Who |
|---|---|---|---|
| 1 | `FileDetail.url` is `string \| null`; new `access` field | 🔴 **Yes — type change** | Everyone rendering a file |
| 2 | 90-day absolute session cap · `AUTH_SESSION_CAP_REACHED` | 🔴 **Yes — new terminal 401** | Everyone with a session |
| 3 | Uploads are virus-scanned on every surface | Refusals are new | Everyone who uploads |
| 4 | `/api/admin/*` is **gone** | 🔴 Yes, for anything still calling it | Legacy admin dashboard |
| 5 | Policy-document uploads go through the real pipeline | Same `{ urls }` | Vendor · Agency |
| 6 | Support-ticket notes: a stored-data consequence, not a wire change | No | Everyone with tickets |
| 7 | geo-tracker session TTL 48 h → 72 h, trail is plausibility-gated | No | Tracking clients |

**No endpoint in this service was renamed or re-shaped by either phase**, other than the
deletions in § 6. The response envelope, the nine-value error taxonomy and every
`{success, data}` / `{success, requestId, error}` shape are exactly as
[README.md](./README.md) documents them.

---

## 1 · 🔴 `FileDetail` — `url` is nullable now, and there is a new `access` field

**This has its own document and it is the one to read:**
[FRONTEND-CHANGELOG-private-files.md](./FRONTEND-CHANGELOG-private-files.md). The summary:

```diff
  {
    "id": "66b1…",
    "key": "shipments/2026/08/9f2c…_proof.jpg",
-   "url": "https://api.example.com/api/files/shipments/2026/08/9f2c…_proof.jpg",
+   "url": null,
+   "access": "authorized",
    "mimeType": "image/jpeg", "size": 284119, "originalName": "proof.jpg"
  }
```

| Field | Type | Meaning |
|---|---|---|
| `url` | `string \| null` | Fetchable directly when a string. **`null` means there is no public URL.** |
| `access` | `"public" \| "authorized"` | Which of the two this is. **Always present**, on every file. |

**Which trees went private:** `digital/` (a vendor's digital product) and `shipments/`
(delivery-proof photos), plus the legacy `ticket-attachments/` directory that holds exactly one
pre-existing file. **Everything else is unchanged and keeps its exact URL** — product imagery,
avatars, store and agency logos and banners, videos, general documents, and both
policy-document trees.

The mount is now an **allowlist derived from one classification table**, so a storage tree added
next year is private until somebody says otherwise. That is the opposite of the old default and
it is why this is worth knowing rather than just absorbing.

⚠ **A ticket attachment uploaded today is still public.** It is an ordinary
`POST /api/files/upload` that lands in `documents/` or `images/` and is attached to the ticket
by id afterwards, so it shares a tree with public product imagery. Making those private needs a
dedicated upload path that **does not exist yet** — do not read the private-files change as
having closed that gap.

**What to do:** let the compiler find your call sites. `url: string | null` is deliberately a
*type* change rather than a silently-different string, because an authorized path looks exactly
like a public URL and a client keeps `<img src={url}>` and renders nothing for anyone not
signed in. Branch on `access`.

---

## 2 · 🔴 A sign-in is now bounded at 90 days, whatever it does in between

**Design record:** [`jovi-mall/docs/ADR-A03-SESSION-CAP.md`](../docs/ADR-A03-SESSION-CAP.md) ·
**Contract:** [auth/README.md](./auth/README.md)

Before Phase 4, the 30-day refresh window slid forever. Every client calls `auth-me` on launch
and was re-issued **both** tokens at full lifetime, so a session that was used at all never
lapsed — including a stolen one. The only remedies were a password change or a suspension, and
both require somebody to know.

**Now:** every token carries an `auth_time` claim recording when the person last *proved*
something. It is copied **byte-identical** through every re-issue, and once
`now − auth_time > 90 days` the session is refused.

| | |
|---|---|
| **Code** | `AUTH_SESSION_CAP_REACHED` |
| **Status** | `401` · category `authentication` |
| **Default message** | *"It's been a while — please sign in again"* |
| **Window** | `AUTH_ABSOLUTE_SESSION_CAP`, default **7 776 000 s = 90 days** |

**Where it fires — and this is the part that surprises people.** It is enforced in **two**
places, not one:

- `POST /api/auth/mobile/refresh` (and the cookie rotation) — the eviction.
- **`requireAuth`, on every authenticated request.** Gating only the refresh would leave a
  capped session working for a further 15 minutes — and, worse, `auth-me` and `add-role` both
  mint a fresh pair from a valid access token, so a client polling `auth-me` every fourteen
  minutes would never reach the rotation at all and the window would slide exactly as before.

So the refusal can arrive on **any** call, not just a refresh.

**What your client must do:**

```ts
if (err.error.code === 'AUTH_SESSION_CAP_REACHED') {
  clearTokens();
  routeToLogin();            // do NOT retry, do NOT refresh — both will fail identically
}
```

⚠ **Distinguish it from its two neighbours.** `AUTH_SESSION_EXPIRED` is routine and refreshable;
`AUTH_PASSWORD_CHANGED` means something may be wrong. `AUTH_SESSION_CAP_REACHED` is neither —
it is normal, it is expected, and it is terminal for that session. A client that treats it as
transient will loop forever.

**Which sign-ins reset the clock.** `auth_time` is stamped fresh only where a credential was
actually proved: **login**, **registration**, the messaging bot's single-use login code, and the
**password-change re-issue**. It is *copied* through `rotateRefreshToken`, `auth-me` and
`add-role` — those prove a token, not a person.

**Nobody is signed out on deploy day.** A token minted before this feature has no `auth_time`
and is dated from its own `iat` instead, so a legacy session is capped from at most 30 days ago
and gains a real `auth_time` on its first re-issue.

**Design implication for native/bearer clients.** A user who never signs out will now be sent to
the login screen roughly every three months. That is the trade ADR-A03 makes explicitly: a
bearer client has no silent renewal the way a cookie client does, so the cap is visible. Make
that path pleasant rather than treating it as an error state.

---

## 3 · Uploads are actually scanned now — on every surface

**Design record:** [`jovi-mall/docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`](../docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md)

Before Phase 4 the virus scanner was a no-op at **three** injection sites (general uploads,
delivery proof, and — the one that matters most — digital products), and **two** more surfaces
(vendor and agency policy documents) bypassed the upload pipeline altogether. The configuration
parsed `UPLOAD_VIRUS_SCAN_PROVIDER` and nothing read it.

All five now run a real ClamAV scan, and the service **refuses to boot** on a configuration that
names a scanner it cannot build. Two client-visible outcomes:

| Outcome | Wire |
|---|---|
| The file is infected | **`400 UPLOAD_POLICY_VIOLATION`**, with a `VIRUS_DETECTED` entry in `details.violations[]` |
| The scanner could not be asked (down, timed out, unintelligible reply) | **`502 UPLOAD_VIRUS_SCAN_UNAVAILABLE`** |

```jsonc
// the infected case — the same envelope every other upload-policy refusal uses
{ "success": false, "requestId": "…",
  "error": { "code": "UPLOAD_POLICY_VIOLATION", "statusCode": 400, "category": "validation",
             "message": "Upload policy violations found",
             "details": { "violations": [ { "code": "VIRUS_DETECTED", "message": "…", "fileIndex": 0 } ] } } }
```

**Read `details.violations[].code`, not the message.** `VIRUS_DETECTED` sits beside the existing
violation codes (`QUOTA_EXCEEDED`, type and size refusals) in the same array, so if you already
render that list you get this one for free — you only need copy for the new code.

⚠ **"Could not scan" is never spelled "clean".** The second row **refuses the upload**. It is a
dependency failure, so it is retryable — but do not silently swallow it, and do not present it
as "your file was rejected", because the file was never judged. Its category is
`external_service`, which means the boundary replaces the message with the registry default and
drops `details` in **every** environment — so do not expect diagnostics on the wire.

**Also new on the surfaces that previously skipped it:** magic-byte sniffing (the declared
`Content-Type` is no longer trusted), fingerprinting, and the owner's plan-driven storage quota.
A file whose real type does not match its extension is now refused where it used to be stored.

---

## 4 · Policy-document uploads changed underneath, and the wire did not

`POST /api/vendor/profile/policy-documents` and `POST /api/agency/profile/policy-documents` used
to call the storage provider directly: no scan, no sniffing, no fingerprint, no quota — the only
gate was the **client-claimed** `Content-Type`. Anything at all, named `.pdf` and declared
`application/pdf`, was stored and handed back as a public URL the owner then republishes to
their counterparties.

Both now go through the real pipeline. **The response is still `{ urls: string[] }` and no client
moves.** What changed is what gets refused:

| Rule | Value |
|---|---|
| Files per request | **2** |
| Per-file size | **5 MB** (10 MB total) |
| Type | **PDF only, checked against the sniffed bytes**, not the declared type |
| Quota | Counts against the owner's plan-driven media cap |
| Virus scan | Yes — see § 3 |

Both trees stay **public by design**: the endpoint's whole contract is handing back a URL the
owner republishes.

**A cost stated rather than discovered:** a policy document uploaded and never submitted back
into `policies.documents` is now **retained** rather than reclaimed. That is a storage leak in
the safe direction — the alternative would have let the abandoned-upload sweep permanently
delete every owner's policy PDFs a grace period after upload.

---

## 5 · Support-ticket notes — a stored-data consequence worth knowing

Not a wire change, and not this service's bug — but it shows on your screen.

Ticket notes carry `visibility: PUBLIC | PRIVATE`, and a non-admin viewer is shown all `PUBLIC`
notes plus the private ones addressed to them. **wi-admin sent the wrong field name for that
switch until 2026-08-20**: it sent `isPublic`, jovi-mall reads `visibility`, and jovi-mall's
receiving schema is not `strict()` — so the key was dropped, the schema default (`PUBLIC`)
applied, and **every note wi-admin ever created was filed public**. Staff commentary on somebody's
support case, shown to them, `201`, no warning.

Fixed at the boundary, and the note length cap wi-admin accepts was corrected to jovi-mall's real
**300** characters (it accepted 2 000 and let the far side refuse). **The historical rows were not
backfilled** — this platform is pre-production and deliberately writes no data migrations — so a
ticket in the dev database may still carry a note that was meant to be internal. If you are
testing against seeded ticket data and see a note that reads like staff shorthand, that is why.

---

## 6 · 🔴 There is no public `/api/admin/*` in this service any more

Phase 5 completed the admin cutover. Verified against a running server: **every one of the twelve
deleted public paths answers 404**, and `requireRole(['admin'])` has **zero live guard sites**
(the 25 textual occurrences that remain are all comments).

| Gone | Where the operation lives now |
|---|---|
| `/api/admin/profile` | wi-admin `GET`/`PATCH /api/v1/administrators/me` |
| `/api/admin/plans`, `/api/admin/earnings/*`, `/api/admin/payout-requests` | wi-admin `/api/v1/{billing,money,accounts}/*` |
| `/api/admin/orders/*`, `/api/admin/cod/*` | wi-admin `/api/v1/{orders,cod}/*` |
| `/api/admin/agents/*`, `/api/admin/delivery-agencies/*` | wi-admin `/api/v1/{agents,agencies}/*` |
| `/api/admin/articles`, `/api/admin/article-authors` | wi-admin `/api/v1/content/*` — **ownership moved**, see § 7 |
| `/api/admin/tickets/*` | wi-admin `/api/v1/support/*` |
| `/api/admin/products/bulk-vectorise` | wi-admin `/api/v1/dev-tools/catalogue/vectorise` |
| `POST /api/webhooks/telegram/send` | wi-admin `POST /api/v1/messaging/telegram` |

**The internal door survives and is unchanged.** `/api/internal/admin/*` still serves its fifteen
route groups — it is service-token-only, wi-admin is its only caller, and it is not a frontend
surface. `api-doc/admin/*` therefore still exists (15 files, down from 17) and now documents
**that** prefix; two genuinely dead pages were deleted and eight were repointed with a banner
naming what moved and where a dashboard should go instead.

**One security consequence for any client holding an old token.** `rotateRefreshToken` used to
copy the role straight out of the presented token with no filter, so a refresh token minted
before the cutover kept producing `role: 'admin'` access tokens for the rest of its 30-day life —
and that token satisfied every admin guard. It is now refused **`403 AUTH_ROLE_NOT_FOUND`**. Only
the four authenticatable roles — `customer`, `vendor`, `agency`, `agent` — can be refreshed into.
A dev fixture holding `roles: ['admin']` was migrated, and `db.users.countDocuments({roles:'admin'})`
is **0**.

---

## 7 · The blog editor moved; the public blog read did not

Ownership of `articles` and `article_authors` **writes** moved to wi-admin
([`admin/docs/api/content.md`](../../admin/docs/api/content.md), 14 routes at `/api/v1/content`).
jovi-mall keeps the Mongoose schema, the indexes — including the unique multikey index on
`slug_keys` that exists only because Mongo refuses a compound index on two parallel array paths
— and the whole public read half.

**`GET /api/public/articles*` is byte-identical.** Same paths, same DTOs, same
`BLOG_ARTICLE_MOVED` redirect on a renamed slug, same hreflang behaviour. See
[public/FRONTEND-CHANGELOG-phase-4-5.md](./public/FRONTEND-CHANGELOG-phase-4-5.md) for the one
thing that *does* move for the marketing site: **the authority for the nine-type block union is
now wi-admin's validator**, not this service's.

`jovi-mall/api-doc/admin/articles.md` was deleted. The editor contract is
[`admin/docs/api/content.md`](../../admin/docs/api/content.md).

---

## 8 · Live tracking — the short version

Full detail in
[`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md).
**No frame, no field and no error code changed.** Three behavioural facts:

1. **`TRACKING_SESSION_TTL` is 72 h**, up from 48 h. It bounds how long a session survives a lost
   terminal event; it must exceed the longest plausible delivery, and 72 h was measured against
   an inter-city delivery plus one failed-then-retried attempt.
2. **The durable GPS trail is now plausibility-gated.** An implausible fix (faster than 75 m/s
   from the last known position) already never reached the live position or a broadcast; it now
   also does not land in the trail. Expect occasional gaps in a trail a spoofed or noisy stream
   produced. The session still **heartbeats** on such a fix — deliberately, so bad GPS cannot
   starve a real delivery into `gps_lost`.
3. **Grant latency is unchanged and is not a bug.** Revocation is pushed; a newly-authorised
   viewer waits out `PERMISSION_CACHE_TTL` and is *not* refreshed by a reconnect.

Phase 5 modified **zero** geo-tracker files.

---

## 9 · What did NOT change, and should not be "fixed"

- **The forwarded-token refresh asymmetry** (register question Q-3). Still deliberate. Reconnect
  with a fresh token on a cadence shorter than the 15-minute access TTL.
- **`GET /api/health`'s frozen shape.** Exact path, exact body, unconditional 200, exempt from
  rate limiting and from maintenance mode. geo-tracker's readiness depends on it.
- **`ENABLED_PAYOUT_METHODS` is still `['mobile_money']`.** Phase 4 fixed the *test* that asserted
  against it, not the switch. Bank and card payout entries are still refused on `method`.
- **The `'admin'` role value survives inside jovi-mall.** `requireAdminCaller` synthesises it for
  every wi-admin call and about twenty downstream sites read it. What was retired is a *platform
  user session* carrying it.
- **`admin_action_log` survives**, and so does the `/api/internal/admin` path that writes to it.
- **wi-admin still has no data door into geo-tracker.** No live position, no trail, no ETA for an
  administrator. Phases 4 and 5 did not change this.
- **`GET /api/digital/download/:token` is unchanged.** What changed is that it is now the *only*
  door, which is what makes its single-use consumption, its counter and its revocation mean
  something.

---

## 10 · One honest caveat about how all of this was verified

Every suite result quoted in the Phase 4 and Phase 5 records was produced **by hand on a
developer machine**. Both live-suite CI jobs are authored, YAML-validated, and have **never
run** — no branch in any of the three repositories has been pushed. Phase 5 added a third
(`verify:content`) to the same unproven pipeline.

That does not make the results wrong; twenty-one of twenty-two live suites are green and the four
that moved each fixed a real defect (including one — approval requests staying decidable past
their `expires_at` — that was a live product bug). It does mean **there is no automated gate
standing between a regression and you**. Test your own integration.

---

## 11 · Where the authoritative detail lives

| Topic | Document |
|---|---|
| Private files, `access`, the proof-photo route | [FRONTEND-CHANGELOG-private-files.md](./FRONTEND-CHANGELOG-private-files.md) |
| The upload/download map | [`docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`](../docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md) |
| The session cap and its reasoning | [`docs/ADR-A03-SESSION-CAP.md`](../docs/ADR-A03-SESSION-CAP.md) · [auth/README.md](./auth/README.md) |
| Mobile / bearer auth | [auth/FRONTEND-CHANGELOG-mobile-auth.md](./auth/FRONTEND-CHANGELOG-mobile-auth.md) · [mobile-auth-backend-spec.md](./mobile-auth-backend-spec.md) |
| Uploads (role-neutral) | [uploads/README.md](./uploads/README.md) |
| Error catalog | [errors/README.md](./errors/README.md) |
| The surviving internal admin door | [admin/internal-service-api.md](./admin/internal-service-api.md) |
| The blog editor's new home | [`admin/docs/api/content.md`](../../admin/docs/api/content.md) |
| The tracking session TTL | [`geo-tracker/docs/ADR-B01-SESSION-TTL.md`](../../geo-tracker/docs/ADR-B01-SESSION-TTL.md) |
| Phase 5 decisions | [`admin/docs/ADR-017-PHASE-17-CLOSEOUT.md`](../../admin/docs/ADR-017-PHASE-17-CLOSEOUT.md) |
