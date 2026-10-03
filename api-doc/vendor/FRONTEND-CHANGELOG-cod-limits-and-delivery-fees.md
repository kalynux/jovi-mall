# Vendor dashboard — COD limits, COD terms and delivery-fee proposals

**Backend change: 2026-10-02 · Not deployed yet.** Deploy prerequisite: the index migration
`npm run migrate:delivery-fee-proposal-indexes` (it creates the partial unique index that stops two
pending fee changes standing on one shipment; `autoIndex` is off in production). Decision record:
[ADR-A09](../../docs/ADR-A09-COD-LIMITS-AND-DELIVERY-FEES.md).

This page is everything the **vendor dashboard** (vendor-dash) has to change for the 2026-10-02
work. It is self-contained; the cross-role pages it summarises are linked at the end of each
section and stay the reference if anything here looks thinner.

---

## ⛔ Breaking — read first

1. **Approving or rejecting a delivery-fee proposal now REQUIRES `version`.**
   `POST /api/vendor/orders/:id/delivery-fee-proposals/:proposalId/approve` body `{ "version": int }`,
   `…/reject` body `{ "version": int, "note"?: string }`. A body without it is
   `400 VALIDATION_ERROR` (both schemas are `.strict()` — `delivery-fee-proposal.validator.ts`).
   If you built against the first draft of this feature (approve with no body), it breaks.
2. **A manual dispatch can now be refused** with `422 COD_AGENCY_LIMIT_EXCEEDED` (single dispatch,
   bulk dispatch, change-agency). Previously these always went through for a dispatchable order.

Everything else is additive.

---

## 1 · COD terms — a new settings card

| Method | Path | Body / answer |
|---|---|---|
| `GET` | `/api/vendor/profile/cod-terms` | `{ codEnabled: boolean, maxCashPerAgency: number \| null, updatedAt: string \| null }` |
| `PUT` | `/api/vendor/profile/cod-terms` | body `{ codEnabled: boolean, maxCashPerAgency: integer 0…100 000 000 \| null }` — full replace, `.strict()`, **both keys required** |

Defaults when never set: `{ codEnabled: true, maxCashPerAgency: null, updatedAt: null }`.

- `codEnabled: false` — customers cannot pay cash on delivery for any order containing your items
  (web checkout and the Telegram Mini App refuse with `422 COD_VENDOR_NOT_ACCEPTED`).
- `maxCashPerAgency` — the most of **your** orders' COD cash one agency may hold un-remitted at
  once. `null` = no cap of yours (the agency's own 1 000 000 limit still applies).
- **Not part of `policies`**: saving does **not** bump `policy_version` and does **not** pause any
  agency connection.
- Agencies with an **active** connection to you are notified when a save actually changes a value
  (a re-save of the same values notifies nobody).

UI: a "Cash on delivery" card in settings — a switch ("Accept cash on delivery") and an optional
amount ("Most cash one agency may hold for me"; empty = no limit). Explain that switching COD off
affects checkout immediately.

Source: `src/modules/vendor/controller/vendor-profile.controller.ts` (`SetCodTermsSchema`),
reference page [profile.md § COD terms](./profile.md#cod-terms-2026-10-02).

## 2 · Dispatch is gated by COD limits — "Dispatch anyway"

Handing a **COD** shipment to its agency is checked against two caps on the cash that agency holds
and has not yet remitted (in-flight COD shipments + collected-not-remitted):

| `kind` | Cap | Checked |
|---|---|---|
| `agency_limit` | the agency's limit — 1 000 000 by default, or an administrator's pin | first |
| `vendor_terms` | your `maxCashPerAgency`, measured on your orders' cash at that agency | second |

"Over" means strictly greater: reaching the limit exactly is allowed. Prepaid orders are never
gated.

| Path | What happens over a cap |
|---|---|
| **Auto-redirect** (your setting, on payment / COD checkout) | The order is placed normally. **That shipment is not dispatched**: it stays `pending` with a `codLimitHold`; the order's other shipments go out. Never forced automatically. You get a `shipment.cod_limit_held` notification. |
| `POST /api/vendor/orders/:id/dispatch` | `422 COD_AGENCY_LIMIT_EXCEEDED`, **nothing** of the order is dispatched — unless body `{ "force": true }` (an absent/empty body is `force: false`) |
| `POST /api/vendor/orders/bulk/dispatch` | per order: an entry in `data.failed[]` `{ orderId, code: "COD_AGENCY_LIMIT_EXCEEDED", reason, details }`; body `"force": true` forces **every** order in the batch |
| `PATCH /api/vendor/orders/:id/delivery-agency` | `422 COD_AGENCY_LIMIT_EXCEEDED` unless `"force": true` (body `{ itemId, deliveryAgencyId, force? }`) |

**The error** — `422 COD_AGENCY_LIMIT_EXCEEDED`, `details`:

```ts
{
  kind: 'agency_limit' | 'vendor_terms';
  currentExposure: number;   // what the agency already holds (minor units)
  additionalAmount: number;  // what this hand-off adds
  limit: number;             // the cap that would be passed
  agencyId: string;
  shipmentId: string;        // on change-agency this is "item:<itemId>", not a real id
  hint: string;              // English, for logs — do not show it as copy
}
```

UI: show `currentExposure + additionalAmount > limit` in words, branch the copy on `kind`
("The agency holds as much cash on delivery as it may" / "Your own COD terms cap this agency"),
and offer **Dispatch anyway** which resends the same request with `force: true`. Also offer
"choose another agency" (change-agency) and, for `vendor_terms`, a link to the COD terms card.

**New fields on order reads** (`src/modules/orders/vendor-order.service.ts`):

- `GET /api/vendor/orders` rows: `codLimitHeld: boolean` — a shipment of this order is held.
  Show a badge.
- `GET /api/vendor/orders/:id` → `items[].delivery` (and `deliveries[]`):
  - `codLimitHold: { kind, currentExposure, additionalAmount, limit, evaluatedAt } | null`
  - `codLimitForce: { kind, forcedByUserId, forcedByRole, forcedAt, currentExposure, additionalAmount, limit } | null`

A forced hand-off records `codLimitForce` (show it as an audit line: "Dispatched over the COD
limit by you on …"). Any dispatch that goes out clears `codLimitHold`. A held shipment is **never
retried automatically** — the vendor must dispatch it (with `force` if still over). ⚠ The timeline
entry for a hold always says "…the delivery agency is at its cash-on-delivery limit", even for
`kind: "vendor_terms"`; render from `codLimitHold.kind`, not from that sentence.

Reference: [orders.md § COD limits on dispatch](./orders.md#cod-limits-on-dispatch-2026-10-02),
cross-role [FRONTEND-CHANGELOG-cod-limits.md](../FRONTEND-CHANGELOG-cod-limits.md) § 3–4.

## 3 · Delivery-fee proposals — approve or reject a fee change

You pay each shipment's delivery fee out of your net. An agency — or its agent, if the agency
allowed it — may now **propose a different fee for one shipment**, with a reason, before pickup.
Nothing changes until **you approve**. **While a proposal is pending, that shipment cannot be
picked up**, so it needs a prompt answer.

| Method | Path | Body |
|---|---|---|
| `GET` | `/api/vendor/delivery-fee-proposals?status=&orderId=&page=1&limit=20` | — (`limit` ≤ 100; every status by default) |
| `GET` | `/api/vendor/orders/:id/delivery-fee-proposals` | — (newest first) |
| `POST` | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId/approve` | `{ "version": int ≥ 1 }` **required** |
| `POST` | `/api/vendor/orders/:id/delivery-fee-proposals/:proposalId/reject` | `{ "version": int ≥ 1, "note"?: string ≤ 500 }` |

`GET /api/vendor/orders/:id` also carries `deliveryFeeProposals: Proposal[]` (`[]` for digital
orders). The inbox answers `{ success, data: Proposal[], meta: { total, page, limit, totalPages } }`.

**The proposal (vendor view):**

```ts
{
  id: string; shipmentId: string; orderId: string; agencyId: string;
  proposedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null };
  currency: string;               // "XAF"
  feeBefore: number;              // minor units
  proposedFee: number;            // minor units, integer ≥ 0
  reason: string;                 // 3–500 chars
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  respondedBy: { role: 'vendor' | 'agency' | 'agent' | 'system'; userId: string | null; at: string } | null;
  rejectionNote: string | null;
  withdrawalReason: string | null;  // 'shipment_declined' | 'agent_detached' (system withdrawals)
  application: {                    // VENDOR VIEW ONLY; set once approved
    feeAtApply: number;
    vendorAllocationBefore: number | null;
    vendorAllocationAfter: number | null;
    snapshotRewritten: boolean;
  } | null;
  version: number;                  // starts at 1, +1 per edit — SEND IT BACK
  edits: Array<{ editedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null };
                 feeBefore: number; feeAfter: number; reasonBefore: string; reasonAfter: string;
                 version: number; at: string }>;     // oldest first
  lastEditedBy: { role: 'agency' | 'agent'; userId: string | null; agentId: string | null; at: string } | null;
  agencyEdited: boolean;
  availableActions: Array<'approve' | 'reject'>;     // render the buttons from THIS
  createdAt: string; updatedAt: string;
}
```

**What approving does.** The shipment's fee becomes `proposedFee`. For an order **already paid
online**, your held earnings for the order move in the same step by `feeBefore − proposedFee`
(ledger reason `delivery_fee_adjustment`), and `application.vendorAllocationBefore/After` show it.
For **cash on delivery**, nothing moves until the cash is collected; the split then charges the new
fee. The platform's 30% delivery-cost cap does **not** apply to an approved fee — the only ceiling
is that you must still earn more than 0 (checked when proposed and again when you approve).

**What rejecting does.** The original fee stands and pickup is unblocked. The agency may send
**one** more proposal (max two non-withdrawn per shipment) or **decline the shipment** — you then
get the existing `shipment.rejected` notification and re-route those items with
`PATCH /api/vendor/orders/:id/delivery-agency`.

**Errors to handle:**

| Code | Status | `details` | UI |
|---|---|---|---|
| `DELIVERY_FEE_PROPOSAL_VERSION_MISMATCH` | 409 | `{ currentVersion }` | it was edited since you loaded it — reload, show the new figure, let the vendor answer again |
| `DELIVERY_FEE_PROPOSAL_NOT_PENDING` | 409 | `{ status }` | already answered / withdrawn — reload |
| `DELIVERY_FEE_PROPOSAL_STALE` | 409 | `{ shipmentStatus }` (sometimes none) | the shipment left the window or the proposing agent left it — reload |
| `DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE` | 422 | none | "Approving this would leave you earning nothing on this order" |
| `DELIVERY_FEE_PROPOSAL_SETTLEMENT_CONFLICT` | 409 | `{ allocationStatus }` | "Your earnings for this order can no longer be adjusted" |
| `DELIVERY_FEE_PROPOSAL_NOT_FOUND` | 404 | — | unknown proposal / not on this order |
| `ORDER_NOT_FOUND` | 404 | — | not your order |
| `VALIDATION_ERROR` | 400 | — | missing `version`, `note` > 500, unknown key |

UI states: a pending badge on the order row and an inbox count (a pending proposal **blocks
pickup**); on the order detail, per pending proposal: proposer (agency / agent — the vendor contracts
with the agency either way), `feeBefore → proposedFee`, the reason, the `edits[]` trail if any, and
**Approve / Reject** with a confirm stating the earnings effect (`feeBefore − proposedFee`).

Reference: [delivery-fee-proposals.md](./delivery-fee-proposals.md), cross-role
[FRONTEND-CHANGELOG-delivery-fee-proposals.md](../FRONTEND-CHANGELOG-delivery-fee-proposals.md).

## 4 · Notifications

**Two new preference keys** on `GET/PATCH /api/vendor/notification-preferences`:
`preferences.codLimitUpdates` and `preferences.deliveryFeeProposals`, both `boolean`, default
`true`. A preferences document written before this change may omit them — treat missing as `true`
(the backend does). Add two toggles.

| `type` | Preference | `action.path` | Meaning |
|---|---|---|---|
| `shipment.cod_limit_held` | `codLimitUpdates` | `orders/{orderId}` | auto-redirect held a COD shipment back (agency limit or your terms) |
| `delivery_fee_proposal.received` | `deliveryFeeProposals` | `orders/{orderId}` | a fee change awaits approve / reject |
| `delivery_fee_proposal.edited` | `deliveryFeeProposals` | `orders/{orderId}` | the pending figure changed — re-read before answering |
| `delivery_fee_proposal.withdrawn` | `deliveryFeeProposals` | `orders/{orderId}` | informational; nothing to answer |

All four have `aggregateType: "order"`, `aggregateId` = the order id. **No new deep-link label**:
`orders/{orderId}` is already in your translator, and the order detail is where "Dispatch anyway"
and Approve / Reject live. Copy (`title`, `message`, `action.label`) is server-rendered in
en/fr/pt/es/ar — render it. WhatsApp templates for all four were submitted to Meta on 2026-10-02
and are pending review; until approved, out-of-window WhatsApp delivery of these fails (in-app,
push, email, Telegram work). ⚠ Emailed / WhatsApp buttons land on `{APP_URL}/orders/{id}`, which
today's SPA sends to the dashboard home — see
[deep-links.md § Emailed buttons](../notifications/deep-links.md#emailed-buttons--decided-2026-09-08-and-both-halves-are-yours).

Reference: [FRONTEND-CHANGELOG-cod-fee-notifications.md](../FRONTEND-CHANGELOG-cod-fee-notifications.md),
[notifications.md § 2026-10-02](./notifications.md).

## 5 · What did not change for you

- The monthly-salary contract model (agency ↔ agent) does not touch the vendor: you pay the same
  delivery fee whatever the agent is paid.
- Prepaid orders: no COD gate. Admin dispatch (wi-admin) is never gated by the agency limit.

## Checklist

- [ ] COD terms card (`GET/PUT /profile/cod-terms`)
- [ ] Orders list badge on `codLimitHeld`; order detail hold / force blocks; **Dispatch anyway**
- [ ] Handle `422 COD_AGENCY_LIMIT_EXCEEDED` on dispatch, bulk dispatch (`failed[]`) and change-agency
- [ ] Fee-proposal inbox + order-detail block; **send `version`** on approve / reject; handle `VERSION_MISMATCH`
- [ ] Two preference toggles; four notification `type`s (optional icons in `TYPE_VISUALS`)
