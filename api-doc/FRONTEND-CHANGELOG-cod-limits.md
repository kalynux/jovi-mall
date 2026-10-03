# Frontend changelog — COD limits (2026-10-02)

> **Backend change: 2026-10-02 · Not deployed yet** (deploy needs `npm run migrate:delivery-fee-proposal-indexes`). One consolidated page per app, covering this page **and** the same day's fee proposals, salary contracts and notifications: [vendor](./vendor/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) · [agency](./agency/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) · [agent](./agent/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) · [customer](./customer/FRONTEND-CHANGELOG-cod-limits-and-delivery-fees.md) · [admin dashboard](../../admin/api-doc/FRONTEND-CHANGELOG-cod-limits.md). Decision record: [ADR-A09](../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md).

Owner decisions of 2026-10-02 restructure who may hold how much cash-on-delivery money. Five
changes, one per section below, then a per-dashboard checklist. Everything is **additive on the
wire** except the agent pool's `source` value (`plan` → `default`) and the meaning of
`max_cod_pool` on plans.

| # | Change | Who sees it |
|---|---|---|
| 1 | Agent COD pool = **500 000 for every verified agent**, whatever their plan | agent app, admin, landing |
| 2 | Agency COD **limit** = **1 000 000** by default; an administrator can **pin** another amount | agency, admin |
| 3 | Vendor **COD terms**: `codEnabled`, `maxCashPerAgency` | vendor, agency, storefront/bot checkout |
| 4 | Dispatch to an agency is **gated** by #2 and #3; auto-redirect **holds**, manual dispatch **refuses unless `force`** | vendor |
| 5 | Agency → agent assign/reassign accept **`force`**, waiving the agent's amount limit only | agency, agent app |

New error codes: **`COD_VENDOR_NOT_ACCEPTED`** (422), **`COD_AGENCY_LIMIT_EXCEEDED`** (422).
Reference: [errors/README.md](./errors/README.md).

---

## 1 · The agent's COD pool no longer comes from the plan

| Before (2026-09-21) | Now |
|---|---|
| verified → plan's `max_cod_pool` (Free 500 000 · Plus 1 000 000 · Pro 2 000 000) | verified → **500 000**, every agent |
| `pool.source: "plan"`, `pool.planCode: "agent_plus"` | `pool.source: "default"`, `pool.planCode: null` (deprecated, always null) |
| changing plan reset the pool | plan changes do nothing to the pool |

Unchanged: unverified → 0 (`not_verified`); an administrator's pin (`override`) outranks the
default up or down and never outranks KYC; the agent may still lower their own pool
(`PUT /api/agent/cod/pool`). Agents synced under the old rule converge on the next nightly
reconcile (or a manual trigger of `agent-cod-pool-reconcile`); until then a stale
`source: "plan"` may still be read — **render it like `default`**.

`max_cod_pool` stays on plan objects (public, agent and admin billing endpoints) but is
**dormant**: do not advertise it as a plan benefit. `AGENT_COD_POOL_ABOVE_CEILING.details.hint`
no longer says "upgrade your plan".

## 2 · Agencies have a COD cash limit

An agency may hold at most **1 000 000 XAF** of COD cash that has not reached the platform:

```
exposure = in-flight COD   (shipments assigned · handing_over · picked_up · in_transit ·
                            agent_delivered whose cash is not collected yet)
         + collected-unremitted (collected by its agents or the agency, not yet settled by a
                            confirmed remittance / direct-to-platform deposit)
```

An administrator may pin another amount (above or below), with a required reason, and release
it. Reads:

- **Agency**: `GET /api/agency/cod/limit` → `{ agencyId, limit, source, defaultLimit, exposure: { inFlight, inFlightCount, collectedUnremitted, collectedCount, total }, headroom, overLimit }`.
- **jovi-mall internal** (wi-admin only): `GET /api/internal/admin/agencies/:id/cod-limit` (same + `override: { amount, reason, setAt, setByUserId, setBySource, setByName } | null`), `PUT …/cod-limit` `{ maxAmount: number | null, reason }`.
- **wi-admin**: `GET /api/v1/agencies/:agencyId/cod-limit` (`agencies.read`), `PUT /api/v1/agencies/:agencyId/cod-limit` `{ maxAmount, reason }` and `POST /api/v1/agencies/:agencyId/cod-limit/release` `{ reason }` (`agencies.cod_limit.set`, audited as `agencies.cod_limit.set` / `agencies.cod_limit.release`).

The limit is **not** on `policies.cod` (that is still the agency's own per-order cap,
`max_order_amount`), so changing it never pauses connections.

## 3 · Vendor COD terms

`GET /api/vendor/profile/cod-terms` · `PUT /api/vendor/profile/cod-terms`

```json
{ "codEnabled": true, "maxCashPerAgency": null, "updatedAt": null }
```

- `codEnabled: false` → web checkout (`POST` checkout with `paymentMethod: "cash_on_delivery"`)
  and the Telegram Mini App checkout refuse COD for any order containing that vendor's items:
  **`422 COD_VENDOR_NOT_ACCEPTED`** `{ vendorId }`. Checked before the agency rules.
- `maxCashPerAgency` → the most of this vendor's COD cash one agency may hold un-remitted at once.
- PUT is a full replace, `.strict()`. Separate from `policies`: no `policy_version` bump, no
  connection pause. ⚠ This said "no notification to agencies" when written; **agencies with an
  ACTIVE connection are now notified** on an actual change (`connection.cod_terms_changed`, see
  [FRONTEND-CHANGELOG-cod-fee-notifications.md](./FRONTEND-CHANGELOG-cod-fee-notifications.md)).
- Agencies see the terms: `codTerms` on `GET /api/agency/vendor-connections/browse` rows,
  `vendorCodTerms` on `GET /api/agency/vendor-connections` and `/:id`.

## 4 · Dispatch is gated (vendor)

When handing a COD shipment to its agency would push that agency over **its limit** (#2,
`kind: "agency_limit"`, checked first) **or** over **the vendor's `maxCashPerAgency`** (#3,
`kind: "vendor_terms"`):

| Path | Behaviour |
|---|---|
| Auto-redirect (payment success / COD checkout) | the customer's order is placed normally; **that shipment is not dispatched**: it stays `pending` with `cod_limit_hold`, other shipments of the order go out; timeline entry `delivery.agency_updated` "Auto-dispatch held back…". Never forces. **Since the notification change of the same day the vendor IS notified** (`shipment.cod_limit_held` → `orders/{orderId}`; see [FRONTEND-CHANGELOG-cod-fee-notifications.md](./FRONTEND-CHANGELOG-cod-fee-notifications.md)). |
| `POST /api/vendor/orders/:id/dispatch` | `422 COD_AGENCY_LIMIT_EXCEEDED`, nothing dispatched — unless body `{ "force": true }` |
| `POST /api/vendor/orders/bulk/dispatch` | per order: `failed[]` entry `{ orderId, code: "COD_AGENCY_LIMIT_EXCEEDED", reason, details }`; body `force: true` forces the whole batch |
| `PATCH /api/vendor/orders/:id/delivery-agency` | `422 COD_AGENCY_LIMIT_EXCEEDED` unless `"force": true` |

`details`: `{ kind, currentExposure, additionalAmount, limit, agencyId, shipmentId, hint }`.

Vendor order DTOs:

- list rows: `codLimitHeld: boolean`
- detail `items[].delivery` / `deliveries[]`: `codLimitHold: { kind, currentExposure, additionalAmount, limit, evaluatedAt } | null` and `codLimitForce: { kind, forcedByUserId, forcedByRole, forcedAt, currentExposure, additionalAmount, limit } | null`.

A forced dispatch stamps `codLimitForce` (who, when, which limit, the numbers) and clears the
hold. An administrator's dispatch (wi-admin) is not gated.

## 5 · Agency → agent force

`PATCH /api/agency/shipments/:id/assign-agent` and `POST /api/agency/shipments/:id/reassign`
accept `"force": true`. It waives **only** `422 COD_AGENT_EXPOSURE_EXCEEDED` (the agent's contract
slice / pool, trust-scaled). Still refused: `AGENT_KYC_NOT_VERIFIED`, `COD_AGENT_TRUST_TOO_LOW`
(trust or open shortfall), and every non-COD rule. The force is persisted on the offer so the
agent's accept honours it; offer summaries carry `codLimitForced: { byUserId, byRole, at } | null`.
Auto-assign never forces.

---

## Per dashboard

### Vendor dashboard
- New settings card: COD terms (`GET/PUT /api/vendor/profile/cod-terms`).
- Orders list: badge on `codLimitHeld`.
- Order detail: show `items[].delivery.codLimitHold` ("held — agency at its COD limit" /
  "held — your COD terms") with a **Dispatch anyway** button → `POST /orders/:id/dispatch` `{ force: true }`.
- On `422 COD_AGENCY_LIMIT_EXCEEDED` from dispatch / bulk dispatch / change agency: show
  `details` (`currentExposure + additionalAmount > limit`, `kind`) and offer a confirm → resend with `force: true`.
- Show `codLimitForce` as an audit line on the delivery block.

### Agency dashboard
- COD screen: `GET /api/agency/cod/limit` gauge (`exposure.total / limit`, `overLimit`).
- Assign / reassign: on `COD_AGENT_EXPOSURE_EXCEEDED`, offer **Assign anyway** → resend with `force: true`. Never offer it for `AGENT_KYC_NOT_VERIFIED` or `COD_AGENT_TRUST_TOO_LOW`.
- Vendor browse / connections: render `codTerms` / `vendorCodTerms`.

### Agent app
- `pool.source` may be `"default"`; `pool.planCode` is always `null`. Remove "upgrade your plan to carry more" copy.
- Offers may carry `codLimitForced` (informational).

### Admin dashboard (wi-admin)
- Agency detail: COD limit panel (`GET /api/v1/agencies/:agencyId/cod-limit`) with pin / release actions (`agencies.cod_limit.set`, reason required).
- Agent COD pool: `source: "default"` replaces `"plan"`; the pin now overrides the 500 000 default, not the plan. Plan editor: `max_cod_pool` no longer affects agents.
- See `admin/api-doc/FRONTEND-CHANGELOG-cod-limits.md`.

### Storefront / bot checkout
- Handle `422 COD_VENDOR_NOT_ACCEPTED` like `COD_AGENCY_NOT_SUPPORTED`: hide/disable COD for that basket.
