# Agency / agent mobile app — what Phase 4 and Phase 5 changed

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md)
- 🔴 **Then this, before your next release:** [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md)
- **Also:** [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md)
  — you hold the socket that streams position
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

> **Two of these land harder on a native app than on a browser**, because a bearer client has no
> cookie to renew from and no same-origin `<img>` to lean on. Sections 1 and 2.

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 A session is capped at **90 days absolutely** — new terminal 401 | **Required** — and it is more visible here than anywhere else |
| 2 | 🔴 **The proof photo has no public URL any more** — fetch bytes with your bearer token | **Required** |
| 3 | Proof-photo uploads are now **virus-scanned and magic-byte sniffed** | Design — two new refusal paths |
| 4 | Tracking session TTL 48 h → **72 h**; the durable trail is plausibility-gated | None — behaviour only |
| 5 | Tickets: the administrator snapshot shape is now documented, and it had changed | Small |
| 6 | `accuracyMetres` was formally closed as out of scope — **and it starts in your app** | Read § 6 before anyone re-requests it |

**Nothing you call was renamed, removed or re-shaped.** `POST /api/agent/shipments/:id/status`,
the offer accept/reject flow, COD collect, `PUT /api/agent/device`, `PUT /api/agent/availability`,
earnings, billing, agency membership and the discovery surfaces answer exactly as their documents
describe.

---

## 1 · 🔴 The 90-day absolute session cap — the change most visible in a native app

Full explanation in [the cross-role page § 2](../FRONTEND-CHANGELOG-phase-4-5.md#2---a-sign-in-is-now-bounded-at-90-days-whatever-it-does-in-between)
and [`docs/ADR-A03-SESSION-CAP.md`](../../docs/ADR-A03-SESSION-CAP.md).

### What changed

Every token now carries an **`auth_time`** claim recording when the rider last actually *proved*
something. It is copied byte-identical through every re-issue, and once
`now − auth_time > 90 days` the session is refused.

Before this, the 30-day refresh window slid forever: your app calls `auth-me` on launch and was
re-issued **both** tokens at full lifetime, so an agent who opens the app at all never lapsed —
and neither did a stolen token an attacker kept refreshing.

| | |
|---|---|
| **Code** | `AUTH_SESSION_CAP_REACHED` |
| **Status** | **401** · category `authentication` |
| **Default message** | *"It's been a while — please sign in again"* |
| **Window** | `AUTH_ABSOLUTE_SESSION_CAP`, default **90 days** |

### Where it fires

**Both** on `POST /api/auth/mobile/refresh` **and inside `requireAuth`, on every authenticated
request.** That second half is not belt-and-braces — it is necessary. `auth-me` and `add-role`
both mint a full fresh pair from a valid *access* token, so an app polling `auth-me` inside the
15-minute access lifetime would never reach the rotation at all and the window would slide
exactly as before.

So plan for the refusal to arrive **on any call**, including the first one after a cold start.

### What your app must do

```dart
if (error.code == 'AUTH_SESSION_CAP_REACHED') {
  await secureStorage.clearTokens();
  navigateToLogin(notice: 'Please sign in again');
  return;                      // do NOT retry, do NOT refresh — both fail identically
}
```

⚠ **Order this branch above your generic 401-refresh-retry.** If a capped 401 reaches that
handler it refreshes, gets the same code, and loops until the app is killed.

⚠ **Distinguish it from its two neighbours.** `AUTH_SESSION_EXPIRED` is routine and refreshable.
`AUTH_PASSWORD_CHANGED` means something may be wrong and deserves a different message. This one
is normal, expected, and terminal — do not show it as an error.

### What resets the clock

A real **login**, a **registration**, the messaging bot's single-use login code, or a **password
change**. `auth-me` on launch does not, any more. Note the password-change case: the rider proved
their old password, and a password change is the platform's only existing revocation — so
re-stamping there is what keeps "change your password" a complete remedy after a lost phone.

### Nobody is signed out on deploy day

A token minted before this feature carries no `auth_time` and is dated from its own `iat`. Every
live refresh token was minted within the last 30 days, so a legacy session is capped from at most
30 days ago and gains a real `auth_time` on its first re-issue.

**Design implication:** an agent who never signs out will now be sent to the login screen roughly
every three months. That is the accepted trade — a bearer client has no silent renewal the way a
browser does. Make that path fast and pleasant rather than treating it as a failure state, and
consider a gentle in-app notice a few days out if you can compute it from `auth_time`.

---

## 2 · 🔴 The delivery-proof photo has no public URL any more

**Read [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md).** The
agent-shaped summary:

A proof photo is *a place and a time about a real customer's address*. It used to sit behind an
unguarded static mount, so anyone who had ever seen the URL could fetch it forever with no
session. The `shipments/` tree left that mount.

```diff
  {
    "id": "665f0c…", "key": "shipments/2026/08/9f2c…_proof.webp",
-   "url": "https://…/shipments/2026/08/9f2c…_proof.webp",
+   "url": null,
+   "access": "authorized",
    "mimeType": "image/webp", "size": 184320, "originalName": "proof.jpg"
  }
```

**Where you see it:** the `201` response to
`POST /api/agent/shipments/:id/delivery-proof`, the metadata read
`GET /api/agent/shipments/:id/delivery-proof`, and `deliveryProof` on
`GET /api/agent/shipments/:id`.

**The new door:**

| | |
|---|---|
| Route | **`GET /api/agent/shipments/:id/delivery-proof/file`** |
| Returns | the raw image bytes · `Content-Type` from the file |
| Headers | `Content-Disposition: inline` · `Cache-Control: private, no-store` |
| Authorization | **the shipment's own** — if you can read the shipment, you can read its proof |
| Not yours, or nothing attached | **404**, never 403 |

**As a bearer client you cannot point an `<Image>` at it directly.** Fetch with your
`Authorization` header and hand the bytes to your image widget:

```dart
final res = await http.get(
  Uri.parse('$base/api/agent/shipments/$shipmentId/delivery-proof/file'),
  headers: {'Authorization': 'Bearer $accessToken'},
);
// res.bodyBytes -> Image.memory(...)
```

⚠ **Respect `no-store`.** The old URL was cacheable by anything in the path, which is half of what
made it a durable leak. Keep it in memory for the screen; do not write it to a persistent cache.

**The metadata read is still worth calling** — it is how you know whether a proof exists, and it
carries `originalName` and `size` for a "photo attached" affordance without pulling the bytes.

**Why `null` rather than the new path:** a path is a string indistinguishable from a public URL,
so a client keeps rendering it and silently shows nothing. `url: string | null` is a *type* change
so your compiler produces the migration list instead of your riders.

---

## 3 · The proof-photo upload is now actually scanned

`POST /api/agent/shipments/:id/delivery-proof` ran a **no-op** scanner until Phase 4, with the
configuration claiming otherwise. It now runs a real ClamAV scan, and the declared
`Content-Type` is no longer trusted — the bytes are sniffed.

| Situation | Wire | What to show |
|---|---|---|
| Infected | **`400 UPLOAD_POLICY_VIOLATION`** — `VIRUS_DETECTED` in `details.violations[]` | "This photo was rejected." Do not retry the same file. |
| Scanner unreachable / timed out | **`502 UPLOAD_VIRUS_SCAN_UNAVAILABLE`** | "We could not check this photo — try again." **Retryable.** |

⚠ **The second is not a verdict on the photo.** "Could not scan" is deliberately never spelled
"clean", so the upload is refused — but the photo was never judged, and telling the rider it was
*rejected* is untrue and will get them re-taking a fine photo in the rain.

The existing rules are unchanged: `image/jpeg`, `image/png`, `image/webp`, max **10 MB**, exactly
one file, charged to the **agency's** storage cap (`QUOTA_EXCEEDED` inside
`UPLOAD_POLICY_VIOLATION` when the agency is full).

---

## 4 · Tracking — TTL and the trail

Detail in [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md).
**No frame, no field and no error code changed on the socket.**

1. **`TRACKING_SESSION_TTL` is 72 h**, up from 48 h. It bounds how long a session survives a lost
   terminal event. The constraint is that it must exceed the longest plausible delivery — a
   session expiring under a live delivery means your reconnect mints a *new* one instead of
   resuming, which is precisely what the session model exists to prevent, and it fails silently.
2. **The durable trail is now plausibility-gated.** A fix implying more than **75 m/s** from the
   last known position never reached the live position or a broadcast, and now also does not land
   in the trail.
   - **Your heartbeat still counts.** An implausible fix is *not* treated as silence: the session
     stays `ONLINE` and does not walk into `gps_lost`. The device is reporting; what is
     untrustworthy is the position, not the fact of the report.
   - **The two error sentinels on `location_update` are unchanged** — an invalid coordinate and an
     implausible jump still map to the same distinct client error codes they always did. Nothing
     to change; this is stated so you do not go looking for a new one.
   - Practical note: a first fix after a long tunnel or a cold GPS lock can legitimately look like
     a jump. It is dropped from the trail and the session carries on; that is the intended
     behaviour, not a bug to work around by faking intermediate points.

**Unchanged and deliberate:** an agent cannot switch Tracking Allow off mid-shipment (geo-tracker
refuses it, because jovi-mall will not dispatch without it). An **administrator** revoking it is
never refused, ends no session, and revokes no watcher — they stay subscribed and receive nothing.

---

## 5 · Tickets: the administrator snapshot is documented now

`assigned_admin` and `created_by_admin` carry an administrator snapshot. It used to be
`{ user_id, role, name, avatar }`; it is now:

```json
{ "name": "Kofi Mensah", "job_title": "Support lead", "department": "Customer Care", "avatar_url": null }
```

[agent/tickets.md](./tickets.md) defers payload shapes to
[vendor/tickets.md](../vendor/tickets.md) by design and now carries a callout pointing at the new
**Administrator snapshot** section there. The short version:

- **`assigned_admin` is `null` until a wi-admin administrator takes the ticket** — the normal
  state, not missing data.
- **`avatar_url` is reserved and permanently `null`.** Draw initials from `name`; do not branch on
  it and do not build a loading state for it.
- **No `tier`, no `id`.** `assigned_admin_id` beside the block resolves to nothing in this service.

Separately: staff notes created through wi-admin before 2026-08-20 were filed **public** by a
field-name mismatch and were shown to ticket followers. Fixed at the boundary; historical rows are
not backfilled. Nothing to build — it explains odd-looking notes in seed data.

---

## 6 · `accuracyMetres` was closed as out of scope — and the first of its four parts is yours

The admin dashboard asked for GPS accuracy on the tracking record. Phase 4 closed the request as
**out of scope**, with the reason written down rather than left on an open list, and the reason is
worth carrying to whoever asks next:

> The field would have to originate in the **Flutter agent application**, travel through
> geo-tracker's `location_update` frame and its location domain, reach the **checkpoint trail** —
> because an administrator reads `last_known_tracking_state`, never a live position — and only
> then reach wi-admin. **Four parts across two repositories and a mobile release. None of them
> exists.**

Nothing to do today. But you are part one: if accuracy is ever wanted, the `location_update`
frame is where it starts, and that is a two-repository change plus an app release — not a
backend field somebody can add.

---

## 7 · What did NOT change

- **Status transitions and COD collect.** Still transactional with their tracking event; a failure
  to write the event still rolls the transition back, and `409 SHIPMENT_STATUS_CONFLICT` still
  means re-read and re-render rather than blind-retry.
- **Offers, acceptance, capacity, reassignment and `handing_over`.** Untouched.
- **`permission_revoked.reason`** is still the closed set of three introduced in Phase 3 —
  `shipment_completed`, `authorization_expired`, `authorization_unavailable`. Treat an unknown
  value as `authorization_expired` and report **no** delivery outcome.
- **The forwarded-token refresh asymmetry.** Deliberate. The WS token is validated at handshake
  only, but a webhook-triggered revocation forwards your *stale* handshake token back to
  jovi-mall — so an expired one drops a watcher. **Reconnect with a fresh token on a cadence
  shorter than the 15-minute access TTL.**
- **geo-tracker's CORS request-header allowlist** is still closed to `Authorization`,
  `Content-Type`, `X-Request-Id`. Do not add a custom request header to a geo-tracker call.
- **Push notifications.** Unchanged by these phases. The `firebase-admin` 14 migration from Phase 2
  is still **unverified end to end** — that caveat has not been discharged.

---

## 8 · Where to look

| Topic | Document |
|---|---|
| The cross-role summary | [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md) |
| 🔴 Private files, `access`, the proof route | [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) |
| Delivery proof | [delivery-proof.md](./delivery-proof.md) |
| Shipments · offers · COD | [shipments.md](./shipments.md) · [offers.md](./offers.md) · [cod-cash.md](./cod-cash.md) |
| Sessions and tokens | [../auth/README.md](../auth/README.md) · [../mobile-auth-backend-spec.md](../mobile-auth-backend-spec.md) |
| The session cap's reasoning | [`docs/ADR-A03-SESSION-CAP.md`](../../docs/ADR-A03-SESSION-CAP.md) |
| The tracking socket | [`geo-tracker/api-doc/tracking-websocket.md`](../../../geo-tracker/api-doc/tracking-websocket.md) |
| The trail and its gating | [`geo-tracker/api-doc/gps-persistence.md`](../../../geo-tracker/api-doc/gps-persistence.md) |
| Error catalog | [../errors/README.md](../errors/README.md) |
