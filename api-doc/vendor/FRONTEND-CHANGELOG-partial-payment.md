# Vendor dashboard: accept orders paid part online, part in cash

**2026-11-01 · not deployed yet · additive.** Off for every vendor until they switch it on.

## What it is

A customer pays part of an order online and the delivery agent collects the rest in cash. The vendor
decides whether to accept this, and the minimum share paid online.

## The setting

`GET /api/vendor/profile/partial-payment` · `PUT /api/vendor/profile/partial-payment`

```json
{ "enabled": true, "minPercent": 30 }
```

| Field | Rule |
|---|---|
| `enabled` | Default `false` |
| `minPercent` | Whole number, 10 to 90. Required when `enabled` is true. The customer may pay more, up to 90% of the order |

The read adds `updatedAt`. Default when never set: `{ "enabled": false, "minPercent": null, "updatedAt": null }`.

It is **separate from the COD terms**: a vendor with cash on delivery off can still accept this. The
delivery agency must still accept cash. Changing it applies to new orders only, and never pauses agency
connections.

Suggested copy: *"Let customers pay part online and the rest in cash at delivery. You set the minimum they
pay online."*

## Orders

The list and the detail gain `partialPayment`, `null` on every other order:

```json
"partialPayment": { "amountPaidOnline": 6000, "balanceDue": 14000, "paidAt": "2026-11-01T10:00:00.000Z" }
```

Show it wherever the payment status appears: *"6,000 paid online, 14,000 collected in cash at delivery."*

`paymentMethod` reads `cash_on_delivery` and `paymentStatus` reads `partially_paid` once the online part is
paid. Until then the status is `AWAITING_PAYMENT`, the order cannot be dispatched
(`422 ORDER_PAYMENT_REQUIRED`), and you should not prepare it.

## Notification

You are NOT told about a partial order at checkout. You get one notification when the online part is paid:
the new situation `order.created.partial`, under the existing "new order" preference.

> Order #ORD-2026-000123: the customer paid 6,000 online out of 20,000 XAF. The delivery agent collects the
> remaining 14,000 in cash at delivery. You can prepare it now.

⚠ Its WhatsApp template needs Meta's approval. Until then, a vendor outside the 24-hour window gets it by the
other channels only.

## Your money

⚠ **Say this next to the setting.**

- Your share of the whole order appears as **pending** when the agent collects the cash.
- You can withdraw it only once that parcel's cash has reached the platform, plus the usual hold. That
  includes your share of what the customer paid online, so a late remittance delays it.
- Each parcel unlocks on its own.
- Commission is on the whole sale. The agency's COD handling fee is on the cash it carries, so it is lower
  than on a fully cash order.

**If a parcel comes back through your fault** (for example it was damaged or wrong), the customer gets back
everything they paid. You pay the delivery company's return fee and both refund fees. If your balance does not
cover it, it is recorded as money you owe and comes out of your later earnings. An explanation appears on the
charge (`reason_code: partial_return_fault`).

Cancelling an order after its online part was paid works like cancelling a paid order: the customer is refunded
in full and you pay the fees.
