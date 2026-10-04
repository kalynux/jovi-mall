# ADR-A07 — A vendor's part of a basket must be able to carry its delivery cost

**Date:** 2026-09-27
**Status:** Accepted — decided by the product owner; implemented the same day
**Scope:** jovi-mall only (no event shape, webhook body or geo-tracker contract changes)
**Code:** `src/modules/earnings/services/delivery-cost-cap.ts` (the arithmetic) ·
`src/modules/orders/services/delivery-cost-cap.service.ts` (units + refusal) ·
`OrderService.buildVendorOrder` (checkout) · `CartQuoteService` (quote) ·
`precheckChatDoor` (chat checkout)
**Test:** `npm run test:delivery-cost-cap`

---

> ## ⚠ AMENDED 2026-10-03 by ADR-A11 (customer-paid delivery) — read [ADR-A11](./ADR-A11-CUSTOMER-PAID-DELIVERY.md) first
>
> Option 3 below ("vendor-configured free-delivery threshold", which includes option 2) was
> built. What changed for this rule:
>
> - The cap runs **only for a shop part whose delivery the VENDOR pays** (shop terms `always`,
>   or `above` with the threshold met). Same arithmetic, same units (online per order, COD per
>   shipment), now with the formula's real fee (weight, region).
> - **D-5 no longer applies as written.** A vendor-paid part that fails the cap is **not
>   refused**: it falls back to customer-paid (`delivery_payer_reason: 'cap_fallback'`, owner
>   decision D-6), and the quote reports the cap's shortfall as `freeDelivery.shortfall`.
> - `422 ORDER_BELOW_DELIVERY_MINIMUM` survives for ONE case: the part is customer-paid and the
>   vendor would still net ≤ 0 (commission + bargain fee + the COD handling fee, which stays the
>   vendor's). Its `details` shape is unchanged.
> - D-4's enforcement table moved: checkout and the quote both price through
>   `VendorOrderPricingService` → `priceVendorOrder` (`orders/domain/vendor-order-pricing.ts`),
>   which calls the unit assessor `assessDeliveryCostUnits` in `delivery-cost-cap.ts`.
>   `DeliveryCostCapService` remains as the mix-priced vendor-paid evaluation; it is no longer on
>   the checkout path.
>
> Everything below is the vendor-paid-only record of 2026-09-27.

## Context

The customer pays for the goods only. The delivery agency's fee — and on cash on delivery its
COD handling fee — is charged to the **vendor**, out of their share:

    vendorNet = subtotal − aiMargin − commission − deliveryFee − codHandlingFee

Nothing at checkout compared the fee with the basket. A 500 XAF basket delivered for a
1 000 XAF fee was accepted like any other, and the problem surfaced only when the money was
split:

- **online**: `splitOrder` throws `EARNINGS_INVALID_SPLIT` (422) at payment success — after
  the customer has paid;
- **COD**: `splitCodCollection` throws the same at the cash handoff — after the agent holds
  the cash.

Either way no allocation is written: the vendor, the agency, the agent and the platform are
all owed nothing on record, while real money has moved. That is the "conflict in cash" the
owner reported.

## Options that were considered

1. **Minimum order at checkout** (block it) — chosen, with the refinement below.
2. Customer pays the shortfall — a business-model change (quote, checkout total, COD amount
   and the split must all move together).
3. Vendor-configured free-delivery threshold — the most work; includes option 2's changes.
4. Let the vendor's net go negative as a debit on future payouts — rejected.

A plain `subtotal ≥ fee + commission + codFee` still lets a vendor sell for **0** (at the
boundary) or 1 XAF. The owner first proposed "and the remainder must be at least 70% of the
subtotal", *with* commission inside the 30%. That was rejected in favour of the variant
because commission is an administrator-set plan term (0–100): with it in the ratio,
**every** sale on a ≥ 30% plan — digital included — would be impossible, and each commission
edit would silently move every vendor's minimum basket.

---

## D-1 · The rule

    deliveryCost = deliveryFee + codHandlingFee
    (1)  deliveryCost × 100 ≤ R × subtotal          R = ORDER_MAX_DELIVERY_COST_PERCENT, default 30
    (2)  vendorNet > 0                              commission and AI margin counted here

- (1) is measured on the **subtotal** — what the customer pays for those lines — in the
  owner's own words. It can be computed before checkout; `vendorGross` cannot, because a
  negotiated line's floor is secret and never on the cart.
- (2) is the backstop that keeps the vendor above zero whatever the plan.
- Physical orders only. A digital order has no delivery cost.

With the default 30% and a 1 000 XAF fee, a shop needs **3 334 XAF** in the basket online —
the same for every vendor, whatever their plan.

## D-2 · The unit is the split's unit

The rule exists to stop the split refusing money that has moved, so it is evaluated over
exactly what each split divides:

| Payment | Unit | Why |
|---|---|---|
| online | one per **vendor order** | `splitOrder` subtracts the sum of every shipment's fee from the order gross |
| cash on delivery | one per **shipment** (= per agency at checkout) | `splitCodCollection` splits each collection on that shipment's slice, and charges the COD fee per collection |

So a COD order of 20 000 XAF from one agency plus 500 XAF from another is refused, although
the same basket paid online passes.

## D-3 · The fee is the split's fee

`deliveryFeeForPickupMix` for an agency with a pricing policy, `EARNINGS_DELIVERY_FLAT_FEE`
(default 0) for one without — the same fallback `computeShipmentDeliveryFee` charges. The COD
fee is `computeCodHandlingFee`, the split's own function. At checkout the pickup mix is read
from the order items' **pickup snapshot**, which is what the split classifies.

## D-4 · Where it is enforced

| Where | Role |
|---|---|
| `OrderService.buildVendorOrder` | **Authoritative.** Inside the checkout transaction, after the COD eligibility check and before the order is created, so a refusal rolls back stock holds and negotiation-lock consumption. Uses the negotiated prices and floors, so the AI margin is exact. Covers every checkout door: customer API, bot `POST /checkout`, mini-app screen and chat door, WhatsApp Flow. |
| `CartQuoteService` | Reports the same verdict per shop (`perVendor[].deliveryMinimum`) so a client says "add X from this shop" before the pay button. Takes an optional `paymentMethod` (default `online`). Counts the bargain fee from the vendor's CURRENT floor on every bargainable line (since 2026-09-28 the fee is owed haggled or not); checkout uses the snapshotted floor, so the two differ only if the vendor moves their minimum in between. |
| `precheckChatDoor` | The chat checkout refuses before its handle is spent (`details.spent: false`). |
| `checkout_review` (bot) | The chat review reports `blocker: "below_delivery_minimum"` with `deliveryShortfalls[]`, mints no checkout ref, and draws "add X more from {shop}" instead of **Place order**. The n8n tool description was republished to match (`UP-wi-mall-mcp` `65a8d170`, 2026-09-27). |
| `EarningsSplitService` | **Unchanged.** `EARNINGS_INVALID_SPLIT` stays as the backstop for drift between checkout and payment (an agency editing its pricing in between). |

## D-5 · The refusal

`422 ORDER_BELOW_DELIVERY_MINIMUM` (category `business_rule`, so `details` reach the client):

```jsonc
{
  "vendorId": "…", "scope": "order" | "shipment", "agencyId": "…" | null,
  "subtotal": 500, "minimumSubtotal": 3334, "shortfall": 2834,
  "maxDeliveryPercent": 30, "reason": "delivery_cost_ratio" | "vendor_net_not_positive",
  "currency": "XAF"
}
```

`minimumSubtotal` is `null` (and `shortfall` 0) when no basket size can pass — a COD
percentage at or above the cap, or commission + COD percentage ≥ 100.

⚠ **`details` never carries the commission, the vendor's net or the fee breakdown** — those
are the vendor's business terms, and the customer only needs how much more to add. The bot
surface has its own sentence for the code in all five languages.

---

## Consequences

- A cheap item whose delivery costs more than 30% of its price **cannot be bought on its own**
  from that shop. That is intended; the customer is told how much more to add.
- Tuning is one environment variable, `ORDER_MAX_DELIVERY_COST_PERCENT` (clamped 1–100).
  `100` does not switch the rule off.
- The quote is an estimate on the same terms as `absorbedByVendor`: an agency editing its
  pricing between quote and checkout can move the verdict. Checkout is the authority.

## Decided NOT to change (owner, 2026-09-27)

1. **Bargaining** stays as it is — a haggled price that fails the cap is refused at checkout.
2. The mini-app **screen** door stays as it is — a refusal there is `spent: true`.
3. **No vendor-side warning** for a product that cannot be bought on its own.
4. **No settlement sweep** — no real customer was active, so no order is stuck.
