# FRONTEND CHANGELOG — earnings timing, paused earnings, cancelling after payment (2026-10-05)

**Audience:** the vendor dashboard. Owner decisions of 2026-10-05. **No response shape changed.**
What changed is when money moves, and what two existing actions now do behind the scenes. The
work here is copy and confirmation dialogs.

## 1 · Earnings now become available 3 days after DELIVERY

Before: held until the order was *completed* (the customer confirmed, or 7 days after delivery),
then 7 more days. Now: **3 days after the order is delivered**. "Delivered" means the courier
finished the order's last parcel (cash on delivery: the code was entered). A digital product counts
as delivered when it is paid, and a booking when you mark it completed. The customer's
confirmation no longer delays your money.

→ Update every place that explains when money becomes withdrawable (earnings page, payout screen,
help text). Full text: [earnings.md](./earnings.md) § Hold timing.

## 2 · Earnings can be PAUSED

Paused earnings stay in `pending` and are not released until the pause is lifted; the paused time
does not count towards the 3 days. A pause happens when:

- you cancel an order the customer had **already paid** (section 3);
- you cancel a **paid booking from the status menu** (section 3);
- the customer **disputes a card payment** with their bank (lifts by itself when the dispute ends);
- our team pauses it, for example while investigating a complaint.

The vendor API does not show the pause on an order yet. Explain it in your earnings help text
("Some earnings may be paused while a refund or a payment dispute is handled") so a seller whose
`pending` balance is not moving has an answer.

## 3 · Cancelling AFTER the customer paid — add a confirmation

**Order:** moving a paid order to `cancelled` (`PATCH /api/vendor/orders/:id/status`, and each order of `POST /api/vendor/orders/bulk/status`) still
works as before. It still does **not** refund the customer automatically, but now the platform pauses
your earnings for that order and opens a high-priority refund ticket for our team. When the order's
`paymentStatus` is `paid`, show a confirmation:

> *This order has been paid. Cancelling it will not refund the customer automatically: our team
> will arrange the refund, and your earnings for this order will be paused until it is resolved.*

**Booking:** on a **paid** booking, steer sellers to the **Cancel booking** action
(`POST /api/vendor/bookings/:id/cancel`), which refunds the customer automatically. Choosing
`cancelled` from the **status menu** (`PATCH /api/vendor/bookings/:id/status`) refunds nothing, so it
now pauses the earnings and opens a refund ticket. Hide `cancelled` from the status menu when
`paymentStatus` is `paid`, or show the same confirmation as above.

## 4 · The refund window now runs from delivery

`GET /api/vendor/orders/:id/refund-eligibility`: the return window (`return_window_days` in your
return policy) is now counted from the **delivery date**, not the order date. An order that has not
been delivered yet is never "too late" (`REFUND_WINDOW_EXPIRED` cannot be returned before
delivery). No shape change. Update any help text that says "from the order date".
