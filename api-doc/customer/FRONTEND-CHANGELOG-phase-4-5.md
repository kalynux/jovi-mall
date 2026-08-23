# Customer app — what Phase 4 and Phase 5 changed

Your slice of Phases **4** (Per-service hardening) and **5** (Legacy close-out) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 4:** 2026-08-19 → 08-20 · **Phase 5:** 2026-08-20
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md)
- **The unauthenticated half of the shop** is [../public/FRONTEND-CHANGELOG-phase-4-5.md](../public/FRONTEND-CHANGELOG-phase-4-5.md)
- **Previous instalment:** [FRONTEND-CHANGELOG-phase-2-3.md](./FRONTEND-CHANGELOG-phase-2-3.md)

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | 🔴 A session is capped at **90 days absolutely** — new terminal 401 | **Required** — one branch, and a route to sign-in |
| 2 | Digital purchases: the token link is now the **only** way to fetch a file | None — you were already using it |
| 3 | `FileDetail` gained `access`; `url` can be `null` | Small — nothing a customer sees today is affected |
| 4 | Ticket attachment uploads are now virus-scanned and byte-sniffed | Design — two new refusal paths |
| 5 | Tickets: the administrator snapshot shape is now documented, and it had changed | Small |
| 6 | Order tracking: session TTL 48 h → **72 h**, trail is plausibility-gated | None — behaviour only |
| 7 | Tickets: staff notes used to leak to you | None — explains seed data |

**Nothing you call was renamed, removed or re-shaped.** Cart, checkout, orders, bookings, payment
methods, profile and addresses, digital products and the storefront read side answer exactly as
their documents describe.

---

## 1 · 🔴 The 90-day absolute session cap

Full explanation in [the cross-role page § 2](../FRONTEND-CHANGELOG-phase-4-5.md#2--a-sign-in-is-now-bounded-at-90-days-whatever-it-does-in-between).

Before Phase 4, a customer who opened the app at all never had to sign in again: every client
calls `auth-me` on launch and was re-issued **both** tokens at full lifetime, so the 30-day
refresh window slid forever — and so did a stolen one.

| | |
|---|---|
| **Code** | `AUTH_SESSION_CAP_REACHED` · **401** · category `authentication` |
| **Default message** | *"It's been a while — please sign in again"* |
| **Fires on** | **any authenticated request**, not just a refresh |
| **Window** | 90 days since the customer last actually proved a credential |

```ts
if (err.error?.code === 'AUTH_SESSION_CAP_REACHED') {
  clearTokens();
  routeToSignIn();      // never retry, never refresh — both fail identically
}
```

⚠ **Branch on the code before your generic "401 → refresh → replay" handler**, or the refresh
401s with the same code and you loop.

⚠ **Distinguish it from `AUTH_SESSION_EXPIRED`** (routine, refreshable) and
`AUTH_PASSWORD_CHANGED` (something may be wrong). This one is normal and expected — present it as
a sign-in prompt, not an error.

### What this means for a bot-first customer

Customers on this platform **sign in passwordlessly** through the messaging bot
([auth/customer-auth.md](../auth/customer-auth.md)). The single-use code the bot hands out
**does** re-stamp the clock — it is a credential being proved. So the 90-day re-authentication is
one bot round-trip, not a password screen.

Make that path obvious from the sign-in prompt. A customer who is bounced out and shown a
password field they never had is the failure mode to avoid here.

---

## 2 · Digital purchases — the raw file URL is gone

Nothing in your flow changes. `POST /api/digital/download-token` still returns

```json
{ "url": "/api/digital/download/eyJ0b2tlbiI6...", "expiresAt": "…", "downloadsRemaining": 4 }
```

and `GET /api/digital/download/:token` still executes the download.

**What changed is that this is now the only door.** The `digital/` storage tree left the public
static mount. Previously, anyone who had ever seen the underlying storage path could fetch the
file forever with no session — which made the token's **single-use consumption**, its **download
counter** and the vendor's **revocation** all advisory, permanently, with nothing recording that
it had happened.

So the three things your UI already tells the customer — *"this link is single use"*, *"N downloads
remaining"* — are now true. Worth a look at whether your copy was hedging.

---

## 3 · `FileDetail` gained `access`, and `url` can be `null`

Detail in [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md).

```jsonc
{ "id": "…", "key": "…", "url": "https://…" | null,
  "access": "public" | "authorized",
  "mimeType": "…", "size": 0, "originalName": "…" }
```

**Nothing a customer currently sees moved to `authorized`.** Product imagery, store logos and
banners, your avatar and ticket attachments are all still `public` with byte-identical URLs. The
two private trees are digital-product files (which you reach by token, § 2) and delivery-proof
photos (which are an agency/agent screen, not yours).

Still: **widen your type**, because `url` is now `string | null` on the shared shape and `access`
is present on every file. Doing it now costs a line; discovering it when a future surface goes
private costs a release.

---

## 4 · Ticket attachments are now scanned

The general upload path (`POST /api/files/upload`, which is how a ticket attachment is created)
ran a **no-op** virus scanner until Phase 4, and trusted the `Content-Type` your client declared.
Both are now real.

| Situation | Wire | What to show |
|---|---|---|
| Infected | **`400 UPLOAD_POLICY_VIOLATION`** — `VIRUS_DETECTED` in `details.violations[]` | "This file was rejected." Do not retry it. |
| Scanner unreachable / timed out | **`502 UPLOAD_VIRUS_SCAN_UNAVAILABLE`** | "We could not check this file — please try again." **Retryable.** |

⚠ **The second is not a verdict on the file.** "Could not scan" is deliberately never spelled
"clean", so the upload is refused — but the file was never judged, and saying it was *rejected*
tells the customer something untrue about their own document.

**Magic-byte sniffing** is now on: a file whose real type does not match what the browser declared
is refused with a policy violation, where it previously stored fine.

⚠ **A ticket attachment is still stored in a public tree.** It lands in `documents/` or `images/`
— the same folders as public product imagery — and is attached to the ticket by id afterwards.
Making those private needs a dedicated upload path that **does not exist yet**. Do not read the
private-files change as having closed that; if your product copy promises attachment privacy,
it is currently promising more than the backend does.

---

## 5 · Tickets: the administrator snapshot is documented now, and it had quietly changed

`assigned_admin` and `created_by_admin` on your ticket reads carry an administrator snapshot. It
used to be `{ user_id, role, name, avatar }`; it is now:

```json
{ "name": "Kofi Mensah", "job_title": "Support lead", "department": "Customer Care", "avatar_url": null }
```

[customer/tickets.md](./tickets.md) defers payload shapes to
[vendor/tickets.md](../vendor/tickets.md) by design and now carries a callout pointing at the new
**Administrator snapshot** section there. The short version:

- **`assigned_admin` is `null` until a support administrator takes the ticket**, and most tickets
  never are. `null` is the normal state, not missing data.
- **`created_by_admin`** carries the identical shape — non-null only when an administrator opened
  the ticket *for* the customer. When they did, `created_by` also appears with `role: "admin"`,
  but its `user_id` resolves nowhere and its `avatar` is always `null`. **Render the person from
  the snapshot block, not from the actor summary.**
- **`avatar_url` is reserved and permanently `null`.** Draw initials from `name`; do not branch on
  it and do not build a loading state for it.
- **No `tier`, no `id`** — the administrator hierarchy is deliberately not disclosed to a ticket
  follower.

---

## 6 · Order tracking — behaviour, not contract

Detail in [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-4-5.md).
**No frame, no field and no error code changed.**

- **The tracking session TTL is 72 h**, up from 48 h — the ceiling on how long a session survives
  a lost terminal event.
- **The durable trail is plausibility-gated**: an implausible fix never reached the live position
  or your map, and now also does not land in the stored trail. Live behaviour is unchanged.
- **`permission_revoked.reason` is still the closed set of three** from Phase 3 —
  `shipment_completed`, `authorization_expired`, `authorization_unavailable`. If you have not
  shipped that branch yet, **it is still the most important thing on your tracking screen**: treat
  an unknown value as `authorization_expired`, and report a delivery outcome **only** on
  `shipment_completed`.

---

## 7 · Ticket notes — why seeded tickets may show staff shorthand

Notes carry `visibility: PUBLIC | PRIVATE`, and you are shown the public ones plus the private
ones addressed to you. Until 2026-08-20 the administration service sent the wrong field name for
that switch, the key was silently dropped, the default (`PUBLIC`) applied, and **every note it
ever created was filed public**.

Fixed at the boundary. Historical rows were **not** backfilled — this platform is pre-production
and deliberately writes no data migrations. Nothing to build; it explains what you may be seeing
in seeded data.

---

## 8 · What did NOT change

- **Registration and sign-in are still bot-first.** There is no customer registration endpoint and
  no password field. [auth/customer-auth.md](../auth/customer-auth.md) is canonical.
- **`POST /api/payments/initiate` and `/verify` are still unauthenticated by design** — a mother
  orders and a son pays. This was examined and withdrawn as a finding; do not "fix" it.
- **Cart, checkout, quotes and delivery.** Untouched. (A dead `CartService.validateCheckout` with
  zero call sites was deleted; the live path is unchanged.)
- **Every public file URL** — product imagery, store logos and banners, avatars. Byte-identical.
  This was a routing change, not a migration.
- **`GET /api/health`'s frozen shape**, if you render a status indicator anywhere.

---

## 9 · Where to look

| Topic | Document |
|---|---|
| The cross-role summary | [../FRONTEND-CHANGELOG-phase-4-5.md](../FRONTEND-CHANGELOG-phase-4-5.md) |
| Private files and `access` | [../FRONTEND-CHANGELOG-private-files.md](../FRONTEND-CHANGELOG-private-files.md) |
| Customer auth (bot registration + passwordless sign-in) | [../auth/customer-auth.md](../auth/customer-auth.md) |
| Sessions and tokens | [../auth/README.md](../auth/README.md) |
| Digital products | [digital-products.md](./digital-products.md) |
| Orders · cart · bookings | [orders.md](./orders.md) · [cart.md](./cart.md) · [bookings.md](./bookings.md) |
| Tickets (shared payload reference) | [../vendor/tickets.md](../vendor/tickets.md) |
| The tracking socket | [`geo-tracker/api-doc/tracking-websocket.md`](../../../geo-tracker/api-doc/tracking-websocket.md) |
| Error catalog | [../errors/README.md](../errors/README.md) |
