# Phase D · 0 · 1 — frontend documentation

What the first three phases of [`PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md`](../../../PRODUCTION-READINESS/10-IMPLEMENTATION-PLAN.md)
changed, written for the people who build against the API rather than for the people who
shipped it.

- **Written:** 2026-08-18
- **Covers:** Phase D (the ten decisions), Phase 0 (custody, CI, the type checker), Phase 1
  (the payments module)
- **Does not cover:** Phases 2–7. Where a Phase D decision is *answered but not built*, the
  document that owns it says so explicitly — those are the paragraphs to read before planning
  a screen around them.

---

## Which document you read

| You build | Read | It covers |
|---|---|---|
| The **admin dashboard** (wi-admin, `/api/v1/*`) | [admin-dashboard.md](./admin-dashboard.md) | Refund verdicts per gateway, the payment settlement list and its new reference lookup, gateway integration health, the fourteenth background worker, the operations scripts, and every Phase D decision that lands on an admin screen |
| The **vendor** or **agency dashboard** | [vendor-agency-dashboard.md](./vendor-agency-dashboard.md) | Plan purchases and credit top-ups (they now settle from the gateway callback), the one-time-code branch, vendor refunds and what `REFUND_GATEWAY_NOT_SUPPORTED` means for the money |
| The **customer app / storefront** | [customer-app.md](./customer-app.md) | Checkout payments end to end: initiate, the one-time-code step, verify, read, booking payments and balances, what to poll and what not to |
| The **agency / agent mobile app** | [agency-agent-app.md](./agency-agent-app.md) | Plans and credits on a bearer session, the OTP branch on mobile, and an explicit list of what Phase 1 did **not** touch (COD, tracking, shipments) |

Each document is self-contained for its audience. Where two audiences share a surface — the
one-time-code endpoint, for example — the surface is documented in full in both, because the
alternative is a reader following a link to find the field they needed.

---

## The three phases in one paragraph each

**Phase D — the decisions register.** Ten questions that could not be answered by writing
code. All ten were answered on 2026-08-18 and each answer is recorded as an ADR in the
repository that owns its consequence. **Nine of the ten change no wire contract yet** — they
authorise work in Phases 2, 4, 5 and 6. The register is
[`11-DECISIONS-REGISTER.md`](../../../PRODUCTION-READINESS/11-DECISIONS-REGISTER.md); every
audience document below lists the decisions that will eventually land on its screens, with a
status you can plan against.

**Phase 0 — custody and the safety net.** All three backends are now in Git with remotes, the
67 previously-ignored files (27 test suites, 15 migrations, the seeds, the
`.env.example`) are tracked, `scripts/` is inside the type checker and the linter, and every
repository has CI. **No API surface changed.** It appears in these documents only where it
explains why a contract can now be trusted: the suites that guard it actually run.

**Phase 1 — the payments module.** The one phase with wire-visible change. Both mobile-money
gateways were placeholders that made no HTTP call at all; they are now real, their webhooks are
signature-verified, the status codes they answer are honest, a background sweep closes payments
whose callback never arrived, plan purchases and credit top-ups settle from the callback, and
the module has a 92-assertion suite. Design record:
[`PHASE-1-PAYMENTS-PLAN.md`](../../../PRODUCTION-READINESS/PHASE-1-PAYMENTS-PLAN.md).

---

## What a client can actually observe

Everything below is new behaviour, not a new endpoint, unless marked.

| Change | Who sees it |
|---|---|
| `POST /api/payments/:transactionId/authorize` — **new endpoint** for the one-time code | Customer app · vendor/agency dashboards · agency/agent app |
| `instructions.requiresOtp: true` — a new branch on the `initiate` response | Everyone who starts a mobile-money payment |
| `instructions.ussdCode` may be **absent** on a genuine NotchPay charge | Everyone who starts a mobile-money payment |
| `merchantRef` and `otpAttempts` — new fields on `GET /api/payments/:transactionId` | Customer app |
| `merchantRef` and `?reference=` — new field and new filter on `GET /api/v1/money/payments` | Admin dashboard |
| A mobile-money **plan purchase or credit top-up settles without polling** | Vendor · agency · agent |
| `gatewayRefundSupported` now answers two questions (does the provider have a refund API, and may our account use it) | Admin dashboard · vendor dashboard |
| A payment whose callback was lost **self-heals within 72 hours** | Everyone |
| Real gateway failures now surface as real errors instead of a fabricated `PENDING` | Everyone |

Nothing was removed, and no field changed type. A client written against the pre-Phase-1
contract keeps working; it will simply render the wrong screen on the Orange Money branch and
will keep polling for something that no longer needs polling.

---

## Shared vocabulary

These values are identical across every document and every surface below.

**Gateways** — `NOTCHPAY` · `MYCOOLPAY` · `STRIPE`. Sent and returned uppercase, always.
`NOTCHPAY` and `MYCOOLPAY` are mobile money (MTN and Orange Cameroon); `STRIPE` is cards.

**Payment status** (`PaymentTransaction.status`, and the `status` on every payment response) —
`INITIATED` · `PENDING` · `SUCCEEDED` · `FAILED` · `CANCELLED` · `REFUNDED`.

| Value | Means |
|---|---|
| `INITIATED` | The row exists; the gateway has not been called yet, or has not answered |
| `PENDING` | The customer must act — approve the prompt on the handset, dial the USSD code, submit the SMS code, or confirm a card |
| `SUCCEEDED` | The gateway confirmed. Fulfilment, stock commit and the earnings split have run |
| `FAILED` | The gateway refused, or the one-time-code attempts were exhausted |
| `CANCELLED` | The customer cancelled at the gateway |
| `REFUNDED` | The whole payment has been refunded. A partial refund leaves `SUCCEEDED` with `hasPartialRefund: true` |

> **`PENDING` is never a failure**, and two paths deliberately produce it: an unrecognised
> status word from a provider, and a verification the provider could not answer. Calling a live
> payment dead strands the customer's money, and only a `PENDING` row is re-swept.

**Payment method** — `MOBILE` · `CARD` · `CASH`. Derived from the gateway (`STRIPE` → `CARD`,
otherwise `MOBILE`); `CASH` belongs to cash-on-delivery, which never reaches this surface.

**Payment purpose** — `primary` · `booking_balance`. A booking can be paid twice: once for the
quoted price and again for a balance raised when the service ran over.

**The success envelope** — `{ success: true, ... }` on jovi-mall, `{ success: true, data, meta? }`
on wi-admin. Per-endpoint shapes are in each document.

**The error envelope** — identical in all three services since Phase 16:

```jsonc
{
  "success": false,
  "requestId": "01J8ZQ7K2C9M4V6T1B0X3H5N7P",
  "error": {
    "code": "PAYMENT_OTP_INVALID",
    "message": "The confirmation code was refused",
    "statusCode": 422,
    "category": "business_rule",
    "details": { "attemptsRemaining": 3 }
  }
}
```

`category` is one of nine values — `authentication` · `authorization` · `validation` ·
`not_found` · `conflict` · `business_rule` · `rate_limit` · `external_service` · `internal` —
and it is the one thing a client can branch on generically. `details` is omitted entirely when
absent, and is **always** dropped (with the message replaced) for `internal` and
`external_service`, in every environment.

---

## Where the authoritative contracts live

These documents describe what Phases D, 0 and 1 changed. The full per-endpoint contracts are
unchanged in location:

- [`api-doc/payments/README.md`](../payments/README.md) — the payment surface, role-neutral
- [`api-doc/customer/orders.md`](../customer/orders.md) · [`api-doc/customer/bookings.md`](../customer/bookings.md)
- [`api-doc/vendor/billing.md`](../vendor/billing.md) · [`api-doc/billing-plans-across-roles.md`](../billing-plans-across-roles.md)
- [`api-doc/admin/orders.md`](../admin/orders.md) · [`api-doc/admin/system.md`](../admin/system.md)
- [`api-doc/errors/README.md`](../errors/README.md) · [`api-doc/rate-limits.md`](../rate-limits.md)
- wi-admin: `admin/docs/api/money.md`, `admin/docs/api/orders.md`, `admin/docs/api/system.md`
