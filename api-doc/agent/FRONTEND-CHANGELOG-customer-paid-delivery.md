# agent_app — the COD cash may now include the delivery fee

**Backend change: 2026-10-03 / 2026-10-04 · Not deployed yet.** No migration. Decision record:
[ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

---

## 1 · `cod.itemsAmount` and `cod.deliveryFeeAmount`

On a cash-on-delivery shipment ([shipments.md](./shipments.md) — the shipment detail `cod` block):

```jsonc
"cod": {
  "expectedAmount": 52000,     // STILL the exact cash to collect — unchanged meaning
  "itemsAmount": 50000,        // the goods
  "deliveryFeeAmount": 2000,   // the delivery fee the customer pays you in cash (0 when the shop pays)
  "currency": "XAF",
  "status": "pending",
  "collectedAt": null
}
```

A shop may now make its customers pay delivery. On such a COD shipment the customer pays the goods
**and** the delivery fee to you at the door, and the platform already counts both in `expectedAmount`
(and in your cash exposure and limits). Nothing changes in the collect flow: the delivery code still
confirms `expectedAmount`.

**What the UI should do:** on the collect-cash screen and the shipment detail, keep `expectedAmount` as
the headline; when `deliveryFeeAmount > 0`, add a line "Goods {itemsAmount} + delivery
{deliveryFeeAmount}" so the agent can explain the amount to the customer. Older backends omit the two
fields — treat absent as `itemsAmount = expectedAmount`, `deliveryFeeAmount = 0`.

## 2 · Your earnings

Unchanged: your cut is still your contract's `fee_split` of the agency's fee, which is the same fee
whoever paid it. The fee itself now grows with the shipment's weight and an out-of-region drop-off
(the agency's formula), so offer-time quotes can be higher than before on heavy or distant parcels.

---

**If this page and the backend's observed behaviour disagree, stop and report the difference.**
