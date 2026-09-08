# Phase D · 0 · 1 — admin dashboard

**Verified against source on 2026-09-08** — R7 re-read the refund-capability derivation (`modules/payments/gateways/registry.ts:89-107`, `payments/config/payments.config.ts:51`, `orders/admin-refund.service.ts:79,180,317`) and the two wi-admin routes and their permissions (`admin/src/modules/orders/routes/order.routes.ts:100-146`, `system/routes/system.routes.ts:63`). **One defect fixed:** § 8's Q-4 row said the bargain range was "closed as not planned" and told readers not to build an offer/counter-offer surface — the negotiation module shipped and `bargain.maxPrice` is now the storefront price.

Everything Phases D, 0 and 1 changed for the administration dashboard. The dashboard talks to
**wi-admin** at `/api/v1/*`; wi-admin reads some records straight out of `jovi_mall` and
delegates the rest over jovi-mall's internal admin API. Both sides are named below wherever it
matters.

**Phase 1 did not modify wi-admin** — it was a one-sided change inside jovi-mall's payments
module. What reaches this dashboard is therefore *different values through unchanged endpoints*,
plus the two additions made while writing this documentation (§ 3). Phase 0 changed no API at
all. Phase D changed no API yet — § 8 lists what is coming and what is already decided against.

---

## 1 · The headline: refunds now answer two different questions

`gatewayRefundSupported` used to be computed from a hardcoded list
(`NON_REFUNDABLE_GATEWAYS = ['NOTCHPAY','MYCOOLPAY']`) sitting a few files away from the guard
that enforced it. The two disagreed: both mobile adapters *defined* a `refundPayment` that
always failed, so the guard never fired and the code actually raised was
`REFUND_GATEWAY_FAILED` while the list — and the documentation — promised
`REFUND_GATEWAY_NOT_SUPPORTED`.

It is now **derived from the gateway registry**, and it folds two facts into one boolean because
both produce the same outcome for an operator:

1. **Does this provider have a refund API at all?** My-CoolPay does not — the method is
   deliberately absent from the adapter rather than stubbed.
2. **May our merchant account use it?** NotchPay's integration is real and correct, but
   `POST /refunds` answers a bare `403` on this account while `GET /refunds` answers `200` with
   the same credentials (verified against the live provider, 2026-08-18). It is governed by
   `NOTCHPAY_REFUNDS_ENABLED`, which defaults to **`false`**.

| Gateway | `gatewayRefundSupported` today | What a refund does |
|---|---|---|
| `STRIPE` | `true` | Real API refund |
| `NOTCHPAY` | **`false`** — flips to `true` the day the provider enables refunds and the operator sets `NOTCHPAY_REFUNDS_ENABLED=true`, with no code change | Manual payout path |
| `MYCOOLPAY` | `false`, permanently — the API has no refund endpoint | Manual payout path |

**The manual payout path**, when a refund is actioned against a gateway that cannot do it: the
order or booking goes `refund_pending`, the vendor's escrowed earnings are reversed, and a
**HIGH-importance support ticket** is raised. The refund request itself still succeeds. Render
this as "refund in progress — manual payout", never as a failure.

### `GET /api/v1/orders/:orderId/refund-eligibility`

**Permission:** `orders.refund` — not `orders.read`. The answer is a ceiling on money leaving the
platform, not a record. Delegated to jovi-mall. **Never throws on ineligibility** — it answers
with a verdict.

| Field | Type | Notes |
|---|---|---|
| `eligible` | boolean | The **money** verdict: is there a gateway payment with a balance to refund |
| `maxRefundable` | number | The full remaining balance — deliberately *not* the vendor's policy fraction |
| `remaining` | number | Same figure, named for the payment |
| `currency` | string \| null | |
| `reasonCode` | string \| undefined | `REFUND_ORDER_IS_COD` · `REFUND_PAYMENT_NOT_FOUND` · `REFUND_ALREADY_FULLY_REFUNDED`. Absent when eligible |
| `gateway` | string \| null | `NOTCHPAY` · `MYCOOLPAY` · `STRIPE`, or `null` when there is no payment |
| `gatewayRefundSupported` | boolean | **Read § 1 above.** Reported up front so the button is never offered for a refund that cannot happen — discovering it after the press leaves a `pending` refund row and an operator who believes money moved |
| `isCod` | boolean | Cash on delivery never went through a gateway |
| `vendorPolicy` | object | What the **vendor's own** policy would have allowed. Reported, never enforced: `{ eligible, maxRefundable, remaining, currency, reasonCode?, refundProcessingDays, returnShippingPayer }` |
| `overrides` | string[] | Which vendor gates this refund would cross: `return_window_expired` · `policy_disabled` · `order_not_paid` · `above_policy_maximum` |

### `POST /api/v1/orders/:orderId/refund`

**Permission:** `orders.refund` (a `financial` permission). **Audited.**

| Field | Type | Required | Notes |
|---|---|---|---|
| `amount` | number > 0 | optional | Absent means the **full remaining refundable balance** — not the vendor's policy cap. An administrator saying "refund this order" means the order |
| `reason` | string | ✅ | Required; a blank string is refused |
| `overridePolicy` | boolean | optional | Acknowledges crossing the vendor's commercial terms. It **never** waives a money invariant — an amount above the remaining balance is refused regardless |

Response: `refundId`, `status: "completed"`, `amount`, `currency`, `totalRefunded`,
`fullyRefunded`, `withinVendorPolicy`, `overrides[]`.

**Error codes worth branching on** (jovi-mall's code reaches the dashboard in
`details.platformCode`):

| Code | Status | `category` | Meaning for the operator |
|---|---|---|---|
| `REFUND_GATEWAY_NOT_SUPPORTED` | 400 | `business_rule` | **An answer, not an outage.** The money goes out by hand; the ticket is already raised. `details.gateway`, and `details.reason` when the provider explained itself |
| `REFUND_GATEWAY_FAILED` | 502 | `external_service` | A genuine failure. Worth a retry. `details` is dropped at the boundary |
| `REFUND_POLICY_OVERRIDE_REQUIRED` | 422 | `business_rule` | Re-submit with `overridePolicy: true` and a reason |
| `REFUND_AMOUNT_EXCEEDS_MAX` | 400 | `validation` | `details.requested`, `details.remaining`; on a cart-group payment also `details.scope: "order"` and `details.groupPaymentId` |
| `REFUND_ALREADY_FULLY_REFUNDED` | 409 | `conflict` | |
| `REFUND_PAYMENT_NOT_FOUND` | 404 | `not_found` | No `SUCCEEDED` payment for the order |
| `REFUND_ORDER_IS_COD` | 400 | `validation` | Its own code so the conversation is "this never went through a gateway", not "the record is missing" |

> **A cart-group refund is capped per order.** One payment settles N orders; the ceiling is that
> order's own `total_amount` minus the completed refunds already carrying its id, never the
> group balance. Without that, one vendor's refund would be paid out of another vendor's
> customer's money.

---

## 2 · Gateway integration health — `GET /api/v1/system/integrations`

**Permission:** `system.health.read`. Delegated to jovi-mall's
`/api/internal/admin/system/integrations`. Optional `?probe=smtp,telegram` runs the two on-demand
probes; the payment gateways are never probed.

Both mobile-money rows changed meaning in Phase 1. They used to report a **hardcoded
`configured: false`** even with an API key set — correct at the time, because the adapters made
no HTTP call at all — and they were deliberately excluded from the passive-observation recorder,
because recording a mock as a successful call would have made this page vouch for a payment path
that did not exist. Both prohibitions were lifted in the same change that made them untrue.

Each row is:

| Field | Type | Notes |
|---|---|---|
| `key` | string | `notchpay` · `mycoolpay` · `stripe` · `mongodb` · `redis` · `whatsapp` · `telegram` · `fcm` · `google_calendar` · `wi_admin`, and the rest of the catalogue |
| `label` | string | Display name, e.g. `"NotchPay (mobile money)"` |
| `impact` | string | What breaks when it is down. Written per integration |
| `configured` | boolean | A pure config predicate. See below — it now means more than "a key is set" |
| `detail` | object | Per-integration, never a secret. Fields listed below |
| `reachability.mode` | `"passive"` \| `"probed"` \| `"on_demand"` \| `"never"` | Both gateways are **`passive`** |
| `reachability.note` | string | Why that mode was chosen |
| `reachability.status` | `"ok"` \| `"error"` \| `"timeout"` \| `null` | **`null` means "not checked", never "down"** |
| `reachability.checkedAt` | ISO-8601 string \| null | When real traffic last learned this |
| `reachability.latencyMs` | number \| null | |
| `reachability.error` | string \| null | The last failure's message |

**`configured` requires the callback credential, not just the calling one.** A gateway that can
take money and cannot authenticate the confirmation charges customers and settles nothing, so:

- **NotchPay** is `configured` only with `NOTCHPAY_PUBLIC_KEY` **and** `NOTCHPAY_WEBHOOK_SECRET`
  (the dashboard's Hash Key, `hsk_…` — a third key, not the private one).
- **My-CoolPay** is `configured` only with `MYCOOLPAY_PUBLIC_KEY` **and**
  `MYCOOLPAY_PRIVATE_KEY` (the private key *is* the callback signer; there is no separate
  webhook secret, and the provider has no such credential).

jovi-mall refuses to boot on either half-configured combination.

**`detail` for `notchpay`:**

| Field | Type | Notes |
|---|---|---|
| `implemented` | boolean | `true` since Phase 1 |
| `publicKeySet` | boolean | The `Authorization` credential |
| `privateKeySet` | boolean | The `X-Grant` credential. **Refunds refuse without it; collection is unaffected**, which is why it is reported separately rather than folded into `configured` |
| `webhookSecretSet` | boolean | The Hash Key |
| `baseUrl` | string | Default `https://api.notchpay.co` |
| `refundSupported` | boolean | The § 1 verdict, same predicate the refund path enforces |

**`detail` for `mycoolpay`:**

| Field | Type | Notes |
|---|---|---|
| `implemented` | boolean | `true` since Phase 1 |
| `publicKeySet` | boolean | Goes in the URL **path**, and is echoed back on every callback as `application` |
| `privateKeySet` | boolean | Double duty: signs the callback and authorises payout/balance |
| `baseUrl` | string | Default `https://my-coolpay.com/api` |
| `callbackIpPinned` | boolean | `MYCOOLPAY_VERIFY_CALLBACK_IP`. Off by default — behind a proxy or tunnel `req.ip` is the hop, not the origin |
| `refundSupported` | boolean | Always `false`. **Not a misconfiguration** — that provider has no refund endpoint |

A half-configured gateway is diagnosable from `detail` alone: `privateKeySet: false` on NotchPay
means collection works and refunds will refuse.

---

## 3 · Payment settlements — `GET /api/v1/money/payments`

**Permission:** `money.payments.read`, held by all three tiers (Support included, deliberately —
answering for a payment is exactly what Support does).

Two things were added here while writing this documentation, because Support could not do its
job without them: **`merchantRef` on the row**, and **`?reference=`**, which matches a term
against *either* reference.

### Query parameters

| Parameter | Type | Notes |
|---|---|---|
| `status` | string, 1–40 | `INITIATED` · `PENDING` · `SUCCEEDED` · `FAILED` · `CANCELLED` · `REFUNDED` — **uppercase**, as stored |
| `gateway` | string, 1–40 | `NOTCHPAY` · `MYCOOLPAY` · `STRIPE` — uppercase |
| `method` | string, 1–40 | `MOBILE` · `CARD` · `CASH` — uppercase |
| `purpose` | string, 1–40 | `primary` · `booking_balance` — lowercase |
| `orderId` | 24-hex | Matches **either** linkage: `orderId` or membership of `orderIds` |
| `bookingId` | 24-hex | |
| `userId` | 24-hex | The payer — not one kind of id (see below) |
| `reference` | string, 1–128 | **New.** Exact match against `gatewayRef` **or** `merchantRef`. One parameter for both because the person pasting one cannot tell which kind they hold: a customer reads ours off their record, a provider's dispute email quotes theirs |
| `from` / `to` | ISO-8601 | Ranged on `createdAt`. Max span 366 days |
| `page` · `limit` · `sort` | | Sort by `createdAt` or `amount`; default `-createdAt` |

### Row fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `settles.orderId` | string \| null | Single-order payment |
| `settles.orderIds` | string[] | The group's orders — present with `cartId`. **A row whose `orderId` is `null` is not incomplete**: a multi-vendor checkout is one payment settling N orders, and that is the common case |
| `settles.bookingId` | string \| null | |
| `settles.cartId` | string \| null | |
| `settles.purpose` | string | `primary` · `booking_balance` |
| `payer.id` | string | |
| `payer.kind` | `"customer_or_user"` | A deliberate *unknown*: order and cart payments store a **customer** id, booking payments a **user** id, and nothing on the row says which |
| `gateway` | string | |
| `method` | string | |
| `gatewayRef` | string | The provider's own reference — the string quoted in a dispute |
| `merchantRef` | string \| null | **New.** Ours: `jm_pt_` + 32 hex characters. `null` on rows written before Phase 1 and on any row whose provider never echoed one back |
| `status` | string | |
| `amount` | number | The amount **at payment time**, never re-read off the order |
| `currency` | string | |
| `refunds.totalRefunded` | number | |
| `refunds.netAmount` | number | `amount − totalRefunded`, computed on the way out |
| `refunds.hasPartialRefund` | boolean | |
| `createdAt` · `updatedAt` | ISO-8601 string \| null | |

`GET /api/v1/money/payments/:transactionId` returns every list field plus `refundTransactions[]`
— the refunds against this payment, each with `id`, `paymentTransactionId`, `source.orderId`,
`source.bookingId`, `vendorId`, `userId`, `amount`, `currency`, `reason`, `status`, `gateway`,
`gatewayRefundRef`, `initiatedBy.id`, `initiatedBy.role`, `createdAt` and `completedAt`.

> **Never returned to anyone**, by projection: `rawGatewayPayloads` (unbounded third-party
> content), `gatewayPayloadHash` and `idempotencyKey`. `merchantRef` is projected because it is a
> routing label the provider already holds and the customer's own record carries — not
> verification material.

**A `pending` or `failed` refund row beside a `totalRefunded` that has not moved is what a stuck
refund looks like** — and on the mobile rails that state is expected rather than exotic, for the
reasons in § 1.

---

## 4 · The fourteenth worker — payment reconciliation

`GET /api/v1/system/workers` (permission `system.workers.read`, delegated to jovi-mall's
`/api/internal/admin/system/workers`) now reports **fourteen** workers: the thirteen triggerable
ones plus `inbound-calendar-sync`, which is observable but not runnable.

The new one is **`payment-reconciliation`**, and it exists because before Phase 1 both mobile
webhook routes answered `200` in every branch — including their catch. To a gateway, `200` means
"handled, stop retrying", so every confirmation dropped by a restart or a database blip was
acknowledged as delivered and never resent, and **nothing swept `payment_transaction`** to
notice.

| Field on the worker row | Value for this worker |
|---|---|
| `key` | `payment-reconciliation` |
| `label` | `Payment reconciliation` |
| `schedules[].expression` | `PAYMENT_RECONCILE_CRON`, default `*/10 * * * *` |
| `schedules[].source` | `PAYMENT_RECONCILE_CRON` — derived from the value actually scheduled with, never a hand-typed string |
| `enabled` | Always `true` — it has no config master switch |
| `scheduled` · `executing` · `manualClaim` | The three distinct booleans every worker reports |
| `triggerable` | `true` |
| `pausedByMaintenance` | `true` while a `down` window is making ticks skip |

**What it does:** selects `NOTCHPAY`/`MYCOOLPAY` transactions in `INITIATED` or `PENDING`, with a
non-empty `gatewayRef`, last updated more than `PAYMENT_RECONCILE_MIN_AGE_MINUTES` ago (default
10) and created less than `PAYMENT_RECONCILE_MAX_AGE_HOURS` ago (default 72), up to
`PAYMENT_RECONCILE_BATCH_SIZE` per pass (default 50) — then re-verifies each through the same
`verifyPayment` path a client poll uses, so a success runs fulfilment, stock commit and the
earnings split on the one path. It then does the same for `pending` plan purchases and credit
top-ups.

**What it never does:** infer. An unreachable provider leaves the row exactly as it was, because
"we could not ask" is not "it failed". Stripe is deliberately excluded — it settles
synchronously and its webhook delivery has its own retry with backoff.

### Running it on demand

`POST /api/v1/dev-tools/workers/payment-reconciliation/run` (permission
`developer_tools.workers.trigger`, audited).

> **`null` and `0` mean different things** in the count this returns. `0` is "nothing was due".
> `null` is "the pass was **refused by the worker lock**" — another instance or an overlapping
> run holds it. Do not render them the same way; a refused pass is not a completed empty one.

---

## 5 · Operations scripts an administrator will be asked about

These are run by an operator on the jovi-mall host, not from the dashboard. They are here
because they are the answer to two questions the dashboard will raise.

| Command | What it does |
|---|---|
| `npm run audit:stuck-payments [-- --days=90] [-- --json]` | **Read-only.** Measures the backlog of payments that never closed — the damage done before the reconciliation worker existed. It deliberately fixes nothing: re-verifying a two-month-old transaction can fire fulfilment and an earnings split on an order somebody already refunded by hand, and that decision belongs to a person holding the report |
| `npm run migrate:payment-indexes [-- --dry-run]` | Builds the Phase 1 indexes explicitly and reports what it did: the **unique `(gateway, eventId)`** dedup index and the 45-day TTL on `payment_webhook_events`, and the sparse-unique merchant-reference indexes on `payment_transactions`, `plan_purchases` and `credit_topups`. Idempotent; never drops anything |
| `npm run test:payments` | The 92-assertion DB-free suite. Runs in CI on every push |
| `npm run verify:gateways` | Talks to both live providers and prints what comes back. **Staged**, because one of the two accounts is live — see the warning below |

> ⚠ **`verify:gateways` can move real money.** The configured My-CoolPay application is a **live
> merchant account**, not the sandbox: a `payin` sends a real prompt to a real phone and a
> `payout` moves real money out. The bare command runs read-only probes; charging requires
> `-- --mycoolpay-pay` or `-- --notchpay-pay`, and payouts `-- --payout`. Verification on
> 2026-08-18 cost 100 XAF, actually charged.

**Why the index migration matters:** `autoIndex` is on, and a failed index build fails
*silently* at boot. Without the unique `(gateway, eventId)` index the webhook-event collection
still accepts writes and **replay protection stops working entirely** — every gateway redelivery
is processed again.

---

## 6 · What the webhook endpoints now answer

Not client-callable, and documented here because the dashboard is where a "did that callback
arrive" question lands. All three gateway webhooks are signature-verified and raw-parsed.

| Situation | Status | Why |
|---|---|---|
| Verified and processed | `200` | |
| Verified, duplicate event id | `200` | A genuine redelivery; retrying changes nothing |
| Verified, names a transaction we do not hold | `200` | Sandbox keys are shared across environments; another deployment's callback is expected traffic |
| Verified, no status we act on | `200` | |
| **Verified, amount or currency disagrees with our snapshot** | `200` with `success: false` | Refused and logged loudly. Never marks a payment succeeded |
| Malformed body | `400` | |
| Missing signature · bad signature · wrong `application` | `401` | The last two are deliberately indistinguishable — telling an unauthenticated caller which check they failed is free information |
| Callback from an unexpected source address (My-CoolPay, when IP pinning is on) | `403` | |
| **We** are not configured to verify | `503` | Refuse, never "skip verification when unconfigured" — that was the shape of the original bug |
| Permanent processing failure | `200` | Retrying sends the same bytes; the reconciliation sweep is the safety net |
| **Transient processing failure** | `500` | The gateway must retry. This branch used to be a `200`, and that is how confirmations were lost |

Accepted callbacks are recorded in **`payment_webhook_events`**, unique on `(gateway, eventId)`,
TTL 45 days, with `outcome` one of `processed` · `unknown_transaction` · `amount_mismatch` ·
`ignored`. **There is no admin endpoint over this collection today** — "did that callback arrive,
and what did we do with it" is answerable from the database, not from the dashboard. Worth
knowing before someone designs a screen for it.

`/api/webhooks/*` is exempt from rate limiting and stays reachable during a maintenance window
unless the operator sets `blockWebhooks` on it: a `429` or a `503` to a gateway loses a payment
notification.

---

## 7 · Phase 0 — what an administrator should know it bought

No API changed. What changed is that the platform is now recoverable and checkable:

- **All three backends are in Git with remotes** (`jovi-mall`, `backend-admin`, `geo-tracker`).
  Roughly 110 files of finished work existed only on one laptop, including one half of a
  two-repo event-shape change on each side.
- **67 previously-ignored files are tracked** — 27 test suites, 15 migrations and backfills, the
  seeds, and `.env.example`, which *is* the deployment contract (268 documented variables today, asserted in both directions by `npm run test:env`).
- **`scripts/` is inside the type checker and the linter** in both TypeScript repositories. The
  proof it was needed was already in the tree: `admin/scripts/test/verify-audit-live.ts` had not
  compiled in months and nothing reported it.
- **CI exists in all three repositories.** jovi-mall runs typecheck, typecheck:scripts, lint,
  every DB-free suite discovered from `package.json`, and `npm audit`; wi-admin the same shape;
  geo-tracker `make lint`, `make test`, `govulncheck` and the Docker-backed integration suite.
- **Two known-red suites are baselined by exact count** and the build fails if either number
  moves *in either direction* — `test:mobile-auth` at 101/2 (the deliberately commented
  `isValid` line, excluded by owner instruction) and `test:contact-validation` at 73/1. A
  pipeline that is red from its first run trains people to ignore it.
- **The three-service error-taxonomy contract has an enforcement point** for the first time: a
  scheduled workflow checks out all three repositories and runs each one's copy of the nine-value
  assertion.

---

## 8 · Phase D — the ten decisions, and what each means for this dashboard

All ten were answered on 2026-08-18. **Six are decided and unbuilt**, one is closed as
*not planned*, and three are already in force. Read the status column before planning a screen.

| Q | Answer | Record | Status for you |
|---|---|---|---|
| **Q-1 · Does an administrator get to see a live position?** | **geo-tracker gains a service-caller model.** Administrators still get no `users` row | `admin/docs/ADR-020-ADMIN-DATA-DOOR.md`, amending ADR-009 D-2 and ADR-015 D-5 | **Decided, unbuilt (Phase 6.I).** Today the admin surface still serves jovi-mall's business-side answer only — the Tracking Allow flag, the policy verdict, the device flags, and `last_known_tracking_state` **labelled stale**. No live position, no trail. The only geo-tracker door wi-admin has is the unauthenticated ops triple (`/healthz`, `/readyz`, `/metrics`) at `GET /api/v1/system/geo-tracker[/metrics]` |
| **Q-6 · Which of `customers.read` / `customers.suspend` is right?** | **Delete both.** Neither has an endpoint; the `users` module already covers customers | `admin/docs/ADR-017` D-1 | **Decided, unbuilt (Phase 5.E).** Both permissions are still in the catalog today and are still granted — Tier 2 gets them through `allInFamily('customers')`, Tier 3 Support holds `customers.read` by name. **Do not build against them**; the customer directory is `GET /api/v1/users?role=customer`, the detail composes a `customer` role-profile, suspension is `POST /api/v1/users/:id/{suspend,restore}`, and order history is `orders.read` filtered by `customerId` |
| **Q-10 · What is the shape of the release?** | Docker for all three · `docker compose` on one host · dev + production · secrets from the host store · **Node 22 LTS** pinned · uploads off the container filesystem | `docs/ADR-019-RELEASE-SHAPE.md` | Decided; Phase 2 builds it. No dashboard impact beyond expecting environments to become real |
| **Q-9 · Which side deploys first on a two-repo change?** | Additive → producer first. Breaking → reader first, writer second. A migration never shares a window with a wire change | `docs/ADR-019-RELEASE-SHAPE.md` | Decided; Phase 2.F writes the runbook |
| **Q-5 · Who can download whose uploads?** | Scan on ingest **and** move the three private upload trees behind auth | `jovi-mall/docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md` | **Decided, unbuilt (Phase 4.A.4).** The whole upload tree is served by an unauthenticated static mount today. Expect direct file URLs to require a session afterwards |
| **Q-3 · Should a bearer session have an absolute cap?** | **90 days**, stateless `auth_time` claim | `jovi-mall/docs/ADR-A03-SESSION-CAP.md` | **Decided, unbuilt (Phase 4.A.5)** |
| **Q-7 · What is the longest plausible delivery in this market?** | **`TRACKING_SESSION_TTL = 72h`** | `geo-tracker/docs/ADR-B01-SESSION-TTL.md` | **Decided, unbuilt (Phase 4.C.2).** The constant still defaults to **48h** in geo-tracker's config |
| **Q-2 · What does "delete my account" mean?** | **Anonymise-and-retain.** No legal enquiry; a new market or processor is the trigger | `jovi-mall/docs/ADR-A02-ACCOUNT-CLOSURE.md` | **Decided, unbuilt (Phase 6.D).** Nothing exists today — no deletion, no export, no session revocation |
| **Q-8 · Own the geocoding or rent it?** | Cache first, then rent one adapter | `jovi-mall/docs/ADR-A04-GEOCODING.md` | **Decided, unbuilt (Phase 6.H)** |
| **Q-4 · Is the bargain range buyer-facing?** | ⛔ **REVERSED — the product shipped.** `bargain.maxPrice` is now the storefront **shelf price** and `variant.price` is the vendor's unpublished floor (`read-models/public-display-price.ts`); a negotiating agent is live at `/api/internal/negotiation/*` (`src/modules/negotiation/`, mounted at `api/index.ts:504-505`) | `jovi-mall/docs/ADR-A05-BARGAIN.md`, superseded | ⚠ **This row said "closed as not planned · do not build an offer/counter-offer surface" until 2026-09-08 (R7), and every clause of that is now false.** The negotiation surface is **service-token only** — the customer bot drives it, not a dashboard — so there is still nothing for *this* dashboard to build; what changed is the pricing semantics, which an admin reading a product's price must understand |

The register itself, with the evidence behind each answer, is
[`11-DECISIONS-REGISTER.md`](../../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md).
