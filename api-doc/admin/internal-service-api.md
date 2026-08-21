# The internal admin API — `/api/internal/admin/*`

**Not a frontend surface.** This is the service-to-service door the **wi-admin** backend calls. No
user session is involved: wi-admin is a service, holds no `users` row here, and carries the
administrator who asked in headers instead of impersonating them.

> ## ⚠️ Since the Phase 5 cutover this is the ONLY administrative surface on jovi-mall
>
> This page used to say *"if you are building a dashboard, you want `/api/admin/*` — the public
> admin surface, which most of this mirrors"*. **There is no public admin surface any more.**
> Every `/api/admin/*` mount was deleted at the cutover, along with the second authorization
> model it carried: `requireRole(['admin'])` on a platform `users` row that holds no tier, no
> permission set and no audit identity.
>
> **A dashboard does not call this door either.** It calls wi-admin's `/api/v1/*`, which resolves
> the administrator's tier and permissions, writes the audit row, and then calls one of the
> routes below on their behalf. See `admin/docs/api/` in the wi-admin repository.
>
> The per-family pages this document links to are still accurate for request and response shapes
> — they were rewritten to the internal prefix rather than deleted, because one factory always
> served both mounts and the payloads never differed.

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

Most routers were **one factory mounted twice** — once publicly under `/api/admin/*` behind
`requireAuth + requireRole(['admin'])`, once here behind `requireAdminCaller`, with identical
paths after the prefix. **Phase 5 Part E deleted every public mount**, so each factory now has
exactly one instantiation and this is it. The linked page is authoritative for request and
response shapes; each was rewritten to the internal prefix rather than deleted, because the
payloads never differed between the two mounts.

The **"was public"** column is kept because the difference is still legible in old data: an
`admin_action_log` row or a dashboard bug report from before the cutover names the public URL,
and for `/billing` and `/agencies` that URL was shaped differently, not merely prefixed.

**111 routes in fifteen groups**, counted from the route tables in the factory files on
2026-08-20 (the previous figure here, 88 in thirteen, predated `/tickets`, `/files` and
`/messaging`).

| Group | Routes | Was public at | Documented in |
|---|---|---|---|
| `/cod/*` | 13 | ~~`/api/admin/cod/*`~~ | [cod.md](./cod.md) |
| `/agents/*` | 14 | ~~`/api/admin/agents/*`~~ | [agents.md](./agents.md) |
| `/agencies/*` | 5 | ~~`/api/admin/delivery-agencies/*`~~ — **different name** | [delivery-agencies.md](./delivery-agencies.md) |
| `/billing/*` | 8 | ~~`/api/admin/{plans,entitlements,vendors,agencies,agents}/…`~~ — **no `/billing` segment** | [billing.md](./billing.md) |
| `/earnings/*` | 4 | ~~`/api/admin/earnings/*`~~ | [earnings.md](./earnings.md) |
| `/payout-requests/*` | 4 | ~~`/api/admin/payout-requests/*`~~ | [payout-requests.md](./payout-requests.md) |
| `/orders/*` | 6 | **partial** — only `GET /disputes` and `POST /:id/dispute/resolve` ever were | [orders.md](./orders.md) |
| `/tickets/*` | 19 | ~~`/api/admin/tickets/*`~~ — deleted earlier, at **Phase 17**. 18 rows moved; `POST /:ticketId/claim` is net-new | [tickets.md](./tickets.md) |
| `/vendors/*` | 8 | **never** | — see below |
| `/users/*` | 5 | **never** | — see below |
| `/shipments/*` | 2 | **never** | — see below |
| `/system/*` | 12 | **never, deliberately** | [system.md](./system.md) |
| `/dev-tools/*` | 7 | **never, deliberately** | [dev-tools.md](./dev-tools.md) |
| `/files/*` | 3 | ~~2 of 3 on `/api/files/*`~~ — ported at **Phase 5 Part B** | see below |
| `/messaging/*` | 1 | ~~`/api/webhooks/telegram/send`~~ — ported at **Phase 5 Part C** | see below |

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

### Added in the dashboard-request round

**`/files/*`** — a group of its own, and the only one on this surface carrying two different
kinds of operation.

```
POST   /files/resolve      body { fileIds: string[] } (1..100) → { files: FileDetail[] }
GET    /files/orphans      ?olderThan=<ISO>  → { data: File[], meta: { count, olderThan } }
DELETE /files/:id/permanent                  → { success, message }
```

`POST /resolve` exists because wi-admin ships every file reference as an opaque id and states
that it resolves no file URLs — correctly, because a URL is `storage.getPublicUrl(key)` and
duplicating `STORAGE_PROVIDER` across two deployments is the drift the service split exists to
prevent. But its contract then told the dashboard to resolve them *"against jovi-mall"*, and the
dashboard talks to wi-admin alone. This is the door that was missing, on the side that owns the
provider.

⚠️ **It resolves; it must never enumerate.** Explicit id set in, matching files out. Ids that
resolve to nothing are **absent** from the result rather than present-and-null — a record
legitimately outlives a file the cleanup job swept.

The other two arrived at **Phase 5 Part B**, moved off the public `/api/files` router where they
had been the only two `requireRole(['admin'])` routes. **The handlers are unchanged** — including
their own `role !== 'admin'` checks, which `requireAdminCaller` satisfies (it fabricates exactly
that shape) rather than contradicts, so they stay as a second lock on the unrecoverable one.

`/orphans` **is** a listing, which is what makes it a different thing from `/resolve`: it
enumerates, because an orphan is found rather than named. `olderThan` defaults to seven days ago
and is refused inside the last 24 hours — a file uploaded a minute ago and attached a minute later
is not an orphan, and that guard rail is what stops the delete candidate list containing it. The
response is the whole `File`, storage `key` included; **wi-admin withholds the key from its own
projection** (Phase 5 D-10), so do not assume the two shapes match.

`DELETE /:id/permanent` removes the row and then deletes the object best-effort — the database is
the source of truth, so a storage failure is logged and the delete stands rather than rolling back
into a half state. ⚠️ **The path segment is `:id`, not `:fileId`**: the handler reads
`req.params.id`. wi-admin's own path is `/files/:fileId/permanent` and carries the
repeat-the-id confirmation (Phase 5 D-9); this side takes the id it is given.

**`GET /vendors/:vendorId/products/:productId`** — the one READ on the vendor router, and the
only read anywhere on this surface that is not a verdict. It is here because projecting a product
needs two things wi-admin may not own: the storage provider, to turn `fileIds` into URLs, and
`storage-fee.calculator.ts`, to quote what the agency charges to shelve it. A record whose
*projection* needs local machinery is delegated — a corollary of ADR-009 D-6, not an exception to
D-1.

**`POST /agents/contracts/:contractId/{suspend,reinstate,deactivate}`** — administrative
intervention on one agent↔agency contract. Each resolves the contract's own `agency_id` and then
runs the ordinary agency-scoped transition, so the authority matrix, the legal `from` states, the
status-request row and the membership-event history are all the same code an agency desk runs.
`deactivate` still needs the counterparty and the §4 cash conditions and answers
`{ request, contract, blockers }` with `contract: null` when they are not met — **there is no
administrative override**, because ending a relationship that still owes an agent money is how
that money stops being anybody's responsibility.

**`POST /users/:userId/{password-reset-link,login-link}`** — send a platform party a way back
into their own account, over `email`, `whatsapp` or `telegram`.

Both mint through machinery that already existed: `PasswordResetService.issueResetLinkFor` (the
same 32-byte token, 30 minutes, single use, and the `password_changed_at` stamp that evicts every
live session) and `MessagingLoginService` (the same ten-minute session the bot `/login` flow
mints, **customer-only** by a literal in that service). A third entrance, not a second mechanism.

⚠️ **The destination is not in the request and the token is not in the response.** The address is
read from the party's own record; a caller who could name one could mail themselves a working
credential for another person's account. Rate-limited per party *and* per administrator.

### Still to come

**Telegram** is the last one — `POST /api/webhooks/telegram/send` has no internal mount, and
wi-admin reaches it through the public path. Adding one is a matter of repeating the same factory
pattern per router (Phase 5 Part C).

Tickets gained theirs (`/tickets`, above). The **blog** never will: ownership of `articles` and
`article_authors` MOVED to wi-admin at Phase 5 Part A (ADR-004 D-4), so there is no jovi-mall
editor left to delegate to — this service keeps the public reader and the schema only.

---

## Related

- [system.md](./system.md) — read-only diagnostics, every route a GET, nothing audited
- [dev-tools.md](./dev-tools.md) — the dangerous half
- [../tracking/agent-tracking-policy.md](../tracking/agent-tracking-policy.md) — the *other*
  service door, `/api/internal/agents/*`, for geo-tracker. Different secret, different guard
