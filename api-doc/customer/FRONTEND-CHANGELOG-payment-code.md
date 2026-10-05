# Customer shop — the Orange Money payment code, and mobile-money limits

**Applies to:** the shop on the landing site (checkout, pay again, bookings, booking balance,
delivery-fee top-up)
**Status:** ✅ built 2026-10-05; live after the next production deploy. Visible to customers only
once an administrator makes NovaSend the collection aggregator.
**Breaks:** nothing. Without this change, an Orange customer is refused `PAYMENT_CODE_REQUIRED`
while NovaSend is active, with nowhere to type the code.

Why, the full error table and the rules: [cross-role page](../FRONTEND-CHANGELOG-payment-code.md).
This page is what the shop has to do.

## What to change

1. **Read the new `/options` fields** (`GET /api/payments/options`, already called when a pay
   sheet opens): `flow: "CODE_FIRST"`, `fields` containing `"paymentCode"`, `codeUssd`, and
   `limits: { min, max }`.
2. **When the chosen provider's entry is `CODE_FIRST`**, show, below the phone number:
   - *"Orange Money: dial **{codeUssd}** to get your payment code"*, with `codeUssd` as a
     `tel:` link (`#` → `%23`);
   - a **Payment code** input: digits only, 4–8, `inputmode="numeric"`,
     `autocomplete="one-time-code"`, never pre-filled, never saved.
   Disable Pay until it holds 4–8 digits.
3. **Send it as `channel.paymentCode`** on every pay call:

   | Where | Call | Body |
   |---|---|---|
   | Checkout / pay again | `POST /api/payments/initiate` | `{ cartId \| orderId, provider, channel: { phoneNumber, paymentCode } }` |
   | Booking | `POST /api/bookings/:id/pay` | `{ provider, channel: { phoneNumber, paymentCode } }` |
   | Booking balance | `POST /api/customer/bookings/:id/pay-balance` | same |
   | Delivery-fee top-up | `POST /api/customer/orders/:id/delivery-fee-proposals/:proposalId/pay` | same |

4. **Handle the three 422s without closing the sheet:**
   - `PAYMENT_CODE_REQUIRED` → show the code field (even if `/options` did not ask for it: it was
     stale), with `details.ussd`. Nothing was charged.
   - `PAYMENT_CODE_REJECTED` → clear the field, *"That code was not accepted. Dial {details.ussd}
     for a new one."* Nothing was charged; Pay again sends a new `initiate`.
   - `PAYMENT_AMOUNT_OUT_OF_RANGE` → *"Mobile money payments are limited to {details.max} FCFA
     right now. Please contact support."*, and offer cash on delivery where checkout allows it.
5. **Warn early:** when the total is above `limits.max` (or below `limits.min`) for every listed
   mobile provider, say so before Pay.
6. After a successful `initiate`, nothing changes: same instructions screen, same `verify` polling,
   same `requiresOtp` / `redirectUrl` handling.

## Checklist

- [ ] `CODE_FIRST` entry → USSD hint + code input; MTN never shows it
- [ ] `channel.paymentCode` on all four doors
- [ ] the three 422s handled in place
- [ ] the code never stored, logged or sent to analytics
- [ ] `limits` warning before Pay
