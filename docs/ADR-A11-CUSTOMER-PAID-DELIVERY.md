# ADR-A11 — Customer-paid delivery

**Date:** 2026-10-03 (decisions D-1 … D-9) · 2026-10-04 (D-10, surfaces)
**Status:** Accepted — decided by the product owner; built in waves W-A … W-F (W-F, cash for delivery,
2026-10-04 — see § Cash for delivery)
**Scope:** jovi-mall (+ a wi-admin statements check, W-G). **No geo-tracker contract change**: no outbox
event shape, webhook body or tracking verdict moved.
**Supersedes:** BARGAINING-AGENT-PLAN D-7 ("delivery is already free to the customer"). **Amends:**
[ADR-A07](./ADR-A07-DELIVERY-COST-CAP.md) (the 30% cap now runs only for a vendor-paid shop part and
falls back instead of refusing).
**Number:** this record was drafted as "ADR-A10"; that number belongs to
[ADR-A10-ROLE-CLOSURE](./ADR-A10-ROLE-CLOSURE.md), written concurrently. Every delivery-context
`ADR-A10` reference in `src/`, `scripts/`, `api-doc/` and `docs/` was renamed to `ADR-A11` on 2026-10-04.

**Code (money path):**
`src/modules/orders/domain/vendor-order-pricing.ts` (the pure pricing core) ·
`src/modules/orders/services/vendor-order-pricing.service.ts` (loads its facts) ·
`src/modules/orders/domain/delivery-payer.ts` (who pays / how much, pure readers) ·
`src/modules/earnings/domain/delivery-pricing.ts` (the fee formula, W-B) ·
`src/modules/vendors/domain/delivery-terms.ts` (the shop's terms, W-A) ·
`src/modules/earnings/services/delivery-cost-cap.ts` (`assessDeliveryCostUnits`, `enforceRatio`) ·
`OrderService.buildVendorOrder` · `CartQuoteService` · `EarningsSplitService` ·
`EarningsQuoteService.computeShipmentDeliveryFee` · `CashCollectionService` ·
`cod/domain/cod-limits.ts` (`expectedCodAmount`).
**Code (surfaces, W-D):** `orders/dto/customer-order.dto.ts` + `services/customer-order-view.service.ts` ·
`vendor/dto/vendor-order.dto.ts` + `orders/vendor-order.service.ts` · `bot-surface/domain/delivery-lines.ts`
(every bot delivery wording) · `bot-surface/domain/checkout-chat-reply.ts` · `miniapp/public/co.html`,
`ol.html`, `pd.html` · `bot-surface/domain/product-card.ts` (`deliveryTermsLine`) ·
`negotiation/domain/delivery-promise.ts`.
**Tests:** `test:delivery-terms` (W-A) · `test:delivery-pricing` (W-B) · `test:customer-delivery-fee`
(W-C) · `test:delivery-surfaces` (W-D) · plus the pinned suites listed in each wave.

---

## Context

Until 2026-10-03 delivery was free to every customer on every order. The agency's fee came out of the
vendor's net inside `splitOrder`; `order.total_amount` was the items; the cart quote reported
`delivery: 0` and the fee as `absorbedByVendor`. Three consequences had become problems:

- A shop selling cheap or heavy goods could not sell at all: ADR-A07 refused any part of a basket
  whose delivery would cost the vendor more than 30% of it, so a 2 000 XAF item never shipped.
- The agency's real cost (weight, out-of-region drop-off) was stored in `policies.pricing` and never
  charged: the formula was a flat per-shipment amount because no weight was snapshotted on an order.
- The storefront, the bots and the bargaining agent all promised "free delivery" / "delivery
  included" unconditionally — true only while every shop paid.

## Decisions (owner, 2026-10-03 / 2026-10-04)

| # | Decision |
|---|---|
| **D-1** | Free delivery is a **SHOP** setting — `always` · `never` · `above` (free when the shop's part of the basket ≥ `freeAboveAmount`, inclusive). The product `free_delivery` flag is **removed** (product schemas are `.strict()`, so an old `freeDelivery` key is a 400). The public product `freeDelivery` boolean is DERIVED (`true` only for `always`) beside `deliveryTerms`. |
| **D-2** | Default for every shop = **`always`** (the behaviour before this record). A shop that never opens the setting changes nothing. |
| **D-3** | A customer-paid fee goes **entirely to the agency side** (agency/agent per their contract). **No platform commission on it** — commission stays on items only. |
| **D-4** | The size component is **weight** (variant / shipping-config grams, snapshotted per order item); an item with no weight counts as `DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS` (default 1 000 g) per unit. |
| **D-5** | The **COD handling fee stays vendor-paid** and is computed on the **product price only** — never on a delivery fee the rider also collects. |
| **D-6** | A vendor-paid (free-delivery) shop part that fails the ADR-A07 30% cap is **not refused**: it **falls back to customer-paid** (`delivery_payer_reason: 'cap_fallback'`), and the quote says "add X more from this shop for free delivery". |
| **D-7** | Cash-for-delivery (goods online, delivery fee in cash to the rider) is built in this effort, **last wave** (W-F, 2026-10-04; `accepts_cash_delivery_fee` on agencies is honoured — see § Cash for delivery). |
| **D-8** | Fees are **posted prices at checkout**, never negotiated before payment. Changes happen AFTER checkout through the existing fee-proposal flow; on a customer-paid shipment the **customer** approves an increase and a decrease applies directly. A customer may request a combined price from an agency carrying ≥ 2 of their shipments. (W-E — see § Fee changes after checkout.) |
| **D-9** | Agency `max_fee_per_shipment` caps the POSTED (formula) price only. A per-shipment proposal may exceed it; the payer approves. |
| **D-10** | Change-agency on a customer-paid order: a WHOLE shipment moving keeps the customer's paid fee; the difference goes through the customer flow (higher → customer approval, reject ⇒ the vendor covers it; lower → refund the difference). A partial move becomes vendor-paid. (W-E.) |

## The fee — one definition (`earnings/domain/delivery-pricing.ts`)

One fee **per shipment** (= vendor order × agency). Same shop + same agency, N items → ONE fee that grows
with weight; two shops through one agency → two fees (two pickups).

```
kg          = max(1, ceil(totalWeightGrams / 1000))          // Σ unit grams × qty of the shipment's items
pickupPart  = base_rate_first_kg + additional_per_kg × (kg − 1) + (outOfRegion ? out_of_region_surcharge : 0)
storagePart = (outOfRegion ? out_of_region_delivery_fee : local_delivery_fee) + pick_pack_fee_per_order
fee         = (hasPickupBased ? pickupPart : 0) + (hasStorageBased ? storagePart : 0)
fee         = min(fee, pricing.max_fee_per_shipment)          // null = no ceiling (D-9)
```

`outOfRegion` = the drop-off `components.region` ≠ the pickup region; **unknown on either side ⇒
in-region** (never surcharge on a guess). `peak_season_surcharge` and `monthly_storage_fee_per_sku`
stay out. An approved override (`shipment.delivery_fee_override`) outranks the snapshot. The formula is
the agency's real cost and serves BOTH payers — vendor-paid fees also grow with weight now.

## Who pays (`vendors/domain/delivery-terms.ts` → `resolveDeliveryPayer`, pure)

```
always                                   → vendor   shop_always
never                                    → customer shop_never
above && shopSubtotal ≥ freeAboveAmount   → vendor   shop_threshold_met
above && below                           → customer threshold_not_met   (freeDeliveryShortfall = gap)
vendor && ADR-A07 cap fails               → customer cap_fallback        (applied by checkout, D-6)
```

`shopSubtotal` = the vendor order's items at their (negotiated) unit prices, before delivery. ONE payer
per vendor order: every shipment of it shares the payer.

## Money, per payer

| | vendor-paid | customer-paid |
|---|---|---|
| `order.price_breakdown` | `{ base, delivery: 0, tax, discount, total = base }` | `{ base, delivery = Σ shipment fees, total = base + delivery }` |
| `order.total_amount` / online charge | base | base + delivery |
| COD `CashCollection.expected_amount` | items | items + that shipment's fee (`items_amount` + `delivery_fee_amount`) |
| `splitOrder` vendorNet | itemsGross − bargain fee − commission − Σ fees | itemsGross − bargain fee − commission |
| `splitCodCollection` vendorNet | gross − bargain fee − commission − fee − codFee | gross − bargain fee − commission − codFee |
| codFee base (D-5) | items | items (never `expected_amount`) |
| commission base (D-3) | items | items |
| agency / agent at delivery | the snapshot, unchanged | the snapshot, unchanged |
| RTO leftover `reserved − earned` | vendor allocation row | no vendor row — owed to the customer (`shipment.customer_fee_refundable`), refunded by W-E |
| ADR-A07 cap | applies; failure ⇒ D-6 fallback | not applied (only `vendorNet > 0`) |
| vendor `gross_snapshot` | items | items |

**`NET_FORMULA` is unchanged, and its `deliveryFee` term now means VENDOR-BORNE delivery**
(`max(0, fee − customerFee)` per shipment: the whole fee when the shop pays, 0 when the customer paid).
Because `gross_snapshot` stays the items on both paths, the residual stays exact. jovi-mall's vendor
analytics and wi-admin's statements both read it that way (W-G checks wi-admin's copy); the two repos'
pinned `NET_FORMULA` literal did not move.

## Data model

- `VendorSettings.delivery_terms = { mode, free_above_amount, updated_at }` — default null ⇒ `always`
  via `vendorDeliveryTermsOf`. Beside `cod_terms`, NOT on `Vendor.policies` (editing must not pause
  agency connections). Routes `GET/PUT /api/vendor/profile/delivery-terms`.
- Product `delivery.free_delivery` — **removed** (model, validators, merge, services, mapper).
- Order: `price_breakdown.delivery`, `delivery_payer`, `delivery_payer_reason`,
  `free_delivery_shortfall`; item `weight_grams` / `weight_source`; item `delivery.free_delivery` removed.
- Shipment: `delivery_payer`, `delivery_fee_snapshot` (now written AT CHECKOUT for every physical
  shipment), `customer_delivery_fee` (what the customer paid — separate from what the agency is paid),
  `fee_components` (display), `customer_fee_refundable` (owed back to the customer).
- Agency `policies.pricing.max_fee_per_shipment: number | null`,
  `policies.pricing.accepts_cash_delivery_fee: boolean` (default false; honoured by W-F).
- CashCollection: `items_amount` + `delivery_fee_amount` (= `expected_amount`).
- Env: `DELIVERY_DEFAULT_ITEM_WEIGHT_GRAMS` (default 1000).

No data migration (pre-production; legacy rows read through defensive readers: a null payer reads
`vendor`, a missing breakdown reads "all goods").

## What changed for each role (surfaces, W-D)

| Role | Change | Contract |
|---|---|---|
| **Customer** (storefront, app) | Cart quote: real `delivery`, per-shop `delivery/total/deliveryPayer/deliveryPayerReason/freeDelivery{mode,freeAboveAmount,shortfall}/shipments[]`, `regionKnown`; "Delivery included" is wrong copy now. Orders: `priceBreakdown.delivery`, `deliveryPayer`, `deliveryPayerReason`, `deliveryFees[] { shipmentId, amount, customerFeeRefundable? }`; COD entries split `itemsAmount` + `deliveryFeeAmount`. | `api-doc/customer/FRONTEND-CHANGELOG-customer-paid-delivery.md` |
| **Public** (catalog) | `freeDelivery` derived; `deliveryTerms` on products and stores. | `api-doc/public/FRONTEND-CHANGELOG-customer-paid-delivery.md` |
| **Bots** (chat + Telegram Mini App) | Checkout review draws one delivery line per shipping shop before the total, with the free-delivery hint (server-built, five languages); the review is priced at the address it names, and with a customer-paid fee the several-addresses list chooses before placing; `co.html` gains `delivery[]` rows (no client arithmetic); `ol.html` "Incl. X delivery"; product cards / screen show the shop's terms; `below_delivery_minimum` reworded and now rare. MCP: `cart_quote` fields, `checkout_review` description, `catalog_search_products` `deliveryTerms`. | `api-doc/n8n/bot-surface.md` § "Customer-paid delivery" |
| **Bargaining agent** | `quote_delivery` derives `free` from the shop's terms (+ optional deal `amount` for `above`), `customerPays: 0 or null` (never a number), `terms`, `freeDeliveryShortfall`, `feeBasis`. Playbook: free delivery only when the tool says so. | `api-doc/n8n/negotiation-tools.md` § 6 |
| **Vendor** | Delivery terms card; product `freeDelivery` key is a 400; order `shipping` = what the customer paid, `priceBreakdown.vendorBorneDelivery`, `deliveryPayer(Reason)`, per-shipment `deliveryFee { payer, fee, customerPaid, vendorBorne }`. | `api-doc/vendor/FRONTEND-CHANGELOG-customer-paid-delivery.md` |
| **Agency** | Per-kg and out-of-region prices charged; `max_fee_per_shipment`; `accepts_cash_delivery_fee` (later wave); COD `itemsAmount` / `deliveryFeeAmount`. Paid the same fee whoever paid it. | `api-doc/agency/FRONTEND-CHANGELOG-customer-paid-delivery.md` |
| **Agent** | COD `itemsAmount` / `deliveryFeeAmount`; earnings unchanged in shape. | `api-doc/agent/FRONTEND-CHANGELOG-customer-paid-delivery.md` |

Notifications needed no change for the amounts: every customer money line reads `total_amount` /
`expected_amount`, which already include customer-paid delivery.

## Consequences

- **The quote can still drift from the charge**, through inputs that change between the two moments:
  agency pricing, shop terms, a product's agency, and the drop-off. Checkout is the authority; every
  surface says "estimate" where it shows a quote. The bot review is priced at the address it names.
- **A cheap shop can now sell.** ADR-A07's refusal survives only where even customer-paid delivery
  leaves the vendor earning ≤ 0.
- **No surface may compute a delivery number.** Storefront, Mini App, chat review and the bargaining
  agent render server values; `test:delivery-surfaces` pins the bot half.
- **The bargaining agent may no longer promise free delivery by default** — a behaviour change in the
  live playbook, which must be re-seeded (owner action).
- **Vendor-paid fees also grow with weight and region**, which can push a free-delivery shop part over
  the 30% cap — D-6 then charges the customer rather than refusing.

## § Fee changes after checkout (W-E, 2026-10-04)

Owner decisions D-8 (fees are posted prices; changes after checkout; the customer approves an
increase on a customer-paid shipment, a decrease applies directly; combined-price requests),
D-9 (a proposal may exceed `max_fee_per_shipment`) and D-10 (change of agency on a customer-paid
order). Code: `src/modules/delivery-fee-proposals/` — rules `domain/customer-fee-change.rules.ts`,
money `services/customer-fee-application.service.ts`, top-up `services/delivery-fee-topup.service.ts`,
refunds `services/delivery-fee-refund.service.ts`, change-agency `services/change-agency-fee.service.ts`,
combined requests `services/combined-delivery-request.service.ts`. Payments: `purpose:
'order_delivery_topup'`, `payments/domain/refund-legs.ts`. Suite: `npm run test:customer-fee-changes`
(103) + `test:delivery-fee-proposals` § 13. Contract: `api-doc/customer/delivery-fee-changes.md`.

### Who answers

| Payer | Direction | Approver | Applies |
|---|---|---|---|
| vendor | either | vendor (ADR-A09, unchanged) | on approval |
| customer | decrease | none | in the proposing transaction (`approved` by `system`) |
| customer | increase | customer (with the `version` shown) | COD: on approval · online: when the top-up payment SUCCEEDS |

On a rejection the agency may carry at the old fee, re-propose once, or decline the job (ADR-A09 D-8).
A customer-approver proposal stays an increase (an edit lowering it → `422
DELIVERY_FEE_PROPOSAL_DIRECTION_CHANGED`) and is frozen once the customer approved it
(`409 DELIVERY_FEE_TOPUP_IN_PROGRESS`). Pickup stays blocked by the shipment pointer until the
change applies, the agency withdraws, or (change-agency) the vendor covers.

### The three numbers, and what each move writes

`fee` (agency is paid; override → snapshot) · `customerFee` = `shipment.customer_delivery_fee`
(online: money PAID for this run, gross — checkout + top-ups, **never lowered**; COD: cash to
collect) · `vendorBorne = max(0, fee − customerFee)`. Two rules: **an increase costs the customer
exactly the delta**; **a decrease reduces the vendor's share first**. One method writes every
customer-paid change (`applyInSession`), each write a CAS:

| | shipment | collection (COD, pending) | order totals¹ | vendor allocation² | refund |
|---|---|---|---|---|---|
| online decrease | override+snapshot = new fee; `customer_fee_refundable` = excess | — | unchanged | +(V−V′) if the vendor bore part | excess refunded (below) |
| COD decrease | fee; `customer_delivery_fee` = min(C, new) | −Δ on fee + expected | −Δ | — | — |
| online increase (paid top-up) | fee; `customer_delivery_fee` += top-up | — | +top-up | unchanged | — |
| COD increase (approved) | fee; `customer_delivery_fee` += Δ | +Δ | +Δ | — | — |
| change-agency difference declined / covered | fee; customer unchanged | — | — | −(V′−V) (online, split) | — |

¹ `price_breakdown.delivery`, `price_breakdown.total`, `total_amount`. **`total_amount` means what
was CHARGED (online) / what will be COLLECTED (COD)**: a top-up grows it, an online decrease does
not shrink it — the refund is recorded beside it (`refund_transactions`, `delivery_fee_refunds`), so
the refund ceiling (total − refunded) stays exact. ² Only on an online order already split; COD and
unsplit orders are divided by the splits from the shipment as it stands. The agency/agent side needs
nothing: `splitShipmentDelivery` divides the (rewritten) snapshot.

### The online top-up

Approve freezes `customer_approval` + `topup {amount, awaiting_payment}`; `POST …/pay` opens a
`PaymentTransaction` with `purpose: 'order_delivery_topup'`, `orderId`, `deliveryTopup {shipmentId,
proposalId, appliedAt}`; idempotency key `${orderId}:delivery_topup:${proposalId}` + amount;
live-attempt guard scoped by purpose AND proposal. ⛔ `handlePaymentSuccess` branches on the purpose
**before** `OrderService.handlePaymentSuccess`, whose already-paid early return would swallow it
(the booking-balance lesson). Success applies the increase in one transaction with the proposal's
`approved` and a CAS on `deliveryTopup.appliedAt` (idempotent). If the proposal no longer waits for
that money (withdrawn, declined, moved), the money is **credited** to the customer as delivery money
paid and refunded — never dropped. A failed top-up sends `order.delivery_fee.topup_failed`, not
`payment.failed` (that would tell the customer their paid order failed).

### Refunds (`delivery_fee_refunds`, per ORDER)

Owed = Σ shipments' `customer_fee_refundable` − Σ claiming ledger rows (`processing`, `completed`,
`manual_required`; `failed` claims nothing), capped at what the order's payments can still return.
Per order, not per shipment, because a change-agency move deletes the source row. Triggered on an
online decrease, on `earnings.split` for a customer-paid return (RTO leftover, W-C), and swept
daily by the earnings release worker (stale `processing` claims → manual). A `processing` claim is
written BEFORE the gateway call (partial unique index: one per order). Gateway refunds go through
`refundPayment` as `system`, `prefer: 'topup_first'`. A gateway that WON'T (mobile money, NotchPay
with refunds off) or COD → `manual_required` + HIGH ticket + `order.delivery_fee.refund_pending`;
a gateway that COULDN'T (5xx) → `failed`, retried.

**`refundPayment` is purpose-aware now.** An order may hold a checkout charge and top-ups;
the refund is spread over the succeeded legs (`planRefundLegs`), every leg's gateway checked
before any money moves, each leg finalised on its own. The source ceiling is `order.total_amount`
(includes top-ups) − Σ completed refunds. Vendor/admin eligibility folds top-ups in; a chargeback
looks up the checkout charge only.

### Change of agency (D-10)

A WHOLE customer-paid shipment moving (its last item): the destination takes over the source's fee
and the customer's money unchanged (money-neutral; nothing left on the deleted row), then the new
agency's formula price is compared: lower → a decrease applied directly; higher → a
`change_agency` proposal the customer answers (approve → pays the delta; decline → **the vendor
covers it**; the vendor may also `cover` at once). The move is refused
(`DELIVERY_FEE_PROPOSAL_VENDOR_NET_NOT_POSITIVE`, nothing written) when the vendor could not afford to cover.
PARTIAL moves stay vendor-paid (W-C). A change-agency row does not spend the agency's two-proposal
cap; its window includes the destination's `pending`.

**One transaction since W-E2 (owner decision D-12, 2026-10-04).** `VendorOrderService.moveItemsToAgency`
(the vendor's `updateDeliveryAgency` is a one-item wrapper; the administrator's `move-agency` passes
every item of the shipment) runs the whole change in ONE `runInTransactionWithRetry`, every read
that decides a write inside the session, grouped PER SOURCE SHIPMENT: the order and the items
re-read and pinned to where the pre-check saw them (else `409 SHIPMENT_REASSIGNMENT_CONFLICT`), the
source's status re-checked, a WHOLE move of a shipment an agent has accepted refused
(`409 SHIPMENT_ALREADY_HAS_AGENT`, the administrator's rule), the whole-move pre-pricing — **"whole"
judged over the batch** (every item of the source in it), never item by item, which used to price the
last item against a destination already holding a vendor-borne fee for the rest and turn an
increase into an unapproved decrease — (`ORDER_NOT_PAID` for an online order not simply `paid`
with a difference to settle), the merge/creation of the destination, the source's item removal and
deletion, on a deleted source its pending proposal (`withdrawn`, `shipment_moved` — any payer), its
live assignment offers (`cancelled`) and its ranking, the fee carry (A — `fee_components` is not
carried: it itemises the old agency's formula and is display-only), the pending COD collections
(`CashCollectionService.followItemMoveInSession`: cancelled with a deleted source, re-priced from
items + customer fee otherwise, CAS; a `cancelled` one — an agency's decline — is history and does
not block), the difference proposal (B, `raiseSystemProposalInSession` — pointer claim, and for a
decrease the money it lands; for an increase the vendor-cover check `VENDOR_NET_NOT_POSITIVE` runs
here, on the order as the move left it, so no sibling shipment is counted twice), the order items'
repoint (a compare-and-set on the shipment each is leaving), the timeline rows; plus the forced-COD
stamp. Side effects run only after the commit, once (a retried attempt's collection is discarded):
`shipment.cod_limit_forced`, the proposal events and customer notification, a gateway refund of a
lowered fee. **The ticket fallback is gone**: a failure anywhere rolls everything back and the
caller sees the error. **Two concurrent moves of one item cannot both succeed**: both write the order
and the source, MongoDB commits one and aborts the other with a write conflict, and the driver's
retry re-reads the committed state and refuses (`409`). Pinned by `test:change-agency-tx`
(DB-free) and `verify:change-agency-tx` (replica set: rollback after the first writes, the race, a
transient retry with effects run once). The COD-limit gate stays a pre-check, evaluated once over the
batch: the exposure it sums spans OTHER orders' documents this transaction does not write, so
re-reading it inside the session would not close the race between two hand-offs to one agency (write
skew) — the same position dispatch takes.

### Combined-price requests (D-8)

Customer → one agency, ≥ 2 eligible parcels of one checkout. The agency answers with LOWER fees
(each an ordinary decrease, `origin: 'combined_request'`) or declines. The request is claimed
before any fee moves; if none lands the claim is released.

### Settling a manual refund (W-E2, D-12)

COD money owed back stays MANUAL (ticket + notice), and an administrator records the hand payment:
`POST /api/internal/admin/delivery-fee-refunds/:refundId/settle { method, reference?, note? }`
(list + read beside it; contract `api-doc/admin/delivery-fee-refunds.md`; wi-admin's button is W-G2).
Only `manual_required` settles, by a CAS on status + amount, inside `runInTransaction` with the
`admin_action_log` row; the row becomes `completed` with `settlement { method, reference, note,
settled_by_* , settled_at }`; then the ticket is resolved and the customer gets
`order.delivery_fee.refund_settled`. Methods `mobile_money | cash | bank | other` moved money;
`covered_by_order_refund` records that a refund of the whole order already returned it (a paying
method is refused then — `DELIVERY_FEE_REFUND_ALREADY_COVERED` — and a partial cover splits off the
part still owed as a new manual row). Money paid by hand is subtracted from both refund ceilings
(`PaymentOrchestratorService.sourceCeiling`, `DeliveryFeeRefundService.refundableCapacity`) via
`sumDeliveryRefundsPaidByHand`.

The CUSTOMER's owed amount is `customerRefundPosition` — Σ refundable − Σ `completed` — so a manual
row stays owed to them until settled (`refunds.owed/returned/awaitingManual` on the fee-changes read;
`deliveryFeeRefund { owed, returned }` on the order view). `outstandingCustomerRefund` keeps its own
meaning: what the SYSTEM may still try to refund.

### In the chat (W-H, 2026-10-04)

The bot surface answers all of the above without a website: eight `/api/internal/bot/delivery-fees/*`
routes (`api-doc/n8n/bot-surface.md` § 3 "Delivery-fee changes after checkout", taps in § 14.9).
`delivery_fees_list_pending` DRAWS the question server-side — Accept · Decline (`yes:dfc:` /
`no:dfc:<proposalId>:<version>`), or Pay now · Decline once an online increase is accepted
(`dfee:pay:<proposalId>`, charging the account's wallet). **Accepting and paying are `flow_only`** —
reached only by those buttons, never by the model — while declining (`delivery_fees_reject`) and the
combined-price tools are model tools. What the customer pays more is W-E's own plan
(`planCustomerApprovedIncrease` over `stateOf`) or the frozen `topup.amount`, never a subtraction in
the chat. The three money notifications (`approval_needed` · `topup_due` · `topup_failed`) carry an
order-scoped button `dfee:{{orderId}}` (template fallback `dfee:list`) that re-reads the current
figure on the press. `combined_delivery_eligible` resolves the eligible groups with W-E's own
predicate, so the model never names a parcel. Suite: `npm run test:bot-fee-changes`.

### Known gaps

- An approved-but-unpaid online increase has no expiry; the agency withdraws or declines (D-12: by design).
- Merging into a destination that carries an approved override keeps the interim fee (not re-priced).
- A deleted source's withdrawn proposal is not announced (`withdrawPendingInSession` emits nothing and
  no `shipment_moved` copy exists in the agent catalog) — same as W-E.
- Vendor/admin refund-eligibility READS do not subtract hand-paid delivery refunds; the orchestrator's
  enforcement does (`REFUND_AMOUNT_EXCEEDS_MAX` rather than an over-refund).

## § Cash for delivery (W-F, 2026-10-04)

Owner decision D-7. Code: `orders/domain/delivery-payer.ts` (`DeliveryFeePayment`,
`paysDeliveryFeeInCash`, `cashCollectionKindOf`, `cashToCollectOf`, `deliveryCashOf`),
`orders/domain/vendor-order-pricing.ts` (`deliveryFeeCashVerdict` → `VendorOrderPricing.deliveryFeeCash`),
`OrderService.createOrdersFromCart` / `buildVendorOrder`, `CartQuoteService` (`deliveryFeeCashTotalOf`),
`CashCollectionService` (`collectsCash`, `cashAmountsOf`), `EarningsSplitService.splitDeliveryFeeCollection`,
`customer-fee-change.rules.ts` (`PaymentMode 'cash_fee'`). Suite: `npm run test:cash-delivery-fee`.

### Who may, and how it is chosen

An ONLINE checkout may pass `deliveryFeePayment: 'cash_to_rider'`. It is decided **per vendor order**:

| Vendor order | Result |
|---|---|
| customer-paid, fee > 0, EVERY carrying agency has `policies.pricing.accepts_cash_delivery_fee === true` | `delivery_fee_payment: cash_to_rider` |
| customer-paid, an agency does not accept (or has no pricing policy) | the WHOLE checkout is refused: `422 DELIVERY_FEE_CASH_NOT_AVAILABLE` `{ reason: agency_declines_cash, vendorId, agencyIds }` |
| vendor-paid, or a 0 fee | stays `with_order` — nothing to hand over |
| no vendor order took it (every shop pays, or digital) | `422 … { reason: not_customer_paid \| no_delivery_fee }` |
| `paymentMethod: cash_on_delivery` | `422 … { reason: cash_on_delivery }` (everything is cash already) |

The quote exposes the same verdict (`perVendor[].deliveryFeeCash`, folded into a checkout-wide
`deliveryFeeCash { available, reason, amountDueOnline, amountDueToRider, vendorIds }`), computed by the
same pure `deliveryFeeCashVerdict` inside `priceVendorOrder`, so the offer and the refusal cannot disagree.
A D-6 `cap_fallback` order is customer-paid and may pay in cash.

### `total_amount` keeps one meaning: what is CHARGED ONLINE

| Field | `cash_to_rider` vendor order |
|---|---|
| `price_breakdown.base` | items |
| `price_breakdown.delivery` | **0** (nothing charged online for delivery) |
| `price_breakdown.delivery_cash` (new) | Σ the shipments' fees — handed to the riders |
| `price_breakdown.total` = `total_amount` | items |
| `order.delivery_fee_payment` (new) | `cash_to_rider` (else `with_order`; read via `deliveryFeePaymentOf`) |
| `shipment.customer_delivery_fee` | the fee (unchanged meaning: what the customer pays for that run — in cash here) |

Chosen so that **no existing reader of `total_amount` changes**: the payment orchestrator charges
Σ `total_amount` (the items), the refund ceilings (`sourceCeiling`, `refundableCapacity`) can never
refund a fee that was paid in cash, lifetime spend counts the online money, the vendor's
`orderItemsGrossOf` is `base`. COD eligibility does not apply (online). W-E's online top-up / refund
machinery is never reached (see fee changes below).

### The fee-only cash collection

Created at agent ACCEPT exactly like a COD collection (`ensureForShipmentInSession`, pickup safety net
too), with `kind: 'delivery_fee'`, `items_amount: 0`, `delivery_fee_amount` = `expected_amount` = the
customer fee, a delivery code sent to the customer (the COD code message, amount = the fee). A shipment
with no customer fee (a PARTIAL agency move's new shipment is vendor-borne) collects nothing — no
collection is ever minted for 0.

Every "does the rider collect cash here" gate reads `CashCollectionService.collectsCash(order, shipment)`
(= `cashCollectionKindOf !== null`), never `payment_method` alone: status transitions (`delivered` only
through the code; the collection ensured at pickup; cancelled on return; re-opened on redelivery), the
customer's confirm-delivery (refused — the code IS the confirmation), the auto-confirm sweep (goes
through `autoCollectWithoutCode`), offers / sessions / accept, the agent COD gate (KYC, trust,
threshold) in ranking and contract policy, the agency/agent COD blocks (now with `kind`).

### Exposure

The fee is cash an agent carries: the agent's exposure (pending collections + cash held) counts it, the
agency's limit counts it (`exposureRows` reads cash-fee orders too), a vendor's own COD terms cap does
NOT (`agencyOnly` rows — the vendor's cap bounds the vendor's goods). The dispatch-time agency-limit
HOLD (`evaluateCodHandoffs`) stays COD-only: a paid online order is never held on a cash limit.

### The accounting — the agency side is paid exactly once

The cash is the AGENCY SIDE's (D-3): agency + agent per the contract, never the vendor's or the
platform's. It travels **the cash chain that already exists**, exactly like the delivery-fee part of a
customer-paid COD collection since W-C:

```
collect (code / auto)   agent cash account += fee, agency→platform liability += fee,
                        contract outstanding += fee                (creditCashLiabilitiesInSession)
agent deposit           agent → agency (settles the agent's liability; unchanged flow)
agency remittance       agency → platform, FIFO over its collections (fee-only ones included);
                        a fully settled collection stamps cash_settled_at on its rows
split (at collect)      splitDeliveryFeeCollection, source 'cod_collection':
                          agency = fee − agentCut, agent = agentCut, requires_cash_settlement: true,
                          gross_snapshot = fee, commission 0 — NO vendor / platform / platform_ai row
release                 hold window after the ORDER completes AND cash settled → paid out once
```

- `splitShipmentDelivery` writes **nothing** for a delivered cash-fee shipment (it would pay the agency
  from the platform a second time); for a RETURNED one (no cash collected, the collection cancelled) the
  run earns nothing, like a COD return, and only a vendor-borne remainder (a change-agency difference the
  vendor covered, already deducted from the vendor's net) goes back to the vendor.
- `splitOrder` at payment: the vendor bears nothing (`customer_delivery_fee` covers the fee), so
  Σ allocations of the order = `total_amount` = the online charge; the fee rows sum to the fee.
- A refund of the order (`EarningsRefundService.onOrderRefund`) does NOT reverse the fee-only collection's
  rows: the customer paid that fee in cash and a refund returns only the online charge.
- The vendor is not sent `payment.received.*` for the riders' delivery cash.

Why the platform round-trip rather than "the agency keeps it": the agent's cut is paid by the platform
like every other beneficiary ("nobody is paid off-platform"), an earnings row exists for both parties'
history, and the rolling reserve / remittance / deposit-deadline machinery needs no second model. The fee
enters the remittance as **agency-side money in transit**, never as platform revenue (no platform row,
no commission). The alternative — netting the agency's share out of the remittance — is recorded as an
open owner question in the W-F report.

### Fee changes after checkout (W-E) on a cash-fee shipment

`CustomerFeeApplicationService.modeOf` returns `'cash_fee'`: the FEE behaves like COD, the VENDOR like
online.

| | collection (pending) | order | vendor allocation | top-up / refund |
|---|---|---|---|---|
| decrease | −Δ (cancelled if it reaches 0) | `delivery_cash` −Δ | +(V−V′) if the vendor bore part | none |
| customer-approved increase | +Δ, applied at approval | `delivery_cash` +Δ | — | none |
| vendor-covered increase | — | — | −(V′−V) (split at payment) | none |

`total_amount` never moves on a cash-fee change. The bot reads the mode as `cod` ("you will pay X more /
less in cash at delivery").

### Surfaces

Customer order DTO: `priceBreakdown.deliveryCash`, `deliveryFeePayment`, `amountDueToRider`,
`deliveryFees[].paidInCash`, fee-only entries in `codCollections[]` (with the delivery code). Agency /
agent shipment reads: the COD block with `kind: 'delivery_fee'`, `itemsAmount: 0`. Notifications: the
out-for-delivery cash line "your items are paid — have X ready in cash for the delivery fee" (5
languages). Bot: `yes:cof:<ref>:<addressId>` "Delivery in cash" beside Pay now on the chat
confirmation, with the summary line naming both amounts; `checkout_place` / `checkout_create_orders`
accept `deliveryFeePayment`; the chat door re-checks before spending the ref (`spent: false`); the Mini
App `co.html` shows a toggle with the server's two strings. Contracts: `api-doc/customer/orders.md`,
`cart.md`, the customer / agency / agent `FRONTEND-CHANGELOG-customer-paid-delivery.md`,
`api-doc/n8n/bot-surface.md` (`yes:cof`).

---

## Money — how the code does it (W-C)

### One pricing path for the quote and the charge

Checkout (`buildVendorOrder`) and the cart quote both call
`VendorOrderPricingService.resolveDeliveryLines` (per line: agency, pickup snapshot, pickup
region, per-unit weight) and then `priceVendorOrder` (pure). The quote cannot drift from the
charge except through inputs that change between the two moments (agency pricing, shop terms,
product agency, the chosen address).

Per vendor order:

1. One shipment per agency. Fee = `computeShipmentFee(policies, { mix, totalWeightGrams =
   Σ unitGrams × qty, outOfRegion })`. `outOfRegion` is true when ANY line's pickup region is
   known and differs from the drop-off region (unknown on either side ⇒ in-region). An agency
   with no pricing policy charges `EARNINGS_DELIVERY_FLAT_FEE` (default 0).
2. Payer = `resolveDeliveryPayer(terms, itemsSubtotal)`.
3. Vendor-paid ⇒ the ADR-A07 cap runs (online per order, COD per shipment). Failure ⇒ payer
   `customer`, reason `cap_fallback`, `freeDeliveryShortfall` = the cap's shortfall (null if no
   basket can pass). ONE payer per vendor order: a COD order with one failing shipment falls back
   entirely.
4. Customer-paid ⇒ sanity only (`enforceRatio: false`): `vendorNet > 0` with the COD handling fee
   still on the vendor. Failure ⇒ `422 ORDER_BELOW_DELIVERY_MINIMUM` (unchanged shape).
5. `deliveryCharged = customer ? Σ fees : 0`; `total = items + deliveryCharged`.

### What checkout writes

| Where | Field | Value |
|---|---|---|
| order | `price_breakdown.base` | items (unchanged meaning) |
| order | `price_breakdown.delivery` | `deliveryCharged` (0 when vendor-paid) |
| order | `price_breakdown.total`, `total_amount` | `base + delivery` |
| order | `delivery_payer` / `delivery_payer_reason` | `vendor`\|`customer` / `shop_always`\|`shop_never`\|`shop_threshold_met`\|`threshold_not_met`\|`cap_fallback` (null on digital) |
| order | `free_delivery_shortfall` | number \| null |
| order item | `weight_grams` / `weight_source` | per-unit grams / `variant`\|`shipping_config`\|`default` |
| shipment | `delivery_payer` | copied from the order |
| shipment | `delivery_fee_snapshot` | the fee — **written at checkout for every physical shipment** |
| shipment | `customer_delivery_fee` | the fee when customer-paid, else 0 |
| shipment | `fee_components` | `{pickup_base, weight_extra, region_surcharge, storage, cap_applied, kg, weight_grams, out_of_region, flat_fallback}` (display only) |

`delivery_fee_snapshot` = what the AGENCY is paid; `customer_delivery_fee` = what the CUSTOMER
paid for that run. Kept separate so a fee change awaiting the customer's money (W-E) never makes
a split read money the customer has not paid. Readers never infer a customer fee from the
snapshot (`customerDeliveryFeeOf`).

### The fee a split divides

`computeShipmentDeliveryFee`: override → checkout snapshot → live formula (item weight snapshots,
drop-off region vs the vendor-address snapshot's region; a depot's region is not snapshotted and
reads as in-region on this path).

For each shipment: `deliveryFeeShares(fee, customerFee)` →
`vendorBorne = max(0, fee − customerFee)`, `customerExcess = max(0, customerFee − fee)`.
Normal cases: vendor-paid ⇒ `vendorBorne = fee`; customer-paid ⇒ `vendorBorne = 0`.

### Online (`splitOrder` at payment, `splitShipmentDelivery` at delivery/return)

```
itemsGross = price_breakdown.base                       (orderItemsGrossOf)
aiMargin   = Σ bargain fee on lines
commission = floor((itemsGross − aiMargin) × c%)        — items only (D-3)
vendorNet  = itemsGross − aiMargin − commission − Σ vendorBorne
gross_snapshot = itemsGross on the vendor/platform/platform_ai rows
```
Reconciliation: `total_amount = aiMargin + commission + vendorNet + Σ reserved fees`
(customer-paid: the fees came from the customer; vendor-paid: from the vendor's share, as before).
`splitOrder` keeps the checkout snapshot (it re-writes it with the override-first value, which is
the same number unless a vendor approved a change). `customerExcess` (only possible after a fee
decrease — W-E) is recorded on `shipment.customer_fee_refundable`, never allocated.

At delivery/return the agency and agent divide the reserved fee exactly as before. A RETURN
(RTO) earns `rto_fee`; the leftover `reserved − earned` goes back to whoever paid it, customer
first (`rtoLeftoverShares`): **vendor-paid ⇒ a vendor allocation row (unchanged); customer-paid ⇒
NO vendor row**, the amount is `$set` on `shipment.customer_fee_refundable` (plus any
`customerExcess`) and stays with the platform, owed to the customer — the refund is W-E's.

### Cash on delivery (`splitCodCollection` at the cash hand-off)

The collection (created at agent accept) stores
`items_amount = Σ price × qty`, `delivery_fee_amount = customerDeliveryFeeOf(order, shipment)`,
`expected_amount = items_amount + delivery_fee_amount`. The pure twin
`expectedCodAmount(orderItems, shipmentItems, customerDeliveryFee)` (exposure, dispatch gates)
and `CashCollectionService.computeExpectedAmount` agree (pinned).

```
gross      = items_amount                               (legacy rows: expected_amount)
codFee     = computeCodHandlingFee(cfg, items_amount)   — product price only (D-5), vendor-paid
commission = floor((gross − aiMargin) × c%)
vendorNet  = gross − aiMargin − commission − vendorBorne − codFee
agency     = fee − agentCut + codFee
agent      = agentCut
```
Customer-paid: `Σ allocations = items + fee = expected_amount` exactly. Vendor-paid: unchanged
(`Σ = items`). A COD return collects no cash and splits nothing (unchanged).

### Other money readers

| Reader | Decision |
|---|---|
| COD eligibility (`max_order_amount`) | the order total INCLUDING customer-paid delivery (cash the agent carries) — checkout and the quote's `cashOnDelivery` |
| COD exposure (agency/vendor caps, agent exposure) | `expected_amount` / `expectedCodAmount` with the customer fee |
| Contract `shipment_value_ceiling` | the GOODS only (`computeItemsAmount`) — the delivery fee is not what a package is worth |
| Agency quote's COD fee | `codGross` = `cod.itemsAmount` (D-5) |
| Auto-redirect threshold | compares the ITEMS (`orderItemsGrossOf`) — keeps the setting's meaning |
| Online charge, refund ceilings, lifetime spend, COD "amount due" notification | `total_amount` (includes customer-paid delivery — correct as is) |
| Vendor analytics | `gross_snapshot` is items; the COD residual is split with the VENDOR-BORNE fee, so `NET_FORMULA` (literal unchanged) stays exact; its `deliveryFee` term now means vendor-borne delivery |

### Delivery-fee proposals

Vendor-paid shipments: unchanged. Customer-paid shipments: the customer flow — see § Fee changes
after checkout (W-E replaced W-C's interim `DELIVERY_FEE_PROPOSAL_CUSTOMER_PAID_PENDING` refusal,
now retired). Prepaid un-split approvals now always find a checkout
snapshot, so they take `planFeeApplication`'s `rewriteSnapshot` branch (correct: the snapshot is
rewritten, the later `splitOrder` charges the override).
