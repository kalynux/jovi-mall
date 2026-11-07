# Customer shop + bot: pay part now, the rest in cash at delivery

**2026-11-01 · not deployed yet · additive.** Nothing changes unless a vendor switches it on, and
nothing changes for a checkout that does not ask for it.

## What it is

A customer pays part of an order online and the rest in cash to the delivery agent. Example: an order
of 20,000 XAF whose vendor asks for at least 30%. The customer pays 6,000 now and 14,000 at the door.

The order waits until the online part is paid: nothing is prepared or sent before that.

## The flow

### 1. The cart quote says whether it is available

`POST /api/customer/cart/quote` gains `partialPayment`, on every quote:

```json
"partialPayment": {
  "available": true,
  "reason": null,
  "vendorIds": [],
  "minimumAmount": 6000,
  "maximumAmount": 18000,
  "total": 20000
}
```

| Field | Meaning |
|---|---|
| `minimumAmount` · `maximumAmount` | The whole checkout's limits. The customer names ONE amount between them, also when the basket has several vendors |
| `total` | The basket as a partial order. Use this rather than the quote's own `total` on this screen, because it is priced as cash on delivery |
| `reason` | When unavailable: `digital_items` · `customer_restricted` · `vendor_not_accepted` · `agency_not_supported` · `order_amount_exceeds_limit` · `order_too_small` · `below_delivery_minimum`. Treat an unknown value as unavailable |
| `vendorIds` | The vendors that refuse. Empty for `digital_items` and `customer_restricted` |

If one vendor in the basket does not accept it, it is unavailable for the whole basket, as with cash on
delivery. To pay everything, the customer chooses fully online or fully cash on delivery.

### 2. Checkout creates the orders

`POST /api/customer/orders/checkout`, with `paymentMethod: "cash_on_delivery"` and `partialPayment: true`.
The response adds:

```json
"partialPayment": { "minimumAmount": 6000, "maximumAmount": 18000 }
```

⚠ `paymentMethod` on the order reads `cash_on_delivery`. Read `partialPayment` on the order (below) to
tell the two apart.

Refused with `422 PARTIAL_PAYMENT_NOT_AVAILABLE` (`details.reason` as above), or one of the existing
cash-on-delivery codes when an agency or the account is what refuses. `deliveryFeePayment: "cash_to_rider"`
cannot be combined with it.

### 3. The customer pays their part

`POST /api/payments/initiate` gains `amount`, with the `cartId` as usual:

```json
{ "cartId": "…", "provider": "MTN", "amount": 6000, "channel": { "phoneNumber": "+237…" } }
```

| Code | When | `details` |
|---|---|---|
| `422 PARTIAL_PAYMENT_AMOUNT_REQUIRED` | No `amount` on a partial order | `minimum`, `maximum` |
| `422 PARTIAL_PAYMENT_AMOUNT_OUT_OF_RANGE` | Outside the limits | `minimum`, `maximum`, `requested` |
| `422 PARTIAL_PAYMENT_NOT_APPLICABLE` | An `amount` on an order that is not partial | |
| `409 PAYMENT_ORDER_ALREADY_PAID` | The online part was already paid: treat it as success | |

If the charge fails, call it again, with a different amount if the wallet was short. While a charge is
still live, `initiate` hands back that same charge whatever amount you send.

### 4. The order

`GET /api/customer/orders/:id` and the group read gain:

```json
"partialPayment": {
  "minimumAmount": 6000,
  "maximumAmount": 18000,
  "amountPaidOnline": 6000,
  "paidAt": "2026-11-01T10:00:00.000Z",
  "balanceDue": 14000
}
```

`null` on every other order. Before the online part is paid, `paidAt` is null, `amountPaidOnline` is 0,
and `paymentStatus` is `AWAITING_PAYMENT`: show a "finish paying" action. After it, `paymentStatus` is
`partially_paid`. It becomes `paid` when every parcel's cash has been collected.

Each order row in the orders LIST carries the short form, `"partialPayment": { "paidAt": null }`, or `null`
on every other order. A row with `paidAt: null` owes money now: don't label it "pay on delivery".

Each entry of `codCollections` gains `prepaidAmount`. `expectedAmount` is already the cash due at the
door, so show that. The delivery code works as on any cash-on-delivery order.

An unpaid partial order is cancelled automatically after the vendor's unpaid-order window, like an unpaid
online order. Once its online part is paid the customer cannot cancel it themselves
(`422 ORDER_CANCEL_REQUIRES_REFUND`).

## What to tell the customer BEFORE they pay

⚠ **Say this on the payment screen.** It is the difference from plain cash on delivery, where refusing a
parcel costs nothing.

> If you refuse the parcel, are absent or cannot be reached and it comes back, the delivery company's
> return fee is kept from what you paid, and the rest is refunded minus the payment and transfer fees.
> If the seller or the delivery company is at fault, you get back everything you paid.

Every refund is reviewed by a person first, so it is not instant.

## Refunds

`order.refund` works as today. `lines` may now carry `fees_paid_by_delivery_company`, and `feesPaidBy` may
be `delivery_company`. Show them like the seller equivalents.

## Notifications

`order.prepayment.received` is new: it says what was received and what is still owed in cash.

## The bot

The chat confirmation offers it in words, because a button cannot carry a typed amount. The mini-app
checkout has a "Pay part now" choice with an amount field. WhatsApp Flows are unchanged, so a customer there
pays part through the chat.
