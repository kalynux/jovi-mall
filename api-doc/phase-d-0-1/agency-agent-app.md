# Phase D · 0 · 1 — agency and agent mobile app

**Verified against source on 2026-09-08** — every route named across the three pages of this
folder is served (whole-tree phantom scan, 0 suspect), all **23** error codes cited exist exactly
once in `src/core/error-codes.ts`, and the six-value `PaymentTransaction.status` enum
(`INITIATED · PENDING · SUCCEEDED · FAILED · CANCELLED · REFUNDED`) matches
`src/modules/payments/models/payment-transaction.model.ts:233`. No corrections were needed.
This folder is a **historical instalment** — it records what Phases D · 0 · 1 changed, and later
phases are covered by their own changelogs.

Everything Phases D, 0 and 1 changed for the native app an agency or a delivery agent carries.
Base URL `http://localhost:8022/api` in development; sessions are **bearer**, minted by
`/api/auth/mobile/*`.

**The short version: almost nothing in this app changed, and that is the important fact.**
Phase 1 was a one-sided change inside jovi-mall's payments module — **geo-tracker source was not
modified** and neither was wi-admin. Delivery, tracking, COD, shipments, offers and earnings are
untouched. What did change is the one place this app takes money from its own user: **plans and
credits**.

§ 5 lists what did *not* change, explicitly, because "did Phase 1 break tracking?" is the
question worth answering in writing.

---

## 1 · Plans and credits — the surface that changed

An agency buys plans and credits at `/api/agency/*`; an agent at `/api/agent/*`. The two mounts
are generated from one controller factory, so they are identical in shape — and identical to the
vendor dashboard's, documented in full in
[vendor-agency-dashboard.md](./vendor-agency-dashboard.md).

| Purpose | Agency | Agent |
|---|---|---|
| Plans available for this role | `GET /api/agency/plans` | `GET /api/agent/plans` |
| Current plan + entitlements | `GET /api/agency/plan` | `GET /api/agent/plan` |
| **Buy a plan** | `POST /api/agency/plans/:planId/purchase` | `POST /api/agent/plans/:planId/purchase` |
| Re-check a purchase | `POST /api/agency/plan-purchases/:id/verify` | `POST /api/agent/plan-purchases/:id/verify` |
| Credit balance | `GET /api/agency/credits` | `GET /api/agent/credits` |
| Credit packs | `GET /api/agency/credits/packs` | `GET /api/agent/credits/packs` |
| **Buy credits** | `POST /api/agency/credits/topups` | `POST /api/agent/credits/topups` |
| Re-check a top-up | `POST /api/agency/credits/topups/:id/verify` | `POST /api/agent/credits/topups/:id/verify` |
| Expiry-notice setting | `GET`/`PATCH /api/agency/settings` | `GET`/`PATCH /api/agent/settings` |

**What Phase 1 changed:** each purchase and top-up now carries a **merchant reference**
(`merchant_ref`: `jm_pp_` or `jm_ct_` followed by 32 hex characters) that the mobile-money
provider echoes back on its callback. That reference is what lets the callback find the row and
settle it — neither kind of row creates a `PaymentTransaction`, which is exactly why a callback
used to find nothing, log "unknown transaction" and answer success.

**Why this matters more on mobile than on a desktop dashboard:** a native app is backgrounded
the moment the user switches to their mobile-money app to approve the charge, and on a poor
connection the poll that used to be the *only* settlement path was the first thing to die. Now:

- **Settlement no longer depends on your app being foregrounded.** The callback settles it.
- If the callback is lost, a background sweep re-verifies pending purchases and top-ups against
  the provider's own record every 10 minutes, for rows between 10 minutes and 72 hours old.
- Polling `/verify` is still worth doing while the user is watching, because it gives them an
  answer now. It is no longer required for correctness.
- Both paths are idempotent and race-safe: a callback arriving while your poll is in flight
  applies the plan or credits exactly once.

### Request bodies

`POST .../plans/:planId/purchase`:

| Field | Type | Required | Rules |
|---|---|---|---|
| `gateway` | `"NOTCHPAY"` \| `"MYCOOLPAY"` \| `"STRIPE"` | ✅ | |
| `channel` | object | optional — defaults to `{}` | |
| `channel.phoneNumber` | string | needed for mobile money | **E.164**: `+237650123456` |
| `channel.phoneOperator` | `"MTN"` \| `"ORANGE"` \| `"MOOV"` | optional | Send it when the app knows it |
| `channel.cardToken` | string | optional | Stripe |
| `channel.customerEmail` | string | optional | Must be a valid address |
| `channel.customerName` | string | optional | |

`POST .../credits/topups` takes the same body plus a required **`packCode`** — one of
`pack_100` (100 credits, 600 XAF), `pack_320` (320 / 1800), `pack_1100` (1100 / 6000),
`pack_2250` (2250 / 12000). Read them from `GET .../credits/packs` rather than hard-coding.

### Response

`201` with `{ success: true, data: { purchase | topup, instructions }, message }`. Every field of
both rows — including the new `merchant_ref` — is tabulated in
[vendor-agency-dashboard.md § 2 and § 3](./vendor-agency-dashboard.md).

---

## 2 · The two mobile-money branches your UI must handle

`data.instructions` is gateway-specific, may be `null`, and every field on it is optional.

| Field | Present when | What the app does |
|---|---|---|
| `ussdCode` | Mobile money, when the provider returned one | Show the code. **Often absent on NotchPay** — a direct MTN charge pushes an approval prompt to the handset and returns no code at all |
| `requiresOtp: true` | **My-CoolPay Orange Money** | The operator SMSes a code, and nothing is charged until it comes back. There is **no** `ussdCode` on this branch. See the warning in § 3 |
| `message` | Always, on mobile money | Render it — it is our copy, not the provider's. NotchPay's own text on the confirm flow is "Payment is being processed", which tells a user standing at a checkout nothing |
| `expiresAt` | NotchPay, sometimes | Session expiry |
| `clientSecret` · `chargedAmount` · `chargedCurrency` | Stripe | Stripe charges in USD while the plan price stays XAF |

**Operators.** NotchPay's direct charge takes an explicit channel, so MTN or Orange must be known
before the call. A declared `phoneOperator` always wins; otherwise the Cameroon prefix table
decides (`650-654`, `670-679`, `680-684` → MTN; `655-659`, `685-689`, `690-699` → ORANGE); and
if neither can answer, the request is refused with `422 PAYMENT_OPERATOR_UNDETERMINED`. **Ask the
user which network they are on** rather than retrying with a guess — sending the wrong channel
reaches them as "payment declined". `+237650123456`, `237650123456` and `650123456` all resolve
identically. `MOOV` has no Cameroon mobile-money rail on either provider, and Nexttel (`66x`) and
Camtel (`62x`) numbers resolve to nothing.

---

## 3 · ⚠ The Orange-Money-on-billing gap

The one-time-code endpoint added in Phase 1 is:

```
POST /api/payments/:transactionId/authorize      body: { "code": "123456" }   // 4–8 digits
```

It resolves `:transactionId` against **`payment_transaction`**, the collection that backs
customer checkout. **A plan purchase and a credit top-up create no row there**, so passing a
purchase or top-up id answers `404 PAYMENT_TRANSACTION_NOT_FOUND`.

**Consequence:** if this app offers **My-CoolPay** to a user on an **Orange** number for a plan
or a credit pack, `initiate` can answer `requiresOtp: true` and there is no first-party endpoint
to submit the code to. MTN numbers are unaffected — they take the USSD/push path.

Until that is closed, the safe options are: offer **NotchPay** for Orange numbers on billing, or
detect `requiresOtp` on a billing response and tell the user to complete the purchase another
way. **Do not** invent a workaround against `gateway_ref` — it is the provider's reference, and
that route does not accept it.

For **customer checkout** the endpoint works exactly as documented in
[customer-app.md § 3](./customer-app.md): 5 attempts
(`PAYMENT_OTP_MAX_ATTEMPTS`), `details.attemptsRemaining` on each refusal, and the sixth wrong
code fails the transaction permanently.

---

## 4 · Errors this app can see

| `error.code` | Status | `category` | When |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | `validation` | Schema failure. `details.fields[]` gives `{ path, message, code }` per field |
| `BILLING_PLAN_NOT_FOUND` | 404 | `not_found` | |
| `BILLING_PLAN_INACTIVE` | 409 | `conflict` | |
| `BILLING_PLAN_ROLE_MISMATCH` | 409 | `conflict` | An agent buying an agency plan, or the reverse |
| `BILLING_PLAN_NOT_PURCHASABLE` | 409 | `conflict` | A free plan — it is the default tier |
| `BILLING_PENDING_PLAN_EXISTS` | 409 | `conflict` | One plan is already queued to activate at expiry. Money is deliberately not taken for a plan that cannot be applied |
| `BILLING_TOPUP_PACK_NOT_FOUND` | 404 | `not_found` | Unknown `packCode` |
| `BILLING_PLAN_PURCHASE_NOT_FOUND` · `BILLING_TOPUP_NOT_FOUND` | 404 | `not_found` | Unknown id, or another owner's |
| `BILLING_PURCHASE_INVALID_STATE` · `BILLING_TOPUP_INVALID_STATE` | 409 | `conflict` | No `gateway_ref` yet — the charge never opened |
| `PAYMENT_OPERATOR_UNDETERMINED` | 422 | `business_rule` | Ask which network |
| `PAYMENT_CURRENCY_NOT_SUPPORTED` | 422 | `business_rule` | A minor-unit currency on a mobile rail |
| `PAYMENT_INITIATION_FAILED` | 502 | `external_service` | The gateway refused or threw; the row is marked `failed` |
| `PAYMENT_GATEWAY_NOT_IMPLEMENTED` | 503 | `external_service` | That gateway is not configured on this deployment |
| `NOTCHPAY_REQUEST_FAILED` · `MYCOOLPAY_REQUEST_FAILED` | 502 | `external_service` | The provider answered non-2xx |
| `NOTCHPAY_UNREACHABLE` · `MYCOOLPAY_UNREACHABLE` | 503 | `external_service` | Timeout, DNS, refused connection. 15 s default timeout |
| `RATE_LIMIT_EXCEEDED` | 429 | `rate_limit` | `details.retryAfterSeconds`. Identity-scoped ceilings are 1200/min for an agent and 900/min for an agency |
| `SYSTEM_MAINTENANCE_ACTIVE` | 503 | `external_service` | See § 6 |

For `external_service` and `internal`, the message is replaced with a generic default and
`details` is dropped **in every environment** — a provider's own error text never reaches this
app. Show your own copy and offer a retry; that is what the category is for.

**A real failure is now a real failure.** Before Phase 1, an unconfigured mobile gateway
fabricated a `PENDING` response with a hard-coded USSD code, so a purchase *looked* started while
no money moved and no error was raised anywhere. That branch is deleted.

---

## 5 · What Phase 1 did **not** touch

Stated explicitly, because the app's core loops all sit in this list:

- **Tracking.** geo-tracker source was not modified in Phase 1. The WebSocket handshake, the
  `device_state` frame, Tracking Allow, tracking sessions, the trail and the live position are
  all exactly as they were.
- **COD.** Cash on delivery never goes through a gateway: it is settled by the agent submitting
  the customer's delivery code. No COD endpoint, code or deadline changed.
- **Shipments, offers and assignment.** Accept/reject/timeout, capacity, reassignment and the
  `handing_over` status are untouched.
- **Earnings and payouts.** Escrow, release and the payout-request queue are unchanged. Payouts
  are still made by a human transferring money and pasting a reference — **automated
  disbursement was explicitly kept out of Phase 1**: My-CoolPay's `payout` is IP-allowlisted to
  at most three pre-authorised server addresses (a container on a rotating address cannot use
  it), and NotchPay's transfer API is available but unbuilt. That decision belongs to Phase 6.
- **Auth.** `/api/auth/mobile/*` is unchanged, including the detail that
  `POST /api/auth/mobile/refresh` stays available during a `readonly` maintenance window because
  it is a bearer client's only renewal path.
- **Agent and agency contracts, the directory, and the request → accept/reject/withdraw
  handshake.** Untouched.

---

## 6 · Maintenance windows, and what still works

`POST .../purchase` and `POST .../topups` are **writes**, so they are refused with
`503 SYSTEM_MAINTENANCE_ACTIVE` during both a `readonly` and a `down` window. Two things stay
reachable in every mode and are worth knowing about:

- **`/api/webhooks/*`** — so a payment already in flight still settles during a window. (An
  operator can override this per window with `blockWebhooks`, which is what they do when the
  window exists *because of* a migration on payments.)
- **`/api/internal/agents/*` and `/api/tracking/*`** — geo-tracker depends on both for
  authorization verdicts, so blocking them would turn a jovi-mall maintenance window into a
  tracking outage.

`POST /api/auth/mobile/refresh` is exempt in `readonly` (blocked in `down`): it mints a token and
writes nothing, and without the exemption every native client would be signed out fifteen
minutes into a window that was supposed to leave reads working.

---

## 7 · Phase D decisions that will reach this app

All ten were answered on 2026-08-18. Three land here, and **none is built yet**:

| Decision | Answer | Status |
|---|---|---|
| **Q-7 · What is the longest plausible delivery in this market?** | **`TRACKING_SESSION_TTL = 72 hours`**, replacing an unmeasured 48-hour default | Decided (`geo-tracker/docs/ADR-B01-SESSION-TTL.md`). **Implemented in Phase 4.C.2.** The constant still defaults to **48h** in geo-tracker today, so a tracking session can still lapse under a delivery that runs longer than two days |
| **Q-3 · Should a bearer session have an absolute cap?** | **90 days**, carried as a stateless `auth_time` claim | Decided (`jovi-mall/docs/ADR-A03-SESSION-CAP.md`). **Phase 4.A.5.** This app is a bearer client, so it is the one most affected: today a refresh token rotates indefinitely; afterwards a 90-day-old session stops refreshing and the user must sign in again. Build the re-login path so it does not lose in-progress work |
| **Q-5 · Who can download whose uploads?** | Scan on ingest **and** move the three private upload trees behind auth | Decided (`jovi-mall/docs/ADR-A01-UPLOAD-DOWNLOAD-MAP.md`). **Phase 4.A.4.** Uploaded files are served today by an unauthenticated static mount — do not cache or hard-code storage URLs, because they will require a session |

Two more are worth knowing even though they do not change this app's calls: **Q-1** decided that
geo-tracker will gain a *service-caller* model so administrators can eventually see a live
position (unbuilt, Phase 6.I), and **Q-10** pinned the release shape — Docker for all three
services, Node 22 LTS, uploads off the container filesystem.

---

## 8 · What Phase 0 means for you

Nothing on the wire. It is why the contract above can be relied on: all three backends are now in
Git with remotes, the previously-ignored test corpus and migrations are tracked, `scripts/` is
type-checked and linted, and CI runs every suite on every push — including `npm run test:payments`,
92 DB-free assertions over the gateway signatures, the status-code table, the merchant-reference
format, the operator resolver and the money cross-check.
