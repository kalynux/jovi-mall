# Agency / agent mobile app — what Phase 2 and Phase 3 changed

**Verified against source on 2026-09-08** — § 1 (the outbox row now commits inside the transaction:
`TrackingOutboxRepository.enqueue` takes a `ClientSession` and `TrackingEventSubscriber` is gone),
§ 2 (`ErrTrackingAllowLocked` is agent-only; `TRACKING_ALLOW_LOCKED` is its wire code), § 3 (the
three `permission_revoked` reasons in `geo-tracker/internal/modules/tracking/domain/entity.go`) and
§ 7 (the colour migration ran: 8 agents, `"bleu"` left verbatim). Everything here still holds.

Your slice of Phases **2** (Deployability) and **3** (Cross-service correctness) of
[`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md).

- **Written:** 2026-08-21 · **Phase 2:** 2026-08-18 → 08-19 · **Phase 3:** 2026-08-19
- **Read first, then this:** [../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md)
- **Also read:** [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)
  — you hold the socket that streams position
- **If your app is a Capacitor/WebView wrapper** rather than native, § 5 is the one that
  unblocks you.

---

## The change list, ranked

| # | Change | Your work |
|---|---|---|
| 1 | Status transitions and COD collect are **atomic with their tracking event** | Small — one new retryable error path |
| 2 | An admin **Tracking Allow revocation** now actually reaches geo-tracker, and converges within 15 min | **Design** — you need a "tracking disabled by administrator" state |
| 3 | 🔴 `permission_revoked.reason` is a closed set of three | Required **if** you subscribe to a live position (e.g. self-view) |
| 4 | Your ETA/tracking view gains a **drop-off-derived ETA** | Optional |
| 5 | Capacitor origins now in both `.env.example` templates | **Unblocks** a wrapped build |
| 6 | `firebase-admin` 13 → 14 — push migrated, **FCM send unverified** | **Test push end to end** |
| 7 | Vehicle colour vocabulary normalised in the data | Small |
| 8 | Restart/keep-alive behaviour — matters for a native connection pool | Small |

Nothing was renamed, removed or re-shaped. `POST /api/agent/shipments/:id/status`,
`POST /api/agent/shipments/:id/cod/collect`, `PUT /api/agent/device`,
`PUT /api/agent/availability` and the rest answer exactly as their documents describe.

---

## 1 · Status transitions and COD collect are now atomic with their tracking event

`POST /api/agent/shipments/:id/status`, `POST /api/agent/shipments/:id/cancel` and
`POST /api/agent/shipments/:id/cod/collect` now write the geo-tracker lifecycle event **inside**
the same database transaction as the state change they cause.

Previously the event was emitted after commit, fire-and-forget. A crash in that window lost it
permanently — a delivered shipment whose position kept being broadcast, or a cancel geo-tracker
never learned about.

**What changes for the app:**

- **A new failure mode, and it is the correct one.** If the event cannot be written, the whole
  transition **rolls back**: the call returns an error and the status did **not** change. Retry
  it. Previously the transition would have "succeeded" while the event vanished — which looked
  like success and left the platform inconsistent.
- **`409 SHIPMENT_STATUS_CONFLICT` is unchanged** and is a routine outcome, not an exception:
  the agency dispatcher and you both drive the same document. **Re-read the shipment and
  re-render.** Do not blind-retry a transition on a 409 — the shipment is not in the status you
  thought it was.
- **A COD collection's status read-back is now correct.** `collect()` reads the shipment status
  back inside its own transaction, so the event now carries the `delivered` that the collection
  itself caused. Nothing to do — it just stops being subtly wrong.
- Request shapes and success responses are identical.

---

## 2 · Tracking Allow: an administrator's revocation now reaches the device

**Design impact — this is the item most likely to need a new screen state.**

Tracking Allow has two owners, and they are not the same switch:

| Owner | What it is | Who writes it |
|---|---|---|
| jovi-mall | `DeliveryAgent.tracking.allowed` — whether tracking is **permitted** | an **administrator** |
| geo-tracker | `DeviceState.TrackingEnabled` — the **device opt-in** | **you**, over the WS `device_state` frame |

Until recently an administrator disabling tracking stopped *new dispatch* and **nothing else** —
the agent went on streaming, because the flag reached geo-tracker through no path at all. That
was closed earlier (Phase 9), and **Phase 3 made it reliable**:

- the flag write and its outbox event now commit **together** (they used to be a bare write plus
  a fire-and-forget publish — the one event with no recovery path anywhere), and
- a new worker re-pushes every revoked agent every **15 minutes** as a backstop, so a lost event
  self-corrects instead of leaving an agent streaming after being told they may not be.

**Three properties are load-bearing and you should build against all three:**

1. **An administrator's revocation is never refused.** The `ErrTrackingAllowLocked` guard that
   stops an agent switching tracking off mid-shipment protects against the **agent** changing
   their mind — it does not apply to an admin.
2. **It ends no tracking session.** Whether a delivery is over is jovi-mall's call, and this
   event does not make it. Your active deliveries stay active.
3. **It revokes no watcher.** The agency stays subscribed and simply receives nothing.

**So the state to render is: "deliveries still assigned to you, live position suppressed by an
administrator."** Not "logged out", not "delivery cancelled", not an error. And note the
practical consequence for the agent: jovi-mall will not dispatch new work to an agent without
Tracking Allow, so this state is a work-stopping one and deserves a clear, non-alarming
explanation plus a "contact your agency" affordance.

Your own opt-out is unchanged: refused while a shipment is in flight. Physical GPS loss is never
refused — it merely impairs the session.

See [availability-and-device.md](./availability-and-device.md) and
[`geo-tracker/api-doc/tracking-sessions.md`](../../../geo-tracker/api-doc/tracking-sessions.md).

---

## 3 · 🔴 `permission_revoked.reason` — only if you also *watch* a position

The agent app's primary socket role is to **publish** position, and a publisher is never sent
`permission_revoked`. But if any screen **subscribes** — a self-view map, or an agency-side
feature inside the same app — this applies to it.

`reason` used to be the single literal `shipment_completed` for every outcome. It is now a
closed set of three:

| `reason` | Meaning | Do |
|---|---|---|
| `shipment_completed` | jovi-mall answered, and the viewer is no longer entitled | Stop watching. **The only value from which you may report a delivery outcome.** |
| `authorization_expired` | the access token was rejected (401/403) — nothing is known about the shipment | Get a fresh token, reconnect, re-subscribe. Say nothing about the delivery. |
| `authorization_unavailable` | jovi-mall could not be asked | Retry with backoff. Report no outcome. |

Treat any unrecognised value as `authorization_expired`.

**And the rule that applies to you regardless of whether you subscribe:** the WS token is
validated **at handshake only**, and there is no refresh path over the socket — geo-tracker
forwards a bearer token and cannot reach jovi-mall's refresh cookie. A socket held open past the
**15-minute** access TTL keeps working until something triggers a re-authorization, and then
stops.

**Reconnect with a fresh access token on a cadence shorter than the access TTL.** For an app
that sits open in a courier's pocket all day, this is the difference between a working shift and
a mysterious dead socket. Do **not** wait for a handshake ack frame telling you when to
refresh — there is no such frame, and a proposal to add one was examined and rejected (it would
have meant a fifth outbound frame type that exhaustive clients reject).

---

## 4 · The tracking ETA now resolves from the shipment

If any screen shows an ETA, geo-tracker now pulls the parcel's geocoded drop-off from jovi-mall
at session activation, so a watcher gets `etaSeconds` / `distanceMeters` without supplying a
`destination`. `subscribe` gained an optional `shipmentId` to scope it when several deliveries
are in flight; with no scoping the server resolves from the agent's **sole** open session and
otherwise declines rather than guessing.

Values are throttled to one recomputation per **30 s** per agent+destination, and may be absent
on any given broadcast. Render the position regardless.

`GET /api/agent/shipments/:id/route` — the drawn route on your own delivery screen — is
**unchanged**, and remains the endpoint to use for the route line.

Detail: [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)

---

## 5 · Capacitor / WebView builds: the origins are finally applied

If this app is a **Capacitor or WebView wrapper** rather than a native client, read this
carefully — it is the single change that unblocks it.

`capacitor://localhost` and `https://localhost` had been **described in both services'
`.env.example` comments and missing from the values** for a long time. Since `.env.example` is
the deployment contract, every environment built from it refused those origins — the worse
failure mode, because an operator reading the template believed them set.

They are now in the **value** in both `jovi-mall/.env.example` and `geo-tracker/.env.example`,
and a test asserts the `ALLOWED_ORIGINS=` **line** rather than the surrounding comment (the
previous assertion passed on the prose, which is why this survived).

Two consequences:

- In **geo-tracker**, `ALLOWED_ORIGINS` drives **both** HTTP CORS **and** the WebSocket
  `CheckOrigin` — there is no separate WS setting. Until now a wrapped client could not open the
  tracking socket **at all**.
- The whole `/api/auth/mobile/*` bearer namespace, built specifically for a client that cannot
  use the cookie session, was unreachable from a wrapped build for the same reason.

**Do not try to solve a wrapped-client problem with a custom request header.** geo-tracker's
CORS request-header allowlist is closed — `Authorization`, `Content-Type`, `X-Request-Id`, and
nothing else — and it is closed on purpose: it is the reason mobile auth became a route
namespace instead of an `X-Client-Type` header. It is now pinned by a test.

Native clients (the Flutter HTTP client) are unaffected — CORS does not apply to them.

See [../auth/FRONTEND-CHANGELOG-mobile-auth.md](../auth/FRONTEND-CHANGELOG-mobile-auth.md) and
[../mobile-auth-backend-spec.md](../mobile-auth-backend-spec.md).

---

## 6 · Push notifications: the SDK moved under you, and the send path is unverified

`firebase-admin` went **13 → 14.2.0**, which **removed the legacy namespaced API outright**
(`admin.apps`, `admin.credential.cert`, `admin.storage()`, `admin.messaging()` and the
`admin.messaging.*` type namespace). The backend was migrated to the modular imports across
three files; the mapping is 1:1 and both the type checker and a runtime resolve confirm it.

⚠ **An actual FCM send has not been verified since the upgrade** — it needs real credentials and
a device, which the development machine does not have. The push path typechecks and the client
constructs; it has **not** been proven end to end.

**Action: test push registration and delivery on a real device before relying on it**, and
report back if a token registers but nothing arrives. See
[push-notifications.md](./push-notifications.md).

Node 22 is now a hard runtime requirement (firebase-admin 14 declares `engines: node >=22`), not
just a policy — irrelevant to the app, relevant if you run a local backend.

---

## 7 · Vehicle colours in existing data

`migrate:agent-vehicle-colors` normalised **8** agents' `vehicle_info.color` to the lowercase
vocabulary (`"Red"` → `"red"`, `"Gray"` → `"grey"`). The app already normalises on write; this
brought the rows already in the collection to the same convention.

**One value was deliberately left verbatim** (`"bleu"`). `color` is a documented convention with
an "another colour" escape hatch, not an enum — anything outside the vocabulary is preserved as
the agent typed it, because rewriting it would destroy what they reported. **Keep the
unknown-token fallback** in your picker and your display.

See [vehicle-profile.md](./vehicle-profile.md).

---

## 8 · Restart behaviour — relevant to a native connection pool

jovi-mall previously had **no** shutdown handling; a restart severed in-flight requests
mid-transaction. It now drains:

- an accepted request **completes** rather than truncating (budget: `SHUTDOWN_TIMEOUT_MS`,
  default **10 s**);
- idle keep-alive sockets are closed after **65 s**.

**For a native HTTP client with a connection pool:** keep the pool's idle timeout **below 65 s**,
or a reused socket will eventually hit `ECONNRESET`. Make sure a connection-level failure retries
rather than surfacing to the courier as a failed action — that is the difference between a
one-second hiccup during a deploy and a delivery step that appears to have failed.

Everything else — probes, rate limits, the frozen `GET /api/health`, token rotation, the
`sharp`/`nodemailer` upgrades, the migration backlog — is on
[../FRONTEND-CHANGELOG-phase-2-3.md](../FRONTEND-CHANGELOG-phase-2-3.md).
