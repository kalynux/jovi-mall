# Frontend changelog — COD-limit & delivery-fee notifications (2026-10-02)

Today's three features (COD limits, per-shipment delivery-fee proposals, salary contracts) now
**notify**. This page is what each app has to add. Everything is additive: an app that ships
nothing still works — an unknown `type` renders with your generic fallback, and an unknown
`action.path` must render **no button** (rule 5 of
[`notifications/deep-links.md`](./notifications/deep-links.md)).

Related contracts: [FRONTEND-CHANGELOG-cod-limits.md](./FRONTEND-CHANGELOG-cod-limits.md),
[FRONTEND-CHANGELOG-delivery-fee-proposals.md](./FRONTEND-CHANGELOG-delivery-fee-proposals.md).

## Shared by all three apps

- **Two new preference keys** on every role's `GET/PATCH /api/{vendor,agency,agent}/notification-preferences`:
  `preferences.codLimitUpdates` and `preferences.deliveryFeeProposals`, both `boolean`, default
  `true`. A preferences row written before today may **omit** them — treat a missing key as `true`
  (the backend does). Add two toggles to each settings screen.
- **Copy is server-rendered and localised** (en/fr/pt/es/ar) in `title`, `message` and
  `action.label`. Render them; do not compose your own sentences.
- **Salary contracts** (`fee_split.model: 'monthly_salary'`) need **nothing** here: the existing
  `agent_contract.terms_*` notifications never quote the fee model, so they read correctly for a
  salary proposal as they do for a percentage one.
- **WhatsApp**: the 21 new templates (`en` + `fr`) were **submitted to Meta on 2026-10-02 and are
  PENDING review** (this line said "not yet submitted" until the submission the same day). Until
  each is APPROVED, out-of-window WhatsApp delivery of that situation fails; in-app, push, email,
  Telegram and in-window WhatsApp work today.

---

## vendor-dash

**New `type`s** (all `aggregateType: 'order'`, `aggregateId` = the order id):

| `type` | Preference | Meaning |
|---|---|---|
| `shipment.cod_limit_held` | `codLimitUpdates` | Auto-redirect held a COD shipment back (agency over its limit, or over your `maxCashPerAgency`). |
| `delivery_fee_proposal.received` | `deliveryFeeProposals` | A fee change awaits your approve / reject. |
| `delivery_fee_proposal.edited` | `deliveryFeeProposals` | The pending figure changed — re-read before answering (your approve must name the current `version`). |
| `delivery_fee_proposal.withdrawn` | `deliveryFeeProposals` | Informational; nothing to answer. |

**Deep link: NO new label.** All four send `action.path = "orders/{orderId}"`, which you already
translate — and your `notificationRoute()` already routes `aggregateType: 'order'` to the order
detail. That page is where the "Dispatch anyway" (`POST /orders/:id/dispatch { force: true }`) and
the fee approve / reject controls live, so nothing to add for routing.

Optional polish: add the four `type`s to `TYPE_VISUALS` (a "cash held" icon for the first, a
"fee" icon for the other three) and, on `received` / `edited`, consider scrolling the order detail
to its fee-proposal block.

---

## agency-dash

**New `type`s**:

| `type` | `aggregateType` | Preference | `action.path` |
|---|---|---|---|
| `delivery_fee_proposal.approved` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.rejected` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.agent_proposed` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `delivery_fee_proposal.agent_edited` | `shipment` | `deliveryFeeProposals` | `shipments/{shipmentId}` |
| `shipment.cod_limit.forced` | `shipment` | `codLimitUpdates` | `shipments/{shipmentId}` |
| `shipment.assignment.cod_limit_blocked` | `shipment` | `codLimitUpdates` | `shipments/{shipmentId}` |
| `connection.cod_terms_changed` | `connection` | `codLimitUpdates` | `vendor-connections/{connectionId}` |
| `cod.limit.pinned` | ⭐ `cod_limit` | `codLimitUpdates` | ⭐ `cod/limit` |
| `cod.limit.released` | ⭐ `cod_limit` | `codLimitUpdates` | ⭐ `cod/limit` |

**One new `aggregateType`: `cod_limit`** (`aggregateId` = your own agency id). Add it to any
exhaustive switch on `aggregateType`.

**One new deep-link label — add this case to `dashboardRoute()` (the translator):**

```ts
// 'cod/limit' — cod.limit.pinned / cod.limit.released (2026-10-02).
// There is no /dashboard/cod route; the COD limit gauge lives on the cash screen.
case 'cod/limit':
  return '/dashboard/cash/summary';
```

Match it **before** any generic `cod/...` handling: `cod/deposits/{id}` and `cod/limit` share the
first segment, and `limit` is not a deposit id. The gauge itself is
`GET /api/agency/cod/limit` (see FRONTEND-CHANGELOG-cod-limits.md § 2) — render it on that tab if it
is not there yet.

Reminders from `deep-links.md` that these new situations make more visible:
`shipments/:id` and `vendor-connections/:id` are still on that doc's "do not resolve yet" list
(the shipment list has no `:id` child; connections live under `vendors/:tab`). Today they fall back
to the dashboard home. `shipment.assignment.cod_limit_blocked` is only useful if it lands where
**Assign anyway** (`PATCH /shipments/:id/assign-agent { agentId, force: true }`) is offered, so this
is the moment to add the `shipments/:id` route.

Behaviour notes for the inbox:
- `shipment.cod_limit.forced` **replaces** `shipment.assigned` for a forced dispatch — you get one,
  never both.
- `shipment.assignment.cod_limit_blocked` **replaces** `shipment.assignment.unfilled` when the COD
  amount was the reason, and arrives at most **once per shipment**.

---

## agent_app (Flutter)

**New `type`s**:

| `type` | `aggregateType` | Preference | `action.path` |
|---|---|---|---|
| `delivery_fee_proposal.approved` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` |
| `delivery_fee_proposal.rejected` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` |
| `delivery_fee_proposal.edited` | `shipment` | `deliveryFeeProposals` | ⭐ `shipments/{shipmentId}` |
| `delivery_fee_proposal.withdrawn` | `shipment` | `deliveryFeeProposals` | **none** (`action: null`) |
| `fee_proposals.enabled` | `contract` | `deliveryFeeProposals` | `memberships/{contractId}` |
| `fee_proposals.disabled` | `contract` | `deliveryFeeProposals` | `memberships/{contractId}` |
| `cod.pool.pinned` | ⭐ `cod_pool` | `codLimitUpdates` | ⭐ `cod` |
| `cod.pool.released` | ⭐ `cod_pool` | `codLimitUpdates` | ⭐ `cod` |

**One new `aggregateType`: `cod_pool`** (`aggregateId` = your own agent id).

**Two new deep-link labels — add these arms to `resolveDeepLink` in
`lib/core/router/deep_links.dart`** (and the matching rows to its doc-comment table and to
`test/core/router/deep_links_test.dart`):

```dart
// A shipment this agent holds — delivery-fee proposal outcomes (2026-10-02).
// Shell route on the shipments branch, so `go`, not `push`.
['shipments', final id] => DeepLinkTarget(
  AppRoutePaths.shipmentDetail(id),
  isFullScreen: false,
),
// The COD screen (pool + hand-overs) — cod.pool.pinned / cod.pool.released.
// The ONE-segment form; ['cod', 'deposits', id] is a separate arm and stays as it is.
['cod'] => const DeepLinkTarget(AppRoutePaths.cod, isFullScreen: false),
```

`delivery_fee_proposal.withdrawn` deliberately carries **no** `action` — the shipment has left
you (declined, or you were taken off it) and its detail would 404, exactly like
`shipment.reassigned_away`. Your existing null-to-inbox fallback is correct.

`shipment.offer.received` may now end with an extra sentence ("your agency sent this offer above
your cash-on-delivery limit …") when the offer carries `codLimitForced`. Nothing to build — it is
in `message`.

⚠ Still outstanding from 2026-09-16: the `earnings` label (four `payout.*` situations) has no arm
in `resolveDeepLink` either. Worth adding in the same change.
