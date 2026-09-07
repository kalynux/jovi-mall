# Agency dashboard — what Phase 4 and Phase 5 changed

**Verified against source on 2026-09-08** — every route claim on this page against the mount it is written under — in particular that the agency serves only `GET /shipments/:id/delivery-proof/file` (`agency.routes.ts:128`) and not the metadata read (`agent.routes.ts:139`) — plus the 10 MB / one-image proof limits, against `jovi-mall/src/modules/delivery/` and `src/core/uploads/upload-config.ts`.

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md)
- 🔴 **Then this, before your next release:** [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md)
- **Also:** [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md)
  — the live map
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 **Delivery-proof photos have no public URL any more** | **Required** — a new route, and a fetch-with-credentials for the image |
| 2 | 🔴 A session is capped at **90 days absolutely** — new terminal 401 | **Required** — one branch, and a login route |
| 3 | Every upload is **virus-scanned and magic-byte sniffed** | Design — two new refusal paths |
| 4 | Policy-document uploads got real rules (PDF-only by *bytes*, 2 × 5 MB, quota) | Small |
| 5 | Tickets: the administrator snapshot shape is now documented, and it had changed | Small |
| 6 | Live map: tracking session TTL 48 h → **72 h**, trail is plausibility-gated | None — behaviour only |
| 7 | Tickets: staff notes filed by administrators used to leak to you | None — explains seed data |

**Nothing you call was renamed, removed or re-shaped.** The agent roster and contracts, shipment
reads and dispatch, reassignment, COD cash management, earnings, billing, vendor connections,
products and the storage surfaces answer exactly as their documents describe.

---

## 1 · 🔴 Delivery-proof photos are no longer fetchable by URL

**This is the one that breaks a shipped screen.** Read
[../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) in full; this is
the agency-shaped summary.

### What happened

The whole `storage/` directory was served by one unguarded static mount, and a stored file's
`url` **was** that path. A delivery-proof photo is *a place and a time about a real customer's
address* — and anyone who had ever seen the URL could fetch it forever, with no session, and
nothing recorded that they had.

The `shipments/` tree left the static mount. Every `FileDetail` for a file in it now returns:

```diff
  {
    "id": "665f0c…",
    "key": "shipments/2026/08/9f2c…_proof.webp",
-   "url": "https://…/shipments/2026/08/9f2c…_proof.webp",
+   "url": null,
+   "access": "authorized",
    "mimeType": "image/webp", "size": 184320, "originalName": "proof.jpg"
  }
```

### Where it shows on your screens

- `deliveryProof` on `GET /api/agency/shipments/:id`

> 🔴 **Corrected 2026-09-06** (DOC-PROGRAM F-17 class 6). A second bullet here read
> *"`GET /api/agency/shipments/:id/delivery-proof` (the metadata read — **still useful**…)"*.
> **That route is not served on the agency side and never was.** `agency.routes.ts` registers
> exactly one delivery-proof route, `/shipments/:id/delivery-proof/file`; the metadata read is
> the **agent's** (`agent.routes.ts:139`). An agency dashboard that followed this bullet got a
> 404. The way an agency learns there *is* a proof — including `originalName` and `size` — is
> the `deliveryProof` object on `GET /api/agency/shipments/:id`, which is the bullet above and
> was always correct.
>
> It survived `route-coverage.js` and `phantom-routes.js` because both match a path SHAPE
> against the whole tree, and `/shipments/:id/delivery-proof` really is served — on the other
> role's mount. **A route claim is only checkable against the mount it is written under.**

### The fix

**`GET /api/agency/shipments/:id/delivery-proof/file`** — the image bytes.

| | |
|---|---|
| Returns | the raw image · `Content-Type` from the file |
| Headers | `Content-Disposition: inline` · `Cache-Control: private, no-store` |
| Authorization | **the shipment's own** — the same scoping as `GET /api/agency/shipments/:id` |
| Not yours, or no proof attached | **404**, never 403 |

Because it is a same-origin cookie-authenticated GET, a browser can point an `<img>` straight at
it:

```tsx
{proof && proof.access === 'authorized'
  ? <img src={`/api/agency/shipments/${shipmentId}/delivery-proof/file`} alt="Delivery proof" />
  : null}
```

⚠ **If your dashboard is wrapped in Capacitor**, it is a bearer client and cannot rely on the
cookie: fetch with the `Authorization` header and turn the response into a blob URL.

⚠ **`Cache-Control: private, no-store` is deliberate.** The old public URL was cacheable by
anything in the path, which is half of what made it a durable leak. Do not add your own
persistent cache in front of it.

### Why `null` and not the new path

A path is a string that looks exactly like a public URL, so a client keeps `<img src={url}>` and
silently renders nothing for every viewer whose session is not attached — a bug that presents as
*"the photo is sometimes missing"* and takes a week to find. `url: string | null` is a **type**
change, so your compiler produces the migration list instead of your users.

---

## 2 · 🔴 The 90-day absolute session cap

Full explanation in [the cross-role page § 2](../FRONTEND-CHANGELOG-phase-4-5.md#2---a-sign-in-is-now-bounded-at-90-days-whatever-it-does-in-between).

| | |
|---|---|
| **Code** | `AUTH_SESSION_CAP_REACHED` · **401** · category `authentication` |
| **Fires on** | **any authenticated request**, not just a refresh |
| **Window** | 90 days since the operator last actually proved a credential |

```ts
if (err.error?.code === 'AUTH_SESSION_CAP_REACHED') {
  clearSession();
  redirectToLogin({ notice: 'Your session expired — please sign in again.' });
  return;                       // never retry, never refresh
}
```

⚠ **Branch on the code before your generic "401 → refresh → replay" interceptor**, or the refresh
401s with the same code and you loop.

A **password change** re-stamps the clock; `auth-me` on launch does not, any more. That was the
defect — every client calls `auth-me` on launch, so the 30-day window used to slide forever.

---

## 3 · Uploads are actually scanned now

Your logo, banner, avatar, general documents, **delivery-proof photos your agents attach** and
your policy documents all now pass a real ClamAV scan. Until Phase 4 the scanner on those paths
was a no-op, with the configuration claiming otherwise.

| Situation | Wire | What to show |
|---|---|---|
| Infected | **`400 UPLOAD_POLICY_VIOLATION`** — `VIRUS_DETECTED` in `details.violations[]` | "Rejected by a virus scan." Do not retry. |
| Scanner unreachable / timed out | **`502 UPLOAD_VIRUS_SCAN_UNAVAILABLE`** | "We could not check this file right now." **Retryable.** |

⚠ **The second is not a verdict on the file** — the file was never judged. "Could not scan" is
deliberately never spelled "clean", so the upload is refused, but telling the operator their
document was *rejected* says something untrue about it.

**Magic-byte sniffing is now on everywhere too**: the `Content-Type` the browser sends is no
longer trusted, so a mislabelled file is refused where it used to be stored.

---

## 4 · Policy documents: same request, same response, real rules

`POST /api/agency/profile/policy-documents` used to write straight to storage — no scan, no
sniffing, no quota, and the only type gate was the **client-claimed** `Content-Type`. It now runs
the real pipeline. **The response is still `{ urls: string[] }`; no client moves.**

| Rule | Value |
|---|---|
| Files per request | 2 |
| Per-file size | 5 MB (10 MB total) |
| Type | **PDF only, checked against the sniffed bytes** |
| Quota | Counts against your plan's media cap |
| Virus scan | Yes |

Two consequences: an agency near its storage cap can now be refused here, and a renamed non-PDF
is now refused rather than stored and handed to a vendor as a broken file. The returned URLs stay
**public by design** — you republish them into `policies.documents`.

---

## 5 · Tickets: the administrator snapshot is documented now, and it had quietly changed

`assigned_admin` and `created_by_admin` carry an administrator snapshot. It used to be
`{ user_id, role, name, avatar }`; it is now:

```json
{ "name": "Kofi Mensah", "job_title": "Support lead", "department": "Customer Care", "avatar_url": null }
```

Written up in [tickets.md § Administrator snapshot](./tickets.md). The four things worth knowing:

- **`assigned_admin` is `null` until a wi-admin administrator takes the ticket**, and most tickets
  never are. `null` is the normal state, not missing data — which is exactly why nobody noticed
  the shape had changed.
- **`created_by_admin`** carries the identical shape and had been documented **nowhere**.
- **`avatar_url` is reserved and permanently `null`.** Render initials from `name`; do not branch
  on it. wi-admin has no write-side file surface at all, so there is no picture to fetch.
- **No `tier`, no `id`** — deliberately. The `assigned_admin_id` beside the block is an id in the
  administration service and **resolves to nothing here**.

---

## 6 · The live map — behaviour, not contract

Detail in [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md).
**No frame, no field and no error code changed.** Two things to know:

1. **`TRACKING_SESSION_TTL` is 72 h**, up from 48 h. That is the ceiling on how long a session
   survives a lost terminal event; it must exceed the longest plausible delivery, and 72 h was
   measured against an inter-city delivery plus one failed-then-retried attempt. A
   `handing_over` reassignment chaining onto a day-old delivery is the case the margin does *not*
   comfortably cover — if you see that in operation, say so.
2. **The durable GPS trail is now plausibility-gated.** A fix implying more than 75 m/s from the
   last known position already never reached the live position or a broadcast; it now also does
   not land in the trail. **A replayed trail may therefore have gaps** where a spoofed or noisy
   stream was rejected. The session still *heartbeats* on such a fix — deliberately, so bad GPS
   cannot starve a real delivery into `gps_lost`.

**Unchanged, and not a bug:** revocation is pushed but a *grant* is not — a newly-authorised
watcher waits out `PERMISSION_CACHE_TTL`, and a reconnect does **not** shorten that wait (the
cache is user-keyed in Redis, so it outlives the socket).

---

## 7 · Ticket notes — why seeded tickets may show staff shorthand

Until 2026-08-20, wi-admin sent `isPublic` where this service reads `visibility`. The receiving
schema is not `strict()`, so the key was **dropped** and the default (`PUBLIC`) applied: **every
note wi-admin ever created was filed public**, and you were shown it.

Fixed at the boundary. Historical rows were **not** backfilled — this platform is pre-production
and deliberately writes no data migrations. Nothing to build; it explains what you may be seeing.

---

## 8 · What did NOT change

- **Shipment dispatch, reassignment and the `handing_over` status.** Untouched.
  `409 SHIPMENT_STATUS_CONFLICT` still means re-read and re-render, not blind-retry.
- **Agent visibility on the map** still derives from **shipments**, not the roster. A browsable
  agent is not a watchable one.
- **The two privacy gates are still separate.** Live position is gated on Tracking Allow alone;
  the durable trail is gated on an open tracking session. An opted-in agent with no delivery is
  *locatable but not tracked*.
- **The forwarded-token refresh asymmetry.** Still deliberate. Reconnect the tracking socket with
  a fresh token on a cadence shorter than the 15-minute access TTL.
- **Every public file URL** — logo, banner, avatars, general documents. Byte-identical.
- **`/api/admin/delivery-agencies` is gone**, but it was never yours — it was the *administrator's*
  view of agencies and now lives at wi-admin's `/api/v1/agencies/*`.

---

## 9 · Where to look

| Topic | Document |
|---|---|
| The cross-role summary | [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md) |
| 🔴 Private files, `access`, the proof route | [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) |
| Shipments | [shipments.md](./shipments.md) |
| Live tracking — this side | [live-tracking.md](./live-tracking.md) |
| Live tracking — the socket | [`geo-tracker/api-doc/tracking-websocket.md`](../../../geo-tracker/api-doc/tracking-websocket.md) |
| Sessions and tokens | [../auth/README.md](../auth/README.md) |
| Uploads | [../uploads/README.md](../uploads/README.md) · [file-management.md](./file-management.md) · [storage.md](./storage.md) |
| Tickets | [tickets.md](./tickets.md) |
| Error catalog | [../errors/README.md](../errors/README.md) |
