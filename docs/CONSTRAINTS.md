# jovi-mall — implementation constraints

**The things that look like improvements and are not.**

Every entry here is a rule whose *obvious* refactor is the bug. They are collected in one place
because they share a property: **each is invisible to the type system**, and most are invisible to
the 68 runnable suites as well — so the only thing standing between the codebase and the regression
is somebody having read this.

Read from source 2026-09-06.

---

## 1 · Ownership — what this service must never give away, and never take

**If it needs the shipment/order model, it belongs here. If it needs a live position or a road
network, it belongs in geo-tracker.** When in doubt, ask which service would have to grow a copy of
the other's data — that one is wrong.

jovi-mall owns tracking **policy**; geo-tracker owns tracking **mechanics**.

- ✅ The visibility rule (`tracking-integration/services/visible-agents.service.ts`) is **ours**,
  and is asked *as the viewer*.
- ✅ Trackable / terminal verdicts are computed here, from `TRACKABLE_SHIPMENT_STATUSES`, and pushed.
- ⛔ **Never reimplement a role or visibility rule in Go.**
- ⛔ **Never let geo-tracker hold a shipment's status.** It holds the *id* and our *verdicts*. A
  status list crossing that boundary turns every status addition into a two-repo change.

⚠ **The corollary that gets forgotten: a jovi-mall-only status change is possible, and `handing_over`
is the proof.** It was added here and geo-tracker was not touched, precisely because the seam
carries verdicts rather than statuses. If a change forces a geo-tracker edit, check first whether the
seam has been widened by accident.

⚠ **Address resolution *for the order and profile model* is ours alone — that is narrower than
"geocoding is ours".** geo-tracker exposes `GET /routing/geocode` and `/routing/reverse-geocode`
against its live provider; a dashboard already authenticated to it may legitimately use them. The
broader claim was false and was corrected on 2026-09-06 (DOC-PROGRAM F-1).

---

## 2 · The frozen contract

⛔ **`GET /api/health` must keep its exact path, its exact body and its unconditional 200.**

geo-tracker's `NodeAPIChecker` points at it and is registered as a **readiness** checker on
`/readyz`, and its client treats **any status ≥ 300 as an error**. So:

> putting readiness semantics on that path means a jovi-mall Redis wobble 503s geo-tracker's
> `/readyz`, the orchestrator pulls geo-tracker out of rotation, and **every live WebSocket tracking
> session dies** — for a fault in a different service that is itself healthy.

Readiness went on `/api/health/ready` instead, which is deliberately **not** a dependency of
geo-tracker: the reverse already holds, and making it mutual deadlocks a cold start of both.
(ADR-014 D-1.)

Two consequences that look unrelated and are the same rule:

- **`/api/health` is exempt from rate limiting.** A 429 there does the same thing a 503 does.
- **geo-tracker's `/webhooks/*` are exempt from *its* limiter**, because a 429 to our dispatcher
  delays a permission revocation.

---

## 3 · Fail OPEN or fail CLOSED — and they are not a style choice

The most common wrong instinct in this codebase is to make these consistent. **They are
deliberately inconsistent**, and the rule that produces the split is: *fail closed when the thing
being guarded is disclosure or money; fail open when the guard's own dependency being down would
cause a bigger outage than the thing it guards against.*

| Mechanism | Posture | Why the other way round is worse |
|---|---|---|
| `JWT_SECRET` unset | **CLOSED** — refuses to boot | a service signing with a default secret is a forgeable one |
| the environment validator | **CLOSED** on provable faults | a silently-substituted default runs for months |
| the rate-limit store (Redis down) | **OPEN** | `rate-limit-redis` *rejects*, and express-rate-limit turns that into a **500 on every request** — a single point of failure in front of every route |
| the worker overlap lock (Redis down) | **OPEN** | failing closed silently stops every sweep in the platform, including the two that move money, with no symptom but work not happening |
| maintenance mode | **OPEN** | **a maintenance window nobody can exit is worse than one that leaks a request** — the operator door may be part of what is down |
| the calendar-sync lock | **OPEN** | one optional integration must not gate a boot |
| the geo-tracker routing call | **degrades** — returns `null` | see § 6 |
| a live-position read's audit row (wi-admin side) | **CLOSED** | the row commits *before* the read, so with the audit store down nothing is disclosed |

⛔ **Do not "harmonise" this table.** Every row's posture is a consequence of what it guards, and a
consistent answer is wrong for half of them.

---

## 4 · Errors, events and money

| ⛔ Do not | Because |
|---|---|
| `throw new Error()` or `res.status().json({ error })` | ESLint bans both — and the `res.json` selector matches `error` **anywhere** in the literal, which is how eight hand-rolled error responses had accumulated |
| **annotate** a category at the throw site | it is derived from `(code, statusCode)`; the same code is raised at different statuses at different sites, so an annotation is wrong at one of them |
| filter an error message at the throw site | filtering is at the **boundary**, keyed on category, in **every** environment. That is what closed the leaks without editing the call sites that could produce them |
| collapse the `400`/`422` split | `400` is a schema failure and `422` is a business rule; 136 and 139 call sites already depend on it and the category derivation reads it |
| add a persisted log field in one place | `core/logging/log-record.ts` assigns **by name** — a new field must be added there, **in the sink, AND in `log-query.service.ts`'s `toRecord`**. Miss one and the data is written and silently dropped on read |
| put money on the **event bus** | it is lossy by construction: a handler that throws is counted, logged and **skipped**, and there is no retry and no persistence |
| put a new consumer on the bus without deciding | there are two lists — recoverable (has a sweep) and not (has nothing). "The money is fine" is true **and does not transfer** |
| build a permission system here | the 116 granular permissions live in wi-admin. A second one drifts from the first |
| read `X-Actor-Tier` for a decision | the token authenticating that call is a full-privilege credential; anyone holding it could set the header. Enforcing on it is theatre |

⛔ **`bot-surface` composes rules; it never owns one.** A business rule that exists only under
`/api/internal/bot/*` is in the wrong module.

---

## 5 · Data

| ⛔ Do not | Because |
|---|---|
| add a Mongoose model for `system_logs` | `autoIndex` would create the collection **UNCAPPED** before the sink's `createCollection` runs, and the log store would grow with no ceiling. `MODELS.SYSTEM_LOG` existing unused is the deliberate half-measure |
| add `.populate()` on an actor (`*_by*`) field | ids written through the wi-admin door resolve to **nothing** in this database. 13 populate sites, none of them touch one, and that is what makes the door safe. Use `*_source` + `*_name` instead |
| treat `admin_action_log` as the compliance record | its TTL is **unconditional**; wi-admin's is partial and export-gated. This one is a stop-gap in a database wi-admin does not own |
| tidy away one of the two `occurred_at` indexes | Mongo will not drive a TTL off the compound index |
| claim a Redis DB below 5 | **wi-admin owns 1/2/3**, and a developer machine runs one Redis for both services |
| close the 4 / 9 gap | they are **retired, not free**. Reading a pre-cutover verification code back as something else is a security incident; two unused integers cost nothing |
| add a twelfth logical Redis database | the ceiling is 16 and startup-only, wi-admin holds three, and **two DBs already hold two things each behind prefixes** as a stated concession. There is no third pairing available |
| write a data backfill | pre-production rule **D-5**: dev data is disposable. Index migrations only — fix the **seed** |
| add a `down` migration | forward-only, by decision. A down migration for a backfill is a fiction; every migration is idempotent, so the correction for a bad one is another one |
| `create(doc, { session })` | Mongoose reads `{ session }` **only** when the first argument is an **array**. The non-array form writes outside the transaction and produces an outbox that *looks* transactional and is not |

---

## 6 · The degradation contract

**Deliveries work when geo-tracker is down, and they must keep working.** geo-tracker must never be
on the critical path for a business action.

When `POST /routing/matrix` fails, `GeoRoutingClient` returns **`null`** and auto-assignment ranks
by the **haversine ordering it already computed**. That is the designed degradation.

⚠ **This decision has a mirror on the other side, and the two are load-bearing together.**
geo-tracker's routing chain deliberately contains **no straight-line provider** — precisely because
this local fallback exists. Adding one there would make a straight-line answer indistinguishable
from a road-network one at the caller, and put a guessed ETA in front of a customer waiting for a
delivery.

⛔ **So if this local fallback is ever removed, geo-tracker's chain has to be revisited in the same
change.** Removing one half silently converts a designed degradation into a guess.

Two more inert-by-design states that are **not** bugs:

- **`GEO_TRACKER_BASE_URL` unset** → the outbox accumulates and nothing dispatches. The intended
  local default.
- **`NODE_API_SERVICE_TOKEN` unset on geo-tracker's side** → the tracking-state reverse channel does
  nothing. The lifecycle still runs and records history.

---

## 7 · Things that have been reported as defects and are not

Each of these has been filed at least once. Check here before filing again.

| Looks like | Is |
|---|---|
| `POST /api/payments/initiate` and `/verify` are unauthenticated | **by design** — a mother orders and a son pays; the payment link is meant to be shareable. Filed as F-C and withdrawn |
| geo-tracker forwards a token it cannot silently refresh | **deliberate**, on the do-not-fix list as Q-3. The client reconnects with a fresh token. Only the *misleading explanation* was a defect, and that is closed — the drop now reports `authorization_expired`, not `shipment_completed` |
| a newly-authorised viewer is refused for up to `PERMISSION_CACHE_TTL` | **deliberate asymmetry**: revocation is pushed, grants are not. The leak direction gets the push; the inconvenience direction does not |
| an opted-in agent with no delivery is locatable | **by design** — that is exactly how the platform finds the agent nearest a pickup. Locatable ≠ tracked |
| `EMAIL_VERIFY_DB = 3` collides with wi-admin | **known and left alone** — both are exact-gets, nothing reads the other's keys, and moving it invalidates every verification link in flight |
| the `unhandled` event-bus label is firing | **21 event types currently have no subscriber**, mostly as a consequence of moving money off the bus. Filed as DOC-PROGRAM P-10; not lost money |

---

## 8 · Known-open implementation problems

**Documented, not fixed.** This program changes no behaviour; these are recorded so the next person
does not rediscover them as surprises.

| Problem | Where |
|---|---|
| the **stock commit is a silent no-op** under the conditions the customer seed reproduces | `orders/services/order-stock.service.ts` |
| the **storage capability matrix is inverted** — local streams, Firebase and Cloudinary do not — so digital download and delivery proof break on those providers; the production provider is still undecided | `core/storage/providers/` |
| `agent-trust-recompute` is a **shadow** worker: it writes `trust_signals.composite_score` and never `cod.trust_score`, which `CodTrustService.applyEvent` still owns | `agents/workers/agent-trust-recompute.worker.ts` |
| the digital-delivery **grant failure whose root cause is still unknown** (the two blockers found on 2026-08-27 are fixed; the underlying cause is not identified) | `modules/digital-delivery/` |
| **strict E.164 locks legacy `login_phone` rows out of phone login** until a migration exists — and D-5 forbids writing one pre-production | `core/validation/phone.ts` |
