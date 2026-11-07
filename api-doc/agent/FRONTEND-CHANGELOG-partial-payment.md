# Agent app: orders paid part online, part in cash

**2026-11-01 · not deployed yet · additive.** Nothing to build unless you want the extra line below.

A customer can now pay part of an order online. You receive it as an ordinary cash-on-delivery shipment, with
the same delivery code.

- `cod.expectedAmount` is the cash to collect: the balance, already net of the online part. **Keep showing it.**
- `cod.prepaidAmount` is new: what was paid online for this parcel. Optional line when above 0: *"6,000 already
  paid online, collect 14,000."*
- You owe only the cash you collect.

⚠ **The reason you give for a failed delivery now affects the customer's money.** On these parcels,
`customer_refused`, `payment_refused`, `customer_absent` and `customer_unreachable` propose that the customer pays
the return fee. An administrator checks it, and your reason and note are shown to them. Consider a line under the
reason picker: *"Choose the true reason. The customer may be charged because of it."*
