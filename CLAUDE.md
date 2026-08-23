# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> ## ⚠️ Agent-contract refactor — one item left, and it is a decision
>
> The COD **shared-pool** model, the contract lifecycle, negotiated terms, agent
> earnings on **both** payment methods, and every admin/agent controller are built,
> reachable and live. The old independent per-agency cap
> (`cod.max_exposure_override`) is gone from the model, and **nothing below still
> describes the pre-refactor model**.
>
> 1. ⛔ **The trust composite is BUILT but runs in SHADOW, and that is deliberate.**
>    `AgentTrustService` and `AgentTrustRecomputeWorker` compute the five-factor score
>    nightly and write `trust_signals.composite_score` **only**;
>    `CodTrustService.applyEvent` is still the sole writer of `cod.trust_score`, the
>    number `CodExposureService` turns into an agent's cash limit. See
>    [§ Agent trust score](#agent-trust-score-live-vs-shadow) for the two blockers
>    holding the flip and where the decision is recorded. **This is the only item
>    still open, and it is blocked on a product decision (O-7) plus rating data that
>    does not exist yet — not on anybody writing code.**
> 2. ✅ **The collection rename and the `cod.outstanding_balance` backfill are
>    CLOSED as not applicable pre-production** (owner decision D-5, 2026-08-21) —
>    not forgotten. The code has been post-rename since before the decision;
>    `agent_agency_memberships` appears nowhere in `src/`. The reasoning is in the
>    handoff doc's § "Not built at all".
> 3. ✅ **Both verification items are BUILT — 2026-08-23.** The 7 scenarios including
>    the concurrent-allocation race are `npm run verify:agent-contract` (**66**), and
>    the 8-step E2E is `npm run verify:agent-e2e` (**55**). Both need Mongo as a
>    replica set. `npm run test:agent-domain` (211) is still DB-free by construction
>    and still covers neither — that is what these two are for.
>
>    ⚠ **They found two live defects on their first run**, both on the order path and
>    both silent: the stock commit was a no-op (an `$inc` smuggled through a `$set`
>    builder behind an `as any`, so **no sale ever decremented stock**), and
>    `markProductsOrdered` threw a BSONError on every paid order because
>    `OrderRepository.findById` populates `items.product_id`. Both are fixed. That is
>    the argument for these two suites in one sentence.
>
> **Read [AGENT-CONTRACT-REFACTOR.md](./AGENT-CONTRACT-REFACTOR.md) before touching
> `src/modules/agents/`, `src/modules/cod/`, or
> `src/modules/shipments/shipment.service.ts`.** It lists what is built, what is not,
> the decisions already settled with the product owner, and the order to finish in.
> **Delete this banner when item 1 closes** — not before, and do not delete it in
> exchange for a sentence somewhere else.

## Commands

```bash
npm run dev          # Start dev server with hot reload (ts-node-dev) — :8022 by default
npm run build        # tsc → dist/, THEN copy-build-assets.ts. Both halves are required
npm run start        # Run compiled server (production)
npm run lint         # ESLint with zero warnings allowed
```

⚠ **`npm run build` is `tsc` plus an asset copy, and the second half is not decoration.**
`tsc` emits `.js` and — via `resolveJsonModule` — imported `.json`, and **nothing else**. So
anything read off disk at runtime through a `__dirname`-relative path lives in `src/` and never
reaches `dist/`, which makes the two run paths silently disagree: `npm run dev` resolves it,
`npm start` and every container image do not.

That was not hypothetical. `mail.service.ts` reads `__dirname/templates/<name>.hbs` and the six
Handlebars templates were **never** in `dist/` — welcome, verify-email, reset-password and the
three notification digests all threw `MAIL_TEMPLATE_NOT_FOUND` in any deployment running the
compiled output. It survived because development never runs the build and CI type-checks without
ever building; containerising the service is what surfaced it.

`scripts/copy-build-assets.ts` copies them from an **explicit manifest** (a glob was rejected —
`src/` also holds READMEs and a test PDF, none of which belong in a runtime image), and
`test:system` scans `src/` for asset extensions and fails if one is neither in the manifest nor
in its ignore list. Adding a `.hbs`/`.sql`/`.yaml` under `src/` means adding it there.

### Containers

`Dockerfile` has three targets — `builder` · `toolbox` · `runtime` — on `node:22-bookworm-slim`.
Node 22 is pinned in **three** places that must agree (`engines`, the Dockerfile `FROM`, CI's
`NODE_VERSION`); `firebase-admin@14` requires `>=22`, so it is a runtime constraint and not only
policy. Read the Dockerfile's header before editing it — every rule in it has a reason written out.

**`toolbox` is the only image that can run a migration**, and it exists because the runtime one
structurally cannot: `scripts/` is never compiled and `ts-node` is a devDependency, so
`npm ci --omit=dev` produces an image with no way to run any of the twenty. Migrations go
`docker compose run --rm jovi-mall-toolbox npm run migrate:up`.

⚠ **`node_modules` and `storage/` are in `.dockerignore`, and both are correctness.** `bcrypt`
and `sharp` resolve platform binaries at install time, so a `node_modules/` built on this Windows
machine carries `@img/sharp-win32-x64` and produces a container that installs cleanly then throws
at the first hash or resize — `npm ci` runs inside the image for exactly that reason. `storage/`
is 112 MB of real uploads that belong in a named volume (D-6), never an image layer.

Data/ops scripts (all `ts-node scripts/…`, and `src/scripts/**` is ESLint-ignored):

**Run migrations through the runner, not the individual bindings.** `npm run migrate:status` and
`npm run migrate:up` are the front door; the individual bindings still work and are what the
runner spawns, but only the runner writes the ledger. See "The migration ledger" below.

```bash
npm run migrate:status                   # each of the 20: applied / not applied / applied-but-changed
npm run migrate:up                       # apply everything unapplied, in the declared order, ledgered
npm run migrate:up -- --dry-run          # rehearse all 20; write nothing, ledger nothing
npm run migrate:up -- --only migrate:storefront-indexes
npm run aggregate:analytics              # Populate vendor analytics data
npm run backfill:last-ordered            # Backfill last-ordered-at (idempotent, --dry-run)
npm run backfill:pickup-locations        # Backfill pickup locations (idempotent, --dry-run)
npm run backfill:shipment-tracking-numbers  # Stamp legacy shipments (idempotent, --dry-run)
npm run migrate:customer-payment-methods # → user_payment_methods (idempotent, --dry-run)
                                         # ⚠ migrate:agent-memberships is GONE (2026-08-23) — it
                                         # wrote the retired status literal `approved`, so its
                                         # create would have thrown; deleted rather than repaired
                                         # because D-5 leaves it no rows to carry
npm run migrate:agent-deposits           # backfill deposit status/recipient (idempotent, --dry-run)
npm run migrate:contract-terms           # terms_proposed_by/terms_version (idempotent, --dry-run)
npm run migrate:cod-late-deposit-index   # DROP the agent-scoped late_deposit index (--dry-run)
npm run migrate:agent-vehicle-colors     # normalize vehicle_info.color to the palette; reports
                                         # every off-vocabulary value (idempotent, --dry-run)
npm run migrate:drop-agent-invites       # ⚠ the ONLY DESTRUCTIVE one: DROPS agent_invites, the
                                         # orphan of the deleted email-invite subsystem. Reads and
                                         # prints (count, indexes, by-status, newest) before it
                                         # drops; a no-op once gone (idempotent, --dry-run)
npm run migrate:booking-rule-timezones   # clear the legacy 'UTC' default off availability rules so
                                         # they inherit the vendor's zone; reports every rule whose
                                         # effective hours would move (idempotent, --dry-run)
npm run migrate:inventory-indexes        # the agency stock-movement + storage-invoice indexes.
                                         # Two of them are correctness: one stops a retried payment
                                         # webhook selling a depot shelf twice, the other stops the
                                         # monthly storage run issuing two statements for one month
                                         # (idempotent, --dry-run)
npm run migrate:storefront-indexes       # build the public-catalog indexes, incl. the ONE $text
                                         # index in this codebase. autoIndex builds them too, but
                                         # silently — a failed build leaves every storefront request
                                         # scanning the collection (idempotent, --dry-run)
npm run migrate:payment-indexes          # build the Phase 1 payment indexes: the UNIQUE
                                         # (gateway, eventId) webhook dedup + its 45-day TTL, and
                                         # the sparse-unique merchant_ref on payment_transactions,
                                         # plan_purchases and credit_topups. Same autoIndex-fails-
                                         # silently argument as above, except here the silent
                                         # failure disables replay protection entirely
                                         # (idempotent, --dry-run)
npm run audit:stuck-payments             # READ-ONLY: how much money sits in payments that never
                                         # closed — the backlog from before the reconciliation
                                         # worker. Fixes nothing, deliberately [-- --days=90 --json]
npm run seed:tickets [-- --clean]        # also: seed:plans, seed:cod [-- --clean]
npm run seed:blog                        # the house byline ONLY — no articles, deliberately
npm run seed:cod-shipments [-- --clean]  # 7 COD shipments across the lifecycle, on the
                                         # EXISTING agency b0…05 + agent b0…06, with real
                                         # geocoded Douala pickup/drop-off addresses
npm run simulate:notifications
```

No test *framework* is configured. Tests are plain ts-node scripts under `scripts/test/` with
hand-rolled asserts — follow that convention rather than introducing a runner:

```bash
npm run test:agent-domain                      # agent domain (211 assertions, no DB needed)
npm run verify:agent-contract                  # the seven invariants the refactor locked, against
                                               # real Mongo (66) — NEEDS a REPLICA SET. Its subject
                                               # is everything test:agent-domain structurally cannot
                                               # see: every guard here is enforced by a QUERY FILTER
                                               # rather than an `if`, and a DB-free stub cannot fail
                                               # a filter. The concurrent-allocation race (10
                                               # simultaneous reservations against a cap of 3 admit
                                               # exactly 3), the §1 worked example with its numbers
                                               # (three agencies wanting 1M each out of one 1M pool),
                                               # a threshold below the cash already held, the cash
                                               # chain's two exact invariants (balance == Σ ledger;
                                               # Σ slices == pot) incl. that a REFUSED debit leaves
                                               # no ledger row, the settlement-vs-deactivation RACE
                                               # (request raised clear, cash collected, approval
                                               # refused), pausing not freeing the pool, and
                                               # ban-as-override-not-cascade
npm run verify:agent-e2e                       # one COD delivery end to end (55) — NEEDS a REPLICA
                                               # SET. Contract formation → checkout → offer/accept →
                                               # transit → the delivery code → the hand-over →
                                               # capacity + the terminal tracking verdict → clean
                                               # termination, through the REAL services. It builds
                                               # its own world under `e2eac…` and deletes it, so it
                                               # touches no real agency or agent. Its value is the
                                               # CHAIN: it pins that for a COD delivery the terminal
                                               # verdict rides `cod.collection.recorded` and NOT
                                               # `shipment.status_changed` — a geo-tracker author
                                               # closing sessions only on the latter would leave
                                               # every COD session open forever, with no symptom on
                                               # this side at all. It found two live silent defects
                                               # on its first run (the stock-commit no-op and the
                                               # markProductsOrdered BSONError)
npm run test:agent-trust                       # the trust composite and its nightly worker (35, no
                                               # DB) — incl. the SOURCE SCAN that keeps the shadow a
                                               # shadow: the worker must not write cod.trust_score
npm run test:agent-shipment-status             # the shared transition map, the map↔schema drift
                                               # guard, and the agency notification catalog's
                                               # five-language completeness (32, no DB needed)
npm run test:earnings-quote                    # the delivery-fee arithmetic (29, no DB needed)
npm run test:pickup-depot                      # the agency-depot pickup location (44, no DB needed)
npm run test:agency-inventory                  # the agency stored-SKU roster AND its counted
                                               # stock (99, no DB) — the movement deltas, the
                                               # asymmetric non-negative rule, an idempotent replayed
                                               # sale, drift-vs-ledger, and SOURCE SCANS for the two
                                               # invariants nothing behavioural can see: only the two
                                               # repositories write the counters, and nothing in the
                                               # storage-invoice path moves money
npm run test:vehicle-profile                   # vehicle colour + photo merge (31, no DB needed)
npm run test:payout-methods                    # the shared payout schema + switch (53, no DB needed)
npm run test:booking-availability               # booking windows/timezones/seats (54, no DB needed)
npm run test:customer-notifications             # customer catalog + balance settlement (30, no DB needed)
npm run test:blog                              # article blocks, slug keys, DTO projection (91, no DB
                                               # needed). Includes the CROSS-REPO fixture list that
                                               # wi-admin's test:content mirrors byte-for-byte — the
                                               # block union lives in both repos with no shared
                                               # package, and that list is what keeps them in step
npm run test:rich-description                  # structured descriptions (149, no DB) — the WhatsApp and
                                               # Telegram formatters asserted against the vendor
                                               # dashboard's OWN fixtures byte-for-byte (two repos, no
                                               # shared package), the href scheme allowlist, the
                                               # null-clears semantics against a fake repository, and
                                               # source scans proving the field reaches all four write
                                               # endpoints while staying OUT of the $text index, the
                                               # vectoriser payload and every public DTO
npm run test:public-catalog                    # the storefront's visibility rules and projections
                                               # (86, no DB). Its core is a set of LEAK assertions:
                                               # DTOs are built from documents carrying vendorId,
                                               # suspension notes, pickup address ids and
                                               # vectorisation state, and the serialised output is
                                               # asserted to contain none of it. /api/public/* has no
                                               # auth guard, so those projections ARE the access
                                               # control.
npm run test:reviews                           # reviews & ratings (62, no DB) — the target matrix
                                               # (which aggregates one review moves, and why an
                                               # agency's review never moves its OWN score), the
                                               # publish-vs-hold rule, LEAK assertions that a public
                                               # review carries no author identity, and SOURCE SCANS
                                               # for the invariants no behavioural test can see:
                                               # exactly one writer of `review_aggregates`, the trust
                                               # collector as its only reader, a compare-and-set on
                                               # the moderation verdict, and no public route to a
                                               # delivery review
npm run test:customer-order-detail             # the customer's view of a parcel (46, no DB) — the
                                               # ADR-A06 agent-disclosure window as a TOTAL table over
                                               # all eleven shipment statuses, the partial-name
                                               # reducer, and SOURCE SCANS for the two rules nothing
                                               # behavioural can see: an agent outside the window is
                                               # never LOOKED UP (so there is nothing to leak), and
                                               # the stored full name never reaches the DTO. Its
                                               # second half pins the 2dsphere null-`location` rule
                                               # across all THREE models that carry it — the defect
                                               # that made "add a second saved address" impossible
npm run test:storefront-checkout               # stock semantics + the cart write contract (50, no DB).
                                               # Largely a SOURCE SCAN, because the invariant that
                                               # matters is structural: reserve writes no stock,
                                               # commit writes it once, release writes none. A
                                               # regression is invisible to every other test — orders
                                               # still work and stock just quietly drains.
npm run test:bargain-price                     # bargainable pricing (145, no DB) — the Zod fragment on
                                               # all four schemas, the pure rule's whole decision table,
                                               # the `bargainable` derivation, the repository's update
                                               # operators, and a SOURCE SCAN proving the rule is called
                                               # BEFORE the stock gate and the file reconcile, and that
                                               # cart/orders/earnings/cod/shipments never mention it
npm run test:connections                       # the unified messaging-connection domain (100, no DB) —
                                               # the 6-char code's alphabet and unbiased sampling, the
                                               # normalizer's FIXED-POINT property (a generated code can
                                               # never contain a glyph it rewrites, so it cannot collapse
                                               # two live codes), a LEAK assertion that no DTO ever emits
                                               # an external_id, and three SOURCE SCANS: the redeem route
                                               # is under /api/me and NOT the rate-limit-exempt
                                               # /api/webhooks, the store claims with SET NX and spends
                                               # with an atomic Lua script, and no `wa` sub-document /
                                               # telegram_links / wa_verify reference survives anywhere.
                                               # Its scans strip COMMENTS first — the tombstones that
                                               # explain what was deleted are the most useful thing in
                                               # that diff, and a scan that forces their removal has made
                                               # the codebase worse
npm run test:password-epoch                    # password-change revocation: the iat-vs-epoch
                                               # predicate, the whole-second boundary that keeps the
                                               # caller's own replacement token valid, and a source
                                               # scan proving BOTH credential paths call it (25, no DB)
npm run test:uploads                           # the virus scanner and the private storage trees
                                               # (73, no DB — the clamd group talks to a FAKE daemon
                                               # on a loopback socket). Its spine is SOURCE SCANS,
                                               # because both findings it guards are wiring rather
                                               # than logic and a regression is invisible elsewhere:
                                               # no file may construct a scanner directly (the
                                               # factory is the only door), no upload config may
                                               # hardcode a `provider:` (four of five did, so three
                                               # live paths took a test double), no express.static
                                               # may reach a private tree, and no file may build a
                                               # FileDetail by hand (three did, so the "single choke
                                               # point" for the public/authorized URL split was not
                                               # one). Plus the clamd wire protocol against real
                                               # bytes — NUL-terminated AND newline-terminated
                                               # replies, an ERROR reply, the multi-chunk framing
                                               # reassembled and compared, and the timeout. That
                                               # group exists because a live EICAR check found a bug
                                               # every source scan had passed
npm run test:mobile-auth                       # bearer auth for cookie-less clients (103, no DB) —
                                               # the /auth/mobile/* namespace, the token envelope,
                                               # the two /api/auth rate-limit buckets, and the
                                               # Capacitor origin rule. Three of its groups are
                                               # SOURCE SCANS, because the invariants are structural
                                               # and a regression is invisible elsewhere: the mobile
                                               # controller must set no cookie, the credential bucket
                                               # must stay the DEFAULT under /api/auth, and — the
                                               # load-bearing one — requireAuth's silent refresh must
                                               # stay ASYMMETRIC. It fires on a cookie or on no
                                               # credential at all (the ordinary browser path past 15
                                               # minutes, and the Flutter agent app's fallback) and
                                               # never on an expired bearer. Tidying those two
                                               # branches into symmetry signs out every browser.
npm run test:messaging-login                   # bot sign-in + reset (158, no DB) — the 8-char code,
                                               # the opaque link token, and the whole store driven
                                               # against a FAKE REDIS, so mutual-kill and expiry are
                                               # real assertions rather than source scans. Its two
                                               # highest-value cases: the Telegram contact guard with
                                               # a forwarded-contact fixture asserted REFUSED, and a
                                               # BARE-DIGITS wa_phone_id resolving an account stored
                                               # as +237… — the silent failure that reports "no
                                               # account" to everybody while every other test passes.
                                               # Plus LEAK assertions (no credential in a result
                                               # field, a key name or a log line) and SOURCE SCANS
                                               # (routes under /api/auth, identity from the context,
                                               # link from STOREFRONT_URL). Also covers
                                               # /reset-password: that it serves vendor, agency and
                                               # agent where /login refuses them, and that it mints
                                               # through the EXISTING PasswordResetService rather
                                               # than a second token store
npm run verify:messaging-login                 # the same feature against real infrastructure (37) —
                                               # NEEDS Redis + Mongo. Boots the app in-process and
                                               # redeems over real HTTP, so the cookies are proven
                                               # rather than asserted. This is what caught KEEPTTL
                                               # being unavailable on Redis 3.0, exactly as
                                               # verify:connections caught GETDEL. Its reset half
                                               # proves a bot-minted token really changes a VENDOR's
                                               # password, that the old one stops working, and that
                                               # a Telegram contact-share completes the RESET rather
                                               # than signing the person in
npm run test:errors                            # Phase 16: the taxonomy, the exposure policy, the
                                               # envelope, the body-parser branch and the rate-limit
                                               # policy (69, no DB). Includes a CENSUS of all 1362
                                               # createAppError sites — it fails if a NEW code is
                                               # raised at two statuses that disagree on category.
                                               # 25 pre-existing conflicts are baselined in the file
                                               # with the reasoning, and the baseline cannot go stale.
npm run test:env                               # the environment contract (36, no DB) — a source CENSUS
                                               # that re-derives every variable src/ reads, INCLUDING the
                                               # ~120 that reach process.env through a config helper and
                                               # are invisible to a `process.env.X` grep, then asserts
                                               # .env.example documents each one. Fails in BOTH directions:
                                               # an undocumented variable is a silently misconfigured
                                               # deploy, a documented-but-unread one is the trap that had
                                               # every storage credential under a name nothing read.
npm run test:system                            # worker schedules, maintenance exemptions, cache-flush
                                               # policy, metric cardinality, plus Phase 15's scrubber,
                                               # ring buffer, console bridge, exposed-config whitelist,
                                               # index-drift diff, prune policy and the safe-execution
                                               # source scan — plus the frozen /api/health contract,
                                               # the build-assets manifest, and the migration ledger's
                                               # four status states + closed registry (225, no DB needed)
npm run verify:shutdown                        # the graceful drain against a real boot (13) — NEEDS
                                               # Mongo. Boots a full instance on its OWN port (8922,
                                               # SHUTDOWN_VERIFY_PORT) so it runs while `npm run dev`
                                               # is up, holds a request open ACROSS the drain and
                                               # asserts it completed rather than being truncated —
                                               # the one thing test:system's source scan cannot see.
                                               # It calls drain() directly because Windows cannot
                                               # deliver a SIGTERM to a child process at all
npm run verify:logs                            # the logging sink against real Mongo (18) — proves the
                                               # collection is genuinely CAPPED, $collStats is permitted
                                               # here, and the warn+ level floor is enforced. NEEDS Mongo
npm run verify:connections                     # messaging connections against real infrastructure (23) —
                                               # NEEDS Redis + Mongo. Proves the two UNIQUE indexes
                                               # actually BUILD (autoIndex fails silently, and without
                                               # them "one account per messaging identity" is enforced by
                                               # nothing), that two concurrent redemptions of one code
                                               # yield exactly one winner, and that a second /connect
                                               # revokes the first code. This is what caught GETDEL being
                                               # unavailable on Redis 3.0. Writes then deletes its own
                                               # `verify-conn-*` fixtures, pass or fail
npm run verify:live-parity                     # agent↔agency smoke test — NEEDS Mongo
npm run verify:blog                            # public reader + index builds + route order — NEEDS Mongo
npm run verify:storefront                      # the storefront against real Mongo (28) — proves the
                                               # indexes actually BUILD (incl. the $text one, and that
                                               # there is exactly one), that every public aggregation
                                               # RUNS, that a pending_verification vendor is published
                                               # while a suspended one is not, and that the route
                                               # tables resolve. Writes then deletes its own
                                               # `verify-storefront-*` fixtures, pass or fail. NEEDS Mongo
npm run verify:reviews                         # the review pipeline against real Mongo (16) — NEEDS
                                               # Mongo. Its first group is the point: it plants a
                                               # DUPLICATE and asserts the E11000, because
                                               # `review_one_per_author_per_subject` is the only thing
                                               # making "one review per author" true (the service
                                               # pre-check is a race) and autoIndex fails silently.
                                               # Also proves a REJECTED review's star really leaves
                                               # the average, and that collectSignals reads the
                                               # aggregate back — the cross-module hop the whole
                                               # module exists for. Fresh ObjectIds, so it touches no
                                               # real agent; writes then deletes its fixtures
npx ts-node scripts/test/test-profile-mappers.ts
```

`verify:storefront` is the third of these, and the `$text` index is why it matters most: MongoDB
permits exactly one per collection, `autoIndex` builds it silently, and a failure leaves every
public search scanning `products`. It also pins the empirical trade — `"Kettl"` does **not** match
"Kettle" — so nobody re-discovers it in production.

`verify:blog` is the blog's counterpart to `verify:live-parity`, for the same three reasons — it is
the only place the unique multikey index on `slug_keys` is proven to build, the `$elemMatch`
translation queries are proven to run, and `/articles/index` is proven to be declared before
`/articles/:slug`. Unlike `verify:live-parity` it **writes**, then deletes its own `verify-blog-*`
documents, pass or fail.

Since Phase 5 Part A it also proves the index **binds** — that a duplicate `slug_keys` entry is
actually rejected, not merely indexed. That stopped being a formality when wi-admin became the
writer: the index is declared in this repository and enforced against writes from another, so "no
two articles answer one URL" is now a claim spanning two services, and an index that builds but
does not bind is indistinguishable from one that works until it matters.

`verify:live-parity` is the other script here that requires a database, and it exists because the
DB-free suites structurally cannot cover four things: that the schema **indexes actually build**
against real data (a failed 2dsphere fails *silently* at boot, and in production `autoIndex` is
off so it is not attempted at all), that the
directory **aggregation pipeline runs** (Mongo validates pipelines at execution time, not compile
time), that the contract lists page and return terminal rows, and that the **Express route table**
resolves literals before `:id` params. It is read-only. Run it after any change to the agent
directory query, the contract list methods, or either router's route order.

Pure derivations are deliberately extracted onto services (`deriveWorkingState`, `buildPolicy`,
`effectiveLimit`) so they can be tested without Mongo. Note that unit tests here cannot catch
circular imports or duplicate Mongoose model registration — boot the server to check those.

## Architecture Overview

**jovi-mall-backend** is an Express/TypeScript modular monolith following DDD-influenced layered architecture.

### Layers (top → bottom)
1. **API layer** (`src/api/`) — middleware, route mounting, global error handler
2. **Module layer** (`src/modules/`) — feature modules with controllers, services, repositories, models, validators, routes
3. **Core layer** (`src/core/`) — base repository, error system, storage abstraction, shared types
4. **Infra layer** (`src/infra/`) — Redis factory, DB connection helpers

### Module structure (consistent across all modules)
Each module under `src/modules/<name>/` follows this layout:
- `controllers/` — HTTP handlers using `asyncHandler` wrapper
- `routes/` — Express router definitions, attaches guards and controllers
- `domain/services/` — single-responsibility business logic classes
- `repositories/interfaces/` — repository contracts (`IProductRepository`, etc.)
- `repositories/mongo/` — Mongoose implementations extending `BaseRepository`
- `repositories/mappers/` — domain ↔ persistence object mapping
- `models/` — Mongoose schema definitions
- `validators/` — Zod schemas for request validation
- `dto/` — Data transfer objects

### Dependency injection
No IoC container. Repositories and services are instantiated manually at the top of each controller file, then closed over in static handler methods. Dependencies flow via constructor injection.

```typescript
// Pattern used in every controller file
const productRepository = new ProductRepositoryMongo();
const productDraftService = new ProductDraftService(productRepository, slugService);

export class VendorProductController {
  static createProduct = asyncHandler(async (req, res) => { ... });
}
```

### Error handling (Phase 16 — `../admin/docs/ADR-016-ERROR-SYSTEM.md`)
**Never** use `throw new Error()` or `res.status().json({ error: ... })`. ESLint enforces this — and the `res.json` selector now matches `error` **anywhere** in the object literal, not only as its first property, which is exactly how eight hand-rolled error responses had accumulated.
- Use `createAppError(code, statusCode, message?, details?)` from `src/core/errors.ts`
- Pass errors to `next(error)` — the global handler normalises AppError, ZodError, body-parser rejections, Mongoose and Multer errors into one shape
- Error codes are domain-prefixed literals in `src/core/error-codes.ts` (541 of them, 1362 call sites, zero ad-hoc strings)

**Every error carries a `category`** — one of nine (`src/core/error-category.ts`), **derived** from `(code, statusCode)` in the `AppError` constructor rather than in the factory, because four subclasses and six `ticket.service.ts` sites call `super()` directly. Never annotate one by hand: the same code is raised at different statuses at different sites, so an annotation would be wrong at one of them. **`400` is a schema failure and `422` is a business rule** — that split already exists at 136 and 139 call sites and the derivation depends on it.

**Filtering happens at the BOUNDARY, keyed on category — never at the throw site.** For `internal` and `external_service` the handler substitutes the code's registry message and **drops `details` entirely**, in *every* environment. That is what closed the `{ cause: error.message }` leak in `payment-orchestrator.service.ts` without editing it, and it is why a service may still put diagnostic context in `details` on a 5xx — it is journaled, not sent.

**The client envelope gained one field, `category`, and nothing else.** `isOperational` is now derived (`statusCode < 500`); it was hardcoded `true`, so the masking its own docstring promised had never once happened.

**Errors are journaled under one `httpError` key** on the log line, read back through `GET /api/internal/admin/system/errors`. That endpoint returns the FULL record — the developer/admin/support ladder is applied in **wi-admin**, the only service that knows an administrator's tier. `X-Actor-Tier` reaches this service and must stay advisory: the token authenticating that call grants everything, so enforcing on the header would be theatre.

⚠ `core/logging/log-record.ts` assigns every persisted field **by name**. A new field must be added there, in the sink, AND in `log-query.service.ts`'s `toRecord` — miss one and the data is written and silently dropped on read. That is why the whole error record nests under a single key.

### Rate limiting (`src/api/rate-limit/`)
Three layers. **Layer A** (`globalRateLimiter`, mounted in `app.ts`) is IP-scoped and runs before auth, so it protects the login endpoint. **Layer B** (`identityRateLimiter`) is attached at the **tail of `requireAuth`** — one edit, and every authenticated route inherits the per-role ceiling; a router added next year gets it without its author knowing. **Layer C** is per-endpoint and deliberately unbuilt.

**Never classify a caller from an unverified JWT.** Selecting a *more generous* bucket from an attacker-chosen claim hands a forger the biggest one — that is the entire reason for the two-layer split rather than one clever limiter.

Ceilings are backstops, not budgets (agent/admin 1200, vendor/agency 900, customer 600, anonymous 600/IP; **credential endpoints 20/IP**, the one strict number and the one security control). Redis DB 11.

**`/api/auth` is TWO buckets now, split by purpose and chosen by `authBucketDispatcher`.** The 20 is aimed at password spraying, and it was being spent by traffic that presents no password — `/auth/me` on every dashboard poll, `/auth/auth-me` on every app launch, `/auth/browser/refresh` on every renewal (the Flutter agent app calls that one every time). Behind a NAT the failure mode was the bad one: a refused refresh signs a user out, and their retry at the login form is refused too, by their neighbours. Session maintenance moved to `auth_session` (300/IP, `RATE_LIMIT_AUTH_SESSION_PER_MIN`); everything else stays at 20. Three properties: the list in `rate-limit/auth-paths.ts` is an **allowlist**, so a route added later inherits the strict bucket; it is a **dispatcher**, not two mounts, so a request is counted once and its `RateLimit` headers describe the counter that actually bound it; and it classifies on **`req.baseUrl + req.path`**, because inside a `use`-mounted layer Express has already stripped the prefix and a bare `req.path` would match nothing — silently, in the safe direction. **The store fails OPEN** — `rate-limit-redis` rejects when Redis is down and express-rate-limit turns that into a 500 on *every* request, so `FailOpenStore` is not garnish: without it, wiring Redis in adds a single point of failure in front of every route. `/api/health*`, `/metrics` and `/api/webhooks/*` are exempt, with a written reason each.

`app.set('trust proxy')` and `express.json({ limit })` are load-bearing companions — the first because `req.ip` is the limiter's key, the second because `REQUEST_BODY_TOO_LARGE` is unreachable without a named ceiling.

### Auth & request context
`requireAuth` middleware (`src/api/middlewares/auth.middleware.ts`) populates `req.auth = { user, role, role_entity }`.

**There is a second door onto `req.auth`, and it builds one from nothing.** `requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`) guards `/api/internal/admin/*`, the surface the **wi-admin** backend calls. Administrators live in a separate database and hold no `users` row and no `admins` row here, so that middleware *synthesises* the whole `req.auth` shape from request headers with **no database query** — `X-Actor-Id` becomes both `user.id` and `role_entity._id`, and the role is the constant `'admin'`.

The consequence is deliberate and worth knowing before you touch an actor field: **a `*_by_user_id` written through that door holds an id that resolves to nothing in this database.** It is safe only because no `.populate()` anywhere dereferences an actor (`*_by*`) field — 13 populate sites, none of them. Adding one would silently return null. What makes it legible instead of mysterious is the pair of companion fields from `core/types/actor-source.types.ts`: `*_source: 'platform' | 'admin'` says which identity space the id belongs to, and `*_name` snapshots who it was, because a cross-database join cannot exist. Use `actorStampFields()` in the schema and `actorStamp()` on the write — writing the three together is what stops a source disagreeing with the id beside it. Applied so far to `agency_remittances.resolved_by` and `agent_deposits.recorded_by`.

`INTERNAL_ADMIN_SERVICE_TOKEN` authenticates that caller and is deliberately **not** `INTERNAL_SERVICE_TOKEN` (geo-tracker's) — different blast radii, so one secret would make either compromise the other's. Both fail closed when unset. Note the token is a *full-privilege* credential: authorization is resolved in wi-admin before the call and this service re-checks nothing, exactly as it trusts geo-tracker.

**⛔ THE CUTOVER HAPPENED. Admin routers are mounted ONCE, internal only** (Phase 5 Part E, 2026-08-20). Every public `/api/admin/*` mount is deleted — eleven of them — and with them jovi-mall's **second authorization model**: `requireRole(['admin'])` on a platform `users` row that holds no tier, no permission set and no audit identity, and so bypassed wi-admin's tier matrix, escalation rules, dual-control queue and audit trail entirely. **`/api/internal/admin/*` is now the only administrative door into this service**: 111 routes in fifteen groups, behind `requireAdminCaller`. Ownership per domain is recorded in `../admin/docs/ADR-004-DOMAIN-OWNERSHIP.md`; the cutover itself is `../admin/docs/ADR-017-PHASE-17-CLOSEOUT.md` D-2.

**The factory shape survives, and is still the shape to follow.** `buildAdminCodRouter(guards)` takes its guard chain as a parameter because a single Router instance cannot be mounted twice — its `router.use` guards would re-run. That is why the deletion was *subtractive*: the same factories that served both mounts now serve one, and only the `'public'` instantiation and its default export went. Each of the seven carries a header saying so, and saying **not to re-add one** — `requireRole(['admin'])` still exists (it guards vendor, agency, agent and customer routes), so writing a public admin mount would compile, work, and silently reopen the model this phase closed.

**Two traps that outlived the public mounts.** The agency router's routes are **path-relative** (`/:id/deactivate`, not `/delivery-agencies/:id/deactivate`) because the prefix used to absorb that segment — that is what let one factory serve `/api/admin/delivery-agencies` and `/api/internal/admin/agencies`, and it is still how the surviving mount is shaped. The billing router is the same story with a bigger gap: its public URLs had **no `/billing` segment at all** (`/api/admin/plans`), so the same operation appears under two different URLs depending on when an `admin_action_log` row was written. wi-admin reads `delivery_agents` and `agent_agency_contracts` directly and calls only the writes plus the three *verdict* reads (`tracking-policy`, `cod-allocation`, `eligibility`) — `../admin/docs/ADR-009-DELIVERY-NETWORK.md` D-1.

**`buildAdminUserRouter` and `buildAdminVendorRouter` were internal-only from the start, and that is now the ordinary case rather than the exception.** Neither domain ever had a public admin surface — the argument at the time was that a public mount would create surface whose only future is the cutover deletion list, which is exactly what happened to the eleven that had one. Users carries writes only (`PATCH /:userId` for the login identifiers, `POST /:userId/{suspend,restore}`); vendors carries seven (suspend/restore, KYC approve/reject, per-product suspend/restore, a narrow settings PATCH). Contract in `api-doc/admin/vendors.md`; design record `../admin/docs/ADR-008-VENDOR-MANAGEMENT.md`. The one public vendor-admin endpoint that did exist — `POST /api/admin/vendors/:vendorId/plan`, in the billing module — went with the rest and is now `POST /api/internal/admin/billing/vendors/:vendorId/plan`.

**The `admin` role VALUE survives here, and deleting it would break about twenty sites.** `requireAdminCaller` *synthesises* `req.auth.role = 'admin'` for every wi-admin call, and the upload policy, file ownership stamping, `FileAttachService`, `FileReferenceService`, `actorSourceOf`, the rate-limit caller class and `AuditLogger.log` all branch on it. `'admin'` also stays in `UserRole` on the Mongoose user model, because that enum describes what a legacy row *may hold*; `AUTHENTICATABLE_ROLES` is what may be signed in *as*, and the two are deliberately different. What was retired is a **platform user session's** ability to carry the role and reach a route with it — see the auth note below.

**`Vendor.status` is now enforced, and this is the second time that sentence has been written here.** It used to be read by exactly one query (`findAvailableForAgencies`, hiding `inactive` vendors from the agency directory) and written by nothing — `updateStatus` had zero callers, and the three guards in `auth/guards/index.ts` that would have read it (`requireActiveUser`, `requireRoleEntityActive`, `requireLegitBusiness`) **had zero call sites and were deleted with that file** (2026-08-19, plan step 4.A.3 — a guard nobody calls protects nothing, and one of the three would have denied every vendor if anyone had attached it). `requireAuth` and `login` now refuse a vendor whose role entity is `inactive` with `403 AUTH_VENDOR_SUSPENDED`.

The check is deliberately `=== 'inactive'`, **never `!== 'active'`**: `pending_verification` is the schema default at registration, so the negated form would lock out every vendor who never verified their email. Refusing only `inactive` is provably a no-op against existing data. Don't "tidy" it — `wi-admin`'s `test:vendors` asserts the narrow form is what is in the file, and `verify:vendors` plants a `pending_verification` vendor to prove it stays untouched.

Suspension is written **only** through `/api/internal/admin/vendors` as a compare-and-set, carries `suspended_at` / `suspended_reason` / `suspended_from_status` / a `suspended_by` actor stamp, and **cascades**: it takes every `active` product of that vendor off sale in the same transaction (`ProductPlatformSuspensionService`, reason `vendor_suspended`), and the restore re-runs the activation gate on each rather than republishing blindly. `Vendor.status` and `User.status` remain separate axes and do **not** cascade into one another in either direction — one account can hold `vendor` and `customer`, and closing the shop must not sign the person out of their own shopping.

**`markEmailVerified` is now conditional, and that matters.** It used to `$set: { status: 'active' }` unconditionally — harmless while nothing wrote any other value, but the moment an administrator can suspend a vendor it means a suspended vendor lifts their own suspension by re-clicking an old verification link. It is a `$cond` pipeline update that only ever promotes out of `pending_verification`. `delivery-agency.repository.ts:135` has the same shape and therefore the same latent bug; flagged, not fixed.

**The deprecated top-level `Vendor.legit_verified` is gone**, and it was worse than dead: its schema path was commented out, so Mongoose strict mode silently stripped it from `setLegitVerified`'s `$set` — half that method never did anything — while `requireLegitBusiness` read it and would therefore have denied *every* vendor the day anybody attached it. The single source of truth is `kyc_details`, which now carries a three-valued `status` (`pending|verified|rejected`) beside the boolean, plus `verified_at`, `rejection_reason` and a reviewer stamp. `legit_verified` stays as the boolean projection because `agency-vendor-browse.dto.ts` renders `kycVerified` from it; the two are written in one `$set` and never apart.
Vendor-scoped queries extract `req.auth!.role_entity._id.toString()` as `vendorId` and pass it to repositories, which enforce scoping at the query level.

**Token resolution: the BEARER first, then the `access_token` cookie — and `extractToken` reports which.** The order was reversed when the mobile namespace landed. No browser sets `Authorization` (none of the four dashboards does; the only place one is built points at geo-tracker), so preferring it is provably a no-op for cookie clients, and it closes a bug that is near-undiagnosable from the client side: a WebView routed through a native HTTP layer inherits the OS cookie jar, and a stale cookie beating a freshly-refreshed bearer produces 401s that look impossible.

**The silent refresh is asymmetric, and the asymmetry is load-bearing.** `requireAuth` still refreshes from the refresh cookie when the caller presented **no credential at all** — that branch is the ordinary browser path once the 15-minute access cookie expires and is deleted, *and* the Flutter agent app's second refresh path, which sends `GET /auth/auth-me/agent` with a hand-built `Cookie: refresh_token=…` and no `Authorization`. It now refuses to refresh a caller who presented an **expired bearer**, answering `401 AUTH_TOKEN_EXPIRED`: refreshing from an ambient cookie there would authenticate the request as whoever that cookie belongs to while the client went on sending its own token. Tidying the two branches into symmetry signs out every browser session older than fifteen minutes; `test:mobile-auth` scans for it.

**Bearer clients now have a way to obtain and renew a token: `/api/auth/mobile/*`.** A third namespace beside `/auth/browser/*`, same session model and same `AuthService` — only delivery differs. `login` · `register` · `refresh` · `auth-me/:role` · `add-role` return the pair as `data.tokens` (with `accessExpiresIn` / `refreshExpiresIn` in seconds) and **set no cookie**; `mobile-auth.controller.ts` contains no `setAuthCookies` and no `res.cookie`, asserted by a source scan. **The namespace is the switch — there is deliberately no `X-Client-Type` header.** A route separation makes "browser behaviour is unchanged" true by construction rather than by a check, costs no preflight on a non-safelisted header, and — the part that reaches across the boundary — avoids editing geo-tracker's closed CORS header list, so this stayed a one-sided change.

`AuthService.rotateRefreshToken` now returns a **pair**; the cookie callers (`requireAuth`'s silent refresh, `POST /auth/browser/refresh`) simply do not read the refresh half, so cookie behaviour is byte-identical. Deliberately not an options flag — the flag restores the two code paths this collapses, for one discarded `jwt.sign`. The 30-day window still **slides** — every re-issue mints both halves at full lifetime — but the *sign-in* is now capped at 90 days, so a stolen refresh token an attacker keeps refreshing no longer lasts forever. See "The absolute session cap" below.

**The absolute session cap (`core/auth/session-cap.ts`, ADR-A03).** One claim, no store: **`auth_time`** records when the account holder last *proved* a credential, and it is **copied byte-identical** through every re-issue. Past `AUTH_ABSOLUTE_SESSION_CAP` (90 days) both credential paths answer `401 AUTH_SESSION_CAP_REACHED`. Four things are load-bearing:

- **Fresh at exactly four sites, and they are the credential proofs:** `login` (bcrypt compared), `register` (the password is set), the messaging-login session (a single-use bot credential was spent), and the password-change re-issue in `user.controller.ts` — that last one deliberately, because a password change is the platform's only existing revocation and re-stamping keeps it a *complete* remedy.
- ⚠ **Copied at three, and `auth-me` is the one that matters.** `rotateRefreshToken` obviously; but `authMe` and `addRole` **also mint a full fresh pair from a valid access token**, and every client calls `auth-me` on launch. Stamping fresh at either — which is what plan step 4.A.5.2 asked for — would reset the clock every few days for the life of the account and make the cap unreachable while looking implemented. `req.auth.auth_time` carries the verified value to them; both take it as a **required** parameter so it cannot be omitted.
- **Enforced on both paths, exactly like the password epoch.** `rotateRefreshToken` is the eviction (the refresh credential lives 30 days); `requireAuth` closes the 15-minute access tail **and** the two re-issue routes behind it — a client polling `auth-me` inside the access lifetime never reaches the rotation at all.
- **A token with no `auth_time` is dated from its own `iat`** (D-9). No grandfathering, no mass sign-out: every live refresh token was minted within 30 days, so a legacy session is capped from at most 30 days ago and heals on its first re-issue. Nobody was signed out on deploy day. A payload carrying **neither** claim fails closed.

⚠ **Passing `issueTokenPair(user, role)` at a copy site is the bug this whole design exists to prevent, and it would look exactly like working code.** No behavioural test can catch a re-stamp in under 90 days, so `test:mobile-auth` asserts all seven sites by **source scan**. Client contract — including "route to login, **never retry**" — is `api-doc/auth/README.md`.

Cookie `maxAge` and JWT `expiresIn` now come from **one** pair of constants (`ACCESS_TOKEN_TTL_S` / `REFRESH_TOKEN_TTL_S` in `core/auth/token.issuer.ts`, which `cookie.config.ts` imports). They used to be two independent `parseInt`s of the same variables, agreeing only because the defaults matched — harmless while nothing published a lifetime, and a client refreshing at the wrong moment once `tokenEnvelope` started to.

**`AUTHENTICATABLE_ROLES` is now enforced on ALL FIVE token-minting paths, and the fifth is the cutover's security half.** `['customer','vendor','agency','agent']` (`auth/auth.schemas.ts`) is one list behind four Zod schemas plus a runtime guard, `isAuthenticatableRole`, for the paths where a role arrives from a stored `users.roles` array rather than a parsed body. `register` and `addRole` refuse `'admin'` at parse; `login` and `authMe` refuse it at parse *and* through `roles.filter(isAuthenticatableRole)`. **`rotateRefreshToken` was the fifth and it was open**: it copies the role straight out of the presented token and never re-reads `user.roles`, so a refresh token minted before the cutover kept producing `role: 'admin'` access tokens for the remainder of its 30-day life — and such a token satisfied every `requireRole(['admin'])` site this service used to serve. It now throws `AUTH_ROLE_NOT_FOUND` (403, the same code `login` and `authMe` answer for the same condition — deliberately *not* `AUTH_SESSION_EXPIRED`, which a client would retry forever). **No behavioural test can see this**, because there is no supported way to mint an `admin` refresh token any more, so `test:mobile-auth` pins it by SOURCE SCAN — three assertions: the guard exists, it reads `payload.role`, and it runs *before* `issueTokenPair`. The rows it protects against were removed in the same change by `migrate:retire-admin-role`, which pulls `'admin'` off every `users` row and suspends any row that carried nothing else: the guard stops new admin tokens being minted, the migration removes what a future regression would mint them from.

**`User.status` is now enforced, and on three paths rather than one.** It used to be written by nothing and read by nothing — `requireActiveUser` had zero call sites, `login` never looked at it, `rotateRefreshToken` never looked at it, and `UserRepository.updateStatus` had no callers. A suspended account was a label. `login`, `rotateRefreshToken` **and `requireAuth`** now refuse a non-`active` account with `403 AUTH_ACCOUNT_SUSPENDED`. The third is the load-bearing one: access tokens are stateless and 15 minutes long while the refresh cookie is 30 days, so a check at login alone would let a suspended person keep working and then silently refresh back in. `requireAuth` already loads the user row, so it costs a comparison and no query. **Consequence:** any `users` row already sitting at `suspended` loses access the moment this deploys, and there is no way for the person to get back in without an administrator — which is the correct meaning of the column, but check the count before rolling out.

Suspension is written **only** through `/api/internal/admin/users` (wi-admin's `users.suspend`), as a compare-and-set on the current status, and it carries `suspended_at` / `suspended_reason` / a `suspended_by` actor stamp. It deliberately does **not** cascade into the role entities: `Vendor.status`, `DeliveryAgent.status` and the rest are a separate axis with their own meanings, and collapsing the two makes reinstatement guess which was true before. The account lock is complete on its own — a suspended user cannot authenticate at all, whatever their role entities say. Design record: `../admin/docs/ADR-007-USER-MANAGEMENT.md`.

**A password change is now a revocation, and `iat` is what carries it.** Tokens here are stateless JWTs with no server-side store, so `changePassword` had nothing to delete and did nothing — a `console.log` where the session invalidation should be. Changing a password, the standard remedy after a compromise, evicted nobody: the attacker's refresh cookie stayed valid for its remaining 30 days and went on minting access tokens while the victim believed they had locked the door.

The revocation list is one field. `UserRepository.updatePassword` stamps `User.password_changed_at` **in the same `$set` as the hash** — never apart, since a hash landing without its stamp is the whole defect — and `core/auth/password-epoch.ts` refuses any token whose `iat` predates it. Four things about it are load-bearing:

- **Both credential paths check, not just one.** `rotateRefreshToken` is the eviction (the cookie lives 30 days); `requireAuth` is what closes the 15-minute tail, and it costs a comparison because the user row is already loaded. Gate only the refresh and whoever the change was aimed at keeps working for a quarter of an hour.
- **The comparison is in whole SECONDS, with `<`.** `iat` is `floor(now/1000)` while the stamp is a millisecond instant, and the change and the caller's replacement pair happen in the same request — a millisecond comparison rejects the brand-new token about half the time. Don't "tighten" it.
- **The caller is re-issued a pair** (`UserController.updatePassword` → `setAuthCookies`), so the person who changed their own password stays signed in and nobody else does. Cookies only, as everywhere else here.
- **`null` means "never changed"** and accepts everything, which is why no backfill was needed.

`401 AUTH_PASSWORD_CHANGED` on both paths — 401 rather than the suspensions' 403 because re-authenticating *is* the remedy, and a browser's silent refresh meets the same verdict on the refresh path and stops rather than loops. Covered DB-free by `npm run test:password-epoch` (25), which includes a source scan of both call sites: a predicate nobody calls protects nothing, and that is the state this feature was in.

**`JWT_SECRET` fails closed here too, and this note used to say otherwise.** `getJwtSecret()` (`config/secrets.config.ts`) throws `CONFIG_MISSING_JWT_SECRET` when unset and additionally refuses a value under 16 characters or a known placeholder in production, with `assertSigningSecrets()` running at boot — so a deploy without it does not start. The old `|| 'secret'` fallback is gone; the claim survived here long enough to be quoted back at us in a frontend spec, which is the argument for [verify-docs-against-code]. ⚠ This sentence used to end "…**exactly as geo-tracker's does not**", and that half was false for months: geo-tracker read `getEnv("JWT_SECRET", "secret")` and booted happily without the variable. It was made true on 2026-08-19 (Phase 3 step 3.E.2) rather than merely deleted — but note what the correction was: an unverified claim about a repository this file's author was not editing. Assert nothing here about the other service without opening its source.

**`POST /auth/login` checks the password.** For a period `bcrypt.compare`'s verdict was computed and discarded — any password authenticated any account, for every role. Restored, with **no environment escape hatch**: a bypass whose failure direction is "open on a typo" is what `config/env.ts`'s own header argues against, and a seed that relied on the hole needs a real password rather than a flag. `test:mobile-auth` asserts both the check and the absence of any variable that could disable it.

### Configuration (`src/config/env.ts` + the module configs)

Values live in ~15 module-level `*.config.ts` objects; **`config/env.ts` validates the
environment those defaults are applied to** and is asserted at boot beside
`assertSigningSecrets()`. That split is deliberate and is where this service diverges from
wi-admin, whose `config/env.ts` *supplies* every value — moving all 254 variables into one
schema would rewrite every module config plus ~40 inline sites to land where the defaults
already are.

What the validator buys is the property the module configs structurally cannot have. They all
share the `intEnv(name, fallback)` shape, which **silently substitutes the fallback for a value
it cannot parse** — so `COD_DEPOSIT_DEADLINE_DAYS=two` booted clean and ran on 2. A per-variable
default cannot detect that; only a pass over the whole environment can. It reports **every**
problem at once, and the error/warning split tracks blast radius, not tidiness: an `error`
refuses the boot, a `warning` is for what this process genuinely cannot decide (is there a proxy
in front of it?). A validator that fails a start over dead leftover config is one somebody
switches off, after which it protects nothing.

⚠ `agent.config.ts` throws at import if the trust weights don't sum to 100, and it is imported
transitively by `app.ts` — so that check fires *before* `startServer()` reaches the validator.

**`.env.example` documents all 254 variables**, grouped by subsystem, with provenance and effect
for each. `npm run test:env` is what stops it drifting: an audit found 84 of 149 undocumented,
and the real number was worse because that audit's own grep could not see the ~120 variables
read through a config helper. The template's storage block additionally named variables
**nothing read** (`CLOUDINARY_*` vs the actual `STORAGE_CLOUDINARY_*`), so an operator
configured object storage and every upload went to a container disk wiped on restart —
`RENAMED_VARS` in the validator now names each one.

### The migration ledger (`src/core/database/schema-migration.model.ts` + `scripts/migrate.ts`)

Sixteen idempotent migration programs exist with good headers, npm bindings and — until plan step
2.C — **no record of what had been applied where**. `schema_migrations` is that record, with geo-tracker's semantics
(`internal/platform/postgres/migrate.go`): **forward-only, no down migrations, one version table**.

- **`checksum` is what makes it useful**, and it is the one field the Go version does not need —
  its migrations are embedded SQL that never changes after it ships, while these are
  TypeScript programs somebody may still edit. Without it the ledger answers "this migration ran";
  with it, "*this version of* this migration ran", and an edit since the last run reports as
  **`applied-but-changed`** instead of hiding inside `applied`. It is normalised for line endings
  — developed on Windows, deployed on Linux, and a CRLF checkout would otherwise report all of them
  as changed on their first run in a container.
- **The collection is APPEND-ONLY and has no unique key.** A failed attempt is worth more than a
  successful one during an incident, so a run never overwrites its predecessor; status is "the
  newest row for this name in this environment". A uniqueness claim would force either an upsert
  (destroying the history) or a failure on the second run of an idempotent script, which is the
  normal case.
- **The runner SHELLS OUT to the existing npm bindings.** Each of them has its own
  `dotenv.config()`, its own `mongoose.connect` and its own `process.exit`; importing them into one
  process is a rewrite of every one, and they are the part that already works. The migration
  under test is byte-identical to the one that runs, and this file cannot break a migration.
- **Order is DECLARED, in `MIGRATIONS`.** One rule survives: every index build runs last (three
  claim uniqueness, and a unique build fails outright against data a later migration has not yet
  cleaned up). A failure **stops** the run. ⚠ There used to be a second — `migrate:agent-memberships`
  first — and it went with that migration when it was **deleted** (2026-08-23, Phase 6 Step 17). No
  surviving data migration reads another's output, so nothing replaced it.
- **The registry is CLOSED.** `assertRegistryCovers()` diffs `MIGRATIONS` against every
  `migrate:*`/`backfill:*` binding in `package.json` and refuses to run on any difference — a
  migration added without a row would otherwise be one the ledger silently does not track, which
  is the exact failure this exists to end. `test:system` asserts it too.
- ⚠ **Exactly one of them destroys** (`migrate:drop-agent-invites`, 2026-08-19). It reads and
  prints what it is about to drop first, and forward-only is unrecoverable rather than merely
  inconvenient for it — see `../docs/RUNBOOK.md` § 2.
- **`--dry-run` ledgers nothing.** A rehearsal is not an application.
- ⚠ **`scripts/migrate.ts` guards its own `main()` behind `require.main === module`**, because
  `test:system` imports it for the registry. Without that, a DB-free unit test would apply every
  migration. `admin/scripts/ensure-indexes.ts` carries the same guard for the same reason.

**wi-admin has a ledger, not a runner** (`admin_schema_migrations`): it has one migration-shaped
script, `ensure:indexes`, which records its own row and is read back by `npm run migrate:status`.
The moment it has two, ORDER becomes a fact somebody must declare and the honest move is to port
`scripts/migrate.ts` rather than grow that file.

### Startup composition and shutdown (`src/lifecycle.ts`)

⚠ **Boot lives in `src/lifecycle.ts`, not `server.ts`.** `server.ts` is now a three-line
entrypoint whose only jobs are to evaluate `dotenv/config` above the module graph and to register
the signal handlers before the boot begins.

Background workers/consumers register at boot, all after the Mongo connection, in `startBackgroundWork()`. **Do not read the list below as the roster** — `startBackgroundWork()` is, and `WORKER_INVENTORY` is what every surface reports from; this is orientation. Analytics aggregation scheduler · billing (plan-expiry + its notification consumer, agent plan→capacity consumer, agency shipment-cap monitor) · the four notification consumer stacks (vendor / agency / **agent** / customer) · file-cleanup · earnings-release · unpaid-order-cancel · bookings (unpaid-booking-cancel, booking-reminder, inbound-calendar-sync) · COD deposit-deadline · payment reconciliation · the tracking **dispatch worker** and the tracking-allow **reconcile** backstop · the shipment-assignment auto-assign subscriber + offer-expiry sweep · agent capacity-reconcile · agent **trust recompute** (⚠ shadow — see § Agent trust score) · agency inventory-reconcile · agency storage-invoice.

There is no tracking event subscriber any more — plan step 3.A.1 moved the outbox write into the producing transaction and deleted it. A feature that needs periodic sweeps registers in `startBackgroundWork()`; sub-minute cadences use `setInterval`, daily ones use `node-cron`.

Two things run **before the listener opens**: `initializeMetrics()` (the private Prometheus registry, plus the Redis error sink) and `primeMaintenanceState()`. The second is load-bearing — an instance starting during a maintenance window must come up already closed, or a rolling deploy serves one full cache window of writes against a platform that is supposed to be shut.

**`autoIndex` is OFF in production** (`mongoose.connect(MONGO_URI, { autoIndex: NODE_ENV !== 'production' })`), matching wi-admin, which has had that line since Phase 4 with a comment naming this service as the counter-example. An index build triggered by a boot is an unannounced load spike timed to a deploy, and a failed one fails *silently* — the promise rejects into a listener nobody attached and the process comes up healthy. Index creation is an explicit, ledgered migration step now: `npm run migrate:up`.

Turning it off trades a silent-SLOW failure for a silent-MISSING one, so it is paired with **`reportIndexDrift()`**, which runs `inspectDatabase(null)` once **after the listener opens** and logs anything declared-but-absent at `warn`. Three properties: it is **not awaited** (the sweep walks the whole collection registry under a wall-clock budget and none of it is a precondition for serving a request), it **never builds** anything (that is what `autoIndex` was turned off to stop), and it **never fails readiness** — a fresh database has every index legitimately missing until the first migration runs, so gating readiness on drift deadlocks a cold start at the worst possible moment. Development keeps `autoIndex` on: a developer who has just written a schema should not have to run a migration to use it.

**Register the singleton, never `new` a worker inline.** The boot used to do `new InboundCalendarSyncWorker().start()`, which left the running worker unreachable by anything else: the operations surface could not report on it even in principle, and `stop()` could never reach the instance that was actually scheduled. Every worker now exports a singleton and `startBackgroundWork()` starts that.

**`drain()` is the ordered shutdown, and it is EXPORTED for a reason.** Windows cannot deliver a
real `SIGTERM` to a child process — Node maps `child.kill('SIGTERM')` onto `TerminateProcess`, an
uncatchable hard kill — so a shutdown reachable only through a signal handler would be untestable
on the development machine and first exercised in production. `npm run verify:shutdown` calls it
directly (13 assertions, NEEDS Mongo), including the one no source scan can make: that a request
in flight when the drain starts **completes** rather than being truncated.

The order is load-bearing, and `test:system` asserts it from source:

1. **`stopAllWorkers()` first, before Mongo closes.** A tick in flight when the connection goes
   away throws inside a timer callback — the one place with no handler above it — so an unhandled
   rejection there takes the process down MID-DRAIN.
2. **`server.close()` + `closeIdleConnections()`.** Without the second, `close()` waits on every
   idle keep-alive socket and the drain reliably hits its deadline.
3. **Wait for in-flight sweeps** (`awaitWorkerLocksReleased`) — a bounded WAIT, deliberately not a
   lock release. `withWorkerLock` holds its token in a closure, and a release-by-key would let a
   caller that is not the holder free a lock whose sweep is still writing. The Redis `PX` is the
   backstop, and the drain logs which keys it left held.
4. **Flush the log sink**, which writes to Mongo, so it must precede the disconnect.
5. **Mongo, then Redis.**

`stopAllWorkers()` **iterates `WORKER_INVENTORY`** rather than naming eighteen singletons —
`ObservableWorker` declares `stop()`, so a worker that loses one is a compile error, and
`test:system` couples the inventory's size to the count of `*.worker.ts` files so an
uninventoried worker fails rather than silently outliving the process. That is the same defect
`AssignmentSweepWorker` already had once.

⚠ **`lifecycle.ts` is the ONLY place in `src/` that may handle a signal**, and `test:system`
scans for it. Two partial handlers used to exist — the log sink's `SIGTERM` flush and the calendar
worker's self-stop — and once a real drain exists those are not a partial version of it but a
**race** against it: both fire concurrently, and the first lands a Mongo write on the connection
the drain is closing. `beforeExit` is exempt (it cannot fire on a signal or on `process.exit()`).

`SHUTDOWN_TIMEOUT_MS` (default 10 000) is the hard deadline, and it must be raised together with
Docker's `stop_grace_period` or the orchestrator's SIGKILL lands first.

### System operations (`src/modules/system/`)
The operator surface, split across two mounts by what it does rather than by convention:

- **`/api/internal/admin/system/*` — every route a GET, nothing audited.** `dependencies` (Mongo readyState + `serverStatus`, Redis per logical DB), `integrations`, `queues`, `cache`, `workers`, `metrics` (JSON), `maintenance`.
- **`/api/internal/admin/dev-tools/*` — everything that changes something**, including the two Phase-14 additions: `PUT /maintenance` and `POST /cache/flush`.

Four rules run through it, and each exists because the obvious implementation is wrong:

- **A probe observes; it does not provision.** Redis connects lazily here and never at boot, so every read goes through `peekRedisClient` (already-open client or null) — a DB this process has not needed reports `idle`, not `down`. `/api/health/ready` therefore treats Redis as **non-required**: requiring it would create a connection on DB 0 (which nothing uses) on every probe interval, and would fail the whole instance for a partial capability loss. The cache *flush* is the one deliberate exception and uses `getRedisClient`; the asymmetry is documented on both accessors.
- **`configured` and `reachable` are different columns**, and most integrations may not be probed at all — a Stripe health check is an authenticated call on a live merchant account, a WhatsApp one is a message to a real person. `domain/integration-catalog.ts` holds the per-provider policy; unprobeable providers report what **real traffic** last learned, via `recordIntegrationCall()`.
- **Metric labels are bounded by a closed allowlist, not by normalisation.** prom-client enforces no cardinality cap, so `domain/route-group.ts`'s allowlist *is* the cap; `event_type` is bounded by *subscription* instead. Never label by user, role, vendor or order id.
- **Maintenance state lives in Mongo and every unknown fails OPEN.** Redis would converge faster but a restart would silently drop the window. An unrecognised mode or a corrupt document reads as `off`, because the failure mode of failing closed is a platform that is down and whose own operator door may be part of what is down.

**`GET /api/health` is FROZEN** — exact path, exact body, unconditional 200. geo-tracker's `NodeAPIChecker` is a **readiness** checker pointed at it and treats any status ≥ 300 as an error, so putting readiness semantics on that path means a jovi-mall Redis wobble pulls geo-tracker out of rotation and kills every live tracking session. `/api/health/{live,ready}` sit beside it. Contracts: `api-doc/health.md`, `api-doc/admin/system.md`, `api-doc/admin/dev-tools.md`; design record `../admin/docs/ADR-014-SYSTEM-OPERATIONS.md`. Covered DB-free by `npm run test:system` (70 assertions).

**Phase 15 added the developer-tools half** — four more GETs on `/system` (`config`, `logs`,
`cache/keys`, `database`) and one more verb on `/dev-tools` (`outbox/prune`, the only new
dangerous one). Design record: `../admin/docs/ADR-015-DEVELOPER-TOOLS.md`. Four rules of its own:

- **`GET /system/config` is a whitelist, never a dump** (`domain/exposed-config.ts`).
  `assertExposedConfigSafe()` runs at boot beside `assertSigningSecrets()` and kills the process
  if the list names anything credential-shaped. No `*_URL`/`*_URI` is exposed at all — the
  derived `wiring` block answers "is it pointed anywhere" without being able to carry a password.
  `SMTP_USER` is absent by a *human* decision the regex cannot make, which is the point.
- **Values never leave the cache.** `/system/cache/keys` returns names, types and TTLs; there is
  deliberately no single-key value read, because that is a disclosure oracle for download tokens,
  verification codes and WhatsApp idempotency keys. Every Redis command goes through the closed
  allowlist in `domain/redis-command-policy.ts` — *the allowlist is the cap*, the same argument
  `route-group.ts` makes about metric labels.
- **`/system/database` reports index drift and never repairs it.** `missing` is the actionable
  bucket, and it stayed actionable when `autoIndex` went off in production (plan step 2.C.4): a
  failed build used to fail *silently* at boot, and now an unbuilt index is silently *absent*
  instead — same blind spot, different cause, which is why `lifecycle.ts` also logs the drift at
  boot. Building or dropping an index is a migration, not a button.

  ⚠ A `$text` index is DECLARED as `{title:'text',…}` and REPORTED as the sentinel
  `{_fts:'text',_ftsx:1}` with the real fields in an alphabetised `weights` document, so comparing
  the two verbatim produced a permanent false `missing` **and** a false `extra` on `products` —
  the one collection here carrying one. `index-diff.ts` canonicalises both sides now. Sorting the
  key is correct **there and nowhere else**: a text index has no prefix semantics, while for a
  compound index key order *is* the identity.
- **`outbox/prune` accepts `status: 'sent'` and nothing else.** Pruning `failed` destroys what
  `outbox/replay` acts on; pruning `pending` destroys undelivered events. `confirm` repeats the
  *age*, because the age is what decides the blast radius.

### Logging (`src/core/logging/`) — Phase 15

This service had **no logging library** until Phase 15: 1268 `console.*` calls, stdout only, no
levels, no redaction, nothing queryable. It now has **pino**, with two sinks — a bounded in-memory
ring buffer and a **capped** `system_logs` collection persisting warn+ — behind
`GET /api/internal/admin/system/logs`.

- **`initLogging()` runs first in `startServer()`**, before the secret assertions, so a refused
  boot is itself captured. `enableLogPersistence()` runs after `mongoose.connect`. Lines between
  the two land in the ring only, and the endpoint reports the sink state so that boundary is
  visible rather than mysterious.
- **`console.*` is bridged** through the logger — that is what gives the 311 existing
  `console.error('…', err)` sites structured, searchable stacks without editing one. Only the
  five level-shaped methods are swapped; `console.table`/`dir`/`trace` stay native.
  `LOG_CONSOLE_BRIDGE=false` is the kill switch. **A test harness must print through
  `originalConsole`**, or the bridge swallows its own results.
- **Redaction is two layers and only one is a boundary.** `REDACTED_PATHS` is derived from
  `core/audit/redact.ts` (so it cannot drift), filtering out that set's two bracketed *path
  fragments* — they are not valid pino paths and pino throws at construction. `scrub.ts` is a
  heuristic net over rendered strings and says so in its own header; it deliberately does not
  match bare long hex, because ObjectIds and upload fingerprints are logged legitimately.
- **The collection is capped, not TTL'd**, and has **no Mongoose model** — `autoIndex` would
  create it uncapped first, and a capped collection cannot be converted afterwards.
  `LOG_MONGO_CAP_BYTES` is a one-way door.
- **`requestId` reaches every line via an `AsyncLocalStorage` mixin**, not a child logger — a
  child would have to be threaded through ~500 signatures and could never reach a bridged
  `console.*` call. `requireAdminCaller` stamps the administrator too, so wi-admin's audit
  `correlation_id` and a jovi-mall log line share one value.

**Workers report three booleans, never one.** `scheduled` / `executing` / `manualClaim`, because three different things in this codebase were all called `running` and `GET /dev-tools/workers` reported the least useful of them — a scheduled sweep churning for ten minutes showed `running: false`. Schedules are **derived** from the value each worker schedules with (`core/jobs/worker-schedule.ts`); the old hand-typed strings were wrong for **eight of ten** workers. Two workers were missing entirely: `AssignmentSweepWorker` is now registered (it is the only thing advancing auto-assignment sessions, so a stalled sweep was invisible from every angle), and `InboundCalendarSyncWorker` appears in `WORKER_INVENTORY` but stays out of the triggerable `WORKER_REGISTRY` — "run it once" has no single meaning for it.

**Overlap is now PREVENTED, by one mechanism, for every one of them** — **18** today: 17 `*.worker.ts` files plus the aggregation scheduler (`core/jobs/worker-lock.ts` — audit finding F-19; design record `../admin/docs/ADR-014-SYSTEM-OPERATIONS.md` D-8-A). The old note here said "the seven cron workers"; it was **nine** — `analytics-aggregation` and both `inbound-calendar-sync` loops had the same unguarded shape and were simply not cron. ⚠ **Do not trust the number in this sentence over the one in the code**: it read "fourteen", then "fifteen", while three more workers landed under it (the trust recompute at Phase 6 Step 3, then the inventory reconcile and the storage invoice at Step 14). That is the same miscount, and it is why the source scan in `test:system`, not a hand-kept list, is what enforces the rule: every `*.worker.ts` plus the scheduler must call `withWorkerLock(`, and `WORKER_SOURCES.length === WORKER_INVENTORY.length` couples the count to the filesystem.

Five properties are load-bearing:

- **Two layers, and only one can fail.** An in-process `Set` is unconditional and closes the single-instance case; a Redis key on `WORKER_LOCK_DB` (`SET NX PX`, renewed while the sweep runs, released by a token compare-and-delete) closes the multi-instance one.
- **The Redis layer FAILS OPEN.** Failing closed would silently stop every sweep during a Redis outage, including the two that move money (`EarningsReleaseWorker`, `CodDepositDeadlineWorker`) — same argument as `FailOpenStore` in the rate limiter. `WORKER_LOCK_REDIS=false` disables that layer alone.
- **Every Redis call is bounded at 2s, and that is what makes "fails open" true.** A dead host does *not* reject promptly — node-redis retries the initial connect, so `getRedisClient` hangs for minutes and the `catch` never runs. Unbounded, the fix parks every sweep on connect: strictly worse than the overlap. A timeout means *don't know* → run; never *held* → skip.
- **The guard sits INSIDE the sweep, unlike the maintenance guard at the tick site.** Maintenance is a policy an operator may override (ADR-014 D-4); overlap is a correctness constraint, and an operator's intent does not make two concurrent writes to one earnings row safe. So a manual trigger beats a maintenance window and returns `200 { ran: false }` against a running sweep.
- **A refused pass is visible.** It counts as `worker_runs_total{outcome="skipped"}` and deliberately does **not** advance `worker_last_success_timestamp_seconds`, so a worker wedged behind an orphaned lock still trips the staleness alert. `executing` keeps its old meaning and is **not** derived from the lock — "idle here but refused because another instance holds it" must stay reportable.

⚠ Two entry-point signatures changed with it, and the `null` is the point: the counting sweeps return `number | null` and `analyticsAggregationWorker.runOnce()` returns `… | null`, where `null` means *refused*. A `0` means "nothing was due", which is a different statement.

### Notifications (`src/modules/notifications/`)
**Four** parallel multi-channel stacks — vendor, agency, agent, and **customer** — each its own model + preference + repository + catalog + event-handler + consumer, all following the same rules (mandatory in-app record, always-on FCM push, at most one preference-gated secondary channel of email/telegram/whatsapp, catalog-driven copy localized in en/fr/pt/es/ar with a startup completeness assert). They are deliberately **not** DRY'd into one generic stack: the copy is written per-audience and the situations barely overlap. When adding a situation, add its `base` copy in **all five languages** or the consumer throws at boot.

**Derive the Mongoose enum from the type union — never hand-maintain both.** Each stack exports a `*_NOTIFICATION_TYPES` array that the schema `enum` spreads. This is not tidiness: the agent stack kept two copies and they drifted, leaving all eight `agent_contract.*` situations in the union and absent from the enum, so every contract notification threw a `ValidationError` and the agent was simply never told. The same applied to its `aggregateType: 'contract'`. Covered by `npm run test:customer-notifications`, which asserts catalog↔enum agreement for **both** stacks.

**`shipment.status_changed` carries descriptive fields, and that is NOT a geo-tracker change.** `trackingNumber`, `failureReason` and `failureNote` were added for the customer stack's "on its way / attempt failed" copy. Since plan step 3.A.1 the reason is stronger than it was: this event **no longer reaches the outbox at all**, so nothing added to its payload can reach geo-tracker even in principle — the row is built from named fields by `TrackingOutboxEmitter`, in the transaction. They are taken from the shipment the CAS returned, not re-read: `delivery_failures` is append-only and `failed → in_transit → failed` is an allowed cycle, so a later read would describe the wrong attempt. **Two** subscribers share this event now (assignment, customer notifications) — the tracking one is gone; neither branches on the new fields.

**`renderTemplate` tidies whitespace after substitution.** Several situations end in an optional sentence (`{{codLine}}`, `{{reasonLine}}`), and an empty one otherwise leaves a trailing or doubled space that reaches push and email un-trimmed — only the in-app copy passes a `trim: true` Mongoose path. Runs of *spaces/tabs* are collapsed, never newlines: no catalog template contains one today, but a multi-paragraph email body added later must not be flattened.

**The customer stack is the newest, and two of its rules are its own.** (1) Times are formatted in the **customer's** timezone (`Customer.timezone`) before reaching a template — a reminder printing a UTC instant is worse than no reminder. (2) **Some situations cannot be muted.** Money (payments, refunds, balance due) and cancellations carry no key in `SITUATION_PREFERENCE`, so no preference silences them; a customer is the *counterparty* to someone else's action there, not the owner of a dashboard. Only progress reporting is gated (`bookingUpdates`, `bookingReminders`, `orderUpdates`; `marketing` is reserved and defaults **off**). Several events are consumed by two stacks at once (`booking.created`, `order.created`) — one event, two audiences, two entirely different messages, exactly as `cod.deposit.recorded` already works across agent and agency. Deep links use `STOREFRONT_URL`. The agent stack is the newest and narrowest — it exists because the COD cash chain moves an agent's money on an agency's say-so, and the agent needed a durable record of it (`cod.deposit.recorded` with no prior declaration is the agent's only signal that an agency under-recorded a hand-over). Some events are shared: `cod.deposit.recorded` is consumed by both the agent handler (all cases) and the agency handler (direct-to-platform only), each no-oping on payloads that are not theirs — the same pattern the `connection.*` events use across vendor and agency.

### Domain events (`src/core/events/event-bus.ts`)
In-memory, **per-process**, no persistence and no retry — a `Map<eventType, handler[]>` where `publish` awaits handlers in sequence and swallows their errors. Anything that must survive a crash or cross a process boundary needs its own durable buffer on top (this is exactly why the geo-tracker integration has an outbox).

Emission convention is **post-commit and fire-and-forget** (`void eventBus.publish(...).catch(log)`), so an event is never inside the transaction that caused it.

⚠ **That convention is exactly why the bus may not carry anything across a service boundary**, and since plan step 3.A.1 nothing does. The tracking outbox used to be reached through it and is now written inside the transaction (see `tracking-integration` below) — a census of all 73 publish sites confirms **no subscriber reaches the outbox**. Two properties make the bus structurally unfit for it: it cannot carry a Mongo `ClientSession`, and `publish` swallows handler errors, so a failed write is silent. **Before adding a subscriber that writes durable state, ask whether the state must survive a crash; if it must, the write belongs in the producer's transaction, not here.**

### Agent vs agency actions (important)
Shipment status transitions are **driven by either the agency or the agent** — two doors onto one state machine. `PATCH /api/agency/shipments/:id/status` → `ShipmentService.updateStatus(agencyId, …)` and `POST /api/agent/shipments/:id/status` → `ShipmentService.updateStatusByAgent(agentId, …)`. Both are thin ownership-scoping wrappers over a shared private `_transitionStatus`; the actor is a discriminated union, and only three things differ:

| | agency | agent |
|---|---|---|
| ownership scope | `findByIdAndAgency` | `findByIdAndAgent` (404, never 403) |
| transition map | `TRIGGERABLE_TRANSITIONS` | **the same map** |
| `status_history.changed_by_role` + audit `actorRole` | `'agency'` | `'agent'` |
| optional failure `reason`/`note` | no | yes, on `failed`/`returned` |

**There is ONE transition map, shared.** The agency and the agent have the same rights over the lifecycle — the agent is the person physically doing it, and the agency endpoint is the desk mirroring that. In particular `handing_over → picked_up|returned` is agent-reachable: **a reassigned shipment is not a second-class one**, and the replacement agent records their own pickup out of `handing_over` exactly as the original agent does out of `assigned` (acceptance binds `agent_id` while the status is still `handing_over` — see `bindAgentIfUnassigned` and `OFFERABLE_STATUSES`). If the two ever genuinely need to diverge, split the map and select on `actor.role` in `_transitionStatus` — don't let a role-specific exception creep into the shared one.

**Both paths write through a from-guarded compare-and-set** (`ShipmentRepository.applyStatusChangeIfCurrent`, filter `{ _id, status: fromStatus }` + the actor's ownership predicate) under `runInTransactionWithRetry`, and a miss is `409 SHIPMENT_STATUS_CONFLICT`. This is load-bearing now that two actors share the document: without it both can read `in_transit`, one write `agent_delivered` and the other `failed`, and the loser's post-commit block (earnings split, capacity release, COD return handling) still fires for a status nobody is in. Every side effect reads the document the CAS returned, never a fresh `findById` — verdicts must describe the status the event was emitted *for*.

The agent may attach an optional `reason` (`ShipmentFailureReason` — a **distinct** enum from `AgentCancellationReason`, see the model) + `note` on `failed`/`returned`; it is appended to the shipment's **append-only `delivery_failures`** array in the same atomic write as the transition. Append-only because `failed → in_transit → failed → returned` is an allowed cycle and each attempt's reason is the record. The agency endpoint stays reason-less by design.

The agent's other self-service write paths *on shipments*: **accept/reject an assignment offer** (`POST /api/agent/offers/:id/{accept,reject}` — the agent-acceptance workflow, see below), `POST /api/agent/shipments/:id/cancel` (release + re-offer mid-delivery), and `POST /api/agent/shipments/:id/cod/collect` (delivery-code submission — the only *API* by which a COD shipment reaches `delivered`).

**The tracking number is generated, not written.** `PATCH /api/{agency,agent}/shipments/:id/tracking-number` is **gone** on both roles: `ShipmentRepository.create` stamps every shipment with `ACR-YYMMDD-HHMMSS-XXXXX` (agency acronym from its Magazin name · UTC creation date · UTC time · 5 Crockford-base32 characters) via `shipments/utils/tracking-number.generator.ts`, and nothing else ever writes the field. Generating it in `create` rather than at the two call sites is the point — a third call site cannot forget. The acronym is **snapshotted**, never re-derived: an agency rename must not rewrite the reference a customer is already holding. Uniqueness is a partial unique index on `tracking_number` (partial so legacy `null`s don't block the build) with a pre-check in the generator; legacy rows are filled by `npm run backfill:shipment-tracking-numbers`. Pure parts are covered by `npm run test:tracking-number` (26 assertions, DB-free).

Agent-driven `picked_up`/`agent_delivered`/`failed`/`returned` also emit `shipment.agent_status_changed`, which the agency notification stack renders (`in_transit` is excluded as a routine progress ping). **geo-tracker needed no change**: `actor_role` is a free TEXT column there and already receives `'agent'` from the COD collect path.

### Agent-acceptance workflow (`src/modules/shipment-assignment/`)
Assignment is **offer-based, not a direct push**. `PATCH /api/agency/shipments/:id/assign-agent` (and `POST …/auto-assign`, gated by the agency's `assignment_settings.auto_assign_enabled`) create a `ShipmentAssignmentOffer` the agent must **accept** before the shipment is theirs. The shipment stays `assigned` (to the agency) with `agent_id = null` until acceptance — the moment `agent_id` is written, the shipment becomes trackable and (COD) the delivery code issues. **No new shipment status was added**, deliberately: that enum is the geo-tracker contract. State is mirrored on a `shipment.assignment` sub-doc (`unassigned | offered | accepted`), which is *not* the status. Auto-assignment is a **broadcast over a ranking session**, not a one-at-a-time relay: `autoAssign` ranks eligible agents nearest-first (Geo Provider road-network matrix, haversine fallback; location + trust gates on top of eligibility) and snapshots the pool onto a `ShipmentAssignmentSession`. The sweep (`AssignmentSweepWorker`, 30s) offers the next-nearest each `SHIPMENT_OFFER_TIMEOUT_SECONDS` (120s) window **while earlier offers still stand** — so several agents can hold a pending offer at once and the first to accept wins (a shipment-level bind CAS); a reject advances immediately, an ignore keeps an acceptable offer (**auto offers never expire** — only manual ones do, via `expireDueOffers`). After `MAX_ROUNDS` (2) passes — round 2 re-nudges ignored offers — the agency is told `shipment.assignment.unfilled`. An agent cancelling mid-delivery resumes the broadcast from its cursor; the session is disposed only on `delivered`/`returned`/`rejected`. Capacity admission control (`AgentCapacityService.tryReserve`/`release`) — previously inert — is now live: reserved on accept, released on `delivered`/`returned`/`rejected`, reconciled nightly. Full design in [SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md); API in `api-doc/agent/offers.md` + `api-doc/agency/assignment.md`.

**Auto-assignment** (the system-driven branch) is documented separately in [AUTO-ASSIGNMENT.md](./AUTO-ASSIGNMENT.md). It ranks up to 20 eligible agents nearest-first via geo-tracker's routing matrix (`GeoRoutingClient`, haversine fallback — geo-tracker stays off the critical path), stores the ranking as a temporary `ShipmentAssignmentSession` (cursor + round + state; deleted when the shipment finishes), and broadcasts down it one candidate per 2-min window across **two rounds**. Several agents can hold an acceptable offer at once — "first valid approval wins" is enforced by a shipment-level CAS (`ShipmentRepository.bindAgentIfUnassigned`) under `runInTransactionWithRetry`, **not** by an offer-uniqueness index (that index was removed). An agent may **cancel mid-delivery** (`POST /api/agent/shipments/:id/cancel`, reason enum + ≤200-char note) — `ShipmentService.releaseForAgentCancel` releases them and the broadcast **resumes from its cursor**. The `AssignmentSweepWorker` drives session advancement + manual-offer expiry, multi-instance-safe via guarded compare-and-set.

**Agent → agent reassignment** (`POST /api/agency/shipments/:id/reassign`, `ShipmentAssignmentService.reassign` → `ShipmentService.reassignAgent`) changes the agent handling a shipment — the critical case where the bound agent picked up but cannot deliver. It **releases** the old agent (session closed, not terminated — a `shipment.agent_released` event; capacity returned) then re-offers to a replacement who must accept before their tracking opens, so two agents are never tracked for one shipment. Detach is a guarded compare-and-set (`claimForReassignment`, the race guard → `SHIPMENT_REASSIGNMENT_CONFLICT`). Pre-pickup it resets to `assigned` (auto or manual); **post-pickup (`picked_up`/`in_transit`/`failed`/`returned`) it enters `handing_over`** — a new, trackable, non-terminal status that lasts until the replacement picks the parcel up — and is **manual-only** (`agentId` required). `reason` is mandatory. `handing_over` is a jovi-mall-only status addition (added to `TRACKABLE_SHIPMENT_STATUSES`, `ACTIVE_SHIPMENT_STATUSES`, fulfillment `SHIPPED_OR_BEYOND`); geo-tracker consumes the trackable *verdict*, not the status, so it needs no enum change.

**Secure handover:** clearing `agent_id` on detach revokes the old agent's access to customer PII, live tracking and shipment actions (all `findByIdAndAgent`-scoped → 404); they keep only their accepted-offer activity history and get a `shipment.reassigned_away` notification. **Dynamic pickup location** (`HandoverPickupService`): where the replacement collects is derived from the status at reassignment — `previous_agent_location` (picked_up/in_transit, from `last_known_tracking_state.last_position`), `original_pickup` (returned), `agency_business` (failed) — always overridable by the agency (`pickupLocation` in the body, `source: 'manual'`). It is stored on `shipment.handover.pickup` and mirrored onto the replacement's offer (`pickup_location`). A settled order is never re-opened (completed-order guard). Full design in [SHIPMENT-ASSIGNMENT.md](./SHIPMENT-ASSIGNMENT.md).

### The COD cash chain (`src/modules/cod/`)

Cash normally travels **Customer → Agent → Agency → Platform**, mirrored by two *independent*
liability balances: `collect()` credits the agent AND the agency, and each is discharged separately
(agent by an `AgentDeposit`, agency by a confirmed `AgencyRemittance`). The agency owes the platform
whether or not its agent has paid up — that independence is what caps the platform's exposure, and
must not be "simplified" into one balance.

**Every leg is two-sided, and each in its own way.** Customer→agent is proven by the delivery code (a
secret the payer holds). Agency→platform is declare + admin-confirm with an external transfer
reference. Agent→agency was the odd one out until step 3f — the agency simply typed a number, which
made its account of a handover unfalsifiable and left the agent wearing a `late_deposit` trust
penalty for cash the agency had not recorded. It is now declare (agent) → confirm/reject (agency),
with the agency's one-step `record()` kept for the desk. **A declaration moves no money** — that is
what stops an agent freeing their own headroom by lying.

`AgentDeposit.recipient: 'platform'` lets an agent bypass the agency entirely: it settles both legs
in one row (agent, contract, *and* the agency's liability + FIFO collection settlement). It is
bounded by the agency's live liability — if the agency already remitted that cash, the platform is
square and the agent genuinely owes the agency, so paying the platform again would only create a
refund obligation.

**COD delivery is closed to every other path, and that is deliberate.** For COD, `delivered` ⟺ cash collected — `recomputeCodPaymentStatus` derives the order's payment status from that equivalence, and `splitCodCollection` only ever runs off a collection, so a COD shipment that reaches `delivered` without one leaves an order that is delivered, completed, and that **nobody is ever paid for** (not even the vendor), with a payment status that is a lie. Consequently: the customer's `confirm-delivery` endpoint **rejects COD** (their code is their confirmation), and the shipment auto-confirm sweep does **not** confirm COD — it routes through `CashCollectionService.autoCollectWithoutCode`, which records the cash and delivers in one transaction. Any new route to `delivered` must go through a collection too.

### The earnings split (`src/modules/earnings/`)

One order's gross is divided across **two moments**, and that is the whole design. At **payment**
(`splitOrder`) only the platform commission and the vendor's net are allocated. The vendor's net is
already reduced by the delivery fee, but that fee is deliberately **not** given to anyone yet: at
payment success the shipments exist at `pending` with `agent_id: null`, and the agent who will earn
a share of that fee has not been dispatched. At **delivery** (`splitShipmentDelivery`, hooked
post-commit on `agent_delivered`/`returned` in `ShipmentService.updateStatus`) the fee is divided
between the agency and the agent who actually ran it.

```
gross = commission + vendorNet + Σ per shipment(agency + agent + vendor refund)
```

COD is the same shape with a different trigger: `splitCodCollection` pays all four parties off the
verified cash handoff, because that is when both the cash and the agent are known. **A prepaid
order never reaches `splitCodCollection` and a COD order never reaches `splitOrder`.**

Four rules that are load-bearing:

- **The agent's cut comes OUT of the agency's fee, never on top** (`fee_split` on their contract,
  clamped to the fee). The vendor pays the same either way. The agency *owes* it; the **platform
  pays** it, through the agent's own `EarningsAccount` — nobody is paid off-platform.
- **`delivery_fee_snapshot` on the Shipment is the contract between the two moments.** The fee
  derives from the agency's *mutable* `policies.pricing`; splitting at delivery would otherwise
  divide a different number than the vendor was charged. `splitOrder` writes it, the delivery split
  divides exactly it.
- **`EarningsCompletionService.onOrderCompleted` must sweep EVERY source type an order produced** —
  `order`, `cod_collection` *and* `shipment`. `markCompletedBySource` is keyed by source, and
  `findMaturedHeld` skips a null `hold_release_at`, so a source it forgets is money held forever.
  This has already been caught once (COD) and is the first thing to check when adding a source type.
  It is also what makes the hold uniform: **every actor on an order matures on the same date**,
  `HOLD_DAYS` (7) after the order completes — never at delivery, never per shipment.
- **A `returned` shipment still splits**, at the agency's `additional_fees.rto_fee` (clamped),
  with the unspent remainder credited back to the vendor. `failed` does not: it is not terminal
  (`failed → in_transit | returned`), so `failed_delivery_fee` needs its own charge path.

Both splits are post-commit and best-effort, so both have a recovery stage in
`EarningsReleaseWorker` (`recoverMissedCodSplits`, `recoverMissedDeliverySplits`).

**Payout destinations are ONE schema for all three owners** (`src/core/types/payout.types.ts`):
vendor, agency and agent each store an ordered `IPayoutMethod[]` (1–3, index 0 preferred), and
`PayoutRequest` snapshots index 0 at request time. Adding a *kind* means the discriminated union,
the Mongoose sub-schema, `maskPayoutMethods`, the vendor and agency DTOs' own copies of the masker,
and `describePayoutMethod` — five places, none of which the compiler will point you at except the
DTOs. The three kinds are `mobile_money`, `bank` and `card`.

**Which kinds may be CONFIGURED is a switch, separate from which exist** —
`ENABLED_PAYOUT_METHODS`, currently `['mobile_money']`. Two schemas express the split:
`PayoutMethodShapeZodSchema` is what a payout method *is* (all three kinds, always), and
`PayoutMethodZodSchema` — what every write path parses with — is the switch **piped in front of**
it, so a client posting a half-filled bank form hears "not available right now" instead of
"bank_name is required". Three things deliberately ignore the switch: reads (`maskPayoutMethods`
and both DTO maskers), the payout pipeline (`resolvePreferredPayoutMethod`, `describePayoutMethod`),
and the Mongoose enum. Switching a kind off must never hide an owner's stored destination or strand
money already addressed to one — it closes the door on *new* configuration only. Re-enabling is
adding the string back to that array; the tests assert the current setting rather than a hardcoded
one, so they follow it.

**`card` holds no PAN and no CVV, and that asymmetry with `bank` is deliberate.** A card's account
number *is* the PAN, so storing it the way `bank.account_number` is stored would put every
collection in PCI-DSS scope — the opposite of the rule `UserPaymentMethod` already established. A
card is identified by brand + last4 + holder + expiry, and the transfer rides an optional
`gateway_token`. The validator **refuses** `number`/`pan`/`cvv`/… rather than letting Zod silently
strip them: a client that gets a 200 back would otherwise reasonably believe the number is on file.
Don't "fix" that by adding the field. Contract is documented **per role** —
`api-doc/{vendor,agency,agent}/payout-methods.md`, one schema written out three times because each
role reaches it through different endpoints; change the schema and all three need the edit. Covered
DB-free by `npm run test:payout-methods`.

**All of the fee arithmetic lives in `EarningsQuoteService`, and `EarningsSplitService` calls it** —
that is what stops what somebody is *quoted* drifting from what they are *paid*. Four pure,
DB-free functions divide every delivery, and **both sides of the fee are named**:

| Function | Answers |
|---|---|
| `resolveEarnedFee(outcome, reservedFee, policies)` | what the run earned out of the reserved fee — the whole fee `delivered`, the clamped `rto_fee` `returned` |
| `applyFeeSplit(fee_split, earnedFee)` | the **agent's** cut, clamped to `[0, fee]` |
| `computeCodHandlingFee(config, collected)` | the COD charge, percentage-of-cash or fixed |
| `computeAgencyCut(earnedFee, agentCut, codFee)` | the **agency's** share — the complement of `applyFeeSplit` |

`agentCut + computeAgencyCut(...) === earnedFee` always. Covered DB-free by
`npm run test:earnings-quote` (29 assertions), which re-derives both split paths from these helpers,
so changing either side breaks the test. Add a fee component here, not at a call site.

Both roles are quoted from them before the money moves: `quoteForShipment(s)` is the **agent's**
offer-time estimate, `quoteAgencyForShipment(s)` the **agency's** (`earnedFee − agentCut +
codHandlingFee`, itemised) on their shipment list and detail. The agency's quote reports
`agencyEarningUnavailable: 'no_agent'` rather than a figure while a shipment is still out on offer —
there is no `fee_split` to subtract yet, and quoting the gross fee would show a number that drops the
instant somebody accepts. A missing *contract* is not unavailable: the cut is 0 and the agency keeps
the whole fee, which is exactly what the split does.

### Agent domain (`src/modules/agents/`)
The agent is a **platform identity, not an agency-owned record** — they sign up independently and may serve **several agencies at once**. `DeliveryAgent.agency_id` no longer exists; the relationship is a **contract** — `AgentAgencyContract`, one row per agent↔agency in `agent_agency_contracts` — with `AgentMembershipEvent` (`agent_membership_events`) as its append-only history.

⚠ **"Membership" is the OLD word and it survives in three places on purpose**, so do not treat any of them as a second concept: the file is still `models/agent-agency-membership.model.ts`, `AgentAgencyMembershipModel` / `MembershipStatus` / `LIVE_MEMBERSHIP_STATUSES` are backwards-compatible aliases of the contract exports, and the eligibility rule is still keyed `approved` on the wire (`membership_not_approved`). The events collection kept its name too. All four are one thing: the contract.

**Statuses are `pending · rejected · withdrawn · active · paused · suspended · deactivated`, and `approved` is NOT among them** — approving is an *action*, and it lands the row in `active`. `withdrawn` arrived with the symmetric handshake and is deliberately outside `LIVE_CONTRACT_STATUSES`, so a withdrawn request does not block the re-request it exists to permit. Three lists derive from that enum and none is a synonym for another: `ALLOCATING_CONTRACT_STATUSES` (`active|paused|suspended`) consume the COD pool, `LIVE_CONTRACT_STATUSES` back the partial unique index on `(agent_id, agency_id)`, and `COUNTED_CONTRACT_STATUSES` bound the max-relationships cap.

**The rule for any new agent field: if the value could differ per agency, it belongs on the contract.** Employment terms, coverage, the fee split and the contract's COD **threshold** are per-contract; identity, trust score, availability, device and tracking permission are per-agent.

⚠ **The COD limit is a SHARED POOL, not a per-agency cap, and that is the whole refactor.** The agent owns one `cod.max_threshold`; every contract's `cod.threshold` is a **sub-allocation** of it, and `AgentCodThresholdService` enforces `Σ (allocating contracts' thresholds) ≤ the agent's pool` from both directions, inside the caller's transaction. The old `cod.max_exposure_override` was an *independent* cap per agency — three agencies could each grant 1M to an agent willing to hold 1M, and the platform discovered the 3M of real exposure only when cash went missing. A pool cannot be over-committed by construction. Lowering a threshold below that contract's outstanding balance is a hard rejection with no side effects. ⚠ One naming leftover: `CodExposureService.effectiveLimit(agent, maxExposureOverride)` is still named for the dead field and its `?? AGENT_MAX_EXPOSURE_DEFAULT` fallback is dead — both call sites pass a definite number. Left alone deliberately (live dispatch path, cosmetic rename); tracked in the handoff doc.

**The handshake is symmetric, and the terms are NEGOTIATED.** Both directions —
`requestFromAgency` (an agency naming a specific agent, **terms required**) and `requestToJoin` (an
agent applying, terms optional) — land in `pending`; neither shortcuts to `active`.

Who may answer is derived from **`terms_proposed_by`**, not from `origin`, by
`AgentContractService.proposerOf`: the counterparty of the standing proposal `approve`/`reject`s or
**counters**, the proposer `withdraw`s, and asking for the wrong one is a 403. A counter overwrites
the terms, flips `terms_proposed_by` and bumps `terms_version` — which is exactly what `origin`
cannot express, being immutable. `origin` survives as audit plus the **fallback** for legacy rows
(`proposerOf` reads it when `terms_proposed_by` is null), which reproduces the old behaviour
exactly. The DTO exposes the verdict as **`awaitingDecisionFrom`**; `initiatedBy` is still there but
is no longer the button rule.

Scoping *all three* of approve/reject/withdraw to the proposer is load-bearing, not tidiness. Key
`withdraw` on `origin` instead and an agency-invited contract the agent counters leaves the agency
two exits (withdraw as initiator, reject as counterparty) and the agent **none** — trapped inside
their own counter-offer. See `PROPOSER_SCOPED_TRANSITIONS`.

**Terms nobody proposed cannot be approved** (`assertTermsApprovable` → 422
`CONTRACT_TERMS_NOT_PROPOSED`). One guard covers three cases: a bare agent join-request, a legacy
row whose fee split was never configured, and the `contractDefaults.feeSplit()` trap — a
`percentage` model with a null share, which `applyFeeSplit` resolves to a cut of **zero**. Before
this, approving such a contract bound the agent to being paid nothing and nobody was asked.

**A live contract's terms change by proposal, never by edit.** `ContractTermsProposal` is a separate
collection precisely so the agreed `fee_split` keeps applying while a change is pending —
`EarningsQuoteService` goes on dividing by it, unaware the model exists. `PATCH …/terms` is
status-aware: on `pending` it delegates to `counterTerms` (one code path, no drift); on a live
contract it is **409 `CONTRACT_TERMS_LIVE_EDIT_NOT_ALLOWED`**. Formation and amendment differ
because a pending contract *is* the offer while a live one *has* one — don't unify them.

The agent's levers are **`fee_split` + `coverage` only** (`AGENT_NEGOTIABLE_TERM_GROUPS`).
`employment` and `cod.threshold` are outside negotiation entirely and keep their own unilateral
routes — the first is the agency's HR record, the second a pool sub-allocation that must stay
transactional.

**Discovery is the front door, and the email-invite subsystem is gone.** `AgentInvite` (model,
repository, service, and all six routes) was deleted: an agency finds agents through
`GET /api/agency/agents/browse` and requests one by id, and an agent finds agencies through
`GET /api/agent/agencies/browse`. `AgentDirectoryService` owns both, deliberately apart from the
contract FSM. The directory's hard filter is `assertCanHoldContract` plus completed onboarding —
listing an agent who cannot accept would render a button whose request dead-ends. Exposure is a
**public work profile only**: `AgentDirectoryMapper` never emits email, phone, `legal_identity`,
`payout_details`, `emergency_contact`, device telemetry or raw capacity counters, and load is the
`working_state` label rather than a count. `AgentRosterEntryDto` *does* carry contact details — the
two DTOs answer different questions and must not be merged. The cost of dropping invites, accepted
knowingly: an agency can no longer approach someone who has not signed up yet.

**The whole surface is an endpoint-for-endpoint mirror of `agency-connections/`, on purpose.** Four
verbs — `approve`, `reject`, `withdraw`, `terminate` — mean the same thing on all four routers of
both flows, plus `browse` / a request POST / a paginated list / a single GET. Don't reintroduce a
role-specific spelling: the HTTP verbs used to say `accept`/`decline` on one side while the FSM said
`approve`/`reject`, and that split bought nothing. `POST /:id/terminate` is canonical on the agency
side; `DELETE /:membershipId` is the same handler under its original name. `deactivate` is
deliberately **not** in `RequestTransitionSchema` — `/terminate` owns it, and leaving it in the
dispatcher would be a second way to end a contract with a different status code.

**Both list endpoints return every status by default**, terminal rows included, and paginate exactly
like `ConnectionRepository.listForVendor` (`{ data, meta: { total, page, limit, pages } }`, renamed
to `totalPages` on the wire). The old live-only default made a relationship history impossible to
fetch. Nothing on the dispatch path reads them — eligibility and COD go through `findActive` /
`findLive` / `listAllocating`, which are still status-scoped. The admin agent view uses
`listAllForAgent` and stays unpaginated: an investigation must not lose rows to a page boundary.

Four state axes are kept deliberately separate — collapsing any two makes "is he offline, or just full?" unanswerable:

| Axis | Question | Written by |
|---|---|---|
| `status` | may this account work at all? | admin |
| `availability` | does the agent *want* work now? | the agent |
| `working_state` | how loaded is he? (derived from shipment counts) | system |
| `tracking.allowed` | may he be tracked? | admin (`PUT /api/internal/admin/agents/:agentId/tracking-allow`) — there is no agency or agent write path |

Two more are worth knowing because nothing agent-facing writes them either: `kyc.status` (admin;
**eligibility passes only on `verified`**, so an unverified agent is undispatchable) and
`capacity.max_active_shipments` (the billing plan, via `AgentPlanCapacityConsumer` — never the
agent, or a plan renewal would undo it). Both are readable on the agent's profile.

Note the two active-shipment counters are **not** interchangeable: `capacity.active_shipment_count`
is authoritative — it is what `tryReserveCapacity` compare-and-sets on accept — while
`working_state.active_shipment_count` is a recomputed input to the label above and can lag it.
Report the former.

#### Agent trust score: live vs shadow

**Two numbers exist, one is live, and mixing them up moves real cash.**

| Field | Written by | Read by | Status |
|---|---|---|---|
| `cod.trust_score` | `CodTrustService.applyEvent` — deltas, `+`/`−` per event | `CodExposureService` → the agent's permitted cash | **LIVE** |
| `trust_signals.composite_score` | `AgentTrustRecomputeWorker` via `agentRepository.setTrustSignalsShadow` | `npm run audit:trust-shadow`, and **wi-admin's** agent read (`compositeScore`) | **SHADOW — read by nothing that decides anything** |

The composite is the design locked with the product owner (`AGENT-CONTRACT-REFACTOR.md` § "Decisions locked"): a pure function of five weighted factors — **COD 30 · activity 20 · customer rating 30 · agency rating 10 · vendor rating 10** — recomputed nightly, replacing the delta model. `AgentTrustService` splits deliberately into `computeComposite(signals)` (**pure**, no I/O, no clock — this is what `test:agent-trust` asserts) and `collectSignals(agentId)` (the I/O half). `agent.config.ts` throws at import if the weights don't sum to 100.

**A factor with no evidence resolves to the SEED, never to zero** — zero would assert "untrustworthy" where the truth is "we do not know". Below `TRUST_MIN_OBSERVATIONS` (5) a rating factor blends toward `TRUST_SCORE_SEED`.

⚠ **`TRUST_SCORE_SEED` is 100 and `TRUST_SCORE_MAX` is 100, so the seed IS the maximum**, and three things follow that are easy to misread: an unmeasured factor contributes its **full** weight rather than a neutral one; sparse evidence is pulled *upward* (a genuine 3-star average from one review resolves to 0.92 on that factor); and therefore "every delta is ≥ 0" on a roster with no reviews is **arithmetic, not a finding about the agents**. This is the locked design — *a new agent is trusted by default* — not a defect. `audit:trust-shadow` prints rating coverage beside every row so the table cannot be read without it.

**Why it is still a shadow.** Flipping is a **one-line** change in the worker (`setTrustSignalsShadow` → `setTrustScore`), and it is held back by two measured blockers, not by caution:

- **There are zero delivery reviews**, so all 50 rating weight still resolves to the seed on every agent and the composite is structurally incapable of lowering anybody. `modules/reviews` gave those three factors a *source* (Phase 6 Step 10); it did not give them *values*.
- ~~**The flip erases every administrative adjustment.**~~ ✅ **CLOSED 2026-08-23 — O-7 answered, and the mechanism is built.** Measured on the dev roster: an agent the platform had **blocked** at a live 35 scores **100** under the composite, so the next nightly recompute would have handed them full cash exposure. The owner chose the **persistent override**, and it exists: `cod.trust_override`.

  **It is a separate field read at decision time, and that is the whole design.** `resolveEffectiveTrustScore(agent)` is the one resolver; `CodExposureService` reads it at both decision points and **never** `agent.cod.trust_score`. Because the override is not coupled to whichever mechanism computes the score, it behaves identically before and after the cutover, and **no recompute can erase it — none writes the field at all.** `setTrustOverride` is its only writer.

  It wins in **both** directions — not a floor, not a ceiling. `reason` is required (this outranks the entire scoring system, so an unexplained pin is unreviewable), the write appends a `CodTrustEvent` with `delta: 0` (truthfully — the *computed* score did not move), and releasing returns the agent to what the platform thinks **today** rather than to what it thought when they were pinned. `PUT /api/internal/admin/cod/agents/:id/trust-override`, `score: null` releases. ⚠ Do not "tidy" this into a write to `cod.trust_score`: that is precisely what does not survive, and it is the failure O-7 was raised about.

Run `npm run audit:trust-shadow [-- --json]` to see the two numbers side by side (READ-ONLY; it recomputes in memory and persists nothing — it does not even refresh the stored shadow). ⚠ **No jovi-mall DTO carries `composite_score`** — not the directory, not the profile, not the COD self-view, all of which report `cod.trust_score` as `trustScore`. The shadow is visible through that script and through **wi-admin**, whose agent read projects it field by field. The decision, its table and the trigger for reopening it are `../PRODUCTION-READINESS/PHASE-6-UNBUILT-SCOPE-PLAN.md` Step 11.

**The nightly sweep is not the only recompute.** `recomputeOne(agentId)` runs synchronously-ish (`void`-dispatched, self-catching) after two writes: a COD discrepancy resolution (`CodTrustService`) and a review that moves an agent's aggregate (`ReviewService`). That closes the safety regression the refactor flagged — with nightly-only recompute a cash shortfall would not throttle an agent until the next night, where the delta model's `−20` is instant. The sweep is the backstop, not the mechanism. Cadence and kill-switch: `AGENT_TRUST_RECOMPUTE_CRON` (default `0 3 * * *`) and `AGENT_TRUST_RECOMPUTE_ENABLED`.

⚠ **One writer at every hop, and `test:agent-trust`'s source scan is what keeps the shadow a shadow** — it asserts the worker never writes `cod.trust_score`. Do not "tidy" `setTrustScore` and `setTrustSignalsShadow` into one repository method: the two-method split is the seam the scan reads.

Consume the domain through the barrel (`src/modules/agents/index.ts`) — **except routes**, which the API layer imports directly from `routes/*`. Routers pull in `auth.middleware` → `auth.service` → the barrel; re-exporting routes from it closes a require cycle that crashes at boot with "AuthService is not a constructor".

**Eligibility** (`agent-eligibility.service.ts`) gates assignment on the agent: active · an **`active` contract** with the *dispatching* agency · online · tracking allowed · device location not disabled · under capacity. It reports **every** failed rule at once, never just the first. An agent may hold several active shipments — capacity bounds that, and counts across all agencies. Note the second rule is still **keyed `approved`** on the wire and reports `membership_not_approved`; that is the old vocabulary kept for clients, and what it tests is `findActive` — `paused` and `suspended` contracts fail it even though they still consume the pool.

**Contract terms gate the SHIPMENT, and live elsewhere.** `evaluate(agentId, agencyId)` takes no shipment, so a rule that needs one cannot go there. `contract-coverage.service.ts` holds the two pure predicates — `contractCoversRegion` (against `order.delivery_address.components.region`) and `contractAllowsShipmentValue` — enforced in `AssignmentCandidateService.buildRanking` (the auto pool) and in `ShipmentAssignmentService.assertContractPolicy`, which runs on **all three** command paths: `offerToAgent`, `accept` and `reassign`. Gate the ranking but miss a command path and a manual assign silently bypasses the term, which is worse than not enforcing it — the rule would appear to work.

**Everything unknown here FAILS OPEN.** Empty `coverage.regions` is the schema default on every contract ever written, so treating it as "covers nowhere" would make the whole roster undispatchable at once; a missing delivery region (orders predating the snapshot) and an uncomputable shipment value do the same. These are narrowing terms, not authorization — see the header of `contract-coverage.service.ts`.

**Writing coverage is the strict half, and that asymmetry is the design.** `coverage.regions` used to be free text; it is now **picked**, from the agency's country's region catalogue in `locations.json` — the same list the agency's own `coverage_areas` use on its location tab. `normalizeContractRegions` (third pure function in `contract-coverage.service.ts`) canonicalises every write and refuses anything that does not resolve to a region of that country: `"Extrême-Nord"` → `far_north`, `"Douala"` → `400 CONTRACT_COVERAGE_REGION_INVALID`. It runs through **one choke point**, `AgentContractService.normalizeCoverageTerms`, called on all six terms-write paths (both request paths, `updateTerms`→`counterTerms`, `counterTerms`, `proposeTermsChange`, `counterTermsProposalAs`) — a term is only as good as its weakest write path. Reading still fails open for the legacy free-text rows. The catalogue is the **country's**, deliberately not the agency's declared areas (an agency contracts agents for a region before it declares it); the agent side is given `agencyCountry` + `agencyCoverageAreas` on `AgentMembershipWithAgencyDto` so its picker can scope itself and mark what the agency actually serves.

**`remittance_terms` drives the COD late-deposit clock** via `nextRemittanceDueAt` (pure, UTC, `on_demand` ⇒ no deadline ever). `CodDepositDeadlineWorker` iterates **contracts, not cash accounts**: the agent's cash pot is global while the cadence is per-agency, so there is no single deadline to compare a pot against. The `late_deposit` flag is now per-contract while the trust penalty stays agent-global and applied once — four agencies must each learn they are owed, and the agent must not take four penalties for one bad week.

**Device location** is the one input jovi-mall cannot observe; it resolves via `IAgentDeviceLocationProvider` (`ports/device-location.port.ts`), swapped in `agent.bootstrap.ts`. The signal is tri-state and `null` (unknown) must never be coerced to `false` — that would make every agent ineligible the instant geo-tracker went down. Policy for unknown lives in `AGENT_CONFIG`, not in the rule.

**Tracking split:** jovi-mall owns whether tracking is *allowed*; geo-tracker owns *execution*. `agent.last_known_tracking_state` is a business mirror, stale by construction — never serve it as a live position, and no assignment rule reads it.

**The admin tracking flag now actually reaches geo-tracker (Phase 9).** `agent.tracking_allow_changed` was published from the day the flag existed and **nothing subscribed to it**, so disabling tracking refused new dispatch (`assertEligible`) and changed nothing else — the agent kept streaming and kept being broadcast. `setTrackingAllowed` now writes an `agent.tracking_allow_changed` outbox row carrying `trackingAllowed` and **no shipment verdicts** (it says nothing about any shipment), the dispatcher POSTs it to `/webhooks/node`, and geo-tracker suppresses the live position. ⚠ Since plan step 3.A.1 that write is **inside a transaction with the flag itself** — the method had none, and this is the one event with no reconciliation path on geo-tracker's side, so a row lost between the flag write and its enqueue meant an administrator was shown success while the agent went on broadcasting indefinitely. `TrackingAllowReconcileWorker` is the second line. **This changed the outbox event shape, so it was a two-repo change** — `webhook/domain/entity.go` gained `TrackingAllowed *bool` in the same commit. Note what it still does not do: `visible-agents` does not consult the flag, so a watcher is not revoked — they stay subscribed and receive nothing.

Because `assertEligible` requires tracking-allowed before dispatch, geo-tracker **refuses** an agent's attempt to switch Tracking Allow off while they hold an active shipment (it would strand a delivery assigned on that promise). Note what Tracking Allow is *for* on geo-tracker's side: it is the permission to read an agent's **live position at all** — including an agent with no shipment, which is exactly the read that finds the one nearest a pickup. It is not what starts a tracking session; only a shipment is.

**Migrations here were for LEGACY data, and D-5 says there is none — so the last one is gone.** `migrate:agent-memberships` carried a pre-refactor `DeliveryAgent.agency_id` into one contract row, and it was **deleted 2026-08-23** (Phase 6 Step 17) along with its npm binding and its `MIGRATIONS` row. It was not merely redundant: it wrote `status: 'approved'`, a literal retired from `ContractStatus` at the refactor, so its create would have thrown a Mongoose `ValidationError` and its idempotence filter could never have matched its own rows. Repairing it would have moved the checksum of an already-applied migration to fix a script whose only job is to carry rows D-5 says will never exist. Its `schema_migrations` row survives as history and is not reported. The **collection rename** (`agent_agency_memberships` → `agent_agency_contracts`) and the **`cod.outstanding_balance` backfill** were never written and are **closed as not applicable pre-production** — the code has been post-rename throughout, and the fix for the balance went into `seed:cod-shipments` rather than into a backfill of rows nobody is keeping. See `AGENT-CONTRACT-REFACTOR.md` § "Not built at all" item 4.

The orphaned `agent_invites` collection — nothing anywhere reads it — is dropped by `npm run migrate:drop-agent-invites`, a ledgered migration as of 2026-08-19 rather than the manual call this line used to describe. It is the only destructive one; read its `--dry-run` output before applying it anywhere you have not personally inspected.

### Base repository (`src/core/repositories/base.repository.ts`)
Generic `BaseRepository<TDoc, TDomain>` provides: `findOne`, `findById`, `paginate`, `create`, `softDelete`, `restore`, `hardDelete`. All queries automatically filter `deletedAt: null`. Pass a Mongoose `ClientSession` for transactional operations.

### Storage (`src/core/storage/`)
Factory + Strategy pattern. Active provider is selected via `STORAGE_PROVIDER` env var (`local` | `firebase` | `cloudinary`). Use `getStorageProvider()` singleton — never instantiate providers directly. Interface: `IStorageProvider` in `storage-provider.interface.ts`.

**Three storage trees are PRIVATE, and the classification is `core/storage/storage-trees.ts`** (ADR-A01 D-2). `digital/`, `shipments/` and `ticket-attachments/` are off `express.static`; every other tree is mounted, and the mount list is **derived** from that table so the two cannot drift. An **unknown tree is private** — `isPrivateStorageKey` fails closed, so a tree added next year is private until somebody classifies it, and `test:uploads` fails if any `folder:` literal is unclassified rather than letting its files 404 silently.

The enforcement is `toFileDetail`: a private key gets **`url: null`** and `access: 'authorized'`, and the bytes come from the owning entity's own route (`GET /api/digital/download/:token`, `GET /api/{agent,agency}/shipments/:id/delivery-proof/file`). `url` is `string | null` rather than an authorized path **because a path is a string indistinguishable from a public URL** — clients would keep rendering it into nothing; the type change makes the compiler produce the migration list instead.

⚠ **A new storage provider can undo all of that without touching either file.** The rule lives in `toFileDetail` and the mount list, *not* in any provider, so an object-storage provider returning a public CDN URL silently republishes the private trees and no test fails. The reasoning is written at the provider switch in `storage.factory.ts`, where the next author will be standing.

⚠ **`storage/ticket-attachments/` has NO WRITER** and holds one legacy file. A ticket attachment today is an ordinary `by-type` upload landing in `documents/` or `images/` — **beside public product imagery** — and attached by id afterwards, so it cannot be made private by moving a tree. That half of D-2 is open and needs a dedicated ticket-attachment upload path.

### Upload security (`src/core/uploads/`)

**Every upload path goes through `UploadIntakeService`, and `resolveVirusScanner()` is the only place a scanner is constructed.** Before Phase 4 the configuration named a provider and nothing read it: `UPLOAD_VIRUS_SCAN_PROVIDER` was parsed and never used, and each site hand-built a no-op — two `NoOpVirusScanner` definitions plus a `MockScanner` on the **digital-products** path, the tree whose bytes travel furthest. Nothing was scanned while the config said otherwise.

Three rules hold it together, and each exists because the obvious version failed:

- **The factory is the only door**, asserted by source scan. The reason this finding survived is that *a scanner which does nothing is indistinguishable from one that works* — same shape, same latency, same log line — so it can only be prevented structurally, never by testing the happy path.
- **A provider that cannot scan REFUSES, at boot.** `cloud`, a typo, and `mock` under `NODE_ENV=production` all throw `CONFIG_INVALID_UPLOAD_SCANNER` from `assertUploadScannerSafe()`, beside `assertSigningSecrets()`. `mock` is the fallback, so "forgot the variable in production" is the *default* misconfiguration and it does not start. `UPLOAD_VIRUS_SCAN_ENABLED=false` is logged rather than refused — that variable claims nothing, and the finding was about a config that *claimed* to scan.
- ⚠ **No config factory may write its own `virusScan` block.** All of them spread `resolveVirusScanConfig()`. Four used to hardcode `provider: 'mock'`, so only *one* of the wired sites actually scanned: in development the digital-products path stayed unscanned, and in production three paths threw on every upload — with the boot guard passing, because it checks the one config that was already right. `test:uploads` scans for a `provider:` literal.

**`ClamAVScanner` speaks `clamd` INSTREAM over a raw socket** (no dependency; `clamscan` shells out to binaries the runtime image lacks). One **whole-operation** deadline, deliberately not `socket.setTimeout` — an idle timeout restarts on every byte, so `blockOnFailure` never gets a verdict. ⚠ Its reply is **NUL-terminated with no newline**, so an anchored `/…FOUND$/m` matches nothing; that was a live bug every source scan passed, and `test:uploads` now pins the wire protocol against a fake daemon.

⚠ **The two policy-document endpoints used to bypass all of this** (`POST /api/{vendor,agency}/profile/policy-documents`), calling `storageProvider.put` directly with only a **client-claimed** MIME check. They go through `PolicyDocumentUploadService` now. **The trap that makes it non-trivial**: a `File` with no reference is *permanently deleted* by `LonelyFileDeletionService` (its clock falls back to `createdAt` for never-attached uploads), so the service writes a `file_reference` **at upload** — otherwise routing them through the pipeline would trade an unscanned upload for the loss of every vendor's policy PDFs. Accepted cost: an uploaded-but-never-submitted document is retained, a leak rather than a loss.

### Geocoding & geospatial addresses (`src/core/geocoding/` + `src/core/types/geo-address.types.ts`)
Same factory + strategy + singleton shape as storage. Active provider is `GEO_PROVIDER`: `nominatim` (the keyless default), `geoapify`, `locationiq`, or — **the intended production setting** — `chain`. `google | mapbox | here` are named seams with no adapter and the factory throws `GEO_PROVIDER_NOT_CONFIGURED` for them, so what is missing stays visible.

**`chain` is a failover order, not a provider** (ADR-A04 **D-3**, answering O-5). Every provider with a usable free tier caps out in the low thousands of calls a day, so picking one just moves the ceiling; the chain **adds the allowances together** — `GEO_PROVIDER_CHAIN=geoapify,locationiq`, with keyless Nominatim always appended last. Four rules:

- **Order is load-bearing and is NOT the daily allowance.** Geoapify leads (3 000/day, **5 rps**, *soft* limits) and LocationIQ reserves (**5 000/day**, 2 rps, *hard* — 429 immediately). Autocomplete is bursty: three keystrokes in a second is already over LocationIQ's limit, so leading with it 429s during ordinary typing while its larger allowance sits unspent.
- **It falls over on a 429/outage AND on an empty result** — coverage genuinely differs on Cameroonian addresses. It does **not** fall over on `GEO_SEARCH_FAILED`: a malformed query is malformed everywhere, and a **401** must surface rather than be papered over by the reserve. Every provider failing re-throws; a 429 *then* an honest miss is a **miss**.
- ⚠ **The chain is never stored.** `GEO_PROVIDERS` has `locationiq` and deliberately no `'chain'` — that value is persisted on every `GeoAddress.provider` and must name the *service* that resolved it, or `provider_place_id` stops being resolvable. Candidates pass through untouched.
- **A missing key skips its provider with a warning; a misspelt name is fatal.** The first lets one setting serve a keyless laptop and a two-key production host; the second stops a deployment running on its fallback while believing it runs on its primary.

⚠ **Neither paid adapter has been run against a live key.** `npm run verify:geocoding-providers` is the check — field mapping, the `[lng, lat]` **order** (a swapped pair puts Douala in the Gulf of Guinea, and both halves stay plausible numbers), and that a no-match returns `[]` rather than throwing. It **skips green** without a key and says so loudly. `npm run test:geocoding-chain` (25, no DB, no network) covers the failover rules against fakes, because a real 429 cannot be produced without burning a day's quota. Use `getGeocodingProvider()`; the interface is `IGeocodingProvider` (`search` + `reverse`). **No business logic ever branches on the provider.** The HTTP surface is `src/modules/geo/` → `GET /api/geo/search` + `GET /api/geo/reverse` (any signed-in role), backing a Maps-style "type → search → select → store" flow.

The stored value object is **`GeoAddress`** (`geo-address.types.ts`): `formatted_address` + `coordinates` (GeoJSON `[lng,lat]`) + `provider` + `provider_place_id` + structured `components` (city/region/country/postal…) + `raw_input`. It is embedded at all five address sites — customer `saved_addresses[].geo`, vendor `business_addresses[].geo`, agency `headquarters_addresses[].geo`, the order pickup snapshot (`items[].delivery.pickup_location.address_snapshot.geo`), and the order **drop-off** (`order.delivery_address`, snapshotted at checkout). Adoption is **additive**: legacy loose fields are kept and geo is optional at the schema level, enforced on write by the Zod validators; use `toGeoAddress` / `withGeoAddress` (`geo-address.types.ts`) to normalise a validated candidate before persisting. A `2dsphere` index sits on every `…geo.coordinates`. Full contract: `api-doc/geo/README.md`.

Geocoding lives in jovi-mall by the governing rule: an address is order/profile-model data, and jovi-mall owns that — geo-tracker owns live positions and road networks, not address resolution. The order's durable geocoded drop-off is **available to geo-tracker routing** but was a **data-only** change: no outbox event shape changed, so geo-tracker code is untouched.

### Pickup locations, and which agency depot (`agency_address_id`)

A physical product's `delivery.pickup_location` is `{ source, vendor_address_id, agency_address_id }`, and **exactly one id is meaningful per source** — `mergeDeliveryConfig` normalises the other to null rather than trusting the caller, so a stale id can't resurface if the source is flipped back.

The two sources snapshot **different amounts** onto the order at checkout, and the asymmetry is the design:

| | `vendor_address` | `agency_storage` |
|---|---|---|
| snapshotted onto the order | the whole address (`address_snapshot`) | only the **choice** (`agency_address_id`) |
| address resolved | frozen at checkout | **live**, every read |
| why | it is the vendor's record of a place they chose per product; history must not re-point when they edit their profile | the depot's address is the *agency's* record — an agent must be driven to where it is now, so a corrected typo fixes every in-flight shipment |

**`agency_address_id: null` means the agency's PRIMARY depot** (`headquarters_addresses[0]`), and that is a real steady state, not a missing value: it keeps tracking the primary if the agency reorders. Three populations rely on it — every product predating the depot picker, every auto-derived one (`PickupLocationResolver` deliberately never picks a depot, even when the agency has exactly one), and any product whose depot the agency later deleted. Consequently **activation can never fail over a depot**, and no backfill was needed.

**`resolveHqAddress` (`magazin/domain/hq-address.resolver.ts`) is the only place that fallback lives.** Four readers route an agent off it — `ShipmentService._resolvePickupEntries` + the detail builder, `AssignmentCandidateService.resolvePickupLocation`, and `HandoverPickupService.fromAgencyBusiness` — and they resolve **per item**, not per shipment, because two items can name two depots of one agency (the pickup dedupe then correctly reports two stops). `MagazinRepository.findHqAddressListsByAgencyIds` returns the whole list for the batch paths; it replaced the old index-0 method rather than sitting beside it, so nothing can keep resolving the primary by accident.

**HQ subdocument `_id`s are now a durable reference, and the magazin PATCH is a full-array replace.** `MagazinHeadquartersAddressSchema` accepts an optional `id` that clients echo back; `toPersistableHeadquarters` sets `_id` from it, and falls back to a **one-to-one consuming** content match (`address_description` + `geoAddressEquals`) for clients that don't. An `id` not on the caller's own magazin is `409 MAGAZIN_CONFLICT` — same remedy as a version miss. Both write paths (`PATCH /api/agency/magazin` and onboarding Step 1) must pass the **raw** `headquarters_addresses` for preservation, never the country-gated `existingHq`, or a country change re-mints every `_id` and orphans every product pointing at one.

`PickupLocationValidationService` takes depot **ids** (`string[] | null`) as a required 4th parameter rather than the magazin document — it stays repository-free, and required-not-optional so a new call site must decide instead of silently skipping the check. Both call sites load the list only when a depot was actually named. The vendor-facing picker is `GET /api/vendor/delivery-agencies/:agencyId/locations` (connection-gated) — the one place the "only the primary HQ is exposed" rule in `VendorAgencyMapper.toListItemDto` is narrowly reversed.

Covered DB-free by `npm run test:pickup-depot`.

### Agency inventory (`src/modules/inventory/`)

`agency_stock_levels` — `(agency_id, location_id, vendor_id, product_id, variant_id)` + `quantity_on_hand` / `quantity_reserved` — is the platform's only record of **what an agency warehouses**. Before it, `agency_storage` was a routing flag carrying no quantity and `ProductVariant.stock` was one global scalar with no location dimension. `GET /api/agency/inventory` + `/:id` read it.

**A row is DERIVED until somebody counts it, and the wire says which** (`countsAreDerived` + per-row `source: 'derived' | 'counted'`). `AgencyInventoryReconciler` builds the roster from products whose pickup is `agency_storage` and whose effective agency is this one, one row per active variant, with quantities of **0**. Do not seed those from `variant.stock` — that is the vendor's global number across every channel, and copying it per depot manufactures precision nobody can verify. Reconciliation is **mark-and-sweep** (one shared `last_reconciled_at`, then retire older `derived` rows); `source: 'counted'` rows are **never** swept, because once a row asserts goods are physically present a config change must not silently delete it.

**Counted quantities are real since Phase 6 Step 14 (D-6), and intake is what creates them.** A row becomes `counted` on its first `receipt` or `count_adjustment` — never automatically — and from then on the order path projects onto it and the storage statement bills against it. Four rules hold the design together:

- **`AgencyStockMovementRepository` is the only writer of the two counters**, and it writes the counter and its ledger row in one transaction, so `quantity_on_hand === Σ on_hand_delta` is true by construction. The reconcile worker checks it anyway and repairs the counter *to* the ledger (never the reverse, and never against `variant.stock` — P-14's lesson: assert the invariant the application maintains, not a re-derivation from another collection). `setCounters` is the single documented exception and exists only for that repair.
- **The non-negative rule is ASYMMETRIC.** An agency movement that would drive a counter below zero is refused (`422 INVENTORY_INSUFFICIENT_STOCK`); a system movement is not. If the shelf record says 0 and an order sells one, refusing would fail a checkout over bookkeeping and clamping would break the invariant above — a negative balance is the variance an agency settles with `POST /:id/count`. That is why the model carries **no `min: 0`**.
- **The projection touches COUNTED rows only, and never throws at its caller.** `AgencyStockProjectionService` hangs off `OrderStockService`'s four existing moments (reserve · commit · release · restock) and skips every row nobody has counted — D-6 says the platform claims nothing about those. Each write is idempotent on the reservation id `OrderStockService` already derives, so a retried payment webhook cannot sell one shelf twice.
- **The reconciler is a WORKER now** (`AgencyInventoryReconcileWorker`, 15-minutely), not a read-path debounce. It also walks the movement ledger, which is not work to hang off a page load — and an agency nobody is looking at is exactly the one whose drift wants finding.

⚠ **`countsAreDerived` is computed, not a literal.** It is true only when *every* row in the response is uncounted, so a mixed page reports `false` while uncounted rows are still on it — the per-row `source` is the precise answer. It used to be the hardcoded `true`, which was honest while nothing could count.

**`resolveStockLocationId` is not `resolveHqAddress`, and the difference is the whole design.** Both send a product naming no depot to the primary, and a product naming a live depot to that depot. They diverge on a **dangling** id: routing falls back to the primary (an agent must be sent *somewhere*), inventory records **`location_id: null`** and the screen surfaces it as unassigned. Falling back would move goods between buildings on paper. Never call the routing resolver from the inventory module.

**Deleting a depot that holds stock is refused** — `409 MAGAZIN_LOCATION_IN_USE` on both magazin write paths (`MagazinProfileService.updateMagazin`, `AgencyProfileService.persistLogisticsToMagazin`). Removals are diffed against the array `toPersistableHeadquarters` is about to persist, **not** the request: an entry that omitted its `id` may still have kept one by content match, and diffing the raw payload would 409 every save from a client that hasn't shipped the id echo. **"Holds stock" is QUANTITY** (`quantity_on_hand !== 0 || quantity_reserved !== 0`) since Step 14; it tested row *existence* while every quantity was 0, and leaving it there once counts are real would mean an agency could never close a depot it had emptied. Configured-but-uncounted rows no longer block a removal — they land as **unassigned** on the next reconcile, which is what that state is for. The guard is check-then-write (`updateByAgencyId` is not session-aware); the `version` CAS narrows the race.

**Re-pointing a product while its shelves hold counted stock is refused too** — `409 INVENTORY_DEPOT_CHANGE_HOLDS_STOCK` on `changeDepot`. Moving goods is `POST /api/agency/inventory/:id/transfers`, which writes a `transfer_out`/`transfer_in` pair in one transaction; `changeDepot` stays a change of *arrangement*. Letting a config edit move goods on paper is the exact failure `resolveStockLocationId` exists to prevent, one level up.

**`IShipmentItem.variant_id` exists now and is nullable forever.** Stock lives on the variant, so a delivered shipment previously could not say which variant left. Written at all three construction sites (checkout + both reassignment branches). Nullable because legacy shipments have none and `addItem` uses a raw `$push` no default reaches — readers treat null as "legacy, join `order_item_id` against the order", which is what they already do for title/sku. `sku` is deliberately **not** denormalized: `CashCollectionService.computeExpectedAmount` hard-throws on a missing order-item join where ~14 other readers tolerate it, and a second source of truth would change that failure behaviour for money code.

Covered DB-free by `npm run test:agency-inventory` (99). Contracts in
`api-doc/agency/inventory.md` and `api-doc/agency/storage-invoices.md`.

**The agency now WRITES, and three of the four writes are one-sided on purpose.** Phase 1
was read-only; `src/modules/inventory/services/agency-stored-product.service.ts` adds
`PATCH /products/:productId/depot` + `POST /products/:productId/{suspend,unsuspend}`, all
keyed on the **product** (the depot lives once on `product.delivery.pickup_location`;
suspension is a product status) and all authorised by the same predicate —
`findRowsForAgencyAndProduct` returning rows. That predicate *is* the storage arrangement,
it avoids a cross-vendor product query, and it yields the `vendorId` each write needs to
stay vendor-scoped. Depot changes go through `mergeDeliveryConfig` and force a reconcile so
the row moves before the next read; they apply with **no vendor confirmation**, because the
depot's address is already the agency's own record (the same reason checkout snapshots only
the depot *choice* for `agency_storage`).

**Suspension reuses `Product.status = 'suspended'` with a fourth reason,
`agency_storage_suspended`.** Two properties keep it from colliding with the
delivery-agency cascade, and both are load-bearing: `DELIVERY_AGENCY_REASONS` is a closed
list that excludes it (so a restore sweep can never lift an agency's leverage — **do not
widen it**), and `suspendVendorPhysicalProducts` only touches `active` products (so the
cascade skips an already-suspended one, and the agency's later unsuspend re-runs the gate
and correctly refuses).

**There are now FOUR disjoint reason sets, and none may absorb another's members.** Vendor
management added `vendor_suspended` (the vendor-level cascade — a system act, reversed by
reinstating the vendor) and `platform_oversight` (one listing removed by an administrator —
a *human* act, so nothing automatic clears it, **including the vendor restore**). That last
exclusion is the point: suspending and reinstating a vendor must not silently republish a
counterfeit listing somebody took down on its merits. `ProductPlatformSuspensionService`
owns both, mirrors `ProductDeliveryAgencySuspensionService` including its `restoreEligible`
re-validation, and covers **every product type** rather than physical only — a suspension
that left the downloads and the bookable services selling would not be one.

The `enum` on `suspension.reason` is now spread from `PRODUCT_SUSPENSION_REASONS` rather
than hand-maintained beside the union — the same rule the notification stacks follow, for
the same reason.

**`ProductStatusValidationService` now blocks activation while the VENDOR is suspended**
(`CATALOG_PRODUCT_VENDOR_SUSPENDED`), as a product-level check that applies to every type.
That is not belt-and-braces: the vendor cascade takes listings down, but three *other*
paths put them back — the delivery-agency cascade, the agency-storage unsuspend, and the
vendor's own activation — and an agency problem resolved while a vendor is suspended would
otherwise walk their catalogue back onto the storefront. Putting the rule in the one
function that answers "may this be on sale" closes all of them at once, and closes the ones
added later by construction. Unsuspend is the one place a 422 carries the whole blocker
checklist (`INVENTORY_PRODUCT_UNSUSPEND_BLOCKED` + `details.blockers`) rather than silently
skipping, because it is an explicit human action. `findAgencyStoredVariants` was widened to
keep `agency_storage_suspended` rows — otherwise suspending a product deletes the row its
own unsuspend button lives on.

**The storage fee is RECORDED and still never charged (D-7).** `storage-fee.calculator.ts`
is pure and quotes `monthly_storage_fee_per_sku × quantity`; `AgencyStorageInvoiceWorker`
turns those quotes into a monthly per-(agency, vendor) statement on `agency_storage_invoices`,
readable from both sides and settleable by the agency. **No money moves** — no earnings entry,
no wallet debit, no payout, and `EarningsQuoteService` still excludes the fee from every
per-order split. `test:agency-inventory` scans the module for exactly that.

⚠ **The quantity it bills is `quantity_on_hand`, and it used to be the catalogue number.**
Rent is owed on what is physically on a shelf, and since Step 14 the platform knows that.
The consequence is visible and deliberate: an agency that has recorded no intake is billed
**0**, and the quote says which case it is in (`storageFee.quantityBasis`) so a screen can
distinguish "not counted yet" from "nothing owed". `catalogStock` stays on the wire as the
vendor's agreed number, and the two are allowed to disagree.

Size still does not price anything: dimensions and volume are surfaced so an agency can
sanity-check a flat rate against what it is shelving, and a client must not multiply by them.

### Two-sided stock adjustment (`src/modules/stock-requests/`)

**On an `agency_storage` product, nobody writes `ProductVariant.stock` alone.** One party
proposes, the other approves, and the number moves in the same transaction that records the
approval — a request marked `approved` whose stock never landed would leave the two sides
believing different things about a warehouse. The module is an endpoint-for-endpoint mirror
of `agency-connections/` (`approve`/`reject`/`withdraw` on both routers, per-outcome
sub-documents, every status in the list by default); the FSM mechanics are lifted from
`ContractTermsProposal` — one-open-per-SKU as a partial unique index, and resolution as a
compare-and-set on `status: 'pending'` whose null return is a **conflict, never a
not-found**.

Three things worth knowing before extending it:

- **`resolveAvailableActions` is the single authority table**, read by the service to
  enforce and by the DTO to render buttons. The asymmetry is deliberate: author ⇒
  `withdraw` only, counterparty ⇒ `approve`/`reject` only. A second copy is how a
  dashboard offers a verb the API refuses.
- **The quantity is ABSOLUTE, never a delta.** A delta approved days later applies to a
  number nobody agreed on. `quantity_before` (proposal time) and
  `approval.quantity_at_apply` (approval time) both persist, so drift is *auditable*
  rather than rejected — it is not a 409.
- **`StockChangeGate` intercepts the three existing vendor write paths** (variant PATCH,
  simple-product PATCH, `PATCH /api/vendor/inventory/bulk-update`) rather than sitting
  beside them as an opt-in surface. Leaving those writing directly would make the rule
  advisory — bypassable by not using it. They return **200** (not 202) with
  `meta.stockAdjustment` and an unchanged `data.stock`; bulk-update gains
  `requested[]`/`notRequested[]` siblings to `variants[]`, raised **after** the commit
  because a proposal is not a stock write. *Creating* a variant or a simple product still
  writes stock directly: an initial quantity is a declaration, not an adjustment.

**A warehoused product cannot have unlimited stock**
(`catalog/domain/services/agency-storage-stock.rule.ts`). Enforced in three places from one
definition — as an activation blocker, as a refusal on `ProductUpdateService` when pickup
becomes `agency_storage` (throwing rather than letting `revalidateActiveStatus` silently
demote a live product to `draft`), and at request *creation*, so no approvable request can
leave a product failing its own gate. Deliberately **not** a `stock > 0` rule: that would
unpublish a product the moment it sold out. Pre-existing offenders are listed by
`npm run audit:infinite-agency-stock` (read-only, no migration).

Covered DB-free by `npm run test:stock-requests` (40) and the extended
`npm run test:agency-inventory` (99). Contracts in `api-doc/{agency,vendor}/stock-requests.md`;
the dashboard hand-off is `api-doc/FRONTEND-CHANGELOG-agency-storage.md`.

### Bargainable pricing (`catalog/domain/services/bargain-price.rule.ts`)

A variant may carry `bargain: { minPrice, maxPrice }` — the window a buyer may haggle within.
**`minPrice === price`, always**, which is what makes this a window rather than a second price
field: nothing downstream (cart, orders, COD, earnings) reads `bargain`, and all of it still
reads `price` alone. `maxPrice` is a negotiation ceiling and is unrelated to `compareAtPrice`.

**Every write path funnels through `resolveBargainWrite`** — the variant controller's create and
update, and both SimpleProduct services. It is three-valued (`undefined` leave alone / `null`
clear / a **complete** pair), and returning only complete pairs is what lets
`VariantRepositoryMongo` keep a whole-object `$set` here instead of `digitalConfig`'s dotted-path
expansion. Four properties are load-bearing:

- **The min/max ordering check is NOT in Zod.** The same violation arrives three ways — inside one
  object, as `price` + `bargain` siblings, and as a bare `price` against stored state — and only
  the first is visible to a schema. Splitting it would raise one code at both 400 and 422, which
  `test:errors`' census refuses. Zod does shape and non-negativity; the rule does the rest at 422.
- **A bare `price` edit auto-syncs `minPrice`**, so a caller that knows nothing about bargaining
  cannot break the invariant. A price rising above the stored ceiling is a 422, never a silent
  ceiling lift — that is the vendor's call.
- **The rule must run before every side effect.** In `updateVariant` that means before
  `fileReferenceService.reconcile` and `stockChangeGate.intercept`; a 422 after the gate leaves an
  approval request in an agency's queue for a PATCH that failed. `test:bargain-price` asserts the
  ordering by source scan rather than trusting it.
- **`bargain: null` is a write-only clear signal** the repository turns into `$unset` — never
  `$set: null`, or "never configured" and "cleared" become two documents meaning the same thing on
  a `default: undefined` path. `toDomain` never produces a `null`.

**The vectorisation flag gates the EFFECT, not the write.** A window may be configured at any time
and is always price-validated; it is live only while `Product.vectorisationEnabled` is true, which
the read model reports as the derived `bargainable`. Nothing is ever deleted when the flag flips —
`prepareForVectorisation` silently resets it on any product that becomes ineligible, so deleting
would destroy vendor config nobody asked to remove. A hard write-gate was rejected because
eligibility requires the product to already be `active`, which would make a window unconfigurable
while building a product.

Service products are refused (400) — their `price` is a per-minute base `BookingPriceResolver`
prorates and peak-surcharges. Clearing is allowed on every type, so a stray window is never stuck.
**No activation blocker**, deliberately: `collectActivationBlockers` runs from
`revalidateActiveStatus`, which silently demotes a live product to `draft` rather than refusing a
write — the same failure mode `agency-storage-stock.rule.ts` was written to avoid.

⚠ `VariantPricingService` — dead, barrel-only, and writing `price` with no `minPrice` sync — was
**deleted** 2026-08-19 (plan step 4.A.6.2). A dead service documenting the invariant it would break
is a loaded gun: the header's warning does not survive a copy-paste. `variants/index.ts` carries a
comment in its place naming `resolveBargainWrite` and the three live write paths, so new variant
pricing is written against the rule from the start.

Covered DB-free by `npm run test:bargain-price` (145). Contract in
`api-doc/vendor/variants.md#bargainable-pricing`; the dashboard hand-off is
`api-doc/FRONTEND-CHANGELOG-bargainable-pricing.md`. **This phase is configuration only** — there
is no offer/counter-offer flow and no path by which a bargained price reaches a cart or an order.

### Structured product descriptions (`src/core/richtext/`)

A product carries **two** descriptions and they are one value in two forms.
`description` is plain text; `descriptionRich` is the typed block document the
vendor authored in the dashboard's formatting editor. They always travel
together — the client sends the pair — and **the server never derives one from
the other**, because a client with no formatting editor sends `description`
alone and must not have a document invented for it.

**`description` stays authoritative for everything except chat formatting.** It
is the only one of the two the storefront renders, `product_storefront_text`
tokenises and the vectoriser embeds. Three rules follow and none is optional:
`descriptionRich` is **not** in the `$text` index (a `$text` index on a nested
document tokenises its structural keys and every `href`, handing a vendor free
relevance for words no customer typed), **not** in the vectoriser payload, and
**not** in any public DTO. The activation gate still reads `description`, so an
emptied document produces an empty projection and `CATALOG_PRODUCT_NO_DESCRIPTION`
still fires.

Four properties are load-bearing:

- **All four write endpoints accept it, and they had to land together.** The two
  `/simple` schemas are top-level `.strict()`, so an unknown key there is a
  `400` on the *entire* save rather than a stripped field, while the two layered
  ones merely strip it. Adding it to only some would make the advanced wizard
  appear to work while quick-add 400s on every save. One shared fragment
  (`validators/rich-description.validator.ts`) is wired onto all four.
- **`null` clears; absent leaves alone.** Every hop reads it with
  `!== undefined`, never a truthiness check. A `!command.descriptionRich` guard
  turns "the vendor deleted their formatting" into "leave it alone", and the
  next read resurrects formatting they removed on purpose.
- **The `href` scheme allowlist is enforced at PARSE time** (`https`/`http`/
  `mailto`/`tel`), not at render time. A `javascript:` href caught only by a
  renderer is one missed call site away from being live. The column is
  Mongoose `Mixed`, so that Zod schema is the *only* shape check there is —
  the same position `article-body.validator.ts` holds for the blog.
- **Formatted output is fitted by trimming the DOCUMENT, never the string.**
  Cutting WhatsApp output can sever a `*` and the client renders the rest as one
  bold run; cutting Telegram HTML severs a `</b>` and the Bot API rejects the
  whole send. `fitFormatted` trims the document, measures, and feeds the marker
  overhead back as a smaller budget.

`core/richtext/` is a **file-for-file mirror** of the dashboard's
`src/lib/richtext/` — there is no shared package, so `test:rich-description`
(149, no DB) asserts this side's WhatsApp and Telegram output against the
dashboard's own fixtures byte-for-byte. A vocabulary change is a two-repo change.

⚠️ **`telegram-bot.service.ts` no longer hardcodes `parse_mode: 'Markdown'`**,
and that was a live defect rather than preparation. Every message this service
sends interpolates user-authored text, and any `_`, `*`, `[` or backtick in it
made the Bot API answer `400 can't parse entities`, `sendMessage` return `false`,
and the notification vanish with only a log line — a vendor trading as
"Chez L_Artisan" was simply never told anything. `parseMode` is now an explicit
option **defaulting to `'none'`** (an unformatted message always arrives; a
malformed formatted one arrives not at all), all four notification stacks compose
their body through `toTelegramNotificationBody` (escaped HTML), and MarkdownV2 is
deliberately not offered — eighteen escape characters that commerce prose collides
with constantly, where one miss drops the message rather than degrading it.

Contract: `api-doc/vendor/product-description-rich.md`; the dashboard hand-off is
`api-doc/FRONTEND-CHANGELOG-rich-descriptions.md`.

**The send path exists now** — `POST /api/vendor/products/:id/share`
(`catalog/domain/services/ProductShareService.ts`, Phase 6 Step 5). It is the first
caller of `toWhatsApp` / `toTelegramHtml`, and `test:product-share` (28, no DB) scans
for those imports so the path cannot rot back to "the formatters are ready and nothing
calls them".

⚠ **A share goes to the VENDOR'S OWN connected identity, and there is deliberately no
recipient field.** Neither channel can address a stranger: WhatsApp permits only an
approved `template` outside its 24-hour service window (and there is no share template),
and the Telegram Bot API sends to a `chat_id` that exists only once that person has
started the bot. The vendor receives the formatted message and forwards it. The window is
checked *before* sending — not because the policy layer would miss it, but because
reaching that layer yields an error naming message types where this one names the remedy
(`PRODUCT_SHARE_WINDOW_CLOSED`).

One rendering rule is its own: **the header is clamped to 200 characters.**
`Product.title` has no `maxlength`, so an unclamped header pushes the body past 4096
however small the description budget goes — and `WaServiceMessage.text` then hard-cuts the
rendered *string*, which is the severed-marker failure `fitFormatted` exists to prevent.

### Blog / editorial (`src/modules/blog/`)

The marketing site's article pages. **This service now holds the public reader and the data
model only** (`/api/public/articles`, no auth, `Cache-Control: public, max-age=300`); the editor
moved to wi-admin at Phase 5 Part A and serves `/api/v1/content` there (ADR-004 D-4).
`/api/admin/articles` and `/api/admin/article-authors` no longer exist. Built to
`api-doc/BACKEND-BLOG-REQUIREMENTS.md`; contract in `api-doc/public/articles.md`, the editor's in
`../admin/docs/api/content.md`.

⚠ **wi-admin WRITES a collection whose schema and indexes are declared here**, on the raw driver,
which applies none of this schema's defaults or validators. That split is the thing to check before
editing either side: a field added to `ArticleSchema` without being added to wi-admin's writer
produces documents the public DTO renders wrong, and no test in either repository would see it.
The index definitions stay here because the public reader needs the schema and `autoIndex` is off
in production, so they come from this service's migration ledger.

**Both repositories now carry a copy of `ArticleBodySchema`**, and there is no shared package. They
are pinned to each other the way `test-rich-description.ts` pins the vendor dashboard's formatters:
`test:blog` § 2b holds a fixture list of block documents with their expected verdict and wi-admin's
`test:content` holds the identical list. Changing the union is a two-repo change, in one commit.

**Bodies are typed blocks, never an HTML string, and `article-body.validator.ts` is the security
boundary.** The frontend renders blocks through React components rather than
`dangerouslySetInnerHTML`, so what that Zod union accepts is what renders on the same origin as the
auth pages. It is `.strict()` throughout — an unknown block type *and* an unknown key on a known
block are both 400s. Mongoose stores `body` as `Mixed` on purpose (a parallel sub-schema would be a
second copy of a 9-type union that nothing keeps in step), which makes one rule load-bearing: **no
write path may set a body that did not come through `ArticleBodySchema`.** Adding a block type is a
two-repo change — `ArticleBody.tsx` switches exhaustively over the union.

**One article, many translations — not one document per language.** `hreflang` and the sitemap's
language alternates are only reconstructible if the languages are one document. The corollary is
that **a missing translation is a 404, never a fallback**: serving English at a Portuguese URL
publishes a page contradicting its own `lang` attribute and competing with its own original. The one
deliberate fallback in the module is the **author bio** (`toPublicAuthorDto`), because a blank byline
where the structured data expects an author is worse than a bio in the wrong language.

**`slug_keys` exists because MongoDB refuses the index you'd reach for first.** A compound unique
index on `translations.locale` + `translations.slug` is two parallel array paths and is rejected at
write time, so every `(locale, slug)` pair is flattened to `"<locale>:<slug>"` in one array with an
ordinary unique multikey index. It holds **retired slugs too**: a renamed slug keeps answering
(`404 BLOG_ARTICLE_MOVED` carrying the current one) and no other article can claim it, because a
reused slug turns a permanent redirect into a wrong answer. `buildSlugKeys` derives it on every
write — never set it by hand.

**The redirect is a machine-readable hint, not an HTTP redirect, and that is the correct split.**
This API can only redirect its own URL; the address needing the 301 is the *page*, which only the
frontend can emit. Same reasoning behind `410 BLOG_ARTICLE_GONE` carrying `categoryKey`.

**`draft` and `archived` are both invisible publicly and are not interchangeable** — a draft 404s
(never live), an archived article 410s with its hub (was live, has inbound links). That is why
`DELETE` is refused once `published_at` is set (in wi-admin, which owns the delete), and why a
preview is `GET /api/v1/content/articles/:articleKey/preview` **there**, returning the *public* DTO
behind the admin guard rather than a flag that returns drafts from the public route. **Do not add
such a flag here** — that preview endpoint exists precisely so previewing never becomes a reason to
relax the public endpoints.

**`content_updated_at` is stamped from a content comparison, not from Mongoose's `updatedAt`.**
`featured`, `categoryKey` and a translation's `published` all move the document; stamping off the row
would put a `dateModified` in the structured data for a revision that never happened. `contentChanged`
fingerprints only what a reader sees. Both that comparison and the `wordCount` derivation are
wi-admin's now (they run on write); this service serves the stored values. `readingMinutes` is
deliberately **not sent** — the frontend computes it from the body it is about to render.

Two rules the requirements ask for that are **not** enforced in code, by agreement: no prices in
article bodies (they go stale silently — link `/pricing`), and no invented metrics.

Covered by `npm run test:blog` (91 assertions, DB-free — the block union incl. the cross-repo
fixture list, the body derivations, `buildSlugKeys` and the public DTO) and `npm run verify:blog`
(needs Mongo — index builds, that the unique `slug_keys` index actually REJECTS a duplicate, the
public queries against real persistence, and that `/articles/index` is declared before
`/articles/:slug`). Both shrank at Phase 5 Part A: the write rules they used to assert —
slug-taken, reserved slugs, the featured demotion, publish-twice, delete-once-published, the
author-in-use guard — are wi-admin's now and its `test:content` / `verify:content` own them.
`verify:blog` drives its lifecycle through `ArticleModel` fixtures rather than a service, and
asserts that **no `/api/admin/article*` route survives** — the half of a mount deletion that can
silently fail. `npm run seed:blog` creates the house byline; **no articles are seeded**,
deliberately.

### The public storefront (`/api/public/*` — catalog half)

The shop's read side, built to `api-doc/public/BACKEND-SHOP-REQUIREMENTS.md` Tiers 1–2.
Contract: `api-doc/public/catalog.md`. **There was no catalog-browse API before this** — the
only non-vendor product router was service booking, so cart and checkout were blocked by the
same gap as browse (a mock catalogue's ids are not ObjectIds).

**Visibility is ONE predicate, in one file.** `catalog/domain/services/public-catalog.filter.ts`
— `status: 'active'` + `deletedAt: null` + `suspension: null` + vendor not `inactive` — applied
by every read in `PublicCatalogRepositoryMongo` and by the booking-availability route. Six
hand-written copies is how a product ends up in the grid and 404ing on its own page.

The vendor half is `!== 'inactive'`, **never `=== 'active'`** — the same form
`ProductStatusValidationService` uses, and for the same reason `requireAuth` does:
`pending_verification` is the registration default, so the positive form hides those vendors'
stores while their products stay listed. §2.4 of the requirements asked for the positive form;
it is wrong.

**Products are nested under their store, and that was a decision.** `Product.slug` is unique
per *vendor*, so `/products/:slug` cannot resolve two vendors owning `blue-shirt`. The
canonical URL is `/public/stores/:storeSlug/products/:productSlug` — which resolves the store
first and therefore hits the existing `{vendorId, slug}` unique index exactly. No migration was
run. `/public/products/:productId` (ObjectId) is a deep-link fallback, not an alternative.

**The DTOs are the security boundary**, and they are explicit projections for one reason: a
spread publishes whatever the model gains next, silently. Do **not** reuse `EnrichedProduct` —
it is `Omit<Product,'fileIds'>` and carries `vendorId`, `suspension.note` (free vendor-facing
text), `delivery.pickup_location` (vendor home/warehouse address ids) and the vectorisation
fields, and is N+1 on files. `test:public-catalog` asserts the absence of each by serialising a
DTO built from a document carrying all of them.

⚠ **The first `$text` index in this codebase** is on `products` (title/tags/description,
`default_language: 'none'`). Every other search here is unanchored `$regex`, which cannot use
an index and has no relevance score — so `sort=relevance` would have had nothing to rank by and
public search would scan the collection. Trade: whole-word matching, and Mongo permits exactly
one text index per collection. Built by `npm run migrate:storefront-indexes`.

`/api/public/*` has its own IP-scoped rate-limit bucket on top of Layer A, so anonymous browse
traffic cannot exhaust the global counter for the signed-in users behind the same NAT.

### Reviews & ratings (`src/modules/reviews/`)

**ONE collection, TWO subjects, THREE author roles**, and the reason it is not just a storefront
feature is arithmetic: `DeliveryAgent.trust_signals` carries three rating factors worth **50 of the
trust composite's 100 weight**, and until this module shipped nothing wrote any of them. Building
only the product half would have left the composite unflippable forever (Phase 6 Step 10, O-1).

A review is a rating 1–5, optional prose, by one identified person, about one identified thing.
`subject_type` tells the two kinds apart:

| `subject_type` | subject | authors | visibility |
|---|---|---|---|
| `product` | a product | the **customer** who bought it | **public** — the storefront's `aggregateRating` |
| `delivery` | a **shipment** | the **customer**, the **vendor** *and* the **agency** | **internal** — feeds the agent's trust score |

**All three delivery authors rate the same shipment and land in three different aggregates**
(customer 30, agency 10, vendor 10). The vendor is in because they are the one non-recipient who
actually *meets* the agent — `vendor-order.service.ts` puts the agent's name, phone and avatar on
their order view. The customer rates the *delivery* and the attribution happens **server-side**;
they never choose an agent, and that half is unchanged.

⚠ **The other half of this paragraph used to read "the customer is the one role that never learns
which agent carried their parcel", and it is no longer true** (2026-08-23,
`docs/ADR-A06-AGENT-IDENTITY-DISCLOSURE.md`). `orders/dto/customer-shipment.dto.ts` now publishes
a **partial name and a photo, and never a phone number**, only while that agent is physically
carrying the parcel, revoked at `delivered`/`returned`. What did not change is what the review
path cares about: a customer still cannot *name* a target, so a delivery review still cannot be
aimed at a person of the author's choosing.

Five rules, each because the obvious version is wrong:

- **`subject_type` and `target_type` are DIFFERENT axes.** The subject is what was reviewed; the
  target is what carries the score. For a product they coincide; for a delivery the subject is a
  shipment and the targets are the agent and the agency, both **snapshotted on the row** so a later
  reassignment cannot move somebody else's reputation. `targetsOf` is the whole matrix, and it is
  pure.
- **An agency's review moves the AGENT's aggregate and never its own.** An agency's directory
  rating comes from its *customers'*, so a business's public score can never be self-reported.
- **A bare star publishes; prose is held for a moderator** (`initialStatusOf`). Everything-pends is
  the reflexive design and it makes the moderation queue a single point of failure for a signal
  that moves real cash exposure — and delivery ratings are overwhelmingly bare stars. A number
  cannot be abusive, and eligibility has already proved the author bought the item or received the
  parcel.
- **The aggregate is RECOMPUTED, never incremented.** An `$inc` path must get publish and reject
  right forever; one missed transition is a permanently drifted average nobody can detect without
  recomputing anyway. Recompute makes "a rejected review counts for nothing, star included" a
  property of the query rather than of a subtraction somebody remembered.
- **`rating` is `null`, never `{average: 0, count: 0}`** — on the product row, the product detail
  and the agency card. That is what closes `aggregateRating`: the frontend rule is *emit it iff
  `rating` is non-null*, and a client cannot get it wrong because the server never sends a
  zero-count summary. Invented review counts are a Google spam-policy violation.

⚠ **One writer at every hop, and that is the rule the whole trust design rests on.**
`ReviewService.refreshTargets` is the *only* function that refreshes an aggregate;
`ReviewAggregateRepository` is the *only* writer of `review_aggregates`;
`AgentTrustService.collectSignals` is its only reader; and the nightly worker is the only writer of
`trust_signals`. **Nothing in `modules/reviews` touches `delivery_agents`**, and the trust collector
never reads `reviews`. `test:reviews` asserts all of it by source scan.

⚠ **`review_one_per_author_per_subject` is the ONLY thing enforcing one review per author.** The
service pre-checks, and a pre-check is a race — two submissions in the same millisecond both read
"none". `autoIndex` is off in production, so `migrate:review-indexes` is what creates it, and
`verify:reviews` is the only place it is proven to **bind** rather than merely exist.

Contracts: [api-doc/reviews.md](./api-doc/reviews.md) (cross-role) and
[api-doc/admin/reviews.md](./api-doc/admin/reviews.md) (moderation). Covered by
`npm run test:reviews` (62, no DB) and `npm run verify:reviews` (16, NEEDS Mongo).

### Stock reservation (`catalog/domain/services/pricing-inventory/` + `orders/services/order-stock.service.ts`)

**Nothing in the order path used to touch `variant.stock`** — the `StockReservation` family
existed with zero call sites anywhere, so `activeReservations` was read from a collection
nothing wrote and overselling was unconstrained.

⚠ **The dead code could not be wired as written, and the fix is the important part.**
`reservePhysicalStock` decremented at *reserve* time while the model TTL-**deletes** an expired
reservation — and only the release restored stock, which can never run on a row that no longer
exists. Every abandoned checkout would have permanently destroyed its units. It also
double-counted against `InventoryAvailabilityCalculator`'s `stock − activeReservations`.

Corrected, and this is now the contract:

| Stage | `variant.stock` | reservation row |
|---|---|---|
| **reserve** (checkout) | untouched | `active`, 30-min TTL |
| **commit** (payment success; COD at *creation*) | decremented **once** | `committed`, TTL pushed out so the audit survives |
| **release** (cancel) | untouched | `released` |
| **expiry** | untouched | TTL-deleted; availability self-heals |

Three properties are load-bearing: availability is `stock − Σ active reservations` and
`countActiveByVariant` sums **quantity** while **excluding already-expired rows** (so a lapsed
hold frees units immediately rather than waiting for Mongo's 60s sweep); all three services
accept the caller's `session` so a rolled-back order cannot leave a hold behind; and a
**returned** shipment *restocks* rather than releases — a committed reservation is refused by
design, because those units were sold and physically came back. `OrderStockService` owns the
wiring and derives the reservation id as `"<cartId>:<variantId>"`, so commit and release
reconstruct it with no new column.

Covered DB-free by `npm run test:storefront-checkout`, which is largely a **source scan**: the
invariant "reserve writes no stock · commit writes it once · release writes none" is structural,
and a regression there is invisible to every other test — stock would just quietly drain.

### Payments (`src/modules/payments/`)

Gateway-agnostic orchestrator (`PaymentOrchestratorService`) over Stripe (cards), NotchPay and
My-CoolPay (mobile money). **All three are real** as of Phase 1; the two mobile adapters used to
make no HTTP call at all, fabricating a `PENDING` response with a hardcoded USSD code when
unkeyed. Contract: `api-doc/payments/README.md`. Covered DB-free by `npm run test:payments` (92).

**One registry, one lookup table.** `gateways/registry.ts` is the only place a gateway is
constructed. There used to be three identical `Map`s — the orchestrator, `CreditTopupService` and
`PlanPurchaseService` — with the orchestrator itself instantiated twice at import, so five
gateway instances each read `process.env` in a constructor. `test:payments` enumerates that
registry and asserts every member implements `verifyWebhook` and `parseWebhookEvent`, which is
what stops a fourth gateway shipping with an unverified endpoint.

**Webhook verification is on the interface, and refusing is not optional.** Both mobile routes
previously read a signature header into a variable and passed it to a method whose first act was
a comment saying it skips verification — on endpoints that are rate-limit-exempt and
maintenance-exempt, reaching `handlePaymentSuccess`. Four rules hold now:

- **An unconfigured gateway refuses its own callback.** Never "skip verification when
  unconfigured" — that is the shape of the original bug, and it means forgetting one environment
  variable silently reopens the hole. `config/env.ts` refuses the boot for the same reason.
- **The status code is the contract.** `domain/webhook-response.ts` holds the whole table, pure
  and testable. Every branch of both mobile routes used to answer `200`, including the catch —
  so a confirmation lost to a restart was acknowledged as delivered and never resent. A
  **transient** failure now answers 5xx so the gateway retries; a permanent one answers 2xx.
  Stripe's written justification for its own 200-after-verification does **not** generalise, and
  the split is on the error's status, not on the gateway.
- **A verified callback is cross-checked against `amountSnapshot`/`currencySnapshot`** before
  anything settles. This is the real compensation for My-CoolPay's MD5 signature: defeating that
  construction still does not let an attacker choose the amount.
- **Replay protection is `payment_webhook_events`**, unique on `(gateway, eventId)`,
  insert-first-wins. `gatewayPayloadHash` remembered only the *last* payload and was shared with
  the initiate/verify paths, so `SUCCEEDED → FAILED → SUCCEEDED` reprocessed.

**`merchantRef` is ours; `gatewayRef` is theirs.** A random 128-bit reference minted per attempt,
sent as NotchPay's `reference` and My-CoolPay's `app_transaction_ref`, and echoed back on the
callback. It replaced sending `idempotencyKey` — `sha256(orderId:userId:amount)`, whose
determinism is right for initiate-dedup and wrong for a gateway-facing identifier. Its typed
prefix (`jm_pt_` / `jm_pp_` / `jm_ct_`) is what lets a mobile-money **plan purchase or credit
top-up** settle from a callback at all; those create no `PaymentTransaction`, so before this they
reached an orchestrator that found nothing and answered success, and only client polling ever
completed one. ⚠ The random part is **hex, not base64url**: base64url contains `_`, the parser
split on `_`, and roughly half of all references would have failed to route intermittently.

**`refundPayment` serves BOTH payable things** — orders and bookings — via a `RefundSource`
discriminated union. Only four points branch (the payment lookup, the `RefundTransaction`
foreign key, the source-status write, the earnings reversal); the money invariants in between are
shared *on purpose*, so a second implementation cannot drift on refundable balance or escrow.

**Refunds ask TWO questions, and conflating them puts a dead button in front of an operator.**

*Does the provider have a refund API?* — `gatewayImplementsRefund()`, answered by the method's
presence. My-CoolPay's API has none (verified against their documentation and their official
SDK), so `MyCoolPayGateway` **omits the method** rather than stubbing it, and the ABSENCE is the
contract: the orchestrator's `typeof … !== 'function'` guard raises
`REFUND_GATEWAY_NOT_SUPPORTED`. That guard used to be dead — both mobile gateways defined a
`refundPayment` that always failed, so the code actually raised was `REFUND_GATEWAY_FAILED`
while the api-doc and a hardcoded `NON_REFUNDABLE_GATEWAYS` list both promised otherwise.

*May our account use it?* — `refundAvailable()`, an account-level gate. ⚠ **NotchPay implements
refunds and this merchant account may not use them**: verified live 2026-08-18, `GET /refunds`
answers 200 with our credentials and `POST /refunds` answers a bare 403 for every body shape
tried. So `NOTCHPAY_REFUNDS_ENABLED` defaults to **false** and NotchPay refunds degrade to the
manual-payout ticket exactly as My-CoolPay's do. Flip the flag when NotchPay enables it; no code
changes with it.

`gatewaySupportsRefund()` reads both, and both `AdminRefundService`'s up-front verdict and the
enforcement in `refundPayment` read *it* — so the verdict and the enforcement cannot disagree.

**A provider that WON'T is not a provider that COULDN'T.** `RefundResult.unsupported` carries
that distinction, and it decides where the money goes: `REFUND_GATEWAY_FAILED` is a 502 that
`VendorRefundService` has **no fallback for**, so a vendor would see an outage for a policy
refusal. `REFUND_GATEWAY_NOT_SUPPORTED` is a documented `business_rule` outcome that
`BookingRefundService` already routes to `refund_pending` + earnings reversal + a HIGH ticket.

**`PaymentReconciliationWorker` is the safety net** (the 14th worker to be built — the roster is 18 now; count it in `WORKER_INVENTORY`, never here). A mobile-money confirmation
arrives minutes after the request that opened it, by which time the customer has closed the page —
so the callback is the settlement path, not a supplement to polling. Nothing swept
`payment_transaction` before this. It re-verifies through `verifyPayment`, never infers: an
unreachable provider leaves the row alone, because "could not ask" is not "failed". For the same
reason an unknown gateway status maps to `PENDING` rather than `FAILED` — only a `PENDING` row is
swept again, so calling a live payment dead strands the money. `npm run audit:stuck-payments`
measures the pre-existing backlog and deliberately fixes nothing.

### Bookings (`src/modules/booking/`) — service products

Services never enter the cart; they are booked. Availability → 15-min Redis hold → booking → payment.

**The booking rows are the authority on a product's own occupancy, not Google Calendar.** This is the load-bearing rule. Availability previously derived busy time from the calendar alone, so a `manual` booking — which writes no calendar event until the vendor accepts it — never blocked its own slot and the same hour could be sold without limit. `ProductBookingService.getAvailability` now subtracts `fullWindows(bookedWindows, seats)` for **every** mode; the calendar only ever *adds* the vendor's other commitments on top. Consequences that follow, and must not be "simplified" back:

- Calendar writes are **best-effort everywhere** (create, reschedule, capacity). A Google outage can no longer reject or lose a confirmed sale, and a vendor with no calendar connected still sells correctly. Safe *only* because of the rule above.
- `AvailabilityService` **unions** persisted `ExternalCalendarBlock` rows with a live query rather than choosing one. Subtracting an interval twice is idempotent, so a union only ever over-blocks (self-healing on the next sync) and never under-blocks. `InboundCalendarSyncWorker` is registered in `lifecycle.ts` and keeps that cache warm.
- `createBooking` re-checks overlap and inserts **inside one transaction** (`BOOKING_SLOT_UNAVAILABLE`, 409). The Redis hold is the first line of defence; it evaporates if Redis restarts, so the CAS is what actually guarantees single occupancy.

**Wall-clock times resolve in the VENDOR's timezone.** `Vendor.timezone` (required, defaults `Africa/Douala`) is the source of truth; `AvailabilityRule.timezone` is now an optional per-rule override, not a `'UTC'` default nobody read. Both availability windows and the peak-hours surcharge go through `booking/utils/availability-timezone.util.ts` — never `setHours`/`getHours`, which resolved against the *server's* clock and shifted every vendor's day when the server moved. `npm run migrate:booking-rule-timezones` (idempotent, `--dry-run`, reports every rule whose hours would move) clears legacy `'UTC'` rows to inherit.

**The pure window arithmetic lives in `booking/utils/availability-windows.util.ts`**, extracted off `AvailabilityService` so it can be tested without Mongo *and* Google. Every availability defect found in review lived there — notably `clipWindow`, which now trims a window to the query range instead of discarding any window not wholly inside it (a mid-day query used to lose the whole day, indistinguishable from fully booked). Covered DB-free by `npm run test:booking-availability` (54).

**Cancelling a paid booking refunds it** (`BookingRefundService`), from **both** the customer and vendor paths — neither refunded anything before. Auto where the gateway supports it; otherwise `paymentStatus: 'refund_pending'` + a HIGH ticket for manual payout, with earnings reversed either way. A refund failure never blocks the cancellation: releasing the slot matters more, and money owed is recoverable from the ticket.

**The customer surface is `/api/customer/bookings`** (list · detail · cancel · reschedule), beside `/customer/orders`. Before it, a customer could pay and then do nothing — `cancelBooking` was fully written, complete with `assertCancellationAllowed`, and simply had no route, so the vendor's cancellation policy was enforced *nowhere*. `UnpaidBookingCancelWorker` sweeps confirmed-but-unpaid bookings (never `pending` ones, which await the vendor).

**The completion balance is REQUESTED, never auto-charged.** `CompletionPricingService` used to compute a shortfall, bury it in `metadata` and stop. It now writes a first-class `booking.settlement` (`finalPrice`, `balanceDue`, `balancePaid`, `creditDue`, indexed for the vendor's outstanding-balance report) and asks the customer for it (`booking.balance.due`). Three rules hold it together:

- **The balance is measured against what was PAID, not what was quoted.** `max(0, finalPrice − amountPaid)`, where `amountPaid` is 0 unless the booking is `paid`. Comparing to `priceSnapshot` billed an unpaid customer only for the overrun and let the original price vanish.
- **Charging is the customer's action.** They agreed to the quote, not to whatever the vendor settles at afterwards. They pay via `POST /api/customer/bookings/:id/pay-balance`, or the vendor records cash via `POST /api/vendor/bookings/:id/settle-balance` (clamped to what is owed, so a mistyped amount cannot inflate earnings).
- **A balance payment is a SECOND payment on the same booking**, discriminated by `PaymentTransaction.purpose = 'booking_balance'` (default `'primary'`, so no migration). Without it the webhook's already-paid early return swallows it. It splits through `splitBookingBalance`, which uses its own source id — `('booking', bookingId)` is already taken by the original — and matures immediately, since the completion that would otherwise start the hold clock has already happened.

`creditDue` (settling *below* what was paid) is **recorded, not refunded**, by explicit product decision — usually a goodwill discount the vendor hands back themselves. It is surfaced so it is at least visible.

**Customers are notified now** — see the notifications section. `BookingReminderWorker` fires ~24h before `startAt`, which the platform owed them: it records `no-show` against people it had never once reminded. Each sweep covers `[now+lead, now+lead+interval)` so consecutive passes tile exactly, and the idempotency key makes a replay harmless.

### Redis (`src/infra/redis/redis.factory.ts`)
Uses dedicated DB indices per feature (email tokens, booking slot locks, download tokens, connection codes, etc.). Connects lazily — **never at boot**, which is why the readiness probe treats it as non-required (see System operations above).

⚠ **4 and 9 are RETIRED, not free.** They held `wa_verify:{CODE}` and `tlgt:{token}` for the two account-linking mechanisms that `CONNECTION_CODE_DB` (13) replaced. They are left unassigned so a stale key from a pre-cutover deployment cannot be read back by whatever claims the number next.

`REDIS_DB_CATALOG` is the table three separate features needed (`/system/dependencies`, `/system/cache`, the flush allowlist) and which previously existed only as trailing comments on the eight constants. The constants stay exported, so no call site changed.

Two accessors, and they are not interchangeable: `getRedisClient(db)` connects if needed (real work, and the cache flush); `peekRedisClient(db)` returns an already-open client or null and **never connects** (every diagnostics read). `redisClientSnapshot()` hands out data rather than handles — exporting the `clients` map would let a caller `quit()` a client out from under a live request.

### Live tracking integration (`src/modules/tracking-integration/`)
The whole jovi-mall half of the geo-tracker contract: the durable outbox (`models/tracking-outbox.model.ts` + repository), `services/tracking-outbox.emitter.ts` (**the only writer** — called by the nine producing transactions listed below, never from the event bus), `services/visible-agents.service.ts` (**the tracking authorization policy** — admin=all, agent=self, agency=agents on approved+active shipments, customer=agents on active orders, vendor=none), `workers/tracking-dispatch.worker.ts` (drains every 2s, HMAC-SHA256, POSTs), and `GET /api/tracking/visible-agents`.

`shipment.agent_released` is the reassignment release: it carries the **old** agent's id with a forced `shipmentTrackable=false, shipmentTerminal=null` verdict (a *release*, independent of the shipment's resulting `assigned`/`handing_over` status), so geo-tracker closes that agent's session and drops the agency/customer's visibility of them — without terminating the shipment, which a fresh session resumes when the replacement accepts.

**jovi-mall decides when geo-tracker tracks a shipment.** A geo-tracker *tracking session* is one shipment's tracking lifecycle, and geo-tracker has no shipment model — so it cannot start or end one on its own. Every outbox event therefore carries three verdicts computed here, in the source of truth, from the same `TRACKABLE_SHIPMENT_STATUSES` that drives agency visibility:

| Field | Scope | Effect in geo-tracker |
|---|---|---|
| `shipmentTrackable` | this shipment | `true` **opens** its tracking session; `false` closes it |
| `shipmentTerminal` | this shipment | `delivered`/`returned`/`failed` — closes it with the outcome stamped |
| `agentHasActiveShipment` | the whole agent | aggregate backstop: `false` closes every session; can open none |

`visibleAgentsService.shipmentTrackability(status)` is the policy. Note `rejected` and `pending_agency_reassignment` are **not** terminal — the shipment isn't over, it just left this agent, so geo-tracker *releases* the session instead. Verdicts are derived from the status the event was emitted **for**, not a re-read of the shipment, so a burst of transitions produces one honest verdict each rather than all reporting the final state. **Changing this shape means changing geo-tracker's `webhook/domain/entity.go` in the same change** — see the cross-service contract in `../CLAUDE.md`.

**Agent-action audit (Phase 6):** `services/agent-action-audit.service.ts` emits `agent.action` outbox rows describing an agent shipment action (pickup/delivery/return/cancel) and its outcome (attempt/success/validation/authorization/system failure). It is wired into `AgentCodController.collect` (the agent's own COD delivery — the full outcome spectrum) and, post-commit, into `ShipmentService.updateStatus`/`reject` (agency-driven lifecycle transitions on an agent's shipment — success). The dispatcher routes these rows to geo-tracker's `/webhooks/agent-actions`, which captures the agent's GPS and writes an immutable spatial-audit row. jovi-mall keeps the **business** event; geo-tracker keeps the **spatial** audit — the two never merge.

Inert when `GEO_TRACKER_BASE_URL` is unset — the outbox still fills, nothing dispatches. That is the intended local default.

**The outbox IS transactional now, and it was not until plan step 3.A.1 (X-1).** Every row is
written by `services/tracking-outbox.emitter.ts` **inside the transaction that made the change it
describes**, so a crash can no longer lose an event. `TrackingEventSubscriber` is **deleted** — the
event bus was the wrong transport for two reasons that cannot be worked around: it carries no Mongo
session, so a row reached through it is necessarily written after the state change has already
committed; and `publish` catches and logs every handler error, so the one hop with no retry was
also the one hop with no alarm.

**Nine write sites, and each one awaits its emit inside its own transaction:**

| Site | Emitter call |
|---|---|
| `ShipmentService` shared transition core | `emitShipmentStatusChanged` |
| `ShipmentService.reject` | `emitShipmentStatusChanged` (`rejected` — a release, not a terminal) |
| `ShipmentService._applyDeliveryConfirmation` | `emitShipmentStatusChanged` (`delivered`) |
| `ShipmentService.reassignAgent` | `emitAgentReleased` |
| `ShipmentService.releaseForAgentCancel` | `emitAgentReleased` |
| `CashCollectionService.collect` | `emitCodCollectionRecorded` |
| `CashCollectionService.autoCollectWithoutCode` | `emitCodCollectionRecorded` |
| `ShipmentAssignmentService.accept` | `emitShipmentStatusChanged` — **the session-OPENING row** |
| `AgentTrackingPolicyService.setTrackingAllowed` | `emitTrackingAllowChanged` (this method **gained** a transaction; it had none) |

Plus `agentActionAuditService.emitShipmentTransition(doc, role, session)` at the first two.

⚠ **`_emitTrackingStatusChanged` (and the identically-named method on `ShipmentAssignmentService`)
is now BUS-ONLY.** Both keep their names and their `eventBus.publish` because in-process consumers
need the event — the customer notification stack and `assignment-event-subscriber.ts` — but neither
reaches geo-tracker any more. **A new status-changing path needs its own emitter call inside its own
transaction; publishing the event is not enough.** Both docstrings say so in their first lines.

**One status write deliberately emits nothing:** `assignPendingByOrderId` (`pending → assigned`, at
checkout). The shipment has no `agent_id` yet — agents bind at `accept` — and geo-tracker's webhook
no-ops on an empty agent id, so there is nobody to track. It publishes `shipment.assigned`, which is
a different event with different consumers, and it never fed the outbox.

**The boundary this establishes, and it is worth stating as a rule:** *nothing that crosses a
service boundary rides the event bus.* The bus is in-process only, and after step 3.A.1 it has no
cross-service consumer at all. A census (73 publish sites, 84 distinct event names, 54 subscribed)
confirms **no subscriber anywhere reaches `TrackingOutboxRepository`, `trackingOutboxEmitter` or
`agentActionAuditService`**. Keep it that way: a durable, ordered, retryable delivery needs a
transaction, and the bus cannot offer one.

**What the bus's lossiness still costs (R-2), stated rather than implied.** 32 of the 84 published
names have **no subscriber** and collapse to `eventBusPublishedTotal{event_type="unhandled"}` —
mostly deliberate audit/future-consumer hooks (`ticket.*`, `store.*`, `agent.*`, `earnings.*`,
`cod.remittance.*`). Two are worth knowing: `vendor.order.${newStatus}` in `vendor-order.service.ts`
builds its name by interpolation and nothing subscribes to any of them, and
`cod.collection.recorded` became unhandled at step 3.A.1b — deliberately, since its publish is a
documented future-consumer hook and its outbox row now comes from the transaction instead. **No
event is subscribed-but-never-published**; there are no dead handlers.

Of the handled ones, only the two money splits have a recovery sweep when a handler fails
(`recoverMissedCodSplits`, `recoverMissedDeliverySplits` in `EarningsReleaseWorker`). **The four
notification stacks have none** — a handler that throws leaves a log line and nothing else, and the
customer is simply never told. That asymmetry is R-2's remaining cost. The durable replacement (J8)
is deferred, and ADR-013 D-2 argues against building a Redis hop as a bandage; agreed, and it means
this stays open rather than fixed.

### Messaging connections (`src/modules/channel-connections/`)

**One mechanism connects any messaging channel to an account, and the code travels bot → user → platform.** It replaced two flows that shared nothing: WhatsApp minted a 16-hex code into a `wa` sub-document duplicated on **four** role models (with an `update_other_roles` flag to fan it out, and no uniqueness index anywhere, so two accounts could claim one number), while Telegram minted a deep-link token into a user-scoped `telegram_links` collection. Both had the *platform* mint the secret.

Now the **bot** mints. A user sends `/connect`, the bot answers with a 6-character code stored against the *messaging identity* it can actually observe, and `POST /api/me/connections` binds that identity to whoever is authenticated. Neither half is told something it cannot verify.

Five things are load-bearing:

- **It binds to the User, never a role entity.** One person has one WhatsApp number. `channel_connections` carries two unique compound indexes: `(user_id, channel)` — one connection per channel per account — and `(channel, external_id)` — one account per messaging identity, which is the constraint WhatsApp never had. `autoIndex` fails *silently*, so `npm run verify:connections` is the only place they are proven to build.
- **Six characters is 2^30, which is NOT enough on its own.** Four guards make it safe: `issue()` revokes the identity's previous code so the guessable set never accumulates; `consume()` is atomic so a code cannot be spent twice; a per-account attempt counter (5 per 10 min) bounds guessing; and `CONNECTION_CODE_POLICY` — the service's **first Layer C limiter** — bounds it again at 30/min per **IP**. The last two key on different axes deliberately: accounts are free to mint, so an account-scoped limit alone bounds nothing. Remove one and the code length becomes the whole defence.
- **The bot webhooks are authenticated now, and `/connect` is why.** They were open — no secret, no signature, unlike geo-tracker's HMAC and the payment gateways' — which was tolerable while they only *redeemed* a code somebody already held. `/connect` makes them **mint** one for whatever identity the request names, so an open endpoint lets anyone mint a code against a stranger's number and attach it to their own account. `BOT_WEBHOOK_SECRET` + `X-Webhook-Secret`, timing-safe; **unset refuses in production and warns in development**, and `reportBotWebhookGuard` prints the state at boot. Setting it means setting it on the automation layer too.
- **`/connect` reads the sender from the CONTEXT, never the payload.** The controller puts `wa_phone_id` / `chat_id` there from the webhook's own fields; the payload is caller-supplied and carries cosmetic name/handle only. The deleted `link` command read `payload.wa_data.wa_phone_id`, which is the same trust mistake one layer down. Source-scanned.
- **The reply is RETURNED, not sent.** The command result carries `message` and the automation layer relays it. Sending from here would mean two outbound APIs, two failure modes, and a code minted whether or not anyone received it. It is also the one piece of outbound copy in this service that is **English only** — localisation reads `preferred_language` off a role entity, and at `/connect` time there is no account to read.
- **`CONNECTION_CODE_EXPIRED` and `CONNECTION_CODE_INVALID` are different answers**, and the key TTL is what buys that: it is validity **plus a grace window**, with `expiresAt` in the record deciding redeemability. A store whose TTL *is* its validity can only ever say "invalid", which is the wrong thing to tell the common failure (a slow user). The bounded cost is a small oracle, accepted here because the code names no account — contrast `AUTH_RESET_TOKEN_INVALID`, which stays undifferentiated because a reset token does.
- **The consume is a Lua script, not `GETDEL`.** `GETDEL` needs Redis 6.2 and the dev Redis here is **3.0**, where it is an unknown command — caught by `verify:connections`, invisible to any source scan. A script is atomic from 2.6 and is the shape `core/jobs/worker-lock.ts` already uses. It must never become a `get` then a `del`: that is exactly what made the old Telegram token redeemable twice while its docstring called it single-use.
- **The alphabet excludes I, L, O and U**, and `normalizeConnectionCode` maps `O→0`, `I/L→1` on both the mint and the redeem side. Because no *generated* code can contain those glyphs, normalization only ever rescues a mistyping user and can never collapse two live codes — `test:connections` asserts every generated code is a fixed point of it.
- **The endpoints are under `/api/me`, deliberately not `/api/webhooks`.** That prefix is exempt from rate limiting and from maintenance windows, and both predecessors had inherited those exemptions purely by being routed next to a webhook. Under `/api/me` the redeem endpoint gets Layer B on top of its own attempt counter. `test:connections` source-scans for it.

`external_id` **never leaves the service** — `domain/identity-mask.ts` renders `••••1234` or `@handle`, and the DTO has no expanded variant. Telegram's old `isActive` toggle is gone with the rest: it muted delivery *and* made `telegramVerified` report `false`, so a connected user was offered "Connect" again.

**The linking rules are a closed table** (`ConnectionService.redeemCode`): unconnected → bind; already this account → **idempotent success**, no second row; another account → `409 MESSAGING_IDENTITY_ALREADY_LINKED`, never a silent transfer, and the refusal names no account because the caller already knows the *identity* and must not learn who else holds it. A code is spent by the attempt, so even a refusal means "send `/connect` again".

Contract: `api-doc/connections/README.md`. Covered by `npm run test:connections` (100, no DB) and `npm run verify:connections` (23, NEEDS Redis + Mongo).

### Messaging login (`src/modules/messaging-login/`)

The module owns **bot-initiated account access**: resolving a messaging identity to an account,
the Telegram contact-share handshake, and the two credentials that follow — `/login` (a
customer session) and `/reset-password` (a password-reset link, any role).

**A customer sends `/login` to the bot and gets two credentials for ONE session** — a magic
link and an 8-character code. Either signs them in, using one kills the other, both die in ten
minutes. It shares `/connect`'s webhook, command bus and code alphabet and **nothing else**,
which is why it is a separate module: `/connect` mints a credential for a messaging identity
nobody owns yet, this mints one that **grants a session on an existing account**. Folding them
together would put a passwordless login path inside the module every notification service
imports, and make one blast radius look like the other.

**The session is always `customer`.** The role is a literal in `MessagingLoginService`, never
read from a request or from the stored record, and a customer role is **never auto-provisioned**
— a vendor who messages the bot is told to use their password.

- **Identity resolution is a three-step ladder** (`identity-resolver.service.ts`), and it reads
  `channel_connections` rather than a new column: that collection already *is* the
  `(user, channel, external_id)` mapping, with unique indexes both ways, and a second one would
  drift. (1) the identity is already bound — instant, both channels. (2) **WhatsApp only:**
  `wa_phone_id` IS the sender's number, so it matches `login_phone` directly; the connection is
  persisted so step 1 serves every later `/login`. (3) **Telegram only:** a `chat_id` matches no
  column anywhere, so the bot asks for a verified contact.
- ⚠ **`wa_phone_id` arrives as BARE DIGITS and `login_phone` is strict E.164**, and the shared
  helpers do not bridge that gap — `toE164('237600123456')` is `null`. A naive
  `findByPhone(wa_phone_id)` therefore matches **nothing, for every user**, while looking
  perfectly implemented. `messagingPhoneToE164` prepends the `+` when the value is all digits;
  Telegram's `contact.phone_number` has the same inconsistency and goes through the same
  function. Both suites carry a bare-digits fixture — it is the single easiest way to ship this
  broken.
- ⚠ **The Telegram contact guard is the whole security of that path.** A user can share somebody
  else's contact card and it arrives in the same shape, so only a contact whose `user_id` is the
  sender's own is accepted; missing or mismatched is refused outright (`400
  MAGIC_CONTACT_UNVERIFIED`), never treated as a hint. The comparand is the **context's**
  `chat_id`, not a payload `from.id` — in a private chat they are the same number, and taking
  both sides from the payload would make the guard forgeable by anyone reaching the webhook.
- **One record, several pointers, on `LOGIN_CODE_DB` (14).** `login:session:{id}` holds the
  record; the link, the code and the messaging identity are keys pointing at it. Spending is one
  atomic delete of the **record**, which is what makes "using either kills the other" true
  without a second source of truth. It stores **ids, never a snapshot** — every gate
  (status, role, customer profile) is re-checked at **redemption**, so a suspension inside the
  ten minutes is seen.
- ⚠ **The grace window is on the credential pointers too, not only the record.** A pointer
  expiring at plain TTL could never resolve to its record, so `MAGIC_*_EXPIRED` would be
  unreachable and every late user would be told INVALID. The *identity* pointer keeps the
  validity alone — an expired session needs no revoking.
- **Key names are hashed; values are not.** `/system/cache/keys` lists key names and offers no
  value read, so a raw token there is a live session credential on the ops surface and a raw
  phone number is personal data in a listing. `digestForKey` covers the token, the code, the
  identity and the attempt counter. This goes further than `channel-connections`, deliberately.
- ⚠ **`MAGIC_CODE_INVALID` is ONE code for four situations** — wrong code, unknown identifier,
  expired-and-swept, and a code/identifier mismatch. Splitting any of them makes the endpoint a
  registration oracle answering "is this phone a customer here?" for any number, with no account.
  `MAGIC_CODE_EXPIRED` is reached only *after* the code is matched to the record's own account.
- ⚠ **The magic link points at `STOREFRONT_URL`, never `API_PUBLIC_URL`, and the page POSTs the
  token.** WhatsApp and Telegram *fetch* URLs to build preview cards, so a `GET` that signed you
  in would be spent by the crawler before the user tapped — a dead link, every time.
- **The redeem routes sit under `/api/auth`** so they inherit the 20/min credential bucket;
  `rate-limit/auth-paths.ts` is an allowlist, so *not* naming them there is how they get it.

**`/reset-password` is the same ladder with a different gate, and it serves EVERY role.**
`resolveForReset` runs steps 1–3 exactly as `/login` does and then checks only that the account
is active — no customer role, no customer profile. A password belongs to the `users` row, so
gating it on the customer role would lock out precisely the people most likely to have one to
forget (customers largely do not have a password at all). It is therefore the only self-service
recovery a vendor or agency has from a chat, **and** the route by which a passwordless customer
acquires a real password.

- **It is a new ENTRANCE, not a second reset mechanism.** `PasswordResetService.issueResetLinkFor`
  shares `mintToken` and `buildResetLink` with the email/WhatsApp path, so the token, its 30
  minutes, its `password_reset:` key space and its redemption at `POST /auth/reset-password`
  are the existing ones — including the `password_changed_at` stamp that makes a reset revoke
  every live session. A second store is how the two entrances drift on single-use or on
  expiry; `test:messaging-login` asserts there is exactly one `randomBytes(32)` and one
  `/reset-password?token=` in that file.
- **It may say "no account" where `POST /auth/forgot-password` may not.** That endpoint must
  answer identically for a real and an imaginary account because an anonymous caller chooses
  the identifier; a bot caller has already proved they control the number, so the oracle does
  not exist. Same reasoning as `/login`.
- **No identity-scoped revocation, deliberately** — unlike `/login`'s credentials. A reset
  token is 2^256, so several live at once is not a guessing risk, and the email path has never
  revoked either; adding it on one path only would make the two disagree for no gain.
- **Link previews are harmless here**, unlike the magic sign-in link: this URL is a page whose
  token is spent by the form's POST, so a crawler fetching it changes nothing.

⚠ **The Telegram contact-share now serves TWO commands, so it needed state.** Both commands hit
the same wall on an unknown chat and answer it with the same keyboard, but the contact that
comes back says nothing about which was asked. `pending-intent.store.ts` records it when the
prompt is rendered and `login_contact` reads it. The original design note said no Redis state
was needed there — true while there was one intent. Three properties: the state is **ours, not
n8n's** (a workflow we do not version or test must not hold security-relevant state, and a
third command would mean re-editing it); it is **a hint, never an authorisation** — the contact
guard, the ladder and the refusal table all run identically, so a lost key degrades to the
default; and **the default is `login`**, the lesser outcome, because defaulting to `reset` would
hand a reset credential to somebody who never asked.

**Customers are passwordless in practice, and that changed registration.** `RegisterSchema` no
longer requires `password` for `role: 'customer'` and **strips one if sent** — honouring a
caller-supplied password would create accounts whose password somebody else chose and knows.
`AuthService.register` mints a random one (`core/auth/system-password.ts`, 32 bytes base64url,
under bcrypt's 72-byte truncation limit) so `password_hash` stays `required: true` and the reset
flow has something to replace. Every other role is unchanged, and `role` still defaults to
`vendor`, so an old body with neither field is refused exactly as before. Consequence:
**`POST /auth/login` always fails for a customer who has never reset**, so the storefront must
route them to the messaging flow rather than showing a password field that cannot work.

⚠ `telegram.controller.ts` used to flatten **every** webhook error into `INTERNAL_SERVER_ERROR`,
keeping only the message — so a command raising a deliberate code had it erased. An `AppError` is
now forwarded unchanged; that is what lets `MAGIC_CONTACT_UNVERIFIED` be distinguishable from a
null-pointer bug.

**The feature is inert without n8n work** (outside this repo): map `/login` **and
`/reset-password` → `reset_password`**, relay `message` verbatim, render a `request_contact`
keyboard on `requestContact: true` (**both** commands can return it), post an inbound `contact`
as `login_contact` **with `user_id`** (one mapping serves both — this service decides which it
completes), relay `error.message` on a 400, and disable link previews.

Contract: `api-doc/auth/magic-login.md`. Covered by `npm run test:messaging-login` (158, no DB —
it drives the real store against a fake Redis) and `npm run verify:messaging-login` (37, NEEDS
Redis + Mongo — it boots the app in-process, redeems over real HTTP, and proves a bot-minted
reset token really changes a **vendor's** password and that the old one stops working).

### Key external integrations
- **Google Calendar** — OAuth 2.0 with encrypted token vault (`src/modules/integrations/calendar/`)
- **WhatsApp** — Meta Cloud API v18.0 (`src/modules/whatsapp/`) — outbound messaging + the bot webhook. Account connection is **not** here (see above)
- **Telegram** — Bot API sends + the bot webhook (`src/modules/telegram/`). Account connection is **not** here (see above)
- **Email** — SMTP (Nodemailer + Handlebars templates) or console provider (`src/modules/mail/`)

## Critical Files

| Purpose | Path |
|---|---|
| App bootstrap & middleware stack | `src/app.ts` |
| Route mounting | `src/api/index.ts` |
| Agent domain public surface | `src/modules/agents/index.ts` |
| Agent↔agency contract lifecycle + handshake | `src/modules/agents/domain/services/agent-contract.service.ts` |
| Agent/agency discovery (both browse directions) | `src/modules/agents/domain/services/agent-directory.service.ts` |
| Assignment eligibility rules | `src/modules/agents/domain/services/agent-eligibility.service.ts` |
| Tracking-allow policy (geo-tracker consumes) | `src/modules/agents/domain/services/agent-tracking-policy.service.ts` |
| geo-tracker integration seam | `src/modules/agents/ports/device-location.port.ts` |
| Agent domain config (all eligibility assumptions) | `src/modules/agents/config/agent.config.ts` |
| Article block vocabulary (the blog's security boundary) | `src/modules/blog/validators/article-body.validator.ts` |
| Error factory & AppError class | `src/core/errors.ts` |
| Error code registry | `src/core/error-codes.ts` |
| Base repository | `src/core/repositories/base.repository.ts` |
| Auth middleware | `src/api/middlewares/auth.middleware.ts` |
| Passwordless `/login` identity ladder (D-1, the E.164 repair) | `src/modules/messaging-login/services/identity-resolver.service.ts` |
| The Telegram contact-share guard | `src/modules/messaging-login/commands/login-contact.command.ts` |
| Storage factory/singleton | `src/core/storage/storage.factory.ts` |
| Geocoding provider abstraction | `src/core/geocoding/` (factory, `getGeocodingProvider()`, Nominatim adapter) |
| GeoAddress value object (all address sites) | `src/core/types/geo-address.types.ts` |
| Transaction manager | `src/core/database/transaction.manager.ts` |
| The migration ledger (model + the four status states) | `src/core/database/schema-migration.model.ts` |
| The migration runner (declared order, closed registry) | `scripts/migrate.ts` |
| Boot sequence + the ordered drain | `src/lifecycle.ts` |
