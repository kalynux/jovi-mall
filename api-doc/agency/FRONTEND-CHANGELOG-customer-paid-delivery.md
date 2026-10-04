# agency-dash — the weight/region formula is live; two new pricing fields; COD cash split

**Backend change: 2026-10-03 / 2026-10-04 · Not deployed yet.** No migration. Decision record:
[ADR-A11](../../docs/ADR-A11-CUSTOMER-PAID-DELIVERY.md).

---

## 1 · Your posted price now really is your formula

Every physical shipment's fee is computed at checkout from your `policies.pricing` and **snapshotted**
on the shipment ([onboarding.md § policies.pricing](./onboarding.md), [earnings.md](./earnings.md)):

```
kg          = max(1, ceil(shipment weight in grams / 1000))     // no weight on an item ⇒ 1 kg per unit
pickupPart  = base_rate_first_kg + additional_per_kg × (kg − 1) + (out of region ? out_of_region_surcharge : 0)
storagePart = (out of region ? out_of_region_delivery_fee : local_delivery_fee) + pick_pack_fee_per_order
fee         = pickupPart (vendor-collected items) + storagePart (warehoused items), then ≤ max_fee_per_shipment
```

`additional_per_kg`, `out_of_region_surcharge` and `out_of_region_delivery_fee` **were stored but not
charged** until now — they are charged from this release. "Out of region" = the drop-off address's region
differs from the pickup region; unknown on either side counts as in-region. Remove any "not yet charged"
wording from your pricing screens.

**Who pays it changes nothing for you:** the shop pays (free delivery) or the customer pays (the shop's
delivery terms), and you are credited the same fee either way; there is no platform commission on it.

## 2 · Two pricing fields (in `policies.pricing`)

| Field | Type | UI |
|---|---|---|
| `max_fee_per_shipment` | integer ≥ 1 or `null` | "Maximum delivery fee per shipment" (optional). Caps the **posted** price only; a per-shipment fee proposal may go above it — the payer approves. `0` is refused. |
| `accepts_cash_delivery_fee` | boolean, default `false` | "Customers may pay the delivery fee in cash to the rider." ⚠ **Coming in a later wave** — stored and echoed now, not honoured by checkout yet. Show it disabled or with a "coming soon" note. |

⚠ `PUT /api/agency/onboarding/policies` replaces the whole `policies` object — send both fields back
when editing others, or they reset to defaults.

## 3 · Shipments — the COD cash is split

`cod` on the shipment list and detail ([shipments.md](./shipments.md)) gains
`itemsAmount` + `deliveryFeeAmount` (`expectedAmount` is their sum). `deliveryFeeAmount` is the
delivery fee the customer pays your agent in cash with the goods when the shop's terms make the
customer pay (`0` otherwise). Your COD handling fee is computed on `itemsAmount` only. Show "Cash to
collect: {expectedAmount} (goods {itemsAmount} + delivery {deliveryFeeAmount})" where space allows.

## 4 · Not in this release

- Fee proposals on a **customer-paid** shipment (the customer approves) — documented with that change.
- Cash-for-delivery on online orders (`accepts_cash_delivery_fee`) — later wave.

---

**If this page and the backend's observed behaviour disagree, stop and report the difference.**

## 2026-10-04 (W-F) — the delivery fee in cash (`accepts_cash_delivery_fee` is now honoured)

- With `policies.pricing.accepts_cash_delivery_fee: true`, a customer may pay the items of an ONLINE
  order and hand **your agent the delivery fee in cash**. Off by default; nothing changes until you
  enable it.
- Such a shipment carries a COD block like a cash-on-delivery one, with **`kind: "delivery_fee"`**,
  `itemsAmount: 0` and `deliveryFeeAmount` = `expectedAmount` = the fee (list and detail reads,
  projected before an agent accepts). The agent collects it with the customer's delivery code — the
  same collect flow; the shipment is delivered only that way.
- **The money**: the cash is your side's (agency + agent per the contract), never the vendor's or
  the platform's — no commission, no COD handling fee. It travels the cash chain you already use:
  agent → agency (agent deposit) → platform (your remittance), and your share and your agent's cut are
  then paid out ONCE from that collection (`requires_cash_settlement`), never also "at delivery". A
  returned shipment collected no fee and earns nothing (as cash on delivery).
- **Limits**: the fee counts in your COD exposure (agency limit) and in your agents' cash exposure
  and thresholds; it does not count against a vendor's own COD cap.
- A fee proposal on such a shipment changes the cash the agent collects (like cash on delivery).
