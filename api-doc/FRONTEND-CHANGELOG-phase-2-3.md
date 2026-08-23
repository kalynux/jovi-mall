# Frontend changelog — Phase 2 (Deployability) and Phase 3 (Cross-service correctness)

What [`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md)
Phases **2** and **3** changed, written for the people who build against the API.

- **Written:** 2026-08-21
- **Phase 2 landed:** 2026-08-18 → 2026-08-19 · design record
  [`PHASE-2-DEPLOYABILITY-PLAN.md`](../../PRODUCTION-READINESS/PHASE-2-DEPLOYABILITY-PLAN.md)
- **Phase 3 landed:** 2026-08-19 · design record
  [`PHASE-3-CROSS-SERVICE-PLAN.md`](../../PRODUCTION-READINESS/PHASE-3-CROSS-SERVICE-PLAN.md)
- **Previous instalment:** [phase-d-0-1/](./phase-d-0-1/README.md) — Phases D · 0 · 1

> **This page is the cross-role half.** Everything here applies to every client of this
> backend. The parts that land on one screen live in that role's folder — see the index below.

---

## The one-paragraph version

**Phase 2 changed almost no wire contract and changed a great deal about how the backend
behaves around a restart.** It gave jovi-mall a graceful shutdown, put all three services in
containers with real liveness/readiness probes, built a migration ledger and applied the whole
15-migration backlog to the dev database, cleared the dependency backlog, and applied two config
values that had been documented-but-never-set — one of which is what makes a Capacitor-wrapped
dashboard able to reach the tracking socket at all.

**Phase 3 changed the tracking seam, and one of its changes is a correctness fix a shipped
client is probably getting wrong today.** A dropped tracking subscription now says *truthfully*
why it was dropped instead of always claiming the shipment completed; every watcher of a
delivery now gets an ETA instead of only customers whose client supplied a destination; and
lifecycle events can no longer be lost between a status transition and the event that tells
geo-tracker about it.

---

## Which document you read

| You build | Read | Then also |
|---|---|---|
| **Vendor dashboard** | [vendor/FRONTEND-CHANGELOG-phase-2-3.md](./vendor/FRONTEND-CHANGELOG-phase-2-3.md) | this page |
| **Agency dashboard** | [agency/FRONTEND-CHANGELOG-phase-2-3.md](./agency/FRONTEND-CHANGELOG-phase-2-3.md) | [geo-tracker](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md) — the live map changed |
| **Agency / agent mobile app** | [agent/FRONTEND-CHANGELOG-phase-2-3.md](./agent/FRONTEND-CHANGELOG-phase-2-3.md) | [geo-tracker](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md) |
| **Customer app** | [customer/FRONTEND-CHANGELOG-phase-2-3.md](./customer/FRONTEND-CHANGELOG-phase-2-3.md) | [geo-tracker](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md) — order tracking changed |
| **Marketing landing + shop** | [public/FRONTEND-CHANGELOG-phase-2-3.md](./public/FRONTEND-CHANGELOG-phase-2-3.md) | this page |
| **Admin dashboard** (wi-admin, `/api/v1/*`) | [`admin/docs/FRONTEND-CHANGELOG-phase-2-3.md`](../../admin/docs/FRONTEND-CHANGELOG-phase-2-3.md) | this page, for context only |
| **Any live-tracking client** | [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md) | — |

---

## 1 · The response envelope did not change

`{success, data, meta?, message?}` and `{success, requestId, error:{code, message, statusCode,
category, details?}}` are exactly as [README.md](./README.md) documents them. The nine-value
error taxonomy is unchanged. **No endpoint was renamed, removed or re-shaped in either phase.**

One route was **added**, and it is not for you:
`GET /api/internal/shipments/:shipmentId/destination` is service-token-only and exists so
geo-tracker can ask where a parcel is going. It refuses a user session. Documented at
[tracking/shipment-destination.md](./tracking/shipment-destination.md) for completeness.

---

## 2 · Behaviour around a deploy or a restart — this is new, and it is client-visible

jovi-mall previously had **no** shutdown handling: a restart severed in-flight requests
mid-transaction. It now drains.

| What | Value | What it means for your client |
|---|---|---|
| In-flight requests on shutdown | completed, not truncated | A request that was already accepted when a deploy started **finishes**. You will see a normal response, not a socket reset. |
| Drain budget | `SHUTDOWN_TIMEOUT_MS`, default **10 s** | A request still running after the budget is cut. Long uploads are the realistic case. |
| Idle keep-alive sockets | `keepAliveTimeout` **65 s** (`headersTimeout` 66 s) | The server closes an idle pooled connection after 65 s. A client HTTP agent with a **longer** idle timeout will eventually reuse a socket the server has closed and see `ECONNRESET`. Keep your agent's idle timeout **below 65 s**, or retry idempotent GETs once on a connection-level error. |
| New connections during drain | refused | Normal rolling-deploy behaviour: retry with backoff. |

**What to do:** nothing new for a browser. For a native/mobile HTTP client with a connection
pool, check the idle timeout, and make sure a connection-level failure retries rather than
surfacing as a user-visible error.

---

## 3 · Probes and status widgets

Three paths, three jobs. If you render a "system status" indicator anywhere, this is the table.

| Service | Liveness | Readiness | Notes |
|---|---|---|---|
| jovi-mall | `GET /api/health/live` | `GET /api/health/ready` | plus the **frozen** `GET /api/health` |
| wi-admin | `GET /health/live` | `GET /health/ready` | |
| geo-tracker | `GET /healthz` | `GET /readyz` | plus `GET /metrics` |

**`GET /api/health` is a frozen wire contract** — exact path, exact body `{status, timestamp}`,
**unconditional 200**, **no `{success, data}` envelope**, exempt from rate limiting and from
maintenance mode. It is now pinned by a test (`test:system`), not by a comment.

```json
{ "status": "ok", "timestamp": "2026-08-19T14:03:11.204Z" }
```

- Use it as *"is this process reachable"*. It is **not** a dependency check and will answer 200
  while Mongo is down.
- Use `/api/health/ready` for *"can it actually serve"* — it 503s when Mongo is unavailable
  (Redis being down does **not** fail readiness; Redis-backed features degrade individually).
- Do not build anything that assumes `/api/health` ever returns a non-200 or grows a field.
  geo-tracker treats any status >= 300 there as a failure of *its own* readiness.

Full detail: [health.md](./health.md) · [system-uptime-status.md](./system-uptime-status.md).

---

## 4 · Maintenance mode and rate-limit exemptions were frozen (not changed)

The lists were already there; Phase 2 pinned them with tests so they cannot be "tidied".
Nothing a browser or app calls gained or lost an exemption. Two things worth knowing:

- `/api/health`, `/api/health/ready`, `/api/internal/agents/*`, `/api/tracking/*` and (new)
  `/api/internal/shipments/*` stay reachable in **every** maintenance mode.
- The rate-limit exemption list is **narrower** than the maintenance list on purpose:
  `/api/tracking/agent-state` is exempt, `/api/tracking/visible-agents` is **not**. Neither is
  called by a browser client. Your limits are unchanged — see [rate-limits.md](./rate-limits.md).

---

## 5 · Sessions, tokens, and the one operational event that logs everybody out

Nothing about the auth contract changed in these phases. One operational fact is now
documented and worth designing for:

**Rotating `JWT_SECRET` invalidates every live access token, in both services, at once.**
Every HTTP call 401s until the client re-authenticates, and every live geo-tracker subscription
is dropped. Phase 3 made that drop *truthful* — it now reports `authorization_expired` instead
of claiming the shipment completed (§ 6).

Design implication: a 401 mid-session is a normal, occasional event. Refresh and retry; do not
treat it as a fatal state or as data loss. Browser clients refresh from the cookie inside an
ordinary request; bearer clients call `POST /api/auth/mobile/refresh`, which is deliberately
exempt from `readonly` maintenance so a maintenance window does not sign every native client
out. See [auth/README.md](./auth/README.md) and
[auth/FRONTEND-CHANGELOG-mobile-auth.md](./auth/FRONTEND-CHANGELOG-mobile-auth.md).

`geo-tracker` also now **refuses to boot** with `JWT_SECRET` unset (it previously started and
verified every token against the literal string `"secret"`). If your local tracking stops
working after a pull, check that `geo-tracker/.env` exists — the container will have exited
rather than come up insecure.

---

## 6 · Live tracking changed — the short version

Full detail in [`geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md`](../../geo-tracker/api-doc/FRONTEND-CHANGELOG-phase-2-3.md)
and, on this side, [tracking/live-tracking.md](./tracking/live-tracking.md).

1. **🔴 `permission_revoked.reason` is now a closed set of three.** It used to be the single
   literal `shipment_completed` for **all** outcomes, including "your token expired" and
   "jovi-mall was unreachable". A client acting on that string told users a delivery had
   finished because an access token aged out. Branch on the value; treat anything unrecognised
   as `authorization_expired` and report **no** delivery outcome.
2. **ETA now works for every watcher**, not only customers whose client sends a `destination`.
   geo-tracker pulls the parcel's geocoded drop-off from jovi-mall at session activation.
3. **`subscribe` gained an optional `shipmentId`** — send it when the agent may be running
   several deliveries, or you get no ETA rather than the wrong one.
4. ETA values are **throttled to one recomputation per 30 s** per agent+destination and may
   lag the position by that much. They can also be **absent** on any given broadcast; render
   without them.

---

## 7 · Data the dev database now holds that it did not before

Phase 2 built a migration ledger (`schema_migrations`) and applied the **entire 15-migration
backlog**. Six had real work to do. What a client can observe:

| Migration | What changed in the data |
|---|---|
| `backfill:shipment-tracking-numbers` | **25** legacy shipments that had `tracking_number: null` now carry one, generated from their own agency and creation time. Hand-typed carrier numbers were left alone. |
| `migrate:agent-vehicle-colors` | **8** agents' `vehicle_info.color` normalised to the lowercase vocabulary (`"Red"` → `"red"`). **One** off-vocabulary value (`"bleu"`) was deliberately left verbatim — the field is a convention with an "other colour" escape hatch, not an enum. Keep rendering unknown tokens. |
| `backfill:last-ordered` | `last_ordered_at` populated on **15** products and **11** variants. |
| `migrate:contract-terms` | **3** agency/agent contracts stamped with the negotiation fields. |
| `migrate:storefront-indexes` | Public catalog queries are indexed rather than collection-scanning. Performance only — no shape change. |
| `migrate:admin-order-indexes`, `migrate:cod-late-deposit-index` | 3 superseded indexes dropped. Performance only. |

The other nine were already no-ops here. Two results worth recording because they contradict the
pessimistic reading: `migrate:payment-indexes` found all five indexes already present (so webhook
dedup was never off), and `migrate:booking-rule-timezones` moved **zero** effective hours — all 37
rules already carried an explicit `Africa/Douala`.

⚠ **Do not remove your defensive handling of legacy shapes.** These migrations ran against the
**dev** database. There is no production database yet, and the ledger is forward-looking.

---

## 8 · Dependency upgrades you should re-test against

No API changed, but three runtime libraries moved under paths your screens exercise.

| Package | Move | Re-test |
|---|---|---|
| `sharp` | 0.34 → **0.35.3** | Every image upload + resize path: product images, store/agency logos and banners, avatars. |
| `nodemailer` | 7 → **9.0.5** | Any flow that ends in an email. |
| `firebase-admin` | 13 → **14.2.0** (removed the whole legacy namespaced API; migrated to modular imports) | **Push notifications.** ⚠ An actual FCM send is **unverified** — the code typechecks and the client constructs, but nothing has been delivered to a device since the upgrade. Treat push as needing an end-to-end test before you rely on it. |

Separately, a **live defect was found and fixed** while building the container image: `tsc`
emits no `.hbs` files, so **every templated email was broken under `npm start`** (i.e. in any
built/deployed environment — it worked in `npm run dev` only). Templates are now copied by the
build from a manifest that a test enforces. If you had written off transactional email as
flaky, retry it.

---

## 9 · Two config values that had never actually been applied

Both were **documented in the `.env.example` templates and absent from the values** — the worse
failure mode, because an operator reading the template believed them set.

**`ALLOWED_ORIGINS` now carries the Capacitor origins** (`capacitor://localhost`,
`https://localhost`) in **both** jovi-mall's and geo-tracker's templates. This is what makes a
Capacitor-wrapped dashboard work at all: in geo-tracker that one variable drives **both** HTTP
CORS **and** the WebSocket `CheckOrigin` — there is no separate WS setting — so until it was set,
a wrapped client could not open a tracking socket, and the entire `/api/auth/mobile/*` namespace
built for it was unreachable in any environment built from the template.

**`BOT_WEBHOOK_SECRET` is now set.** The messaging-bot webhooks (`/connect`, the passwordless
customer login path) now require an `X-Webhook-Secret` header **in development too** — they used
to be open locally and fail-closed only in production. The n8n side must send the same value or
`/connect` answers **401** and mints no codes. This affects customer sign-in; see
[customer/FRONTEND-CHANGELOG-phase-2-3.md](./customer/FRONTEND-CHANGELOG-phase-2-3.md).

---

## 10 · Reliability changes you will feel rather than call

Phase 3 Part A moved the tracking outbox **inside** the database transaction that causes it.
Nine write sites, one shared emitter, and the event bus is out of that path entirely.

**What this fixes, from a screen's point of view:**

- A shipment status transition and the event that tells geo-tracker about it now **succeed or
  fail together**. Previously a crash in the window between them lost the event permanently:
  a delivered shipment whose agent kept being broadcast, or an accepted offer whose tracking
  session never opened.
- 🔴 **The auto-confirm sweep never emitted anything, ever.** A prepaid delivery the customer
  never confirmed was auto-confirmed to `delivered` — a terminal status — and geo-tracker was
  never told. The tracking session stayed open until its TTL. Fixed. This was invisible in
  testing and routine in production, because it is the path taken by exactly the least-engaged
  customers.
- 🔴 **Offer-accept was severed and restored inside the same phase.** The row that *opens* a
  tracking session comes from `ShipmentAssignmentService.accept()`; it is now the ninth
  transactional write site. Nothing shipped broken, but it is the highest-consequence row in
  the contract and is now pinned by `test:tracking-outbox`.

**One new failure mode, and it is the correct one:** because the event is written inside the
transaction, a failure to write it now **rolls the transition back**. Your call returns an
error and the status did **not** change. Retry it. Previously the transition would have
succeeded and the event silently vanished — a worse outcome that looked like success.

`409 SHIPMENT_STATUS_CONFLICT` (the from-status compare-and-set, pre-existing) is unchanged:
re-read the shipment and re-render, do not blind-retry.

**Tracking Allow gained a reconciliation backstop.** An administrator revoking an agent's
tracking permission is pushed to geo-tracker transactionally, and a new worker re-pushes every
revoked agent every **15 minutes** as a backstop. So a revocation converges within 15 minutes
even if its event is lost. It is a backstop, not the delivery mechanism.

---

## 11 · What did NOT change, and should not be "fixed"

- **The forwarded-token refresh asymmetry.** geo-tracker forwards a bearer token and has no
  access to jovi-mall's refresh cookie, so an expired token drops the subscription. This is
  deliberate (register question Q-3). Phase 3 fixed the *explanation*, not the asymmetry.
  **Reconnect with a fresh token on a cadence shorter than the 15-minute access TTL.**
- **There is no connect/handshake ack frame on the tracking socket**, and none was added. A
  proposal to hang an `expiresAt` on one was examined and rejected: it would have meant
  inventing a fifth server→client frame type that clients switching exhaustively on `type`
  would reject. Do not wait for a frame at handshake.
- **geo-tracker's CORS request-header allowlist is closed** — `Authorization`, `Content-Type`,
  `X-Request-Id`, and nothing else. Do not add a custom request header to a geo-tracker call;
  it will be refused, and widening the list is a two-repo change that was deliberately avoided
  once already (it is why mobile auth got its own route namespace instead of an
  `X-Client-Type` header).
- **`GET /api/health`'s shape.** See § 3.
- **wi-admin still has no data door into geo-tracker.** Administrators get no live position, no
  trail and no ETA. Phase 3 did not change this.

---

## 12 · Cross-repository contracts that are enforced by nothing but this paragraph

Phase 3 Part D audited the contract-enforcement story and found that **neither CI workflow in
this workspace had ever executed a single assertion** — one died on a missing secret, the other
on a heap OOM, both silently. That is fixed. Two contracts, though, reach repositories that are
not in this workspace, and **a change on the frontend side is caught by nothing**:

| Contract | This side | Your side | Who |
|---|---|---|---|
| Chat formatter output (`descriptionRich`) | `test:rich-description` asserts the WhatsApp and Telegram strings **byte-for-byte** | `tools/richtext/` and its `fixtures.ts` | **Vendor dashboard** |
| Blog block-type union | `blog/validators/article-body.validator.ts` — a `z.discriminatedUnion('type', …)` over nine block types | `ArticleBody.tsx` switches the same union **exhaustively** | **Marketing site** |

If you own either, read your role's document — each carries the manual step and, for the blog
union, the **ordering rule** (the reader ships first).

---

## 13 · Where the authoritative detail lives

| Topic | Document |
|---|---|
| Health probes, the frozen contract, metrics | [health.md](./health.md) |
| Rate limits | [rate-limits.md](./rate-limits.md) |
| Live tracking — jovi-mall side | [tracking/live-tracking.md](./tracking/live-tracking.md) |
| Tracking authorization policy | [tracking/agent-tracking-policy.md](./tracking/agent-tracking-policy.md) |
| The drop-off pull (service-to-service) | [tracking/shipment-destination.md](./tracking/shipment-destination.md) |
| The tracking WebSocket | [`geo-tracker/api-doc/tracking-websocket.md`](../../geo-tracker/api-doc/tracking-websocket.md) |
| ETA and its throttle | [`geo-tracker/api-doc/routing.md`](../../geo-tracker/api-doc/routing.md) |
| Deploy, rollback, secret rotation | [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md) |
| Release shape (containers, Node 22, one host) | [`docs/ADR-019-RELEASE-SHAPE.md`](../../docs/ADR-019-RELEASE-SHAPE.md) |
