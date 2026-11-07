# Agency dashboard: orders paid part online, part in cash

**2026-11-01 · not deployed yet · additive.** Almost nothing to build: the amounts you already show are right.

## What changes

A customer can now pay part of an order online. It reaches you as a cash-on-delivery shipment
(`cod.kind: "order"`), only after the online part is paid, and it works like any COD shipment: delivery code,
deposit, remittance.

| Field | What it now means on such a shipment |
|---|---|
| `cod.expectedAmount` | The cash to collect: the balance, already net of what was paid online |
| `cod.prepaidAmount` | **New.** What the customer already paid online for this parcel. 0 on every other shipment |
| `cod.itemsAmount` · `cod.deliveryFeeAmount` | The FULL values. `expected = items + delivery fee − prepaid` |

Show the agent and the agency `expectedAmount`. Show `prepaidAmount` beside it when it is above 0: *"6,000 already
paid online, collect 14,000."*

## Your money

- Your liability and your cash limits count only the cash you carry.
- Your COD handling fee is on that cash, not on the order's value.
- Your earnings on the parcel wait for its cash to reach the platform, as on any COD shipment.

## A returned parcel

Report the true reason. It proposes who pays, and an administrator confirms it.

| Who is at fault | You receive |
|---|---|
| Customer (refused, did not pay, absent, unreachable) | Your return fee, from what the customer prepaid. Never more than they prepaid |
| Vendor | Your return fee, charged to the vendor |
| You | Nothing for the trip, and you pay the payment and transfer fees on the customer's refund. If your balance does not cover them, they are recorded as money you owe (`reason_code: partial_return_fault`) |

A parcel whose refund has been opened cannot be sent out again: `409 SHIPMENT_REASSIGNMENT_CONFLICT`.
