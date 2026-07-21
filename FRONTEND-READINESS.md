# Frontend Integration Readiness — Audit & Report

**Date:** 2026-07-17 · **Scope:** both backends — `jovi-mall/` (Node/Express) and `geo-tracker/` (Go).
**Goal:** frontend developers can build the entire app from `api-doc/` without reading backend code.

> This report is the capstone of a readiness audit + a first remediation pass. It lists what was
> found, what was changed in this pass, the **breaking changes introduced**, and what remains. Start
> integration from [`api-doc/README.md`](./api-doc/README.md) (jovi-mall) and
> [`../geo-tracker/api-doc/README.md`](../geo-tracker/api-doc/README.md) (geo-tracker).

---

## 0. What was changed in this pass

### Code (jovi-mall) — verified `tsc --noEmit` + `npm run lint` clean

| Change | Files |
|---|---|
| **New standard success-response helper** (`sendSuccess` / `sendCreated` / `sendPaginated` / `sendMessage`) | `src/core/responses.ts` (new) |
| Standardized **auth** responses to `{ success, data }` (was bare `{ user, role, role_entity }`) | `src/modules/auth/auth.controller.ts`, `src/modules/auth/controllers/browser-auth.controller.ts` |
| Standardized **WhatsApp** + **Telegram** user-facing link endpoints | `src/modules/whatsapp/whatsapp.controller.ts`, `src/modules/telegram/telegram.controller.ts` |
| Standardized **vendor inventory** (also fixed non-standard `pagination.totalPages` → `meta.pages`) | `src/modules/catalog/controllers/vendor-inventory.controller.ts` |
| Standardized **admin orders** (also fixed `meta.totalPages` → `meta.pages`) | `src/modules/orders/admin-order.controller.ts` |
| **Wired the customer digital-delivery feature** — mounted at `/api/digital`; fixed the `customerId` auth bug (now `req.auth.role_entity._id`); added `requireAuth`+`requireRole('customer')`; removed try/catch that masked `DIGITAL_*` error codes; standardized responses | `src/modules/digital-delivery/routes/customer.routes.ts`, `src/api/index.ts` |
| Standardized **admin platform earnings ledger** (`{success, items, total, page, limit}` → `{success, data, meta}`) | `src/modules/earnings/controllers/admin-earnings.controller.ts` |
| Standardized **Google Calendar** JSON responses (status/test/disconnect/callback-fallback) to the envelope; redirect flow unchanged | `src/modules/integrations/calendar/google/google.routes.ts` |
| Commented out (not deleted) two superseded/dead digital route files | `digital-delivery/routes/vendor.routes.ts`, `digital-delivery/routes/customer-digital-products.routes.ts` |

Provider **webhooks** (`/webhooks/stripe|whatsapp|telegram`, payment gateways) were **intentionally
left raw** — they answer Stripe/Meta/Telegram, not the frontend, and those providers own the contract.
The `/api/health` probe likewise keeps its `{ status, timestamp }` shape.

### Docs (jovi-mall/api-doc)

| Doc | Status |
|---|---|
| `README.md` (root index: envelope, pagination, auth, **permission matrix**, full doc map) | **new** |
| `auth/README.md` | **updated** for the new envelope + fixed a documented-but-nonexistent `POST /auth/refresh` |
| `customer/profile.md` | **new** |
| `admin/profile.md` | **new** |
| `admin/orders.md` | **new** |
| `admin/agents.md` | **new** |
| `agent/tickets.md` | **new** |
| `customer/tickets.md` | **new** |
| `uploads/README.md` (role-neutral) | **new** |
| `customer/digital-products.md` | **new** (library + download-link + execute flow) |
| `telegram/README.md` | **new** (account linking & notifications, all roles) |
| `integrations/google-calendar.md` | **new** (OAuth connect/callback/status/disconnect/test) |
| `admin/earnings.md` | **new** (platform balances + ledger) |

---

## 1. Missing / unreachable endpoints

| # | Finding | Status |
|---|---|---|
| 1 | **Customer digital-product delivery was unmounted + buggy.** The customer consumption routes (`createCustomerDigitalRoutes`: download-links, download/:token, my-products) were **defined but never mounted**, and read `(req as any).user?.customerId` — which the auth middleware never sets — so they would always 401. | ✅ **RESOLVED this pass.** Mounted at `/api/digital`; `customerId` fixed to `req.auth.role_entity._id` (verified: `order.customer_id` refs `MODELS.CUSTOMER`, the same id `grantEntitlement` stores); added customer auth guards; standardized responses; removed try/catch that masked `DIGITAL_*` codes. Boot-checked (app imports OK — no cycles / dup model registration). Documented in [customer/digital-products.md](./api-doc/customer/digital-products.md). **Note:** the vendor side was already live via the catalog module (per-variant `/api/vendor/products/:productId/variants/:variantId/digital/*`); `createVendorDigitalRoutes` and `vendor-digital-config.routes.ts` are **superseded dead code** and were correctly left unmounted. `customer-digital-products.routes.ts` is a redundant duplicate of `/api/digital` and remains unmounted. |
| 2 | **Agent-contract refactor surface not mounted** (agent COD threshold, contract terms, settlements, KYC/ban admin, contract status-request inbox). | 🔒 **Blocked by design** — `AGENT-CONTRACT-REFACTOR.md` §5 defers these behind the prepaid-agent-cut, the trust engine, and a data migration (without which deposits 422). **Do not build yet.** Documented in `api-doc/admin/agents.md`. |
| 3 | `POST /api/tracking/agent-state` (jovi-mall receiver for geo-tracker tracking-state pushes). | 🔒 **Internal, deferred** — geo→jovi, not frontend-facing. geo-tracker drops failed deliveries best-effort; safe to ship geo side first (per root `CLAUDE.md`). |

No other "service exists, route missing, safe to wire" cases were found — the rest of the surface is mounted.

## 2. Missing WebSocket events

- **jovi-mall has no WebSocket server** (pure Express) — correct by design; all realtime lives in geo-tracker.
- **geo-tracker** WS is documented (`geo-tracker/api-doc/tracking-websocket.md`). One deliberate gap:
  **no outbound WS broadcast of tracking-*state* changes to watchers** — state reaches clients via the
  `/tracking/sessions` HTTP reads + the jovi-mall notification. Live **position** fan-out works. This is
  documented as intentionally deferred, not a defect.

## 3. Missing documentation

Addressed this pass (see §0). **Now documented (previously gaps):**
- ✅ **Telegram account-linking** (`/webhooks/telegram/link-token|status|toggle|disconnect|send`) → [telegram/README.md](./api-doc/telegram/README.md).
- ✅ **Google Calendar OAuth** connect/callback/status/disconnect/test → [integrations/google-calendar.md](./api-doc/integrations/google-calendar.md). (Also standardized its 4 raw JSON responses to the envelope; the redirect flow is unchanged.)
- ✅ **Admin platform earnings** (`/admin/earnings/platform` + `/ledger`) → [admin/earnings.md](./api-doc/admin/earnings.md). (Also standardized `getPlatformLedger` from `{success, items, total, page, limit}` → `{success, data, meta}`.)

**Remaining doc gaps (implemented & user-facing, not yet documented):**
- **Generic payments** endpoints (`/payments/*` initiate/status) — checkout payment is partially covered under `customer/orders.md`; no dedicated payments doc. *(Deferred per request — "deal with payments later".)*
- Confirm **WhatsApp** user link/status/unlink endpoints are fully covered by `whatsapp/README.md`.
- Per-endpoint validation tables for the large vendor/catalog/booking modules (see §7).
- **Not exhaustively verified:** every one of the ~44 routers has *not* been line-by-line diffed against its doc; the above are the known gaps.

## 4. Endpoints that require refactoring

| Area | Issue | Recommendation |
|---|---|---|
| Digital delivery | Unmounted + `customerId` auth bug (§1.1) | Mount + fix `customerId` resolution |
| Auth `me` vs `auth-me` | `GET /auth/me` now returns `{ user, role, role_entity }` (doc previously said user-only) | Doc corrected; consider consolidating the two "current user" endpoints |
| Pagination param parsing | `page`/`limit`/`sort` parsed per-controller (no shared query middleware) | Extract a shared `parsePagination(req.query)` helper so param names/limits can't drift |

## 5. Inconsistent responses — **fixed** (breaking; see §9)

Before this pass the success shape was ~85% `{ success, data, meta? }` but with real stragglers:
- **auth** returned bare `{ user, role, role_entity }` — the first thing every client integrates.
- **browser-auth** used `{ success, user }` (no `data`).
- **whatsapp / telegram** link endpoints returned bare service objects.
- **vendor-inventory** + **admin-orders** used a non-standard `pagination: { …, totalPages }` block.

All of the above now emit the standard envelope. **Provider webhooks and `/health` are the documented
exceptions.** geo-tracker still returns **plain-text errors** (`http.Error`) rather than the structured
envelope — a cross-service inconsistency the frontend must handle (documented in
`geo-tracker/api-doc/errors/README.md`); converting it is a geo-tracker task, not done here.

## 6. Permission (in)consistencies

- Role guards (`requireRole`) are consistent and clear across routers. No privilege gaps found.
- There was **no consolidated permission matrix** — now added to `api-doc/README.md`.
- Agents deliberately have **no** pickup/deliver/return/cancel endpoints (transitions are agency-driven);
  this is an easy false assumption for a frontend and is now called out in the matrix and agent docs.

## 7. Missing validation

- Zod validation is applied widely and bubbles to the global error handler as
  `VALIDATION_ERROR` with `details.fields[]`. Pipeline is sound.
- **Not yet done:** a per-endpoint validation-rules pass across all 44 routers. The docs written this
  pass include full validation tables; the large pre-existing vendor/catalog/booking docs should get the
  same treatment. No endpoint was found *lacking* validation, but coverage isn't yet exhaustively verified.

## 8. Missing examples

- New docs include request + success + error examples. Older docs are example-rich already.
- Gap: examples in older docs still show pre-standardization shapes in a few places (e.g. any doc that
  showed a bare auth payload). The root index's envelope section is the authoritative override; a sweep
  to update stale inline examples is recommended.

## 9. Breaking changes introduced ⚠️

You chose **full standardization (breaking)**. The following response shapes changed — **update the
frontend accordingly**:

| Endpoint(s) | Old shape | New shape |
|---|---|---|
| `POST /auth/register`, `/auth/login`, `GET /auth/me`, `/auth/auth-me/:role`, `POST /auth/add-role` | `{ user, role, role_entity }` | `{ success, data: { user, role, role_entity } }` |
| `POST /auth/logout` | `{ success, message }` | `{ success, data: null, message }` |
| `POST /auth/send-email-verification`, `GET /auth/verify-email`, `POST /auth/request-wa-verification` | bare service object | `{ success, data: <object> }` |
| `POST /auth/browser/login`, `/auth/browser/refresh` | `{ success, user }` | `{ success, data: { user } }` |
| `GET /api/whatsapp status`, telegram `link-token`/`status`/`toggle`/`send` | bare object | `{ success, data: <object> }` |
| `GET /vendor/inventory/history`, `/reservations` | `{ logs\|reservations, pagination: {…, totalPages} }` | `{ success, data: [...], meta: { total, page, limit, pages[, totalReserved] } }` |
| `GET /vendor/inventory/alerts`, `PATCH /vendor/inventory/bulk-update` | bare result | `{ success, data: <result> }` |
| `GET /admin/orders/disputes` | `{ success, data, meta:{…totalPages} }` | `{ success, data, meta:{ total, page, limit, pages } }` |
| `POST /admin/orders/:id/dispute/resolve` | `{ success, data, message }` (unchanged shape) | now via helper (identical output) |
| `GET /admin/earnings/platform/ledger` | `{ success, items, total, page, limit }` | `{ success, data: [...], meta: { total, page, limit, pages } }` |
| `GET /integrations/google/status` | `{ connected, email?, expiresAt? }` | `{ success, data: { connected, email?, expiresAt? } }` |
| `GET /integrations/google/test` | `{ success: <bool> }` | `{ success: true, data: { ok: <bool> } }` |
| `POST /integrations/google/disconnect`, callback JSON fallback | `{ success, message }` | `{ success, data: null, message }` |

**Not changed** (already conformant): the ~85% of controllers already emitting `{ success, data, meta? }`.
**Not changed** (deliberate): provider webhooks, `/api/health`.

## 10. Frontend Integration Score

| Service | Before | After this pass | Notes |
|---|---:|---:|---|
| **jovi-mall** | 7.5 / 10 | **9.1 / 10** | Envelope uniform; index + permission matrix + 11 new docs; digital delivery wired; Telegram/Google-OAuth/admin-earnings now documented. Only payments doc + validation-table sweep remain |
| **geo-tracker** | 8.5 / 10 | **8.5 / 10** | Untouched this pass; strong docs; plain-text errors + deferred watcher-broadcast are the open items |
| **Overall** | ~7.5 / 10 | **~9.0 / 10** | Reaches ~9.4 once the payments doc lands and geo-tracker errors are enveloped |

---

## Remaining work (prioritized)

1. ~~Wire digital-product delivery~~ — **DONE this pass** (§1.1). Optional follow-up: delete the two
   superseded dead route files (`digital-delivery/routes/vendor.routes.ts`,
   `digital-delivery/routes/customer-digital-products.routes.ts`) once confirmed no external imports.
2. **Doc sweep for stale inline examples** — update older docs that still show pre-standardization payloads.
3. **`integrations/google` OAuth connect flow doc.**
4. **Shared pagination-query helper** + per-endpoint validation tables for the big vendor/catalog/booking docs.
5. **geo-tracker: structured error envelope** to match jovi-mall (cross-service consistency).
6. **Do NOT** build the agent-contract refactor endpoints (§1.2) until `AGENT-CONTRACT-REFACTOR.md` steps 3–7 land.
