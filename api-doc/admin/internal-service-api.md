# The internal admin API — `/api/internal/admin/*`

**Not a frontend surface.** This is the service-to-service door the **wi-admin** backend calls. No
user session is involved: wi-admin is a service, holds no `users` row here, and carries the
administrator who asked in headers instead of impersonating them.

If you are building a dashboard, you want [`/api/admin/*`](./profile.md) — the public admin
surface, which most of this mirrors. This page exists so the internal surface is written down
somewhere in this repo, and so the two mounts can be told apart.

- Mount: `src/api/routes/internal-admin.routes.ts`
- Guard: `requireAdminCaller` (`src/api/middlewares/admin-caller.middleware.ts`)
- Design record: `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md`

---

## Authentication

| Header | Required | Meaning |
|---|---|---|
| `X-Service-Token` **or** `Authorization: Bearer …` | ✅ | Must equal `INTERNAL_ADMIN_SERVICE_TOKEN`. Constant-time compare |
| `X-Actor-Id` | ✅ | The wi-admin `admin_accounts._id` of the administrator who asked. Must be a valid ObjectId |
| `X-Actor-Name` | ❌ | Snapshot written beside the id. Defaults to `"Administrator"` |
| `X-Actor-Tier` | ❌ | **Accepted for logging and never read for a decision** |
| `X-Request-Id` | ❌ | Adopted verbatim, so wi-admin's audit `correlation_id` joins to jovi-mall's logs |

| `error.code` | Status | When |
|---|---|---|
| `AUTH_ADMIN_CALLER_NOT_CONFIGURED` | 503 | `INTERNAL_ADMIN_SERVICE_TOKEN` is unset. **An unset secret denies** — the whole surface is off |
| `AUTH_ADMIN_CALLER_TOKEN_INVALID` | 401 | Missing or wrong token |
| `AUTH_ADMIN_CALLER_ACTOR_MISSING` | 400 | `X-Actor-Id` absent or not an ObjectId. Refused rather than defaulted — an operation recorded against nobody is worse than a failed one |

> **This token is a full-privilege credential.** The guard checks *authentication*, never
> *permissions*: authorization is resolved in wi-admin before the call is made, deliberately
> single-sided. Its secrecy is the entire control. It is a **separate secret** from geo-tracker's
> `INTERNAL_SERVICE_TOKEN` (`/api/internal/agents/*`), with a different blast radius.

Two structural properties follow from being a service door:

- **Exempt from the maintenance gate**, the whole prefix — it is the door an operator uses to turn
  maintenance *off*, and they need `/system/*` to decide when to exit. See
  [dev-tools.md](./dev-tools.md#the-exemption-list).
- **Exempt from rate limiting**, via the `internal_service` caller class resolved from the shared
  secret. Throttling wi-admin turns an administrator's action into an outage. See
  [../rate-limits.md](../rate-limits.md).
- **Not covered by `adminActionLogMiddleware`.** That middleware is attached to `/admin` only.
  These calls are already audited in wi-admin against a real administrator identity; recording
  them here would double-count every ported operation.

---

## The rule that decides what is here

**Delegate a verdict, read a record** (ADR-009 D-1). wi-admin reads the shared `jovi_mall`
database *directly* for append-only records — the earnings ledger, `delivery_agents`,
`agent_agency_contracts`, `users`. What it cannot do directly is anything whose correctness
depends on code that runs in *this* process: a transaction paired with a post-commit event
emission, a balance derived from four sub-balances, or an answer about this process's own state.
Those are asked for over HTTP.

---

## Route inventory

Most routers are **one factory mounted twice** — once publicly under `/api/admin/*` behind
`requireAuth + requireRole(['admin'])`, once here behind `requireAdminCaller`. Where that is the
case the paths after the prefix are identical and the linked public doc is authoritative for
request and response shapes.

82 routes in twelve groups.

| Group | Routes | Public twin | Documented in |
|---|---|---|---|
| `/cod/*` | 13 | `/api/admin/cod/*` | [cod.md](./cod.md) |
| `/agents/*` | 11 | `/api/admin/agents/*` | [agents.md](./agents.md) |
| `/agencies/*` | 5 | `/api/admin/delivery-agencies/*` | [delivery-agencies.md](./delivery-agencies.md) |
| `/billing/*` | 8 | `/api/admin/{plans,entitlements,vendors,agencies,agents}/…` | [billing.md](./billing.md) |
| `/earnings/*` | 4 | `/api/admin/earnings/*` | [earnings.md](./earnings.md) |
| `/payout-requests/*` | 4 | `/api/admin/payout-requests/*` | [payout-requests.md](./payout-requests.md) |
| `/orders/*` | 6 | **partial** — only `GET /disputes` and `POST /:id/dispute/resolve` have one | [orders.md](./orders.md) |
| `/vendors/*` | 7 | **none** | — see below |
| `/users/*` | 3 | **none** | — see below |
| `/shipments/*` | 2 | **none** | — see below |
| `/system/*` | 12 | **none, deliberately** | [system.md](./system.md) |
| `/dev-tools/*` | 7 | **none, deliberately** | [dev-tools.md](./dev-tools.md) |

### The groups with no public twin

**`/vendors/*`** — writes only; wi-admin reads `vendors` directly.

```
POST   /vendors/:vendorId/suspend
POST   /vendors/:vendorId/restore
POST   /vendors/:vendorId/kyc/approve
POST   /vendors/:vendorId/kyc/reject
PATCH  /vendors/:vendorId/settings
POST   /vendors/:vendorId/products/:productId/suspend
POST   /vendors/:vendorId/products/:productId/restore
```

Suspending a vendor takes their whole catalogue off sale **inside the transaction that moves their
status**, and the restore re-runs the activation gate on every listing rather than blindly
republishing it. A second writer would reproduce the status change and miss all of that.

**`/users/*`** — writes only, for the same reason.

```
POST   /users/:userId/suspend
POST   /users/:userId/restore
PATCH  /users/:userId
```

A suspension is only real by virtue of the checks in `requireAuth`, `login` and the refresh
rotation — all of which live here.

**`/shipments/*`**

```
POST   /shipments/:shipmentId/cancel
POST   /shipments/:shipmentId/reassign
```

**`/orders/*`** — four of its six are internal-only, and their absence from `/api/admin/orders` is
deliberate: a refund moves money through a payment gateway, and `requireRole(['admin'])` on a
platform `users` row is a credential that predates wi-admin's permission catalog and knows nothing
about `orders.refund` being tier-2-only.

```
GET    /orders/disputes                        ← also public
POST   /orders/:orderId/dispute/resolve        ← also public
POST   /orders/:orderId/cancel                 ← internal only
POST   /orders/:orderId/dispatch               ← internal only
GET    /orders/:orderId/refund-eligibility     ← internal only
POST   /orders/:orderId/refund                 ← internal only
```

### Still to come

Tickets, blog, files and telegram have **no** internal mount yet — wi-admin reaches those through
the public `/api/admin/*` surface. Adding one is a matter of repeating the same factory pattern per
router.

---

## Related

- [system.md](./system.md) — read-only diagnostics, every route a GET, nothing audited
- [dev-tools.md](./dev-tools.md) — the dangerous half
- [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md) — the *other*
  service door, `/api/internal/agents/*`, for geo-tracker. Different secret, different guard
