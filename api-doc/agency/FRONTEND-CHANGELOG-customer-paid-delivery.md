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

**🆕 `feeComponents` on the shipment detail** (`GET /api/agency/shipments/:id`) — the line-by-line
build of that posted fee (base · weight extra · region surcharge · storage · ceiling applied · kg ·
out-of-region). Show it on the shipment screen. Shape: [shipments.md](./shipments.md) § fee proposals.

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

## 4 · Fee proposals on customer-paid parcels + combined-price requests — SHIPPED 2026-10-04

Contract: [shipments.md § fee proposals and § Combined delivery-price requests](./shipments.md#combined-delivery-requests).

- Your existing "propose a different fee" form now works on **customer-paid** parcels too. A
  **decrease** applies immediately (status `approved` by the system — show it as applied). An
  **increase** is answered by the **customer**, not the vendor: show "Waiting for the customer"; on an
  online order an accepted increase waits for the customer's top-up (pickup stays blocked until paid,
  or until you withdraw). If the customer declines you may carry at the old fee, propose once more, or
  decline the job. Responder names in notifications read "The customer".
- A proposal may exceed your `max_fee_per_shipment` (the ceiling caps the automatic price only).
- **New screen — combined-price requests:** a customer may ask you for one lower price on ≥2 of their
  parcels you carry. `GET /api/agency/combined-delivery-requests?status=open` (notification
  `combined_delivery_request.received`) and `POST …/:requestId/respond` with
  `{ fees: [{ shipmentId, proposedFee }] }` (each fee must be lower) or `{ decline: true }`, optional `note`.
- Parcels moved to you from another company (change of agency) can arrive with a pending difference
  the customer or the shop must settle before pickup.
- Cash-for-delivery: § "2026-10-04 (W-F)" below.

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
